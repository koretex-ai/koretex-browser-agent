import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';
import { fetchWithTimeout, withTimeout } from '../net';
import { scrubPii } from './pii';

const logger = createLogger('orchestrator');

// A cloud PLAN/REFLECT/REPORT call gets this long to respond before it is
// treated as a stall — long enough for a big plan, short enough that a wedged
// connection surfaces as an error instead of an eternal spinner
const CLOUD_CALL_TIMEOUT_MS = 90_000;

/**
 * Cloud planner/reflector for the plan–act–verify architecture. One strong
 * model (GLM 5.2 by default) makes every decision through exactly three
 * prompts: PLAN (objective -> steps with expects), REFLECT (failed step ->
 * fix/replan/stop), REPORT (journal -> final answer). Local models only
 * perceive: grounding, extraction, and visual verification.
 *
 * HARD RULE: payloads are digest-only. This module has no access to
 * screenshots by construction — the objective, the journal, page digests
 * (URL/title/element labels), and verifier observations are the only things
 * that cross the boundary. Collected datasets are written to pages via
 * textFrom:"collected" WITHOUT crossing the boundary at all.
 */

/**
 * Observable postcondition, verified against the LIVE page by the harness.
 * url/text/element are deterministic checks (instant, polled while the page
 * settles); `see` is a local-VLM screenshot question for what only pixels can
 * answer. All specified fields must hold.
 */
export interface StepExpect {
  /** Substring the page URL must contain */
  url?: string;
  /** Text that must appear in the readable page text */
  text?: string;
  /** Label of an interactive element that must exist */
  element?: string;
  /**
   * A label/text that must NO LONGER be present — the "disappeared" half of a
   * transition (a dialog/composer closed, an item deleted, a spinner gone).
   * Deterministic, polled. This is how a submit/close/delete is proven without
   * vision.
   */
  gone?: string;
  /** Yes/no question for the local vision verifier (canvas editors, layout) */
  see?: string;
}

/**
 * One typed step of a planner-authored program. The harness executes steps
 * deterministically — no model interprets them. Targets are element
 * DESCRIPTIONS (visible labels), resolved on-page by label matching with a
 * vision-grounding fallback.
 */
export interface ProgramStep {
  do:
    | 'navigate'
    | 'click'
    | 'type'
    | 'type_focused'
    | 'key'
    | 'scroll'
    | 'extract'
    | 'harvest'
    | 'verify_visual'
    | 'wait'
    | 'wait_for'
    | string;
  url?: string;
  /** click/type: element description; wait_for: text that must appear */
  target?: string;
  text?: string;
  /**
   * type/type_focused: insert the task's ENTIRE local collection store
   * (untruncated harvested items) at execution time, below any literal
   * `text` (which becomes a header line). The data never round-trips
   * through the cloud.
   */
  textFrom?: 'collected';
  combo?: string;
  query?: string;
  /** verify_visual: question answered from a screenshot by the local VLM */
  question?: string;
  /** harvest: stop once ~this many items are collected */
  until?: number;
  /** collect (stepwise only): items the navigator read off the SCREENSHOT */
  items?: string[];
  maxScrolls?: number;
  direction?: 'up' | 'down';
  times?: number;
  /** wait: delay; wait_for: timeout (default 10000, max 20000) */
  ms?: number;
  /** Postcondition verified after the step; REQUIRED on state-changing steps */
  expect?: StepExpect;
  /** Posts/sends/submits/purchases/deletes — never auto-retried */
  sideEffect?: boolean;
}

export interface PlanResult {
  mode: 'chat' | 'plan' | 'clarify';
  /** Unused for chat (the reply is streamed separately with history) */
  reply?: string;
  /** 1-3 questions for the user for mode=clarify */
  questions?: string[];
  /** The complete program for mode=plan */
  steps?: ProgramStep[];
  /** 1-4 expects that define success of the WHOLE objective */
  objective?: StepExpect[];
}

export interface ReflectResult {
  verdict: 'fix_step' | 'replan' | 'stop';
  /** Corrected step (with expect) for verdict=fix_step */
  step?: ProgramStep;
  reason?: string;
}

// Shared step-forms reference for PLAN and REFLECT
const STEP_FORMS = `Step forms (the runtime executes these EXACTLY — put real values in, never placeholders):
{"do":"navigate","url":"https://..."}
{"do":"click","target":"<visible label of the element, e.g. Start a post>"}
{"do":"type","target":"<label/placeholder of the input>","text":"..."}  (replaces the input's content; if no labeled input matches, the runtime visually locates the field, focuses it, and types)
{"do":"type_focused","text":"line1\\nline2"}  (trusted keyboard input into whatever currently has focus — the way to type into any RICH EDITOR that is not a plain form field: canvas editors like Google Docs/Sheets, and contenteditable composers like post/message boxes. Focus it first — click it, or it focuses itself when opened)
{"do":"key","combo":"Enter"}  (submit a search box after typing into it)
{"do":"scroll","direction":"down","times":2}
{"do":"extract","query":"<what to read from the page text>"}  (a local reader answers from page text; list items are stored in the collection)
{"do":"harvest","query":"<items to collect>","until":10}  (scroll+extract loop until ~N unique items are collected or results stop yielding — USE THIS for any collect-N-things-from-a-feed work; the runtime deduplicates; 0 items fails the step)
{"do":"wait_for","target":"<text that must appear>","ms":10000}  (poll until the text appears; rarely needed — expects already wait)
{"do":"wait","ms":1500}  (blind delay — last resort)
Targets are element DESCRIPTIONS (visible text labels), resolved on the live page by label matching with a vision fallback — never invent element indices.

EXPECTS — every state-changing step (navigate, click, type, type_focused, key) MUST carry "expect", the observable postcondition that proves the step worked:
"expect": {"url": "<substring the URL will contain>"}
"expect": {"text": "<text that will appear on the page>"}
"expect": {"element": "<label of an element that will now exist>"}
"expect": {"gone": "<label/text that will NO LONGER be present>"}  (the disappeared half of a transition: a dialog/composer closed, an item deleted, a spinner finished)
"expect": {"see": "<yes/no question for a local vision model>"}
Fields combine (all must hold). url/text/element/gone are deterministic — checked instantly against the live page and POLLED up to ~8 seconds, so you never need wait steps after navigation: the expect IS the wait. "see" is for outcomes only a screenshot can judge (canvas editors like Google Docs/Sheets; a purely visual layout) — it is the RIGHT tool for a visual-only transition, just slower, so reach for a deterministic field first when one captures the transition. Read-only steps (extract, harvest, scroll, wait, wait_for) may omit expect.

GROUND EXPECTS IN OBSERVATION. For a destination you have NOT yet observed, assert only STRUCTURE: a url fragment, an "element" named by its FUNCTION ("compose editor", "search input", "text editor"), or a "gone". NEVER assert the exact wording of an unseen page — placeholders, headings, captions, and marketing copy vary by locale and A/B test, and a guessed string fails verification even when the action worked. Free-text "text" expects are only for content this run itself typed, or wording an observed page digest / the journal already showed you.

AN EXPECT MUST BE SATISFIABLE ONLY BY SUCCESS — never by a state that is ALREADY TRUE before the step completes. The test: could this expect pass even if the action did nothing? If yes, it is worthless. In particular, verifying that content you just entered is still on the page does NOT prove it was submitted — that text was there the moment you typed it. For an action that SUBMITS / SENDS / CREATES / DELETES, verify the TRANSITION that only success produces — most reliably with "gone" (the input surface or dialog closed) and/or a confirmation "element" that only appears afterwards. E.g. after posting, the composer is gone: {"gone": "<the composer's placeholder or submit label>"}. Do NOT verify a submit by the persistence of the text you typed. The OBJECTIVE expects follow the same rule: they must describe the delivered outcome, checkable only after it truly happened.

SIDE EFFECTS — steps that post, send, submit a form, purchase, or delete MUST carry "sideEffect": true (the runtime never auto-retries them) AND their expect must verify the post-action transition above, never the persistence of the entered content. Mind WHICH KIND of input surface you are submitting from: a DIALOG/MODAL composer closes on success, so "gone" on it is right — but a PERSISTENT INLINE composer (one that lives on the page, like a feed's post box) CLEARS and stays, so "gone" on it can never pass; verify an inline submit with a "see" question about the outcome (the new item visible outside the composer, a sent confirmation) or an "element" that only success produces.

WRITING COLLECTED DATA: a type/type_focused step may use "textFrom":"collected" — the runtime inserts EVERY item collected so far, complete and verbatim, below the optional "text" (which becomes a header line). This is the ONLY reliable way to write a collected dataset — journal digests are truncated, so never paste them into "text" yourself. Because items are inserted verbatim, think about where they will finally land and have harvest/extract queries request each item ALREADY IN THE FORM it should appear at that destination — the right fields, order, and separators for that medium (tab-separated only where tabs are meaningful, e.g. a spreadsheet grid).

Canvas-rendered editors (e.g. Google Docs/Sheets) are invisible to page-text extraction: type into them with type_focused (they focus themselves when opened; clicking around first can steal focus), write text exactly as it should appear (they render input literally, not as markup), and verify their writes with a "see" expect — url/text checks cannot see inside a canvas.`;

const PLAN_SYSTEM_PROMPT = `You are the planner for a browser agent running in a Chrome side panel. You compile the user's OBJECTIVE into a complete typed program that a deterministic runtime executes against the user's active tab, verifying every step's expect against the live page as it goes. Local models perceive (locate described elements, read page text, answer visual questions) but make no decisions.

THINK BEFORE YOU PLAN. First work out what outcome the user would actually consider success — the intent behind their words — and design the plan to produce that outcome. For each step, ask what the real site will actually do or return in response; choose queries, URLs, and actions for the results they will produce, not for surface similarity to the user's phrasing. A plan that executes flawlessly but produces the wrong thing is a failed plan. When a JOURNAL is present, study it before planning: understand what was tried, what failed, and WHY — then design the new plan to work around those causes, not to repeat or merely reword them.

THE CURRENT PAGE IS WHERE THE BROWSER HAPPENS TO BE — not a license to skip navigation. Treat any CURRENT PAGE you are shown as a starting observation, never as the assumption that it is the right place to act. Do NOT drop a navigate step just because the domain already matches: if the objective implies a destination or a fresh action, navigate to the canonical surface for that action (an app's main/home/compose surface), and build directly on the current page ONLY when it is genuinely already the correct context. Acting on the wrong sub-page — an arbitrary profile, someone else's content, an unrelated view — is a failed plan even if every step verifies, and for side-effecting actions it is harmful.

Reply ONLY with a JSON object:
{"mode": "chat" | "plan" | "clarify", "steps": [...], "objective": [{...expect...}], "questions": ["..."]}

- "chat": no browser needed (questions, conversation). The reply is streamed by a separate call.
- "clarify": the objective is genuinely ambiguous in a way that would change the plan or risk producing the WRONG result, and no reasonable default resolves it. Reply with 1-3 specific "questions". Ask ONLY when you truly cannot proceed sensibly — never for things you can reasonably assume; when a sane default exists, take it, note the assumption, and plan. Do not ask about details you would discover on the page anyway. (You are told PLANS USED n/N — only ask on the first plan, never mid-task.)
- "plan": the COMPLETE program to achieve the objective end to end — including the final write/save/deliver steps, max 25 steps. If the task says to save/write/post something, the plan must contain the steps that actually do it, not just open the destination.

${STEP_FORMS}

OBJECTIVE EXPECTS: "objective" is 1-4 expects that define success of the WHOLE task, verified on the live page after the last step. Make them the user's actual deliverable ("text": the sheet shows the header row; "url": the doc URL), not intermediate progress.

When collecting, collect against the INTENT, honoring every qualifier the user gave (who, where, what kind, how many). Over-collecting is fine — collected data is quality-filtered against the objective before it is written; searching for the wrong thing is not fine, because everything downstream inherits it.

Rules: prefer the most direct, deterministic route the web offers (a URL that encodes the query beats typing into a search box; when you do type into one, the next step must be {"do":"key","combo":"Enter"}). Steps that submit content come AFTER the steps that enter it. When a step redoes work that an earlier attempt may have PARTIALLY completed, first restore a known clean state rather than adding on top of unknown leftovers. Never plan logging in or handling credentials — if the task requires being signed in, assume the user is; if a login wall appears, the run will stop and tell them. You are told PLANS USED n/N: when on the LAST plan, deliver the objective with the data already collected (a delivered partial beats an undelivered perfect).`;

// ---- STEPWISE ENGINE ----
// One JUDGE-AND-DECIDE call per step: a multimodal navigator receives a
// SCREENSHOT of the live tab (plus the digest and journal), judges what the
// last action actually did from that evidence, and decides the single next
// step. There are no planner-authored expects to get wrong — outcomes are
// judged after the fact from pixels, not predicted in advance.
const NEXT_STEP_FORMS = `Step forms (the runtime executes these EXACTLY — put real values in, never placeholders):
{"do":"navigate","url":"https://..."}
{"do":"click","target":"<visible label of the element, e.g. Start a post>"}
{"do":"type","target":"<label/placeholder of the input>","text":"..."}  (replaces the input's content; if no labeled input matches, the runtime visually locates the field, focuses it, and types)
{"do":"type_focused","text":"line1\\nline2"}  (trusted keyboard input into whatever currently has focus — the way to type into any RICH EDITOR that is not a plain form field: canvas editors like Google Docs/Sheets, and contenteditable composers like post/message boxes. Focus it first — click it, or it focuses itself when opened)
{"do":"key","combo":"Enter"}  (submit a search box after typing into it)
{"do":"scroll","direction":"down","times":2}
{"do":"extract","query":"<what to read from the page text>"}  (a local reader answers from the FULL page text; list items are stored in the collection — also the way to read more than the truncated text sample shows)
{"do":"harvest","query":"<items to collect>","until":10}  (scroll+extract loop until ~N unique items are collected or results stop yielding — for LARGE collections; the runtime deduplicates; 0 items fails the step)
{"do":"collect","items":["<one item per entry>", ...]}  (record data YOU can read on the SCREENSHOT into the collection — the RELIABLE way to capture what you can see: posts, names, rows. Write each item complete and already formatted for its destination. Text extraction is garbled on some sites; your own eyes are not. Use extract/harvest only for content beyond the visible screenshot or for large lists.)
{"do":"wait","ms":2000}  (the page is visibly still loading — look again after a pause)
Targets are element DESCRIPTIONS (visible text labels), resolved on the live page by label matching with a vision fallback — never invent element indices.

SIDE EFFECTS — a step that posts, sends, submits a form, purchases, or deletes MUST carry "sideEffect": true. The runtime gives such steps exactly ONE attempt and will refuse a blind re-issue: if a side-effect's outcome is unclear, your next move is to LOOK for its result (navigate to where it would be visible, extract), never to do it again.

WRITING COLLECTED DATA — the ONLY correct form is exactly this:
{"do":"type_focused","textFrom":"collected","text":"Title\\tSource"}
The RUNTIME appends every collected item below the optional "text" (a header line at most), complete and verbatim, after a quality pass that drops off-target items. Two forbidden variants, both live failures:
- "text" must NEVER carry data rows or placeholder/template rows ("Article 1\\tSource 1"...) — the runtime does NOT fill templates; placeholders land on the page literally (a sheet came out full of "Article 3 / Source 3").
- Hand-typing the real items into "text" is equally wrong: your journal view of them is TRUNCATED — hand-typed data comes out cut mid-word and duplicated, while the collection held every item complete.
Have harvest/extract/collect record each item ALREADY IN THE FORM it should appear at the destination (tab-separated only where tabs are meaningful, e.g. a spreadsheet grid).

Canvas-rendered editors (e.g. Google Docs/Sheets) render input literally, not as markup — type into them with type_focused (they focus themselves when opened; clicking around first can steal focus). type_focused INSERTS at the focus — it does NOT clear existing content; if a failed earlier attempt left partial content behind, restore a clean state first (in a text editor: select-all then retype; in a grid: select the cells and delete — never select-all in a grid, it selects cells, not text).`;

const NEXT_SYSTEM_PROMPT = `You are the navigator for a browser agent. You work ONE step at a time: a deterministic runtime executes each step you decide against the user's active tab, then returns to you with a fresh SCREENSHOT of the tab, a page digest, and the journal. Local models handle perception details (locating elements to click, bulk-reading page text); you make every decision.

You are given: the OBJECTIVE, STEPS USED plus TIME REMAINING, sometimes an ACTIVE STRATEGY (standing orders from a deeper strategic review — always follow it), sometimes SITE PLAYBOOKS (proven notes on how the sites involved actually work — strong priors that spare you rediscovering routes and traps, but the live page always wins: if the screenshot contradicts a note, trust the screenshot), LAST ACTION (the step just executed and what the executor reported), CURRENT PAGE (url, title, visible element labels, truncated page-text sample), the JOURNAL (chronological history: every step, your judgment of it, and data collected), and the SCREENSHOT of the tab as it looks right now.

YOUR FIRST JOB EVERY TURN IS TO JUDGE. Look at the screenshot and state what you actually see and what the LAST ACTION accomplished — as evidence, not hope: "the composer is open and empty", "the post now appears at the top of the feed", "a dialog is asking to confirm deletion", "the page is still loading". Then rule the last action succeeded, failed, or uncertain. Judge ONLY from visible evidence; wanting it to have worked is not evidence. If the page looks mid-load (spinners, blank regions), say so and prefer a short {"do":"wait"} over guessing.

YOUR SECOND JOB IS TO DECIDE the single next step that most directly advances the objective from the page as it ACTUALLY is.

Reply ONLY with a JSON object:
{"assessment":"<1-2 sentences: what the screenshot shows and what the last action did>","last_action":"succeeded"|"failed"|"uncertain"|"none","decision":"step","why":"<one line: what this step accomplishes>","step":{...}}
Add "stuck": true to your reply when you notice you are CIRCLING — repeating variations of an approach that keeps not working (a control that reverts, results that stay empty, the same page state recurring). A deeper strategic review will then chart a different route; flagging early beats burning turns.
Other decisions (same JSON shape, with assessment and last_action always present):
"done" — the screenshot/journal show the objective FULLY delivered (every part of it — including any cleanup the user asked for). Your assessment must state the visible evidence.
"stop" with "reason" — ONLY when the page POSITIVELY shows a blocker only the user can clear (a visible login form, a CAPTCHA). A disabled control or an odd page is a precondition to satisfy, not a blocker.
"clarify" with "questions":[1-3] — first decision only, and only when no reasonable default exists.
"chat" — the message is conversation, not a browser task (first decision only).

${NEXT_STEP_FORMS}

Decision rules:
- THE CURRENT PAGE IS WHERE THE BROWSER HAPPENS TO BE — an observation, not a license to act here. If the objective implies a destination or a fresh action, navigate to the canonical surface for it.
- DISAMBIGUATE CLICK TARGETS. A short label often matches several elements (a nav item and a per-item button can share a name — clicking the wrong "More" opens the wrong menu). When that risk exists, describe the target by label AND place/role: "the ··· More button on the post", "the Post button inside the composer", "the Delete item in the opened menu".
- Prefer the most direct, deterministic route the web offers: a URL that encodes the query beats typing into a search box; after typing into a search box, the next step is {"do":"key","combo":"Enter"}.
- When searching for a CLASS of things, translate the class into concrete queries that will actually match (role-class → real titles; combine the user's qualifiers). Searching for the wrong thing poisons everything downstream.
- When an action fails, your judgment of WHY (from the screenshot) drives the fix: a different control, a different route, an unmet precondition. Never re-issue an action you have judged failed twice unchanged.
- A step that redoes work a failed attempt may have PARTIALLY completed must first restore a clean state (select-all/clear before retyping; close a half-open dialog).
- TO CONFIRM whether content exists beyond the visible screenshot (a saved row, an older post), use extract — absence from the digest or a scrolled-away screenshot is not evidence of absence.
- Never plan logging in or handling credentials — if a login wall appears, stop.
- You are told TIME REMAINING: there is no step limit, but when only a few minutes remain, stop exploring and DELIVER the objective with the data already collected — a delivered partial beats an undelivered perfect. Deliverables that need a destination (a sheet, a doc) take several steps; budget for them.`;

export interface NextResult {
  assessment?: string;
  last_action?: 'succeeded' | 'failed' | 'uncertain' | 'none';
  decision: 'step' | 'done' | 'stop' | 'clarify' | 'chat';
  why?: string;
  step?: ProgramStep;
  questions?: string[];
  reason?: string;
  /** Navigator noticed it is circling — the conductor triggers a strategic review */
  stuck?: boolean;
}

// ---- STRATEGIC REVIEW (the altitude the fast loop deliberately lacks) ----
// Called by the conductor only when a stuck pattern fires: repeated judged
// failures, guard rejections, state reverts, or the navigator flagging
// itself. One deep call — reasoning ON — that diagnoses the ROOT CAUSE and
// sets standing orders (an ACTIVE STRATEGY) the myopic per-step loop then
// follows.
const REVIEW_SYSTEM_PROMPT = `You are the strategist for a browser agent. The fast per-step navigator has STOPPED MAKING PROGRESS — you are called only when a stuck pattern fires. You get the OBJECTIVE, TIME REMAINING, the STUCK SIGNAL (which pattern fired), any ACTIVE STRATEGY already in force, the JOURNAL (full history: every step, its judgment, data collected), and the CURRENT PAGE digest plus SCREENSHOT.

STEP BACK AND THINK DEEPLY. Diagnose the ROOT CAUSE — not "the click failed" but why the whole approach is not working: a capability gated behind a paywall or upsell (a control that reverts or is blocked by an upgrade prompt is UNAVAILABLE on this account — route around it, never fight it), the wrong surface for the goal, a search phrased so it matches nothing, a page that requires state the run never established. Then chart a DIFFERENT route to the objective — the web usually offers several: keywords in the query instead of UI filters, a URL that encodes the search, a different page or surface, a simpler deliverable path. Never propose retrying what the journal shows failing repeatedly. Prefer routes that need fewer privileged features. Respect the remaining time: a simple route that delivers a partial beats an elegant long one.

Reply ONLY with a JSON object:
{"diagnosis":"<root cause, 1-2 sentences>","verdict":"strategy","strategy":"<standing orders for the navigator: what to do INSTEAD and what to STOP attempting — concrete, 1-3 sentences>"}
{"diagnosis":"...","verdict":"done"}  — the journal and screenshot show the objective is ALREADY fully delivered.
{"diagnosis":"...","verdict":"blocked","reason":"<what only the user can do>"}  — ONLY for walls no strategy can route around: a login wall, a CAPTCHA, the site fundamentally lacking the capability.`;

export interface ReviewResult {
  diagnosis?: string;
  verdict: 'strategy' | 'done' | 'blocked';
  strategy?: string;
  reason?: string;
}

export interface ReviewArgs {
  objective: string;
  journal: string[];
  pageDigest?: string;
  screenshotDataUrl?: string;
  activeStrategy?: string;
  /** Rendered site playbooks applicable this turn (skills.ts) */
  skills?: string;
  /** One-line index of the user's OTHER playbooks */
  skillCatalog?: string;
  stuckSignal: string;
  timeRemainingMin?: number;
}

export async function strategicReview(
  args: ReviewArgs,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: ReviewResult; usage: CallUsage }> {
  const { navigatorModel } = await chatSettingsStore.getSettings();
  const content =
    `OBJECTIVE: ${args.objective}` +
    (args.timeRemainingMin !== undefined ? `\nTIME REMAINING: about ${args.timeRemainingMin} minute(s)` : '') +
    `\n\nSTUCK SIGNAL: ${args.stuckSignal}` +
    (args.activeStrategy ? `\n\nACTIVE STRATEGY (already in force — it has NOT worked):\n${args.activeStrategy}` : '') +
    (args.skills
      ? `\n\nSITE PLAYBOOKS (proven notes for the sites this task involves — factor them into the diagnosis and strategy):\n${args.skills}`
      : '') +
    (args.skillCatalog
      ? `\n\nOTHER PLAYBOOKS THE USER HAS (one line each — if one covers the objective, route the strategy through its site):\n${args.skillCatalog}`
      : '') +
    (args.pageDigest ? `\n\nCURRENT PAGE (the active tab right now):\n${args.pageDigest}` : '') +
    journalSection(args.journal);
  const { value, usage } = await callOrchestrator<ReviewResult>(REVIEW_SYSTEM_PROMPT, content, signal, onProgress, {
    imageDataUrl: args.screenshotDataUrl,
    modelOverride: navigatorModel || undefined,
    deepReview: true,
  });
  if (!['strategy', 'done', 'blocked'].includes(value.verdict)) {
    throw new Error(`Strategist returned invalid verdict: ${String(value.verdict)}`);
  }
  return { result: value, usage };
}

export interface NextArgs {
  objective: string;
  journal: string[];
  pageDigest?: string;
  /** The step just executed, for the judge — null on the first turn */
  lastAction?: { description: string; execNote: string } | null;
  stepsUsed: number;
  maxSteps: number;
  /** Minutes left on the wall-clock budget — the budget the navigator plans against */
  timeRemainingMin?: number;
  /** Standing orders from the last strategic review, pinned into every turn */
  activeStrategy?: string;
  /** Rendered site playbooks applicable this turn (skills.ts), pinned like the strategy */
  skills?: string;
  /** One-line index of the user's OTHER playbooks (not in force this turn) */
  skillCatalog?: string;
  /** Screenshot of the tab as it looks now (data URL); omit if capture failed */
  screenshotDataUrl?: string;
}

export async function nextStep(
  args: NextArgs,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: NextResult; usage: CallUsage }> {
  const { navigatorModel } = await chatSettingsStore.getSettings();
  const lastSection = args.lastAction
    ? `\n\nLAST ACTION (just executed — judge its outcome from the screenshot):\n${args.lastAction.description}\nExecutor reported: ${args.lastAction.execNote || '(nothing)'}`
    : '\n\nLAST ACTION: none — this is the first turn; judge only what the current page shows.';
  const pageSection = args.pageDigest ? `\n\nCURRENT PAGE (the active tab right now):\n${args.pageDigest}` : '';
  const budgetLine =
    args.timeRemainingMin !== undefined
      ? `\n\nSTEPS USED: ${args.stepsUsed} · TIME REMAINING: about ${args.timeRemainingMin} minute(s)`
      : `\n\nSTEPS USED: ${args.stepsUsed} of ${args.maxSteps}`;
  const strategySection = args.activeStrategy
    ? `\n\nACTIVE STRATEGY (standing orders from a strategic review after earlier approaches failed — FOLLOW THIS, and do not retry what it rules out):\n${args.activeStrategy}`
    : '';
  const skillsSection = args.skills
    ? `\n\nSITE PLAYBOOKS (proven notes for the sites this task involves — strong priors, not orders; the live page wins over any note it contradicts):\n${args.skills}`
    : '';
  const catalogSection = args.skillCatalog
    ? `\n\nOTHER PLAYBOOKS THE USER HAS (one line each — full notes activate when you are on their site or the task matches; when one covers the objective, PREFER its site and route over improvising):\n${args.skillCatalog}`
    : '';
  const buildContent = (withScreenshot: boolean) =>
    `OBJECTIVE: ${args.objective}${budgetLine}${strategySection}${skillsSection}${catalogSection}` +
    lastSection +
    pageSection +
    (withScreenshot
      ? ''
      : '\n\n(NOTE: no screenshot is available this turn — judge from the digest and page-text sample, and be conservative: prefer "uncertain" over guessing.)') +
    journalSection(args.journal);
  // Models sometimes put the step's ACTION TYPE in the decision field
  // ({"decision":"extract","query":...}) — the intent is unambiguous, so
  // reshape it instead of dying on it (live failure 2026-07-15: one such
  // reply killed an otherwise-healthy run)
  const STEP_DOS = new Set([
    'navigate',
    'click',
    'type',
    'type_focused',
    'key',
    'scroll',
    'extract',
    'harvest',
    'collect',
    'wait',
    'wait_for',
  ]);
  const coerce = (value: NextResult): NextResult => {
    const raw = value as NextResult & Record<string, unknown>;
    if (STEP_DOS.has(String(raw.decision))) {
      const step = (raw.step as ProgramStep | undefined) ?? ({ ...raw, do: raw.decision } as unknown as ProgramStep);
      return { ...value, decision: 'step', step };
    }
    return value;
  };
  const validate = (value: NextResult): NextResult => {
    if (!['step', 'done', 'stop', 'clarify', 'chat'].includes(value.decision)) {
      throw new Error(`Navigator returned invalid decision: ${String(value.decision)}`);
    }
    return value;
  };

  try {
    const { value, usage } = await callOrchestrator<NextResult>(
      NEXT_SYSTEM_PROMPT,
      buildContent(Boolean(args.screenshotDataUrl)),
      signal,
      onProgress,
      {
        imageDataUrl: args.screenshotDataUrl,
        modelOverride: navigatorModel || undefined,
        lowLatency: true,
      },
    );
    const coerced = coerce(value);
    if (['step', 'done', 'stop', 'clarify', 'chat'].includes(coerced.decision)) return { result: coerced, usage };
    // Valid JSON, invalid schema — one corrective re-ask (the malformed-JSON
    // sibling case already gets a retry inside callOrchestrator)
    onProgress?.('The reply used an invalid decision — asking the navigator to correct it…');
    const retry = await callOrchestrator<NextResult>(
      NEXT_SYSTEM_PROMPT,
      buildContent(Boolean(args.screenshotDataUrl)) +
        `\n\n(Your previous reply had "decision":"${String(value.decision)}", which is INVALID. "decision" must be one of step|done|stop|clarify|chat — an action belongs INSIDE "step", e.g. {"decision":"step","step":{"do":"extract",...}}. Reply again, corrected.)`,
      signal,
      onProgress,
      {
        imageDataUrl: args.screenshotDataUrl,
        modelOverride: navigatorModel || undefined,
        lowLatency: true,
      },
    );
    return { result: validate(coerce(retry.value)), usage: retry.usage };
  } catch (error) {
    // Degraded fallback: if the call keeps dying WITH the screenshot attached
    // (transient network / provider stall — observed twice on media-heavy
    // post-submit pages), try once more image-free. A turn judged blind from
    // the digest is strictly better than a dead run.
    if (!args.screenshotDataUrl || signal.aborted || !isTransientNetworkError(error)) throw error;
    logger.warning('navigator call failed with screenshot attached — retrying image-free:', error);
    onProgress?.('The call kept failing with the screenshot attached — retrying without it…');
    const { value, usage } = await callOrchestrator<NextResult>(
      NEXT_SYSTEM_PROMPT,
      buildContent(false),
      signal,
      onProgress,
      { modelOverride: navigatorModel || undefined, lowLatency: true },
    );
    return { result: validate(coerce(value)), usage };
  }
}

const REFLECT_SYSTEM_PROMPT = `You are the reflector for a browser agent. One step of the current plan failed verification (or failed to execute). You get the OBJECTIVE, the JOURNAL, the PLAN, the FAILED STEP with its expect, and the OBSERVATION — what the page or verifier actually shows. Observe carefully, work out what ACTUALLY happened and why the expectation was not met, and only then decide whether the STEP was wrong or the PLAN is wrong.

Reply ONLY with a JSON object:
{"verdict": "fix_step" | "replan" | "stop", "step": {...corrected step with expect...}, "reason": "<short diagnosis>"}

- "fix_step": the plan is right, this one action was wrong — wrong element label, wrong URL, a dialog needs dismissing first is NOT this (that changes the plan). Provide the corrected step (same intent, with expect). It replaces the failed step and the plan continues.
- "replan": the plan's assumption about the page is false (unexpected state, the approach cannot work from here, a precondition is missing). Say why in "reason" — the planner is called again with it.
- "stop": ONLY the user can resolve it, and the OBSERVATION positively shows the blocker (a visible sign-in form, a permission/consent prompt, a CAPTCHA) or the objective is genuinely impossible. Never infer a user-only blocker from a symptom — a control being disabled, greyed, or unresponsive is NOT evidence of one.

${STEP_FORMS}

Reason from the OBSERVATION and the journal, never from guesses — the observation tells you what the page really shows, and your diagnosis is only as good as your reading of it. If the observation says the page could not be READ (a perception/tooling problem — "could not read the page"), that is NOT evidence the step or the site failed: retry the same step (fix_step with the same action) or wait, and never conclude the site is broken or the objective impossible from a read failure. State only causes the observation actually supports; do not name a cause (e.g. "not signed in", "no permission") unless the page visibly shows it. A control that is disabled/greyed/blocked means a PRECONDITION has not been met yet — work out which earlier action would satisfy it (e.g. a submit control is inert until its input has the required content) and prefer replanning to establish that precondition over declaring the task blocked. Always consider what state the FAILED ATTEMPT ITSELF left behind: an action that failed verification may still have partially taken effect, and whatever you decide must account for those leftovers rather than blindly redoing work on top of them. Put the ROOT CAUSE in "reason" — a replan is only as good as the planner's understanding of why the last plan failed. SIDE-EFFECT RULE: if the failed step has sideEffect true, it may have taken effect even though verification failed — NEVER fix_step a repeat of that action; verdict must be replan with a verification-first approach, or stop.`;

const REPORT_SYSTEM_PROMPT = `You are writing the final user-facing answer for a browser agent run. You get the OBJECTIVE, the STATUS (achieved or partial), the JOURNAL of what happened, and the COLLECTED ITEMS (complete, deduplicated data gathered during the run).

Reply ONLY with a JSON object: {"answer": "<the answer>"}

Ground every fact ONLY in the journal and collected items — never invent data. For achieved: confirm what was done and present the results. For partial: lead with what WAS accomplished and found (list the actual data), then say briefly what could not be completed and why. If nothing useful was gathered, say so honestly in one sentence.

Distinguish PROVEN from UNKNOWN. A verified step or an extract's answer is evidence; a failed VERIFICATION is only evidence that the check did not pass — NOT proof the action had no effect (side-effecting actions often land despite a failed check). If the journal never confirms a side-effect's outcome either way, do not assert it succeeded OR failed — say its outcome is unconfirmed and tell the user exactly what to check.

When the run WROTE content somewhere (a doc, sheet, post), report what the journal shows was ACTUALLY written and judged on screen — never re-derive that list from the collected items. The collection accumulates everything sighted during the run, including candidates that were later dropped; describing collection items as the delivered content misstates what the user will find.`;

// Tolerant JSON extraction (models sometimes wrap JSON in fences or prose)
function parseJsonObject<T>(content: string): T {
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as T;
    throw new Error(`Orchestrator did not return JSON: ${content.slice(0, 120)}`);
  }
}

export async function isOrchestratorConfigured(): Promise<boolean> {
  const settings = await chatSettingsStore.getSettings();
  return Boolean(settings.orchestratorEnabled && settings.orchestratorApiKey && settings.orchestratorBaseUrl);
}

/** Attribution for one cloud call: model used and USD cost when reported */
export interface CallUsage {
  model: string;
  /** USD, when the provider reports it (OpenRouter usage accounting) */
  cost: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** HTTP requests behind this logical call (JSON retries + repair rounds) */
  calls?: number;
  /** Wall-clock time spent waiting on the model, summed across those requests */
  durationMs?: number;
}

/** Called when a logical call needs extra rounds, so the UI can say why it is slow */
export type ProgressFn = (message: string) => void;

/** Message content: plain text, or text + image for multimodal calls */
type MessageContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface CallOpts {
  /** Attach a screenshot (data URL) to the user message — multimodal models only */
  imageDataUrl?: string;
  /** Use this model instead of the configured orchestratorModel */
  modelOverride?: string;
  /**
   * Latency-sensitive call (the per-step navigator): prefer high-throughput
   * providers and ask the model for minimal reasoning — a judge-and-decide
   * turn needs a look and a verdict, not minutes of chain-of-thought.
   */
  lowLatency?: boolean;
  /**
   * Strategic-review call: same provider routing as lowLatency, but reasoning
   * stays ON and the output budget is generous — this is the one call where
   * deep thinking is the point.
   */
  deepReview?: boolean;
  /**
   * Disciplined PROSE call (the cloud page reader): full lowLatency contract
   * — fast-host routing, reasoning off, output cap, short window — but no
   * JSON response format, and the raw content string is returned unparsed.
   * Exists so non-JSON calls still go through THIS gateway and inherit every
   * check by default instead of growing their own (drifting) copy.
   */
  prose?: boolean;
}

// Network-transient errors (connection drop, provider blip, timeout) get one
// retry — a run should not die because a single HTTP request hiccuped one
// step from the finish line (live failure 2026-07-15: "Failed to fetch").
function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|network|timed out|ECONNRESET|socket|HTTP 5\d\d|HTTP 429/i.test(message);
}

export async function callOrchestrator<T>(
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal,
  onProgress?: ProgressFn,
  opts?: CallOpts,
): Promise<{ value: T; usage: CallUsage }> {
  const { orchestratorBaseUrl, orchestratorApiKey, orchestratorModel, cloudOnly, piiGuard } =
    await chatSettingsStore.getSettings();
  const model = opts?.modelOverride || orchestratorModel;

  // PII guard (cloud-only mode): every text payload passes through the
  // pseudonymizer at this single choke point — detectable identifiers leave
  // as vault tokens, and the executor substitutes real values back locally
  // at typing time. Screenshots are not covered by this layer.
  if (cloudOnly && piiGuard) userContent = scrubPii(userContent);

  // Per-step navigator turns must be snappy — a shorter window plus the
  // image-free fallback beats waiting out two 90s stalls
  const timeoutMs = opts?.lowLatency || opts?.prose ? 60_000 : CLOUD_CALL_TIMEOUT_MS;

  const attemptRequest = async (
    messages: { role: string; content: MessageContent }[],
  ): Promise<{ content: string; usage: CallUsage }> => {
    const requestStartedAt = Date.now();
    const body = JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      usage: { include: true },
      // Payloads can carry page digests and (for the stepwise navigator)
      // SCREENSHOTS of the user's logged-in browser — route only to
      // providers that neither train on nor retain prompts (OpenRouter
      // provider preference).
      // Fastest host UNDER a price ceiling: sort:"throughput" alone routed to
      // the priciest host ($2/M out, DeepInfra); sort:"price" alone routed to
      // a 12-24 tok/s host (DigitalOcean) whose slow generation WAS the
      // timeouts. max_price ($/M) keeps the $0.14/$0.28-class hosts in play
      // and excludes the expensive tier; throughput picks the fastest of them.
      provider: {
        data_collection: 'deny',
        ...(opts?.lowLatency || opts?.deepReview || opts?.prose
          ? { sort: 'throughput', max_price: { prompt: 0.25, completion: 0.6 } }
          : {}),
      },
      // Navigator turns need a look and a JSON verdict, not an essay. Live
      // failure 2026-07-15: runaway chain-of-thought hit the default 16,384
      // output cap ("length") on ~1/3 of turns — 58s + $0.033 each, and the
      // truncation IS the "malformed reply". reasoning off + a hard output
      // cap turn a runaway into a cheap fast retry instead of a stall.
      ...(opts?.lowLatency
        ? { reasoning: { enabled: false }, response_format: { type: 'json_object' }, max_tokens: 4096 }
        : {}),
      // Prose calls (the page reader) get the same muzzle without the JSON format
      ...(opts?.prose ? { reasoning: { enabled: false }, max_tokens: 4096 } : {}),
      // Strategic reviews are the inverse trade: reasoning stays ON (deep
      // thinking is the point), with a generous-but-bounded output budget
      ...(opts?.deepReview ? { response_format: { type: 'json_object' }, max_tokens: 8192 } : {}),
    });
    // Payload size is the prime suspect when calls die on SPECIFIC turns
    // (media-heavy pages → much larger screenshots) — make it visible
    logger.info(`orchestrator request: ${Math.round(body.length / 1024)}KB body, model ${model}`);
    const response = await fetchWithTimeout(
      `${orchestratorBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${orchestratorApiKey}`,
          'HTTP-Referer': 'https://github.com/koretex-ai/browser-use',
          'X-Title': 'Browser Use',
        },
        body,
      },
      signal,
      timeoutMs,
    );
    if (!response.ok) {
      const detail = (await withTimeout(response.text(), 15_000, 'reading the error response').catch(() => '')).slice(
        0,
        200,
      );
      throw new Error(`Orchestrator request failed (HTTP ${response.status}): ${detail}`);
    }
    // fetch resolves on HEADERS; for a non-streaming completion the BODY is
    // where the whole generation time lives — it must be bounded too (live
    // failure 2026-07-15: "90s-capped" navigator calls ran 2m35s because the
    // body read had no timeout)
    const data = await withTimeout(response.json(), timeoutMs, 'reading the model response');
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    const content: string = data.choices?.[0]?.message?.content ?? '';
    const durationMs = Date.now() - requestStartedAt;
    logger.info(
      `orchestrator response (${Math.round(durationMs / 1000)}s, ${data.usage?.completion_tokens ?? '?'} out tok):`,
      content.slice(0, 300),
    );
    return {
      content,
      usage: {
        model: data.model ?? model,
        cost: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
        calls: 1,
        durationMs,
      },
    };
  };

  // One transparent retry for transient network failures — never for user
  // cancellation, and never a third attempt
  const request = async (
    messages: { role: string; content: MessageContent }[],
  ): Promise<{ content: string; usage: CallUsage }> => {
    try {
      return await attemptRequest(messages);
    } catch (error) {
      if (signal.aborted || !isTransientNetworkError(error)) throw error;
      logger.warning('transient network error, retrying once:', error);
      onProgress?.('Network hiccup — retrying the model call…');
      await new Promise(resolve => setTimeout(resolve, 2500));
      return attemptRequest(messages);
    }
  };

  const userMessage: { role: string; content: MessageContent } = opts?.imageDataUrl
    ? {
        role: 'user',
        content: [
          { type: 'text', text: userContent },
          { type: 'image_url', image_url: { url: opts.imageDataUrl } },
        ],
      }
    : { role: 'user', content: userContent };
  const messages: { role: string; content: MessageContent }[] = [
    { role: 'system', content: systemPrompt },
    userMessage,
  ];
  const first = await request(messages);
  // Prose mode: the caller wants the text itself, not a parsed object
  if (opts?.prose) return { value: first.content as unknown as T, usage: first.usage };
  try {
    return { value: parseJsonObject<T>(first.content), usage: first.usage };
  } catch (parseError) {
    // One malformed reply is worth a retry, not a dead task
    logger.warning('orchestrator returned non-JSON, retrying once:', parseError);
    onProgress?.('The model reply was malformed — asking it once more…');
    const retry = await request([
      ...messages,
      { role: 'assistant', content: first.content.slice(0, 2000) },
      {
        role: 'user',
        content:
          'That was not valid JSON. Reply ONLY with the JSON object in the specified format — no prose, no code fences.',
      },
    ]);
    return { value: parseJsonObject<T>(retry.content), usage: combineUsage(first.usage, retry.usage) };
  }
}

/** Sum two usages into one logical-call attribution (retries, repair rounds) */
function combineUsage(a: CallUsage, b: CallUsage | null | undefined): CallUsage {
  if (!b) return a;
  const sum = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return {
    model: b.model ?? a.model,
    cost: sum(a.cost, b.cost),
    promptTokens: sum(a.promptTokens, b.promptTokens),
    completionTokens: sum(a.completionTokens, b.completionTokens),
    calls: (a.calls ?? 1) + (b.calls ?? 1),
    durationMs: (a.durationMs ?? 0) + (b.durationMs ?? 0),
  };
}

function journalSection(journal: string[]): string {
  return journal.length ? `\n\nJOURNAL (everything tried and learned so far):\n${journal.join('\n')}` : '';
}

export async function planTask(
  objective: string,
  journal: string[],
  pageDigest: string | undefined,
  plansUsed: number,
  maxPlans: number,
  signal: AbortSignal,
  /**
   * Returns expect-validity faults in a plan, or [] when valid. When it finds
   * faults, planTask hands the plan back to the model with the specific faults
   * for ONE inline correction round — a cheap patch instead of throwing the
   * plan away and replanning from scratch (which surfaced as a jarring "Plan
   * rejected" opener and burned a plan slot every run).
   */
  validate?: (plan: PlanResult) => string[],
  onProgress?: ProgressFn,
): Promise<{ result: PlanResult; usage: CallUsage }> {
  const pageSection = pageDigest ? `\n\nCURRENT PAGE (the active tab right now):\n${pageDigest}` : '';
  const baseContent =
    `OBJECTIVE: ${objective}\n\nPLANS USED: ${plansUsed} of ${maxPlans}` + pageSection + journalSection(journal);
  const first = await callOrchestrator<PlanResult>(PLAN_SYSTEM_PROMPT, baseContent, signal, onProgress);
  if (!['chat', 'plan', 'clarify'].includes(first.value.mode)) {
    throw new Error(`Planner returned invalid mode: ${String(first.value.mode)}`);
  }

  if (first.value.mode !== 'plan' || !validate) return { result: first.value, usage: first.usage };
  const faults = validate(first.value);
  if (faults.length === 0) return { result: first.value, usage: first.usage };

  // Inline repair round: give the model its own plan back plus the exact
  // faults, and ask it to fix ONLY those.
  onProgress?.('The draft plan had invalid success checks — asking the planner to correct them…');
  const repairContent =
    `${baseContent}\n\nYou proposed this plan:\n${JSON.stringify({ steps: first.value.steps, objective: first.value.objective })}\n\n` +
    `It has these success-check (expect) faults:\n${faults.map(f => `- ${f}`).join('\n')}\n\n` +
    'Return the CORRECTED plan in the same JSON format. Fix ONLY these faults — keep everything else the same.';
  const repaired = await callOrchestrator<PlanResult>(PLAN_SYSTEM_PROMPT, repairContent, signal, onProgress).catch(
    () => null,
  );
  const combined = combineUsage(first.usage, repaired?.usage);
  // Use the repair only if it is a valid plan shape; otherwise fall through to
  // the conductor's backstop with the original (it will reject/replan).
  if (repaired && ['chat', 'plan', 'clarify'].includes(repaired.value.mode)) {
    return { result: repaired.value, usage: combined };
  }
  return { result: first.value, usage: combined };
}

export async function reflectOnFailure(
  objective: string,
  journal: string[],
  planSteps: string[],
  failedStepIndex: number,
  failedStep: ProgramStep,
  observation: string,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: ReflectResult; usage: CallUsage }> {
  const userContent =
    `OBJECTIVE: ${objective}\n\n` +
    `PLAN:\n${planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
    `FAILED STEP (${failedStepIndex + 1} of ${planSteps.length}):\n${JSON.stringify(failedStep)}\n\n` +
    `OBSERVATION:\n${observation}` +
    journalSection(journal);
  const { value: result, usage } = await callOrchestrator<ReflectResult>(
    REFLECT_SYSTEM_PROMPT,
    userContent,
    signal,
    onProgress,
  );
  if (!['fix_step', 'replan', 'stop'].includes(result.verdict)) {
    throw new Error(`Reflector returned invalid verdict: ${String(result.verdict)}`);
  }
  return { result, usage };
}

const CURATE_SYSTEM_PROMPT = `You are curating a dataset a browser agent collected, just before it is written to the user's document. The local page-reader transcribes verbatim — it does NOT judge relevance — so the raw items may include people/rows that do not actually fit the user's request. Your job is to KEEP only the items that genuinely match, in the user's intended order.

Reply ONLY with a JSON object: {"items": ["<kept item verbatim>", ...], "dropped": <count>}

Rules: return kept items EXACTLY as given (same text, same field separators — do not reformat, do not add or invent fields). Drop items that clearly do not match the objective (wrong role, wrong location, off-topic, obvious duplicates, junk). If the objective asks for N items and more than N genuinely qualify, keep the N best. If you cannot tell whether an item qualifies, KEEP it (better a borderline include than dropping real data). Never fabricate items.`;

/**
 * Quality pass over the collection before it is written: the local reader
 * cannot judge relevance, so a broad search leaks non-matching rows. One cheap
 * GLM call prunes them against the objective. Returns the kept items (verbatim)
 * or the originals unchanged on any failure — curation must never lose data.
 */
export async function curateCollection(
  objective: string,
  items: string[],
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ items: string[]; dropped: number; usage: CallUsage | null }> {
  if (items.length === 0) return { items, dropped: 0, usage: null };
  try {
    const userContent = `OBJECTIVE: ${objective}\n\nCOLLECTED ITEMS (one per line):\n${items.join('\n')}`;
    const { value, usage } = await callOrchestrator<{ items: string[]; dropped?: number }>(
      CURATE_SYSTEM_PROMPT,
      userContent,
      signal,
      onProgress,
    );
    if (!Array.isArray(value.items) || value.items.length === 0) return { items, dropped: 0, usage };
    return { items: value.items, dropped: Math.max(0, items.length - value.items.length), usage };
  } catch (error) {
    if (signal.aborted) throw error;
    logger.warning('curate failed, keeping all items:', error);
    return { items, dropped: 0, usage: null };
  }
}

export async function reportOutcome(
  objective: string,
  status: 'achieved' | 'partial',
  journal: string[],
  collection: string[],
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ answer: string; usage: CallUsage }> {
  const collectionSection = collection.length
    ? `\n\nCOLLECTED ITEMS (complete, deduplicated):\n${collection.slice(0, 100).join('\n').slice(0, 8000)}`
    : '';
  const userContent = `OBJECTIVE: ${objective}\n\nSTATUS: ${status}` + journalSection(journal) + collectionSection;
  const { value, usage } = await callOrchestrator<{ answer: string }>(
    REPORT_SYSTEM_PROMPT,
    userContent,
    signal,
    onProgress,
  );
  if (!value.answer) throw new Error('Report returned no answer');
  return { answer: value.answer, usage };
}

// ---- DISTILL (teach-by-demonstration → skill draft) ----
// The user demonstrated a task by hand while the extension recorded a
// semantic event log; this call turns demonstration + notes into a SKILL —
// a playbook the navigator reads as a prior, never a replayable macro.
const DISTILL_SYSTEM_PROMPT = `You are distilling a user's hand-performed browser demonstration into a SKILL for a browser agent. A skill is a short playbook of site knowledge the agent reads as a STRONG PRIOR while working — the agent still judges every step from the live page, so a skill teaches routes, traps, and expectations; it is NEVER a literal macro.

You get the DEMONSTRATION (a chronological event log: navigations with URLs, clicks with element descriptions, typed text, key presses), the user's NOTES (typed while demonstrating — these carry the WHY and outrank your inferences), and possibly INTERVIEW ANSWERS from a previous round.

Write the playbook the way an expert would brief a colleague:
- The FIRST LINE must state the skill's PURPOSE: what it accomplishes and when to reach for it, naming the site (e.g. "Find top-performing new Solana tokens on birdeye.so."). This line doubles as the skill's entry in a catalog the agent always sees — it is how the skill gets FOUND, so it must describe the goal, never a mid-flow detail.
- Capture the CANONICAL ROUTE: exact URLs that encode the operation (a visited URL that creates/searches directly is gold), the order of surfaces, which controls matter.
- Capture TRAPS the notes or the demonstration reveal (things avoided, retried, or warned about).
- GENERALIZE task-specific values into their role ("the user's search keywords", "the text to post") — never hard-code the demo's literals except URLs/controls that are part of the route.
- State only what the demonstration and notes support. Do not invent site knowledge.
- 3-6 short lines. Plain language. No numbering needed.

Also derive:
- "name": short kebab-case, named for the operation (e.g. "notion-new-page").
- "hosts": URL substrings (host + optional path prefix) of the sites ACTED ON in the demo — these trigger the skill when a tab matches. On multi-app domains include the path that identifies the app: "docs.google.com/document", never bare "docs.google.com" (which would also match Sheets and Slides and pin the skill on the wrong app).
- "intent": a case-insensitive regex source matching how a user would PHRASE tasks this skill serves. GENEROUS and order-free: single distinctive topic words as alternatives ("solana|birdeye|token" style), never multi-word ordered phrases like "top.*token.*solana" — users phrase tasks unpredictably and a missed match means the skill silently never fires.
- "questions": up to 3 SHORT questions. On the FIRST round (no INTERVIEW ANSWERS yet), the first question must always confirm the skill's key objective in the user's own words ("What should this skill accomplish — when should the agent use it?") unless the notes already state it explicitly. Further questions only where the demonstration is genuinely ambiguous about generality ("Is this URL always the starting point?", "Should this apply to all X or only Y?"). If INTERVIEW ANSWERS are present, fold them in and return few or no new questions.

Reply ONLY with JSON: {"name":"...","hosts":["..."],"intent":"...","guidance":"<lines separated by \\n>","questions":["..."]}`;

export interface SkillDraft {
  name: string;
  hosts: string[];
  intent?: string;
  guidance: string;
  questions?: string[];
}

export interface TeachInput {
  events: string[];
  notes: string[];
  qa: { question: string; answer: string }[];
  priorDraft?: SkillDraft;
}

export async function distillSkill(
  input: TeachInput,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: SkillDraft; usage: CallUsage }> {
  // Same call shape as the strategic review: the navigator model with
  // reasoning ON and fast-host routing — the default orchestrator path
  // (reasoning-heavy, unrouted) made distilling visibly slow in live use
  const { navigatorModel } = await chatSettingsStore.getSettings();
  const content =
    `DEMONSTRATION (chronological):\n${input.events.join('\n') || '(no events were recorded)'}` +
    (input.notes.length ? `\n\nNOTES from the user while demonstrating:\n${input.notes.join('\n')}` : '') +
    (input.priorDraft
      ? `\n\nPREVIOUS DRAFT (refine this using the interview answers):\n${JSON.stringify(input.priorDraft)}`
      : '') +
    (input.qa.length
      ? `\n\nINTERVIEW ANSWERS:\n${input.qa.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join('\n')}`
      : '');
  const { value, usage } = await callOrchestrator<SkillDraft>(DISTILL_SYSTEM_PROMPT, content, signal, onProgress, {
    modelOverride: navigatorModel || undefined,
    deepReview: true,
  });
  if (!value.name || !value.guidance) throw new Error('Distiller returned an incomplete skill draft');
  return {
    result: {
      name: String(value.name).trim(),
      hosts: (value.hosts ?? []).map(host => String(host).trim()).filter(Boolean),
      intent: value.intent ? String(value.intent) : undefined,
      guidance: String(value.guidance),
      questions: (value.questions ?? []).map(question => String(question)).filter(Boolean),
    },
    usage,
  };
}
