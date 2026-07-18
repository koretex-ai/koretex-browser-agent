import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
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

  recordRun: async (id, status) => {
    let updated: ScheduleRecord | undefined;
    await schedulesStorage.set(prev =>
      prev.map(s => {
        if (s.id !== id) return s;
        const runCount = s.runCount + 1;
        updated = {
          ...s,
          runCount,
          lastRunAt: Date.now(),
          lastRunStatus: status,
          // A finished schedule stays visible but inert
          enabled: s.enabled && !(s.maxRuns !== null && runCount >= s.maxRuns),
          updatedAt: Date.now(),
        };
        return updated;
      }),
    );
    return updated;
  },
};
