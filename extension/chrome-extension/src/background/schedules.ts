import { Actors, chatHistoryStore, scheduleStore, isScheduleComplete, nextRunAt } from '@extension/storage';
import { SCHEDULES_STORAGE_KEY } from '@extension/storage/lib/schedules/store';
import { createLogger } from './log';
import { runAgentTask } from './agent/loop';

const logger = createLogger('schedules');

const ALARM_PREFIX = 'schedule:';

/**
 * Abort handle of the currently-running scheduled occurrence. Claimed
 * SYNCHRONOUSLY in the alarm listener — the claim must happen before any
 * await, or two near-simultaneous alarms both pass the busy check and end up
 * typing into the same page at once.
 */
let scheduledRunAbort: AbortController | null = null;

/** Injected by index.ts so a scheduled run yields to a live user task */
let isUserTaskRunning: () => boolean = () => false;

export const setUserTaskProbe = (probe: () => boolean) => {
  isUserTaskRunning = probe;
};

/** A user task always wins the tab: index.ts calls this when one starts */
export const cancelScheduledRun = () => {
  scheduledRunAbort?.abort();
};

/**
 * Rebuild chrome.alarms from the schedule store. Called at service-worker
 * startup and whenever the store changes (the side panel writes directly to
 * storage; no message round-trip needed).
 */
export async function syncScheduleAlarms(): Promise<void> {
  const existing = await chrome.alarms.getAll();
  await Promise.all(existing.filter(a => a.name.startsWith(ALARM_PREFIX)).map(a => chrome.alarms.clear(a.name)));

  const schedules = await scheduleStore.getAll();
  const now = Date.now();
  for (const schedule of schedules) {
    const when = nextRunAt(schedule, now);
    if (when === null) continue;
    chrome.alarms.create(ALARM_PREFIX + schedule.id, {
      when,
      // chrome.alarms handles the recurrence; maxRuns is enforced in the
      // handler (recordRun disables the schedule, which clears the alarm)
      periodInMinutes: schedule.intervalMinutes,
    });
  }
  logger.info('alarms synced', schedules.length, 'schedules');
}

/**
 * Dedicated window for a scheduled occurrence — scheduled runs must never
 * borrow the user's tab (live complaint 2026-07-20: a schedule navigated
 * away from the page the user was on). Desktop-sized on purpose: the width
 * keeps sites in their desktop layouts and satisfies the grounder's >=1280px
 * screenshot requirement; opened unfocused so it lands behind the user's
 * work; removed again when the run ends. NEVER minimized — Chrome freezes
 * the pages of minimized windows (rAF stops), which is what wedged the first
 * live scheduled run.
 */
async function openScheduledWindow(): Promise<{ windowId: number; tabId: number } | null> {
  try {
    const win = await chrome.windows.create({
      url: 'about:blank',
      focused: false,
      width: 1290,
      height: 900,
    });
    const tabId = win?.tabs?.[0]?.id;
    if (win?.id === undefined || tabId === undefined) return null;
    return { windowId: win.id, tabId };
  } catch (error) {
    logger.error('could not open a dedicated window for the scheduled run', error);
    return null;
  }
}

/**
 * One occurrence: run the schedule's task in its own dedicated window,
 * persisting progress into a fresh chat session so the run is inspectable
 * from History even when the side panel is closed.
 */
async function runScheduledTask(scheduleId: string, abort: AbortController): Promise<void> {
  const schedule = await scheduleStore.get(scheduleId);
  if (!schedule || !schedule.enabled || isScheduleComplete(schedule)) {
    await chrome.alarms.clear(ALARM_PREFIX + scheduleId);
    return;
  }

  // Session first: it doubles as the run's trace, so even a run that dies
  // before touching the browser leaves an inspectable record. beginRun links
  // the session to the schedule's run history (shown in the Schedules panel).
  const session = await chatHistoryStore.createSession(
    `⏰ ${schedule.task.substring(0, 50)}${schedule.task.length > 50 ? '...' : ''}`,
  );
  await chatHistoryStore.addMessage(session.id, {
    actor: Actors.USER,
    content: `Scheduled run #${schedule.runCount + 1}: ${schedule.task}`,
    timestamp: Date.now(),
  });
  await scheduleStore.beginRun(scheduleId, session.id);

  const dedicated = await openScheduledWindow();
  if (!dedicated) {
    await chatHistoryStore.addMessage(session.id, {
      actor: Actors.SYSTEM,
      content: 'Could not open a browser window to run in.',
      timestamp: Date.now(),
    });
    await scheduleStore.finishRun(scheduleId, session.id, 'failed — could not open a browser window');
    return;
  }
  const { windowId, tabId } = dedicated;

  // runAgentTask only ever calls postMessage on the port; this shim routes
  // the events into chat history instead of a live side panel
  let finalState = 'task.fail';
  const historyPort = {
    postMessage: (message: { type?: string; state?: string; data?: { details?: string; meta?: string } }) => {
      if (message?.type !== 'execution' || !message.state) return;
      if (message.state === 'task.start') return;
      if (['task.ok', 'task.fail', 'task.cancel', 'step.ok'].includes(message.state)) {
        if (message.state !== 'step.ok') finalState = message.state;
        chatHistoryStore
          .addMessage(session.id, {
            actor: message.state === 'task.ok' ? Actors.ASSISTANT : Actors.SYSTEM,
            content: message.data?.details || (message.state === 'task.ok' ? 'Done.' : 'Failed.'),
            timestamp: Date.now(),
            meta: message.data?.meta,
          })
          .catch(err => logger.error('failed to persist scheduled-run message', err));
      }
    },
  } as unknown as chrome.runtime.Port;

  logger.info('scheduled run starting', scheduleId, schedule.task);
  // The page will show artifacts of earlier occurrences (identical messages,
  // posts, rows); the agent must deliver a FRESH result this run, and never
  // mistake prior artifacts for this run's outcome.
  const objective =
    `${schedule.task}\n\n` +
    `(This is occurrence #${schedule.runCount + 1} of a recurring schedule. Earlier occurrences already ran, ` +
    `so the page may already show identical results from before — those prove nothing about this run. ` +
    `Perform the task freshly now, and judge it delivered only on evidence produced by this run.)`;
  try {
    await runAgentTask(historyPort, tabId, session.id, objective, abort.signal);
  } catch (error) {
    logger.error('scheduled run crashed', error);
    finalState = 'task.fail';
  } finally {
    // The run is over either way — its window has served its purpose. If the
    // user closed it mid-run this is a no-op (and the run failed on its own).
    await chrome.windows.remove(windowId).catch(() => {});
  }
  if (abort.signal.aborted) finalState = 'task.cancel';

  const updated = await scheduleStore.finishRun(
    scheduleId,
    session.id,
    finalState === 'task.ok' ? 'ok' : finalState === 'task.cancel' ? 'cancelled — a user task took over' : 'failed',
  );
  if (updated && (!updated.enabled || isScheduleComplete(updated))) {
    await chrome.alarms.clear(ALARM_PREFIX + scheduleId);
  }
}

/** Wire up alarm + storage listeners; call once from the service worker */
export function initSchedules(): void {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const scheduleId = alarm.name.slice(ALARM_PREFIX.length);

    // Never stack agent runs: a live user task or another occurrence wins.
    // The missed occurrence is skipped (not replayed) and does not count.
    // Checked and claimed synchronously — no await may precede this.
    if (scheduledRunAbort || isUserTaskRunning()) {
      logger.warning('schedule skipped, another task is running', scheduleId);
      scheduleStore
        .get(scheduleId)
        .then(s => s && scheduleStore.upsert({ ...s, lastRunStatus: 'skipped — another task was running' }))
        .catch(err => logger.error('failed to record skip', err));
      return;
    }
    const abort = new AbortController();
    scheduledRunAbort = abort;

    runScheduledTask(scheduleId, abort)
      .catch(err => logger.error('scheduled run failed', err))
      .finally(() => {
        if (scheduledRunAbort === abort) scheduledRunAbort = null;
      });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SCHEDULES_STORAGE_KEY]) {
      syncScheduleAlarms().catch(err => logger.error('alarm sync failed', err));
    }
  });

  syncScheduleAlarms().catch(err => logger.error('initial alarm sync failed', err));
}
