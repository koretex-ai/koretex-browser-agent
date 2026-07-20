/**
 * A user-defined recurring task: run `task` starting at `startAt`, every
 * `intervalMinutes`, until `maxRuns` runs have happened (null = forever) or
 * the user disables/deletes it. Mirrors a calendar event with a recurrence.
 */
/** One occurrence of a schedule, linked to the chat session holding its trace */
export interface ScheduleRunEntry {
  /** Epoch ms the occurrence started */
  startedAt: number;
  /** Epoch ms the occurrence finished; null while still running */
  endedAt: number | null;
  /** 'running' while in flight, then ok / failed / cancelled */
  status: string;
  /** Chat session whose messages ARE the run's trace */
  sessionId: string;
}

/** Recent occurrences kept per schedule — enough to inspect a bad week */
export const SCHEDULE_RUN_HISTORY_LIMIT = 10;

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
  /** Occurrences STARTED so far (counted at run start, not completion) */
  runCount: number;
  enabled: boolean;
  lastRunAt: number | null;
  /** Short human note about the last occurrence (running / ok / failed / skipped) */
  lastRunStatus: string | null;
  /** Newest-first history of recent occurrences (absent on old records) */
  runs?: ScheduleRunEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleStorage {
  getAll: () => Promise<ScheduleRecord[]>;
  get: (id: string) => Promise<ScheduleRecord | undefined>;
  upsert: (record: ScheduleRecord) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /**
   * Mark one occurrence STARTED: counts it, records status 'running', and
   * prepends a run entry pointing at its trace session. Counting at start —
   * not completion — keeps the UI honest while a run is in flight (live
   * confusion 2026-07-20: "0 runs so far" shown during the first run), and
   * auto-disables at maxRuns so no further alarms schedule.
   */
  beginRun: (id: string, sessionId: string) => Promise<ScheduleRecord | undefined>;
  /** Record how the occurrence started via beginRun actually ended */
  finishRun: (id: string, sessionId: string, status: string) => Promise<ScheduleRecord | undefined>;
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
