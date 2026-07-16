import { createLogger } from '../log';
import { withTimeout } from '../net';

const logger = createLogger('cdp');

// A wedged tab can hang chrome.debugger calls indefinitely; nothing the
// conductor awaits may hang (net.ts principle) — a stall must surface as a
// labeled error, not a silent forever-spinner
const CDP_ATTACH_TIMEOUT_MS = 10_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;

/**
 * CDP escape hatch (DESIGN.md Phase 6): trusted input via chrome.debugger.
 *
 * Synthetic DOM events (isTrusted: false) are ignored by canvas-rendered
 * editors — Google Docs/Sheets route text through Chrome's real input
 * pipeline. Input.insertText / Input.dispatchKeyEvent inject at that level,
 * indistinguishable from a physical keyboard.
 *
 * Scope: KEYBOARD ONLY. CDP mouse input is deliberately not used — attaching
 * the debugger shows an infobar that reflows the viewport, which would shift
 * coordinates captured before attach (the vision grounder's click space).
 * Keyboard input is coordinate-free and immune to that.
 *
 * Lifecycle: attach lazily on first use, STAY attached (a stable infobar
 * means stable page geometry for perception), detach at task end.
 */

const PROTOCOL_VERSION = '1.3';
const attached = new Set<number>();

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await withTimeout(chrome.debugger.attach({ tabId }, PROTOCOL_VERSION), CDP_ATTACH_TIMEOUT_MS, 'debugger attach');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already attached/i.test(message)) {
      throw new Error(
        `Cannot attach debugger to the tab (${message}). If DevTools is open on this tab, close it and retry.`,
      );
    }
  }
  attached.add(tabId);
  logger.info('debugger attached to tab', tabId);
}

/** Detach at task end (also safe to call when never attached). */
export async function detachCdp(tabId: number): Promise<void> {
  dialogCallbacks.delete(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  logger.info('debugger detached from tab', tabId);
}

// Chrome cleans up on tab close; keep our bookkeeping in sync
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId !== undefined) {
    attached.delete(source.tabId);
    dialogCallbacks.delete(source.tabId);
  }
});

// ---- NATIVE DIALOG GUARD ----
// A native browser dialog (beforeunload "Leave site?", alert, confirm) is
// invisible to every sense the agent has: it is not in the DOM, synthetic
// clicks cannot reach it, CDP keyboard input goes to the PAGE not the
// browser, and page JS is FROZEN while it is up — so perception times out
// and the run goes blind (live failure 2026-07-16: an unsaved Sheets tab
// popped "Leave site?" on navigate and the run starved to death on blind
// waits). The ONLY channel that can press those buttons is the debugger's
// Page domain, so the guard must live here in the harness, not in prompts.
//
// Policy: beforeunload is auto-ACCEPTED — the agent itself decided to
// navigate; the dialog is Chrome double-checking. That may discard unsaved
// page state, so the callback surfaces what happened for the journal.
// alert has only one button — accept. confirm/prompt are auto-DISMISSED
// (the conservative answer); the journal note lets the navigator route
// around whatever the page wanted to confirm.

export interface DialogEvent {
  kind: string;
  message: string;
  accepted: boolean;
}

const dialogCallbacks = new Map<number, (event: DialogEvent) => void>();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Page.javascriptDialogOpening' || source.tabId === undefined) return;
  const { type, message } = (params ?? {}) as { type?: string; message?: string };
  const accept = type === 'beforeunload' || type === 'alert';
  chrome.debugger
    .sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', { accept })
    .catch(error => logger.warning('could not handle native dialog:', error));
  logger.info(`native ${type ?? 'dialog'} ${accept ? 'accepted' : 'dismissed'} on tab`, source.tabId);
  dialogCallbacks.get(source.tabId)?.({ kind: type ?? 'dialog', message: message ?? '', accepted: accept });
});

/**
 * Attach (if needed) and start auto-handling native dialogs on this tab for
 * the rest of the task. Attaching up front also FIXES page geometry for the
 * whole run — the debugger infobar reflows the viewport once, before the
 * first perception, instead of mid-task on the first type_focused.
 */
export async function armDialogGuard(tabId: number, onDialog: (event: DialogEvent) => void): Promise<void> {
  await send(tabId, 'Page.enable');
  dialogCallbacks.set(tabId, onDialog);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(tabId: number, method: string, params?: Record<string, any>): Promise<void> {
  await ensureAttached(tabId);
  await withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), CDP_COMMAND_TIMEOUT_MS, `CDP ${method}`);
}

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  /** Character produced by the key, for keys that type text */
  text?: string;
}

const NAMED_KEYS: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
};

// US-layout virtual keycodes for printable punctuation. NEVER derive a
// keycode from the character's char code: the ASCII codes of punctuation
// collide with NAVIGATION keycodes — "&" is 38 (ArrowUp) and "'" is 39
// (ArrowRight), so Sheets committed cells mid-word and walked the selection
// around the grid ("Founder & Managing Director" overwrote the row above;
// "D'Souza" split across two columns — live run 2026-07-16).
const PUNCTUATION_KEYCODES: Record<string, number> = {
  '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48,
  '-': 189, _: 189, '=': 187, '+': 187, '[': 219, '{': 219, ']': 221, '}': 221, '\\': 220, '|': 220,
  ';': 186, ':': 186, "'": 222, '"': 222, ',': 188, '<': 188, '.': 190, '>': 190, '/': 191, '?': 191,
  '`': 192, '~': 192,
};

function keySpecFor(rawKey: string): KeySpec {
  const named = NAMED_KEYS[rawKey.toLowerCase()];
  if (named) return named;
  if (rawKey.length === 1) {
    if (/[a-z]/i.test(rawKey)) {
      const upper = rawKey.toUpperCase();
      return { key: rawKey, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: rawKey };
    }
    if (/[0-9]/.test(rawKey)) {
      return { key: rawKey, code: `Digit${rawKey}`, keyCode: rawKey.charCodeAt(0), text: rawKey };
    }
    // Punctuation and other printables: mapped keycode or none at all —
    // insertion is driven by the `text` field either way, and keyCode 0 can
    // never be mistaken for a navigation key
    return { key: rawKey, code: '', keyCode: PUNCTUATION_KEYCODES[rawKey] ?? 0, text: rawKey };
  }
  // Pass through unknown named keys ("F5" etc.) and let Chrome interpret
  return { key: rawKey, code: rawKey, keyCode: 0 };
}

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8
function modifierBits(mods: Set<string>): number {
  return (
    (mods.has('alt') || mods.has('option') ? 1 : 0) +
    (mods.has('ctrl') || mods.has('control') ? 2 : 0) +
    (mods.has('cmd') || mods.has('meta') ? 4 : 0) +
    (mods.has('shift') ? 8 : 0)
  );
}

/** Press a key (optionally with modifiers, e.g. "Enter", "Ctrl+A") as
 * trusted input. */
export async function cdpKey(tabId: number, combo: string): Promise<void> {
  const parts = combo
    .split('+')
    .map(s => s.trim())
    .filter(Boolean);
  const rawKey = parts.pop() ?? '';
  if (!rawKey) throw new Error('key requires a key name, e.g. "Enter"');
  const spec = keySpecFor(rawKey);
  const modifiers = modifierBits(new Set(parts.map(p => p.toLowerCase())));

  await send(tabId, 'Input.dispatchKeyEvent', {
    type: spec.text && !modifiers ? 'keyDown' : 'rawKeyDown',
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers,
    ...(spec.text && !modifiers ? { text: spec.text, unmodifiedText: spec.text } : {}),
  });
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers,
  });
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Human-plausible pacing. CDP can fire keys ~1ms apart — far faster than any
// typist — but Sheets opens its cell editor on the FIRST keystroke and
// commits on Enter/Tab asynchronously; keys racing those transitions can be
// silently dropped by the page. Typical cost: a 5-row write ≈ 1.5s.
const COMMIT_SETTLE_MS = 150; // after Enter/Tab: commit + selection move
const EDIT_OPEN_MS = 100; // after a segment's first char: editor opening
const CHAR_MS = 5; // between ordinary characters

/** One printable character as a real keydown/keyup pair. */
async function cdpChar(tabId: number, ch: string): Promise<void> {
  const spec = keySpecFor(ch);
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    text: ch,
    unmodifiedText: ch,
  });
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  });
}

/**
 * Type text into whatever currently has keyboard focus, as trusted input —
 * PER-CHARACTER key events, never Input.insertText. insertText pastes into a
 * focused text FIELD, but a selected spreadsheet grid cell is not a text
 * field until a real keystroke opens its cell editor: an entire Sheets write
 * landed nowhere (2026-07-16) while Delete — a real key event — worked fine.
 * Real keydowns enter cell edit mode exactly like a physical keyboard, and
 * still work in Docs and plain form fields (same trusted input pipeline).
 *
 * Tabs and newlines are pressed as real Tab/Enter keys — in a grid they move
 * across columns / down rows (insertText treated \t as literal text, which
 * concatenated whole rows into one cell).
 *
 * INSERT semantics — no automatic select-all. The old idempotency trick
 * (Cmd+A before typing) selected ALL CELLS in a spreadsheet GRID instead of
 * text, so nothing was ever typed (live failure 2026-07-15: an entire Sheets
 * write landed nowhere while the selection showed 1:1000). Clean-state
 * before a redo is now the navigator's decision — it can SEE leftovers on
 * the screenshot and clear them explicitly.
 */
export async function cdpTypeFocused(tabId: number, text: string): Promise<void> {
  // Grid-style payload (tab-separated columns): after Enter commits a row,
  // Sheets moves DOWN from the CURRENT column — the "return to the column
  // where the row started" behavior of physical keyboards is not honored for
  // CDP-dispatched Tab/Enter, so each row started one column further right
  // (live diagonal, 2026-07-16). Press Home after each Enter to return to
  // the row's first column explicitly. Only for tabbed payloads — Home means
  // other things in text editors.
  const grid = text.includes('\t');
  let segmentStart = true;
  for (const ch of text) {
    if (ch === '\r') continue; // \r\n → one Enter, not two
    if (ch === '\n' || ch === '\t') {
      await cdpKey(tabId, ch === '\n' ? 'Enter' : 'Tab');
      await sleep(COMMIT_SETTLE_MS);
      if (ch === '\n' && grid) {
        await cdpKey(tabId, 'Home');
        await sleep(CHAR_MS);
      }
      segmentStart = true;
      continue;
    }
    await cdpChar(tabId, ch);
    await sleep(segmentStart ? EDIT_OPEN_MS : CHAR_MS);
    segmentStart = false;
  }
}
