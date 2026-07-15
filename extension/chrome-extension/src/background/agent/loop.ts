import type { PerceptionSnapshot, TaskRecord } from '@extension/storage';
import { Actors, chatSettingsStore, trajectoryStore } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState, capturePageText, clearHighlights } from '../perception';
import { executeAction } from '../actions/executor';
import { detachCdp } from '../actions/cdp';
import { streamChatReply } from './chat';
import { groundTarget } from './grounder';
import { planNextAction, validateCompletion, decisionToAction, extractFromPage, LOCAL_ENDPOINT } from './planner';
import type { PlannerDecision, PlannerEndpoint } from './planner';
import { PLANNER_SYSTEM_PROMPT, VALIDATOR_SYSTEM_PROMPT, formatPlannerTurn, formatValidatorTurn } from './prompts';
import { isOrchestratorConfigured } from './orchestrator';
import type { CallUsage } from './orchestrator';
import { runPavTask } from './pav';
import { runStepwiseTask } from './stepwise';

// Engine experiment (2026-07-15): 'stepwise' decides ONE step at a time from
// the live page + journal (no upfront plan, no separate reflector); 'pav'
// compiles full plans and reflects on failures. Flip here to A/B on the bench.
const CLOUD_ENGINE: 'pav' | 'stepwise' = 'stepwise';

const logger = createLogger('agent');

const MAX_STEPS = 10;
const MAX_CONSECUTIVE_FAILURES = 3;
// Validate at most once: a 4B validator that rejects twice is more likely
// wrong than the planner; don't burn the step budget arguing
const MAX_VALIDATION_REJECTIONS = 1;
// A decision repeated this many times (or a page unchanged across this many
// steps) means the executor is looping — warn once, then declare stuck
const STUCK_REPEAT_THRESHOLD = 3;
// Evidence caps for outcome digests
const MAX_EVIDENCE_TEXT_CHARS = 800;
// How much of an extract answer flows back into the planner HISTORY
const MAX_EXTRACT_HISTORY_CHARS = 600;
// Extracts are the slowest local operation (~16k-char prefill + long
// generation on a 4B model) — cap them per subtask so redundant re-reads
// can't eat the wall clock
const MAX_EXTRACTS_PER_SUBTASK = 4;

// Fuzzy comparison for extract stagnation: strip digits so changing
// like/view counts can't disguise otherwise-identical content
function normalizeExtract(answer: string): string {
  return answer.toLowerCase().replace(/[0-9]/g, '').replace(/\s+/g, ' ').trim();
}

function cloudMeta(usage: CallUsage): string {
  const cost =
    usage.cost !== null
      ? `$${usage.cost.toFixed(4)}`
      : usage.promptTokens !== null
        ? `${usage.promptTokens}+${usage.completionTokens ?? 0} tok`
        : 'cost n/a';
  return `☁ ${usage.model} · ${cost}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizable(decision: any): string {
  switch (decision.action) {
    case 'click':
      return decision.index !== undefined ? `click [${decision.index}]` : `click "${decision.target}"`;
    case 'type':
      return `type "${decision.text}" into [${decision.index}]`;
    case 'type_focused':
      return `type "${(decision.text ?? '').slice(0, 60)}" into the focused editor`;
    case 'key':
      return `press ${decision.combo}`;
    case 'extract':
      return `extract "${decision.query}"`;
    case 'scroll':
      return `scroll ${decision.direction ?? 'down'}`;
    case 'navigate':
      return `navigate to ${decision.url}`;
    case 'back':
      return 'go back';
    default:
      return decision.action;
  }
}

function decisionKey(decision: PlannerDecision): string {
  return JSON.stringify([
    decision.action,
    decision.index,
    decision.target,
    decision.text,
    decision.url,
    decision.direction,
    decision.query,
    decision.combo,
  ]);
}

function pageSignature(state: PerceptionSnapshot | null): string {
  if (!state) return 'no-state';
  return `${state.url}|${state.scroll.y}|${state.elements.length}|${state.elements
    .map(el => el.text)
    .join(',')
    .slice(0, 400)}`;
}

function elementsDigestOf(state: PerceptionSnapshot | null): string[] {
  if (!state) return [];
  return state.elements.slice(0, 60).map(el => {
    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
    const label = (el.text || el.placeholder || el.href || '').slice(0, 60);
    return `[${el.index}]<${kind}> ${label}`.trim();
  });
}

export interface SubtaskRunResult {
  status: 'ok' | 'fail' | 'stuck' | 'streamed';
  summary: string;
  actions: string[];
  url?: string;
  title?: string;
  /** Element labels from the final page state */
  elementsDigest?: string[];
  /** Short excerpt of the final page text */
  pageTextExcerpt?: string;
}

interface SubtaskOptions {
  /** TaskRecord this subtask belongs to */
  taskRecordId: string;
  /** Success criterion (recorded; also appended to the goal by callers) */
  success?: string;
  plannedBy: 'orchestrator' | 'user';
  /** Run the local 4B validator on 'done' */
  useLocalValidator: boolean;
  /** Allow a 'respond' decision to fall through to streaming chat (top-level tasks only) */
  allowRespondChat: boolean;
  /** Prefix for step narration, e.g. "[2/4] " */
  stepPrefix?: string;
  /** Which model drives this subtask (local by default) */
  endpoint?: PlannerEndpoint;
  /** NOTE lines seeded into HISTORY before the first step */
  seedHistory?: string[];
  /** Cost attribution for escalated planner calls; returns the display meta */
  trackUsage?: (usage: CallUsage) => string;
  /** The goal is exactly ONE browser action: perform it and stop */
  atomic?: boolean;
  /** Receives every extract result */
  onExtract?: (query: string, answer: string) => void;
  /** Live view of already-collected data, so extracts report only NEW items */
  knownData?: () => string[];
}

/**
 * The local-only inner loop: perceive → plan → execute against one bounded
 * goal with the local 4B planner. Used ONLY when no cloud orchestrator is
 * configured (fully-local mode). The hybrid path is the plan–act–verify
 * conductor in pav.ts.
 */
async function runSubtask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  goal: string,
  opts: SubtaskOptions,
  signal: AbortSignal,
): Promise<SubtaskRunResult> {
  const subtaskId = crypto.randomUUID();
  const startedAt = Date.now();
  const history: string[] = [...(opts.seedHistory ?? [])];
  const prefix = opts.stepPrefix ?? '';
  let consecutiveFailures = 0;
  let validationRejections = 0;
  let stepsCount = 0;
  let lastState: PerceptionSnapshot | null = null;
  // Loop detection
  let repeatKey = '';
  let repeatCount = 0;
  let lastSignature = '';
  let sameSignatureStreak = 0;
  let loopWarned = false;
  // Extract stagnation: the same answer twice means no new information, even
  // if the query was reworded
  let lastExtractAnswer = '';
  let extractCount = 0;
  // Consecutive perception failures: fail loudly with the REAL error instead
  // of letting the model confabulate "the site is inaccessible"
  let perceptionFailures = 0;
  const MAX_PERCEPTION_FAILURES = 3;

  const { model: localModel, grounderModel } = await chatSettingsStore.getSettings();
  const endpoint = opts.endpoint ?? LOCAL_ENDPOINT;
  const isCloud = endpoint.kind === 'cloud';
  const plannerModelName = isCloud ? endpoint.model : localModel;
  const plannerTier = isCloud ? endpoint.tier : 0;
  const plannerMeta = isCloud ? `☁ ${endpoint.model} (escalated)` : `⌂ ${localModel} (local) · $0`;
  const grounderMeta = `⌂ ${grounderModel.split('/').pop()} (local) · $0`;

  const finalize = async (status: 'ok' | 'fail' | 'stuck', summary: string): Promise<SubtaskRunResult> => {
    const finalState = await capturePageState(tabId, false).catch(() => lastState);
    if (finalState) lastState = finalState;
    await trajectoryStore
      .appendSubtask({
        id: subtaskId,
        sessionId: taskId,
        taskRecordId: opts.taskRecordId,
        goal,
        success: opts.success ?? '',
        status,
        summary,
        stepsCount,
        plannedBy: opts.plannedBy,
        plannerTier,
        plannerModel: plannerModelName,
        startedAt,
        endedAt: Date.now(),
      })
      .catch(error => logger.warning('subtask record failed:', error));
    return {
      status,
      summary,
      actions: history.slice(-6),
      url: lastState?.url,
      title: lastState?.title,
      elementsDigest: elementsDigestOf(lastState),
      pageTextExcerpt: lastState?.pageText?.slice(0, MAX_EVIDENCE_TEXT_CHARS),
    };
  };

  const logRejectedDecision = (decision: PlannerDecision, error: string) => {
    if (!lastState) return;
    trajectoryStore
      .appendStep({
        sessionId: taskId,
        before: lastState,
        action: null,
        ok: false,
        error,
        timestamp: Date.now(),
        subtaskId,
        decision,
        plannerModel: plannerModelName,
        plannerTier,
        historyContext: history.slice(-8),
      })
      .catch(err => logger.warning('trajectory logging failed:', err));
  };

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');

      // Perception with one delayed retry: transient failures happen while a
      // page is mid-navigation, and the retry usually lands after it settles
      let perceptionError = '';
      const state: PerceptionSnapshot | null = await capturePageState(tabId, true).catch(async error => {
        logger.warning('perception failed, retrying:', error);
        await new Promise(resolve => setTimeout(resolve, 1500));
        return capturePageState(tabId, true).catch(retryError => {
          perceptionError = retryError instanceof Error ? retryError.message : String(retryError);
          logger.warning('perception retry failed:', perceptionError);
          return null;
        });
      });
      lastState = state ?? lastState;
      if (state) {
        perceptionFailures = 0;
      } else {
        perceptionFailures++;
        history.push(
          `PERCEPTION ERROR (a temporary technical problem reading the page — NOT a website restriction): ${perceptionError.slice(0, 150)}`,
        );
        if (perceptionFailures >= MAX_PERCEPTION_FAILURES) {
          await clearHighlights(tabId).catch(() => {});
          return await finalize(
            'fail',
            `Perception failed ${MAX_PERCEPTION_FAILURES} times in a row (${perceptionError.slice(0, 200)}). ` +
              'This is a tooling problem (page still loading, or extension site access), not a website restriction — do not conclude the site is inaccessible.',
          );
        }
      }

      // No-effect detection: the page has not changed across executed steps
      const signature = pageSignature(state);
      if (signature === lastSignature) sameSignatureStreak++;
      else {
        sameSignatureStreak = 0;
        lastSignature = signature;
      }

      // A malformed planner response is a failed step, not a dead task
      let planned;
      try {
        planned = await planNextAction(
          PLANNER_SYSTEM_PROMPT,
          formatPlannerTurn(goal, history, state, { cloud: isCloud }),
          signal,
          endpoint,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        logger.warning('planner call failed:', message);
        history.push(`planner error -> ${message.slice(0, 120)} (produce ONLY the JSON object)`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }
      const { decision, usage: planUsage } = planned;
      const stepMeta = planUsage ? (opts.trackUsage?.(planUsage) ?? cloudMeta(planUsage)) : plannerMeta;
      logger.info(`${prefix}step ${step}:`, JSON.stringify(decision));
      stepsCount++;

      // Repeated-decision detection
      const key = decisionKey(decision);
      if (key === repeatKey) repeatCount++;
      else {
        repeatKey = key;
        repeatCount = 1;
      }
      const isTerminal = decision.action === 'done' || decision.action === 'respond';
      if (!isTerminal && (repeatCount >= STUCK_REPEAT_THRESHOLD || sameSignatureStreak >= STUCK_REPEAT_THRESHOLD)) {
        if (!loopWarned) {
          loopWarned = true;
          repeatCount = 0;
          logRejectedDecision(decision, 'suppressed: repeated action with no page change');
          history.push(
            'NOTE: you are repeating the same action and the page is NOT changing. That approach does not work. ' +
              'Choose something DIFFERENT: another element, extract, scroll, navigate, or report the blocker via done.',
          );
          continue;
        }
        logRejectedDecision(decision, 'stuck: repeated action with no page change after warning');
        await clearHighlights(tabId).catch(() => {});
        return await finalize(
          'stuck',
          `Looping without progress: repeated "${summarizable(decision)}" with no page change. Last steps:\n${history
            .slice(-4)
            .join('\n')}`,
        );
      }

      if (decision.action === 'respond') {
        if (opts.allowRespondChat) {
          await clearHighlights(tabId).catch(() => {});
          await streamChatReply(port, taskId, goal, signal);
          return await finalize('ok', '(answered conversationally)').then(r => ({ ...r, status: 'streamed' as const }));
        }
        await clearHighlights(tabId).catch(() => {});
        return await finalize('ok', decision.message || 'No browser action was needed for this subtask.');
      }

      if (decision.action === 'done') {
        const answer = decision.message || 'Subtask complete.';
        if (opts.useLocalValidator && validationRejections < MAX_VALIDATION_REJECTIONS && history.length > 0) {
          const verdict = await validateCompletion(
            VALIDATOR_SYSTEM_PROMPT,
            formatValidatorTurn(goal, history, answer, state),
            signal,
          ).catch(error => {
            logger.warning('validator failed, accepting answer:', error);
            return { valid: true, reason: '' };
          });
          if (!verdict.valid) {
            validationRejections++;
            history.push(`done rejected by validator: ${verdict.reason}`);
            postExecutionEvent(
              port,
              Actors.SYSTEM,
              'step.ok',
              taskId,
              `Validator: not done — ${verdict.reason}`,
              plannerMeta,
            );
            continue;
          }
        }
        await clearHighlights(tabId).catch(() => {});
        return await finalize('ok', answer);
      }

      // The extract action: answer the planner's query from the full page
      // text with a dedicated LLM call, then feed the answer back via HISTORY
      if (decision.action === 'extract' && decision.query) {
        const query = decision.query;
        extractCount++;
        if (extractCount > MAX_EXTRACTS_PER_SUBTASK) {
          sameSignatureStreak++;
          history.push(
            `extract "${query}" -> SKIPPED: the extract budget for this subtask (${MAX_EXTRACTS_PER_SUBTASK}) is used up. ` +
              'Scroll or navigate to change the page, or finish with done.',
          );
          continue;
        }
        try {
          const pageText = await capturePageText(tabId).catch(() => state?.pageText ?? '');
          const { answer, usage } = await extractFromPage(query, pageText, signal, endpoint, opts.knownData?.() ?? []);
          if (usage) opts.trackUsage?.(usage);
          const found = !answer.startsWith('NOT FOUND');
          const nothingNew = /^NOTHING NEW/i.test(answer);
          const stagnant =
            nothingNew || (normalizeExtract(answer) === lastExtractAnswer && normalizeExtract(answer) !== '');
          lastExtractAnswer = normalizeExtract(answer);
          if (stagnant) {
            sameSignatureStreak++;
            history.push(
              `extract "${query}" -> ${nothingNew ? 'NOTHING NEW beyond already-collected data' : 'SAME ANSWER as the previous extract'} — no new information. ` +
                'Do NOT extract again without changing the page first (scroll or navigate), or finish with done.',
            );
            continue;
          }
          if (found && opts.onExtract) opts.onExtract(query, answer);
          if (opts.atomic && found) {
            await clearHighlights(tabId).catch(() => {});
            return await finalize('ok', `extract "${query}" -> ${answer.slice(0, MAX_EXTRACT_HISTORY_CHARS)}`);
          }
          sameSignatureStreak = 0;
          history.push(`extract "${query}" -> ${answer.slice(0, MAX_EXTRACT_HISTORY_CHARS)}`);
          postExecutionEvent(
            port,
            Actors.SYSTEM,
            'step.ok',
            taskId,
            `${prefix}Step ${step}: extract "${query}" — ${answer.slice(0, 200)}${answer.length > 200 ? '…' : ''}`,
            stepMeta,
          );
          if (state) {
            trajectoryStore
              .appendStep({
                sessionId: taskId,
                before: state,
                action: { type: 'extract', query },
                ok: found,
                error: found ? undefined : answer.slice(0, 200),
                timestamp: Date.now(),
                subtaskId,
                decision,
                plannerModel: plannerModelName,
                plannerTier,
                historyContext: history.slice(-8),
              })
              .catch(err => logger.warning('trajectory logging failed:', err));
          }
          consecutiveFailures = 0;
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          history.push(`extract "${query}" -> FAILED: ${message}`);
          consecutiveFailures++;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      const logContext = {
        subtaskId,
        decision,
        plannerModel: plannerModelName,
        plannerTier,
        historyContext: history.slice(-8),
      };

      // Hybrid grounding: click-by-target routes through the vision grounder
      if (decision.action === 'click' && decision.index === undefined && decision.target) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `${prefix}Step ${step}: locating "${decision.target}" visually — ${decision.reasoning}`,
          grounderMeta,
        );
        await clearHighlights(tabId).catch(() => {});
        try {
          const point = await groundTarget(tabId, decision.target, signal);
          const result = await executeAction(
            tabId,
            taskId,
            { type: 'click_at', x: point.x, y: point.y, target: point.target },
            state,
            logContext,
          );
          history.push(`ground+click "${decision.target}" -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);
          if (opts.atomic && result.ok) {
            return await finalize('ok', `Performed: ground+click "${decision.target}" — ${result.message}`);
          }
          consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          history.push(`ground "${decision.target}" -> FAILED: ${message}`);
          consecutiveFailures++;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      const action = decisionToAction(decision);
      if (action === null) continue; // unreachable, satisfies types
      if ('error' in action) {
        logRejectedDecision(decision, action.error);
        history.push(`invalid decision (${summarizable(decision)}): ${action.error}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      // Reject hallucinated indices before executing
      if ((action.type === 'click' || action.type === 'type') && state && action.index >= state.elements.length) {
        const error =
          `index ${action.index} is not in the PAGE list ` +
          `(it has ${state.elements.length} elements, [0]..[${state.elements.length - 1}])`;
        logRejectedDecision(decision, error);
        history.push(`${summarizable(decision)} -> REJECTED: ${error}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `${prefix}Step ${step}: ${summarizable(decision)} — ${decision.reasoning}`,
        stepMeta,
      );

      const result = await executeAction(tabId, taskId, action, state, logContext);
      history.push(`${summarizable(decision)} -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);

      if (opts.atomic && result.ok) {
        await clearHighlights(tabId).catch(() => {});
        return await finalize('ok', `Performed: ${summarizable(decision)} — ${result.message}`);
      }

      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }

    await clearHighlights(tabId).catch(() => {});
    return await finalize(
      'fail',
      consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        ? `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last steps:\n${history.slice(-3).join('\n')}`
        : `Step budget (${MAX_STEPS}) exhausted without completing: ${goal}`,
    );
  } catch (error) {
    await clearHighlights(tabId).catch(() => {});
    throw error;
  }
}

/** Local-only mode: the original single-level agent loop (no API key). */
async function runLocalTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  record: TaskRecord,
  signal: AbortSignal,
): Promise<void> {
  record.mode = 'local';
  const outcome = await runSubtask(
    port,
    tabId,
    taskId,
    task,
    { taskRecordId: record.id, plannedBy: 'user', useLocalValidator: true, allowRespondChat: true },
    signal,
  );
  if (outcome.status === 'streamed') {
    record.outcome = 'ok';
    return; // chat path posted its own events
  }
  const meta = `⌂ ${record.localModel} (local) · task total $0`;
  if (outcome.status === 'ok') {
    record.outcome = 'ok';
    record.answer = outcome.summary;
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, outcome.summary, meta);
  } else {
    record.outcome = 'fail';
    record.answer = outcome.summary;
    postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, outcome.summary, meta);
  }
}

/**
 * Task entry point. Plan–act–verify (pav.ts) when a cloud orchestrator is
 * configured; otherwise the original local-only loop. Always writes a
 * TaskRecord (the end-to-end training label).
 */
export async function runAgentTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  postExecutionEvent(port, Actors.SYSTEM, 'task.start', taskId);
  const settings = await chatSettingsStore.getSettings();
  const record: TaskRecord = {
    id: crypto.randomUUID(),
    sessionId: taskId,
    task,
    mode: 'local',
    outcome: 'fail',
    answer: '',
    replans: 0,
    totalCostUsd: 0,
    cloudCalls: 0,
    localModel: settings.model,
    grounderModel: settings.grounderModel,
    startedAt: Date.now(),
    endedAt: 0,
  };
  try {
    if (await isOrchestratorConfigured()) {
      if (CLOUD_ENGINE === 'stepwise') {
        await runStepwiseTask(port, tabId, taskId, task, record, signal);
      } else {
        await runPavTask(port, tabId, taskId, task, record, signal);
      }
    } else {
      await runLocalTask(port, tabId, taskId, task, record, signal);
    }
  } catch (error) {
    await clearHighlights(tabId).catch(() => {});
    if (signal.aborted) {
      record.outcome = 'cancel';
      postExecutionEvent(port, Actors.SYSTEM, 'task.cancel', taskId, 'Stopped.');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      record.outcome = 'fail';
      record.answer = message;
      logger.error('agent task failed:', message);
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, message);
    }
  } finally {
    // Drop the CDP session (and its "started debugging" infobar) at task end
    await detachCdp(tabId).catch(() => {});
    record.endedAt = Date.now();
    trajectoryStore.appendTask(record).catch(error => logger.warning('task record failed:', error));
  }
}
