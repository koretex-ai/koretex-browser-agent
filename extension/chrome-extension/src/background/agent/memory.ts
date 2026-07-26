/**
 * AGENT MEMORY — runtime glue between the agentMemoryStore (identity the
 * user set at onboarding + learnings distilled from past runs) and the
 * strategic-tier prompts (kickoff, review, report).
 *
 * Lifecycle per run: loadAgentMemory() once at run start renders the pinned
 * section; after the final answer is posted, updateMemoryAfterRun() fires
 * ONE cheap distill call (fire-and-forget — it must never delay or fail the
 * delivery) that rewrites the learnings wholesale, capped in code.
 *
 * Division of labor: SKILLS carry site lore; memory carries cross-task
 * knowledge — the user's context and preferences, approach-level lessons.
 */

import { distillRunMemory } from './orchestrator';
import { agentMemoryStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('memory');

/** Runs with almost no history teach nothing — skip the distill call */
const MIN_JOURNAL_LINES = 5;

/**
 * The memory as pinned prompt text — identity line plus learnings — or
 * undefined when the user never set anything and no run has taught anything.
 */
export async function loadAgentMemory(): Promise<string | undefined> {
  try {
    const memory = await agentMemoryStore.get();
    const identity =
      memory.agentName || memory.purpose
        ? `You are "${memory.agentName || "this user's agent"}"${memory.purpose ? ` — typically used for: ${memory.purpose}` : ''}.`
        : '';
    const rendered = [identity, memory.learnings].filter(Boolean).join('\n');
    return rendered || undefined;
  } catch (error) {
    logger.warning('agent memory unavailable:', error);
    return undefined;
  }
}

/**
 * Distill this run's learnings into the long-term memory. Fire-and-forget:
 * call WITHOUT await after the final answer is posted; every failure is
 * logged and swallowed. The journal is already pseudonymized (PII guard), so
 * this call is as cloud-safe as the run's own calls were.
 */
export function updateMemoryAfterRun(input: {
  objective: string;
  outcome: 'delivered' | 'failed';
  journal: string[];
  signal: AbortSignal;
}): void {
  if (input.journal.length < MIN_JOURNAL_LINES) return;
  void (async () => {
    const memory = await agentMemoryStore.get();
    const { memory: updated } = await distillRunMemory(
      {
        agentName: memory.agentName,
        purpose: memory.purpose,
        currentMemory: memory.learnings,
        runsDistilled: memory.runCount,
        objective: input.objective,
        outcome: input.outcome,
        journal: input.journal,
      },
      input.signal,
    );
    await agentMemoryStore.applyLearnings(updated);
    logger.info(`agent memory updated (run #${memory.runCount + 1}, ${updated.length} chars)`);
  })().catch(error => logger.warning('memory distill failed (run delivered normally):', error));
}
