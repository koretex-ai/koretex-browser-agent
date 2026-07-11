import type { Action, PerceptionSnapshot } from '@extension/storage';
import { trajectoryStore } from '@extension/storage';
import { createLogger } from '../log';
import { getLastSnapshot, runInPage } from '../perception';
import { clickElementByIndex, clickAtPoint, typeIntoElement, scrollPage } from '../perception/pageScript';

const logger = createLogger('executor');

// Give the page a beat to react (navigation start, DOM updates) after an action
const POST_ACTION_DELAY_MS = 500;

export interface ActionResult {
  ok: boolean;
  message: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForTabLoad(tabId: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    if (Date.now() - start > timeoutMs) return;
    await sleep(200);
  }
}

async function performAction(tabId: number, action: Action): Promise<ActionResult> {
  switch (action.type) {
    case 'click': {
      const result = await runInPage(tabId, clickElementByIndex, action.index);
      if (!result?.ok) return { ok: false, message: result?.error ?? 'Click failed' };
      await sleep(POST_ACTION_DELAY_MS);
      await waitForTabLoad(tabId);
      return {
        ok: true,
        message: `Clicked element [${action.index}]${result.recovered ? ' (page had re-rendered; clicked its last known position)' : ''}`,
      };
    }
    case 'click_at': {
      const result = await runInPage(tabId, clickAtPoint, action.x, action.y);
      if (!result?.ok) return { ok: false, message: result?.error ?? 'Click failed' };
      await sleep(POST_ACTION_DELAY_MS);
      await waitForTabLoad(tabId);
      return {
        ok: true,
        message: `Clicked at (${action.x}, ${action.y})${result.hit ? `, hit ${result.hit}` : ''}`,
      };
    }
    case 'type': {
      const result = await runInPage(tabId, typeIntoElement, action.index, action.text);
      if (!result?.ok) return { ok: false, message: result?.error ?? 'Type failed' };
      return { ok: true, message: `Typed "${action.text}" into element [${action.index}]` };
    }
    case 'scroll': {
      // undefined is not serializable as an executeScript arg — pass null
      await runInPage(tabId, scrollPage, action.direction, action.amount ?? null);
      await sleep(300);
      return { ok: true, message: `Scrolled ${action.direction}` };
    }
    case 'navigate': {
      const url = /^[a-z]+:\/\//i.test(action.url) ? action.url : `https://${action.url}`;
      await chrome.tabs.update(tabId, { url });
      await sleep(POST_ACTION_DELAY_MS);
      await waitForTabLoad(tabId);
      return { ok: true, message: `Navigated to ${url}` };
    }
    case 'back': {
      await chrome.tabs.goBack(tabId);
      await sleep(POST_ACTION_DELAY_MS);
      await waitForTabLoad(tabId);
      return { ok: true, message: 'Went back' };
    }
    case 'done': {
      return { ok: true, message: action.message };
    }
  }
}

/**
 * Execute a typed action against a tab and log the step to the trajectory
 * store (the data flywheel records from the very first action).
 *
 * IMPORTANT: this never re-perceives. The pre-action snapshot is the one the
 * decision was made against — the caller's capture, or the module-tracked
 * last snapshot. Re-extracting here would rebuild the in-page element
 * registry and invalidate the indices the planner just chose (SPA pages
 * morph continuously, so the two extractions disagree).
 */
export async function executeAction(
  tabId: number,
  sessionId: string,
  action: Action,
  beforeSnapshot?: PerceptionSnapshot | null,
): Promise<ActionResult> {
  let before: PerceptionSnapshot | null = null;
  if (action.type !== 'navigate' && action.type !== 'done') {
    before = beforeSnapshot !== undefined ? beforeSnapshot : getLastSnapshot();
  }

  let result: ActionResult;
  try {
    result = await performAction(tabId, action);
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (before) {
    trajectoryStore
      .appendStep({
        sessionId,
        before,
        action,
        ok: result.ok,
        error: result.ok ? undefined : result.message,
        timestamp: Date.now(),
      })
      .catch(error => logger.warning('trajectory logging failed:', error));
  }

  logger.info('action', JSON.stringify(action), '->', result.message);
  return result;
}
