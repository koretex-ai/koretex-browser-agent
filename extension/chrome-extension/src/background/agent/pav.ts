import type { PerceptionSnapshot, TaskRecord } from '@extension/storage';
import { Actors, trajectoryStore } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import { capturePageState } from '../perception';
import { streamCloudChatReply } from './chat';
import { planTask, reflectOnFailure, reportOutcome, curateCollection } from './orchestrator';
import type { ProgramStep, CallUsage } from './orchestrator';
import { createStepRunner, describeStep, listLines, itemKey } from './program';
import { verifyExpect, describeExpect, hasExpectation, degenerateExpectReason } from './verifier';

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

const stripBullet = (line: string) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();

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

  // Final report; never throws (a failed report falls back to raw journal)
  const report = async (status: 'achieved' | 'partial', reason: string): Promise<void> => {
    let meta = '';
    let answer: string;
    try {
      const result = await reportOutcome(task, status, journal, collection, signal);
      answer = result.answer;
      meta = track(result.usage);
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning('report call failed:', error);
      answer = `${reason}\n\nWhat happened:\n${journal.slice(-12).join('\n')}`;
    }
    if (status === 'achieved') finishOk(answer, meta);
    else finishFail(reason ? `${answer}\n\n(${reason})` : answer, meta);
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
    const result = await curateCollection(task, collection.slice(), signal);
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

  const priorFingerprints: string[] = [];
  let plansUsed = 0;

  record.mode = 'plan';

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
      planCall = await planTask(task, journal, pageDigest, plansUsed, MAX_PLANS, signal);
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
      return;
    }

    plansUsed++;
    record.replans = plansUsed - 1;
    const steps = (plan.steps ?? []).slice(0, MAX_STEPS_PER_PLAN);
    const objective = (plan.objective ?? []).filter(hasExpectation).slice(0, 4);

    // Conductor-enforced plan validity: no steps; a state-changing step with
    // no expect; or a DEGENERATE expect (e.g. {"see":"yes"}) that would pass
    // vacuously. Verification only means something if the expects are real.
    const expectFaults: string[] = [];
    for (const [i, step] of steps.entries()) {
      if (STATE_CHANGING.has(step.do) && !hasExpectation(step.expect)) {
        expectFaults.push(`step ${i + 1} (${describeStep(step)}) has no expect`);
      } else if (step.expect) {
        const degenerate = degenerateExpectReason(step.expect);
        if (degenerate) expectFaults.push(`step ${i + 1}: ${degenerate}`);
      }
    }
    for (const [i, expect] of objective.entries()) {
      const degenerate = degenerateExpectReason(expect);
      if (degenerate) expectFaults.push(`objective check ${i + 1}: ${degenerate}`);
    }
    const invalid = steps.length === 0 ? 'the plan has no steps' : expectFaults.join('; ');
    if (invalid) {
      note(
        `plan ${plansUsed} rejected by the runtime: ${invalid}. Every state-changing step needs a REAL, specific expect — a "see" question must ask something concrete about the page, never "yes".`,
      );
      postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `Plan rejected (${invalid}) — replanning.`, planMeta);
      continue;
    }

    // Repeat-plan guard: an identical action skeleton to a failed plan gets
    // one forced-difference warning, then the run stops honestly
    const fingerprint = planFingerprint(steps);
    if (priorFingerprints.includes(fingerprint)) {
      if (priorFingerprints.filter(f => f === fingerprint).length >= 2) {
        await report('partial', 'The planner kept proposing the same failed plan.');
        return;
      }
      note(`plan ${plansUsed} is IDENTICAL to a previous failed plan — the next plan must take a different approach.`);
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
    note(`plan ${plansUsed}: ${steps.length} steps toward: ${task.slice(0, 120)}`);

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
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const exec = await runner.execStep(step);
        if (!exec.ok) {
          observation = exec.message;
        } else if (hasExpectation(step.expect)) {
          const verdict = await verifyExpect(tabId, step.expect!, signal);
          if (verdict.pass) {
            passed = true;
            observation = verdict.observation;
          } else {
            observation = verdict.observation;
          }
        } else {
          passed = true;
          observation = exec.message;
        }
        if (passed) break;
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1200));
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
        reflectCall = await reflectOnFailure(task, journal, steps.map(describeStep), i, step, observation, signal);
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
}
