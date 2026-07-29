import { runSitting, getProgress } from './prospecting';
import { createLogger } from './log';

const logger = createLogger('autopilot');

/**
 * Pass 2 Step 3 — the pacing engine.
 *
 * Turns the manual "Run one sitting" into an unattended day: short sittings at
 * a human pace, long randomized breaks, active hours only, and a full stop for
 * the day whenever the worker or the server reports a halt. All the risk
 * controls stay where they already live — the server owns the daily cap and
 * warm-up ramp (capForToday), the sitting worker owns the checkpoint
 * kill-switches — this module only decides WHEN the next sitting happens.
 *
 * chrome.alarms drives the schedule so it survives service-worker sleeps and
 * browser restarts; state lives in chrome.storage.local for the same reason.
 */

const ALARM = 'pass2-autopilot';
const STATE_KEY = 'pass2_autopilot';

/** Working hours, local time — when a person would plausibly be at a desk. */
const ACTIVE_START_MIN = 9 * 60; // 09:00
const ACTIVE_END_MIN = 21 * 60; // 21:00

/** Profiles per sitting and the break between sittings — both jittered so no
 *  two days produce the same rhythm. */
const SITTING_MIN = 8;
const SITTING_MAX = 15;
const BREAK_MIN_MS = 15 * 60_000;
const BREAK_MAX_MS = 45 * 60_000;

/** A sitting already in progress (e.g. started by hand) — look again shortly. */
const BUSY_RETRY_MS = 5 * 60_000;

export interface AutopilotState {
  enabled: boolean;
  /** When the next sitting is due, epoch ms — null when disabled. */
  nextRunAt: number | null;
  /** Outcome of the last automatic sitting, for the dashboard. */
  lastSummary: string;
}

const jitter = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));

export async function getAutopilotState(): Promise<AutopilotState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return (
    (stored[STATE_KEY] as AutopilotState | undefined) ?? { enabled: false, nextRunAt: null, lastSummary: '' }
  );
}

async function setAutopilotState(patch: Partial<AutopilotState>): Promise<AutopilotState> {
  const next = { ...(await getAutopilotState()), ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

function minutesIntoDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function withinActiveHours(d = new Date()): boolean {
  const m = minutesIntoDay(d);
  return m >= ACTIVE_START_MIN && m < ACTIVE_END_MIN;
}

/**
 * The next moment work may start: today's window if it hasn't opened yet,
 * otherwise tomorrow's — plus up to 90 minutes of jitter so no two days
 * begin at the same minute.
 */
function nextWindowStart(from = new Date()): number {
  const start = new Date(from);
  start.setHours(Math.floor(ACTIVE_START_MIN / 60), ACTIVE_START_MIN % 60, 0, 0);
  if (minutesIntoDay(from) >= ACTIVE_START_MIN) start.setDate(start.getDate() + 1);
  return start.getTime() + jitter(0, 90 * 60_000);
}

async function schedule(when: number): Promise<void> {
  await chrome.alarms.create(ALARM, { when });
  await setAutopilotState({ nextRunAt: when });
  logger.info('next sitting at', new Date(when).toLocaleString());
}

/** Summaries that mean "today is over" rather than "take a break". */
const DAY_OVER =
  /(paused for today|stopped for today|nothing to visit|queue is empty|limit is reached|out of (?:coins|credits))/i;
/** Summaries that mean autopilot cannot usefully continue at all. */
const DEAD = /(no account connected)/i;

async function tick(): Promise<void> {
  const state = await getAutopilotState();
  if (!state.enabled) return;

  if ((await getProgress()).running) {
    await schedule(Date.now() + BUSY_RETRY_MS);
    return;
  }

  if (!withinActiveHours()) {
    await schedule(nextWindowStart());
    return;
  }

  const summary = await runSitting(jitter(SITTING_MIN, SITTING_MAX)).catch(e => `Stopped: ${(e as Error).message}`);
  await setAutopilotState({ lastSummary: summary });

  if (DEAD.test(summary)) {
    // Pointless to keep waking up — turn off and say why.
    await disableAutopilot(summary);
    return;
  }

  const halted = (await getProgress()).halted;
  if (halted || DAY_OVER.test(summary)) {
    await schedule(nextWindowStart());
    return;
  }

  await schedule(Date.now() + jitter(BREAK_MIN_MS, BREAK_MAX_MS));
}

export async function enableAutopilot(): Promise<AutopilotState> {
  await setAutopilotState({ enabled: true, lastSummary: '' });
  // First sitting starts almost immediately when inside the window (small
  // jitter so enabling never reads as an instant robotic reaction).
  const when = withinActiveHours() ? Date.now() + jitter(20_000, 90_000) : nextWindowStart();
  await schedule(when);
  return getAutopilotState();
}

export async function disableAutopilot(reason?: string): Promise<AutopilotState> {
  await chrome.alarms.clear(ALARM);
  return setAutopilotState({ enabled: false, nextRunAt: null, ...(reason ? { lastSummary: reason } : {}) });
}

/** Called once at service-worker start: re-arm the alarm if it was lost. */
export function initAutopilot(): void {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) void tick();
  });
  void (async () => {
    const state = await getAutopilotState();
    if (!state.enabled) return;
    const alarm = await chrome.alarms.get(ALARM);
    if (!alarm) {
      // Alarm evaporated (browser restart edge) — pick the schedule back up.
      await schedule(withinActiveHours() ? Date.now() + jitter(60_000, 5 * 60_000) : nextWindowStart());
    }
  })();
}
