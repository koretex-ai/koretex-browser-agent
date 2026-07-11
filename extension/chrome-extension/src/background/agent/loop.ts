import type { PerceptionSnapshot } from '@extension/storage';
import { Actors } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState, clearHighlights } from '../perception';
import { executeAction } from '../actions/executor';
import { streamChatReply } from './chat';
import { groundTarget } from './grounder';
import { planNextAction, validateCompletion, decisionToAction } from './planner';
import {
  PLANNER_SYSTEM_PROMPT,
  VALIDATOR_SYSTEM_PROMPT,
  formatPlannerTurn,
  formatValidatorTurn,
} from './prompts';
import { isOrchestratorConfigured, triageTask, checkpoint } from './orchestrator';
import type { Subtask, SubtaskOutcome } from './orchestrator';

const logger = createLogger('agent');

const MAX_STEPS = 10;
const MAX_CONSECUTIVE_FAILURES = 3;
// Validate at most once: a 4B validator that rejects twice is more likely
// wrong than the planner; don't burn the step budget arguing
const MAX_VALIDATION_REJECTIONS = 1;
// Orchestrated-mode budgets
const MAX_SUBTASKS = 8;
const MAX_REPLANS = 2;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizable(decision: any): string {
  switch (decision.action) {
    case 'click':
      return decision.index !== undefined ? `click [${decision.index}]` : `click "${decision.target}"`;
    case 'type':
      return `type "${decision.text}" into [${decision.index}]`;
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

interface SubtaskRunResult {
  status: 'ok' | 'fail' | 'streamed';
  summary: string;
  actions: string[];
  url?: string;
  title?: string;
}

interface SubtaskOptions {
  /** Run the local 4B validator on 'done' (local-only mode; checkpoints cover it in hybrid) */
  useLocalValidator: boolean;
  /** Allow a 'respond' decision to fall through to streaming chat (top-level tasks only) */
  allowRespondChat: boolean;
  /** Prefix for step narration, e.g. "Subtask 2/4 — " */
  stepPrefix?: string;
}

/**
 * The inner loop: perceive → plan → execute against one bounded goal.
 * Returns a structured outcome; posts step narration but no terminal events —
 * callers decide how the task ends.
 */
async function runSubtask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  goal: string,
  opts: SubtaskOptions,
  signal: AbortSignal,
): Promise<SubtaskRunResult> {
  const history: string[] = [];
  const prefix = opts.stepPrefix ?? '';
  let consecutiveFailures = 0;
  let validationRejections = 0;
  let lastState: PerceptionSnapshot | null = null;

  const finish = (status: 'ok' | 'fail', summary: string): SubtaskRunResult => ({
    status,
    summary,
    actions: history.slice(-6),
    url: lastState?.url,
    title: lastState?.title,
  });

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');

      const state: PerceptionSnapshot | null = await capturePageState(tabId, true).catch(error => {
        logger.warning('perception failed:', error);
        return null;
      });
      lastState = state ?? lastState;

      const decision = await planNextAction(PLANNER_SYSTEM_PROMPT, formatPlannerTurn(goal, history, state), signal);
      logger.info(`${prefix}step ${step}:`, JSON.stringify(decision));

      if (decision.action === 'respond') {
        if (opts.allowRespondChat) {
          await clearHighlights(tabId).catch(() => {});
          await streamChatReply(port, taskId, goal, signal);
          return { status: 'streamed', summary: '', actions: history.slice(-6) };
        }
        // Inside a plan, 'respond' means: nothing to do in the browser
        await clearHighlights(tabId).catch(() => {});
        return finish('ok', decision.message || 'No browser action was needed for this subtask.');
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
            postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `Validator: not done — ${verdict.reason}`);
            continue;
          }
        }
        await clearHighlights(tabId).catch(() => {});
        return finish('ok', answer);
      }

      // Hybrid grounding: click-by-target routes through the vision grounder
      if (decision.action === 'click' && decision.index === undefined && decision.target) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `${prefix}Step ${step}: locating "${decision.target}" visually — ${decision.reasoning}`,
        );
        // Highlights would pollute the grounder's screenshot
        await clearHighlights(tabId).catch(() => {});
        try {
          const point = await groundTarget(tabId, decision.target, signal);
          const result = await executeAction(
            tabId,
            taskId,
            { type: 'click_at', x: point.x, y: point.y, target: point.target },
            state,
          );
          history.push(`ground+click "${decision.target}" -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);
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
        history.push(`invalid decision (${summarizable(decision)}): ${action.error}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }

      // Reject hallucinated indices before executing: the planner must pick
      // from the PAGE list it was shown
      if ((action.type === 'click' || action.type === 'type') && state && action.index >= state.elements.length) {
        history.push(
          `${summarizable(decision)} -> REJECTED: index ${action.index} is not in the PAGE list ` +
            `(it has ${state.elements.length} elements, [0]..[${state.elements.length - 1}])`,
        );
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
      );

      const result = await executeAction(tabId, taskId, action, state);
      history.push(`${summarizable(decision)} -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);

      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }

    await clearHighlights(tabId).catch(() => {});
    return finish(
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

/** Local-only mode: the original single-level agent loop. */
async function runLocalTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  const outcome = await runSubtask(
    port,
    tabId,
    taskId,
    task,
    { useLocalValidator: true, allowRespondChat: true },
    signal,
  );
  if (outcome.status === 'streamed') return; // chat path posted its own events
  if (outcome.status === 'ok') {
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, outcome.summary);
  } else {
    postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, outcome.summary);
  }
}

/** Hybrid mode: cloud orchestrator plans and checkpoints; local models execute. */
async function runOrchestratedTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  const triage = await triageTask(task, signal);
  logger.info('triage:', JSON.stringify(triage).slice(0, 300));

  if (triage.mode === 'chat') {
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, triage.reply || '');
    return;
  }

  if (triage.mode === 'execute') {
    // Single concrete goal: run the local loop, checkpoint validates the result
    const outcome = await runSubtask(
      port,
      tabId,
      taskId,
      task,
      { useLocalValidator: false, allowRespondChat: false },
      signal,
    );
    const plan: Subtask[] = [{ goal: task, success: 'the task is complete' }];
    const verdict = await checkpoint(task, plan, [toOutcome(task, outcome)], signal);
    if (verdict.decision === 'done' || (verdict.decision === 'continue' && outcome.status === 'ok')) {
      postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, verdict.answer || outcome.summary);
    } else {
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, verdict.reason || outcome.summary);
    }
    return;
  }

  // mode === 'plan'
  let plan = (triage.subtasks ?? []).slice(0, MAX_SUBTASKS);
  const outcomes: SubtaskOutcome[] = [];
  let replans = 0;
  let index = 0;

  postExecutionEvent(
    port,
    Actors.SYSTEM,
    'step.ok',
    taskId,
    `Plan (${plan.length} subtasks):\n${plan.map((s, i) => `${i + 1}. ${s.goal}`).join('\n')}`,
  );

  while (index < plan.length && outcomes.length < MAX_SUBTASKS + MAX_REPLANS * 2) {
    const subtask = plan[index];
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `Subtask ${index + 1}/${plan.length}: ${subtask.goal}`,
    );

    const run = await runSubtask(
      port,
      tabId,
      taskId,
      `${subtask.goal} (success: ${subtask.success})`,
      { useLocalValidator: false, allowRespondChat: false, stepPrefix: `[${index + 1}/${plan.length}] ` },
      signal,
    );
    outcomes.push(toOutcome(subtask.goal, run));

    const verdict = await checkpoint(task, plan, outcomes, signal);
    logger.info('checkpoint:', JSON.stringify(verdict).slice(0, 300));

    if (verdict.decision === 'done') {
      postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, verdict.answer || 'Task complete.');
      return;
    }
    if (verdict.decision === 'fail') {
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, verdict.reason || 'The orchestrator gave up.');
      return;
    }
    if (verdict.decision === 'replan') {
      if (replans >= MAX_REPLANS || !verdict.subtasks?.length) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'task.fail',
          taskId,
          `Replan budget exhausted. ${verdict.reason ?? ''}`.trim(),
        );
        return;
      }
      replans++;
      plan = verdict.subtasks.slice(0, MAX_SUBTASKS);
      index = 0;
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Replanned (${plan.length} subtasks):\n${plan.map((s, i) => `${i + 1}. ${s.goal}`).join('\n')}`,
      );
      continue;
    }
    index++;
  }

  // Plan ran out without an explicit done — ask for a final verdict
  const final = await checkpoint(task, plan, outcomes, signal);
  if (final.decision === 'done') {
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, final.answer || 'Task complete.');
  } else {
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'task.fail',
      taskId,
      final.reason || 'Plan completed without a confirmed result.',
    );
  }
}

function toOutcome(goal: string, run: SubtaskRunResult): SubtaskOutcome {
  return {
    goal,
    status: run.status === 'ok' ? 'ok' : 'fail',
    summary: run.summary,
    actions: run.actions,
    url: run.url,
    title: run.title,
  };
}

/**
 * Task entry point. Hybrid (orchestrated) when a cloud orchestrator is
 * configured; otherwise the original local-only loop.
 */
export async function runAgentTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  postExecutionEvent(port, Actors.SYSTEM, 'task.start', taskId);
  try {
    if (await isOrchestratorConfigured()) {
      await runOrchestratedTask(port, tabId, taskId, task, signal);
    } else {
      await runLocalTask(port, tabId, taskId, task, signal);
    }
  } catch (error) {
    await clearHighlights(tabId).catch(() => {});
    if (signal.aborted) {
      postExecutionEvent(port, Actors.SYSTEM, 'task.cancel', taskId, 'Stopped.');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('agent task failed:', message);
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, message);
    }
  }
}
