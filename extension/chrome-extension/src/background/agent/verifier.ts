import type { PerceptionSnapshot } from '@extension/storage';
import { createLogger } from '../log';
import { capturePageState } from '../perception';
import { verifyVisual } from './grounder';
import { resolveTarget } from './program';
import type { StepExpect } from './orchestrator';

const logger = createLogger('verifier');

/**
 * Tiered verification of a StepExpect against the live page.
 *
 * Deterministic fields (url/text/element) are checked against fresh
 * perception snapshots and POLLED until they hold or the deadline passes —
 * verification doubles as the "wait for the page to settle" primitive, which
 * removes the blind-wait race class entirely. The `see` field goes to the
 * local vision verifier exactly once, only after the deterministic fields
 * hold (no point paying a slow VLM call on a page that is provably wrong).
 *
 * Conservative by design: uncertain = fail. A false "pass" poisons every
 * later step; a false "fail" costs one reflect call. Failures return a
 * precise OBSERVATION of what the page actually shows — that observation is
 * what lets the reflector distinguish a step fault from a plan fault.
 */

const DEFAULT_VERIFY_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 800;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface VerifyResult {
  pass: boolean;
  /** What the page/verifier actually shows — precise on failure */
  observation: string;
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Short human-readable form of an expect, for step narration and the journal */
export function describeExpect(expect: StepExpect): string {
  const parts: string[] = [];
  if (expect.url) parts.push(`url~"${expect.url}"`);
  if (expect.text) parts.push(`text "${expect.text.slice(0, 60)}"`);
  if (expect.element) parts.push(`element "${expect.element.slice(0, 40)}"`);
  if (expect.see) parts.push(`see: "${expect.see.slice(0, 60)}"`);
  return parts.join(' & ') || '(no expect)';
}

export function hasExpectation(expect?: StepExpect): boolean {
  return Boolean(expect && (expect.url || expect.text || expect.element || expect.see));
}

// Degenerate expects are the loophole a lazy planner finds: {"see":"yes"} asks
// the VLM the question "yes", gets "YES", and passes vacuously — verification
// theater. A real check has substance. Returns a reason string, or null when
// the expect is legitimate. Trivial deterministic fields (url/text/element)
// are permitted even if short — a 3-char URL fragment is still a real check;
// only the free-form `see` question can be meaningfully empty.
const DEGENERATE_SEE = new Set(['yes', 'no', 'ok', 'true', 'false', 'done', 'success', 'yes/no', 'visible']);
export function degenerateExpectReason(expect: StepExpect): string | null {
  if (expect.see !== undefined) {
    const q = expect.see
      .trim()
      .toLowerCase()
      .replace(/[?.!]+$/, '');
    if (q.length < 12 || DEGENERATE_SEE.has(q) || !/\s/.test(q)) {
      return `the "see" question "${expect.see}" is not a real yes/no question about the page`;
    }
  }
  if (!hasExpectation(expect)) return 'the expect is empty';
  return null;
}

// Check the deterministic fields against one snapshot; null = all hold
function deterministicFailure(state: PerceptionSnapshot, expect: StepExpect): string | null {
  if (expect.url && !state.url.toLowerCase().includes(expect.url.toLowerCase())) {
    return `url is ${state.url} (expected it to contain "${expect.url}")`;
  }
  if (expect.text && !normalize(state.pageText ?? '').includes(normalize(expect.text))) {
    return `the page text does not contain "${expect.text}" — page is "${state.title}" at ${state.url}`;
  }
  if (expect.element && resolveTarget(state, expect.element) === null) {
    const labels = state.elements
      .map(el => el.text || el.placeholder)
      .filter(Boolean)
      .slice(0, 12)
      .map(label => `"${label.slice(0, 40)}"`)
      .join(', ');
    return `no element matching "${expect.element}" — visible elements include: ${labels || '(none)'}`;
  }
  return null;
}

export async function verifyExpect(
  tabId: number,
  expect: StepExpect,
  signal: AbortSignal,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<VerifyResult> {
  if (!hasExpectation(expect)) return { pass: true, observation: 'no expect specified' };

  const hasDeterministic = Boolean(expect.url || expect.text || expect.element);
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'could not read the page';

  if (hasDeterministic) {
    for (;;) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const state = await capturePageState(tabId, false).catch(() => null);
      if (state) {
        const failure = deterministicFailure(state, expect);
        if (failure === null) break;
        lastFailure = failure;
      }
      if (Date.now() >= deadline) {
        logger.info('verify fail:', lastFailure.slice(0, 160));
        return { pass: false, observation: lastFailure };
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  if (expect.see) {
    // Single VLM call — conservative parse: an answer that does not clearly
    // start with YES is a failure, with the verifier's own words as the
    // observation
    const answer = await verifyVisual(tabId, expect.see, signal);
    if (/^\s*yes\b/i.test(answer)) {
      return { pass: true, observation: `visual check passed: ${answer.slice(0, 160)}` };
    }
    const uncertain = !/^\s*no\b/i.test(answer);
    return {
      pass: false,
      observation: `visual check ${uncertain ? 'was uncertain' : 'failed'}: ${answer.slice(0, 240)}`,
    };
  }

  return { pass: true, observation: 'expect met' };
}
