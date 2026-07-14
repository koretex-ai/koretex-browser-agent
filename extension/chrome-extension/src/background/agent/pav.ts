import type { PerceptionSnapshot, TaskRecord, RunStatus } from '@extension/storage';
import { Actors, trajectoryStore, runStateStore } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState } from '../perception';
import { streamCloudChatReply } from './chat';
import { planTask, reflectOnFailure, reportOutcome, curateCollection } from './orchestrator';
import type { ProgramStep, CallUsage, StepExpect } from './orchestrator';
import { createStepRunner, describeStep, listLines, itemKey } from './program';
import {
  verifyExpect,
  describeExpect,
  hasExpectation,
  degenerateExpectReason,
  weakSideEffectExpectReason,
} from './verifier';

const logger = createLogger('pav');

/**
 * Plan–act–verify conductor. A deterministic state machine — no model lives
 * in this file. The cloud planner (GLM) thinks; local models perceive; this
 * module runs the loops, owns the budgets and the journal, and enforces the
 * safety rules in code, not prompts.
 *
 * Inner loop (per step): execute -> verify expect -> pass: next step.
 * Fail: one silent retry (most failures are flakes), then REFLECT decides
 * fix_step / replan / stop. Outer loop (per objective): all steps passed ->
 * verify the objective's expects -> achieved: REPORT. Not achieved: PLAN
 * again with the journal. Repeat until achieved or budgets die.
 */

const MAX_PLANS = 5;
const MAX_STEPS_PER_PLAN = 25;
// Total reflect-driven step corrections per plan — past this the plan is
// clearly wrong and a replan is cheaper than more surgery
const MAX_FIXES_PER_PLAN = 4;
const MAX_TASK_MS = 15 * 60_000;
const JOURNAL_MAX_LINES = 80;
// A stalled run is only resumable this long — after that it is stale context
// that must not leak into a later task on the same session
const RESUME_WINDOW_MS = 30 * 60_000;
// Steps that change page/app state need a verifiable postcondition; read-only
// steps may omit one
const STATE_CHANGING = new Set(['navigate', 'click', 'type', 'type_focused', 'key']);

function cloudMeta(usage: CallUsage): string {
  const cost =
    usage.cost !== null
      ? `$${usage.cost.toFixed(4)}`
      : usage.promptTokens !== null
        ? `${usage.promptTokens}+${usage.completionTokens ?? 0} tok`
        : 'cost n/a';
  return `☁ ${usage.model} · ${cost}`;
}

function elementsDigestOf(state: PerceptionSnapshot | null): string[] {
  if (!state) return [];
  return state.elements.slice(0, 30).map(el => {
    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
    const label = (el.text || el.placeholder || el.href || '').slice(0, 60);
    return `[${el.index}]<${kind}> ${label}`.trim();
  });
}

// Plan fingerprint for the repeat-plan guard: the action skeleton, ignoring
// free text (a plan that only rewords its typing is still the same plan)
function planFingerprint(steps: ProgramStep[]): string {
  return JSON.stringify(steps.map(step => [step.do, step.url ?? '', step.target ?? '', step.query ?? '']));
}

// A plan that fails validation gets an inline repair round inside planTask
// before it ever reaches the conductor; if it STILL fails here it is
// exceptional, and bounded by this cap so it can't loop on the happy path.
const MAX_REJECTIONS = 3;

// Expect-validity faults in a plan — the rules verification depends on:
// state-changing steps need a REAL, specific expect (not missing, not
// degenerate like {see:"yes"}, not a side-effect/objective check that only
// re-reads content an earlier step typed). Returns [] for a valid plan. Used
// both to build planTask's inline-repair validator and as the conductor's
// backstop, so the same rules apply in both places.
function collectExpectFaults(steps: ProgramStep[], objective: StepExpect[]): string[] {
  if (steps.length === 0) return ['the plan has no steps'];
  const faults: string[] = [];
  const typedSoFar: string[] = [];
  for (const [i, step] of steps.entries()) {
    if (STATE_CHANGING.has(step.do) && !hasExpectation(step.expect)) {
      faults.push(`step ${i + 1} (${describeStep(step)}) has no expect`);
    } else if (step.expect) {
      const degenerate = degenerateExpectReason(step.expect);
      if (degenerate) faults.push(`step ${i + 1}: ${degenerate}`);
      // Only a side-effect step is suspect: a plain type step verifying its
      // OWN text landed is legitimate proof the typing worked
      else if (step.sideEffect) {
        const weak = weakSideEffectExpectReason(step.expect, typedSoFar);
        if (weak) faults.push(`step ${i + 1} (${describeStep(step)}): ${weak}`);
      }
    }
    if ((step.do === 'type' || step.do === 'type_focused') && step.text && step.textFrom !== 'collected') {
      typedSoFar.push(step.text);
    }
  }
  for (const [i, expect] of objective.entries()) {
    const degenerate = degenerateExpectReason(expect);
    if (degenerate) faults.push(`objective check ${i + 1}: ${degenerate}`);
    else {
      const weak = weakSideEffectExpectReason(expect, typedSoFar);
      if (weak) faults.push(`objective check ${i + 1}: ${weak}`);
    }
  }
  return faults;
}

const stripBullet = (line: string) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();

// A message that means "carry on the stalled task" rather than a new request.
// Explicit resume avoids seeding an unrelated new task with stale collected data.
const CONTINUATION = /^(continue|resume|keep going|carry on|go on|proceed|finish it|carry on with it)\b/i;

export async function runPavTask(
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
    record.cloudCalls++;
    record.orchestratorModel = usage.model;
    if (usage.cost !== null) record.totalCostUsd += usage.cost;
    else costKnown = false;
    return cloudMeta(usage);
  };
  const totalMeta = () =>
    `task total ${costKnown ? '' : '≥'}$${record.totalCostUsd.toFixed(4)} · ${record.cloudCalls} cloud call${record.cloudCalls === 1 ? '' : 's'}`;

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

  // The journal: ONE compact history fed identically to every cloud call.
  // Facts, step outcomes, failures with observations, verdicts. Capped;
  // oldest evicted first.
  const journal: string[] = [];
  const note = (line: string) => {
    journal.push(line.replace(/\n/g, ' ').slice(0, 300));
    if (journal.length > JOURNAL_MAX_LINES) journal.splice(0, journal.length - JOURNAL_MAX_LINES);
  };

  // Structured collection store: every list-item line from every extract,
  // deduplicated, kept UNTRUNCATED. Steps with textFrom:"collected" write
  // these to the page verbatim; the journal only ever sees digests.
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

  // The EFFECTIVE objective: the user's message, unless this run is resuming a
  // stalled task or answering a clarification — then it is rewritten below to
  // carry the original goal plus the continuation/answer.
  let goalText = task;
  let pendingQuestions: string[] | undefined;
  let plansUsed = 0;
  // Pre-execution validation rejections (a plan that never ran) — bounded
  // separately from the execution plan budget so they don't consume it
  let rejections = 0;

  // Persist the run's knowledge so a stall/cancel can be resumed. Called
  // through the run; on a clean finish the state is cleared instead.
  const persist = async (status: RunStatus) => {
    try {
      await runStateStore.setRun({
        sessionId: taskId,
        objective: goalText,
        journal: journal.slice(-JOURNAL_MAX_LINES),
        collection: collection.slice(),
        status,
        pendingQuestions,
        plansUsed,
        updatedAt: Date.now(),
      });
    } catch (error) {
      logger.warning('persist run state failed:', error);
    }
  };

  // Final report; never throws (a failed report falls back to raw journal).
  // A delivered task clears its state; a partial one leaves it RESUMABLE.
  const report = async (status: 'achieved' | 'partial', reason: string): Promise<void> => {
    let meta = '';
    let answer: string;
    try {
      const result = await reportOutcome(goalText, status, journal, collection, signal);
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

  // Curate the collection ONCE, lazily, right before it is first written —
  // by then all harvesting is done. The local reader transcribes without
  // judging relevance, so a broad search leaks non-matching rows; this prunes
  // them against the objective. Mutates `collection` in place so the live
  // textFrom:"collected" view sees the curated set.
  let curated = false;
  const curateBeforeWrite = async (meta: string): Promise<string> => {
    if (curated || collection.length === 0) return meta;
    curated = true;
    const result = await curateCollection(goalText, collection.slice(), signal);
    const usedMeta = result.usage ? track(result.usage) : meta;
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
    return usedMeta;
  };

  // ---- RESUME / CLARIFY SEEDING ----
  // A persisted run for this session means the last turn stalled or asked the
  // user a question. Seed its accumulated knowledge (journal + collection) so
  // we re-plan against the live page WITH that context — knowledge-replay, not
  // step-replay (the page it left is stale).
  const prior = await runStateStore.getRun(taskId).catch(() => null);
  // Only a RECENT prior run may be resumed/answered — an old one lingering on
  // the session (the user moved on long ago) must never bleed into new work
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
      plansUsed = prior.plansUsed;
      note(`resumed after clarification — user answered: ${task.slice(0, 160)}`);
      postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, 'Thanks — continuing with your answer.');
    } else if (prior.status === 'stalled' && CONTINUATION.test(task.trim())) {
      seedFromPrior();
      goalText = prior.objective;
      plansUsed = prior.plansUsed;
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
      // Unrelated new request — discard the stale run rather than contaminate it
      await runStateStore.clearRun(taskId).catch(() => {});
    }
  }

  const priorFingerprints: string[] = [];

  record.mode = 'plan';

  try {
    while (plansUsed < MAX_PLANS) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (outOfTime()) {
        await report('partial', `Time budget (${Math.round(MAX_TASK_MS / 60000)} min) exhausted.`);
        return;
      }

      // ---- PLAN ----
      const pageDigest = await scout();
      let planCall;
      try {
        planCall = await planTask(goalText, journal, pageDigest, plansUsed, MAX_PLANS, signal, plan =>
          collectExpectFaults(
            (plan.steps ?? []).slice(0, MAX_STEPS_PER_PLAN),
            (plan.objective ?? []).filter(hasExpectation).slice(0, 4),
          ),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        logger.warning('plan call failed:', message);
        await report('partial', `Planner call failed: ${message.slice(0, 200)}`);
        return;
      }
      const planMeta = track(planCall.usage);
      const plan = planCall.result;
      logger.info('plan:', JSON.stringify(plan).slice(0, 400));

      if (plan.mode === 'chat') {
        record.mode = 'chat';
        try {
          const { text, usage } = await streamCloudChatReply(port, taskId, task, signal);
          finishOk(text || '', usage ? track(usage) : planMeta);
        } catch (error) {
          if (signal.aborted) throw error;
          logger.warning('chat stream failed:', error);
          finishFail('The chat reply failed to stream.', planMeta);
        }
        await runStateStore.clearRun(taskId).catch(() => {});
        return;
      }

      // ---- CLARIFY ---- only on the first plan; mid-task the journal carries
      // context and asking would just stall. Post the questions, persist the
      // run as awaiting an answer, and end the turn — the user's next message
      // resumes here as the answer.
      if (plan.mode === 'clarify' && plan.questions?.length && plansUsed === 0) {
        const questions = plan.questions.slice(0, 3);
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
          planMeta,
        );
        return;
      }

      const steps = (plan.steps ?? []).slice(0, MAX_STEPS_PER_PLAN);
      const objective = (plan.objective ?? []).filter(hasExpectation).slice(0, 4);

      // planTask already ran an inline repair round against these same rules,
      // so a still-invalid plan here is exceptional (not the happy path). Do
      // NOT consume an execution plan slot for a plan that never ran — bound it
      // with a separate rejection cap instead, and keep the wording calm.
      const faults = collectExpectFaults(steps, objective);
      if (faults.length) {
        rejections++;
        const invalid = faults.join('; ');
        const rejectedFp = planFingerprint(steps);
        const repeated = priorFingerprints.includes(rejectedFp);
        priorFingerprints.push(rejectedFp);
        note(
          `plan attempt rejected by the runtime: ${invalid}. Emit a DIFFERENT plan that fixes this — state-changing steps need a REAL, specific expect, and side-effect/objective expects must verify the transition only success produces, not content already on the page.`,
        );
        const rejectedSteps = steps.map((s, n) => `${n + 1}. ${describeStep(s)}`).join('\n');
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Refining the plan (${invalid.slice(0, 160)})`,
          planMeta,
        );
        logger.info('rejected plan:', rejectedSteps);
        if (repeated || rejections >= MAX_REJECTIONS) {
          await report('partial', `The planner could not produce a plan with valid success checks: ${invalid}`);
          return;
        }
        continue;
      }

      plansUsed++;
      record.replans = plansUsed - 1;

      // Repeat-plan guard: an identical action skeleton to a failed plan gets
      // one forced-difference warning, then the run stops honestly
      const fingerprint = planFingerprint(steps);
      if (priorFingerprints.includes(fingerprint)) {
        if (priorFingerprints.filter(f => f === fingerprint).length >= 2) {
          await report('partial', 'The planner kept proposing the same failed plan.');
          return;
        }
        note(
          `plan ${plansUsed} is IDENTICAL to a previous failed plan — the next plan must take a different approach.`,
        );
      }
      priorFingerprints.push(fingerprint);

      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Plan ${plansUsed}/${MAX_PLANS} (${steps.length} steps):\n${steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n')}`,
        planMeta,
      );
      note(`plan ${plansUsed}: ${steps.length} steps toward: ${goalText.slice(0, 120)}`);
      await persist('running');

      // ---- ACT + VERIFY ----
      const planId = crypto.randomUUID();
      const runner = createStepRunner(
        tabId,
        taskId,
        {
          runId: planId,
          onExtract: recordExtract,
          knownData: () => collection.slice(-8).map(entry => entry.slice(0, 250)),
          collectedItems: () => collection,
        },
        signal,
      );

      let fixes = 0;
      let replanReason: string | null = null;
      let stopped = false;
      const planStart = Date.now();

      let i = 0;
      while (i < steps.length) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (outOfTime()) break;
        const step = steps[i];
        const stepLabel = `Step ${i + 1}/${steps.length}: ${describeStep(step)}`;
        const wasFixed = Boolean((step as { _fixed?: boolean })._fixed);

        // Quality-gate the data the moment before it is written to the document
        if (step.textFrom === 'collected') await curateBeforeWrite('');

        // Execute + verify, with one silent retry for flakes. Side-effect steps
        // get exactly ONE attempt — retrying a possibly-landed post/send is the
        // one mistake this architecture must never make (enforced here, not in
        // a prompt).
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
            // A perception failure is not proof the step failed. Re-VERIFY
            // (never re-execute — that could repeat a side effect) a couple
            // times before deciding; perception usually recovers.
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
          // Do not re-execute on an unreadable page — proceed-with-caveat below
          if (passed || inconclusive) break;
          if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1200));
        }

        // Perception could not read the page even after retries: this is a
        // tooling failure, not proof the step failed. Proceed with a loud
        // caveat rather than re-doing a possibly-completed action or looping —
        // the objective verification at the end is the backstop.
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
            `step ${i + 1} could NOT be verified (perception failed, not a step failure) — proceeding: ${describeStep(step)}`,
          );
          await persist('running');
          i++;
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
            `step ${i + 1} ok: ${describeStep(step)}${observation && observation !== 'expect met' ? ` — ${observation.slice(0, 120)}` : ''}`,
          );
          // Checkpoint the accumulated knowledge after each verified step so a
          // stall here can resume with everything up to this point
          await persist('running');
          i++;
          continue;
        }

        // ---- REFLECT ----
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `${stepLabel} ✗ — ${observation.slice(0, 160)}`,
          '⚙ verify failed',
        );
        note(`step ${i + 1} FAILED: ${describeStep(step)} — ${observation.slice(0, 180)}`);

        // A step that was already corrected once and failed again means the
        // reflector is guessing — force a replan instead of more surgery
        if (wasFixed || fixes >= MAX_FIXES_PER_PLAN) {
          replanReason = wasFixed
            ? `the corrected step also failed: ${observation.slice(0, 160)}`
            : `too many step corrections in this plan (${fixes})`;
          note(`forcing replan: ${replanReason}`);
          break;
        }

        let reflectCall;
        try {
          reflectCall = await reflectOnFailure(
            goalText,
            journal,
            steps.map(describeStep),
            i,
            step,
            observation,
            signal,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          logger.warning('reflect call failed:', error);
          replanReason = `reflection failed after a step failure: ${observation.slice(0, 160)}`;
          break;
        }
        const reflectMeta = track(reflectCall.usage);
        const reflect = reflectCall.result;
        logger.info('reflect:', JSON.stringify(reflect).slice(0, 300));
        note(`reflect: ${reflect.verdict}${reflect.reason ? ` — ${reflect.reason.slice(0, 160)}` : ''}`);

        if (reflect.verdict === 'fix_step' && reflect.step) {
          // Conductor guard: a side-effect action may have landed — a "fix"
          // that repeats the same kind of action is not allowed
          const repeatsSideEffect = step.sideEffect && reflect.step.do === step.do;
          const fixValid = !STATE_CHANGING.has(reflect.step.do) || hasExpectation(reflect.step.expect);
          if (!repeatsSideEffect && fixValid) {
            fixes++;
            (reflect.step as { _fixed?: boolean })._fixed = true;
            steps[i] = reflect.step;
            postExecutionEvent(
              port,
              Actors.SYSTEM,
              'step.ok',
              taskId,
              `Corrected step ${i + 1}: ${describeStep(reflect.step)}${reflect.reason ? ` (${reflect.reason.slice(0, 120)})` : ''}`,
              reflectMeta,
            );
            continue;
          }
          replanReason = repeatsSideEffect
            ? 'a side-effect step failed verification and must not be repeated blindly'
            : 'the corrected step was missing an expect';
          note(`fix rejected by the runtime: ${replanReason}`);
          break;
        }
        if (reflect.verdict === 'replan') {
          replanReason = reflect.reason || 'the reflector requested a new plan';
          break;
        }
        // stop
        stopped = true;
        replanReason = reflect.reason || 'the reflector stopped the run';
        break;
      }

      trajectoryStore
        .appendSubtask({
          id: planId,
          sessionId: taskId,
          taskRecordId: record.id,
          goal: `plan ${plansUsed}: ${task.slice(0, 140)}`,
          success: objective.map(describeExpect).join(' & '),
          status: replanReason === null ? 'ok' : 'fail',
          summary: replanReason ?? `all ${steps.length} steps passed verification`,
          stepsCount: steps.length,
          plannedBy: 'orchestrator',
          plannerTier: 0,
          plannerModel: 'pav',
          startedAt: planStart,
          endedAt: Date.now(),
        })
        .catch(error => logger.warning('plan record failed:', error));

      if (stopped) {
        await report('partial', `Stopped: ${replanReason}`);
        return;
      }
      if (replanReason !== null) {
        note(`plan ${plansUsed} abandoned: ${replanReason}`);
        continue;
      }
      if (outOfTime()) {
        await report('partial', `Time budget (${Math.round(MAX_TASK_MS / 60000)} min) exhausted mid-plan.`);
        return;
      }

      // ---- VERIFY OBJECTIVE ----
      if (objective.length === 0) {
        // The planner defined no objective checks — steps all verified, accept
        note('all steps passed; the plan declared no objective expects');
        await report('achieved', '');
        return;
      }
      let objectiveMet = true;
      for (const expect of objective) {
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
          note(`objective check FAILED: ${describeExpect(expect)} — ${verdict.observation.slice(0, 180)}`);
          break;
        }
      }
      if (objectiveMet) {
        note('all objective checks passed');
        await report('achieved', '');
        return;
      }
      // Objective not met — plan again with the journal explaining why
    }

    await report('partial', `Plan budget (${MAX_PLANS}) exhausted without meeting the objective.`);
  } catch (error) {
    if (signal.aborted) {
      // The user explicitly STOPPED this task — stop means stop. Clear the
      // state so it can never bleed into the next task on this session.
      await runStateStore.clearRun(taskId).catch(() => {});
    } else {
      // A timeout / network / unexpected error — leave the run RESUMABLE so
      // the user can pick up where it stalled instead of starting over
      await persist('stalled').catch(() => {});
    }
    throw error;
  }
}
