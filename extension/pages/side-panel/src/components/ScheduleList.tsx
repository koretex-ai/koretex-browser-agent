import { useCallback, useEffect, useState } from 'react';
import { FiClock, FiEdit2, FiPlus, FiTrash2, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import {
  scheduleStore,
  nextRunAt,
  isScheduleComplete,
  SCHEDULES_STORAGE_KEY,
  type ScheduleRecord,
} from '@extension/storage';

interface ScheduleListProps {
  /** Open a run's trace: loads that chat session and leaves the Schedules view */
  onOpenRun: (sessionId: string) => void;
}

type IntervalUnit = 'minutes' | 'hours' | 'days';

const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 };

interface DraftSchedule {
  id: string | null; // null = creating new
  task: string;
  startAt: string; // datetime-local value
  intervalValue: string;
  intervalUnit: IntervalUnit;
  maxRuns: string; // '' = run forever
}

const emptyDraft = (): DraftSchedule => ({
  id: null,
  task: '',
  startAt: toLocalInputValue(new Date(Date.now() + 5 * 60_000)),
  intervalValue: '1',
  intervalUnit: 'days',
  maxRuns: '',
});

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeInterval(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? 'day' : `${d} days`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? 'hour' : `${h} hours`;
  }
  return minutes === 1 ? 'minute' : `${minutes} minutes`;
}

function toDraft(schedule: ScheduleRecord): DraftSchedule {
  const unit: IntervalUnit =
    schedule.intervalMinutes % 1440 === 0 ? 'days' : schedule.intervalMinutes % 60 === 0 ? 'hours' : 'minutes';
  return {
    id: schedule.id,
    task: schedule.task,
    startAt: toLocalInputValue(new Date(schedule.startAt)),
    intervalValue: String(schedule.intervalMinutes / UNIT_MINUTES[unit]),
    intervalUnit: unit,
    maxRuns: schedule.maxRuns === null ? '' : String(schedule.maxRuns),
  };
}

/** "2m 10s" / "45s" duration for a finished run */
function describeDuration(startedAt: number, endedAt: number): string {
  const s = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const ScheduleList = ({ onOpenRun }: ScheduleListProps) => {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [draft, setDraft] = useState<DraftSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const all = await scheduleStore.getAll();
    setSchedules([...all].sort((a, b) => b.createdAt - a.createdAt));
  }, []);

  useEffect(() => {
    reload().catch(err => console.error('Failed to load schedules:', err));
    // Live refresh: the background writes run status into the store as runs
    // start and finish — without this the panel showed stale counts ("0 runs
    // so far" during the first run, live confusion 2026-07-20)
    const onStoreChange = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && SCHEDULES_STORAGE_KEY in changes) {
        reload().catch(err => console.error('Failed to reload schedules:', err));
      }
    };
    chrome.storage.onChanged.addListener(onStoreChange);
    return () => chrome.storage.onChanged.removeListener(onStoreChange);
  }, [reload]);

  const handleSave = async () => {
    if (!draft) return;
    const task = draft.task.trim();
    if (!task) return setError('Describe the task to run.');

    const startAt = new Date(draft.startAt).getTime();
    if (Number.isNaN(startAt)) return setError('Pick a valid start time.');

    const intervalValue = Number(draft.intervalValue);
    if (!Number.isFinite(intervalValue) || intervalValue <= 0) return setError('Repeat interval must be positive.');
    const intervalMinutes = Math.round(intervalValue * UNIT_MINUTES[draft.intervalUnit]);
    if (intervalMinutes < 1) return setError('Minimum repeat interval is 1 minute.');

    let maxRuns: number | null = null;
    if (draft.maxRuns.trim() !== '') {
      maxRuns = Math.floor(Number(draft.maxRuns));
      if (!Number.isFinite(maxRuns) || maxRuns < 1) return setError('Number of runs must be at least 1 (or blank).');
    }

    const existing = draft.id ? schedules.find(s => s.id === draft.id) : undefined;
    await scheduleStore.upsert({
      id: draft.id ?? crypto.randomUUID(),
      task,
      startAt,
      intervalMinutes,
      maxRuns,
      runCount: existing?.runCount ?? 0,
      enabled: true,
      lastRunAt: existing?.lastRunAt ?? null,
      lastRunStatus: existing?.lastRunStatus ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    setDraft(null);
    setError(null);
    await reload();
  };

  const handleToggle = async (schedule: ScheduleRecord) => {
    await scheduleStore.upsert({ ...schedule, enabled: !schedule.enabled });
    await reload();
  };

  const handleDelete = async (id: string) => {
    await scheduleStore.remove(id);
    await reload();
  };

  const inputClass =
    'w-full rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:border-white focus:outline-none';

  const form = draft && (
    <div className="mb-3 rounded-lg border border-white/25 bg-[#0A0A0A] p-3">
      <div className="mb-2 text-sm font-semibold text-white">{draft.id ? 'Edit schedule' : 'New schedule'}</div>
      <label className="mb-1 block text-xs text-gray-400" htmlFor="schedule-task">
        Task to run
      </label>
      <textarea
        id="schedule-task"
        value={draft.task}
        onChange={e => setDraft({ ...draft, task: e.target.value })}
        rows={3}
        placeholder="e.g. Open news.ycombinator.com and summarize the top 5 stories"
        className={`${inputClass} resize-none`}
      />
      <label className="mb-1 mt-2 block text-xs text-gray-400" htmlFor="schedule-start">
        First run at
      </label>
      <input
        id="schedule-start"
        type="datetime-local"
        value={draft.startAt}
        onChange={e => setDraft({ ...draft, startAt: e.target.value })}
        className={`${inputClass} [color-scheme:dark]`}
      />
      <label className="mb-1 mt-2 block text-xs text-gray-400" htmlFor="schedule-interval">
        Repeat every
      </label>
      <div className="flex gap-2">
        <input
          id="schedule-interval"
          type="number"
          min={1}
          value={draft.intervalValue}
          onChange={e => setDraft({ ...draft, intervalValue: e.target.value })}
          className={`${inputClass} w-24`}
        />
        <select
          aria-label="Repeat interval unit"
          value={draft.intervalUnit}
          onChange={e => setDraft({ ...draft, intervalUnit: e.target.value as IntervalUnit })}
          className={inputClass}>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>
      <label className="mb-1 mt-2 block text-xs text-gray-400" htmlFor="schedule-max-runs">
        Stop after (number of runs — leave blank to run forever)
      </label>
      <input
        id="schedule-max-runs"
        type="number"
        min={1}
        value={draft.maxRuns}
        onChange={e => setDraft({ ...draft, maxRuns: e.target.value })}
        placeholder="∞"
        className={inputClass}
      />
      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setDraft(null);
            setError(null);
          }}
          className="rounded-md border border-white/30 px-3 py-1 text-sm text-gray-300 hover:text-white">
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="rounded-md bg-white px-3 py-1 text-sm font-medium text-black hover:bg-gray-200">
          Save
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-white">
          <FiClock size={18} />
          <span className="text-sm font-semibold">Schedules</span>
        </div>
        {!draft && (
          <button
            type="button"
            onClick={() => {
              setDraft(emptyDraft());
              setError(null);
            }}
            className="flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-medium text-black hover:bg-gray-200">
            <FiPlus size={14} /> New
          </button>
        )}
      </div>

      {form}

      {schedules.length === 0 && !draft && (
        <div className="mt-8 text-center text-sm text-gray-500">
          No schedules yet. Create one and the agent will run it automatically at the times you choose — even when this
          panel is closed.
        </div>
      )}

      <div className="space-y-2">
        {schedules.map(schedule => {
          const next = nextRunAt(schedule, Date.now());
          const complete = isScheduleComplete(schedule);
          const runs = schedule.runs ?? [];
          const expanded = expandedId === schedule.id;
          return (
            <div key={schedule.id} className="rounded-lg border border-white/20 bg-[#0A0A0A] p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 break-words text-sm text-white">{schedule.task}</div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(toDraft(schedule));
                      setError(null);
                    }}
                    className="text-gray-400 hover:text-white"
                    aria-label="Edit schedule"
                    title="Edit">
                    <FiEdit2 size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(schedule.id)}
                    className="text-gray-400 hover:text-white"
                    aria-label="Delete schedule"
                    title="Delete">
                    <FiTrash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="mt-2 space-y-0.5 text-xs text-gray-400">
                <div>
                  Every {describeInterval(schedule.intervalMinutes)} ·{' '}
                  {schedule.maxRuns === null
                    ? `${schedule.runCount} runs so far, no limit`
                    : `run ${schedule.runCount} of ${schedule.maxRuns}`}
                </div>
                {complete ? (
                  <div>Finished — all runs completed.</div>
                ) : schedule.enabled && next ? (
                  <div>Next run: {new Date(next).toLocaleString()}</div>
                ) : (
                  <div>Paused.</div>
                )}
                {schedule.lastRunAt && (
                  <div>
                    Last run: {new Date(schedule.lastRunAt).toLocaleString()}
                    {schedule.lastRunStatus ? ` (${schedule.lastRunStatus})` : ''}
                  </div>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                {!complete && (
                  <button
                    type="button"
                    onClick={() => handleToggle(schedule)}
                    className="rounded-md border border-white/30 px-2 py-0.5 text-xs text-gray-300 hover:text-white">
                    {schedule.enabled ? 'Pause' : 'Resume'}
                  </button>
                )}
                {runs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : schedule.id)}
                    className="flex items-center gap-1 rounded-md border border-white/30 px-2 py-0.5 text-xs text-gray-300 hover:text-white"
                    aria-expanded={expanded}>
                    {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                    Runs ({runs.length})
                  </button>
                )}
              </div>
              {expanded && (
                <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
                  {runs.map(run => (
                    <div key={run.sessionId} className="flex items-center justify-between gap-2 text-xs">
                      <div className="min-w-0 flex-1 truncate text-gray-400">
                        {new Date(run.startedAt).toLocaleString()} ·{' '}
                        <span
                          className={
                            run.status === 'ok'
                              ? 'text-green-400'
                              : run.status === 'running'
                                ? 'animate-pulse text-gray-300'
                                : 'text-red-400'
                          }>
                          {run.status}
                        </span>
                        {run.endedAt !== null && ` · ${describeDuration(run.startedAt, run.endedAt)}`}
                      </div>
                      <button
                        type="button"
                        onClick={() => onOpenRun(run.sessionId)}
                        className="shrink-0 text-gray-400 underline hover:text-white">
                        View trace
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ScheduleList;
