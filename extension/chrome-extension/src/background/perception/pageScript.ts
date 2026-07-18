/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Functions in this file are injected into pages via chrome.scripting.executeScript.
 * They are serialized, so each must be fully self-contained: no imports, no
 * closures over module scope. Shared state lives on window.__lbu.
 */

export interface ExtractedPageState {
  url: string;
  title: string;
  scroll: { x: number; y: number; pageHeight: number; viewportHeight: number };
  elements: Array<{
    index: number;
    tag: string;
    role: string;
    text: string;
    placeholder: string;
    value: string;
    href: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
}

// Extract visible interactive elements, register them on window.__lbu, and
// optionally draw numbered set-of-marks overlays.
export function extractInteractiveElements(showHighlights: boolean): ExtractedPageState {
  const win = window as any;

  // Remove any previous overlay
  document.getElementById('__lbu_highlights')?.remove();

  const SELECTOR =
    'a, button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], ' +
    '[role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="switch"], ' +
    '[onclick], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

  // Collect candidates recursively through open shadow roots (Reddit, YouTube
  // and other web-component sites keep their interactive elements there)
  const collectCandidates = (root: Document | ShadowRoot | Element): HTMLElement[] => {
    const found: HTMLElement[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(SELECTOR))) {
      found.push(el);
    }
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) found.push(...collectCandidates(el.shadowRoot));
    }
    return found;
  };
  const candidates = collectCandidates(document);

  // elementFromPoint that descends through open shadow roots to the deepest node
  const deepElementFromPoint = (x: number, y: number): Element | null => {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  // containment check that crosses shadow boundaries (a.contains(b) is false
  // when b is inside a's shadow root)
  const composedContains = (a: Element, b: Element): boolean => {
    let node: Node | null = b;
    while (node) {
      if (node === a) return true;
      node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
    }
    return false;
  };

  const isVisible = (el: HTMLElement): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    // Viewport-only: set-of-marks describes what the eye (and screenshot) sees
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth)
      return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    // Hit-test the center: skip elements fully covered by others
    const cx = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const cy = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const hit = deepElementFromPoint(cx, cy);
    if (hit && !composedContains(el, hit) && !composedContains(hit, el)) return false;
    return true;
  };

  const getLabel = (el: HTMLElement): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (text) return text.slice(0, 120);
    return el.getAttribute('title') || el.getAttribute('alt') || '';
  };

  const visible = candidates.filter(isVisible);
  // Keep the INNERMOST interactive elements: drop anything that contains
  // another visible candidate. Sites put tabindex/roles on huge layout
  // containers (GitHub's content div has tabindex="0") — preferring ancestors
  // would swallow the whole page into one entry. Events bubble, so clicking
  // the innermost target still triggers wrapper handlers.
  const elements = visible.filter(el => !visible.some(other => other !== el && composedContains(el, other)));

  // Registry keeps rects too: SPA pages (GitHub etc.) re-render between
  // perceive and act, so stale refs fall back to a position-based click
  win.__lbu = {
    elements,
    rects: elements.map(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  };

  const state: ExtractedPageState = {
    url: window.location.href,
    title: document.title,
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      pageHeight: Math.round(document.documentElement.scrollHeight),
      viewportHeight: Math.round(window.innerHeight),
    },
    elements: elements.map((el, index) => {
      const rect = el.getBoundingClientRect();
      return {
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || (el as HTMLInputElement).type || '',
        text: getLabel(el),
        // Rich contenteditable composers carry their placeholder in
        // aria-placeholder (WhatsApp) or data-placeholder (Quill, Draft.js) —
        // without these the composer digests as an anonymous <div:textbox>
        // that no target description can match (live WhatsApp failure
        // 2026-07-18: "Type a message" unmatchable, 8 wasted steps)
        placeholder:
          el.getAttribute('placeholder') ||
          el.getAttribute('aria-placeholder') ||
          el.getAttribute('data-placeholder') ||
          '',
        value: (el as HTMLInputElement).value || '',
        href: (el as HTMLAnchorElement).href || '',
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    }),
  };

  if (showHighlights) {
    const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];
    const container = document.createElement('div');
    container.id = '__lbu_highlights';
    container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    for (const item of state.elements) {
      const color = COLORS[item.index % COLORS.length];
      const box = document.createElement('div');
      box.style.cssText =
        `position:fixed;left:${item.rect.x}px;top:${item.rect.y}px;` +
        `width:${item.rect.width}px;height:${item.rect.height}px;` +
        `border:2px solid ${color};box-sizing:border-box;`;
      const label = document.createElement('span');
      label.textContent = String(item.index);
      label.style.cssText =
        `position:absolute;top:-16px;left:0;background:${color};color:#fff;` +
        'font:bold 11px/14px monospace;padding:0 3px;border-radius:2px;';
      box.appendChild(label);
      container.appendChild(box);
    }
    document.body.appendChild(container);
  }

  return state;
}

// Remove set-of-marks overlays
export function removeHighlights(): void {
  document.getElementById('__lbu_highlights')?.remove();
}

// Extract readable page text, viewport-first: text visible in the current
// viewport fills the budget before below/above-fold text, so under a tight
// char cap the planner reads what the screenshot shows. Interactive-element
// labels alone miss most page content (prices, table cells, article text) —
// this is the non-interactive complement to set-of-marks.
export function extractPageText(maxChars: number): string {
  const vh = window.innerHeight;

  // Preserve content-block boundaries as line breaks: posts/cards/rows are
  // delimited by STANDARD semantics (article, listitem, tr, ...), so authors
  // and their content stay together on one line and adjacent posts don't
  // bleed into each other (misattribution root cause). Generic by design —
  // no site-specific selectors.
  // Card-level containers first (a post's author + content must land on ONE
  // line even when they sit in different paragraphs inside the card); only
  // pages without card semantics fall back to paragraph-level blocks.
  const CARD_SELECTOR = 'article, [role="article"], li, [role="listitem"], tr';
  const FINE_SELECTOR = 'blockquote, section, h1, h2, h3, h4, h5, h6, p';
  interface Bucket {
    lines: string[];
    current: string[];
    lastBlock: Element | null;
  }
  const makeBucket = (): Bucket => ({ lines: [], current: [], lastBlock: null });
  const flush = (bucket: Bucket) => {
    if (bucket.current.length) {
      bucket.lines.push(bucket.current.join(' '));
      bucket.current = [];
    }
  };
  const push = (bucket: Bucket, text: string, block: Element | null) => {
    if (block !== bucket.lastBlock) {
      flush(bucket);
      bucket.lastBlock = block;
    }
    bucket.current.push(text);
  };
  const inView = makeBucket();
  const offView = makeBucket();

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME']);

  const visit = (root: Node): void => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (node instanceof Element) {
          if (SKIP_TAGS.has(node.tagName.toUpperCase()) || node.id === '__lbu_highlights')
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP; // descend, but elements themselves yield nothing
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    // Recurse into open shadow roots (walker does not descend into them)
    const shadowHosts = (
      root instanceof Element || root instanceof Document || root instanceof ShadowRoot
        ? Array.from((root as Element).querySelectorAll?.('*') ?? [])
        : []
    ).filter(el => (el as Element).shadowRoot) as Element[];

    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const block = el.closest(CARD_SELECTOR) ?? el.closest(FINE_SELECTOR);
      push(rect.bottom >= 0 && rect.top <= vh ? inView : offView, text, block);
    }
    for (const host of shadowHosts) visit(host.shadowRoot as ShadowRoot);
  };
  visit(document.body);
  flush(inView);
  flush(offView);

  const visible = inView.lines.join('\n');
  if (visible.length >= maxChars) return visible.slice(0, maxChars) + '…';
  const rest = offView.lines.join('\n');
  if (!rest) return visible;
  const remaining = maxChars - visible.length;
  return `${visible}\n[off-screen] ${rest.slice(0, remaining)}${rest.length > remaining ? '…' : ''}`;
}

// Click the element registered at the given index by the last extraction.
// If the ref went stale (SPA re-rendered between perceive and act), recover
// by hit-testing the element's remembered position.
export function clickElementByIndex(index: number): { ok: boolean; error?: string; recovered?: boolean } {
  const win = window as any;
  let el: HTMLElement | undefined = win.__lbu?.elements?.[index];
  let recovered = false;

  if (!el || !el.isConnected) {
    const rect = win.__lbu?.rects?.[index];
    if (!rect) return { ok: false, error: `No element at index ${index} — the page changed, using the new PAGE list` };
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    let hit = document.elementFromPoint(cx, cy);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit) {
      return { ok: false, error: `Element at index ${index} disappeared — the page changed, using the new PAGE list` };
    }
    const INTERACTIVE =
      'a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], ' +
      '[role="menuitem"], [role="option"], [role="checkbox"], [onclick], [contenteditable="true"]';
    let node: Node | null = hit;
    let match: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.matches(INTERACTIVE)) {
        match = node;
        break;
      }
      node = node.parentNode ?? (node.getRootNode() as ShadowRoot | Document as ShadowRoot).host ?? null;
      if (node instanceof ShadowRoot) node = node.host;
    }
    el = match ?? (hit as HTMLElement);
    recovered = true;
  }

  // Clicking a disabled control is a silent no-op — report it as a failure
  // so the planner reacts instead of assuming success
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') {
    return { ok: false, error: `Element at index ${index} is disabled — its precondition is not met yet` };
  }

  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // Dispatch at the DEEPEST node under the element's center, like a real
  // click — apps with delegated handlers key off the deep target, and events
  // dispatched at a wrapper never reach a listener registered on its child.
  // (WhatsApp chat rows silently ignored ancestor-dispatched clicks — live
  // runs 2026-07-18.) Only trust the hit if it is inside the element;
  // otherwise something overlays it and the registered element stays target.
  let deep = document.elementFromPoint(cx, cy);
  while (deep?.shadowRoot) {
    const inner = deep.shadowRoot.elementFromPoint(cx, cy);
    if (!inner || inner === deep) break;
    deep = inner;
  }
  const target: HTMLElement = deep instanceof HTMLElement && el.contains(deep) ? deep : el;

  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, detail: 1 };
  const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
  target.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...pointer, button: 0, buttons: 1 }));
  target.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }));
  // Untrusted mousedown does not focus — do what the real one would
  el.focus?.({ preventScroll: true });
  target.dispatchEvent(new PointerEvent('pointerup', { ...base, ...pointer, button: 0, buttons: 0 }));
  target.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }));
  // ONE click, dispatched at the deep target so it bubbles through every
  // handler on the path; activation behavior (links, buttons) still runs on
  // the nearest activatable ancestor. Never ALSO call el.click() — a second
  // click event double-toggles checkboxes and menus.
  target.dispatchEvent(new MouseEvent('click', { ...base, button: 0, buttons: 0 }));
  return { ok: true, recovered };
}

// Type text into the element registered at the given index
export async function typeIntoElement(index: number, text: string): Promise<{ ok: boolean; error?: string }> {
  const win = window as any;
  const el: HTMLElement | undefined = win.__lbu?.elements?.[index];
  if (!el || !el.isConnected)
    return { ok: false, error: `No element at index ${index} — the page changed, using the new PAGE list` };
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Use the native setter so frameworks (React etc.) observe the change
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  if (el.isContentEditable) {
    // Rich-text editors (LinkedIn, Quill, ProseMirror, WhatsApp's Lexical)
    // ignore textContent writes — they need real editing commands that fire
    // beforeinput/input. Selecting the contents first makes insertText a
    // REPLACE, which is this action's contract.
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const inserted = document.execCommand('insertText', false, text);
    // Safety net for editors that silently ignore execCommand — but ONLY
    // after letting the editor re-render. Frameworks like Lexical apply the
    // insert asynchronously, so an immediate textContent read shows '' even
    // when the insert landed; the old synchronous check then inserted a
    // second copy (live WhatsApp failure 2026-07-18: "good morninggood
    // morning" from one type step).
    if (!inserted || (el.textContent ?? '').trim() === '') {
      await new Promise(resolve => setTimeout(resolve, 200));
      if ((el.textContent ?? '').trim() === '') {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
    return { ok: true };
  }

  return { ok: false, error: `Element at index ${index} is not editable (<${el.tagName.toLowerCase()}>)` };
}

// Clear whatever editable currently has keyboard focus — scoped to the
// FOCUSED element only (an input's value or a contenteditable's contents),
// never a page-level select-all, so a spreadsheet grid can never be caught
// by it. Used by the targeted-type vision fallback so `type` keeps its
// replace semantics even when the field is a rich composer.
export function clearFocusedEditable(): { cleared: boolean } {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return { cleared: false };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.value !== '') {
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { cleared: true };
  }
  if (el.isContentEditable) {
    if ((el.textContent ?? '').trim() !== '') {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('delete', false);
    }
    return { cleared: true };
  }
  return { cleared: false };
}

// Click at a point in viewport CSS coordinates (vision-grounded click).
// Shadow-DOM aware: descends through open shadow roots to the deepest hit
// node, climbs across shadow boundaries to the nearest interactive ancestor,
// and dispatches composed events. Reports what was actually clicked so bad
// grounding is visible.
export function clickAtPoint(x: number, y: number): { ok: boolean; error?: string; hit?: string } {
  // Descend to the deepest node under the point
  let hitNode = document.elementFromPoint(x, y);
  while (hitNode?.shadowRoot) {
    const inner = hitNode.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hitNode) break;
    hitNode = inner;
  }
  if (!hitNode) return { ok: false, error: `Nothing at (${x}, ${y})` };

  const INTERACTIVE =
    'a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], ' +
    '[role="menuitem"], [role="option"], [role="checkbox"], [onclick], [contenteditable="true"]';

  // Climb to an interactive ancestor, crossing shadow boundaries via host
  let el: HTMLElement = hitNode as HTMLElement;
  let node: Node | null = hitNode;
  while (node) {
    if (node instanceof HTMLElement && node.matches(INTERACTIVE)) {
      el = node;
      break;
    }
    node = node.parentNode ?? (node.getRootNode() as ShadowRoot | Document as ShadowRoot).host ?? null;
    if (node instanceof ShadowRoot) node = node.host;
  }

  // Dispatch at the DEEPEST hit node, like a real click — apps with
  // delegated handlers key off the deep target, and events dispatched at the
  // interactive ancestor never reach a listener on its child (WhatsApp chat
  // rows silently ignored ancestor-dispatched clicks — live runs 2026-07-18).
  // `el` (the interactive ancestor) is still what gets focused and reported.
  const target = hitNode instanceof HTMLElement ? hitNode : el;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, detail: 1 };
  const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
  target.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...pointer, button: 0, buttons: 1 }));
  target.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }));
  // Untrusted mousedown does not focus — do what the real one would
  el.focus?.({ preventScroll: true });
  target.dispatchEvent(new PointerEvent('pointerup', { ...base, ...pointer, button: 0, buttons: 0 }));
  target.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }));
  // ONE click at the deep target (activation still runs on the nearest
  // activatable ancestor); never also el.click() — two click events
  // double-toggle checkboxes and menus.
  target.dispatchEvent(new MouseEvent('click', { ...base, button: 0, buttons: 0 }));
  const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  return { ok: true, hit: `<${el.tagName.toLowerCase()}> ${label}`.trim() };
}

// Press a keyboard key (optionally with modifiers, e.g. "Enter", "Escape",
// "Ctrl+A") on the currently focused element. SPAs (X, LinkedIn) handle
// keydown themselves; for plain HTML forms an unhandled Enter falls back to
// native form submission.
export function pressKey(combo: string): { ok: boolean; error?: string; target?: string } {
  const parts = combo
    .split('+')
    .map(s => s.trim())
    .filter(Boolean);
  const rawKey = parts.pop() ?? '';
  if (!rawKey) return { ok: false, error: 'key requires a key name, e.g. "Enter"' };
  const mods = new Set(parts.map(p => p.toLowerCase()));

  const NAMED: Record<string, string> = {
    enter: 'Enter',
    return: 'Enter',
    escape: 'Escape',
    esc: 'Escape',
    tab: 'Tab',
    space: ' ',
    backspace: 'Backspace',
    delete: 'Delete',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    home: 'Home',
    end: 'End',
  };
  const key = NAMED[rawKey.toLowerCase()] ?? rawKey;
  const code =
    key === ' ' ? 'Space' : key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`) : key;

  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const init: KeyboardEventInit = {
    key,
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: mods.has('ctrl') || mods.has('control'),
    metaKey: mods.has('cmd') || mods.has('meta'),
    altKey: mods.has('alt') || mods.has('option'),
    shiftKey: mods.has('shift'),
  };
  const unprevented = target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));

  // Synthetic events never trigger native form submission — do it explicitly
  // when the page did not handle the keydown itself
  if (key === 'Enter' && unprevented) {
    const form = (target as HTMLInputElement).form;
    if (form) {
      try {
        form.requestSubmit();
      } catch {
        form.submit();
      }
    }
  }
  const label = (target.getAttribute?.('aria-label') || target.tagName || 'page').toString().slice(0, 40);
  return { ok: true, target: label };
}

// Report viewport CSS size (for scaling grounder image coordinates)
export function getViewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

// Scroll the page by roughly one viewport.
// amount is number|null (never undefined — executeScript args must serialize).
export function scrollPage(direction: 'up' | 'down', amount: number | null): { ok: boolean } {
  const dy = (amount ?? Math.round(window.innerHeight * 0.75)) * (direction === 'down' ? 1 : -1);
  window.scrollBy({ top: dy, behavior: 'instant' as ScrollBehavior });
  return { ok: true };
}
