import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import { SCHEDULE_RUN_HISTORY_LIMIT } from './types';
import type { ScheduleRecord, ScheduleStorage } from './types';

/** Storage key — the background watches this key to resync chrome.alarms */
export const SCHEDULES_STORAGE_KEY = 'schedules';

const schedulesStorage = createStorage<ScheduleRecord[]>(SCHEDULES_STORAGE_KEY, [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const scheduleStore: ScheduleStorage = {
  getAll: async () => schedulesStorage.get(),

  get: async id => (await schedulesStorage.get()).find(s => s.id === id),

  upsert: async record => {
    await schedulesStorage.set(prev => {
      const now = Date.now();
      const existing = prev.find(s => s.id === record.id);
      if (!existing) return [...prev, { ...record, createdAt: now, updatedAt: now }];
      return prev.map(s => (s === existing ? { ...record, createdAt: existing.createdAt, updatedAt: now } : s));
    });
  },

  remove: async id => {
    await schedulesStorage.set(prev => prev.filter(s => s.id !== id));
  },

  beginRun: async (id, sessionId) => {
    let updated: ScheduleRecord | undefined;
    await schedulesStorage.set(prev =>
      prev.map(s => {
        if (s.id !== id) return s;
        const now = Date.now();
        const runCount = s.runCount + 1;
        updated = {
          ...s,
          runCount,
          lastRunAt: now,
          lastRunStatus: 'running',
          runs: [{ startedAt: now, endedAt: null, status: 'running', sessionId }, ...(s.runs ?? [])].slice(
            0,
            SCHEDULE_RUN_HISTORY_LIMIT,
          ),
          // A finished schedule stays visible but inert
          enabled: s.enabled && !(s.maxRuns !== null && runCount >= s.maxRuns),
          updatedAt: now,
        };
        return updated;
      }),
    );
    return updated;
  },

  finishRun: async (id, sessionId, status) => {
    let updated: ScheduleRecord | undefined;
    await schedulesStorage.set(prev =>
      prev.map(s => {
        if (s.id !== id) return s;
        const now = Date.now();
        updated = {
          ...s,
          lastRunStatus: status,
          runs: (s.runs ?? []).map(run => (run.sessionId === sessionId ? { ...run, status, endedAt: now } : run)),
          updatedAt: now,
        };
        return updated;
      }),
    );
    return updated;
  },
};
