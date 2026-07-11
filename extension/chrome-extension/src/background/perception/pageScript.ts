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
        placeholder: el.getAttribute('placeholder') || '',
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
      node = node.parentNode ?? ((node.getRootNode() as ShadowRoot | Document) as ShadowRoot).host ?? null;
      if (node instanceof ShadowRoot) node = node.host;
    }
    el = match ?? (hit as HTMLElement);
    recovered = true;
  }

  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: cx,
        clientY: cy,
      }),
    );
  }
  el.click();
  return { ok: true, recovered };
}

// Type text into the element registered at the given index
export function typeIntoElement(index: number, text: string): { ok: boolean; error?: string } {
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
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  }

  return { ok: false, error: `Element at index ${index} is not editable (<${el.tagName.toLowerCase()}>)` };
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
    node = node.parentNode ?? ((node.getRootNode() as ShadowRoot | Document) as ShadowRoot).host ?? null;
    if (node instanceof ShadowRoot) node = node.host;
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
    );
  }
  el.click?.();
  const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  return { ok: true, hit: `<${el.tagName.toLowerCase()}> ${label}`.trim() };
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
