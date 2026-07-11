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

const logger = createLogger('agent');

const MAX_STEPS = 10;
const MAX_CONSECUTIVE_FAILURES = 3;
// Validate at most once: a 4B validator that rejects twice is more likely
// wrong than the planner; don't burn the step budget arguing
const MAX_VALIDATION_REJECTIONS = 1;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizable(decision: any): string {
  switch (decision.action) {
    case 'click':
      return `click [${decision.index}]`;
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

/**
 * The Phase-3 agent loop: perceive → plan → execute, bounded by step and
 * failure budgets, with a single validation pass on completion. Grounding is
 * DOM set-of-marks (the planner picks element indices); the vision grounder
 * splits out in Phase 4.
 */
export async function runAgentTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  postExecutionEvent(port, Actors.SYSTEM, 'task.start', taskId);

  const history: string[] = [];
  let consecutiveFailures = 0;
  let validationRejections = 0;

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');

      const state: PerceptionSnapshot | null = await capturePageState(tabId, true).catch(error => {
        logger.warning('perception failed:', error);
        return null;
      });

      const decision = await planNextAction(PLANNER_SYSTEM_PROMPT, formatPlannerTurn(task, history, state), signal);
      logger.info(`step ${step}:`, JSON.stringify(decision));

      if (decision.action === 'respond') {
        // Pure conversation — hand off to the streaming chat path
        await clearHighlights(tabId).catch(() => {});
        await streamChatReply(port, taskId, task, signal);
        return;
      }

      if (decision.action === 'done') {
        const answer = decision.message || 'Task complete.';
        if (validationRejections < MAX_VALIDATION_REJECTIONS && history.length > 0) {
          const verdict = await validateCompletion(
            VALIDATOR_SYSTEM_PROMPT,
            formatValidatorTurn(task, history, answer, state),
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
        postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, answer);
        return;
      }

      // Hybrid grounding: click-by-target routes through the vision grounder
      if (decision.action === 'click' && decision.index === undefined && decision.target) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Step ${step}: locating "${decision.target}" visually — ${decision.reasoning}`,
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
        `Step ${step}: ${summarizable(decision)} — ${decision.reasoning}`,
      );

      const result = await executeAction(tabId, taskId, action, state);
      history.push(`${summarizable(decision)} -> ${result.ok ? 'ok' : `FAILED: ${result.message}`}`);

      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }

    await clearHighlights(tabId).catch(() => {});
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'task.fail',
      taskId,
      consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        ? `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last steps:\n${history.slice(-3).join('\n')}`
        : `Step budget (${MAX_STEPS}) exhausted without completing the task.`,
    );
  } catch (error) {
    await clearHighlights(tabId).catch(() => {});
    if (signal.aborted) {
      postExecutionEvent(port, Actors.SYSTEM, 'task.cancel', taskId, 'Stopped.');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('agent loop failed:', message);
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, message);
    }
  }
}
