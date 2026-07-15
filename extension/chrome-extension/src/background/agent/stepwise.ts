import type { PerceptionSnapshot, TaskRecord, RunStatus } from '@extension/storage';
import { Actors, trajectoryStore, runStateStore } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState } from '../perception';
import { streamCloudChatReply } from './chat';
import { nextStep, reportOutcome, curateCollection } from './orchestrator';
import type { ProgramStep, CallUsage, StepExpect } from './orchestrator';
import { createStepRunner, describeStep, listLines, itemKey } from './program';
import {
  verifyExpect,
  describeExpect,
  hasExpectation,
  degenerateExpectReason,
  weakSideEffectExpectReason,
} from './verifier';

const logger = createLogger('stepwise');

/**
 * STEPWISE conductor (experimental alternative to pav.ts — flip the engine
 * constant in loop.ts to switch). No upfront plan: the cloud navigator
 * decides ONE step at a time from the live page digest + the journal, the
 * runtime executes and verifies it, and the outcome (with the verifier's
 * observation) feeds the next decision. There is no separate reflector — a
 * failure's observation lands in the journal and the next decision IS the
 * reaction. Expects are observation-grounded by construction: every decision
 * sees the actual page it is acting on, so it never has to invent
 * postconditions for pages it hasn't seen.
 *
 * The safety invariants are inherited from PAV and live IN CODE, not prompts:
 * side-effect steps get ONE attempt and a failed one may never be re-issued;
 * state-changing steps without a real expect are rejected before execution;
 * a decision that repeats a failing action stops the run honestly; hard
 * budgets on steps, wall clock, and consecutive failures.
 */

const MAX_STEPS = 30;
const MAX_TASK_MS = 15 * 60_000;
const JOURNAL_MAX_LINES = 80;
// Consecutive FAILED steps before the run stops — the navigator is clearly
// not converging and each failure costs a decision + an execution
const MAX_CONSECUTIVE_FAILURES = 4;
// Runtime-rejected decisions (invalid/unsafe steps) before stopping
const MAX_REJECTIONS = 3;
const RESUME_WINDOW_MS = 30 * 60_000;
const STATE_CHANGING = new Set(['navigate', 'click', 'type', 'type_focused', 'key']);

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
  return JSON.stringify([step.do, step.url ?? '', step.target ?? '', step.query ?? '']);
}

// Runtime validity of ONE decided step (the stepwise counterpart of the plan
// validator): state-changing steps need a real, non-degenerate expect, and a
// side-effect step may not "prove" itself with text this run already typed.
function stepFaultReason(step: ProgramStep, typedSoFar: string[]): string | null {
  if (!step.do) return 'the step has no "do"';
  if (STATE_CHANGING.has(step.do)) {
    if (!hasExpectation(step.expect)) return `a ${step.do} step must carry an expect (its observable postcondition)`;
    const degenerate = degenerateExpectReason(step.expect!);
    if (degenerate) return degenerate;
    if (step.sideEffect) {
      const weak = weakSideEffectExpectReason(step.expect!, typedSoFar);
      if (weak) return weak;
    }
  }
  return null;
}

const stripBullet = (line: string) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();

const CONTINUATION = /^(continue|resume|keep going|carry on|go on|proceed|finish it|carry on with it)\b/i;

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

  const scout = async (): Promise<string | undefined> => {
    const state = await capturePageState(tabId, false).catch(() => null);
    return state ? `${state.title} — ${state.url}\nELEMENTS:\n${elementsDigestOf(state).join('\n')}` : undefined;
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

  // In-code memory for the safety guards
  const typedSoFar: string[] = [];
  let lastFailedFingerprint: string | null = null;
  let lastFailedWasSideEffect = false;
  let repeatWarnings = 0;
  let consecutiveFailures = 0;
  let decidedAny = false;
  let outcome: 'ok' | 'fail' | null = null;
  let outcomeSummary = '';

  try {
    heartbeat('Reading the page and deciding the first step…');
    while (stepsUsed < MAX_STEPS) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (outOfTime()) {
        await report('partial', `Time budget (${Math.round(MAX_TASK_MS / 60000)} min) exhausted.`);
        outcome = 'fail';
        outcomeSummary = 'time budget exhausted';
        return;
      }

      // ---- DECIDE ----
      const pageDigest = await scout();
      let call;
      try {
        call = await nextStep(goalText, journal, pageDigest, stepsUsed, MAX_STEPS, signal, heartbeat);
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        logger.warning('nextStep call failed:', message);
        await report('partial', `Navigator call failed: ${message.slice(0, 200)}`);
        outcome = 'fail';
        outcomeSummary = 'navigator call failed';
        return;
      }
      const decideMeta = track(call.usage);
      const decision = call.result;
      logger.info('decision:', JSON.stringify(decision).slice(0, 400));

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
        // ---- VERIFY OBJECTIVE ----
        const checks = (decision.objective ?? []).filter(hasExpectation).slice(0, 3);
        let objectiveMet = true;
        for (const expect of checks) {
          const verdict = await verifyExpect(tabId, expect, signal);
          postExecutionEvent(
            port,
            Actors.SYSTEM,
            'step.ok',
            taskId,
            `Objective check ${verdict.pass ? '✓' : '✗'} ${describeExpect(expect)}${verdict.pass ? '' : ` — ${verdict.observation.slice(0, 140)}`}`,
            '⚙ verified · $0',
          );
          if (!verdict.pass) {
            objectiveMet = false;
            note(
              `navigator said done, but the objective check FAILED: ${describeExpect(expect)} — ${verdict.observation.slice(0, 160)}. The objective is NOT delivered yet.`,
            );
            break;
          }
        }
        if (objectiveMet) {
          note(checks.length ? 'all objective checks passed' : 'navigator declared done (no objective checks given)');
          await report('achieved', '');
          outcome = 'ok';
          outcomeSummary = 'objective met';
          return;
        }
        // Failed done-claim costs a decision slot so it cannot loop free
        stepsUsed++;
        continue;
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

      // Runtime validity + safety gates (in code, not prompts)
      const fault = stepFaultReason(step, typedSoFar);
      if (fault) {
        rejections++;
        note(
          `step rejected by the runtime: ${fault}. Decide a corrected step — state-changing steps need a REAL expect that only success satisfies.`,
        );
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
      if (step.sideEffect && lastFailedWasSideEffect && fingerprint === lastFailedFingerprint) {
        rejections++;
        note(
          'step rejected: that side-effect action already failed VERIFICATION and may have taken effect — verify its outcome (navigate to where the result would be visible) instead of re-issuing it.',
        );
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', 'A side-effect step failed verification and must not be blindly repeated.');
          outcome = 'fail';
          outcomeSummary = 'side-effect repeat blocked';
          return;
        }
        continue;
      }
      if (fingerprint === lastFailedFingerprint) {
        repeatWarnings++;
        if (repeatWarnings >= 2) {
          await report('partial', 'The navigator kept deciding the same failing step.');
          outcome = 'fail';
          outcomeSummary = 'repeat-decision loop';
          return;
        }
        note('warning: this exact action just failed — if it fails again the run stops; the NEXT decision must take a different approach.');
      }

      stepsUsed++;
      const stepLabel = `Step ${stepsUsed}: ${describeStep(step)}`;
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `${stepLabel}${decision.why ? ` — ${decision.why.slice(0, 120)}` : ''}`,
        decideMeta,
      );

      if (step.textFrom === 'collected') await curateBeforeWrite();
      if ((step.do === 'type' || step.do === 'type_focused') && step.text && step.textFrom !== 'collected') {
        typedSoFar.push(step.text);
      }

      // ---- ACT + VERIFY (same invariants as PAV) ----
      const attempts = step.sideEffect ? 1 : 2;
      let observation = '';
      let passed = false;
      let inconclusive = false;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const exec = await runner.execStep(step);
        if (!exec.ok) {
          observation = exec.message;
        } else if (hasExpectation(step.expect)) {
          let verdict = await verifyExpect(tabId, step.expect!, signal);
          // Perception failure is not proof of step failure: re-VERIFY (never
          // re-execute) before deciding
          for (let v = 0; v < 2 && verdict.inconclusive; v++) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            verdict = await verifyExpect(tabId, step.expect!, signal);
          }
          passed = verdict.pass;
          inconclusive = Boolean(verdict.inconclusive);
          observation = verdict.observation;
        } else {
          passed = true;
          observation = exec.message;
        }
        if (passed || inconclusive) break;
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1200));
      }

      if (!passed && inconclusive) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `${stepLabel} ⚠ could not verify (perception) — proceeding`,
          '⚙ unverified',
        );
        note(
          `step ${stepsUsed} could NOT be verified (perception failed, not a step failure) — proceeding: ${describeStep(step)}`,
        );
        consecutiveFailures = 0;
        lastFailedFingerprint = null;
        lastFailedWasSideEffect = false;
        await persist('running');
        continue;
      }

      if (passed) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `${stepLabel} ✓${hasExpectation(step.expect) ? ` (${describeExpect(step.expect!)})` : ''}`,
          '⚙ verified · $0',
        );
        note(
          `step ${stepsUsed} ok: ${describeStep(step)}${observation && observation !== 'expect met' ? ` — ${observation.slice(0, 120)}` : ''}`,
        );
        consecutiveFailures = 0;
        repeatWarnings = 0;
        lastFailedFingerprint = null;
        lastFailedWasSideEffect = false;
        await persist('running');
        continue;
      }

      // ---- FAILED — the observation goes to the journal; the next decision
      // is the reaction (no separate reflector in this engine) ----
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `${stepLabel} ✗ — ${observation.slice(0, 160)}`,
        '⚙ verify failed',
      );
      note(`step ${stepsUsed} FAILED: ${describeStep(step)} — ${observation.slice(0, 180)}`);
      consecutiveFailures++;
      lastFailedFingerprint = fingerprint;
      lastFailedWasSideEffect = Boolean(step.sideEffect);
      await persist('running');

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await report('partial', `${MAX_CONSECUTIVE_FAILURES} consecutive steps failed — not converging.`);
        outcome = 'fail';
        outcomeSummary = 'consecutive failures';
        return;
      }
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
