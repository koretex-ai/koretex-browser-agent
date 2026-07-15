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

// A full perception read can take up to ~12s on a heavy/loading page; the
// verify window must exceed that so at least one attempt completes before we
// call it. URL checks do not wait on perception (see below), so navigation
// still verifies in well under a second.
const DEFAULT_VERIFY_TIMEOUT_MS = 12000;
const POLL_INTERVAL_MS = 800;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface VerifyResult {
  pass: boolean;
  /** What the page/verifier actually shows — precise on failure */
  observation: string;
  /**
   * Perception could not READ the page to judge the content checks, so this
   * is not a definitive failure — the step may well have worked. The conductor
   * must not treat it as proof the step failed.
   */
  inconclusive?: boolean;
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Short human-readable form of an expect, for step narration and the journal */
export function describeExpect(expect: StepExpect): string {
  const parts: string[] = [];
  if (expect.url) parts.push(`url~"${expect.url}"`);
  if (expect.text) parts.push(`text "${expect.text.slice(0, 60)}"`);
  if (expect.element) parts.push(`element "${expect.element.slice(0, 40)}"`);
  if (expect.gone) parts.push(`gone "${expect.gone.slice(0, 40)}"`);
  if (expect.see) parts.push(`see: "${expect.see.slice(0, 60)}"`);
  return parts.join(' & ') || '(no expect)';
}

export function hasExpectation(expect?: StepExpect): boolean {
  return Boolean(expect && (expect.url || expect.text || expect.element || expect.gone || expect.see));
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

// The substring cousin of {see:"yes"}: a SUBMIT/SEND/CREATE step whose only
// proof is text that an EARLIER step already typed onto the page. That text was
// present the moment it was typed — before the submit — so the check passes
// whether or not the action succeeded (the x.com "posted hello world" false
// positive). A transition field (url/element/see) that only success produces
// rescues it; text-alone against already-entered content does not.
export function weakSideEffectExpectReason(expect: StepExpect, priorTypedTexts: string[]): string | null {
  if (!expect.text) return null;
  // A url/element/gone/see field checks a transition — that makes the expect real
  if (expect.url || expect.element || expect.gone || expect.see) return null;
  const wanted = normalize(expect.text);
  if (!wanted) return null;
  for (const typed of priorTypedTexts) {
    const t = normalize(typed);
    if (t && (t.includes(wanted) || wanted.includes(t))) {
      return `the expect only checks that "${expect.text.slice(0, 40)}" is on the page, but a step earlier in THIS plan typed that same content — so it is already true before this click and cannot prove the action happened; verify the TRANSITION instead: add "gone" (the composer/dialog closed), an "element" that only appears on success (a confirmation), or a "see" question`;
    }
  }
  return null;
}

// Derive a screenshot question from a deterministic expect, for the vision
// escalation path. `gone` is deliberately excluded: blind senses make a gone
// check false-PASS (nothing found = "gone"), not false-fail, so it never
// reaches the escalation branch — and asking a small VLM to prove absence
// invites hallucinated confirmation.
function visionQuestionFor(expect: StepExpect): string | null {
  if (expect.text) {
    return `Does the page visibly show the text "${expect.text.slice(0, 80)}" anywhere, including as a placeholder or inside a dialog?`;
  }
  if (expect.element) {
    return `Is a control or element labeled "${expect.element.slice(0, 60)}" visible on the page?`;
  }
  return null;
}

// Check the perception-requiring fields (text/element/gone) against one
// snapshot; null = all hold. The url field is checked separately from the tab
// itself, without needing the content script.
function contentFailure(state: PerceptionSnapshot, expect: StepExpect): string | null {
  if (expect.text) {
    const wanted = normalize(expect.text);
    const inPageText = normalize(state.pageText ?? '').includes(wanted);
    // Element labels/placeholders are a second, independent sense — pageText
    // extraction can come back empty on heavy SPAs while the element digest is
    // fine (x.com: page text "", but the composer + its placeholder were in
    // the digest). A text expect holds if EITHER sense carries it.
    const inElements =
      inPageText || state.elements.some(el => normalize(`${el.text ?? ''} ${el.placeholder ?? ''}`).includes(wanted));
    if (!inPageText && !inElements) {
      return `neither the page text nor any element label contains "${expect.text}" — page is "${state.title}" at ${state.url}`;
    }
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
  if (expect.gone) {
    // The disappearance is proven only when NEITHER an element NOR the page
    // text still carries it
    const stillElement = resolveTarget(state, expect.gone) !== null;
    const stillText = normalize(state.pageText ?? '').includes(normalize(expect.gone));
    if (stillElement || stillText) {
      return `"${expect.gone}" is still present (expected it to be gone) — page is "${state.title}" at ${state.url}`;
    }
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

  const needsPerception = Boolean(expect.text || expect.element || expect.gone);
  const deadline = Date.now() + timeoutMs;
  let lastFailure = '';
  let lastReadError = '';
  let gotState = false;
  let lastState: PerceptionSnapshot | null = null;

  if (expect.url || needsPerception) {
    for (;;) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');

      // URL is on the TAB, not behind the content script — a heavy or still-
      // loading page has a real URL even when its body cannot be read yet. So
      // a navigate verifies without waiting on (or being blocked by) perception.
      let urlOk = true;
      if (expect.url) {
        const tabUrl = await chrome.tabs
          .get(tabId)
          .then(t => t.url ?? '')
          .catch(() => '');
        urlOk = tabUrl.toLowerCase().includes(expect.url.toLowerCase());
        if (!urlOk) lastFailure = `url is ${tabUrl || '(unknown)'} (expected it to contain "${expect.url}")`;
      }

      let contentOk = true;
      if (needsPerception) {
        const state = await capturePageState(tabId, false).catch(error => {
          lastReadError = error instanceof Error ? error.message : String(error);
          return null;
        });
        if (state) {
          gotState = true;
          lastState = state;
          const failure = contentFailure(state, expect);
          contentOk = failure === null;
          if (!contentOk) lastFailure = failure!;
        } else {
          contentOk = false; // could not read — may just be slow/loading
        }
      }

      if (urlOk && contentOk) break;
      if (Date.now() >= deadline) {
        // A wrong URL is a real, definitive failure. But if the page could
        // never be READ for the content checks, that is INCONCLUSIVE — the
        // step may have worked; do not report it as a proven failure.
        if (expect.url && !urlOk) return { pass: false, observation: lastFailure };

        // ---- VISION ESCALATION ----
        // House rule (same as ambiguous-click grounding): an uncertain local
        // sense escalates to a stronger sense — it never concludes from
        // blindness. If the deterministic senses were BLIND (no read at all,
        // or a text check against effectively-empty page text, or an element
        // check against an empty digest), ask the local VLM one screenshot
        // question derived from the expect before failing. Vision only breaks
        // ties where the alternative was certain failure, so even a mediocre
        // verdict strictly improves on the status quo. Genuine mismatches on
        // WORKING senses never escalate — a false vision YES must not
        // override a correct deterministic failure.
        const pageTextBlind = Boolean(expect.text) && (lastState?.pageText ?? '').trim().length < 40;
        const elementsBlind = Boolean(expect.element) && (lastState?.elements.length ?? 0) === 0;
        const blind = (needsPerception && !gotState) || pageTextBlind || elementsBlind;
        let visionNote = '';
        const question = blind ? visionQuestionFor(expect) : null;
        if (question) {
          const answer = await verifyVisual(tabId, question, signal).catch(error => {
            logger.warning('vision escalation failed:', error);
            return '';
          });
          if (/^\s*yes\b/i.test(answer.trim())) {
            return {
              pass: true,
              observation: `deterministic senses could not read this (${describeExpect(expect)}) — vision confirmed it: ${answer.slice(0, 140)}`,
            };
          }
          if (answer) visionNote = ` — vision was asked "${question}" and answered: ${answer.slice(0, 120)}`;
        }

        if (needsPerception && !gotState) {
          return {
            pass: false,
            inconclusive: true,
            observation: `could not read the page to verify (${describeExpect(expect)})${lastReadError ? ` — ${lastReadError}` : ''}${visionNote} — this is a perception/tooling problem, not proof the step failed; the action may have worked`,
          };
        }
        logger.info('verify fail:', lastFailure.slice(0, 160));
        return { pass: false, observation: (lastFailure || 'the expected postcondition was not met') + visionNote };
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
