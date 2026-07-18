/**
 * A user-defined recurring task: run `task` starting at `startAt`, every
 * `intervalMinutes`, until `maxRuns` runs have happened (null = forever) or
 * the user disables/deletes it. Mirrors a calendar event with a recurrence.
 */
export interface ScheduleRecord {
  id: string;
  /** The natural-language task the agent runs on each occurrence */
  task: string;
  /** Epoch ms of the first occurrence */
  startAt: number;
  /** Recurrence interval in minutes (chrome.alarms minimum is 1) */
  intervalMinutes: number;
  /** Total occurrences before the schedule stops for good; null = unlimited */
  maxRuns: number | null;
  /** Occurrences actually executed so far */
  runCount: number;
  enabled: boolean;
  lastRunAt: number | null;
  /** Short human note about the last occurrence (ok / failed / skipped) */
  lastRunStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleStorage {
  getAll: () => Promise<ScheduleRecord[]>;
  get: (id: string) => Promise<ScheduleRecord | undefined>;
  upsert: (record: ScheduleRecord) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Mark one occurrence executed; auto-disables when maxRuns is reached */
  recordRun: (id: string, status: string) => Promise<ScheduleRecord | undefined>;
}

/** True when the schedule has used up all its allowed runs */
export const isScheduleComplete = (s: ScheduleRecord): boolean => s.maxRuns !== null && s.runCount >= s.maxRuns;

/**
 * Next occurrence time in epoch ms, or null if the schedule will never fire
 * again (disabled or complete). Occurrences stay on the startAt + N*interval
 * grid; missed slots are skipped, not replayed.
 */
export const nextRunAt = (s: ScheduleRecord, now: number): number | null => {
  if (!s.enabled || isScheduleComplete(s)) return null;
  if (s.startAt > now) return s.startAt;
  const period = s.intervalMinutes * 60_000;
  const elapsed = now - s.startAt;
  return s.startAt + Math.ceil((elapsed + 1) / period) * period;
};
