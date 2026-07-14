import { createLogger } from '../log';

const logger = createLogger('cdp');

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
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
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
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  logger.info('debugger detached from tab', tabId);
}

// Chrome cleans up on tab close; keep our bookkeeping in sync
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(tabId: number, method: string, params?: Record<string, any>): Promise<void> {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, method, params);
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

function keySpecFor(rawKey: string): KeySpec {
  const named = NAMED_KEYS[rawKey.toLowerCase()];
  if (named) return named;
  if (rawKey.length === 1) {
    const upper = rawKey.toUpperCase();
    const code = /[a-z]/i.test(rawKey) ? `Key${upper}` : /[0-9]/.test(rawKey) ? `Digit${rawKey}` : '';
    return { key: rawKey, code, keyCode: upper.charCodeAt(0), text: rawKey };
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

/**
 * Type text into whatever currently has keyboard focus, as trusted input.
 * Newlines become real Enter presses (Input.insertText does not translate
 * them). Works in canvas editors (Google Docs/Sheets) that ignore synthetic
 * DOM events.
 *
 * REPLACE semantics, not append: select-all first so the initial insert
 * overwrites any existing content. This makes the step IDEMPOTENT — a retry
 * or a reflect-correction re-types cleanly instead of doubling the text
 * ("hello worldhello world"). Select-all on an empty editor is a no-op.
 */
export async function cdpTypeFocused(tabId: number, text: string): Promise<void> {
  // Cmd+A selects the focused editor's content; the first insertText below
  // replaces the selection. (macOS — the dev target; Meta is the select-all
  // modifier.)
  await cdpKey(tabId, 'Meta+A').catch(() => {});
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await send(tabId, 'Input.insertText', { text: lines[i] });
    if (i < lines.length - 1) await cdpKey(tabId, 'Enter');
  }
}
