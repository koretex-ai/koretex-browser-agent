import type { PerceptionSnapshot, TaskRecord, RunStatus } from '@extension/storage';
import { Actors, trajectoryStore, runStateStore } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState } from '../perception';
import { streamCloudChatReply } from './chat';
import { nextStep, strategicReview, reportOutcome, curateCollection } from './orchestrator';
import { applicableSkills, skillsFor } from './skills';
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

  // One observation = digest for the prompt + screenshot for the judge's eyes
  const observe = async (): Promise<{ digest?: string; screenshot?: string }> => {
    const state = await capturePageState(tabId, false).catch(() => null);
    if (!state) return {};
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

  const persist = async (status: RunStatus) => {
    try {
      await runStateStore.setRun({
        sessionId: taskId,
        objective: goalText,
        journal: journal.slice(-JOURNAL_MAX_LINES),
        collection: collection.slice(),
        status,
        pendingQuestions,
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
    };
    if (prior.status === 'awaiting_clarification') {
      seedFromPrior();
      goalText = `${prior.objective}\n\nThe user was asked: ${(prior.pendingQuestions ?? []).join(' ')}\nThe user answered: ${task}`;
      note(`resumed after clarification — user answered: ${task.slice(0, 160)}`);
      postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, 'Thanks — continuing with your answer.');
    } else if (prior.status === 'stalled' && CONTINUATION.test(task.trim())) {
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

  const runner = createStepRunner(
    tabId,
    taskId,
    {
      runId: taskId,
      onExtract: recordExtract,
      knownData: () => collection.slice(-8).map(entry => entry.slice(0, 250)),
      collectedItems: () => collection,
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
  // Which playbooks the navigator is currently reading — announced on change
  let lastSkillsKey = '';
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
          skills: skillsFor(goalText, currentUrlPath) || undefined,
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
        `🧭 Review: objective already delivered — ${(review.diagnosis ?? '').slice(0, 180)}`,
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
        `🧭 Review: blocked — ${(review.reason ?? review.diagnosis ?? '').slice(0, 180)}`,
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
    postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `🧭 Strategy: ${strategy.slice(0, 240)}`, meta);
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
    postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `🧭 Out of strategies — ${stuckSignal.slice(0, 180)}`);
    await report(
      'partial',
      `Out of strategies: all ${MAX_REVIEWS} strategic reviews were spent and the run is stuck again (${stuckSignal.slice(0, 160)}).`,
    );
    outcomeSummary = 'out of strategies';
    return 'ended';
  };

  try {
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

      // Surface playbook activation in the trace + journal whenever the set
      // changes — the trigger is deterministic (host/path substring or
      // objective match, in code), so the trace can state it as fact
      const activeSkills = applicableSkills(goalText, currentUrlPath);
      const skillsKey = activeSkills.map(skill => skill.name).join(', ');
      if (skillsKey !== lastSkillsKey) {
        lastSkillsKey = skillsKey;
        if (skillsKey) {
          note(`site playbooks in force: ${skillsKey}`);
          postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `📘 Site playbooks in force: ${skillsKey}`);
        }
      }

      let call;
      try {
        call = await nextStep(
          {
            objective: goalText,
            journal,
            pageDigest: observed.digest,
            lastAction: lastAction
              ? { description: lastAction.description, execNote: lastAction.execNote }
              : null,
            stepsUsed,
            maxSteps: MAX_STEPS,
            timeRemainingMin: Math.max(0, Math.round((deadline - Date.now()) / 60_000)),
            activeStrategy: activeStrategy || undefined,
            skills: skillsFor(goalText, currentUrlPath) || undefined,
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
      const assessment = (decision.assessment ?? '').slice(0, 220);
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
        postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `Objective judged complete — ${assessment}`, decideMeta);
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
        postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `Refining the step (${fault.slice(0, 160)})`, decideMeta);
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', `The navigator could not produce a valid step: ${fault}`);
          outcome = 'fail';
          outcomeSummary = 'invalid steps';
          return;
        }
        continue;
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
        `Step ${stepsUsed}: ${description}${decision.why ? ` — ${decision.why.slice(0, 120)}` : ''}`,
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
          `Step ${stepsUsed}: ${description} ✗ — ${exec.message.slice(0, 160)}`,
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
