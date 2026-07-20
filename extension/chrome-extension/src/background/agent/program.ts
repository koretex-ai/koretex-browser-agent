import type { PerceptionSnapshot } from '@extension/storage';
import { trajectoryStore } from '@extension/storage';
import { createLogger } from '../log';
import { capturePageState, capturePageText, runInPage } from '../perception';
import { clearFocusedEditable } from '../perception/pageScript';
import { executeAction } from '../actions/executor';
import { extractFromPage, LOCAL_ENDPOINT } from './planner';
import type { PlannerEndpoint } from './planner';
import type { CallUsage } from './orchestrator';
import { scrubPii, rehydratePii } from './pii';
import { groundTarget, verifyVisual } from './grounder';
import type { ProgramStep } from './orchestrator';

const logger = createLogger('program');

/**
 * Deterministic step engine — the "harness as runtime" half of the
 * architecture. The cloud planner emits typed steps; this module executes
 * them exactly as written, with NO model in between. Local models are used
 * only as senses:
 *  - resolveTarget: description -> element index (deterministic label match)
 *  - Holo grounding: vision fallback when the DOM match fails (clicks only)
 *  - extractFromPage: reading data out of the page text
 *  - verifyVisual: answering questions from a screenshot
 */

const HARVEST_DEFAULT_MAX_SCROLLS = 6;
const HARVEST_NO_CHANGE_LIMIT = 2;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface StepRunnerContext {
  /** Groups this run's trajectory step logs (the plan id) */
  runId: string;
  /** Receives every extract result, for the journal and collection store */
  onExtract?: (query: string, answer: string) => void;
  /** Live view of already-collected data, so extracts report only NEW items */
  knownData?: () => string[];
  /**
   * Live view of the task's FULL collection store (untruncated items). Steps
   * with textFrom:"collected" expand to these at execution time — collected
   * data reaches the page verbatim without a cloud round-trip.
   */
  collectedItems?: () => string[];
  /**
   * Where extract/harvest reading runs. Default local (Ollama). Cloud-only
   * mode passes a cloud endpoint — page text then leaves the machine, so it
   * is scrubbed by the PII guard first when scrubForCloud is set.
   */
  readerEndpoint?: PlannerEndpoint;
  /** Pseudonymize page text before a CLOUD reader call (PII guard active) */
  scrubForCloud?: boolean;
  /** Cost attribution for cloud reader calls */
  onUsage?: (usage: CallUsage) => void;
  /**
   * Live current tab for multi-tab runs (tab-per-site) — every action and
   * perception targets this. Default: the tab the runner was created with.
   */
  resolveTab?: () => number;
  /**
   * Multi-tab navigate delegate: the conductor decides whether a navigate
   * means "open a new tab", "switch to the site's existing tab", or "load in
   * place". When absent, navigate loads in the current tab as always.
   */
  navigateTab?: (url: string) => Promise<{ ok: boolean; message: string }>;
}

export interface StepRunner {
  execStep: (step: ProgramStep) => Promise<{ ok: boolean; message: string }>;
  perceive: () => Promise<PerceptionSnapshot | null>;
  getState: () => PerceptionSnapshot | null;
}

function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"''""`]/g, '')
    .replace(/[!?,;:()[\]{}<>|~^*+=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TargetMatch {
  /** Best-matching element index, or null when nothing clears the threshold */
  index: number | null;
  /**
   * Two different elements matched almost equally well — the DOM label cannot
   * tell them apart (e.g. a nav "Post" and a composer's submit "Post"). The
   * caller should defer to vision rather than silently pick one.
   */
  ambiguous: boolean;
}

/**
 * Resolve a target description ("the 'Start a post' button") to an element
 * index by label matching, and report whether the match was AMBIGUOUS.
 * Deterministic, no model call.
 *
 * Escalate-on-uncertainty: a confident single match is used directly; no
 * match returns null (caller uses vision); a near-tie between distinct
 * elements returns ambiguous=true so the caller ALSO uses vision — a
 * deterministic sense must not guess when it cannot distinguish candidates.
 */
export function resolveTargetDetail(state: PerceptionSnapshot, target: string): TargetMatch {
  const wanted = normalizeLabel(target);
  if (!wanted) return { index: null, ambiguous: false };
  const wantedTokens = new Set(wanted.split(' '));

  let bestIndex: number | null = null;
  let bestScore = 0;
  let secondScore = 0;
  for (const el of state.elements) {
    const label = normalizeLabel(el.text || el.placeholder || el.value || '');
    if (!label) continue;
    let score = 0;
    if (label === wanted) {
      score = 1;
    } else if (label.includes(wanted)) {
      // The WHOLE wanted phrase appears inside the label. For a multi-word
      // phrase that is near-certain — labels routinely append context the
      // description omits ("Type a message" vs "Type a message to group
      // Koretex < … >"), and the raw length ratio sank exactly that match
      // below the cutoff (live WhatsApp failure 2026-07-18, element [49]).
      // Single tokens keep the ratio: "search" inside a long label is weak.
      const ratio = (0.9 * wanted.length) / label.length;
      score = wantedTokens.size >= 2 ? Math.max(ratio, 0.85) : ratio;
    } else if (wanted.includes(label)) {
      // The label is a fragment of the description — weaker: score by how
      // much of the description the label accounts for
      score = (0.9 * label.length) / wanted.length;
    } else {
      const labelTokens = new Set(label.split(' '));
      let common = 0;
      for (const token of wantedTokens) if (labelTokens.has(token)) common++;
      score = (0.8 * common) / Math.max(wantedTokens.size, labelTokens.size);
    }
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestIndex = el.index;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (bestScore < 0.45) return { index: null, ambiguous: false };
  // A strong second match within a hair of the best = indistinguishable by label
  const ambiguous = bestScore >= 0.85 && secondScore >= bestScore - 0.08;
  return { index: bestIndex, ambiguous };
}

/** Index-only convenience (existence checks); ignores ambiguity. */
export function resolveTarget(state: PerceptionSnapshot, target: string): number | null {
  return resolveTargetDetail(state, target).index;
}

export function describeStep(step: ProgramStep): string {
  switch (step.do) {
    case 'navigate':
      return `navigate to ${step.url}`;
    case 'click':
      return `click "${step.target}"`;
    case 'type':
      return step.textFrom === 'collected'
        ? `type the collected data into "${step.target}"`
        : `type "${step.text}" into "${step.target}"`;
    case 'type_focused':
      return step.textFrom === 'collected'
        ? 'type the collected data into the focused editor'
        : `type ${String(step.text ?? '').split('\n').length} line(s) into the focused editor`;
    case 'key':
      return `press ${step.combo}`;
    case 'scroll':
      return `scroll ${step.direction ?? 'down'}${step.times && step.times > 1 ? ` x${step.times}` : ''}`;
    case 'extract':
      return `extract "${step.query}"`;
    case 'harvest':
      return `harvest "${step.query}" until ${step.until ?? 10} items`;
    case 'collect':
      return `record ${step.items?.length ?? 0} item(s) read from the screenshot`;
    case 'verify_visual':
      return `verify visually: "${step.question}"`;
    case 'wait':
      return `wait ${step.ms ?? 1000}ms`;
    case 'wait_for':
      return `wait for "${step.target}" to appear`;
    default:
      return JSON.stringify(step).slice(0, 80);
  }
}

export function listLines(answer: string): string[] {
  return answer.split('\n').filter(line => /^\s*(?:[-*•]|\d+[.)])/.test(line));
}

// Rough count of collected items in an extract answer (list lines)
function countItems(answer: string): number {
  return listLines(answer).length || 1;
}

// Normalize a harvested line to a dedup key: bullets/numbering, digits
// (engagement counts, list positions) and whitespace/case must not
// distinguish two sightings of the same item
export function itemKey(line: string): string {
  return line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .toLowerCase()
    .replace(/[0-9]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// The local reader emits the literal token "<TAB>" (or an escaped "\t") when
// told to tab-separate — convert those to a real tab character so spreadsheet
// pastes land in columns instead of showing the placeholder text verbatim
export function normalizeTabs(text: string): string {
  return text.replace(/<TAB>/gi, '\t').replace(/\\t/g, '\t');
}

function pageSignature(state: PerceptionSnapshot | null): string {
  if (!state) return 'no-state';
  return `${state.url}|${state.scroll.y}|${(state.pageText ?? '').slice(0, 300)}`;
}

/**
 * Create the step engine for one plan run. Steps execute exactly as written;
 * retries, verification, and reflection are the conductor's job.
 */
export function createStepRunner(
  initialTabId: number,
  taskId: string,
  ctx: StepRunnerContext,
  signal: AbortSignal,
): StepRunner {
  // Multi-tab runs move the working tab as sites open in their own tabs
  const tab = () => ctx.resolveTab?.() ?? initialTabId;
  let lastState: PerceptionSnapshot | null = null;
  const history: string[] = [];

  // Why the last perceive() returned null — surfaced verbatim in step-failure
  // messages so the reflector (and the transcript) sees the actual cause
  // ("reading the page timed out after 12s") instead of a generic shrug
  let lastPerceiveError = '';
  const perceive = async (): Promise<PerceptionSnapshot | null> => {
    const state = await capturePageState(tab(), false).catch(async () => {
      await sleep(1500);
      return capturePageState(tab(), false).catch(error => {
        lastPerceiveError = error instanceof Error ? error.message : String(error);
        return null;
      });
    });
    lastState = state ?? lastState;
    if (state) lastPerceiveError = '';
    return state;
  };
  const readFailure = (what: string) =>
    `could not read the page to locate the ${what}${lastPerceiveError ? ` (${lastPerceiveError})` : ''}`;

  const logContextFor = (step: ProgramStep) => ({
    subtaskId: ctx.runId,
    decision: step,
    plannerModel: 'program',
    plannerTier: 0,
    historyContext: history.slice(-8),
  });

  // Run one extract (ledger- and dedup-aware); returns new-item count.
  // With `seen` (harvest mode) the HARNESS deduplicates: the local reader
  // re-reports items that stay in view across scrolls, so only never-seen
  // lines count toward the target — and only they reach the journal.
  const runExtract = async (query: string, seen?: Set<string>): Promise<{ newItems: number; note: string }> => {
    let pageText = await capturePageText(tab()).catch(() => lastState?.pageText ?? '');
    const endpoint = ctx.readerEndpoint ?? LOCAL_ENDPOINT;
    // Cloud reading sends the FULL page text off-machine — pseudonymize
    // detectable identifiers first when the PII guard is on
    if (endpoint.kind === 'cloud' && ctx.scrubForCloud) pageText = scrubPii(pageText);
    let answer: string;
    try {
      const result = await extractFromPage(query, pageText, signal, endpoint, ctx.knownData?.() ?? []);
      answer = result.answer;
      if (result.usage) ctx.onUsage?.(result.usage);
    } catch (error) {
      if (signal.aborted) throw error;
      // A reader call misfiring is a STEP failure the navigator judges and
      // routes around — never run death (a raw JSON parse error once killed
      // an otherwise healthy run at this exact spot)
      const message = error instanceof Error ? error.message : String(error);
      logger.warning('reader call failed:', message);
      return { newItems: 0, note: `READER ERROR: ${message.slice(0, 160)}` };
    }
    if (/^NOTHING NEW/i.test(answer)) return { newItems: 0, note: 'nothing new' };
    if (answer.startsWith('NOT FOUND')) return { newItems: 0, note: answer.slice(0, 120) };
    let reported = answer;
    let newItems = countItems(answer);
    if (seen) {
      const lines = listLines(answer);
      if (lines.length > 0) {
        const fresh = lines.filter(line => {
          const key = itemKey(line);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (fresh.length === 0) return { newItems: 0, note: 'no new items (all already collected)' };
        reported = fresh.join('\n');
        newItems = fresh.length;
      } else {
        // Prose answer: treat the whole thing as one item
        const key = itemKey(answer);
        if (seen.has(key)) return { newItems: 0, note: 'no new items (same as before)' };
        seen.add(key);
        newItems = 1;
      }
    }
    ctx.onExtract?.(query, reported);
    if (lastState) {
      trajectoryStore
        .appendStep({
          sessionId: taskId,
          before: lastState,
          action: { type: 'extract', query },
          ok: true,
          timestamp: Date.now(),
          ...logContextFor({ do: 'extract', query }),
        })
        .catch(error => logger.warning('trajectory logging failed:', error));
    }
    return { newItems, note: reported.slice(0, 160) };
  };

  // A step's text, with textFrom:"collected" expanded from the task's local
  // collection store — the full untruncated items, joined below any literal
  // text (which serves as a header line)
  const resolveStepText = (step: ProgramStep): string | undefined => {
    // rehydratePii: vault tokens (⟨email-1⟩…) become their real values at the
    // moment of TYPING — the substitution happens locally, so the cloud only
    // ever saw the token. No-op when the vault is empty.
    if (step.textFrom === 'collected') {
      const items = ctx.collectedItems?.() ?? [];
      if (items.length === 0) return undefined;
      return rehydratePii(normalizeTabs([step.text, ...items].filter(Boolean).join('\n')));
    }
    return step.text === undefined ? undefined : rehydratePii(normalizeTabs(step.text));
  };

  const execStep = async (step: ProgramStep): Promise<{ ok: boolean; message: string }> => {
    const result = await execStepInner(step);
    history.push(`${describeStep(step)} -> ${result.ok ? result.message || 'ok' : `FAILED: ${result.message}`}`);
    return result;
  };

  const execStepInner = async (step: ProgramStep): Promise<{ ok: boolean; message: string }> => {
    switch (step.do) {
      case 'navigate':
        if (!step.url) return { ok: false, message: 'navigate step has no url' };
        // Multi-tab runs route navigation through the conductor's tab manager
        if (ctx.navigateTab) return ctx.navigateTab(step.url);
        return executeAction(tab(), taskId, { type: 'navigate', url: step.url }, lastState, logContextFor(step));
      case 'key':
        if (!step.combo) return { ok: false, message: 'key step has no combo' };
        return executeAction(tab(), taskId, { type: 'key', combo: step.combo }, lastState, logContextFor(step));
      case 'type_focused': {
        const text = resolveStepText(step);
        if (!text) {
          return {
            ok: false,
            message:
              step.textFrom === 'collected'
                ? 'textFrom:"collected" but the collection store is empty — nothing has been harvested/extracted yet'
                : 'type_focused step has no text',
          };
        }
        return executeAction(tab(), taskId, { type: 'type_focused', text }, lastState, logContextFor(step));
      }
      case 'wait':
        await sleep(Math.min(step.ms ?? 1000, 10000));
        return { ok: true, message: `waited ${step.ms ?? 1000}ms` };
      case 'wait_for': {
        // Readiness condition instead of a blind delay: poll until the target
        // text appears in the page text or matches an element label
        if (!step.target) return { ok: false, message: 'wait_for step has no target text' };
        const timeout = Math.min(step.ms ?? 10000, 20000);
        const deadline = Date.now() + timeout;
        const wanted = step.target.toLowerCase();
        for (;;) {
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');
          const state = await perceive();
          if (state) {
            const inText = (state.pageText ?? '').toLowerCase().includes(wanted);
            if (inText || resolveTarget(state, step.target) !== null) {
              return { ok: true, message: `"${step.target}" appeared` };
            }
          }
          if (Date.now() >= deadline) {
            return { ok: false, message: `"${step.target}" did not appear within ${timeout}ms` };
          }
          await sleep(800);
        }
      }
      case 'scroll': {
        const times = Math.min(step.times ?? 1, 10);
        for (let i = 0; i < times; i++) {
          await executeAction(
            tab(),
            taskId,
            { type: 'scroll', direction: step.direction ?? 'down' },
            lastState,
            logContextFor(step),
          );
        }
        return { ok: true, message: `scrolled ${step.direction ?? 'down'} x${times}` };
      }
      case 'click': {
        if (!step.target) return { ok: false, message: 'click step has no target' };
        const state = await perceive();
        if (!state) return { ok: false, message: readFailure('target') };
        const match = resolveTargetDetail(state, step.target);
        // Use the DOM match only when it is confident AND unambiguous. A near-
        // tie between distinct elements (two "Post" buttons) goes to vision,
        // which sees the screenshot and can pick the right one.
        if (match.index !== null && !match.ambiguous) {
          return executeAction(tab(), taskId, { type: 'click', index: match.index }, state, logContextFor(step));
        }
        try {
          const point = await groundTarget(tab(), step.target, signal);
          return executeAction(
            tab(),
            taskId,
            { type: 'click_at', x: point.x, y: point.y, target: point.target },
            state,
            logContextFor(step),
          );
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const why = match.ambiguous
            ? `"${step.target}" matched several elements`
            : `no element matching "${step.target}"`;
          return { ok: false, message: `${why} (vision fallback: ${message})` };
        }
      }
      case 'type': {
        const text = resolveStepText(step);
        if (!step.target || !text) return { ok: false, message: 'type step needs target and text' };
        const state = await perceive();
        if (!state) return { ok: false, message: readFailure('input') };
        const match = resolveTargetDetail(state, step.target);
        if (match.index !== null && !match.ambiguous) {
          return executeAction(tab(), taskId, { type: 'type', index: match.index, text }, state, logContextFor(step));
        }
        // Vision fallback — the same ladder click has. Rich/contenteditable
        // composers often expose no matchable label: ground the field on the
        // screenshot, click to focus it, then type as trusted keyboard input.
        try {
          const point = await groundTarget(tab(), step.target, signal);
          const focus = await executeAction(
            tab(),
            taskId,
            { type: 'click_at', x: point.x, y: point.y, target: point.target },
            state,
            logContextFor(step),
          );
          if (!focus.ok) return { ok: false, message: `could not focus "${step.target}": ${focus.message}` };
          await sleep(400);
          // `type` promises REPLACE semantics, but type_focused is insert-only
          // (the Sheets select-all trap). Clear the now-focused field first —
          // scoped to the focused editable itself, so a grid can never be hit.
          // Without this, a retry into a rich composer APPENDS (live WhatsApp
          // failure 2026-07-18: "good morning" snowballed to 8 copies).
          await runInPage(tab(), clearFocusedEditable).catch(() => {});
          return executeAction(tab(), taskId, { type: 'type_focused', text }, lastState, logContextFor(step));
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, message: `no input element matching "${step.target}" (vision fallback: ${message})` };
        }
      }
      case 'extract': {
        if (!step.query) return { ok: false, message: 'extract step has no query' };
        const { newItems, note } = await runExtract(step.query);
        if (note.startsWith('READER ERROR')) return { ok: false, message: note };
        // Zero-yield parity with harvest: a read that found NOTHING while the
        // task collection is still empty is a step failure the reflector must
        // see NOW — not a silent ✓ that surfaces as an empty deliverable ten
        // steps later. A dry read on top of an existing collection stays ok
        // (the tail of a scroll+extract sequence legitimately runs dry), and a
        // prose answer (a fact, not list items) counts as content.
        const foundNothing = newItems === 0 && (/^(NOT FOUND|nothing new|no new items)/i.test(note) || !note.trim());
        if (foundNothing && (ctx.collectedItems?.() ?? []).length === 0) {
          return {
            ok: false,
            message: `extract collected 0 items — the content may not have rendered yet or the query matched nothing on this page (reader said: ${note || 'empty answer'})`,
          };
        }
        return { ok: true, message: note };
      }
      case 'verify_visual': {
        if (!step.question) return { ok: false, message: 'verify_visual step has no question' };
        // Local VLM reads the screenshot; only the verdict leaves the machine
        const answer = await verifyVisual(tab(), step.question, signal);
        return { ok: true, message: answer.slice(0, 200) };
      }
      case 'harvest': {
        if (!step.query) return { ok: false, message: 'harvest step has no query' };
        const target = step.until ?? 10;
        const maxScrolls = Math.min(step.maxScrolls ?? HARVEST_DEFAULT_MAX_SCROLLS, 12);
        // Harness-side dedup across rounds: feed pages keep the same items in
        // view while scrolling, so re-sightings must not count toward `until`
        const seen = new Set<string>();
        let total = 0;
        let noChange = 0;
        let lastSig = '';
        for (let round = 0; round <= maxScrolls; round++) {
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');
          const { newItems } = await runExtract(step.query, seen);
          total += newItems;
          if (total >= target) return { ok: true, message: `collected ${total} unique items` };
          await executeAction(tab(), taskId, { type: 'scroll', direction: 'down' }, lastState, logContextFor(step));
          const state = await perceive();
          const sig = pageSignature(state);
          // A round is dry when the page did not change OR it yielded nothing
          // new (the reader can saturate while the page keeps loading)
          if (sig === lastSig || newItems === 0) {
            noChange++;
            if (noChange >= HARVEST_NO_CHANGE_LIMIT) break;
          } else {
            noChange = 0;
          }
          lastSig = sig;
        }
        // Zero yield is a FAILURE, not a completed collection — the reflector
        // gets to decide whether the page or the query was the problem
        if (total === 0) {
          return {
            ok: false,
            message:
              'harvest collected 0 items — the results may not have rendered yet or the query matched nothing on this page',
          };
        }
        return { ok: true, message: `collected ${total} unique items (results stopped yielding new ones)` };
      }
      default:
        return { ok: false, message: `unknown step "${String(step.do)}"` };
    }
  };

  return { execStep, perceive, getState: () => lastState };
}
