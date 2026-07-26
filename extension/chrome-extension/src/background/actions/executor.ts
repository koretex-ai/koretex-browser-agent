import type { Action, PerceptionSnapshot } from '@extension/storage';
import { trajectoryStore } from '@extension/storage';
import { createLogger } from '../log';
import { getLastSnapshot, runInPage } from '../perception';
import { clickElementByIndex, clickAtPoint, typeIntoElement, scrollPage, pressKey } from '../perception/pageScript';
import { cdpKey, cdpTypeFocused } from './cdp';

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
      // Echo what was actually hit: the judge compares this against the
      // intended target and catches a wrong-element click on the next turn
      const hit = result.label
        ? ` — hit "${result.label}"${result.tag ? ` (${result.tag})` : ''}`
        : result.tag
          ? ` — hit an unlabeled <${result.tag}>`
          : '';
      return {
        ok: true,
        message: `Clicked element [${action.index}]${hit}${result.recovered ? ' (page had re-rendered; clicked its last known position)' : ''}`,
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
      // index -1 = type into the currently FOCUSED plain form field (the
      // vision-fallback path grounds + clicks first); pageScript reports
      // notEditable for rich/canvas surfaces so the caller can escalate to
      // trusted CDP input instead
      const result = await runInPage(tabId, typeIntoElement, action.index >= 0 ? action.index : null, action.text);
      if (!result?.ok)
        return {
          ok: false,
          message: `${result?.notEditable ? 'NOT_EDITABLE: ' : ''}${result?.error ?? 'Type failed'}`,
        };
      return {
        ok: true,
        message: `Typed "${action.text}" into ${action.index >= 0 ? `element [${action.index}]` : 'the focused field'}`,
      };
    }
    case 'scroll': {
      // undefined is not serializable as an executeScript arg — pass null
      await runInPage(tabId, scrollPage, action.direction, action.amount ?? null);
      await sleep(300);
      return { ok: true, message: `Scrolled ${action.direction}` };
    }
    case 'key': {
      // Trusted CDP input first (works everywhere, incl. canvas editors);
      // synthetic DOM events as fallback if the debugger cannot attach
      try {
        await cdpKey(tabId, action.combo);
      } catch (error) {
        logger.warning('CDP key failed, falling back to synthetic:', error);
        const result = await runInPage(tabId, pressKey, action.combo);
        if (!result?.ok) return { ok: false, message: result?.error ?? 'Key press failed' };
      }
      // Enter often submits/navigates — give the page time to react
      await sleep(POST_ACTION_DELAY_MS);
      await waitForTabLoad(tabId);
      return { ok: true, message: `Pressed ${action.combo}` };
    }
    case 'type_focused': {
      // CDP-only: this action exists precisely for surfaces where synthetic
      // events do nothing (Google Docs/Sheets canvas editors)
      await cdpTypeFocused(tabId, action.text);
      await sleep(POST_ACTION_DELAY_MS);
      return { ok: true, message: `Typed ${action.text.split('\n').length} line(s) into the focused editor` };
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
    case 'extract': {
      // The agent loop performs extraction (it needs an LLM call over the
      // page text) and logs the step itself; nothing to do in the page
      return { ok: true, message: `Extract: ${action.query}` };
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
export interface StepLogContext {
  subtaskId?: string;
  /** The planner's raw decision JSON, including reasoning */
  decision?: unknown;
  plannerModel?: string;
  /** The HISTORY lines the planner saw when deciding */
  historyContext?: string[];
}

export async function executeAction(
  tabId: number,
  sessionId: string,
  action: Action,
  beforeSnapshot?: PerceptionSnapshot | null,
  logContext?: StepLogContext,
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
        ...logContext,
      })
      .catch(error => logger.warning('trajectory logging failed:', error));
  }

  logger.info('action', JSON.stringify(action), '->', result.message);
  return result;
}
