import type { PerceptionSnapshot, TaskRecord, RunStatus } from '@extension/storage';
import { Actors, trajectoryStore, runStateStore, skillStore, chatSettingsStore, chatHistoryStore } from '@extension/storage';
import { resetPiiVault, rehydratePii, scrubPii } from './pii';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';
import {
  capturePageState,
  capturePageText,
  captureViewportText,
  captureScreenshot,
  SWEEP_SCREENSHOT_OPTS,
} from '../perception';
import { extractFromPage, LOCAL_ENDPOINT } from './planner';
import type { PlannerEndpoint } from './planner';
import { streamCloudChatReply } from './chat';
import {
  nextStep,
  strategicReview,
  kickoffStrategy,
  reportOutcome,
  curateCollection,
  auditDone,
  collectFromScreenshot,
  collectFromText,
} from './orchestrator';
import { allSkills, applicableSkills, renderSkills, skillCatalog } from './skills';
import { loadAgentMemory, updateMemoryAfterRun } from './memory';
import { armDialogGuard, detachCdp } from '../actions/cdp';
import { rebindSessionTab } from '../taskWindow';
import { executeAction } from '../actions/executor';
import { stashSuccessfulRun } from '../recorder/teach';
import { createRunSync, type RunSyncHandle } from '../sync';
import type { ProgramStep, CallUsage } from './orchestrator';
import { createStepRunner, describeStep, listLines, itemKey } from './program';

const logger = createLogger('stepwise');

/**
 * STEPWISE conductor: judge-and-decide, one multimodal cloud call per step.
 *
 * Loop: [capture screenshot + digest] -> navigator JUDGES what the last
 * action actually did (from pixels, not predictions) and DECIDES the next
 * step -> runtime executes it -> settle -> repeat, until the navigator can
 * see the objective delivered. There are no planner-authored expects and no
 * separate verifier: verification IS the judgment at the top of every turn,
 * made by the strongest model in the system looking at the actual outcome.
 *
 * Safety invariants live IN CODE, not prompts:
 * - side-effect steps get exactly ONE attempt, and one judged failed or
 *   uncertain can never be blindly re-issued on the same page (permanent
 *   per-run memory);
 * - an action judged failed twice is rejected at decision time;
 * - hard budgets on steps, wall clock, consecutive failures, and
 *   consecutive invalid decisions (reset by any executed step).
 *
 * PRIVACY NOTE: this engine sends tab screenshots to the remote navigator
 * model. Calls request no-retention routing (provider.data_collection=deny),
 * but this is a deliberate departure from the local-only doctrine, traded
 * for verification robustness. The no-API-key local path is unaffected.
 */

// NOT a working budget — a runaway backstop only (user decision 2026-07-15:
// steps are cheap and fast now; the wall clock is the real budget). A run
// that legitimately needs many steps must never be guillotined mid-progress.
const MAX_STEPS = 150;
const MAX_TASK_MS = 15 * 60_000;
const JOURNAL_MAX_LINES = 80;
const MAX_CONSECUTIVE_FAILURES = 4;
// Consecutive runtime-rejected decisions; any EXECUTED step resets the count
const MAX_REJECTIONS = 3;
// Review termination is OUTCOME-BASED, not budget-based (user decision
// 2026-07-23: "a set mechanical number does not make sense"): a run ends
// when strategies stop producing new outcomes — two consecutive reviews
// with zero collection growth between them — or when the wall clock dies.
// MAX_REVIEWS is only a runaway backstop, far above any healthy run.
const MAX_REVIEWS = 8;
// Runtime sweep: screenfuls read per sweep before giving up (a backstop —
// bottom detection normally ends it much earlier)
const SWEEP_MAX_SCREENS = 30;

// A kickoff-declared row target is honored only when the OBJECTIVE itself
// names that count ("top 10", "find 15 leads") — the model invents round
// numbers for open-ended objectives (live 2026-07-23: target 10 declared for
// "pull the full speaker list" made the run stop at 10 of 119 and the
// completion gate dutifully agreed). Digits alone are not evidence — years
// and URLs carry digits — so the SPECIFIC number must appear as a standalone
// token, or as its number word.
const NUMBER_WORDS: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  12: 'twelve',
  15: 'fifteen',
  20: 'twenty',
  25: 'twenty-five',
  30: 'thirty',
  50: 'fifty',
  100: 'hundred',
};
// Bounded Levenshtein distance — used only for near-duplicate name rows,
// where inputs are short person/company names
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function objectiveNamesCount(objective: string, target: number): boolean {
  if (new RegExp(`\\b${target}\\b`).test(objective)) return true;
  const word = NUMBER_WORDS[target];
  return word ? new RegExp(`\\b${word}\\b`, 'i').test(objective) : false;
}
// At a review dead end, a stuck signal ends the run — UNLESS the run is
// demonstrably still progressing (recent collection growth), in which case
// it gets a bounded number of grace passes to route around the local
// obstacle (live 2026-07-23: 75/119 speakers collected and climbing; two
// missed clicks on a letter link killed the run mid-harvest).
const MAX_POST_REVIEW_GRACES = 3;
const GRACE_PROGRESS_WINDOW = 4;
// Stuck signals that trigger a review (deterministic, evaluated in code):
// same action judged failed twice, this many consecutive failed judgments,
// any guard rejection, or the navigator flagging itself as circling
const REVIEW_AFTER_CONSECUTIVE_FAILURES = 2;
const RESUME_WINDOW_MS = 30 * 60_000;

// Give the page time to react before photographing it — a screenshot of a
// mid-transition page produces a wrong judgment, and wrong judgments are this
// architecture's only failure mode. (capturePageState additionally waits for
// the tab's load state.)
const SETTLE_MS: Record<string, number> = {
  navigate: 2500,
  click: 1500,
  type: 1200,
  type_focused: 1200,
  key: 1500,
  scroll: 600,
  clear_focused: 500,
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 100 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function cloudMeta(usage: CallUsage): string {
  const cost =
    usage.cost !== null
      ? `$${usage.cost.toFixed(4)}`
      : usage.promptTokens !== null
        ? `${usage.promptTokens}+${usage.completionTokens ?? 0} tok`
        : 'cost n/a';
  const calls = (usage.calls ?? 1) > 1 ? ` · ${usage.calls} model calls` : '';
  const took = usage.durationMs !== undefined ? ` · ${fmtDuration(usage.durationMs)}` : '';
  return `☁ ${usage.model} · ${cost}${calls}${took}`;
}

function elementsDigestOf(state: PerceptionSnapshot | null): string[] {
  if (!state) return [];
  return state.elements.slice(0, 30).map(el => {
    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
    const label = (el.text || el.placeholder || el.href || '').slice(0, 60);
    return `[${el.index}]<${kind}> ${label}`.trim();
  });
}

// Action skeleton for the repeat-decision guard (free text ignored: a
// decision that only rewords its typing is still the same decision)
function actionFingerprint(step: ProgramStep): string {
  return JSON.stringify([step.do, step.url ?? '', step.target ?? '', step.query ?? '', step.items?.[0] ?? '']);
}

// Futility window: how many recent executed steps to remember, and how many
// repeats of one action inside it count as pacing (a loop made of local
// successes — scroll up, scroll down, scroll up — that no failure signal sees)
const FUTILITY_WINDOW = 8;
const FUTILITY_REPEATS = 3;
// Same action judged "uncertain" (no visible effect) this many times = stuck
const UNCERTAIN_REPEATS = 2;

// ---- HUMAN-VERIFICATION (CAPTCHA) POLICY ----
// The agent NEVER solves a verification challenge itself — enforced HERE, in
// code, because the prompt rule alone failed (live 2026-07-21: the navigator
// clicked Cloudflare's "Verify you are human" checkbox under progress
// pressure). A click on a verification control is rejected at decision time;
// what happens next is the user's captchaBehavior setting: 'wait' (default)
// parks the run on the challenge page, surfaces the agent window, and polls
// perception until the USER clears it, then resumes; 'stop' stalls
// immediately (reply "continue" after clearing it manually).
const CAPTCHA_MARKERS =
  /captcha|turnstile|verify (?:that )?you(?:'| ?a)re (?:a )?human|human verification|not a robot|unusual traffic|cf-chl|security check to continue/i;
const VERIFICATION_POLL_MS = 4_000;
const VERIFICATION_WAIT_MS = 180_000;
const MAX_VERIFICATION_WAITS = 2;

// ---- ZERO-PROGRESS FUTILITY ----
// Step-level judgments only see individual success: a page that loads is a ✓
// even when it teaches nothing. A run can therefore circle indefinitely with
// every step "succeeding" (live 2026-07-21: ~25 steps of re-worded Google
// searches, each judged ✓, zero new data — no stuck signal ever fired).
// Progress is measured in outcomes: a new collection item, a change made to
// the world, or a first visit to a new site. This many executed steps
// without any of those escalates to a strategic review.
const PROGRESSLESS_STEPS = 8;

// How many collection items the navigator sees verbatim each turn — the
// COMPLETE ledger for any normal-sized collection (live 2026-07-22: a last-6
// tail hid the ledger during per-item enrichment; the navigator re-verified
// done items and invented ones that were never collected). ~40 × 160 chars
// ≈ 6KB — negligible next to the screenshot the same call carries.
const COLLECTION_LEDGER_ITEMS = 40;

// A "done" on a data deliverable is vetted against the full ledger by a
// stronger model this many times before it is accepted regardless — the cap
// stops a navigator that keeps re-declaring done from looping (the honest
// report still states what was and wasn't gathered).
const MAX_DONE_AUDITS = 2;

// Submit-looking click/key targets must declare sideEffect explicitly — an
// unmarked submit would get the transient-retry treatment and could fire
// twice. Input-looking targets are excluded (a textbox merely NAMED "Post
// text" is not a submit button — live false positive 2026-07-15).
const SUBMITTY = /\b(post|send|submit|publish|delete|purchase|buy|pay|confirm|apply|tweet|reply)\b/i;
const INPUTISH = /\b(text|field|box|input|editor|composer|area|message body|search|what)\b/i;
// Submit words in NOUN context — "Ahmad's post", "the post about X", the
// "Post your reply" composer placeholder — describe content being OPENED, not
// a control that submits. These phrases are stripped before the SUBMITTY test
// so a click that merely opens a post to read it is not flagged (live failure
// 2026-07-20: three rejections on read-only clicks stalled the run). A target
// that STILL carries a submit word after stripping ("the Reply button") keeps
// the declaration requirement — the guard itself stays strict.
const SUBMIT_NOUN_CONTEXT = /['’]s\s+(?:post|tweet|reply|comment|message)\b|\b(?:post|tweet|reply|comment|message)s?\s+(?:about|by|from|titled|containing)\b|\bpost\s+your\s+reply\b/gi;

function stepFaultReason(step: ProgramStep): string | null {
  if (!step.do) return 'the step has no "do"';
  const target = step.target ?? '';
  if (
    (step.do === 'click' || step.do === 'key') &&
    step.sideEffect === undefined &&
    SUBMITTY.test(target.replace(SUBMIT_NOUN_CONTEXT, ' ')) &&
    !INPUTISH.test(target)
  ) {
    // Show the exact form to send back — prose descriptions of the mechanism
    // were re-issued unchanged until the run stalled (lesson: show the form)
    return `this ${step.do} on "${target.slice(0, 60)}" needs an explicit "sideEffect" — re-issue the SAME step with the field added, e.g. {"do":"${step.do}",...,"sideEffect":false}. Use false when it merely OPENS a post, composer, menu, or dialog; true when it posts/sends/deletes/purchases`;
  }
  return null;
}

// Hand-transcription detector: how many lines of a typed text duplicate
// items already in the collection store. The navigator only ever sees the
// collection through the CAPPED journal digest, so a multi-line write it
// composes by hand can only carry the rows it happened to see — every other
// collected item is silently dropped (live run 2026-07-19: 13 collected
// LinkedIn contacts, 9 hand-typed rows reached the sheet). Matching is by
// dedup-key prefix because the navigator retypes truncated digest lines.
function transcribedCollectionLines(text: string | undefined, collectionKeys: Set<string>): number {
  const lines = (text ?? '')
    .split('\n')
    .map(itemKey)
    .filter(key => key.length >= 8);
  if (lines.length < 3 || collectionKeys.size === 0) return 0;
  const prefixes = [...collectionKeys].map(key => key.slice(0, 24)).filter(prefix => prefix.length >= 8);
  return lines.filter(line => prefixes.some(prefix => line.startsWith(prefix) || prefix.startsWith(line.slice(0, 24))))
    .length;
}

const stripBullet = (line: string) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();

const CONTINUATION = /^(continue|resume|keep going|carry on|go on|proceed|finish it|carry on with it)\b/i;

// A bare agreement to whatever the assistant just offered ("want me to try
// again?" → "yeah"). Taken alone it is meaningless as an objective — the run
// once asked "what exactly do you want me to do on X?" right after offering
// the action itself (live failure 2026-07-20). Deliberately strict: only
// short, purely-affirmative messages qualify; anything with its own content
// stays the objective verbatim.
const AFFIRMATION = /^(?:yeah|yea|yes|yep|yup|sure|ok|okay|sounds good|go ahead|do it|please do|go for it|let'?s (?:do it|go)|try again|yes please)[\s.!]*$/i;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runStepwiseTask(
  port: chrome.runtime.Port,
  tabId: number,
  taskId: string,
  task: string,
  record: TaskRecord,
  signal: AbortSignal,
  // The tab the user was viewing when they sent the task (null when unknown —
  // scheduled runs, non-http pages). The agent window can't see it, so it is
  // handed to kickoff and the journal as the referent for deictic objectives.
  userPage: { url: string; title: string } | null = null,
): Promise<void> {
  const startedAt = Date.now();
  let costKnown = true;
  const track = (usage: CallUsage): string => {
    record.cloudCalls += usage.calls ?? 1;
    record.orchestratorModel = usage.model;
    if (usage.cost !== null) record.totalCostUsd += usage.cost;
    else costKnown = false;
    return cloudMeta(usage);
  };
  const totalMeta = () =>
    `task total ${costKnown ? '' : '≥'}$${record.totalCostUsd.toFixed(4)} · ${record.cloudCalls} cloud call${record.cloudCalls === 1 ? '' : 's'}`;
  const heartbeat = (message: string) => postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, message);

  const finishOk = (answer: string, meta: string) => {
    record.outcome = 'ok';
    record.answer = answer;
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, answer, `${meta} · ${totalMeta()}`);
    // Offer to distill the winning route into a skill — but only when the run
    // actually produced NEW knowledge: either no playbook was pinned (novel
    // territory), or one was pinned but the run still hit a stuck signal hard
    // enough to need a strategic review (the playbook's route wasn't enough;
    // what the review discovered is knowledge worth keeping). A success that
    // simply followed an existing skill teaches nothing — offering to distill
    // it would just mint a duplicate of the skill that carried the run.
    const novelRun = pinnedSkillNames.size === 0 || reviewsUsed > 0;
    if (journal.length > 0 && novelRun) {
      stashSuccessfulRun({
        objective: goalText,
        journal: journal.slice(),
        pinnedSkills: [...pinnedSkillNames],
      }).catch(error => logger.warning('skillify stash failed:', error));
      try {
        port.postMessage({ type: 'skillify_offer', objective: goalText });
      } catch {
        /* panel closed — nothing to offer */
      }
    }
  };
  const finishFail = (reason: string, meta: string) => {
    record.outcome = 'fail';
    record.answer = reason;
    postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, reason, `${meta} · ${totalMeta()}`);
  };

  const journal: string[] = [];
  const note = (line: string) => {
    journal.push(line.replace(/\n/g, ' ').slice(0, 300));
    if (journal.length > JOURNAL_MAX_LINES) journal.splice(0, journal.length - JOURNAL_MAX_LINES);
  };

  const collection: string[] = [];
  const collectionKeys = new Set<string>();

  // ---- DELIVERABLE SCHEMA (schema'd collection, 2026-07-22) ----
  // When the kickoff declares the deliverable as a TABLE (columns + optional
  // target count), the collection becomes ROWS with named fields and the
  // bookkeeping that kept failing as LLM-over-strings becomes plain code:
  // "is this row complete" is a null-check, merging is filling an empty
  // cell, "are we done" is completeRows >= target. The `collection` string
  // array remains the RENDERED VIEW of the rows ("name — column: value — …",
  // round-trippable by parseLineToRow) so every downstream consumer — curate,
  // report, persistence/resume, textFrom:"collected" writes — keeps working.
  // Without a schema everything behaves exactly as before (free-text lines).
  let schema: { columns: string[]; target?: number } | null = null;
  const rows: Array<Record<string, string>> = [];
  const rowIndex = new Map<string, number>(); // rowKey -> rows index

  // Account sync (optional): mirrors this run to "My Searches" on the user's
  // koretex.ai account while it works. Fire-and-forget — a missing account or
  // unreachable site leaves runSync null and changes nothing about the run.
  let runSync: RunSyncHandle | null = null;
  void createRunSync(taskId, task.slice(0, 200), task, () => ({
    columns: schema?.columns ?? null,
    rows,
    collection,
  }))
    .then(handle => {
      runSync = handle;
    })
    .catch(() => {});
  const rowKeyOf = (name: string): string =>
    name
      .toLowerCase()
      .replace(/^the\s+/, '')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 60);
  const normalizeCol = (label: string): string =>
    label
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, '')
      .trim();
  const matchColumn = (label: string): string | null => {
    if (!schema) return null;
    const norm = normalizeCol(label);
    if (!norm) return null;
    for (const col of schema.columns) {
      const colNorm = normalizeCol(col);
      if (colNorm === norm || colNorm.includes(norm) || norm.includes(colNorm)) return col;
    }
    return null;
  };
  // Bare values self-select a column by TYPE (a URL fills the website-ish
  // column) — the common shape of enrichment lookups
  const URLISH = /^(https?:\/\/\S+|www\.\S+|[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?)$/i;
  const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const columnForValue = (value: string): string | null => {
    if (!schema) return null;
    const v = value.trim();
    if (URLISH.test(v)) return schema.columns.find(c => /site|url|link|domain|homepage|web/.test(normalizeCol(c))) ?? null;
    if (EMAILISH.test(v)) return schema.columns.find(c => /mail/.test(normalizeCol(c))) ?? null;
    return null;
  };
  const rowComplete = (row: Record<string, string>): boolean =>
    schema !== null && schema.columns.every(col => (row[col] ?? '').trim().length > 0);
  const completeRowCount = (): number => rows.filter(rowComplete).length;
  const renderRowDisplay = (row: Record<string, string>): string => {
    if (!schema) return '';
    const name = row[schema.columns[0]] ?? '?';
    const rest = schema.columns.slice(1).map(col => `${col}: ${(row[col] ?? '').trim() || '—'}`);
    const notes = row.notes?.trim() ? [`notes: ${row.notes.slice(0, 120)}`] : [];
    return [name, ...rest, ...notes].join(' — ');
  };
  const rebuildCollectionView = (): void => {
    if (!schema) return;
    collection.length = 0;
    for (const row of rows) collection.push(renderRowDisplay(row));
  };
  // Per-record diagnostics: WHY each item landed / merged / bounced. Fed to
  // the journal so the navigator can correct its recording format instead of
  // blindly retrying (live failure 2026-07-22 run #8: four identical record
  // attempts for one website all bounced as "already collected" with no
  // explanation; the run died pacing on them).
  const collectDiagnostics: string[] = [];
  // A cell value must BE the thing its column names: link-ish columns only
  // accept real external URLs/domains (live 2026-07-22 run #12: profile
  // SLUGS like "straikerai" filled 36 website cells, the rows counted
  // "complete", and the batch/done machinery ran on garbage)
  const isLinkishCol = (col: string): boolean => /site|url|link|domain|homepage|web/.test(normalizeCol(col));
  const validateCellValue = (col: string, value: string): string | null => {
    if (!isLinkishCol(col)) return value;
    const v = value.replace(/^["'(<]+/, '').replace(/[)>,.;"']+$/, '');
    if (!URLISH.test(v) || !v.includes('.')) return null;
    const currentHost = currentUrlPath.split('/')[0].replace(/^www\./, '').toLowerCase();
    if (currentHost && v.toLowerCase().includes(currentHost)) return null; // the source site's own page
    return v;
  };
  // "DV Dor Vardi" → "Dor Vardi": on cards whose photo is an initials
  // circle, the vision reader transcribes the initials as part of the name,
  // creating a duplicate row beside the real one (live 2026-07-23). A
  // leading all-caps token that matches the initials of the words after it
  // is that avatar, not a name part.
  const stripAvatarInitials = (name: string): string => {
    const parts = name.trim().split(/\s+/);
    // Leading token shaped like initials: "JL", "J.L.", "jl" all count
    const lead = (parts[0] ?? '').replace(/\./g, '').toUpperCase();
    if (parts.length >= 3 && /^[A-Z]{2,3}$/.test(lead)) {
      const initials = parts
        .slice(1)
        .map(word => word[0]?.toUpperCase() ?? '')
        .join('');
      if (initials.startsWith(lead)) return parts.slice(1).join(' ');
    }
    return name.trim();
  };
  // Avatar-initials circles are DOM TEXT on photo-less cards, so the token
  // rides the text channel too and occasionally lands in a CELL — as a
  // whole value ("SS" as a company: the NEIGHBOR card's initials, live
  // 2026-07-23) or glued to one ("Reevo AG", AG = the row's own initials).
  // Strip artifact tokens from cell edges; a value that is ONLY such a
  // token bounces. Guarded by an initials match against known rows so real
  // short companies (G2 has a digit; IBM only bounces if some row's
  // initials are literally IBM) almost never false-positive.
  const initialsOf = (fullName: string): string =>
    fullName
      .trim()
      .split(/\s+/)
      .map(word => word[0]?.toUpperCase() ?? '')
      .join('');
  const scrubInitialsArtifact = (value: string, ownName: string): string => {
    if (!schema) return value.trim();
    const known = new Set(
      rows.map(row => initialsOf(row[schema!.columns[0]] ?? '')).filter(initials => initials.length >= 2),
    );
    const own = initialsOf(ownName);
    if (own.length >= 2) known.add(own);
    const isArtifact = (token: string): boolean => {
      const t = token.replace(/\./g, '').toUpperCase();
      return /^[A-Z]{2,3}$/.test(t) && known.has(t);
    };
    const tokens = value.trim().split(/\s+/);
    while (tokens.length > 1 && isArtifact(tokens[0])) tokens.shift();
    while (tokens.length > 1 && isArtifact(tokens[tokens.length - 1])) tokens.pop();
    if (tokens.length === 1 && isArtifact(tokens[0])) return '';
    return tokens.join(' ');
  };
  const upsertRow = (name: string, fields: Record<string, string>): 'new' | 'upgraded' | 'dup' => {
    if (!schema) return 'dup';
    const cleanName = stripAvatarInitials(name);
    // Sentence-shaped "names" are reader commentary, not entities (live: a
    // row named "Note: The first three entries in the page text…")
    if (cleanName.length > 64) {
      collectDiagnostics.push(`"${cleanName.slice(0, 40)}…": rejected — not an entity name`);
      return 'dup';
    }
    const key = rowKeyOf(cleanName);
    if (!key) return 'dup';
    let idx = rowIndex.get(key);
    let outcome: 'new' | 'upgraded' | 'dup' = 'dup';
    if (idx === undefined) {
      idx = rows.length;
      rows.push({ [schema.columns[0]]: cleanName });
      rowIndex.set(key, idx);
      outcome = 'new';
      curated = false; // a new entity after a curation pass re-arms it
    }
    const row = rows[idx];
    const filled: string[] = [];
    const bounced: string[] = [];
    for (const [label, rawValue] of Object.entries(fields)) {
      const raw = String(rawValue ?? '')
        .trim()
        .replace(/^—$/, '');
      if (!raw) continue;
      const value = scrubInitialsArtifact(raw, cleanName);
      if (!value) {
        bounced.push(`"${raw.slice(0, 20)}" is an avatar-initials artifact, not a real ${label.slice(0, 20)}`);
        continue;
      }
      const col = matchColumn(label) ?? (normalizeCol(label) === 'notes' ? 'notes' : null);
      if (col && col !== 'notes') {
        const validated = validateCellValue(col, value);
        if (validated === null) {
          bounced.push(`"${value.slice(0, 30)}" is not a valid ${col} (not an external URL/domain)`);
        } else if (!(row[col] ?? '').trim()) {
          row[col] = validated;
          filled.push(col);
          if (outcome === 'dup') outcome = 'upgraded';
        } else {
          bounced.push(`${col} already holds "${(row[col] ?? '').slice(0, 40)}"`);
        }
      } else {
        const existing = row.notes ?? '';
        if (!existing.toLowerCase().includes(value.toLowerCase())) {
          row.notes = existing ? `${existing}; ${value}` : value;
          filled.push(`notes("${label.slice(0, 20)}" matched no column)`);
          if (outcome === 'dup') outcome = 'upgraded';
        }
      }
    }
    collectDiagnostics.push(
      `"${cleanName.slice(0, 40)}": ${
        outcome === 'new'
          ? `new row${filled.length ? `, filled ${filled.join(', ')}` : ''}`
          : filled.length
            ? `filled ${filled.join(', ')}`
            : `NO CHANGE${bounced.length ? ` (${bounced.join('; ')})` : Object.keys(fields).length ? ' (no recognizable "column: value" field)' : ' (name only, no fields)'}`
      }`,
    );
    if (outcome !== 'dup') {
      collectionMutations++;
      rebuildCollectionView();
    }
    return outcome;
  };
  // Free-text line -> row: first separator part is the name; "label: value"
  // parts map to columns; bare values self-select by type; the rest is notes
  const parseLineToRow = (line: string): 'new' | 'upgraded' | 'dup' => {
    if (!schema) return 'dup';
    const parts = stripBullet(line)
      .split(/\s*(?:—|–|\|)\s*/)
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length === 0) return 'dup';
    const fields: Record<string, string> = {};
    const extras: string[] = [];
    for (const part of parts.slice(1)) {
      const labelled = part.match(/^([A-Za-z][\w /-]{0,30}?)\s*[:=]\s*(.+)$/);
      if (labelled && matchColumn(labelled[1])) {
        fields[labelled[1]] = labelled[2];
        continue;
      }
      const typedCol = columnForValue(part);
      if (typedCol && !(typedCol in fields)) fields[typedCol] = part;
      else extras.push(part);
    }
    if (extras.length) fields.notes = extras.join('; ');
    return upsertRow(parts[0], fields);
  };
  // Object collect item -> row: locate the name column among the keys
  const upsertObjectItem = (obj: Record<string, unknown>): 'new' | 'upgraded' | 'dup' => {
    if (!schema) return 'dup';
    const keys = Object.keys(obj);
    const nameKey = keys.find(k => matchColumn(k) === schema!.columns[0]) ?? keys.find(k => normalizeCol(k) === 'name') ?? keys[0];
    if (!nameKey) return 'dup';
    const name = String(obj[nameKey] ?? '').trim();
    if (!name) return 'dup';
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === nameKey) continue;
      fields[k] = String(v ?? '');
    }
    return upsertRow(name, fields);
  };
  // A vision misread of a name ("Bonnaceur" for "Bennaceur") creates a
  // SEPARATE row that exact-key dedupe can never merge (live 2026-07-23:
  // both rows shipped in the final table). Names sharing their first word
  // within 2 edits of each other are the same person/entity: keep the row
  // with more filled cells, merge the other's fields into it.
  const mergeNearDuplicateRows = (): number => {
    if (!schema || rows.length < 2) return 0;
    const nameCol = schema.columns[0];
    const filledCount = (row: Record<string, string>): number =>
      schema!.columns.filter(col => (row[col] ?? '').trim()).length;
    let merged = 0;
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const a = (rows[i][nameCol] ?? '').trim().toLowerCase();
          const b = (rows[j][nameCol] ?? '').trim().toLowerCase();
          if (!a || !b || a === b) continue;
          if ((a.split(/\s+/)[0] ?? '') !== (b.split(/\s+/)[0] ?? '')) continue;
          if (editDistance(a, b) > 2) continue;
          const keepIdx = filledCount(rows[i]) >= filledCount(rows[j]) ? i : j;
          const dropIdx = keepIdx === i ? j : i;
          for (const col of schema.columns) {
            if (!(rows[keepIdx][col] ?? '').trim() && (rows[dropIdx][col] ?? '').trim()) {
              rows[keepIdx][col] = rows[dropIdx][col];
            }
          }
          rows.splice(dropIdx, 1);
          merged++;
          changed = true;
          break outer;
        }
      }
    }
    if (merged) {
      rowIndex.clear();
      rows.forEach((row, i) => rowIndex.set(rowKeyOf(row[nameCol] ?? ''), i));
      rebuildCollectionView();
    }
    return merged;
  };
  const renderRowWrite = (row: Record<string, string>): string =>
    (schema?.columns ?? []).map(col => (row[col] ?? '').trim()).join('\t');
  // The table as the navigator sees it each turn: computed status line +
  // per-row missing-cell annotations — the checklist that replaces counting
  const renderDeliverableStatus = (): string | undefined => {
    if (!schema) return undefined;
    const complete = completeRowCount();
    const shown = rows.slice(0, COLLECTION_LEDGER_ITEMS).map((row, i) => {
      const missing = schema!.columns.filter(col => !(row[col] ?? '').trim());
      return `${i + 1}. ${renderRowDisplay(row)}   ${missing.length ? `[missing: ${missing.join(', ')}]` : '[complete]'}`;
    });
    const overflow =
      rows.length > COLLECTION_LEDGER_ITEMS ? `\n(…and ${rows.length - COLLECTION_LEDGER_ITEMS} more rows)` : '';
    const targetPart = schema.target ? ` Target: ${schema.target} complete rows.` : '';
    return `Columns: ${schema.columns.join(' | ')}.${targetPart} Status: ${complete} complete, ${rows.length - complete} incomplete.\n${shown.join('\n') || '(no rows yet)'}${overflow}`;
  };

  // The final-answer table, rendered by the RUNTIME from its row store —
  // never by the model. The write path learned this lesson long ago
  // (textFrom:"collected" exists because model retyping drops rows); the
  // answer path repeats it: 107 curated rows in, a token-capped reply
  // truncated the table at exactly 100 and presented the wrong count as
  // fact (live 2026-07-23 18:04).
  const renderMarkdownTable = (): string => {
    if (!schema || rows.length === 0) return '';
    const esc = (value: string): string => value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
    const header = schema.columns.map(col => col.charAt(0).toUpperCase() + col.slice(1));
    const lines = [
      `| ${header.join(' | ')} |`,
      `|${header.map(() => '---').join('|')}|`,
      ...rows.map(row => `| ${schema!.columns.map(col => esc((row[col] ?? '').trim()) || '—').join(' | ')} |`),
    ];
    return `${lines.join('\n')}\n\n(${rows.length} rows, rendered directly from the run's data store.)`;
  };

  // Entity head of an item line — the text before the first field separator.
  // Per-item enrichment records "Name — website" while the original ledger
  // line holds "Name — Series A …"; stored as separate partial items the
  // pair NEVER satisfies a per-item-fields objective (live failure
  // 2026-07-22: 8 companies had both halves in the ledger as splits, the
  // done-audit correctly counted "2 of 10 complete", and the run burned its
  // budget re-enriching items it already held). Same-entity lines MERGE.
  const nameKeyOf = (line: string): string => {
    const head = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').split(/\s*(?:—|–|\||:|\t|,)\s*/)[0] ?? '';
    return head.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
  };
  // Fields of `other` not already present in `base`, appended — no field is
  // ever lost regardless of which line was fuller
  const mergeLines = (base: string, other: string): string => {
    const baseNorm = base.toLowerCase();
    const extras = other
      .split(/\s*(?:—|–|\|)\s*/)
      .slice(1)
      .map(part => part.trim())
      .filter(part => part && !baseNorm.includes(part.toLowerCase()));
    return extras.length ? `${base} — ${extras.join(' — ')}` : base;
  };
  // Counts every new-or-upgraded item — the progress signal (collection
  // LENGTH misses upgrades, which change an item in place)
  let collectionMutations = 0;
  const addOrUpgrade = (rawItem: string): 'new' | 'upgraded' | 'dup' => {
    const item = stripBullet(rawItem).trim();
    // Schema mode: every line becomes (part of) a row
    if (schema) return parseLineToRow(item);
    const key = itemKey(item);
    if (!key || collectionKeys.has(key)) return 'dup';
    const nameKey = nameKeyOf(item);
    // Short heads ("AI", "The") are too generic to identify an entity
    if (nameKey.length >= 4) {
      const existingIdx = collection.findIndex(existing => nameKeyOf(existing) === nameKey);
      if (existingIdx >= 0) {
        const existing = collection[existingIdx];
        const merged = item.length > existing.length ? mergeLines(item, existing) : mergeLines(existing, item);
        if (merged === existing) return 'dup';
        collection[existingIdx] = merged;
        collectionKeys.add(key);
        collectionKeys.add(itemKey(merged));
        collectionMutations++;
        return 'upgraded';
      }
    }
    collectionKeys.add(key);
    collection.push(item);
    collectionMutations++;
    curated = false; // a new entity after a curation pass re-arms it
    return 'new';
  };

  const recordExtract = (query: string, answer: string) => {
    let fresh = 0;
    let upgraded = 0;
    collectDiagnostics.length = 0;
    for (const line of listLines(answer)) {
      const outcome = addOrUpgrade(line);
      if (outcome === 'new') fresh++;
      else if (outcome === 'upgraded') upgraded++;
    }
    if (schema && collectDiagnostics.length) note(`record outcomes: ${collectDiagnostics.slice(0, 6).join(' · ')}`);
    note(
      fresh + upgraded > 0
        ? `data: +${fresh} new${upgraded ? `, ${upgraded} upgraded` : ''} item(s) (${collection.length} total): ${answer.slice(0, 160)}`
        : `data: ${answer.slice(0, 220)}`,
    );
  };

  let currentUrlPath = '';

  // ---- RUN TAB SET (tab-per-site) ----
  // Multi-site tasks used to thrash ONE tab: returning to the sheet meant
  // reloading docs.google.com and re-finding the document — wasted steps and
  // the classic tip-over of creating a duplicate "Untitled spreadsheet"
  // (live failure 2026-07-20). Now each SITE gets its own tab for the whole
  // run: the first navigate to a site opens a tab, every later navigate to
  // that site SWITCHES to it (a pure switch when it already shows the
  // requested page — state preserved, no reload). Deterministic and
  // invisible to the navigator: it still just decides "navigate to <url>";
  // the decision space is unchanged (tab bookkeeping belongs in code, not in
  // a small model's hands). The navigator learns what is open via the RUN
  // TABS line pinned into its prompt.
  const MAX_RUN_TABS = 4;
  let currentTab = tabId;
  const runTabs = new Map<string, number>(); // site key -> tabId
  // docs.google.com hosts several apps — a sheet and a doc must not share a tab
  const siteKey = (url: URL): string => {
    const host = url.host.replace(/^www\./, '');
    return host === 'docs.google.com' ? `${host}/${url.pathname.split('/')[1] ?? ''}` : host;
  };
  const registerCurrentTabSite = (urlStr: string) => {
    try {
      runTabs.set(siteKey(new URL(urlStr)), currentTab);
    } catch {
      /* about:blank etc. — nothing to register */
    }
  };

  // One observation = digest for the prompt + screenshot for the judge's eyes
  // Signature of the last successful observation — the runtime's own measure
  // of "did the page change", independent of the judge's impression. URL +
  // scroll + text length + element count + leading text catches navigations,
  // scrolls, and content changes while staying cheap.
  let lastObservedSig: string | null = null;
  const observe = async (): Promise<{ digest?: string; screenshot?: string }> => {
    const state = await capturePageState(currentTab, false).catch(() => null);
    if (!state) {
      lastObservedSig = null;
      return {};
    }
    lastObservedSig =
      `${state.url}|${state.scroll?.y ?? 0}|${(state.pageText ?? '').length}|${elementsDigestOf(state).length}|` +
      (state.pageText ?? '').replace(/\s+/g, ' ').slice(0, 300);
    registerCurrentTabSite(state.url);
    try {
      const url = new URL(state.url);
      currentUrlPath = url.host + url.pathname;
    } catch {
      currentUrlPath = state.url.slice(0, 120);
    }
    const textSample = (state.pageText ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
    const digest =
      `${state.title} — ${state.url}\nELEMENTS:\n${elementsDigestOf(state).join('\n')}` +
      (textSample ? `\nPAGE TEXT (truncated sample — use an extract step to read more):\n${textSample}` : '');
    return { digest, screenshot: state.screenshot || undefined };
  };

  let goalText = task;
  let pendingQuestions: string[] | undefined;
  let stepsUsed = 0;
  let rejections = 0;

  // Cloud-only mode + PII guard + sensitive-site policy, loaded once per run
  const runSettings = await chatSettingsStore.getSettings();
  const piiGuardActive = runSettings.cloudOnly && runSettings.piiGuard;
  resetPiiVault();
  const sensitivePatterns = (runSettings.sensitiveSites ?? '')
    .split(',')
    .map(pattern => pattern.trim().toLowerCase())
    .filter(Boolean);
  const approvedHosts = new Set<string>();
  let pendingApprovalHost: string | undefined;
  const captchaWait = (runSettings.captchaBehavior ?? 'wait') !== 'stop';
  let verificationWaits = 0;

  // Zero-progress futility state (see PROGRESSLESS_STEPS)
  let progresslessSteps = 0;
  let lastProgressMutations = 0;
  const visitedHosts = new Set<string>();

  const persist = async (status: RunStatus) => {
    try {
      await runStateStore.setRun({
        sessionId: taskId,
        objective: goalText,
        journal: journal.slice(-JOURNAL_MAX_LINES),
        collection: collection.slice(),
        collectionSchema: schema ?? undefined,
        status,
        pendingQuestions,
        approvedHosts: [...approvedHosts],
        pendingApprovalHost,
        // Schema reuse: the runstate field is named for the PAV engine, but it
        // is just "budget consumed so far" — stepwise stores steps here
        plansUsed: stepsUsed,
        updatedAt: Date.now(),
      });
    } catch (error) {
      logger.warning('persist run state failed:', error);
    }
  };

  const report = async (status: 'achieved' | 'partial', reason: string): Promise<void> => {
    // Schema mode: complete rows outrank incomplete ones — deterministically,
    // so no model pass can drop a verified row while keeping unverified ones
    // (live 2026-07-22: curation dropped the one verified company "to keep
    // the list at 10" while seven kept rows lacked websites)
    if (schema && rows.length > 1) {
      const ordered = [...rows].sort((a, b) => Number(rowComplete(b)) - Number(rowComplete(a)));
      rows.length = 0;
      rows.push(...ordered);
      rowIndex.clear();
      rows.forEach((row, i) => rowIndex.set(rowKeyOf(row[schema!.columns[0]] ?? ''), i));
      rebuildCollectionView();
    }
    // Curate BEFORE reporting, not only before writes: the collection
    // accumulates every candidate sighted during the run, including items
    // that fail the objective's qualifiers (live 2026-07-22: a creator
    // platform and a dev-tools company shipped in a "fintech B2B SaaS" list,
    // taken on faith from an AI-overview summary). One quality pass so the
    // report works from vetted data.
    // Merge BEFORE curating: curation's "kept N" journal line is what the
    // prose model quotes, so the table must not shrink after it (live
    // 2026-07-23: prose said 105, the rendered footer said 104)
    mergeNearDuplicateRows();
    try {
      await curateBeforeWrite();
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning('pre-report curation failed:', error);
    }
    if (schema && rows.length > 0) {
      note(
        `final deliverable: ${rows.length} row(s) — the runtime-rendered table below the answer holds exactly this count; quote THIS number`,
      );
    }
    let meta = '';
    let answer: string;
    heartbeat(status === 'achieved' ? 'Objective met — writing the final answer…' : 'Writing up what happened…');
    // Schema runs: the harness renders the table, the model writes only the
    // prose around it (see renderMarkdownTable for the live failure)
    const runtimeTable = renderMarkdownTable();
    try {
      const result = await reportOutcome(goalText, status, journal, collection, signal, heartbeat, {
        runtimeTable: Boolean(runtimeTable),
        memory: agentMemory,
      });
      answer = result.answer;
      meta = track(result.usage);
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning('report call failed:', error);
      answer = `${reason}\n\nWhat happened:\n${journal.slice(-12).join('\n')}`;
    }
    if (runtimeTable) answer = `${answer}\n\n${runtimeTable}`;
    // Vault tokens in the answer become real values HERE, locally — the user
    // sees their actual data even though the cloud only saw placeholders
    answer = rehydratePii(answer);
    if (status === 'achieved') {
      await runStateStore.clearRun(taskId).catch(() => {});
      finishOk(answer, meta);
    } else {
      await persist('stalled');
      finishFail(
        `${reason ? `${answer}\n\n(${reason})` : answer}\n\nReply "continue" to resume from where this left off.`,
        meta,
      );
    }
    // Distill this run's learnings into the long-term memory — after the
    // answer is already posted, fire-and-forget: memory upkeep must never
    // delay or fail a delivery. Failed runs distill too (what didn't work
    // is half the point of remembering).
    updateMemoryAfterRun({
      objective: goalText,
      outcome: status === 'achieved' ? 'delivered' : 'failed',
      journal,
      signal,
    });
  };

  const deadline = startedAt + MAX_TASK_MS;
  const outOfTime = () => Date.now() >= deadline;

  // Park the run while the USER clears a human-verification challenge: bring
  // the agent window forward, then poll perception until the challenge
  // markers leave the page. 'cleared' resumes the loop; 'gaveup' (timeout)
  // falls through to a stall the user can "continue" out of.
  const awaitHumanVerification = async (why: string): Promise<'cleared' | 'gaveup'> => {
    verificationWaits++;
    note(`human-verification wall (${why}) — waiting for the user to clear it; the agent never answers those itself`);
    try {
      const tab = await chrome.tabs.get(currentTab);
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    } catch {
      // Focusing the agent window is best-effort
    }
    postExecutionEvent(
      port,
      Actors.ASSISTANT,
      'step.ok',
      taskId,
      "🧍 This site is asking for human verification — that's a question only you should answer. I've brought the agent window forward: complete the check there and I'll continue automatically.",
    );
    const waitUntil = Math.min(Date.now() + VERIFICATION_WAIT_MS, deadline);
    while (Date.now() < waitUntil) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      await sleep(VERIFICATION_POLL_MS);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const look = await observe();
      if (look.digest && !CAPTCHA_MARKERS.test(look.digest)) {
        note('the human-verification challenge is gone — the user cleared it; continuing the run');
        postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, '✅ Verification cleared — continuing.');
        return 'cleared';
      }
      heartbeat('Waiting for you to complete the verification in the agent window…');
    }
    return 'gaveup';
  };

  // Same parking mechanics as the sensitive-site ask: status 'stalled', and a
  // "continue" on this session resumes with journal + collection intact
  const stallOnVerification = async (message: string): Promise<void> => {
    record.outcome = 'ok';
    record.answer = 'awaiting human verification';
    await persist('stalled');
    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, message);
  };

  // Collection quality pass — runs before a collected-data WRITE, before a
  // "done" is accepted, and (via report) before every final answer. Re-armed
  // whenever a NEW item lands (addOrUpgrade/upsertRow set curated = false) so
  // rows recorded after a pass still get vetted. Returns how many items the
  // pass dropped, so the done-gate can say WHY the count fell.
  let curated = false;
  const curateBeforeWrite = async (): Promise<number> => {
    if (curated || collection.length === 0) return 0;
    curated = true;
    heartbeat(`Reviewing the ${collection.length} collected item(s) against the objective…`);
    const result = await curateCollection(goalText, collection.slice(), signal, heartbeat);
    const usedMeta = result.usage ? track(result.usage) : '';
    if (result.items.length && result.items.length !== collection.length) {
      // Drops must be VISIBLE by name — invisible drops let curation delete
      // real speakers for two runs before anyone noticed (live 2026-07-23:
      // Peter Grant, recovered by a dedicated second pass, silently culled)
      let droppedNames: string[] = [];
      if (schema) {
        // Schema mode: curation decides WHICH rows stay (matched by name);
        // the rows themselves — not the returned strings — remain the data,
        // so field structure survives curation untouched
        const keptKeys = new Set(
          result.items.map(item => rowKeyOf(stripBullet(item).split(/\s*(?:—|–|\|)\s*/)[0] ?? '')),
        );
        const keptRows = rows.filter(row => keptKeys.has(rowKeyOf(row[schema!.columns[0]] ?? '')));
        droppedNames = rows
          .filter(row => !keptKeys.has(rowKeyOf(row[schema!.columns[0]] ?? '')))
          .map(row => (row[schema!.columns[0]] ?? '?').slice(0, 40));
        if (keptRows.length) {
          rows.length = 0;
          rows.push(...keptRows);
          rowIndex.clear();
          rows.forEach((row, i) => rowIndex.set(rowKeyOf(row[schema!.columns[0]] ?? ''), i));
          rebuildCollectionView();
        }
      } else {
        const keptSet = new Set(result.items.map(item => itemKey(item)));
        droppedNames = collection
          .filter(item => !keptSet.has(itemKey(item)))
          .map(item => item.split(/\s*(?:—|–|\|)\s*/)[0]?.slice(0, 40) ?? '?');
        collection.length = 0;
        collection.push(...result.items);
      }
      const droppedList = droppedNames.slice(0, 8).join(', ') + (droppedNames.length > 8 ? ', …' : '');
      note(
        `curated the collection: kept ${result.items.length}, dropped ${result.dropped} non-matching item(s)${droppedList ? ` — dropped: ${droppedList}` : ''}`,
      );
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Curated collected data — kept ${result.items.length}, dropped ${result.dropped}${droppedList ? `: ${droppedList}` : ' off-target item(s)'}.`,
        usedMeta,
      );
      return result.dropped;
    }
    return 0;
  };

  // ---- RESUME / CLARIFY SEEDING (knowledge-replay, same as PAV) ----
  // Resume kind steers the kickoff below: a stalled continuation skips it
  // (the journal already carries the run's thinking); a clarify-resume
  // re-runs it with asking disabled, so the answers become a strategy.
  let resumedAfterClarify = false;
  let resumedContinuation = false;
  // Steering resume: a stalled run + ANY follow-up that isn't a bare
  // continuation phrase — the user is commenting on / correcting the task,
  // not starting a new one (live 2026-07-23: "the run was not stuck, all
  // you had to do was scroll down" hit the discard branch and the agent
  // asked "what was the original task?"). Seeds everything a continuation
  // seeds; kickoff still runs (asking disabled) to interpret the feedback.
  let resumedSteering = false;
  const prior = await runStateStore.getRun(taskId).catch(() => null);
  const priorFresh = prior ? Date.now() - prior.updatedAt < RESUME_WINDOW_MS : false;
  if (prior && !priorFresh) {
    await runStateStore.clearRun(taskId).catch(() => {});
  } else if (prior) {
    const seedFromPrior = () => {
      journal.push(...prior.journal.slice(-JOURNAL_MAX_LINES));
      // Restore the schema FIRST so seeded lines re-parse into rows (the
      // rendered "name — column: value" lines round-trip through the parser)
      const priorSchema = prior.collectionSchema;
      if ((priorSchema?.columns?.length ?? 0) >= 2) {
        schema = { columns: priorSchema!.columns.slice(), target: priorSchema!.target };
      }
      for (const item of prior.collection) {
        if (schema) {
          addOrUpgrade(item);
          continue;
        }
        const key = itemKey(item);
        if (key && !collectionKeys.has(key)) {
          collectionKeys.add(key);
          collection.push(item);
        }
      }
      for (const host of prior.approvedHosts ?? []) approvedHosts.add(host);
      // Resuming a run that stalled on a sensitive-site ask IS the approval
      if (prior.pendingApprovalHost) {
        approvedHosts.add(prior.pendingApprovalHost);
        note(`user approved working on the sensitive site ${prior.pendingApprovalHost}`);
      }
    };
    if (prior.status === 'awaiting_clarification') {
      resumedAfterClarify = true;
      seedFromPrior();
      goalText = `${prior.objective}\n\nThe user was asked: ${(prior.pendingQuestions ?? []).join(' ')}\nThe user answered: ${task}`;
      note(`resumed after clarification — user answered: ${task.slice(0, 160)}`);
      postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, 'Thanks — continuing with your answer.');
    } else if (prior.status === 'stalled' && CONTINUATION.test(task.trim())) {
      resumedContinuation = true;
      seedFromPrior();
      goalText = prior.objective;
      note(
        `resuming a stalled run — ${collection.length} item(s) already collected, ${journal.length} journal lines restored`,
      );
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Resuming the previous task — ${collection.length} item(s) already collected.`,
      );
    } else if (prior.status === 'stalled') {
      // A stalled run + a follow-up in the same session is a conversation
      // about THAT task until proven otherwise — never discard the run's
      // memory on a phrase mismatch. The message leads (a genuinely new
      // objective still wins), the stalled task rides as context.
      resumedSteering = true;
      seedFromPrior();
      goalText =
        `${task}\n\nCONTEXT — this message follows a STALLED run of the task: "${prior.objective}". ` +
        `${collection.length} item(s) collected so far are restored below, and the journal carries the run's history. ` +
        `If the message above steers, corrects, or comments on that task (the common case), CONTINUE that task with ` +
        `the feedback applied; treat it as a new objective only if it clearly names an unrelated task.`;
      note(
        `resuming a stalled run with user feedback ("${task.trim().slice(0, 120)}") — ${collection.length} item(s) already collected, ${journal.length} journal lines restored`,
      );
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Picking the previous task back up with your feedback — ${collection.length} item(s) already collected.`,
      );
    } else {
      await runStateStore.clearRun(taskId).catch(() => {});
    }
  }

  // Follow-ups are ONE conversation, not independent tasks. A later message
  // routinely refers back ("more posts", "try again", or a bare "yeah") —
  // run on the literal words alone and the run has no idea what they point
  // at (live failures 2026-07-20/21: "yeah" produced "what do you want me to
  // do on X?"; "analyse some more posts" lost the first analysis entirely).
  if (!resumedAfterClarify && !resumedContinuation && !resumedSteering) {
    const session = await chatHistoryStore.getSession(taskId).catch(() => null);
    const lastAssistant = (session?.messages ?? [])
      .filter(message => message.actor === Actors.ASSISTANT)
      .at(-1)
      ?.content?.trim();
    if (lastAssistant) {
      if (AFFIRMATION.test(task.trim())) {
        // A bare agreement to the assistant's previous offer — the offer IS
        // the objective
        goalText = `The assistant's previous message to the user was:\n"""${lastAssistant.slice(-1200)}"""\n\nThe user replied: "${task.trim()}" — agreeing to what that message proposed. The objective is to carry out the proposed action.`;
        note(`the user's "${task.trim().slice(0, 40)}" agrees to the assistant's previous offer — objective resolved from that offer`);
      } else {
        goalText = `${task}\n\nCONVERSATION CONTEXT — this is a FOLLOW-UP in the same chat; interpret the objective in light of it ("more", "again", "another", "the same" refer back to it). The assistant's previous answer was:\n"""${lastAssistant.slice(-900)}"""`;
        note('follow-up in an ongoing conversation — the previous answer is attached to the objective as context');
      }
    }
  }

  record.mode = 'plan';

  // Pin the user's viewing context into the journal — the run happens in the
  // agent window, so without this line no model ever learns what "this
  // page"/"this form" pointed at (live failure 2026-07-21: a form-filling
  // task confabulated a Gmail errand). Skipped on continuations: the seeded
  // journal already carries the original run's context, and the tab active
  // when the user typed "continue" is not the task's referent.
  if (userPage && !resumedContinuation && !resumedSteering) {
    note(`the user's active page when they sent the task: "${userPage.title}" — ${userPage.url}`);
  }

  if (piiGuardActive) {
    note(
      'PII guard active: values like ⟨email-1⟩ or ⟨phone-1⟩ are REAL values masked locally — use the tokens verbatim; typing a token types the real value.',
    );
  }

  // Native dialogs (beforeunload/alert/confirm) freeze the tab and are
  // invisible to every sense — the guard auto-handles them at the browser
  // level and reports here so the journal records what happened. Named so
  // every run tab (multi-tab: one per site) arms the same guard.
  const onNativeDialog = ({ kind, message, accepted }: { kind: string; message: string; accepted: boolean }) => {
    const label =
      kind === 'beforeunload'
        ? '"Leave site?" — the page warned of unsaved changes; unsaved work on the previous page may be lost'
        : `${kind}${message ? ` — "${message}"` : ''}`;
    note(`native browser dialog ${accepted ? 'auto-accepted' : 'dismissed'}: ${label}`);
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `🛡 Native dialog ${accepted ? 'accepted' : 'dismissed'}: ${label}`,
    );
  };

  // Managed navigate (tab-per-site; see RUN TAB SET above). Same URL in the
  // site's tab = pure switch, no reload; new URL on a known site = navigate
  // within its tab; new site = its own tab (capped — beyond the cap, load in
  // place). The returned message reaches the journal and the judge.
  const navigateManaged = async (rawUrl: string): Promise<{ ok: boolean; message: string }> => {
    const urlStr = /^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    let key: string | null = null;
    try {
      key = siteKey(new URL(urlStr));
    } catch {
      key = null;
    }
    const inPlace = () => executeAction(currentTab, taskId, { type: 'navigate', url: urlStr }, null);

    const existing = key !== null ? runTabs.get(key) : undefined;
    if (existing !== undefined && existing !== currentTab) {
      const alive = await chrome.tabs.get(existing).catch(() => null);
      if (!alive) {
        runTabs.delete(key!); // the user closed that tab — reopen below
      } else {
        currentTab = existing;
        rebindSessionTab(taskId, existing);
        await chrome.tabs.update(existing, { active: true }).catch(() => {});
        if ((alive.url ?? '').split('#')[0] === urlStr.split('#')[0]) {
          return { ok: true, message: `switched to the existing ${key} tab — page state preserved, no reload` };
        }
        const result = await inPlace();
        return result.ok ? { ok: true, message: `switched to the ${key} tab and navigated to ${urlStr}` } : result;
      }
    }
    if (existing === undefined && key !== null) {
      // The current tab is EMPTY (fresh agent window, or a follow-up landing
      // on the session's starter tab) — the first site loads HERE. Opening a
      // new tab instead orphans a blank tab that stays registered as the
      // session's tab, and the next follow-up "reuses" it and runs blind
      // (live failure 2026-07-21).
      const currentInfo = await chrome.tabs.get(currentTab).catch(() => null);
      if (currentInfo && !/^https?:/i.test(currentInfo.url ?? currentInfo.pendingUrl ?? '')) {
        runTabs.set(key, currentTab);
        return inPlace();
      }
      const distinctTabs = new Set(runTabs.values());
      distinctTabs.add(currentTab);
      if (distinctTabs.size < MAX_RUN_TABS) {
        const windowId = (await chrome.tabs.get(currentTab).catch(() => null))?.windowId;
        const created = await chrome.tabs
          .create({ url: urlStr, active: true, ...(windowId !== undefined ? { windowId } : {}) })
          .catch(() => null);
        if (created?.id !== undefined) {
          runTabs.set(key, created.id);
          currentTab = created.id;
          rebindSessionTab(taskId, created.id);
          await armDialogGuard(created.id, onNativeDialog).catch(error =>
            logger.warning('dialog guard unavailable on new tab:', error),
          );
          return { ok: true, message: `opened ${key} in its own new tab (the previous tab keeps its state)` };
        }
      }
    }
    return inPlace();
  };

  // Shared by the step runner's extract path and the batch-loop executor
  const readerEndpointCfg: PlannerEndpoint | undefined = runSettings.cloudOnly
    ? {
        kind: 'cloud',
        baseUrl: runSettings.orchestratorBaseUrl,
        apiKey: runSettings.orchestratorApiKey,
        model: runSettings.cloudReaderModel || runSettings.navigatorModel || runSettings.orchestratorModel,
        tier: 0,
      }
    : undefined;

  const runner = createStepRunner(
    tabId,
    taskId,
    {
      runId: taskId,
      resolveTab: () => currentTab,
      navigateTab: navigateManaged,
      onExtract: recordExtract,
      knownData: () => collection.slice(-8).map(entry => entry.slice(0, 250)),
      // Schema mode: writes get tab-separated column values (grid-ready);
      // prompts and reports keep the labeled display lines
      collectedItems: () => (schema ? rows.map(renderRowWrite) : collection),
      // Cloud-only mode: extract/harvest read via the orchestrator endpoint
      readerEndpoint: readerEndpointCfg,
      scrubForCloud: piiGuardActive,
      onUsage: usage => track(usage),
    },
    signal,
  );

  // ---- BATCH-LOOP EXECUTOR (schema mode, 2026-07-22) ----
  // A strategist-emitted, harness-validated per-row lookup: navigate a
  // {name}-templated URL, ONE reader call, fill ONE empty cell — repeated
  // over the rows missing that column with zero navigator turns. Codifies
  // the loop the per-step engine kept hand-cranking (~4 multimodal calls per
  // row in live runs). Deliberately read-only: no clicks, no typing, no
  // side-effect surface. Aborts back to normal stepping on verification
  // walls or two consecutive failures. Validation is strict by user policy:
  // only certainly-codifiable shapes run.
  let batchOpportunityTried = false;
  const runBatchLoop = async (loop: {
    urlTemplate?: string;
    fillColumn?: string;
    maxIterations?: number;
  }): Promise<void> => {
    if (!schema) return;
    const template = String(loop.urlTemplate ?? '').trim();
    const col = loop.fillColumn ? matchColumn(loop.fillColumn) : null;
    const placeholders = template.split('{name}').length - 1;
    if (!col || col === schema.columns[0] || placeholders !== 1 || !/^https?:\/\//i.test(template)) {
      note(
        `batch loop rejected by the runtime: ${
          !col
            ? `"${loop.fillColumn ?? ''}" is not a table column`
            : col === schema.columns[0]
              ? 'cannot batch-fill the name column'
              : placeholders !== 1
                ? 'urlTemplate must contain {name} exactly once'
                : 'urlTemplate must be an https URL'
        }`,
      );
      return;
    }
    let templateHost = '';
    try {
      templateHost = new URL(template.replace('{name}', 'x')).host.replace(/^www\./, '');
    } catch {
      note('batch loop rejected by the runtime: urlTemplate is not a valid URL');
      return;
    }
    const cap = Math.min(Math.max(1, Math.floor(loop.maxIterations ?? 20)), 40);
    const queue = rows
      .filter(row => (row[schema!.columns[0]] ?? '').trim() && !(row[col] ?? '').trim())
      .slice(0, cap);
    if (queue.length === 0) {
      note('batch loop: no rows are missing that column — nothing to do');
      return;
    }
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `⚙ Batch: filling "${col}" for ${queue.length} row(s) via ${templateHost} — one read per row, no per-step decisions.`,
    );
    note(`batch loop started: filling "${col}" for ${queue.length} row(s) via ${templateHost}`);
    const isLinkish = /site|url|link|domain|homepage|web/.test(normalizeCol(col));
    let filled = 0;
    let missed = 0;
    let consecutiveErrors = 0;
    for (const row of queue) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (outOfTime()) {
        note('batch loop stopped: time budget exhausted');
        break;
      }
      const name = (row[schema.columns[0]] ?? '').trim();
      heartbeat(`Batch: looking up "${col}" for ${name} (${filled + missed + 1}/${queue.length})…`);
      const nav = await navigateManaged(template.replace('{name}', encodeURIComponent(name)));
      if (!nav.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 2) {
          note('batch loop aborted: consecutive navigation failures — back to normal stepping');
          break;
        }
        continue;
      }
      await sleep(1800);
      let pageText = await capturePageText(currentTab).catch(() => '');
      if (CAPTCHA_MARKERS.test(pageText)) {
        note('batch loop aborted: the lookup page is showing a human-verification wall — back to normal stepping');
        break;
      }
      if (piiGuardActive) pageText = scrubPii(pageText);
      try {
        const query = `The ${col} of "${name}" — its OWN official ${
          isLinkish ? "website domain (an EXTERNAL site — never a URL on this page's own domain)" : col
        } as shown here. Reply with ONLY the value, or exactly NOT FOUND.`;
        const { answer, usage } = await extractFromPage(query, pageText, signal, readerEndpointCfg ?? LOCAL_ENDPOINT, []);
        if (usage) track(usage);
        const firstLine = answer.trim().split('\n')[0]?.trim() ?? '';
        let value: string | null = null;
        if (firstLine && !/not\s+found/i.test(firstLine)) {
          if (isLinkish) {
            value =
              firstLine
                .split(/\s+/)
                .map(token => token.replace(/^["'(<]+/, '').replace(/[)>,.;"']+$/, ''))
                .find(token => URLISH.test(token) && !token.toLowerCase().includes(templateHost)) ?? null;
          } else {
            value = firstLine.slice(0, 160);
          }
        }
        if (value) {
          upsertRow(name, { [col]: value });
          filled++;
          note(`batch: ${name} → ${col}: ${value.slice(0, 80)}`);
        } else {
          missed++;
          note(`batch: ${name} → ${col} not found on the lookup page`);
        }
        consecutiveErrors = 0;
      } catch (error) {
        if (signal.aborted) throw error;
        consecutiveErrors++;
        logger.warning('batch iteration failed:', error);
        if (consecutiveErrors >= 2) {
          note('batch loop aborted: consecutive reader failures — back to normal stepping');
          break;
        }
      }
    }
    if (filled > 0) progresslessSteps = 0;
    const skipped = queue.length - filled - missed;
    note(`batch loop finished: ${filled} filled, ${missed} not found${skipped ? `, ${skipped} not attempted` : ''}`);
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `⚙ Batch done — ${filled} filled, ${missed} not found${skipped ? `, ${skipped} skipped` : ''}. ${completeRowCount()} complete row(s) now.`,
    );
    await persist('running');
  };

  // ---- SWEEP EXECUTOR (harness-driven full-page collection, 2026-07-23) ----
  // A full-page collection sweep is a MECHANICAL loop — scroll exactly one
  // viewport, read the screen, repeat until the bottom — and per-turn model
  // decisions hand-cranking it wander (live 2026-07-23: scroll x3 skipped
  // whole letter sections, then the run oscillated hunting the holes it
  // created and died pacing at 86/119, then 101/119). The runtime owns the
  // loop: one vision-read call per screenful (same cost as a hand-cranked
  // collect, none of the wandering), harness-side dedupe via the existing
  // row store, bottom detection via the page signature. Read-only by design.
  // An open-ended collection: the objective wants everything ("full list",
  // "all", "every"…) and no numeric target bounds it. Shared by the scroll
  // clamp, the sweep takeover, and the done-time exhaustion gate.
  const openEndedGathering = (): boolean =>
    !schema?.target && /\b(all|every|full|complete|entire)\b/i.test(goalText);
  let sweepUsed = false;
  const runSweep = async (why: string): Promise<void> => {
    sweepUsed = true;
    note(`sweep started (${why}): reading the page one screenful at a time from the top`);
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `⚙ Sweep: reading the whole page screen by screen — ${why}.`,
    );
    // To the top: two max-size up-scrolls cover any page a sweep handles
    await runner.execStep({ do: 'scroll', direction: 'up', times: 10 }).catch(() => {});
    await runner.execStep({ do: 'scroll', direction: 'up', times: 10 }).catch(() => {});
    await sleep(800);
    let prevSig: string | null = null;
    let bottomHits = 0;
    let totalNew = 0;
    let readerFailures = 0;
    for (let screen = 1; screen <= SWEEP_MAX_SCREENS; screen++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (outOfTime()) {
        note('sweep stopped: time budget exhausted');
        break;
      }
      heartbeat(`Sweep: reading screen ${screen}…`);
      const obs = await observe();
      // Bottom detection: the page no longer changes when scrolled
      if (lastObservedSig !== null && lastObservedSig === prevSig) {
        bottomHits++;
        if (bottomHits >= 2) {
          note(`sweep reached the bottom after ${screen - 1} screen(s)`);
          break;
        }
      } else {
        bottomHits = 0;
      }
      prevSig = lastObservedSig;
      // ---- TEXT FIRST, VISION FALLBACK (2026-07-23, user decision) ----
      // The DOM text is lossless — a text read cannot misspell "Canva" —
      // and a screenful of text costs a fraction of a screenshot. Vision
      // (at grounder-grade resolution, since it only runs when needed) is
      // the fallback for screens whose text yields nothing: canvas pages,
      // markup the extractor can't line-up, or a text-parse failure.
      let items: Array<Record<string, unknown>> = [];
      let readVia = 'text';
      const viewText = await captureViewportText(currentTab).catch(() => '');
      if (viewText.trim().length >= 40) {
        try {
          const call = await collectFromText(
            { objective: goalText, columns: schema?.columns, pageText: viewText },
            signal,
            heartbeat,
          );
          track(call.usage);
          items = call.result.items;
          readerFailures = 0;
        } catch (error) {
          if (signal.aborted) throw error;
          note(
            `sweep screen ${screen}: text read failed (${(error instanceof Error ? error.message : String(error)).slice(0, 100)}) — falling back to vision`,
          );
        }
      }
      if (items.length === 0) {
        readVia = 'vision';
        const shot = await captureScreenshot(currentTab, SWEEP_SCREENSHOT_OPTS).catch(() => null);
        const shotUrl = shot?.dataUrl ?? obs.screenshot;
        if (!shotUrl) {
          note('sweep stopped: no text and no screenshot available for this screen');
          break;
        }
        try {
          const call = await collectFromScreenshot(
            { objective: goalText, columns: schema?.columns, screenshotDataUrl: shotUrl },
            signal,
            heartbeat,
          );
          track(call.usage);
          items = call.result.items;
          readerFailures = 0;
        } catch (error) {
          if (signal.aborted) throw error;
          readerFailures++;
          note(
            `sweep screen ${screen}: reader calls failed (${(error instanceof Error ? error.message : String(error)).slice(0, 100)}) — ${readerFailures >= 2 ? 'aborting the sweep' : 'continuing'}`,
          );
          if (readerFailures >= 2) break;
        }
      }
      let added = 0;
      let upgraded = 0;
      for (const item of items) {
        if (!item || typeof item !== 'object' || Object.keys(item).length === 0) continue;
        const outcome = schema
          ? upsertObjectItem(item)
          : addOrUpgrade(
              Object.values(item)
                .map(v => String(v ?? '').trim())
                .filter(Boolean)
                .join(' — '),
            );
        if (outcome === 'new') added++;
        else if (outcome === 'upgraded') upgraded++;
      }
      totalNew += added;
      if (added + upgraded > 0) progresslessSteps = 0;
      lastProgressMutations = collectionMutations;
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `⚙ Sweep screen ${screen}: +${added} new${upgraded ? `, ${upgraded} upgraded` : ''} (${collection.length} total) · ${readVia}`,
      );
      await runner.execStep({ do: 'scroll', direction: 'down' }).catch(() => {});
      await sleep(700);
    }
    const mergedDupes = mergeNearDuplicateRows();
    if (mergedDupes) note(`merged ${mergedDupes} near-duplicate row(s) (misread-name twins) after the sweep`);
    note(`sweep finished: ${totalNew} new item(s), collection now holds ${collection.length}`);
    postExecutionEvent(
      port,
      Actors.SYSTEM,
      'step.ok',
      taskId,
      `⚙ Sweep done — ${totalNew} new item(s), ${collection.length} total.`,
    );
    await persist('running');
  };

  // Guard memory — PERMANENT for the run (an intervening success must never
  // launder a failed action back into eligibility)
  const failedCounts = new Map<string, number>();
  const failedSideEffectContexts = new Set<string>();
  // Futility memory — cleared when a strategic review sets new orders
  const uncertainCounts = new Map<string, number>();
  // No-effect memory: actions that EXECUTED fine but measurably changed
  // nothing on the page (live 2026-07-22: "2026 Agenda" clicked 4×, every
  // click ✓, same page every time — no failure signal ever fired)
  const noEffectCounts = new Map<string, number>();
  const recentFingerprints: string[] = [];
  let consecutiveFailures = 0;
  let decidedAny = false;
  // "Done" plausibility gate (one-shot): a run that collected nothing and
  // changed nothing has no evidence to finish on — nudge once before
  // accepting (live failure 2026-07-20: 3 scrolls, zero collects, "objective
  // met", empty-handed report on a read-my-posts task)
  let doneNudged = false;
  // Done-audit budget: a stronger model vets each "done" against the ledger,
  // but a stubborn navigator must not loop declaring done forever — after
  // this many audits the run delivers (curate + honest report still apply)
  let doneAudits = 0;
  // Fingerprint of the most recent collect — an IDENTICAL record repeated
  // back-to-back is always a no-op and is rejected at decision time (live
  // 2026-07-22 run #10: every successful record was followed by 2-3 identical
  // re-records because the turn after a collect carried "LAST ACTION: none";
  // the no-ops tripped the pacing guard and killed the run). Cleared by any
  // non-collect execution.
  let lastCollectFp: string | null = null;
  let changedAnything = false;
  let outcome: 'ok' | 'fail' | null = null;
  let outcomeSummary = '';

  // The step awaiting judgment at the top of the next turn
  let lastAction: {
    stepNo: number;
    description: string;
    execNote: string;
    fingerprint: string;
    sideEffect: boolean;
    urlPath: string;
    // Page signature at decision time, set only for page-affecting steps —
    // compared against the next observation to detect no-effect actions
    pageSigBefore?: string | null;
  } | null = null;

  // ---- STRATEGIC REVIEW (the altitude the fast loop deliberately lacks) ----
  // The per-step navigator is myopic by design; when a stuck pattern fires,
  // one deep call (reasoning ON, full journal + screenshot) diagnoses the
  // root cause and sets an ACTIVE STRATEGY — standing orders pinned into
  // every subsequent turn until superseded. Bounded like everything else.
  let activeStrategy = '';
  let lastStrategyText = '';
  let reviewsUsed = 0;
  // Outcome-based review termination: what the collection looked like when
  // the last review fired, and how many consecutive reviews produced no
  // collection growth. Two consecutive fruitless strategies = a genuine
  // dead end; a run whose reviews keep unlocking new rows can review on.
  let mutationsAtLastReview = -1;
  let fruitlessReviews = 0;
  // Consecutive FAILED review calls (the call itself erroring, not a verdict)
  // — a failed call must not burn a budget slot, but it also must not loop:
  // the trigger condition persists, so two failures in a row end the run
  // honestly (live 2026-07-22: three silent call failures burned the whole
  // budget in 30s and the run died "out of strategies" after 6 steps)
  let reviewCallFailures = 0;
  // Built-in + user-defined playbooks, loaded once per run; a custom skill
  // sharing a built-in's name replaces it
  const skillSet = allSkills(await skillStore.getAll().catch(() => []));
  // Long-term memory (identity + learnings distilled from past runs), pinned
  // into the strategic tier — kickoff, reviews, report — like a playbook for
  // the user themself. Loaded once per run; rewritten after delivery.
  const agentMemory = await loadAgentMemory();

  // Arm the dialog guard on the initial tab (new tabs arm in navigateManaged)
  await armDialogGuard(tabId, onNativeDialog).catch(error => {
    // e.g. DevTools already open on the tab — run continues unguarded
    logger.warning('dialog guard unavailable:', error);
  });

  // ---- ADOPT CLICK-SPAWNED TABS ----
  // A click on a target="_blank" control (a "Visit Website" button, an
  // outbound directory link) opens a NEW tab — and the run, watching only
  // currentTab, would never see it (live failure 2026-07-22: the official
  // site the objective needed opened in a new tab; the run judged the click
  // a no-op and fell back to a slow per-company search loop). This listener
  // remembers a tab the run's own tabs opened; the loop adopts it as
  // currentTab before the next observation, so the agent follows the link
  // like a person would.
  let spawnedTabId: number | null = null;
  const onTabCreated = (tab: chrome.tabs.Tab): void => {
    const opener = tab.openerTabId;
    if (opener === undefined || tab.id === undefined) return;
    if (opener === currentTab || [...runTabs.values()].includes(opener)) {
      spawnedTabId = tab.id;
    }
  };
  chrome.tabs.onCreated.addListener(onTabCreated);
  // Which playbooks the navigator is currently reading — announced on change
  let lastSkillsKey = '';
  // Every playbook pinned at any point this run — gates the save-as-skill
  // offer (a run that just followed an existing skill teaches nothing new;
  // see finishOk) and tells the distiller what knowledge already exists
  const pinnedSkillNames = new Set<string>();
  const runReview = async (
    stuckSignal: string,
    observed: { digest?: string; screenshot?: string },
  ): Promise<'continue' | 'ended'> => {
    heartbeat(`Stepping back for a strategic review (#${reviewsUsed + 1})…`);
    let call;
    try {
      call = await strategicReview(
        {
          objective: goalText,
          journal,
          pageDigest: observed.digest,
          screenshotDataUrl: observed.screenshot,
          activeStrategy: activeStrategy || undefined,
          skills: renderSkills(applicableSkills(goalText, currentUrlPath, skillSet)) || undefined,
          skillCatalog:
            skillCatalog(skillSet, new Set(applicableSkills(goalText, currentUrlPath, skillSet).map(s => s.name))) ||
            undefined,
          memory: agentMemory,
          stuckSignal,
          timeRemainingMin: Math.max(0, Math.round((deadline - Date.now()) / 60_000)),
        },
        signal,
        heartbeat,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning('strategic review call failed:', error);
      reviewCallFailures++;
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 140);
      note(`a strategic review was attempted but the call failed (${detail}) — continuing without it`);
      // Failure must be VISIBLE (live 2026-07-22: three silent failures read
      // as "reviews happened" in the trace) and must not burn a budget slot
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `⚠️ Strategic review call failed (${detail}) — continuing under the current approach.`,
      );
      if (reviewCallFailures >= 2) {
        await report(
          'partial',
          `Strategic review calls kept failing (${detail}) — check the strategist/orchestrator model settings.`,
        );
        return 'ended';
      }
      return 'continue';
    }
    reviewCallFailures = 0;
    reviewsUsed++;
    // Outcome bookkeeping: did the PREVIOUS strategy period produce any
    // collection growth? Measured in code, not judged.
    if (mutationsAtLastReview >= 0 && collectionMutations === mutationsAtLastReview) fruitlessReviews++;
    else fruitlessReviews = 0;
    mutationsAtLastReview = collectionMutations;
    const meta = track(call.usage);
    const review = call.result;
    logger.info('review:', JSON.stringify(review).slice(0, 400));
    if (review.verdict === 'done') {
      note(`strategic review: objective already delivered — ${(review.diagnosis ?? '').slice(0, 160)}`);
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `🧭 Review: objective already delivered — ${review.diagnosis ?? ''}`,
        meta,
      );
      await report('achieved', '');
      return 'ended';
    }
    if (review.verdict === 'blocked') {
      // Blocked on a verification wall = handoff to the user, not the end
      if (
        captchaWait &&
        CAPTCHA_MARKERS.test(`${review.reason ?? ''} ${review.diagnosis ?? ''}`) &&
        verificationWaits < MAX_VERIFICATION_WAITS &&
        !outOfTime()
      ) {
        const waited = await awaitHumanVerification('a strategic review found a verification wall');
        if (waited === 'cleared') {
          await persist('running');
          return 'continue';
        }
      }
      note(`strategic review: blocked — ${(review.reason ?? review.diagnosis ?? '').slice(0, 200)}`);
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `🧭 Review: blocked — ${review.reason ?? review.diagnosis ?? ''}`,
        meta,
      );
      await report('partial', `Blocked: ${review.reason ?? 'the strategist found no route around the obstacle'}`);
      return 'ended';
    }
    const strategy = (review.strategy ?? '').trim();
    if (!strategy || strategy === lastStrategyText) {
      // The strategist has no better idea than last time — stop honestly
      note('strategic review produced no new strategy — stopping');
      await report('partial', 'A strategic review could not find a different viable approach.');
      return 'ended';
    }
    lastStrategyText = strategy;
    activeStrategy = strategy;
    // Fresh start under new orders
    consecutiveFailures = 0;
    rejections = 0;
    progresslessSteps = 0;
    uncertainCounts.clear();
    recentFingerprints.length = 0;
    note(
      `STRATEGIC REVIEW (${stuckSignal.slice(0, 80)}): ${(review.diagnosis ?? '').slice(0, 140)} → new strategy in force`,
    );
    postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `🧭 Strategy: ${strategy}`, meta);
    await persist('running');
    // The eraser: the strategist names rows that do not belong and the
    // runtime deletes them (live 2026-07-22 run #12: two reviews ordered
    // "clear the incorrect rows" and no such operation existed — 62 junk
    // rows stayed load-bearing to the end)
    if (schema && Array.isArray(review.dropRows) && review.dropRows.length) {
      const dropKeys = new Set(review.dropRows.map(name => rowKeyOf(String(name))).filter(Boolean));
      const before = rows.length;
      const kept = rows.filter(row => !dropKeys.has(rowKeyOf(row[schema!.columns[0]] ?? '')));
      if (kept.length < before) {
        rows.length = 0;
        rows.push(...kept);
        rowIndex.clear();
        rows.forEach((row, i) => rowIndex.set(rowKeyOf(row[schema!.columns[0]] ?? ''), i));
        rebuildCollectionView();
        note(`strategist dropped ${before - kept.length} off-target row(s) — ${kept.length} remain`);
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `🧹 Dropped ${before - kept.length} off-target row(s) — ${kept.length} remain.`,
        );
        await persist('running');
      }
    }
    // Strategist codified a per-row lookup — execute it mechanically now;
    // the navigator resumes afterwards with the table already fuller
    if (review.batchLoop) {
      try {
        await runBatchLoop(review.batchLoop);
      } catch (error) {
        if (signal.aborted) throw error;
        logger.warning('batch loop failed:', error);
        note('the batch loop hit an unexpected error — continuing with normal stepping');
      }
    }
    return 'continue';
  };

  // A stuck/futility signal demands escalation: a strategic review while
  // strategies are still producing outcomes, an honest stop once they are
  // not. Termination is OUTCOME-BASED: a dead end is the previous review
  // having produced zero collection growth AND nothing having grown since
  // the latest one either — two consecutive fruitless strategies. The fixed
  // budget this replaces killed a run mid-harvest at 75/119 (2026-07-23).
  let postReviewGraces = 0;
  const escalate = async (
    stuckSignal: string,
    observed: { digest?: string; screenshot?: string },
  ): Promise<'continue' | 'ended'> => {
    const deadEnd =
      fruitlessReviews >= 1 && mutationsAtLastReview >= 0 && collectionMutations === mutationsAtLastReview;
    if (!deadEnd && reviewsUsed < MAX_REVIEWS) return runReview(stuckSignal, observed);
    // Dead end (or backstop), but the run is measurably still delivering
    // (collection grew within the last few steps): a local stumble is not
    // "stuck" — keep going, bounded. Each grace also RESETS the pacing
    // window so the signal that fired cannot re-fire as its own echo and
    // burn the remaining graces in consecutive turns (live 2026-07-23:
    // three graces consumed in three turns by one pacing signal).
    if (progresslessSteps < GRACE_PROGRESS_WINDOW && postReviewGraces < MAX_POST_REVIEW_GRACES) {
      postReviewGraces++;
      recentFingerprints.length = 0;
      note(
        `stuck signal at a strategy dead end (${stuckSignal.slice(0, 120)}) — but the collection grew within the last ${GRACE_PROGRESS_WINDOW} steps, so the run continues (grace ${postReviewGraces}/${MAX_POST_REVIEW_GRACES}): avoid the failing action and keep doing what was working.`,
      );
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `🧭 Strategies look exhausted, but progress is still landing — pressing on around the obstacle (${postReviewGraces}/${MAX_POST_REVIEW_GRACES}).`,
      );
      return 'continue';
    }
    const why = deadEnd
      ? `the last two strategic reviews produced no new progress`
      : `${reviewsUsed} strategic reviews were spent (runaway backstop)`;
    note(`stuck again and ${why}: ${stuckSignal.slice(0, 160)}`);
    postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `🧭 Out of strategies — ${stuckSignal}`);
    await report('partial', `Out of strategies: ${why}, and the run is stuck again (${stuckSignal.slice(0, 160)}).`);
    outcomeSummary = 'out of strategies';
    return 'ended';
  };

  try {
    // ---- KICKOFF (strategic review #0) ----
    // Interpret the INTENT before the first literal-minded step (live
    // failure 2026-07-20: "decision makers" typed verbatim into a search
    // box; the insight arrived 14 steps later via a stuck-triggered review).
    // One reasoning call: strategy -> pinned as the opening ACTIVE STRATEGY;
    // proceed -> trivial/conversational, straight to the loop; clarify ->
    // ask the user and end the turn (the reply resumes via the clarify path
    // above, which re-runs kickoff with asking disabled). Does not consume
    // the reactive review budget. Skipped on stalled continuations — the
    // seeded journal already carries the run's thinking.
    if (!resumedContinuation) {
      heartbeat('Reading the task — working out the intent and an approach…');
      try {
        const applicable = applicableSkills(goalText, currentUrlPath, skillSet);
        const call = await kickoffStrategy(
          {
            objective: goalText,
            currentPage: userPage ? `"${userPage.title}" — ${userPage.url}` : undefined,
            skills: renderSkills(applicable) || undefined,
            skillCatalog: skillCatalog(skillSet, new Set(applicable.map(s => s.name))) || undefined,
            memory: agentMemory,
            timeBudgetMin: Math.round(MAX_TASK_MS / 60_000),
            noClarify: resumedAfterClarify || resumedSteering,
          },
          signal,
          heartbeat,
        );
        const meta = track(call.usage);
        const kick = call.result;
        // Tabular deliverable declared -> schema mode: the runtime owns the
        // table from here (rows, completeness, done gating)
        const declared = (kick.deliverable?.columns ?? [])
          .map(col => String(col).toLowerCase().trim())
          .filter(Boolean)
          .slice(0, 8);
        if (declared.length >= 2) {
          const rawTarget = kick.deliverable?.target;
          const proposed =
            Number.isFinite(rawTarget) && (rawTarget as number) > 0
              ? Math.min(Math.floor(rawTarget as number), 200)
              : undefined;
          // Invented-target guard: an open-ended objective completes at
          // source exhaustion, never at a round number the model made up
          const target = proposed && objectiveNamesCount(goalText, proposed) ? proposed : undefined;
          if (proposed && !target) {
            note(
              `kickoff proposed a target of ${proposed} rows, but the objective names no such count — target DROPPED: this is an open-ended collection, complete only when the source runs dry`,
            );
          }
          schema = { columns: declared, target };
          note(
            `deliverable table defined: columns [${schema.columns.join(', ')}]${schema.target ? `, target ${schema.target} complete rows` : ''}`,
          );
        }
        if (kick.verdict === 'clarify' && kick.questions?.length) {
          const questions = kick.questions.slice(0, 3);
          pendingQuestions = questions;
          record.outcome = 'ok';
          record.answer = questions.join('\n');
          await persist('awaiting_clarification');
          postExecutionEvent(
            port,
            Actors.ASSISTANT,
            'task.ok',
            taskId,
            `Before I start, a couple of things so I get this right:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
            meta,
          );
          return;
        }
        const strategy = (kick.strategy ?? '').trim();
        if (kick.verdict === 'strategy' && strategy) {
          activeStrategy = strategy;
          // Same-text rule as reviews: a later review merely echoing the
          // kickoff has no new idea and ends the run honestly
          lastStrategyText = strategy;
          note(`KICKOFF strategy: ${strategy.slice(0, 200)}`);
          postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `🧭 Approach: ${strategy}`, meta);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        logger.warning('kickoff call failed:', error);
        note('the kickoff strategy call failed — starting without an opening strategy');
      }
    }

    heartbeat('Looking at the page and deciding the first step…');
    while (stepsUsed < MAX_STEPS) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (outOfTime()) {
        await report('partial', `Time budget (${Math.round(MAX_TASK_MS / 60000)} min) exhausted.`);
        outcome = 'fail';
        outcomeSummary = 'time budget exhausted';
        return;
      }

      // ---- ADOPT A CLICK-SPAWNED TAB ----
      // The previous step's click opened a new tab (target="_blank"). Follow
      // it: make it currentTab so this turn observes the page the click meant
      // to open, not the tab left behind.
      if (spawnedTabId !== null) {
        const spawned = spawnedTabId;
        spawnedTabId = null;
        const alive = spawned !== currentTab ? await chrome.tabs.get(spawned).catch(() => null) : null;
        if (alive) {
          currentTab = spawned;
          rebindSessionTab(taskId, spawned);
          await chrome.tabs.update(spawned, { active: true }).catch(() => {});
          await armDialogGuard(spawned, onNativeDialog).catch(() => {});
          note(`the last click opened a new tab — following it (${(alive.url ?? '').slice(0, 80)})`);
        }
      }

      // ---- OBSERVE + JUDGE + DECIDE (one multimodal call) ----
      if (decidedAny || lastAction) {
        heartbeat('Looking at the result and deciding the next step…');
      }
      const observed = await observe();

      // ---- NO-EFFECT DETECTION (measured, not judged) ----
      // The executor said ✓, but the page is byte-identical to before the
      // action: tell the judge as a runtime FACT so a "worked but did
      // nothing" click cannot be graded a success four times in a row
      if (lastAction?.pageSigBefore && lastObservedSig) {
        if (lastAction.pageSigBefore === lastObservedSig) {
          const repeats = (noEffectCounts.get(lastAction.fingerprint) ?? 0) + 1;
          noEffectCounts.set(lastAction.fingerprint, repeats);
          lastAction.execNote +=
            ' — RUNTIME MEASUREMENT: the page did NOT change after this action (same URL, scroll position, and content)' +
            (repeats >= 2
              ? `; this exact action has now executed ${repeats} times without changing anything — it is a dead end, take a DIFFERENT control or route`
              : '');
          note(
            `no-effect action (${repeats}×): ${lastAction.description.slice(0, 80)} executed but the page did not change`,
          );
        } else {
          noEffectCounts.delete(lastAction.fingerprint);
        }
      }

      // ---- ZERO-PROGRESS FUTILITY (outcome-level stuckness) ----
      // Reaching a genuinely new site counts as progress; a threshold of
      // outcome-free steps escalates even when every one was judged ✓
      const hostNow = currentUrlPath.split('/')[0];
      if (hostNow && !visitedHosts.has(hostNow)) {
        visitedHosts.add(hostNow);
        progresslessSteps = 0;
      }
      // ---- BATCH OPPORTUNITY (deterministic, once per run) ----
      // Several rows missing the SAME column is the codifiable shape: give
      // the strategist ONE chance to emit a batchLoop instead of letting the
      // navigator hand-crank the lookups (~4 multimodal calls per row)
      if (schema && !batchOpportunityTried && rows.length >= 4 && reviewsUsed < MAX_REVIEWS && !outOfTime()) {
        const missingByCol = new Map<string, number>();
        for (const row of rows) {
          for (const col of schema.columns.slice(1)) {
            if (!(row[col] ?? '').trim()) missingByCol.set(col, (missingByCol.get(col) ?? 0) + 1);
          }
        }
        const best = [...missingByCol.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1])[0];
        if (best) {
          batchOpportunityTried = true;
          note(`batch opportunity detected: ${best[1]} rows are missing "${best[0]}"`);
          const outcomeOfReview = await escalate(
            `BATCH OPPORTUNITY: ${best[1]} rows in the deliverable table are missing the "${best[0]}" column and nothing else about them varies — if one uniform read-only per-row lookup can fill it, reply verdict "strategy" WITH a batchLoop (see the batchLoop rules); otherwise chart the best route without one`,
            observed,
          );
          if (outcomeOfReview === 'ended') {
            outcome = record.outcome === 'ok' ? 'ok' : 'fail';
            outcomeSummary = outcomeSummary || 'ended by strategic review';
            return;
          }
          continue;
        }
      }

      if (progresslessSteps >= PROGRESSLESS_STEPS && !outOfTime()) {
        note(
          `${progresslessSteps} consecutive steps executed without a new collection item, a change to the page, or a new site — the run is circling even though individual steps succeed`,
        );
        progresslessSteps = 0;
        const outcomeOfReview = await escalate(
          `${PROGRESSLESS_STEPS} consecutive steps executed without gaining any new data, changing anything, or reaching a new site — every step "succeeds" but the run is not converging on the objective`,
          observed,
        );
        if (outcomeOfReview === 'ended') {
          outcome = record.outcome === 'ok' ? 'ok' : 'fail';
          outcomeSummary = outcomeSummary || 'ended by strategic review';
          return;
        }
        continue;
      }

      // ---- SENSITIVE-SITE POLICY: ask before working where it matters ----
      // Screenshots of this page would go to the cloud model; on a site from
      // the user's sensitive list, that needs their explicit go-ahead once
      // per task. Resuming IS the approval.
      const sensitiveHit = sensitivePatterns.find(pattern => currentUrlPath.toLowerCase().includes(pattern));
      const currentHost = currentUrlPath.split('/')[0];
      if (sensitiveHit && currentHost && !approvedHosts.has(currentHost)) {
        pendingApprovalHost = currentHost;
        note(`paused on ${currentHost} — matches the sensitive-site list ("${sensitiveHit}"), awaiting user approval`);
        record.outcome = 'ok';
        record.answer = `sensitive-site approval requested: ${currentHost}`;
        await persist('stalled');
        postExecutionEvent(
          port,
          Actors.ASSISTANT,
          'task.ok',
          taskId,
          `⚠️ This task is on **${currentHost}**, which matches your sensitive-site list ("${sensitiveHit}"). Continuing will send screenshots of this page to the cloud model (no-retention routing, but they do leave your machine).\n\nReply "continue" to proceed — that approves ${currentHost} for this task — or give me a different task to stop here.`,
        );
        outcome = 'ok';
        outcomeSummary = 'awaiting sensitive-site approval';
        return;
      }

      // Surface playbook activation in the trace + journal whenever the set
      // changes — the trigger is deterministic (host/path substring or
      // objective match, in code), so the trace can state it as fact
      const activeSkills = applicableSkills(goalText, currentUrlPath, skillSet);
      const skillsKey = activeSkills.map(skill => skill.name).join(', ');
      if (skillsKey !== lastSkillsKey) {
        lastSkillsKey = skillsKey;
        if (skillsKey) {
          for (const skill of activeSkills) pinnedSkillNames.add(skill.name);
          note(`site playbooks in force: ${skillsKey}`);
          postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `📘 Site playbooks in force: ${skillsKey}`);
        }
      }

      // RUN TABS context — only once a second site is open (single-tab runs
      // stay exactly as before, no prompt noise)
      let openTabsLines: string | undefined;
      const distinctRunTabs = [...new Map([...runTabs.entries()].map(([key, id]) => [id, key])).entries()];
      if (distinctRunTabs.length > 1) {
        const lines = await Promise.all(
          distinctRunTabs.map(async ([id, key]) => {
            const tab = await chrome.tabs.get(id).catch(() => null);
            if (!tab) return null;
            const marker = id === currentTab ? ' ← YOU ARE HERE' : '';
            return `- ${key}: ${(tab.url ?? '').slice(0, 120)} — "${(tab.title ?? '').slice(0, 60)}"${marker}`;
          }),
        );
        openTabsLines = lines.filter(Boolean).join('\n') || undefined;
      }

      let call;
      try {
        call = await nextStep(
          {
            objective: goalText,
            journal,
            pageDigest: observed.digest,
            lastAction: lastAction ? { description: lastAction.description, execNote: lastAction.execNote } : null,
            stepsUsed,
            maxSteps: MAX_STEPS,
            timeRemainingMin: Math.max(0, Math.round((deadline - Date.now()) / 60_000)),
            activeStrategy: activeStrategy || undefined,
            skills: renderSkills(activeSkills) || undefined,
            skillCatalog: skillCatalog(skillSet, new Set(activeSkills.map(s => s.name))) || undefined,
            openTabs: openTabsLines,
            // Schema mode: the computed table status replaces the raw ledger
            deliverable: renderDeliverableStatus(),
            // FULL ledger, not a tail: the last-6 window made the navigator
            // lose track of what it already held during per-item enrichment
            // (live 2026-07-22 run #5: re-verified one company 3×, invented
            // candidates never on the list — ~8 wasted steps). Compact lines,
            // capped; the cap note keeps the model honest about omissions.
            collectedSample: collection.length
              ? collection
                  .slice(-COLLECTION_LEDGER_ITEMS)
                  .map(item => `- ${item.slice(0, 160)}`)
                  .join('\n') +
                (collection.length > COLLECTION_LEDGER_ITEMS
                  ? `\n(…and ${collection.length - COLLECTION_LEDGER_ITEMS} earlier item(s) not shown — the journal's running totals cover them)`
                  : '')
              : undefined,
            screenshotDataUrl: observed.screenshot,
          },
          signal,
          heartbeat,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        logger.warning('nextStep call failed:', message);
        // A misfired call is not a reasoned cause of death — retake the turn
        // (fresh observe + decide), bounded by the same rejection cap
        rejections++;
        note(`navigator call failed (${message.slice(0, 120)}) — retaking the turn`);
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', `Navigator calls kept failing: ${message.slice(0, 200)}`);
          outcome = 'fail';
          outcomeSummary = 'navigator call failures';
          return;
        }
        heartbeat('That decision call failed — retaking the turn…');
        continue;
      }
      const decideMeta = track(call.usage);
      const decision = call.result;
      logger.info('decision:', JSON.stringify(decision).slice(0, 500));

      // ---- BOOK THE JUDGMENT of the previous step ----
      // Shown in full in the trace (debugging value); journal note() caps its
      // own lines for the model's context budget
      const assessment = decision.assessment ?? '';
      if (lastAction) {
        const verdict = decision.last_action ?? 'uncertain';
        const mark = verdict === 'succeeded' ? '✓' : verdict === 'failed' ? '✗' : '⚠';
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Step ${lastAction.stepNo} ${mark} — ${assessment || verdict}`,
          '👁 judged (same call as the next decision — cost shown there)',
        );
        note(`judge on step ${lastAction.stepNo} (${lastAction.description.slice(0, 80)}): ${verdict} — ${assessment}`);
        let stuckSignal: string | null = null;
        if (verdict === 'failed') {
          consecutiveFailures++;
          const fpFailures = (failedCounts.get(lastAction.fingerprint) ?? 0) + 1;
          failedCounts.set(lastAction.fingerprint, fpFailures);
          if (fpFailures >= 2) {
            stuckSignal = `the same action has now been judged failed ${fpFailures} times: ${lastAction.description.slice(0, 100)}`;
          } else if (consecutiveFailures >= REVIEW_AFTER_CONSECUTIVE_FAILURES) {
            stuckSignal = `${consecutiveFailures} consecutive steps were judged failed`;
          }
        } else if (verdict === 'succeeded') {
          consecutiveFailures = 0;
        } else if (verdict === 'uncertain') {
          // "Uncertain" repeated on the SAME action is stuckness too — six
          // identical no-visible-effect clicks once went undetected because
          // only failures counted
          const n = (uncertainCounts.get(lastAction.fingerprint) ?? 0) + 1;
          uncertainCounts.set(lastAction.fingerprint, n);
          if (n >= UNCERTAIN_REPEATS) {
            stuckSignal = `the same action has been judged uncertain (no visible effect) ${n} times: ${lastAction.description.slice(0, 100)}`;
          }
        }
        // Failed OR uncertain side effects may have landed — same-page
        // re-issue is off the table for the rest of the run
        if (lastAction.sideEffect && verdict !== 'succeeded') {
          failedSideEffectContexts.add(`${lastAction.fingerprint}@${lastAction.urlPath}`);
        }
        lastAction = null;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await report('partial', `${MAX_CONSECUTIVE_FAILURES} consecutive steps failed — not converging.`);
          outcome = 'fail';
          outcomeSummary = 'consecutive failures';
          return;
        }
        await persist('running');
        if (stuckSignal && !outOfTime()) {
          const outcomeOfReview = await escalate(stuckSignal, observed);
          if (outcomeOfReview === 'ended') {
            outcome = record.outcome === 'ok' ? 'ok' : 'fail';
            outcomeSummary = outcomeSummary || 'ended by strategic review';
            return;
          }
          // Re-decide from a fresh observation under the new strategy —
          // this turn's decision predates the strategy
          continue;
        }
      } else if (assessment) {
        note(`observed: ${assessment}`);
      }

      // Navigator flagged itself as circling — escalate before acting on a
      // decision that is likely part of the circle
      if (decision.decision === 'step' && decision.stuck && !outOfTime()) {
        note('the navigator flagged that it is circling without progress');
        const outcomeOfReview = await escalate(
          'the navigator itself flagged that it is circling without making progress',
          observed,
        );
        if (outcomeOfReview === 'ended') {
          outcome = record.outcome === 'ok' ? 'ok' : 'fail';
          outcomeSummary = outcomeSummary || 'ended by strategic review';
          return;
        }
        continue;
      }

      // ---- ACT ON THE DECISION ----
      if (decision.decision === 'chat' && !decidedAny) {
        record.mode = 'chat';
        try {
          const { text, usage } = await streamCloudChatReply(port, taskId, task, signal);
          finishOk(text || '', usage ? track(usage) : decideMeta);
        } catch (error) {
          if (signal.aborted) throw error;
          logger.warning('chat stream failed:', error);
          finishFail('The chat reply failed to stream.', decideMeta);
        }
        await runStateStore.clearRun(taskId).catch(() => {});
        return;
      }

      if (decision.decision === 'clarify' && decision.questions?.length && !decidedAny) {
        const questions = decision.questions.slice(0, 3);
        pendingQuestions = questions;
        record.outcome = 'ok';
        record.answer = questions.join('\n');
        await persist('awaiting_clarification');
        postExecutionEvent(
          port,
          Actors.ASSISTANT,
          'task.ok',
          taskId,
          `Before I start, a couple of things so I get this right:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
          decideMeta,
        );
        return;
      }

      if (decision.decision === 'stop') {
        // A stop over a verification wall is a HANDOFF, not a death: with
        // captchaBehavior 'wait' the user clears it and the run resumes
        if (
          captchaWait &&
          CAPTCHA_MARKERS.test(`${decision.reason ?? ''} ${assessment}`) &&
          verificationWaits < MAX_VERIFICATION_WAITS &&
          !outOfTime()
        ) {
          note(`navigator hit a verification wall: ${(decision.reason ?? '').slice(0, 120)} — handing it to the user`);
          const waited = await awaitHumanVerification('the navigator stopped on a verification challenge');
          if (waited === 'cleared') continue;
          await stallOnVerification(
            '⏳ The verification challenge is still up. Complete it in the agent window, then reply "continue" and I\'ll pick up where I left off.',
          );
          outcome = 'ok';
          outcomeSummary = 'awaiting human verification';
          return;
        }
        note(`navigator stopped: ${decision.reason ?? 'no reason given'}`);
        await report('partial', `Stopped: ${decision.reason ?? 'the navigator stopped the run'}`);
        outcome = 'fail';
        outcomeSummary = `stopped: ${decision.reason ?? ''}`;
        return;
      }

      if (decision.decision === 'done') {
        // Plausibility gate, one nudge only (a legitimate nav-only or
        // already-satisfied objective just re-declares and passes)
        if (!doneNudged && collection.length === 0 && !changedAnything) {
          doneNudged = true;
          note(
            stepsUsed === 0
              ? 'done not accepted yet: NO step has executed this run — nothing was performed. If the current page already satisfies the objective, declare done again citing the visible evidence; otherwise decide the step that does the work.'
              : 'done not accepted yet: nothing was collected and nothing was changed this run. A reading/analysis objective is delivered by collected data — record the content via collect, then finish. If the objective truly needed no data, declare done again and it will be accepted.',
          );
          heartbeat('Checking that claim of completion against the evidence…');
          continue;
        }
        // ---- CURATE BEFORE THE GATES ----
        // The completeness gates must count VETTED rows: recording is greedy
        // (a keyword SERP mixes wrong roles/cities in), so an unvetted count
        // can satisfy the target on junk that the pre-report curation then
        // silently drops AFTER the done decision, delivering a shortfall with
        // budget left (live 2026-07-22: LinkedIn run collected 15, curation
        // kept 4, run finalized at 4 with no way back).
        let curationDropped = 0;
        if (!outOfTime()) {
          try {
            curationDropped = await curateBeforeWrite();
          } catch (error) {
            if (signal.aborted) throw error;
            logger.warning('done-time curation failed:', error);
          }
        }
        // ---- EXHAUSTION SWEEP (code-verified, 2026-07-23) ----
        // On an open-ended collection ("full list", no numeric target),
        // "the source is exhausted" must be MEASURED, never self-certified:
        // the navigator judged a single x3-jump pass as "fully traversed"
        // and delivered 52 of a page that renders ~101 (live 2026-07-23
        // 14:26 — the weak-harvest sweep trigger never fired because the
        // run hand-cranked with scroll+collect and no harvest ever ran).
        // Before done is accepted, the runtime sweeps the current page once,
        // screen by screen; only a sweep that adds nothing confirms
        // exhaustion. A sweep that finds missed data rejects the done.
        if (openEndedGathering() && collection.length > 0 && !sweepUsed && !outOfTime()) {
          note(
            'done declared on an open-ended collection, but exhaustion is not yet verified — sweeping the page screen-by-screen to confirm nothing was missed',
          );
          const mutationsBeforeSweep = collectionMutations;
          try {
            await runSweep('verifying the source is exhausted before finishing');
          } catch (error) {
            if (signal.aborted) throw error;
            logger.warning('exhaustion sweep failed:', error);
            note('the exhaustion sweep hit an error — proceeding with the done claim as-is');
          }
          if (collectionMutations > mutationsBeforeSweep) {
            note(
              'done rejected by the runtime: the verification sweep found items the manual pass missed — the source was NOT exhausted. Review the updated table and finish, or keep collecting if the sweep shows more remains.',
            );
            postExecutionEvent(
              port,
              Actors.SYSTEM,
              'step.ok',
              taskId,
              `↩︎ Not done — the verification sweep found items the manual pass had missed (${collection.length} total now).`,
            );
            await persist('running');
            continue;
          }
          note('exhaustion verified: the sweep added nothing new — the source is genuinely exhausted');
        }
        // ---- SCHEMA DONE-GATE (deterministic, replaces the LLM audit) ----
        // With a declared table + target, completeness is COMPUTED: no model
        // opinion involved, no vague "several verified" to slip through.
        if (schema?.target && doneAudits < MAX_DONE_AUDITS && !outOfTime()) {
          const complete = completeRowCount();
          if (complete < schema.target) {
            doneAudits++;
            const missingSummary = rows
              .filter(row => !rowComplete(row))
              .slice(0, 8)
              .map(
                row =>
                  `${row[schema!.columns[0]] ?? '?'} (missing ${schema!.columns.filter(col => !(row[col] ?? '').trim()).join(', ')})`,
              )
              .join('; ');
            const droppedNote = curationDropped
              ? `A quality pass dropped ${curationDropped} recorded row(s) that did not genuinely match the objective (wrong role, wrong location, off-topic) — only rows satisfying EVERY stated qualifier count toward the target, so record only genuine matches from here on. `
              : '';
            note(`done rejected by the runtime: ${complete}/${schema.target} rows complete. ${droppedNote}${missingSummary}`);
            activeStrategy = `${droppedNote}The deliverable table is incomplete: ${complete}/${schema.target} rows complete. Fill the missing cells (one direct lookup per row), or find new qualifying rows if some cannot be completed. Incomplete: ${missingSummary}`;
            postExecutionEvent(
              port,
              Actors.SYSTEM,
              'step.ok',
              taskId,
              `↩︎ Not done — ${complete}/${schema.target} rows complete. ${missingSummary ? `Missing: ${missingSummary}` : ''}`,
            );
            await persist('running');
            continue;
          }
          note(`done gate: ${complete}/${schema.target} rows complete — accepted`);
        }
        // ---- DONE AUDIT: supervisor sign-off against the full ledger ----
        // A stronger model checks the completion claim before the run
        // delivers (live 2026-07-22: navigator declared done with 2 of 10
        // required websites present). Only for NON-schema runs (the schema
        // gate above is deterministic and authoritative when active); only
        // when there IS a ledger to check, bounded, never past the clock.
        if (!schema?.target && collection.length > 0 && doneAudits < MAX_DONE_AUDITS && !outOfTime()) {
          doneAudits++;
          heartbeat('Double-checking the collected data against the objective before finishing…');
          try {
            const audit = await auditDone(goalText, collection.slice(), signal, heartbeat);
            track(audit.usage);
            if (!audit.result.complete && audit.result.reason) {
              note(`done audit: NOT complete — ${audit.result.reason}`);
              activeStrategy = `The objective is not yet complete: ${audit.result.reason}`;
              postExecutionEvent(
                port,
                Actors.SYSTEM,
                'step.ok',
                taskId,
                `↩︎ Not done yet — ${audit.result.reason}`,
              );
              await persist('running');
              continue;
            }
            note('done audit: the collected data satisfies the objective');
          } catch (error) {
            if (signal.aborted) throw error;
            // The audit is a safeguard, not a gate — its failure never blocks
            // an otherwise-complete delivery
            logger.warning('done audit call failed:', error);
          }
        }
        note(`navigator declared done: ${assessment || '(no evidence stated)'}`);
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Objective judged complete — ${assessment}`,
          decideMeta,
        );
        // Honest status: a run that exhausted its done-gate budget still below
        // a declared target delivers as PARTIAL (resumable), never "achieved"
        const shortfall = schema?.target ? Math.max(0, schema.target - completeRowCount()) : 0;
        await report(
          shortfall ? 'partial' : 'achieved',
          shortfall ? `Delivered ${completeRowCount()} of the ${schema!.target} requested item(s).` : '',
        );
        outcome = 'ok';
        outcomeSummary = shortfall ? `objective partially met (${completeRowCount()}/${schema!.target})` : 'objective met';
        return;
      }

      // ---- decision === 'step' ----
      let step = decision.step;
      if (!step) {
        rejections++;
        note('navigator replied "step" with no step object — reply with a valid step');
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', 'The navigator kept returning invalid steps.');
          outcome = 'fail';
          outcomeSummary = 'invalid steps';
          return;
        }
        continue;
      }
      decidedAny = true;

      const fault = stepFaultReason(step);
      if (fault) {
        rejections++;
        note(`step rejected by the runtime: ${fault}`);
        postExecutionEvent(port, Actors.SYSTEM, 'step.ok', taskId, `Refining the step (${fault})`, decideMeta);
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', `The navigator could not produce a valid step: ${fault}`);
          outcome = 'fail';
          outcomeSummary = 'invalid steps';
          return;
        }
        continue;
      }

      // ---- CAPTCHA GUARD (safety in code, not prompts) ----
      // The navigator is never allowed to click a verification control, no
      // matter what it decided (live 2026-07-21: it clicked Cloudflare's
      // checkbox despite the prompt rule). Hand the challenge to the user.
      if (step.do === 'click' && CAPTCHA_MARKERS.test(step.target ?? '')) {
        note(
          'step blocked by the runtime: human-verification controls are never clicked by the agent — the check exists to be answered by a person. Do not attempt it again.',
        );
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          '🛑 Blocked a click on a human-verification control — the agent never answers those itself.',
          decideMeta,
        );
        if (captchaWait && verificationWaits < MAX_VERIFICATION_WAITS && !outOfTime()) {
          const waited = await awaitHumanVerification('the navigator tried to click the verification control');
          if (waited === 'cleared') continue;
        }
        await stallOnVerification(
          captchaWait
            ? '⏳ The verification challenge is still up. Complete it in the agent window, then reply "continue" and I\'ll pick up where I left off.'
            : '🧍 This site is asking for human verification, and your settings say to stop here rather than wait. Complete it in the agent window and reply "continue" to resume, or give me a different task.',
        );
        outcome = 'ok';
        outcomeSummary = 'awaiting human verification';
        return;
      }

      // Collected data must be WRITTEN via textFrom:"collected" — a
      // multi-line type step that retypes collected items by hand carries
      // only the rows visible in the truncated journal and drops the rest
      if ((step.do === 'type' || step.do === 'type_focused') && step.textFrom !== 'collected') {
        const transcribed = transcribedCollectionLines(step.text, collectionKeys);
        if (transcribed >= 2) {
          rejections++;
          note(
            `step rejected: ${transcribed} of the typed line(s) retype collected items from the journal digest — the digest is truncated, so a hand-typed write silently drops the rest of the ${collection.length}-item collection. Re-issue the write with "textFrom":"collected" (put only the header line in "text"); the runtime inserts every collected item verbatim.`,
          );
          if (rejections >= MAX_REJECTIONS) {
            await report(
              'partial',
              'The navigator kept hand-typing collected data instead of using textFrom:"collected".',
            );
            outcome = 'fail';
            outcomeSummary = 'hand-typed collection write blocked';
            return;
          }
          continue;
        }
      }

      // ---- FULL-LIST READS MUST HARVEST (gate in code, not prompts) ----
      // A one-shot extract reads a capped slice of the page text; on a
      // "full list" objective that made 4-of-150 look complete (live
      // 2026-07-22: SaaStr speaker list — the whole grid sat below the char
      // cap and the run pivoted away). While the collection is still being
      // GATHERED, the runtime upgrades extract → harvest (scroll + re-read +
      // dedupe until rounds run dry) so a gathering read can only stop at
      // saturation, never at the cap. Enrichment reads (rows already named,
      // filling cells) keep plain extract.
      if (step.do === 'extract' && step.query) {
        const namesFilled = schema
          ? rows.filter(row => (row[schema!.columns[0]] ?? '').trim()).length
          : collection.length;
        const wantsEverything = /\b(all|every|full|complete|entire)\b/i.test(goalText);
        const stillGathering = schema?.target ? namesFilled < schema.target : wantsEverything && namesFilled === 0;
        if (stillGathering) {
          const until = schema?.target ? Math.max(schema.target - namesFilled, 10) : 30;
          step = { ...step, do: 'harvest', until, maxScrolls: 12 };
          note(
            `runtime upgraded the extract to a harvest (until ${until} items): the objective needs a complete collection, and a one-shot extract reads only a capped slice of the page — harvest scrolls and re-reads until no new items appear.`,
          );
          postExecutionEvent(
            port,
            Actors.SYSTEM,
            'step.ok',
            taskId,
            '⚙ Upgraded extract → harvest: full-list objectives must read until the page runs dry, not once.',
            decideMeta,
          );
        }
      }

      // ---- SCROLL CLAMP (open-ended gathering, 2026-07-23) ----
      // A multi-screen scroll jump skips content between two screenshots,
      // and the skip is invisible to the navigator — the after-photo always
      // looks like normal progress (live 2026-07-23: x3 jumps missed whole
      // letter sections, twice). While a full-list collection is being
      // gathered, scroll size is not the model's choice: one screenful at a
      // time, enforced in code.
      if (openEndedGathering() && step.do === 'scroll' && (step.times ?? 1) > 1) {
        step = { ...step, times: 1 };
        note(
          'scroll clamped to x1 by the runtime: on a full-list objective the page is read one screenful at a time so nothing is skipped between screenshots',
        );
      }

      const fingerprint = actionFingerprint(step);
      if (step.sideEffect && failedSideEffectContexts.has(`${fingerprint}@${currentUrlPath}`)) {
        rejections++;
        note(
          'step rejected: that side-effect action already ran on this page with an unconfirmed outcome — LOOK for its result (navigate to where it would be visible, extract) instead of re-issuing it.',
        );
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', 'A side-effect step with an unconfirmed outcome must not be blindly repeated.');
          outcome = 'fail';
          outcomeSummary = 'side-effect repeat blocked';
          return;
        }
        if (!outOfTime()) {
          const outcomeOfReview = await escalate(
            'the runtime blocked a re-issue of a side-effect action whose outcome is unconfirmed',
            observed,
          );
          if (outcomeOfReview === 'ended') {
            outcome = record.outcome === 'ok' ? 'ok' : 'fail';
            outcomeSummary = outcomeSummary || 'ended by strategic review';
            return;
          }
        }
        continue;
      }
      if ((failedCounts.get(fingerprint) ?? 0) >= 2) {
        rejections++;
        note(
          'step rejected: that exact action has already failed twice this run — take a DIFFERENT approach (another control, route, or surface).',
        );
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', 'The navigator kept deciding the same failing step.');
          outcome = 'fail';
          outcomeSummary = 'repeat-decision loop';
          return;
        }
        if (!outOfTime()) {
          const outcomeOfReview = await escalate(
            `the navigator decided an action that has already failed twice: ${describeStep(step).slice(0, 100)}`,
            observed,
          );
          if (outcomeOfReview === 'ended') {
            outcome = record.outcome === 'ok' ? 'ok' : 'fail';
            outcomeSummary = outcomeSummary || 'ended by strategic review';
            return;
          }
        }
        continue;
      }

      // An identical record repeated straight after itself cannot add
      // anything — reject it with the reason instead of executing a no-op
      // that feeds the pacing counter
      if (step.do === 'collect' && fingerprint === lastCollectFp) {
        rejections++;
        note(
          'record rejected: that exact record was just processed — the table already reflects it (see the DELIVERABLE TABLE / collected totals). Decide a DIFFERENT action: the next incomplete row, or done if the target is met.',
        );
        if (rejections >= MAX_REJECTIONS) {
          await report('partial', 'The navigator kept re-issuing an identical record.');
          outcome = 'fail';
          outcomeSummary = 'repeat-record loop';
          return;
        }
        continue;
      }

      // Pacing detector: the same action recurring in the recent window —
      // even when every occurrence "succeeded" — is a loop no failure signal
      // sees (live case: 27 steps of scroll-up/scroll-down/extract circling).
      // PROGRESS-GATED (2026-07-23): scroll→collect→scroll→collect is what a
      // healthy sweep looks like — the same action recurring WHILE rows land
      // is convergence, not pacing; a run visibly progressing is never
      // interrupted. Repetition only escalates once progress has also
      // stalled for several steps.
      const windowRepeats = recentFingerprints.filter(fp => fp === fingerprint).length;
      if (windowRepeats >= FUTILITY_REPEATS && progresslessSteps >= GRACE_PROGRESS_WINDOW && !outOfTime()) {
        note(
          `pacing detected: "${describeStep(step)}" chosen ${windowRepeats + 1} times in the last ${FUTILITY_WINDOW} steps without the task advancing`,
        );
        const outcomeOfReview = await escalate(
          `the run is pacing — the same action (${describeStep(step).slice(0, 80)}) keeps recurring without the task advancing`,
          observed,
        );
        if (outcomeOfReview === 'ended') {
          outcome = record.outcome === 'ok' ? 'ok' : 'fail';
          outcomeSummary = outcomeSummary || 'ended by strategic review';
          return;
        }
        continue;
      }

      // Decision accepted — an executed step resets the invalid-decision streak
      rejections = 0;
      stepsUsed++;
      const description = `${describeStep(step)}${step.sideEffect ? ' [side-effect]' : ''}`;
      postExecutionEvent(
        port,
        Actors.SYSTEM,
        'step.ok',
        taskId,
        `Step ${stepsUsed}: ${description}${decision.why ? ` — ${decision.why}` : ''}`,
        decideMeta,
      );

      recentFingerprints.push(fingerprint);
      if (recentFingerprints.length > FUTILITY_WINDOW) recentFingerprints.shift();

      // ---- VISION-COLLECT (handled by the conductor, no browser action) ----
      // The navigator records data it read off the SCREENSHOT — the strong
      // model's eyes replace the local DOM reader for small collections
      // (which returns garbled fragments on some heavy SPAs, e.g. x.com)
      if (step.do === 'collect') {
        const items = (step.items ?? []).filter(item => {
          if (item === null || item === undefined) return false;
          if (typeof item === 'object') return Object.keys(item).length > 0;
          return String(item).trim().length > 0;
        });
        if (items.length === 0) {
          rejections++;
          note('collect step rejected: it carried no items');
          if (rejections >= MAX_REJECTIONS) {
            await report('partial', 'The navigator kept returning invalid steps.');
            outcome = 'fail';
            outcomeSummary = 'invalid steps';
            return;
          }
          continue;
        }
        // ---- SWEEP BEFORE INGEST (text is the first writer, 2026-07-23) ----
        // A screenshot record carrying several items confirms this page IS
        // the list — but its values are VISION reads, and ingesting them
        // first locks their misreads in ("Papsy Global" filled the cell, so
        // the later correct text read couldn't; "Bonnaceur" seeded a row
        // beside "Bennaceur" — live 2026-07-23). So on an open-ended
        // collection the runtime sweeps FIRST (lossless DOM text writes
        // every cell it can), and the navigator's screenshot items ingest
        // AFTER, backfilling only what the text genuinely missed.
        let sweptFirst = false;
        if (openEndedGathering() && !sweepUsed && items.length >= 3 && !outOfTime()) {
          sweptFirst = true;
          note(
            'a screenshot record with several items confirms this page is the list — running the text sweep FIRST so lossless text is the first writer; the screenshot items will backfill anything the sweep missed',
          );
          try {
            await runSweep('this page is the list — text reads first, the screenshot record backfills after');
          } catch (error) {
            if (signal.aborted) throw error;
            logger.warning('sweep failed:', error);
            note('the sweep hit an unexpected error — ingesting the screenshot record normally');
          }
        }
        // Trust the navigator's items verbatim — recordExtract's listLines()
        // heuristics expect the local reader's bulleted output and silently
        // discard plain lines (live case: "record 5 item(s) ✓ — 0 new" ×3).
        // Same-entity lines MERGE (see addOrUpgrade) so an enrichment record
        // upgrades the item it enriches instead of stranding a partial twin.
        let added = 0;
        let upgraded = 0;
        collectDiagnostics.length = 0;
        for (const item of items) {
          const outcome =
            typeof item === 'object'
              ? schema
                ? upsertObjectItem(item as Record<string, unknown>)
                : addOrUpgrade(
                    Object.values(item as Record<string, unknown>)
                      .map(v => String(v ?? '').trim())
                      .filter(Boolean)
                      .join(' — '),
                  )
              : addOrUpgrade(String(item));
          if (outcome === 'new') added++;
          else if (outcome === 'upgraded') upgraded++;
        }
        const gained = added + upgraded;
        note(
          gained > 0
            ? `collected +${added} new, ${upgraded} upgraded item(s) from the screen (${collection.length} total)`
            : `collect added nothing new — all ${items.length} item(s) were already in the collection (${collection.length} total)`,
        );
        if (schema && collectDiagnostics.length) {
          note(`record outcomes: ${collectDiagnostics.slice(0, 6).join(' · ')}`);
          if (gained === 0) {
            note(
              'to FILL A CELL, the record must be the row name exactly as the table shows it, then "column: value" ("Apruve — website: apruve.com"). A record the table already holds changes nothing — check the table, and NEVER retry an identical record.',
            );
          }
        }
        if (gained > 0) progresslessSteps = 0;
        else progresslessSteps++;
        lastProgressMutations = collectionMutations;
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          gained > 0
            ? `Step ${stepsUsed}: ${description} ✓ — ${added} new, ${upgraded} upgraded, ${collection.length} total`
            : `Step ${stepsUsed}: ${description} ⚠ — 0 new (all ${items.length} already collected), ${collection.length} total`,
          '⚙ recorded',
        );
        // The record's effect is in the TABLE, not on the screen — tell the
        // next turn what happened instead of "LAST ACTION: none" (which read
        // as "you haven't recorded yet" and caused identical re-records)
        lastCollectFp = fingerprint;
        // Backfill can re-introduce misread-name twins the sweep just
        // cleaned — merge again after ingesting the screenshot items
        if (sweptFirst) {
          const mergedAfterBackfill = mergeNearDuplicateRows();
          if (mergedAfterBackfill) note(`merged ${mergedAfterBackfill} near-duplicate row(s) after the screenshot backfill`);
        }
        lastAction = {
          stepNo: stepsUsed,
          description,
          execNote: sweptFirst
            ? `the runtime swept the whole page screen-by-screen FIRST (lossless text reads), then this screenshot record backfilled ${added} new row(s) and ${upgraded} cell(s) the text missed — ${collection.length} item(s) now held. Judge from the DELIVERABLE TABLE/ledger and decide what remains: verify completeness, then finish or write the deliverable.`
            : gained > 0
              ? `recorded instantly — ${added} new row(s), ${upgraded} cell(s) filled; the table above already reflects it. This action's effect is in the TABLE, not on the page: judge it succeeded and decide the NEXT action — re-recording the same item does nothing.`
              : `nothing changed — the table already held all of it. Judge from the table, not the page; NEVER re-issue this record — move to the next incomplete row.`,
          fingerprint,
          sideEffect: false,
          urlPath: currentUrlPath,
        };
        await persist('running');
        continue;
      }

      if (step.textFrom === 'collected') await curateBeforeWrite();

      // ---- EXECUTE ----
      // Executor-level retry only for steps that DIDN'T run (grounding miss,
      // stale element): exec.ok=false means the action never happened, so a
      // retry is safe. Side-effect steps still get exactly one attempt.
      // Schema mode: tell the reader the exact line shape that parses into
      // rows ("<name> | column: value"), so extracted data lands in the table
      if (schema && (step.do === 'extract' || step.do === 'harvest') && step.query) {
        // Filter at the door: on a mixed page, an unqualified read ingests
        // EVERYTHING into the table and junk rows become load-bearing (live
        // 2026-07-22 run #12: 37 mixed-sector cards became "complete" rows).
        const qualifier = ` Include ONLY items that genuinely match the objective "${goalText.replace(/\s+/g, ' ').slice(0, 140)}" — skip every other item on the page; fewer correct items beat many wrong ones.`;
        const shape = /format/i.test(step.query)
          ? ''
          : ` — format each item exactly as: <${schema.columns[0]}> | ${schema.columns
              .slice(1)
              .map(col => `${col}: <value, omit if not shown>`)
              .join(' | ')}.`;
        step = { ...step, query: `${step.query}${shape}${qualifier}` };
      }
      const attempts = step.sideEffect ? 1 : 2;
      const mutationsBeforeExec = collectionMutations;
      let exec = await runner.execStep(step);
      for (let attempt = 2; !exec.ok && attempt <= attempts; attempt++) {
        await sleep(1200);
        exec = await runner.execStep(step);
      }

      // ---- WEAK-HARVEST FALLBACK → SWEEP ----
      // The text reader failing to parse a page's card markup is a sensing
      // problem, not a strategy problem (live 2026-07-23: harvest returned
      // 1 then 0 items on a page visibly full of speaker cards, and the run
      // hand-cranked the collection for 40 steps). When a harvest lands
      // almost nothing, the runtime immediately sweeps the page with vision
      // instead — once per run.
      if (step.do === 'harvest' && !sweepUsed && collectionMutations - mutationsBeforeExec < 3 && !outOfTime()) {
        const gained = collectionMutations - mutationsBeforeExec;
        note(
          `the harvest yielded only ${gained} item(s) on a page that should hold more — the text reader is not parsing this page's markup; switching to a vision sweep`,
        );
        const beforeSweep = collectionMutations;
        try {
          await runSweep('the text harvest under-yielded on this page');
        } catch (error) {
          if (signal.aborted) throw error;
          logger.warning('sweep failed:', error);
          note('the sweep hit an unexpected error — continuing with normal stepping');
        }
        if (collectionMutations > beforeSweep) {
          exec = {
            ok: true,
            message: `the text harvest under-yielded (${gained} item(s)), so the runtime swept the page screen-by-screen with vision instead — ${collectionMutations - beforeSweep} item(s) landed, collection now ${collection.length}`,
          };
        }
      }

      if (!exec.ok) {
        postExecutionEvent(
          port,
          Actors.SYSTEM,
          'step.ok',
          taskId,
          `Step ${stepsUsed}: ${description} ✗ — ${exec.message}`,
          '⚙ executor failed',
        );
        note(`step ${stepsUsed} could not execute: ${describeStep(step)} — ${exec.message.slice(0, 180)}`);
        consecutiveFailures++;
        failedCounts.set(fingerprint, (failedCounts.get(fingerprint) ?? 0) + 1);
        // The action never ran, so there is nothing for the judge to assess
        lastAction = null;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await report('partial', `${MAX_CONSECUTIVE_FAILURES} consecutive steps failed — not converging.`);
          outcome = 'fail';
          outcomeSummary = 'consecutive failures';
          return;
        }
        await persist('running');
        continue;
      }

      // A different action executed — the identical-record guard resets (a
      // later re-record after new context is a decision, not a reflex)
      lastCollectFp = null;
      if (step.sideEffect || step.do === 'type' || step.do === 'type_focused' || step.do === 'key') {
        changedAnything = true;
      }
      // Outcome-level progress accounting: extract/harvest grow the
      // collection inside execStep, so the size delta is visible here; a
      // world-changing step is progress by definition (acting tasks collect
      // nothing). New-site progress is credited at the top of the next turn.
      if (
        collectionMutations > lastProgressMutations ||
        step.sideEffect ||
        step.do === 'type' ||
        step.do === 'type_focused' ||
        step.do === 'key'
      ) {
        progresslessSteps = 0;
      } else {
        progresslessSteps++;
      }
      lastProgressMutations = collectionMutations;
      // Journal the EXECUTION immediately — if the run dies before the next
      // turn's judgment, the report must still know this action ran (live
      // failure: a report claimed "NOT posted" about an executed Post click
      // whose judgment turn never happened; the post was live)
      // Typed text goes into the journal VERBATIM (prefix) so the next turn's
      // judge can compare it against what the field actually shows — without
      // it, truncated typing ("LLMs…" landing as "s…") was judged a success
      // because the intended text was invisible (live failure 2026-07-20)
      const typedPreview =
        (step.do === 'type' || step.do === 'type_focused') && step.text && step.textFrom !== 'collected'
          ? ` — typed text begins: "${step.text.replace(/\n/g, ' ').slice(0, 90)}"`
          : '';
      note(
        `step ${stepsUsed} EXECUTED${step.sideEffect ? ' [side-effect]' : ''}: ${describeStep(step)}${typedPreview} — outcome not yet judged${step.sideEffect ? '; it may have taken effect' : ''}`,
      );

      // Executed — give the page time to react before the next observation
      await sleep(SETTLE_MS[step.do] ?? 400);
      lastAction = {
        stepNo: stepsUsed,
        description,
        execNote: exec.message,
        fingerprint,
        sideEffect: Boolean(step.sideEffect),
        urlPath: currentUrlPath,
        // Only actions whose whole point is to change the page get the
        // no-effect check; reads and side-effects (off-page effects) don't
        pageSigBefore:
          !step.sideEffect && (step.do === 'click' || step.do === 'key' || step.do === 'scroll')
            ? lastObservedSig
            : null,
      };
      await persist('running');
    }

    await report('partial', `Step budget (${MAX_STEPS}) exhausted without meeting the objective.`);
    outcome = 'fail';
    outcomeSummary = 'step budget exhausted';
  } catch (error) {
    if (signal.aborted) {
      await runStateStore.clearRun(taskId).catch(() => {});
    } else {
      await persist('stalled').catch(() => {});
    }
    throw error;
  } finally {
    // Close out the account sync with an honest status. A run waiting on the
    // user (clarification/stall) stays RUNNING on the site only while it can
    // still be resumed into the same clientRunId.
    if (runSync) {
      const sync = runSync;
      void (async () => {
        const state = await runStateStore.getRun(taskId).catch(() => null);
        if (state?.status === 'awaiting_clarification') {
          await sync.flush();
          sync.stop();
        } else if (outcome === 'ok') {
          await sync.finish('COMPLETED');
        } else if (signal.aborted) {
          await sync.finish('STOPPED', 'Cancelled from the extension');
        } else if (outcome === 'fail') {
          await sync.finish('FAILED', outcomeSummary || undefined);
        } else {
          await sync.finish('STOPPED', 'Paused — reply "continue" in the extension to resume');
        }
      })().catch(() => {});
    }
    chrome.tabs.onCreated.removeListener(onTabCreated);
    // Multi-tab runs: drop the CDP session from every EXTRA tab this run
    // opened (loop.ts detaches the initial one). The tabs themselves stay
    // open by policy — the deliverable (e.g. the written sheet) may be one
    // of them; scheduled runs clean up wholesale when their window closes.
    for (const extraTabId of new Set(runTabs.values())) {
      if (extraTabId !== tabId) await detachCdp(extraTabId).catch(() => {});
    }
    trajectoryStore
      .appendSubtask({
        id: taskId,
        sessionId: taskId,
        taskRecordId: record.id,
        goal: `stepwise: ${task.slice(0, 140)}`,
        success: outcomeSummary || 'n/a',
        status: outcome === 'ok' ? 'ok' : 'fail',
        summary: outcomeSummary || 'ended without explicit outcome',
        stepsCount: stepsUsed,
        plannedBy: 'orchestrator',
        plannerTier: 0,
        plannerModel: 'stepwise',
        startedAt,
        endedAt: Date.now(),
      })
      .catch(error => logger.warning('subtask record failed:', error));
  }
}
