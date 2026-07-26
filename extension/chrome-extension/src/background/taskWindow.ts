import { createLogger } from './log';

const logger = createLogger('taskWindow');

/**
 * Dedicated agent window for INTERACTIVE tasks (user decision 2026-07-20):
 * a task never borrows the tab the user is browsing — it runs in its own
 * window so the user keeps using theirs. Desktop-sized on purpose (the
 * vision grounder needs >=1280px screenshots and sites must render desktop
 * layouts). VISIBLE by design (user decision 2026-07-22): the window is
 * brought to the FRONT at task start — created focused, and an existing
 * agent window is re-focused when a new task lands in it — so the user can
 * watch the agent work (previously it opened unfocused and sat hidden
 * behind the user's window, which read as "no window opened"). The user can
 * click back to their own window; CDP capture keeps working unfocused.
 * NEVER minimized — Chrome freezes the pages of minimized windows.
 *
 * Reuse policy:
 * - Same session (follow-up / "continue") -> the session's existing tab,
 *   with the stalled page still loaded — continuations re-observe it live.
 * - New session with the agent window still open -> a NEW TAB in it (old
 *   deliverable tabs stay open by policy; the window collects them).
 * - Otherwise -> a fresh window.
 *
 * Scheduled runs keep their own window lifecycle (schedules.ts): they close
 * it wholesale at run end; interactive windows stay open because the
 * deliverable (e.g. the written sheet) usually lives in one of the tabs.
 *
 * State is in-memory only: a service-worker restart forgets the window and
 * the next task simply opens a fresh one.
 */

let agentWindowId: number | null = null;
let viewerWindowId: number | null = null;
const sessionTabs = new Map<string, { windowId: number; tabId: number }>();

chrome.windows.onRemoved.addListener(windowId => {
  if (windowId === agentWindowId) {
    agentWindowId = null;
    // The agent window is gone — its companion trace viewer has nothing to
    // narrate; close it too
    if (viewerWindowId !== null) {
      chrome.windows.remove(viewerWindowId).catch(() => {});
      viewerWindowId = null;
    }
  }
  if (windowId === viewerWindowId) viewerWindowId = null;
  for (const [sessionId, entry] of sessionTabs) {
    if (entry.windowId === windowId) sessionTabs.delete(sessionId);
  }
});

/**
 * Companion TRACE VIEWER: the panel page in a small popup window docked to
 * the agent window's right edge. chrome.sidePanel.open() refuses to run
 * without a user gesture (confirmed live 2026-07-20 — the panel never
 * opened), so the trace gets its own popup instead: execution events
 * broadcast to every connected panel (index.ts), and this one is always
 * there to show them next to the tabs being driven.
 */
async function ensureTraceViewer(agentWin: chrome.windows.Window): Promise<void> {
  if (viewerWindowId !== null) {
    const alive = await chrome.windows.get(viewerWindowId).catch(() => null);
    if (alive) return;
    viewerWindowId = null;
  }
  const viewer = await chrome.windows
    .create({
      url: chrome.runtime.getURL('side-panel/index.html'),
      type: 'popup',
      focused: false,
      width: 420,
      height: agentWin.height ?? 900,
      left: (agentWin.left ?? 0) + (agentWin.width ?? 1290),
      top: agentWin.top ?? 0,
    })
    .catch(error => {
      logger.warning('could not open the trace viewer window', error);
      return null;
    });
  if (viewer?.id !== undefined) viewerWindowId = viewer.id;
}

export type TaskTabAcquisition = { tabId: number; created: 'window' | 'tab' | 'reused' };

/** Whether a follow-up on this session will reuse an existing live tab (no
 * new window/tab announcement needed). */
export async function hasSessionTab(sessionId: string): Promise<boolean> {
  const prior = sessionTabs.get(sessionId);
  if (!prior) return false;
  return (await chrome.tabs.get(prior.tabId).catch(() => null)) !== null;
}

/**
 * Keep the session→tab mapping pointing at the tab the run is ACTUALLY
 * using. The stepwise engine opens each site in its own tab (tab-per-site),
 * so the tab a run ends on is rarely the tab it was handed — without this,
 * a follow-up "reused" the original ABOUT:BLANK starter tab and ran blind
 * (live failure 2026-07-21: every turn "no screenshot available", scrolling
 * a blank page).
 */
export function rebindSessionTab(sessionId: string, tabId: number): void {
  const prior = sessionTabs.get(sessionId);
  if (prior && prior.tabId !== tabId) sessionTabs.set(sessionId, { windowId: prior.windowId, tabId });
}

export async function acquireTaskTab(sessionId: string): Promise<TaskTabAcquisition | null> {
  // Bring the agent window to the front so the user can watch the run
  const surface = (windowId: number) => chrome.windows.update(windowId, { focused: true }).catch(() => {});

  // Same session -> same tab: its page state is the run's context
  const prior = sessionTabs.get(sessionId);
  if (prior) {
    const tab = await chrome.tabs.get(prior.tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.update(prior.tabId, { active: true }).catch(() => {});
      await surface(prior.windowId);
      return { tabId: prior.tabId, created: 'reused' };
    }
    sessionTabs.delete(sessionId);
  }

  // Agent window still open -> a new tab in it
  if (agentWindowId !== null) {
    const win = await chrome.windows.get(agentWindowId).catch(() => null);
    if (win) {
      const tab = await chrome.tabs
        .create({ windowId: agentWindowId, url: 'about:blank', active: true })
        .catch(() => null);
      if (tab?.id !== undefined) {
        sessionTabs.set(sessionId, { windowId: agentWindowId, tabId: tab.id });
        await surface(agentWindowId);
        await ensureTraceViewer(win);
        return { tabId: tab.id, created: 'tab' };
      }
    }
    agentWindowId = null;
  }

  // Fresh dedicated window — created FOCUSED so it opens in front
  const win = await chrome.windows
    .create({ url: 'about:blank', focused: true, width: 1290, height: 900 })
    .catch(error => {
      logger.error('could not open the agent window', error);
      return null;
    });
  const tabId = win?.tabs?.[0]?.id;
  if (win?.id === undefined || tabId === undefined) return null;
  agentWindowId = win.id;
  sessionTabs.set(sessionId, { windowId: win.id, tabId });
  await ensureTraceViewer(win);
  return { tabId, created: 'window' };
}
