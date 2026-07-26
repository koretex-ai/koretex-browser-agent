import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';

/**
 * AGENT MEMORY — the agent's long-term identity and learnings (the soul.md
 * idea): a name and purpose the user gives at onboarding, plus a small
 * distilled text the agent rewrites after every run — what generally works,
 * what does not, and what it has learned about the user. Pinned into every
 * strategic-tier prompt (kickoff, review, report), so it must stay SMALL:
 * the caps below are enforced in code, and the distiller is instructed to
 * merge and prune, never append forever.
 *
 * Division of labor with skills: skills carry SITE lore (routes and traps on
 * a specific site); memory carries CROSS-TASK lore (the user's context and
 * preferences, approach-level lessons). The distiller is told to keep site
 * specifics out — they belong in a playbook.
 */

export interface AgentMemoryData {
  /** The name the user gave the agent at onboarding ('' = unnamed) */
  agentName: string;
  /** What the user said they'll typically use the agent for */
  purpose: string;
  /** Distilled learnings, rewritten whole after each run (capped) */
  learnings: string;
  /** Runs distilled into the learnings so far */
  runCount: number;
  updatedAt: number;
}

/** Hard cap on the learnings text — memory rides in every strategic prompt */
export const MEMORY_MAX_CHARS = 2400;
export const MEMORY_MAX_LINES = 30;

const EMPTY: AgentMemoryData = { agentName: '', purpose: '', learnings: '', runCount: 0, updatedAt: 0 };

const memoryStorage = createStorage<AgentMemoryData>('agentMemory', EMPTY, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

// READ-FRESH MERGE — never trust the per-context cache. createStorage's
// set(updater) applies the updater to a cache loaded once per context, so a
// background write after a run would merge into a STALE snapshot and clobber
// fields another context saved meanwhile (live bug 2026-07-25: the agent
// name/purpose saved by the options page were wiped by the service worker's
// post-run applyLearnings, whose cache predated the save). Every mutation
// here re-reads storage first and writes the merged object as a plain value.
const merge = async (patch: (prev: AgentMemoryData) => Partial<AgentMemoryData>): Promise<void> => {
  const prev = await memoryStorage.get();
  await memoryStorage.set({ ...prev, ...patch(prev), updatedAt: Date.now() });
};

/** Enforce the size caps on distiller output — code, not prompt trust */
export const capLearnings = (text: string): string =>
  text
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(0, MEMORY_MAX_LINES)
    .join('\n')
    .slice(0, MEMORY_MAX_CHARS);

export const agentMemoryStore = {
  get: async (): Promise<AgentMemoryData> => memoryStorage.get(),

  /** Onboarding / options: set who the agent is and what it's for */
  setIdentity: async (agentName: string, purpose: string): Promise<void> => {
    await merge(() => ({
      agentName: agentName.trim().slice(0, 60),
      purpose: purpose.trim().slice(0, 500),
    }));
  },

  /** Post-run distillation: replace the learnings wholesale (capped) */
  applyLearnings: async (learnings: string): Promise<void> => {
    await merge(prev => ({ learnings: capLearnings(learnings), runCount: prev.runCount + 1 }));
  },

  /** Options page: direct user edit of the learnings text */
  setLearnings: async (learnings: string): Promise<void> => {
    await merge(() => ({ learnings: capLearnings(learnings) }));
  },

  clearLearnings: async (): Promise<void> => {
    await merge(() => ({ learnings: '', runCount: 0 }));
  },
};
