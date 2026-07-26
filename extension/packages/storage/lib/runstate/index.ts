import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

/**
 * Durable per-session run state for the plan–act–verify conductor. Persisted
 * so a task that stalls (network drop, cancel, budget) can be RESUMED from the
 * knowledge it accumulated — the journal and collection — instead of starting
 * over. Resume is knowledge-replay, not step-replay: the conductor re-plans
 * against the live page with this state seeded, because the page it left is
 * stale by the time the user comes back.
 *
 * Also carries a pending-clarification handoff: when the planner asks the user
 * a question, the state waits here until their next message answers it.
 */
export type RunStatus = 'running' | 'stalled' | 'awaiting_clarification';

export interface RunState {
  sessionId: string;
  /** The user's original objective (survives across resume/clarify turns) */
  objective: string;
  /** Accumulated journal — the conductor's history, seeded on resume */
  journal: string[];
  /** Deduplicated collected items, kept untruncated. In schema mode these
   * are the rendered row lines ("name — column: value — …"), which the
   * stepwise engine re-parses into rows on resume. */
  collection: string[];
  /** Deliverable table schema (stepwise): set by kickoff when the objective's
   * output is a set of items with fields; completeness is then computed in
   * code. First column identifies the item. */
  collectionSchema?: { columns: string[]; target?: number };
  status: RunStatus;
  /** Questions posted to the user; their next message answers these */
  pendingQuestions?: string[];
  /** Sensitive sites the user approved for this task */
  approvedHosts?: string[];
  /** Host awaiting the user's go-ahead — approved when the run is resumed */
  pendingApprovalHost?: string;
  plansUsed: number;
  updatedAt: number;
}

type RunStateMap = Record<string, RunState>;

export type RunStateStorage = BaseStorage<RunStateMap> & {
  getRun: (sessionId: string) => Promise<RunState | null>;
  setRun: (state: RunState) => Promise<void>;
  clearRun: (sessionId: string) => Promise<void>;
};

const storage = createStorage<RunStateMap>('pav-run-state', {}, { storageEnum: StorageEnum.Local, liveUpdate: false });

export const runStateStore: RunStateStorage = {
  ...storage,
  async getRun(sessionId) {
    const map = (await storage.get()) || {};
    return map[sessionId] ?? null;
  },
  async setRun(state) {
    await storage.set(prev => ({ ...(prev || {}), [state.sessionId]: state }));
  },
  async clearRun(sessionId) {
    await storage.set(prev => {
      if (!prev || !(sessionId in prev)) return prev || {};
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  },
};
