import type { PerceptionSnapshot, TaskRecord, RunStatus } from '@extension/storage';
import { Actors, trajectoryStore, runStateStore, skillStore, chatSettingsStore } from '@extension/storage';
import { resetPiiVault, rehydratePii } from './pii';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState } from '../perception';
import { streamCloudChatReply } from './chat';
import { nextStep, strategicReview, kickoffStrategy, reportOutcome, curateCollection } from './orchestrator';
import { allSkills, applicableSkills, renderSkills, skillCatalog } from './skills';
import { armDialogGuard, detachCdp } from '../actions/cdp';
import { executeAction } from '../actions/executor';
import { stashSuccessfulRun } from '../recorder/teach';
import type { ProgramStep, CallUsage } from './orchestrator';
import { createStepRunner, describeStep, listLines, itemKey } from './program';

const logger = createLogger('stepwise');

/**
 * STEPWISE conductor: judge-and-decide, one multimodal cloud call per step.
 *
 * Loop: [capture screenshot + digest] -> navigator JUDGES what the last
 * action actually did (from pixels, not predictions) and DECIDES the next
 * step -> runtime executes it -> settle -> repeat, until the navigator can
 * see the objective delivered. There are no planner-authored expects and no
 * separate verifier: verification IS the judgment at the top of every turn,
 * made by the strongest model in the system looking at the actual outcome.
 *
 * Safety invariants live IN CODE, not prompts:
 * - side-effect steps get exactly ONE attempt, and one judged failed or
 *   uncertain can never be blindly re-issued on the same page (permanent
 *   per-run memory);
 * - an action judged failed twice is rejected at decision time;
 * - hard budgets on steps, wall clock, consecutive failures, and
 *   consecutive invalid decisions (reset by any executed step).
 *
 * PRIVACY NOTE: this engine sends tab screenshots to the remote navigator
 * model. Calls request no-retention routing (provider.data_collection=deny),
 * but this is a deliberate departure from the local-only doctrine, traded
 * for verification robustness. The no-API-key local path is unaffected.
 */

// NOT a working budget — a runaway backstop only (user decision 2026-07-15:
// steps are cheap and fast now; the wall clock is the real budget). A run
// that legitimately needs many steps must never be guillotined mid-progress.
const MAX_STEPS = 150;
const MAX_TASK_MS = 15 * 60_000;
const JOURNAL_MAX_LINES = 80;
const MAX_CONSECUTIVE_FAILURES = 4;
// Consecutive runtime-rejected decisions; any EXECUTED step resets the count
const MAX_REJECTIONS = 3;
// Strategic reviews per run — the escalation tier is bounded like everything
const MAX_REVIEWS = 3;
// Stuck signals that trigger a review (deterministic, evaluated in code):
// same action judged failed twice, this many consecutive failed judgments,
// any guard rejection, or the navigator flagging itself as circling
const REVIEW_AFTER_CONSECUTIVE_FAILURES = 2;
const RESUME_WINDOW_MS = 30 * 60_000;

// Give the page time to react before photographing it — a screenshot of a
// mid-transition page produces a wrong judgment, and wrong judgments are this
// architecture's only failure mode. (capturePageState additionally waits for
// the tab's load state.)
const SETTLE_MS: Record<string, number> = {
  navigate: 2500,
  click: 1500,
  type: 1200,
  type_focused: 1200,
  key: 1500,
  scroll: 600,
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 100 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function cloudMeta(usage: CallUsage): string {
  const cost =
    usage.cost !== null
      ? `$${usage.cost.toFixed(4)}`
      : usage.promptTokens !== null
        ? `${usage.promptTokens}+${usage.completionTokens ?? 0} tok`
        : 'cost n/a';
  const calls = (usage.calls ?? 1) > 1 ? ` · ${usage.calls} model calls` : '';
  const took = usage.durationMs !== undefined ? ` · ${fmtDuration(usage.durationMs)}` : '';
  return `☁ ${usage.model} · ${cost}${calls}${took}`;
}

function elementsDigestOf(state: PerceptionSnapshot | null): string[] {
  if (!state) return [];
  return state.elements.slice(0, 30).map(el => {
    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
    const label = (el.text || el.placeholder || el.href || '').slice(0, 60);
    return `[${el.index}]<${kind}> ${label}`.trim();
  });
}

// Action skeleton for the repeat-decision guard (free text ignored: a
// decision that only rewords its typing is still the same decision)
function actionFingerprint(step: ProgramStep): string {
  return JSON.stringify([step.do, step.url ?? '', step.target ?? '', step.query ?? '', step.items?.[0] ?? '']);
}

// Futility window: how many recent executed steps to remember, and how many
// repeats of one action inside it count as pacing (a loop made of local
// successes — scroll up, scroll down, scroll up — that no failure signal sees)
const FUTILITY_WINDOW = 8;
const FUTILITY_REPEATS = 3;
// Same action judged "uncertain" (no visible effect) this many times = stuck
const UNCERTAIN_REPEATS = 2;

// Submit-looking click/key targets must declare sideEffect explicitly — an
// unmarked submit would get the transient-retry treatment and could fire
// twice. Input-looking targets are excluded (a textbox merely NAMED "Post
// text" is not a submit button — live false positive 2026-07-15).
const SUBMITTY = /\b(post|send|submit|publish|delete|purchase|buy|pay|confirm|apply|tweet|reply)\b/i;
const INPUTISH = /\b(text|field|box|input|editor|composer|area|message body|search|what)\b/i;

function stepFaultReason(step: ProgramStep): string | null {
  if (!step.do) return 'the step has no "do"';
  if (
    (step.do === 'click' || step.do === 'key') &&
    step.sideEffect === undefined &&
    SUBMITTY.test(step.target ?? '') &&
    !INPUTISH.test(step.target ?? '')
  ) {
    return `this ${step.do} on "${step.target}" may trigger an irreversible submit — declare "sideEffect" explicitly: true if it posts/sends/deletes/purchases, false if it merely opens a composer, menu, or dialog`;
  }
  return null;
}

// Hand-transcription detector: how many lines of a typed text duplicate
// items already in the collection store. The navigator only ever sees the
// collection through the CAPPED journal digest, so a multi-line write it
// composes by hand can only carry the rows it happened to see — every other
// collected item is silently dropped (live run 2026-07-19: 13 collected
// LinkedIn contacts, 9 hand-typed rows reached the sheet). Matching is by
// dedup-key prefix because the navigator retypes truncated digest lines.
function transcribedCollectionLines(text: string | undefined, collectionKeys: Set<string>): number {
  const lines = (text ?? '')
    .split('\n')
    .map(itemKey)
    .filter(key => key.length >= 8);
  if (lines.length < 3 || collectionKeys.size === 0) return 0;
  const prefixes = [...collectionKeys].map(key => key.slice(0, 24)).filter(prefix => prefix.length >= 8);
  return lines.filter(line => prefixes.some(prefix => line.startsWith(prefix) || prefix.startsWith(line.slice(0, 24))))
    .length;
}

const stripBullet = (line: string) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();

const CONTINUATION = /^(continue|resume|keep going|carry on|go on|proceed|finish it|carry on with it)\b/i;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runStepwiseTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  record: TaskRecord,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  let costKnown = true;
  const track = (usage: CallUsage): string => {
    record.cloudCalls += usage.calls ?? 1;
    record.orchestratorModel = usage.model;
    if (usage.cost !== null) record.totalCostUsd += usage.cost;
    else costKnown = false;
    return cloudMeta(usage);
  };
  const totalMeta = () =>
    `task total ${costKnown ? '' : '≥'}$${record.totalCostUsd.toFixed(4)} · ${record.cloudCalls} cloud call${record.cloudCalls === 1 ? '' : 's'}`;
  const heartbeat = (message: string) => postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, message);

  const finishOk = (answer: string, meta: string) => {
    record.outcome = 'ok';
    record.answer = answer;
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, answer, `${meta} · ${totalMeta()}`);
    // Offer to distill the winning route into a skill — but only when the run
    // actually produced NEW knowledge: either no playbook was pinned (novel
    // territory), or one was pinned but the run still hit a stuck signal hard
    // enough to need a strategic review (the playbook's route wasn't enough;
    // what the review discovered is knowledge worth keeping). A success that
    // simply followed an existing skill teaches nothing — offering to distill
    // it would just mint a duplicate of the skill that carried the run.
    const novelRun = pinnedSkillNames.size === 0 || reviewsUsed > 0;
    if (journal.length > 0 && novelRun) {
      stashSuccessfulRun({
        objective: goalText,
        journal: journal.slice(),
        pinnedSkills: [...pinnedSkillNames],
      }).catch(error => logger.warning('skillify stash failed:', error));
      try {
        port.postMessage({ type: 'skillify_offer', objective: goalText });
      } catch {
        /* panel closed — nothing to offer */
      }
    }
  };
  const finishFail = (reason: string, meta: string) => {
    record.outcome = 'fail';
    record.answer = reason;
    postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, reason, `${meta} · ${totalMeta()}`);
  };

  const journal: string[] = [];
  const note = (line: string) => {
    journal.push(line.replace(/\n/g, ' ').slice(0, 300));
    if (journal.length > JOURNAL_MAX_LINES) journal.splice(0, journal.length - JOURNAL_MAX_LINES);
  };

  const collection: string[] = [];
  const collectionKeys = new Set<string>();
  const recordExtract = (query: string, answer: string) => {
    let fresh = 0;
    for (const line of listLines(answer)) {
      const key = itemKey(line);
      if (!key || collectionKeys.has(key)) continue;
      collectionKeys.add(key);
      collection.push(stripBullet(line));
      fresh++;
    }
    note(
      fresh > 0
        ? `data: +${fresh} item(s) (${collection.length} total): ${answer.slice(0, 180)}`
        : `data: ${answer.slice(0, 220)}`,
    );
  };

  let currentUrlPath = '';

  // ---- RUN TAB SET (tab-per-site) ----
  // Multi-site tasks used to thrash ONE tab: returning to the sheet meant
  // reloading docs.google.com and re-finding the document — wasted steps and
  // the classic tip-over of creating a duplicate "Untitled spreadsheet"
  // (live failure 2026-07-20). Now each SITE gets its own tab for the whole
  // run: the first navigate to a site opens a tab, every later navigate to
  // that site SWITCHES to it (a pure switch when it already shows the
  // requested page — state preserved, no reload). Deterministic and
  // invisible to the navigator: it still just decides "navigate to <url>";
  // the decision space is unchanged (tab bookkeeping belongs in code, not in
  // a small model's hands). The navigator learns what is open via the RUN
  // TABS line pinned into its prompt.
  const MAX_RUN_TABS = 4;
  let currentTab = tabId;
  const runTabs = new Map<string, number>(); // site key -> tabId
  // docs.google.com hosts several apps — a sheet and a doc must not share a tab
  const siteKey = (url: URL): string => {
    const host = url.host.replace(/^www\./, '');
    return host === 'docs.google.com' ? `${host}/${url.pathname.split('/')[1] ?? ''}` : host;
  };
  const registerCurrentTabSite = (urlStr: string) => {
    try {
      runTabs.set(siteKey(new URL(urlStr)), currentTab);
    } catch {
      /* about:blank etc. — nothing to register */
    }
  };

  // One observation = digest for the prompt + screenshot for the judge's eyes
  const observe = async (): Promise<{ digest?: string; screenshot?: string }> => {
    const state = await capturePageState(currentTab, false).catch(() => null);
    if (!state) return {};
    registerCurrentTabSite(state.url);
    try {
      const url = new URL(state.url);
      currentUrlPath = url.host + url.pathname;
    } catch {
      currentUrlPath = state.url.slice(0, 120);
    }
    const textSample = (state.pageText ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
    const digest =
      `${state.title} — ${state.url}\nELEMENTS:\n${elementsDigestOf(state).join('\n')}` +
      (textSample ? `\nPAGE TEXT (truncated sample — use an extract step to read more):\n${textSample}` : '');
    return { digest, screenshot: state.screenshot || undefined };
  };

  let goalText = task;
  let pendingQuestions: string[] | undefined;
  let stepsUsed = 0;
  let rejections = 0;

  // Cloud-only mode + PII guard + sensitive-site policy, loaded once per run
  const runSettings = await chatSettingsStore.getSettings();
  const piiGuardActive = runSettings.cloudOnly && runSettings.piiGuard;
  resetPiiVault();
  const sensitivePatterns = (runSettings.sensitiveSites ?? '')
    .split(',')
    .map(pattern => pattern.trim().toLowerCase())
    .filter(Boolean);
  const approvedHosts = new Set<string>();
  let pendingApprovalHost: string | undefined;

  const persist = async (status: RunStatus) => {
    try {
      await runStateStore.setRun({
        sessionId: taskId,
        objective: goalText,
        journal: journal.slice(-JOURNAL_MAX_LINES),
        collection: collection.slice(),
        status,
        pendingQuestions,
        approvedHosts: [...approvedHosts],
        pendingApprovalHost,
        // Schema reuse: the runstate field is named for the PAV engine, but it
        // is just "budget consumed so far" — stepwise stores steps here
        plansUsed: stepsUsed,
        updatedAt: Date.now(),
      });
    } catch (error) {
      logger.warning('persist run state failed:', error);
    }
  };

  const report = async (status: 'achieved' | 'partial', reason: string): Promise<void> => {
    let meta = '';
    let answer: string;
    heartbeat(status === 'achieved' ? 'Objective met — writing the final answer…' : 'Writing up what happened…');
    try {
      const result = await reportOutcome(goalText, status, journal, collection, signal, heartbeat);
      answer = result.answer;
      meta = track(result.usage);
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning('report call failed:', error);
      answer = `${reason}\n\nWhat happened:\n${journal.slice(-12).join('\n')}`;
    }
    // Vault tokens in the answer become real values HERE, locally — the user
    // sees their actual data even though the cloud only saw placeholders
    answer = rehydratePii(answer);
    if (status === 'achieved') {
      await runStateStore.clearRun(taskId).catch(() => {});
      finishOk(answer, meta);
    } else {
      await persist('stalled');
      finishFail(
        `${reason ? `${answer}\n\n(${reason})` : answer}\n\nReply "continue" to resume from where this left off.`,
        meta,
      );
    }
  };

  const deadline = startedAt + MAX_TASK_MS;
  const outOfTime = () => Date.now() >= deadline;

  let curated = false;
  const curateBeforeWrite = async (): Promise<void> => {
    if (curated || collection.length === 0) return;
    curated = true;
    heartbeat(`Reviewing the ${collection.length} collected item(s) against the objective…`);
    const result = await curateCollection(goalText, collection.slice(), signal, heartbeat);
    const usedMeta = result.usage ? track(result.usage) : '';
    if (result.items.length && result.items.length !== collection.length) {
      collection.length = 0;
      collection.push(...result.items);
      note(`curated the collection: kept ${result.items.length}, dropped ${result.dropped} non-matching item(s)`);
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Curated collected data — kept ${result.items.length}, dropped ${result.dropped} off-target item(s).`,
        usedMeta,
      );
    }
  };

  // ---- RESUME / CLARIFY SEEDING (knowledge-replay, same as PAV) ----
  // Resume kind steers the kickoff below: a stalled continuation skips it
  // (the journal already carries the run's thinking); a clarify-resume
  // re-runs it with asking disabled, so the answers become a strategy.
  let resumedAfterClarify = false;
  let resumedContinuation = false;
  const prior = await runStateStore.getRun(taskId).catch(() => null);
  const priorFresh = prior ? Date.now() - prior.updatedAt < RESUME_WINDOW_MS : false;
  if (prior && !priorFresh) {
    await runStateStore.clearRun(taskId).catch(() => {});
  } else if (prior) {
    const seedFromPrior = () => {
      journal.push(...prior.journal.slice(-JOURNAL_MAX_LINES));
      for (const item of prior.collection) {
        const key = itemKey(item);
        if (key && !collectionKeys.has(key)) {
          collectionKeys.add(key);
          collection.push(item);
        }
      }
      for (const host of prior.approvedHosts ?? []) approvedHosts.add(host);
      // Resuming a run that stalled on a sensitive-site ask IS the approval
      if (prior.pendingApprovalHost) {
        approvedHosts.add(prior.pendingApprovalHost);
        note(`user approved working on the sensitive site ${prior.pendingApprovalHost}`);
      }
    };
    if (prior.status === 'awaiting_clarification') {
      resumedAfterClarify = true;
      seedFromPrior();
      goalText = `${prior.objective}\n\nThe user was asked: ${(prior.pendingQuestions ?? []).join(' ')}\nThe user answered: ${task}`;
      note(`resumed after clarification — user answered: ${task.slice(0, 160)}`);
      postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, 'Thanks — continuing with your answer.');
    } else if (prior.status === 'stalled' && CONTINUATION.test(task.trim())) {
      resumedContinuation = true;
      seedFromPrior();
      goalText = prior.objective;
      note(
        `resuming a stalled run — ${collection.length} item(s) already collected, ${journal.length} journal lines restored`,
      );
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Resuming the previous task — ${collection.length} item(s) already collected.`,
      );
    } else {
      await runStateStore.clearRun(taskId).catch(() => {});
    }
  }

  record.mode = 'plan';

  if (piiGuardActive) {
    note(
      'PII guard active: values like ⟨email-1⟩ or ⟨phone-1⟩ are REAL values masked locally — use the tokens verbatim; typing a token types the real value.',
    );
  }

  // Native dialogs (beforeunload/alert/confirm) freeze the tab and are
  // invisible to every sense — the guard auto-handles them at the browser
  // level and reports here so the journal records what happened. Named so
  // every run tab (multi-tab: one per site) arms the same guard.
  const onNativeDialog = ({ kind, message, accepted }: { kind: string; message: string; accepted: boolean }) => {
    const label =
      kind === 'beforeunload'
        ? '"Leave site?" — the page warned of unsaved changes; unsaved work on the previous page may be lost'
        : `${kind}${message ? ` — "${message}"` : ''}`;
    note(`native browser dialog ${accepted ? 'auto-accepted' : 'dismissed'}: ${label}`);
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `🛡 Native dialog ${accepted ? 'accepted' : 'dismissed'}: ${label}`,
    );
  };

  // Managed navigate (tab-per-site; see RUN TAB SET above). Same URL in the
  // site's tab = pure switch, no reload; new URL on a known site = navigate
  // within its tab; new site = its own tab (capped — beyond the cap, load in
  // place). The returned message reaches the journal and the judge.
  const navigateManaged = async (rawUrl: string): Promise<{ ok: boolean; message: string }> => {
    const urlStr = /^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    let key: string | null = null;
    try {
      key = siteKey(new URL(urlStr));
    } catch {
      key = null;
    }
    const inPlace = () => executeAction(currentTab, taskId, { type: 'navigate', url: urlStr }, null);

    const existing = key !== null ? runTabs.get(key) : undefined;
    if (existing !== undefined && existing !== currentTab) {
      const alive = await chrome.tabs.get(existing).catch(() => null);
      if (!alive) {
        runTabs.delete(key!); // the user closed that tab — reopen below
      } else {
        currentTab = existing;
        await chrome.tabs.update(existing, { active: true }).catch(() => {});
        if ((alive.url ?? '').split('#')[0] === urlStr.split('#')[0]) {
          return { ok: true, message: `switched to the existing ${key} tab — page state preserved, no reload` };
        }
        const result = await inPlace();
        return result.ok ? { ok: true, message: `switched to the ${key} tab and navigated to ${urlStr}` } : result;
      }
    }
    if (existing === undefined && key !== null) {
      const distinctTabs = new Set(runTabs.values());
      distinctTabs.add(currentTab);
      if (distinctTabs.size < MAX_RUN_TABS) {
        const windowId = (await chrome.tabs.get(currentTab).catch(() => null))?.windowId;
        const created = await chrome.tabs
          .create({ url: urlStr, active: true, ...(windowId !== undefined ? { windowId } : {}) })
          .catch(() => null);
        if (created?.id !== undefined) {
          runTabs.set(key, created.id);
          currentTab = created.id;
          await armDialogGuard(created.id, onNativeDialog).catch(error =>
            logger.warning('dialog guard unavailable on new tab:', error),
          );
          return { ok: true, message: `opened ${key} in its own new tab (the previous tab keeps its state)` };
        }
      }
    }
    return inPlace();
  };

  const runner = createStepRunner(
    tabId,
    taskId,
    {
      runId: taskId,
      resolveTab: () => currentTab,
      navigateTab: navigateManaged,
      onExtract: recordExtract,
      knownData: () => collection.slice(-8).map(entry => entry.slice(0, 250)),
      collectedItems: () => collection,
      // Cloud-only mode: extract/harvest read via the orchestrator endpoint
      readerEndpoint: runSettings.cloudOnly
        ? {
            kind: 'cloud',
            baseUrl: runSettings.orchestratorBaseUrl,
            apiKey: runSettings.orchestratorApiKey,
            model: runSettings.cloudReaderModel || runSettings.navigatorModel || runSettings.orchestratorModel,
            tier: 0,
          }
        : undefined,
      scrubForCloud: piiGuardActive,
      onUsage: usage => track(usage),
    },
    signal,
  );

  // Guard memory — PERMANENT for the run (an intervening success must never
  // launder a failed action back into eligibility)
  const failedCounts = new Map<string, number>();
  const failedSideEffectContexts = new Set<string>();
  // Futility memory — cleared when a strategic review sets new orders
  const uncertainCounts = new Map<string, number>();
  const recentFingerprints: string[] = [];
  let consecutiveFailures = 0;
  let decidedAny = false;
  let outcome: 'ok' | 'fail' | null = null;
  let outcomeSummary = '';

  // The step awaiting judgment at the top of the next turn
  let lastAction: {
    stepNo: number;
    description: string;
    execNote: string;
    fingerprint: string;
    sideEffect: boolean;
    urlPath: string;
  } | null = null;

  // ---- STRATEGIC REVIEW (the altitude the fast loop deliberately lacks) ----
  // The per-step navigator is myopic by design; when a stuck pattern fires,
  // one deep call (reasoning ON, full journal + screenshot) diagnoses the
  // root cause and sets an ACTIVE STRATEGY — standing orders pinned into
  // every subsequent turn until superseded. Bounded like everything else.
  let activeStrategy = '';
  let lastStrategyText = '';
  let reviewsUsed = 0;
  // Built-in + user-defined playbooks, loaded once per run; a custom skill
  // sharing a built-in's name replaces it
  const skillSet = allSkills(await skillStore.getAll().catch(() => []));

  // Arm the dialog guard on the initial tab (new tabs arm in navigateManaged)
  await armDialogGuard(tabId, onNativeDialog).catch(error => {
    // e.g. DevTools already open on the tab — run continues unguarded
    logger.warning('dialog guard unavailable:', error);
  });
  // Which playbooks the navigator is currently reading — announced on change
  let lastSkillsKey = '';
  // Every playbook pinned at any point this run — gates the save-as-skill
  // offer (a run that just followed an existing skill teaches nothing new;
  // see finishOk) and tells the distiller what knowledge already exists
  const pinnedSkillNames = new Set<string>();
  const runReview = async (
    stuckSignal: string,
    observed: { digest?: string; screenshot?: string },
  ): Promise<'continue' | 'ended'> => {
    reviewsUsed++;
    heartbeat(`Stepping back for a strategic review (${reviewsUsed}/${MAX_REVIEWS})…`);
    let call;
    try {
      call = await strategicReview(
        {
          objective: goalText,
          journal,
          pageDigest: observed.digest,
          screenshotDataUrl: observed.screenshot,
          activeStrategy: activeStrategy || undefined,
          skills: renderSkills(applicableSkills(goalText, currentUrlPath, skillSet)) || undefined,
          skillCatalog:
            skillCatalog(skillSet, new Set(applicableSkills(goalText, currentUrlPath, skillSet).map(s => s.name))) ||
            undefined,
          stuckSignal,
          timeRemainingMin: Math.max(0, Math.round((deadline - Date.now()) / 60_000)),
        },
        signal,
        heartbeat,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning('strategic review call failed:', error);
      note('a strategic review was attempted but the call failed — continuing without it');
      return 'continue';
    }
    const meta = track(call.usage);
    const review = call.result;
    logger.info('review:', JSON.stringify(review).slice(0, 400));
    if (review.verdict === 'done') {
      note(`strategic review: objective already delivered — ${(review.diagnosis ?? '').slice(0, 160)}`);
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `🧭 Review: objective already delivered — ${review.diagnosis ?? ''}`,
        meta,
      );
      await report('achieved', '');
      return 'ended';
    }
    if (review.verdict === 'blocked') {
      note(`strategic review: blocked — ${(review.reason ?? review.diagnosis ?? '').slice(0, 200)}`);
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `🧭 Review: blocked — ${review.reason ?? review.diagnosis ?? ''}`,
        meta,
      );
      await report('partial', `Blocked: ${review.reason ?? 'the strategist found no route around the obstacle'}`);
      return 'ended';
    }
    const strategy = (review.strategy ?? '').trim();
    if (!strategy || strategy === lastStrategyText) {
      // The strategist has no better idea than last time — stop honestly
      note('strategic review produced no new strategy — stopping');
      await report('partial', 'A strategic review could not find a different viable approach.');
      return 'ended';
    }
    lastStrategyText = strategy;
    activeStrategy = strategy;
    // Fresh start under new orders
    consecutiveFailures = 0;
    rejections = 0;
    uncertainCounts.clear();
    recentFingerprints.length = 0;
    note(
      `STRATEGIC REVIEW (${stuckSignal.slice(0, 80)}): ${(review.diagnosis ?? '').slice(0, 140)} → new strategy in force`,
    );
    postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `🧭 Strategy: ${strategy}`, meta);
    await persist('running');
    return 'continue';
  };

  // A stuck/futility signal demands escalation: strategic review if any
  // remain, otherwise the run is out of strategies — stop honestly instead
  // of flailing until a harder guard kills it (live case: 20 post-review
  // steps with futility signals firing into a void)
  const escalate = async (
    stuckSignal: string,
    observed: { digest?: string; screenshot?: string },
  ): Promise<'continue' | 'ended'> => {
    if (reviewsUsed < MAX_REVIEWS) return runReview(stuckSignal, observed);
    note(`stuck again with all ${MAX_REVIEWS} strategic reviews spent: ${stuckSignal.slice(0, 160)}`);
    postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `🧭 Out of strategies — ${stuckSignal}`);
    await report(
      'partial',
      `Out of strategies: all ${MAX_REVIEWS} strategic reviews were spent and the run is stuck again (${stuckSignal.slice(0, 160)}).`,
    );
    outcomeSummary = 'out of strategies';
    return 'ended';
  };

  try {
    // ---- KICKOFF (strategic review #0) ----
    // Interpret the INTENT before the first literal-minded step (live
    // failure 2026-07-20: "decision makers" typed verbatim into a search
    // box; the insight arrived 14 steps later via a stuck-triggered review).
    // One reasoning call: strategy -> pinned as the opening ACTIVE STRATEGY;
    // proceed -> trivial/conversational, straight to the loop; clarify ->
    // ask the user and end the turn (the reply resumes via the clarify path
    // above, which re-runs kickoff with asking disabled). Does not consume
    // the reactive review budget. Skipped on stalled continuations — the
    // seeded journal already carries the run's thinking.
    if (!resumedContinuation) {
      heartbeat('Reading the task — working out the intent and an approach…');
      try {
        const applicable = applicableSkills(goalText, currentUrlPath, skillSet);
        const call = await kickoffStrategy(
          {
            objective: goalText,
            skills: renderSkills(applicable) || undefined,
            skillCatalog: skillCatalog(skillSet, new Set(applicable.map(s => s.name))) || undefined,
            timeBudgetMin: Math.round(MAX_TASK_MS / 60_000),
            noClarify: resumedAfterClarify,
          },
          signal,
          heartbeat,
        );
        const meta = track(call.usage);
        const kick = call.result;
        if (kick.verdict === 'clarify' && kick.questions?.length) {
          const questions = kick.questions.slice(0, 3);
          pendingQuestions = questions;
          record.outcome = 'ok';
          record.answer = questions.join('\n');
          await persist('awaiting_clarification');
          postExecutionEvent(
            port,
            Actors.ASSISTANT,
            'task.ok',
            taskId,
            `Before I start, a couple of things so I get this right:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
            meta,
          );
          return;
        }
        const strategy = (kick.strategy ?? '').trim();
        if (kick.verdict === 'strategy' && strategy) {
          activeStrategy = strategy;
          // Same-text rule as reviews: a later review merely echoing the
          // kickoff has no new idea and ends the run honestly
          lastStrategyText = strategy;
          note(`KICKOFF strategy: ${strategy.slice(0, 200)}`);
          postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `🧭 Approach: ${strategy}`, meta);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        logger.warning('kickoff call failed:', error);
        note('the kickoff strategy call failed — starting without an opening strategy');
      }
    }

    heartbeat('Looking at the page and deciding the first step…');
    while (stepsUsed < MAX_STEPS) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (outOfTime()) {
        await report('partial', `Time budget (${Math.round(MAX_TASK_MS / 60000)} min) exhausted.`);
        outcome = 'fail';
        outcomeSummary = 'time budget exhausted';
        return;
      }

      // ---- OBSERVE + JUDGE + DECIDE (one multimodal call) ----
      if (decidedAny || lastAction) {
        heartbeat('Looking at the result and deciding the next step…');
      }
      const observed = await observe();

      // ---- SENSITIVE-SITE POLICY: ask before working where it matters ----
      // Screenshots of this page would go to the cloud model; on a site from
      // the user's sensitive list, that needs their explicit go-ahead once
      // per task. Resuming IS the approval.
      const sensitiveHit = sensitivePatterns.find(pattern => currentUrlPath.toLowerCase().includes(pattern));
      const currentHost = currentUrlPath.split('/')[0];
      if (sensitiveHit && currentHost && !approvedHosts.has(currentHost)) {
        pendingApprovalHost = currentHost;
        note(`paused on ${currentHost} — matches the sensitive-site list ("${sensitiveHit}"), awaiting user approval`);
        record.outcome = 'ok';
        record.answer = `sensitive-site approval requested: ${currentHost}`;
        await persist('stalled');
        postExecutionEvent(
          port,
          Actors.ASSISTANT,
          'task.ok',
          taskId,
          `⚠️ This task is on **${currentHost}**, which matches your sensitive-site list ("${sensitiveHit}"). Continuing will send screenshots of this page to the cloud model (no-retention routing, but they do leave your machine).\n\nReply "continue" to proceed — that approves ${currentHost} for this task — or give me a different task to stop here.`,
        );
        outcome = 'ok';
        outcomeSummary = 'awaiting sensitive-site approval';
        return;
      }

      // Surface playbook activation in the trace + journal whenever the set
      // changes — the trigger is deterministic (host/path substring or
      // objective match, in code), so the trace can state it as fact
      const activeSkills = applicableSkills(goalText, currentUrlPath, skillSet);
      const skillsKey = activeSkills.map(skill => skill.name).join(', ');
      if (skillsKey !== lastSkillsKey) {
        lastSkillsKey = skillsKey;
        if (skillsKey) {
          for (const skill of activeSkills) pinnedSkillNames.add(skill.name);
          note(`site playbooks in force: ${skillsKey}`);
          postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `📘 Site playbooks in force: ${skillsKey}`);
        }
      }

      // RUN TABS context — only once a second site is open (single-tab runs
      // stay exactly as before, no prompt noise)
      let openTabsLines: string | undefined;
      const distinctRunTabs = [...new Map([...runTabs.entries()].map(([key, id]) => [id, key])).entries()];
      if (distinctRunTabs.length > 1) {
        const lines = await Promise.all(
          distinctRunTabs.map(async ([id, key]) => {
            const tab = await chrome.tabs.get(id).catch(() => null);
            if (!tab) return null;
            const marker = id === currentTab ? ' ← YOU ARE HERE' : '';
            return `- ${key}: ${(tab.url ?? '').slice(0, 120)} — "${(tab.title ?? '').slice(0, 60)}"${marker}`;
          }),
        );
        openTabsLines = lines.filter(Boolean).join('\n') || undefined;
      }

      let call;
      try {
        call = await nextStep(
          {
            objective: goalText,
            journal,
            pageDigest: observed.digest,
            lastAction: lastAction ? { description: lastAction.description, execNote: lastAction.execNote } : null,
            stepsUsed,
            maxSteps: MAX_STEPS,
            timeRemainingMin: Math.max(0, Math.round((deadline - Date.now()) / 60_000)),
            activeStrategy: activeStrategy || undefined,
            skills: renderSkills(activeSkills) || undefined,
            skillCatalog: skillCatalog(skillSet, new Set(activeSkills.map(s => s.name))) || undefined,
            openTabs: openTabsLines,
            screenshotDataUrl: observed.screenshot,
          },
          signal,
          heartbeat,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        logger.warning('nextStep call failed:', message);
        // A misfired call is not a reasoned cause of death — retake the turn
        // (fresh observe + decide), bounded by the same rejection cap
        rejections++;
        note(`navigator call failed (${message.slice(0, 120)}) — retaking the turn`);
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', `Navigator calls kept failing: ${message.slice(0, 200)}`);
          outcome = 'fail';
          outcomeSummary = 'navigator call failures';
          return;
        }
        heartbeat('That decision call failed — retaking the turn…');
        continue;
      }
      const decideMeta = track(call.usage);
      const decision = call.result;
      logger.info('decision:', JSON.stringify(decision).slice(0, 500));

      // ---- BOOK THE JUDGMENT of the previous step ----
      // Shown in full in the trace (debugging value); journal note() caps its
      // own lines for the model's context budget
      const assessment = decision.assessment ?? '';
      if (lastAction) {
        const verdict = decision.last_action ?? 'uncertain';
        const mark = verdict === 'succeeded' ? '✓' : verdict === 'failed' ? '✗' : '⚠';
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Step ${lastAction.stepNo} ${mark} — ${assessment || verdict}`,
          '👁 judged (same call as the next decision — cost shown there)',
        );
        note(`judge on step ${lastAction.stepNo} (${lastAction.description.slice(0, 80)}): ${verdict} — ${assessment}`);
        let stuckSignal: string | null = null;
        if (verdict === 'failed') {
          consecutiveFailures++;
          const fpFailures = (failedCounts.get(lastAction.fingerprint) ?? 0) + 1;
          failedCounts.set(lastAction.fingerprint, fpFailures);
          if (fpFailures >= 2) {
            stuckSignal = `the same action has now been judged failed ${fpFailures} times: ${lastAction.description.slice(0, 100)}`;
          } else if (consecutiveFailures >= REVIEW_AFTER_CONSECUTIVE_FAILURES) {
            stuckSignal = `${consecutiveFailures} consecutive steps were judged failed`;
          }
        } else if (verdict === 'succeeded') {
          consecutiveFailures = 0;
        } else if (verdict === 'uncertain') {
          // "Uncertain" repeated on the SAME action is stuckness too — six
          // identical no-visible-effect clicks once went undetected because
          // only failures counted
          const n = (uncertainCounts.get(lastAction.fingerprint) ?? 0) + 1;
          uncertainCounts.set(lastAction.fingerprint, n);
          if (n >= UNCERTAIN_REPEATS) {
            stuckSignal = `the same action has been judged uncertain (no visible effect) ${n} times: ${lastAction.description.slice(0, 100)}`;
          }
        }
        // Failed OR uncertain side effects may have landed — same-page
        // re-issue is off the table for the rest of the run
        if (lastAction.sideEffect && verdict !== 'succeeded') {
          failedSideEffectContexts.add(`${lastAction.fingerprint}@${lastAction.urlPath}`);
        }
        lastAction = null;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await report('partial', `${MAX_CONSECUTIVE_FAILURES} consecutive steps failed — not converging.`);
          outcome = 'fail';
          outcomeSummary = 'consecutive failures';
          return;
        }
        await persist('running');
        if (stuckSignal && !outOfTime()) {
          const outcomeOfReview = await escalate(stuckSignal, observed);
          if (outcomeOfReview === 'ended') {
            outcome = record.outcome === 'ok' ? 'ok' : 'fail';
            outcomeSummary = outcomeSummary || 'ended by strategic review';
            return;
          }
          // Re-decide from a fresh observation under the new strategy —
          // this turn's decision predates the strategy
          continue;
        }
      } else if (assessment) {
        note(`observed: ${assessment}`);
      }

      // Navigator flagged itself as circling — escalate before acting on a
      // decision that is likely part of the circle
      if (decision.decision === 'step' && decision.stuck && !outOfTime()) {
        note('the navigator flagged that it is circling without progress');
        const outcomeOfReview = await escalate(
          'the navigator itself flagged that it is circling without making progress',
          observed,
        );
        if (outcomeOfReview === 'ended') {
          outcome = record.outcome === 'ok' ? 'ok' : 'fail';
          outcomeSummary = outcomeSummary || 'ended by strategic review';
          return;
        }
        continue;
      }

      // ---- ACT ON THE DECISION ----
      if (decision.decision === 'chat' && !decidedAny) {
        record.mode = 'chat';
        try {
          const { text, usage } = await streamCloudChatReply(port, taskId, task, signal);
          finishOk(text || '', usage ? track(usage) : decideMeta);
        } catch (error) {
          if (signal.aborted) throw error;
          logger.warning('chat stream failed:', error);
          finishFail('The chat reply failed to stream.', decideMeta);
        }
        await runStateStore.clearRun(taskId).catch(() => {});
        return;
      }

      if (decision.decision === 'clarify' && decision.questions?.length && !decidedAny) {
        const questions = decision.questions.slice(0, 3);
        pendingQuestions = questions;
        record.outcome = 'ok';
        record.answer = questions.join('\n');
        await persist('awaiting_clarification');
        postExecutionEvent(
          port,
          Actors.ASSISTANT,
          'task.ok',
          taskId,
          `Before I start, a couple of things so I get this right:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
          decideMeta,
        );
        return;
      }

      if (decision.decision === 'stop') {
        note(`navigator stopped: ${decision.reason ?? 'no reason given'}`);
        await report('partial', `Stopped: ${decision.reason ?? 'the navigator stopped the run'}`);
        outcome = 'fail';
        outcomeSummary = `stopped: ${decision.reason ?? ''}`;
        return;
      }

      if (decision.decision === 'done') {
        note(`navigator declared done: ${assessment || '(no evidence stated)'}`);
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Objective judged complete — ${assessment}`,
          decideMeta,
        );
        await report('achieved', '');
        outcome = 'ok';
        outcomeSummary = 'objective met';
        return;
      }

      // ---- decision === 'step' ----
      const step = decision.step;
      if (!step) {
        rejections++;
        note('navigator replied "step" with no step object — reply with a valid step');
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', 'The navigator kept returning invalid steps.');
          outcome = 'fail';
          outcomeSummary = 'invalid steps';
          return;
        }
        continue;
      }
      decidedAny = true;

      const fault = stepFaultReason(step);
      if (fault) {
        rejections++;
        note(`step rejected by the runtime: ${fault}`);
        postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `Refining the step (${fault})`, decideMeta);
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', `The navigator could not produce a valid step: ${fault}`);
          outcome = 'fail';
          outcomeSummary = 'invalid steps';
          return;
        }
        continue;
      }

      // Collected data must be WRITTEN via textFrom:"collected" — a
      // multi-line type step that retypes collected items by hand carries
      // only the rows visible in the truncated journal and drops the rest
      if ((step.do === 'type' || step.do === 'type_focused') && step.textFrom !== 'collected') {
        const transcribed = transcribedCollectionLines(step.text, collectionKeys);
        if (transcribed >= 2) {
          rejections++;
          note(
            `step rejected: ${transcribed} of the typed line(s) retype collected items from the journal digest — the digest is truncated, so a hand-typed write silently drops the rest of the ${collection.length}-item collection. Re-issue the write with "textFrom":"collected" (put only the header line in "text"); the runtime inserts every collected item verbatim.`,
          );
          if (rejections >= MAX_REJECTIONS) {
            await report(
              'partial',
              'The navigator kept hand-typing collected data instead of using textFrom:"collected".',
            );
            outcome = 'fail';
            outcomeSummary = 'hand-typed collection write blocked';
            return;
          }
          continue;
        }
      }

      const fingerprint = actionFingerprint(step);
      if (step.sideEffect && failedSideEffectContexts.has(`${fingerprint}@${currentUrlPath}`)) {
        rejections++;
        note(
          'step rejected: that side-effect action already ran on this page with an unconfirmed outcome — LOOK for its result (navigate to where it would be visible, extract) instead of re-issuing it.',
        );
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', 'A side-effect step with an unconfirmed outcome must not be blindly repeated.');
          outcome = 'fail';
          outcomeSummary = 'side-effect repeat blocked';
          return;
        }
        if (!outOfTime()) {
          const outcomeOfReview = await escalate(
            'the runtime blocked a re-issue of a side-effect action whose outcome is unconfirmed',
            observed,
          );
          if (outcomeOfReview === 'ended') {
            outcome = record.outcome === 'ok' ? 'ok' : 'fail';
            outcomeSummary = outcomeSummary || 'ended by strategic review';
            return;
          }
        }
        continue;
      }
      if ((failedCounts.get(fingerprint) ?? 0) >= 2) {
        rejections++;
        note(
          'step rejected: that exact action has already failed twice this run — take a DIFFERENT approach (another control, route, or surface).',
        );
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', 'The navigator kept deciding the same failing step.');
          outcome = 'fail';
          outcomeSummary = 'repeat-decision loop';
          return;
        }
        if (!outOfTime()) {
          const outcomeOfReview = await escalate(
            `the navigator decided an action that has already failed twice: ${describeStep(step).slice(0, 100)}`,
            observed,
          );
          if (outcomeOfReview === 'ended') {
            outcome = record.outcome === 'ok' ? 'ok' : 'fail';
            outcomeSummary = outcomeSummary || 'ended by strategic review';
            return;
          }
        }
        continue;
      }

      // Pacing detector: the same action recurring in the recent window —
      // even when every occurrence "succeeded" — is a loop no failure signal
      // sees (live case: 27 steps of scroll-up/scroll-down/extract circling)
      const windowRepeats = recentFingerprints.filter(fp => fp === fingerprint).length;
      if (windowRepeats >= FUTILITY_REPEATS && !outOfTime()) {
        note(
          `pacing detected: "${describeStep(step)}" chosen ${windowRepeats + 1} times in the last ${FUTILITY_WINDOW} steps without the task advancing`,
        );
        const outcomeOfReview = await escalate(
          `the run is pacing — the same action (${describeStep(step).slice(0, 80)}) keeps recurring without the task advancing`,
          observed,
        );
        if (outcomeOfReview === 'ended') {
          outcome = record.outcome === 'ok' ? 'ok' : 'fail';
          outcomeSummary = outcomeSummary || 'ended by strategic review';
          return;
        }
        continue;
      }

      // Decision accepted — an executed step resets the invalid-decision streak
      rejections = 0;
      stepsUsed++;
      const description = `${describeStep(step)}${step.sideEffect ? ' [side-effect]' : ''}`;
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Step ${stepsUsed}: ${description}${decision.why ? ` — ${decision.why}` : ''}`,
        decideMeta,
      );

      recentFingerprints.push(fingerprint);
      if (recentFingerprints.length > FUTILITY_WINDOW) recentFingerprints.shift();

      // ---- VISION-COLLECT (handled by the conductor, no browser action) ----
      // The navigator records data it read off the SCREENSHOT — the strong
      // model's eyes replace the local DOM reader for small collections
      // (which returns garbled fragments on some heavy SPAs, e.g. x.com)
      if (step.do === 'collect') {
        const items = (step.items ?? []).map(item => String(item).trim()).filter(Boolean);
        if (items.length === 0) {
          rejections++;
          note('collect step rejected: it carried no items');
          if (rejections >= MAX_REJECTIONS) {
            await report('partial', 'The navigator kept returning invalid steps.');
            outcome = 'fail';
            outcomeSummary = 'invalid steps';
            return;
          }
          continue;
        }
        // Trust the navigator's items verbatim — recordExtract's listLines()
        // heuristics expect the local reader's bulleted output and silently
        // discard plain lines (live case: "record 5 item(s) ✓ — 0 new" ×3)
        let added = 0;
        for (const item of items) {
          const key = itemKey(item);
          if (!key || collectionKeys.has(key)) continue;
          collectionKeys.add(key);
          collection.push(item);
          added++;
        }
        note(
          added > 0
            ? `collected +${added} item(s) from the screen (${collection.length} total)`
            : `collect added nothing new — all ${items.length} item(s) were already in the collection (${collection.length} total)`,
        );
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          added > 0
            ? `Step ${stepsUsed}: ${description} ✓ — ${added} new, ${collection.length} total`
            : `Step ${stepsUsed}: ${description} ⚠ — 0 new (all ${items.length} already collected), ${collection.length} total`,
          '⚙ recorded',
        );
        lastAction = null;
        await persist('running');
        continue;
      }

      if (step.textFrom === 'collected') await curateBeforeWrite();

      // ---- EXECUTE ----
      // Executor-level retry only for steps that DIDN'T run (grounding miss,
      // stale element): exec.ok=false means the action never happened, so a
      // retry is safe. Side-effect steps still get exactly one attempt.
      const attempts = step.sideEffect ? 1 : 2;
      let exec = await runner.execStep(step);
      for (let attempt = 2; !exec.ok && attempt <= attempts; attempt++) {
        await sleep(1200);
        exec = await runner.execStep(step);
      }

      if (!exec.ok) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Step ${stepsUsed}: ${description} ✗ — ${exec.message}`,
          '⚙ executor failed',
        );
        note(`step ${stepsUsed} could not execute: ${describeStep(step)} — ${exec.message.slice(0, 180)}`);
        consecutiveFailures++;
        failedCounts.set(fingerprint, (failedCounts.get(fingerprint) ?? 0) + 1);
        // The action never ran, so there is nothing for the judge to assess
        lastAction = null;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await report('partial', `${MAX_CONSECUTIVE_FAILURES} consecutive steps failed — not converging.`);
          outcome = 'fail';
          outcomeSummary = 'consecutive failures';
          return;
        }
        await persist('running');
        continue;
      }

      // Journal the EXECUTION immediately — if the run dies before the next
      // turn's judgment, the report must still know this action ran (live
      // failure: a report claimed "NOT posted" about an executed Post click
      // whose judgment turn never happened; the post was live)
      note(
        `step ${stepsUsed} EXECUTED${step.sideEffect ? ' [side-effect]' : ''}: ${describeStep(step)} — outcome not yet judged${step.sideEffect ? '; it may have taken effect' : ''}`,
      );

      // Executed — give the page time to react before the next observation
      await sleep(SETTLE_MS[step.do] ?? 400);
      lastAction = {
        stepNo: stepsUsed,
        description,
        execNote: exec.message,
        fingerprint,
        sideEffect: Boolean(step.sideEffect),
        urlPath: currentUrlPath,
      };
      await persist('running');
    }

    await report('partial', `Step budget (${MAX_STEPS}) exhausted without meeting the objective.`);
    outcome = 'fail';
    outcomeSummary = 'step budget exhausted';
  } catch (error) {
    if (signal.aborted) {
      await runStateStore.clearRun(taskId).catch(() => {});
    } else {
      await persist('stalled').catch(() => {});
    }
    throw error;
  } finally {
    // Multi-tab runs: drop the CDP session from every EXTRA tab this run
    // opened (loop.ts detaches the initial one). The tabs themselves stay
    // open by policy — the deliverable (e.g. the written sheet) may be one
    // of them; scheduled runs clean up wholesale when their window closes.
    for (const extraTabId of new Set(runTabs.values())) {
      if (extraTabId !== tabId) await detachCdp(extraTabId).catch(() => {});
    }
    trajectoryStore
      .appendSubtask({
        id: taskId,
        sessionId: taskId,
        taskRecordId: record.id,
        goal: `stepwise: ${task.slice(0, 140)}`,
        success: outcomeSummary || 'n/a',
        status: outcome === 'ok' ? 'ok' : 'fail',
        summary: outcomeSummary || 'ended without explicit outcome',
        stepsCount: stepsUsed,
        plannedBy: 'orchestrator',
        plannerTier: 0,
        plannerModel: 'stepwise',
        startedAt,
        endedAt: Date.now(),
      })
      .catch(error => logger.warning('subtask record failed:', error));
  }
}
