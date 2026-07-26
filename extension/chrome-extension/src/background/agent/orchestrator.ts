import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';
import { fetchWithTimeout, withTimeout } from '../net';
import { scrubPii, piiVaultSize } from './pii';

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
  /** collect (stepwise only): items the navigator read off the SCREENSHOT.
   * Plain strings, or — when a deliverable table is defined — objects whose
   * keys are the table's columns; fields merge into the named row. */
  items?: Array<string | Record<string, string>>;
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
{"do":"clear_focused"}  (empty the text field/composer that currently has focus — the way to remove a bad draft or leftover text before retyping. Focus it first. Text surfaces only — in a spreadsheet grid, select the cells and press Delete instead)
{"do":"key","combo":"Enter"}  (submit a search box after typing into it)
{"do":"scroll","direction":"down","times":2}
{"do":"extract","query":"<what to read from the page text>"}  (a local reader answers from the FULL page text; list items are stored in the collection — also the way to read more than the truncated text sample shows)
{"do":"harvest","query":"<items to collect>","until":10}  (scroll+extract loop until ~N unique items are collected or results stop yielding — for LARGE collections; the runtime deduplicates; 0 items fails the step)
{"do":"collect","items":["<one item per entry>", ...]}  (record data YOU can read on the SCREENSHOT into the collection — the RELIABLE way to capture what you can see: posts, names, rows. Write each item complete and already formatted for its destination. Text extraction is garbled on some sites; your own eyes are not. Use extract/harvest only for content beyond the visible screenshot or for large lists. When a DELIVERABLE TABLE is defined, use OBJECT items keyed by its columns — {"do":"collect","items":[{"name":"Acme","website":"acme.com"}]} — fields merge into the named row.)
{"do":"wait","ms":2000}  (the page is visibly still loading — look again after a pause)
Targets are element DESCRIPTIONS (visible text labels), resolved on the live page by label matching with a vision fallback — never invent element indices.

SIDE EFFECTS — a step that posts, sends, submits a form, purchases, or deletes MUST carry "sideEffect": true. The runtime gives such steps exactly ONE attempt and will refuse a blind re-issue: if a side-effect's outcome is unclear, your next move is to LOOK for its result (navigate to where it would be visible, extract), never to do it again. Clicks that merely OPEN something — a post to read it, a reply/comment control that opens a composer, a menu, a dialog — carry "sideEffect": false. When the runtime rejects a step asking for this declaration, re-issue the SAME step with the "sideEffect" field added — never re-issue it unchanged.

WRITING COLLECTED DATA — the ONLY correct form is exactly this:
{"do":"type_focused","textFrom":"collected","text":"Title\\tSource"}
The RUNTIME appends every collected item below the optional "text" (a header line at most), complete and verbatim, after a quality pass that drops off-target items. Two forbidden variants, both live failures:
- "text" must NEVER carry data rows or placeholder/template rows ("Article 1\\tSource 1"...) — the runtime does NOT fill templates; placeholders land on the page literally (a sheet came out full of "Article 3 / Source 3").
- Hand-typing the real items into "text" is equally wrong: your journal view of them is TRUNCATED — hand-typed data comes out cut mid-word and duplicated, while the collection held every item complete.
Have harvest/extract/collect record each item ALREADY IN THE FORM it should appear at the destination (tab-separated only where tabs are meaningful, e.g. a spreadsheet grid).
The collection is INTERNAL runtime state, not something on the page — the journal already shows every recorded item and the running total. Never spend a step extracting or re-reading the page to "verify the collection"; extract reads the PAGE, and on many sites returns garbled text that only muddies what the collection holds cleanly.

Canvas-rendered editors (e.g. Google Docs/Sheets) render input literally, not as markup — type into them with type_focused (they focus themselves when opened; clicking around first can steal focus). type_focused INSERTS at the focus — it does NOT clear existing content; if the editor/composer already holds content you did not intend this turn — a failed earlier attempt, or a leftover draft from a previous session (recurring runs revisit the same pages) — restore a clean state first (in a text field or composer: clear_focused, then retype; in a grid: select the cells and press Delete — never select-all in a grid, it selects cells, not text). Composing on top of an unnoticed draft sends doubled text.`;

const NEXT_SYSTEM_PROMPT = `You are the navigator for a browser agent. You work ONE step at a time: a deterministic runtime executes each step you decide against the user's active tab, then returns to you with a fresh SCREENSHOT of the tab, a page digest, and the journal. Local models handle perception details (locating elements to click, bulk-reading page text); you make every decision.

You are given: the OBJECTIVE, STEPS USED plus TIME REMAINING, sometimes an ACTIVE STRATEGY (standing orders from a deeper strategic review — always follow it), sometimes SITE PLAYBOOKS (proven notes on how the sites involved actually work — strong priors that spare you rediscovering routes and traps, but the live page always wins: if the screenshot contradicts a note, trust the screenshot), LAST ACTION (the step just executed and what the executor reported), CURRENT PAGE (url, title, visible element labels, truncated page-text sample), the JOURNAL (chronological history: every step, your judgment of it, and data collected), and the SCREENSHOT of the tab as it looks right now.

YOUR FIRST JOB EVERY TURN IS TO JUDGE. Look at the screenshot and state what you actually see and what the LAST ACTION accomplished — as evidence, not hope: "the composer is open and empty", "the post now appears at the top of the feed", "a dialog is asking to confirm deletion", "the page is still loading". Then rule the last action succeeded, failed, or uncertain. Judge ONLY from visible evidence; wanting it to have worked is not evidence. If the page looks mid-load (spinners, blank regions), say so and prefer a short {"do":"wait"} over guessing.

YOUR SECOND JOB IS TO DECIDE the single next step that most directly advances the objective from the page as it ACTUALLY is.

Reply ONLY with a JSON object:
{"assessment":"<1-2 sentences: what the screenshot shows and what the last action did>","last_action":"succeeded"|"failed"|"uncertain"|"none","decision":"step","why":"<one line: what this step accomplishes>","step":{...}}
Add "stuck": true to your reply when you notice you are CIRCLING — repeating variations of an approach that keeps not working (a control that reverts, results that stay empty, the same page state recurring). A deeper strategic review will then chart a different route; flagging early beats burning turns.
Other decisions (same JSON shape, with assessment and last_action always present):
"done" — the screenshot/journal show the objective FULLY delivered (every part of it — including any cleanup the user asked for). Your assessment must state the visible evidence.
"stop" with "reason" — ONLY when the page POSITIVELY shows a blocker only the user can clear (a visible login form, a CAPTCHA) AND the blocked site is REQUIRED by the objective — the user named it, or it holds the user's account or data. A blocker belongs to a SITE, not the objective: when the site is merely one possible source for the data, a wall there is a dead end to route around — journal it and navigate to an alternative source instead. A disabled control or an odd page is a precondition to satisfy, not a blocker.
"clarify" with "questions":[1-3] — first decision only, and only when no reasonable default exists.
"chat" — the message is conversation, not a browser task (first decision only).

${NEXT_STEP_FORMS}

Decision rules:
- THE CURRENT PAGE IS WHERE THE BROWSER HAPPENS TO BE — an observation, not a license to act here. If the objective implies a destination or a fresh action, navigate to the canonical surface for it.
- DISAMBIGUATE CLICK TARGETS. A short label often matches several elements (a nav item and a per-item button can share a name — clicking the wrong "More" opens the wrong menu). When that risk exists, describe the target by label AND place/role: "the ··· More button on the post", "the Post button inside the composer", "the Delete item in the opened menu". Never name a target by the glyph drawn on it — icon rails and avatar lists are full of look-alike letters, and "K" clicks whichever one matches first (live failure 2026-07-25: three clicks aimed at a server icon named "K" landed on a different server); use the element's full accessible name plus its place ("the Koretex server icon in the left server rail"). And READ THE EXECUTOR'S REPORT: it echoes what was actually hit — when the hit label is not the thing you aimed at, the click landed on the wrong element; re-aim with a more specific description instead of blaming the page.
- Prefer the most direct, deterministic route the web offers: a URL that encodes the query beats typing into a search box; after typing into a search box, the next step is {"do":"key","combo":"Enter"}.
- When searching for a CLASS of things, translate the class into concrete queries that will actually match (role-class → real titles; combine the user's qualifiers). Searching for the wrong thing poisons everything downstream.
- When an action fails, your judgment of WHY (from the screenshot) drives the fix: a different control, a different route, an unmet precondition. Never re-issue an action you have judged failed twice unchanged.
- A step that redoes work a failed attempt may have PARTIALLY completed must first restore a clean state (select-all/clear before retyping; close a half-open dialog). The same applies to leftovers you did not create: a composer that already shows a draft on arrival must be cleared (or the draft accounted for) before typing into it.
- EVIDENCE OF DELIVERY MUST BE FRESH — FROM THIS RUN. Pages can already show near-identical artifacts of earlier occurrences (recurring schedules, retried tasks): a message/post/row matching your objective that was already there when you arrived proves NOTHING about this run. A send/post/submit is delivered only when the screenshot shows ITS OWN result: the new item at the newest position bearing the current time, and the composer/form cleared. Text still sitting in the composer means NOT SENT — press the send control; typing alone delivers nothing.
- TO CONFIRM whether content exists beyond the visible screenshot (a saved row, an older post), use extract — absence from the digest or a scrolled-away screenshot is not evidence of absence.
- A READING objective (summarize, analyze, "get a feel", review, compare content) is delivered by DATA: record what you read via collect AS YOU GO — scrolling without collecting gathers nothing, and "done" on a reading objective is supported only when the collection holds the evidence.
- COLLECT ONLY WHAT IS VISIBLE. A recorded item carries exactly what the screenshot or page shows — never a field you inferred (a guessed domain like "<name>.com" is fabrication, not data; so is a category or amount the page never stated). A field the page does not show stays missing until some page shows it. And a claim from an AI-generated summary (a search engine's AI overview) is HEARSAY — usable as a lead, but an item built solely from it should be verified against a real page or reported with that caveat.
- COLLECT ONLY GENUINE MATCHES. Record an item only when its visible details satisfy EVERY qualifier the objective states (the right role, the right place, the right kind) — search results mix in near-misses, and a recorded near-miss is not progress: a quality pass drops non-matching items before delivery, so rows that don't qualify never count toward a target, they only inflate the table until they vanish (live failure 2026-07-22: 15 recorded, 11 dropped at delivery, 4 delivered). When you judge an on-screen entry non-matching, do not record it.
- A SOURCE IS EXHAUSTED only when EVERY screenful has been read — reaching the bottom via multi-screen scroll jumps skips content in between and proves nothing (live failure: a x3-jump pass "reached the bottom" having rendered 52 of ~101 cards). On a full-list objective, scroll ONE screenful at a time and record after every scroll; when you declare done, the runtime verifies exhaustion with its own screen-by-screen sweep and REJECTS the done if that sweep finds items you missed. A genuinely exhausted source is DONE for that source whatever count its header advertises ("119 speakers" is the site's claim; what the page renders is the truth) — state the rendered and advertised counts in your assessment.
- A SECTION LABELED "FEATURED", "HIGHLIGHTED", "TOP", or "SELECTED" is a curated SUBSET by definition — a full-list objective ("all speakers", "the complete list", "every product") is NEVER satisfied from such a section alone. Treat it as evidence a fuller list exists elsewhere (a directory page, an "all"/"view all" link, a sitemap, a web search for the dedicated page) and keep hunting; deliver a featured subset only as an explicitly-labeled partial when every fuller route is exhausted.
- A deliverable with PER-ITEM FIELDS ("names AND websites", "title, company and email") is complete only when EVERY item carries EVERY required field. When collected items lack a field, the route is PER-ITEM ENRICHMENT: one quick, direct lookup per item (e.g. search "<company> official website" and read the result), item by item — NOT another hunt for a single source that lists everything at once. Before declaring done on such a deliverable, COUNT against the LEDGER — read the collected items and state in your assessment exactly how many carry every required field ("7 of the 10 items have a website"); a count below the target means NOT done while time remains. Vague claims ("several are verified") are not a count — a done backed by one is rejected (live failure 2026-07-22: done declared citing "verified websites" for six items whose ledger entries had none).
- AFTER A TYPE STEP, compare the text now visible in the field against the text the journal shows was typed. A cut-off start or missing leading characters (editors sometimes swallow the first keystrokes while gaining focus) means the step FAILED even though text is present — clear_focused, then retype; never leave truncated text to be submitted.
- When COMPOSING text meant to sound like a specific person (the user's voice, a reply "in my style"), imitate the VERBATIM examples in the collected items — match their typical length, tone, and register. Never draft generic prose that ignores the examples the run collected.
- A SUPERLATIVE objective (cheapest, best, fastest, latest, top N) is a claim about a WHOLE SET, provable only two ways: the list explicitly sorted by that attribute, or every candidate read. The top of a list sorted any OTHER way (a "Best"/"Recommended"/relevance default) proves nothing about the superlative — sort by the attribute first (sites usually offer it), or enumerate, and only then is "done" supported. And the set spans EVERY dimension the objective ranges over: "cheapest this week" compares ALL the week's days, not one representative date (live failure: one day searched, six silently dropped). Prefer a surface that shows the whole range at once when the site offers one.
- SITE DEFAULTS ARE THE SITE'S GUESS, NOT THE USER'S INTENT. Pages arrive pre-filled — dates a search defaults to, an origin city from geolocation, whichever account is signed in. Check every pre-filled parameter that defines the deliverable against the OBJECTIVE (resolving relative dates against TODAY'S DATE) and SET the ones that disagree before reading results; results computed from an unchecked default answer the site's question, not the user's.
- A message that CONTRADICTS a previous answer ("there's a cheaper one at $X", "that's wrong") is evidence the previous answer failed — a correction task. Re-verify against the live page (sort, open, read as the claim requires) before deciding "done"; the user's value merely being visible on screen is not verification, and agreeing without fresh evidence is a failure, not a delivery.
- Never plan logging in or handling credentials — if a login wall appears, stop.
- NEVER INVENT DATA INTO A FORM. Form fields are filled ONLY with values the user or the objective actually provided. Fabricating an email, name, or phone number to get past a lead-capture, signup, download, or newsletter gate is forbidden (live failure 2026-07-22: a made-up email was submitted to an email-gated list) — email-gated content is a WALL on a fungible source: leave and get the data from an open source instead. Any form submission is a side effect: sideEffect true.
- TO ADD A FIELD to an item already on the LEDGER (e.g. the website just found for a collected company), record ONE line that STARTS WITH THE SAME NAME as the ledger line and carries the new field ("Flagright — flagright.com") — the runtime merges it into that item, upgrading it in place. Never re-record an unchanged item, and never record a found field without the item's name in front of it.
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

STEP BACK AND THINK DEEPLY. Diagnose the ROOT CAUSE — not "the click failed" but why the whole approach is not working: a capability gated behind a paywall or upsell (a control that reverts or is blocked by an upgrade prompt is UNAVAILABLE on this account — route around it, never fight it), the wrong surface for the goal, a search phrased so it matches nothing, a page that requires state the run never established. Then chart a DIFFERENT route to the objective — the web usually offers several: keywords in the query instead of UI filters, a URL that encodes the search, a different page or surface, a simpler deliverable path. When items are already collected but a required per-item field is missing (websites for named companies, emails for named people), the route is PER-ITEM ENRICHMENT — one direct lookup per item — never another search for a single source that lists everything at once. Never propose retrying what the journal shows failing repeatedly. Prefer routes that need fewer privileged features. Respect the remaining time: a simple route that delivers a partial beats an elegant long one.

Reply ONLY with a JSON object:
{"diagnosis":"<root cause, 1-2 sentences>","verdict":"strategy","strategy":"<standing orders for the navigator: what to do INSTEAD and what to STOP attempting — concrete, 1-3 sentences>"}
{"diagnosis":"...","verdict":"done"}  — the journal and screenshot show the objective is ALREADY fully delivered. For a SUPERLATIVE objective (cheapest/best/fastest/top N), "delivered" requires the journal to show the candidate set was sorted by that attribute or exhaustively read — one visible candidate from a differently-sorted view does not prove a superlative.
{"diagnosis":"...","verdict":"blocked","reason":"<what only the user can do>"}  — ONLY for walls no strategy can route around: a login wall or CAPTCHA on a site the objective REQUIRES (the user named it, or it holds the user's account or data), or the capability fundamentally missing everywhere. A wall on a FUNGIBLE source is NOT a blocker — the same data lives elsewhere on the open web; that is a "strategy" verdict routing to an alternative source, with the walled site noted as dead for this run.

BATCH LOOP (optional, alongside verdict "strategy", ONLY while a DELIVERABLE TABLE is in force): when the remaining work is one UNIFORM read-only lookup per row — the same search, the same field, only the row's name changing — add "batchLoop" and the runtime executes it mechanically (navigate → read → fill cell, one iteration per row, no per-step decisions). This is dramatically faster than stepping through rows one decision at a time, so PREFER it whenever 3+ rows lack the same column and a uniform lookup would fill it:
{"verdict":"strategy","strategy":"...","batchLoop":{"urlTemplate":"https://duckduckgo.com/?q={name}+official+website","fillColumn":"website","maxIterations":15}}
Rules: urlTemplate is a search-engine or public listing URL containing {name} EXACTLY once (the runtime substitutes each row's name, URL-encoded); fillColumn is one of the table's columns; the loop only READS pages — it never clicks, types, or submits — only fills EMPTY cells of that one column, skips rows the page cannot answer, and aborts back to normal stepping on walls or repeated failures. Never emit it for work that varies per row or needs interaction.

DROP ROWS (optional, alongside verdict "strategy", table mode): when the table holds rows that do NOT belong — wrong sector, wrong funding round, junk names, off-objective items — return "dropRows":["<row name>", ...] and the runtime DELETES them (this is the ONLY way rows are removed; instructing the navigator to "clear" rows does nothing). Prune aggressively when the table is polluted: machinery downstream (completeness counts, batch loops, the done gate) runs on these rows, so junk rows are load-bearing, not cosmetic.`;

export interface ReviewResult {
  diagnosis?: string;
  verdict: 'strategy' | 'done' | 'blocked';
  strategy?: string;
  reason?: string;
  /** Codified per-row lookup the harness executes mechanically (schema mode) */
  batchLoop?: { urlTemplate?: string; fillColumn?: string; maxIterations?: number };
  /** Row names to DELETE from the deliverable table (schema mode) */
  dropRows?: string[];
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
  /** Rendered agent memory (memory.ts) — long-term learnings across runs */
  memory?: string;
  stuckSignal: string;
  timeRemainingMin?: number;
}

// Pinned into judge-facing prompts whenever the PII vault holds tokens. The
// guard pseudonymizes TEXT but screenshots show real values — without this
// note the judge compares on-screen reality to the token and fails correct
// steps (live Gmail run 2026-07-18: the correctly-typed recipient was judged
// "wrong email" twice because the screenshot could not match ⟨email-2⟩).
// The model has no clock: without this line "this week"/"tomorrow" resolve
// against whatever dates a site happens to default to (live failure
// 2026-07-21: "this week" was answered with Google Flights' default dates a
// month out — the judge inferred "today" from the page). Pinned into every
// reasoning call's context.
const todayLine = (): string => {
  const now = new Date();
  const formatted = now.toLocaleDateString('en-AU', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `\nTODAY'S DATE: ${formatted} (user's local time) — resolve every relative time phrase ("this week", "tomorrow", "next month") against THIS date, never against dates a website shows or defaults to.`;
};

// AGENT MEMORY — the long-term memory distilled after every run (storage
// agentMemoryStore): who the agent is, what the user typically wants, and
// approach-level lessons. Pinned into the strategic tier (kickoff, review,
// report) — NOT the per-step navigator: the opening strategy carries any
// relevant preference into the loop, and the memory would otherwise ride on
// every one of up to 150 cheap calls.
const memorySection = (memory?: string): string =>
  memory
    ? `\n\nAGENT MEMORY (durable notes distilled from this agent's past runs — the user's context and preferences, and lessons on what has and hasn't worked; fold them in: prefer approaches memory shows working, avoid ones it shows failing, and apply the user's standing preferences without re-asking):\n${memory}`
    : '';

// The model has no idea what OS drives the browser — and application
// keyboard shortcuts differ by platform (live Discord failure 2026-07-25:
// the quick switcher is Cmd+K on macOS; two Ctrl+K presses no-oped and the
// run died navigating by rail-icon clicks instead). Same class of blindness
// as the missing date, same fix: state the fact in every reasoning call.
// getPlatformInfo resolves in ms at service-worker start; '' until then.
let platformOs: string | null = null;
chrome.runtime
  .getPlatformInfo()
  .then(info => {
    platformOs = info.os;
  })
  .catch(() => {});
const platformLine = (): string =>
  platformOs === 'mac'
    ? '\nBROWSER OS: macOS — web-app keyboard shortcuts use Cmd (the Meta key), NOT Ctrl: a quick-switcher/search shortcut is Meta+k, select-all is Meta+a. Ctrl+<letter> is usually a silent no-op in web apps on macOS.'
    : platformOs
      ? `\nBROWSER OS: ${platformOs === 'win' ? 'Windows' : platformOs} — web-app keyboard shortcuts use Ctrl.`
      : '';

const pseudonymSection = (): string =>
  piiVaultSize() > 0
    ? `\n\nPSEUDONYM TOKENS IN FORCE: a local privacy guard replaced identifiers (emails, phone numbers, card numbers) with tokens like ⟨email-1⟩ in the objective and journal. Tokens never reach the page: when a step types a token, the runtime types its REAL value, and the screenshot always shows real values. A real identifier of the matching type, visible where a token was typed or expected, IS that token's value — judge such steps by type and position, never by comparing visible text against the token, and never retype or "fix" a value because it differs from the token text.`
    : '';

export async function strategicReview(
  args: ReviewArgs,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: ReviewResult; usage: CallUsage }> {
  // Strategic tier runs on the strongest reasoning model (strategistModel,
  // empty = orchestratorModel) — NOT the cheap per-step navigator: reviews
  // are where reasoning quality decides the run (live 2026-07-21: navigator-
  // model reviews fixated on a "one perfect source" constraint for 25 steps).
  // FALLBACK CHAIN (live 2026-07-22: GLM 5.2 review calls failed silently and
  // a run died in 6 steps): strategist+screenshot → strategist text-only →
  // the multimodal navigator, the config every review ran on before.
  const { strategistModel, navigatorModel } = await chatSettingsStore.getSettings();
  const content =
    `OBJECTIVE: ${args.objective}` +
    todayLine() +
    platformLine() +
    pseudonymSection() +
    memorySection(args.memory) +
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
  const callReview = (modelOverride: string | undefined, withImage: boolean) =>
    callOrchestrator<ReviewResult>(REVIEW_SYSTEM_PROMPT, content, signal, onProgress, {
      imageDataUrl: withImage ? args.screenshotDataUrl : undefined,
      modelOverride,
      deepReview: true,
    });
  const strategist = strategistModel?.trim() || undefined;
  let value: ReviewResult;
  let usage: CallUsage;
  try {
    ({ value, usage } = await callReview(strategist, true));
  } catch (firstError) {
    if (signal.aborted) throw firstError;
    try {
      // A text-only strategist model rejects the image part — the digest and
      // journal carry the diagnosis; retry without the screenshot
      ({ value, usage } = await callReview(strategist, false));
    } catch (secondError) {
      if (signal.aborted) throw secondError;
      // Last resort: the multimodal navigator with the screenshot — a review
      // from the proven config beats no review at all
      ({ value, usage } = await callReview(navigatorModel?.trim() || undefined, true));
    }
  }
  if (!['strategy', 'done', 'blocked'].includes(value.verdict)) {
    throw new Error(`Strategist returned invalid verdict: ${String(value.verdict)}`);
  }
  return { result: value, usage };
}

// ---- DONE AUDIT (a supervisor sign-off at the finish line) ----
// The navigator declared the objective met. A second, stronger model checks
// that claim against the FULL collected ledger before the run reports —
// specifically the failure the navigator keeps making: declaring done while
// per-item fields are missing (live 2026-07-22: "done" citing "verified
// websites" for items whose ledger entries had none). Cheap, text-only, one
// call; page-blind by design (the ledger is the evidence, not the screen).
const DONE_AUDIT_SYSTEM_PROMPT = `You are the final checkpoint before a browser agent delivers its answer. The agent believes the objective is COMPLETE. You get the OBJECTIVE and the COLLECTED ITEMS (the complete ledger of data gathered). Decide whether the ledger genuinely satisfies the objective — do NOT be generous, this is the last guard against an incomplete answer.

Reply ONLY with a JSON object: {"complete": true|false, "reason": "<one line>"}

- PER-ITEM FIELDS: if the objective asks for fields per item (names AND websites, title AND email), the ledger satisfies it only when enough items carry EVERY required field. Count them. "10 companies with websites" needs 10 items that each actually have a website — items with a name but no website do NOT count toward the total.
- COUNT: if the objective names a number (10 companies), at least that many fully-qualified items must be present.
- When incomplete, "reason" states exactly what is missing and points at the fix ("only 3 of 10 items have a website — look up the website for each of the remaining 7"). This becomes the agent's next instruction, so make it actionable.
- When the objective has no per-item fields or count (a summary, a single fact, an action), judge whether the ledger holds the substance asked for; if it plainly does, complete:true.`;

export async function auditDone(
  objective: string,
  collection: string[],
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: { complete: boolean; reason: string }; usage: CallUsage }> {
  const { strategistModel, orchestratorModel } = await chatSettingsStore.getSettings();
  const ledger = collection.map((item, i) => `${i + 1}. ${item.slice(0, 240)}`).join('\n');
  const content = `OBJECTIVE: ${objective}\n\nCOLLECTED ITEMS (the full ledger):\n${ledger || '(empty)'}`;
  const { value, usage } = await callOrchestrator<{ complete?: boolean; reason?: string }>(
    DONE_AUDIT_SYSTEM_PROMPT,
    content,
    signal,
    onProgress,
    { modelOverride: strategistModel?.trim() || orchestratorModel || undefined, deepReview: true },
  );
  return { result: { complete: value.complete === true, reason: (value.reason ?? '').trim() }, usage };
}

// ---- KICKOFF (strategic review #0 — intent before the first action) ----
// The per-step navigator takes objectives literally (live failure 2026-07-20:
// "decision makers" was typed verbatim into LinkedIn search; the run only got
// smart after a mid-run review earned the same insight 14 steps in). One
// reasoning-ON call BEFORE the loop interprets the intent, sets the OPENING
// active strategy, or asks the user. Deliberately blind to the page: it
// charts intent and approach, never page mechanics — the navigator still
// decides every step from the live screenshot, and later strategic reviews
// supersede this strategy freely. Triage is folded in ("proceed" for trivial
// or conversational objectives) instead of a separate complexity call.
const KICKOFF_SYSTEM_PROMPT = `You are the strategist for a browser agent about to start a task. The fast per-step navigator will decide one step at a time from live screenshots; you run ONCE, before it starts, so it begins thoughtfully instead of literally.

THINK about what the user actually WANTS — the intent behind the words — and how a capable operator would approach it. Translate class phrases into the concrete terms a website can act on (e.g. "decision makers" means concrete titles — CEO, CTO, Managing Director, Founder — the literal phrase must never be typed into a search box; "cheap flights" means specific dates, routes and a sort order). Consider which site or surface fits the goal, what "done" looks like, and the first move. For gathering public data (facts, lists, research not tied to the user's accounts), prefer OPEN surfaces — a search engine, news sites, public pages — over specialist databases that gate or bot-wall anonymous visitors; a walled database is a last resort, never the opening move, and no single source is load-bearing when the data lives in many places. Order the approach by DEPENDENCY: work the source before the destination — gather data before opening the place it will be written to. If SITE PLAYBOOKS are provided, fold their proven routes into the approach. If AGENT MEMORY is provided (durable notes from past runs), let it shape the approach: reuse what it shows working, avoid what it shows failing, and honor the user's standing preferences without re-asking — but the OBJECTIVE always outranks memory when they conflict.

When the objective CONTRADICTS or corrects something previously delivered (the user reports a different or better value than the last answer), treat it as evidence the previous answer was WRONG: the task is to re-verify on the live page and deliver a corrected, confirmed answer — never to agree with the user's claim without fresh evidence. And a superlative goal (cheapest, best, latest) is settled by SORTING by that attribute or reading every candidate — over the FULL range the objective spans ("this week" means all its days, not one date). Fold that into the approach.

Stay inside the ERRAND the user actually gave. Interpretation sharpens the objective's own terms — it never adds a new kind of action: an objective that provides data to enter somewhere is a data-entry task, not an instruction to send, post, or share that data with anyone, and no playbook's presence makes it one. When a USER'S CURRENT PAGE is given and the objective points at it deictically ("this page", "this form", "here") or names no other destination, that page IS the target — the approach starts by navigating to its URL.

Reply ONLY with a JSON object, one of:
{"verdict":"strategy","strategy":"<opening orders for the navigator: the interpreted intent, the approach, and the first move — at most 4 sentences. Intent and approach only, NEVER page mechanics or numbered step lists: you have not seen the page.>","deliverable":{"columns":["name","website"],"target":10}}
{"verdict":"proceed"}  — the objective is conversational, or so direct that interpretation adds nothing (e.g. "open example.com").

"deliverable" (optional, strategy verdict only): when the objective's output is a SET OF ITEMS WITH FIELDS (companies with websites, people with title and email, products with prices), declare the table: 2-6 short lowercase column names, the FIRST column being the item's identifying name, and "target" ONLY when the objective names a count ("10 companies" → 10). An OPEN-ENDED objective ("the full list", "all speakers", "every item") has NO target — OMIT the field entirely; never invent a round number, the collection completes when the source runs dry (the runtime drops any target the objective does not name). The runtime then maintains the table, computes completeness per row in code, and refuses "done" until the target is met — this is the backbone of the run, so declare it whenever the deliverable is genuinely tabular. OMIT it for summaries, single facts, actions, or free-form research.
CONSTRAINTS BECOME COLUMNS: when the objective carries a PER-ITEM qualifier the search surface likely cannot filter on ("at companies with 50-200 employees", "founded after 2020", "Series A funded"), declare it as a column too (e.g. "company_size") — a constraint that is not a column is never verified: rows look complete without it, the done gate is satisfied, and the run delivers unchecked claims (live failure 2026-07-22: "50-200 employees" was stated in the objective, never became a column, and 15 people shipped with zero size checks). The strategy then reads: fill the identifying columns from the search FIRST, then verify the constraint column item by item (one direct lookup per row — a company page, a quick search); an item whose verified value violates the qualifier does not count toward the target, so seek a replacement. If the constraint proves genuinely unobtainable, the run must STILL deliver the identified items — with that column empty and reported as unverified — never withhold the data it did gather because one field could not be confirmed.
{"verdict":"clarify","questions":["<1-3 questions>"]}  — ONLY when the objective is ambiguous in a way that would change the OUTCOME and no reasonable default exists. When a sane default exists, assume it, fold the assumption into the strategy, and do not ask. Never ask about details the page will reveal anyway. A deictic objective ("this form", "this page") with NO user's current page provided is exactly this case — ask where the work should happen rather than guessing a site. So is a missing parameter that DEFINES the deliverable and only the user can supply — the origin of a journey, the account or identity to act under, the recipient of anything: a website will happily fill these with its own guess (geolocation, whoever is signed in), but the site's guess is not the user's answer — ask.`;

export interface KickoffResult {
  verdict: 'strategy' | 'proceed' | 'clarify';
  strategy?: string;
  questions?: string[];
  /** Tabular deliverable declaration — see KICKOFF prompt */
  deliverable?: { columns?: string[]; target?: number };
}

export interface KickoffArgs {
  objective: string;
  /** The page the user was viewing when they sent the task — the referent of
   * deictic objectives ("this form"), which the agent window can't see */
  currentPage?: string;
  /** Rendered site playbooks whose intent-trigger matches the objective */
  skills?: string;
  /** One-line index of the user's other playbooks */
  skillCatalog?: string;
  /** Rendered agent memory (memory.ts) — long-term learnings across runs */
  memory?: string;
  timeBudgetMin?: number;
  /** Clarify-resume: the user already answered questions — forbid asking more */
  noClarify?: boolean;
}

export async function kickoffStrategy(
  args: KickoffArgs,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: KickoffResult; usage: CallUsage }> {
  // Same strategic tier as reviews: strongest reasoning model, page-blind
  // by design so a text-only model loses nothing here. Same fallback as
  // reviews: a failed strategist call retries on the navigator model.
  const { strategistModel, navigatorModel } = await chatSettingsStore.getSettings();
  const content =
    `OBJECTIVE: ${args.objective}` +
    todayLine() +
    (args.currentPage
      ? `\nUSER'S CURRENT PAGE (the tab the user was viewing when they sent the task — the referent of "this page"-style objectives): ${args.currentPage}`
      : '') +
    platformLine() +
    pseudonymSection() +
    memorySection(args.memory) +
    (args.timeBudgetMin !== undefined ? `\nTIME BUDGET: about ${args.timeBudgetMin} minute(s)` : '') +
    (args.skills
      ? `\n\nSITE PLAYBOOKS (proven notes for the sites this task likely involves — fold their routes into the approach):\n${args.skills}`
      : '') +
    (args.skillCatalog
      ? `\n\nOTHER PLAYBOOKS THE USER HAS (one line each — if one covers the objective, route the approach through its site):\n${args.skillCatalog}`
      : '') +
    (args.noClarify
      ? '\n\nThe user has ALREADY answered clarifying questions — "clarify" is not available. Reply with "strategy" or "proceed".'
      : '');
  const callKickoff = (modelOverride: string | undefined) =>
    callOrchestrator<KickoffResult>(KICKOFF_SYSTEM_PROMPT, content, signal, onProgress, {
      modelOverride,
      deepReview: true,
    });
  let value: KickoffResult;
  let usage: CallUsage;
  try {
    ({ value, usage } = await callKickoff(strategistModel?.trim() || undefined));
  } catch (error) {
    if (signal.aborted) throw error;
    ({ value, usage } = await callKickoff(navigatorModel?.trim() || undefined));
  }
  if (!['strategy', 'proceed', 'clarify'].includes(value.verdict)) {
    throw new Error(`Kickoff returned invalid verdict: ${String(value.verdict)}`);
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
  /** Multi-tab runs: one line per open run tab (url — title, current marked) */
  openTabs?: string;
  /** Rendered site playbooks applicable this turn (skills.ts), pinned like the strategy */
  skills?: string;
  /** One-line index of the user's OTHER playbooks (not in force this turn) */
  skillCatalog?: string;
  /**
   * A few most-recent collected items, VERBATIM (the journal's view of them
   * is truncated). Composing in someone's voice needs the real examples —
   * live failure 2026-07-20: a spot-on style analysis, then a generic draft,
   * because the drafting turn only saw a vague re-summary.
   */
  collectedSample?: string;
  /** Rendered deliverable-table status (schema mode) — replaces collectedSample */
  deliverable?: string;
  /** Screenshot of the tab as it looks now (data URL); omit if capture failed */
  screenshotDataUrl?: string;
}

// ---- SWEEP READER (harness-driven page sweep, 2026-07-23) ----
// One focused multimodal call per screenful during a runtime sweep: read
// every matching card/row visible in the screenshot into row objects. No
// judging, no deciding — transcription only. The sweep loop in stepwise.ts
// owns scrolling, deduplication, and termination.
// Field rules shared by both sweep readers (text and vision): the live
// failure they encode is one "Title, Company" line landing whole in the
// title column, leaving company empty — which spawned a 30-step repair tail
const SWEEP_FIELD_RULES = `- Each item is an object whose keys are the given COLUMNS (e.g. {"name":"...","title":"...","company":"..."}). Omit a field the source does not show for that item — never guess, infer, or approximate one.
- EACH COLUMN HOLDS ONLY ITS OWN FIELD — never merge two fields into one value, and never repeat one field's text inside another. When a card renders title and company as ONE line ("Chief Product Officer, Rubrik"), split at the LAST comma: title before it, company after it. A title must not end with the company; a company cell holds only the company.
- AVATAR-INITIALS TOKENS ARE UI ARTIFACTS, NOT DATA: cards without photos show a 1-3 letter abbreviation of the person's name ("SS" beside "Shashank Somal"), and on this page that token is part of the text. NEVER emit such a token as a field value, never let it prefix a name, and never glue it onto another field ("Reevo AG" when the card says "Reevo" is wrong).
- EACH ITEM'S FIELDS COME FROM ITS OWN CARD ONLY — when two cards sit adjacent in the text, never assign one card's company or title to its neighbor; if you cannot tell where one card ends, omit the ambiguous field.
- Include only genuine matches for the objective; skip navigation, headers, ads, and unrelated content.
- Include every matching item even if it looks like one you may have seen before — deduplication happens elsewhere. An item cut off at the edge still counts if its fields are readable.
- No matching items → {"items":[]}.`;

const SWEEP_COLLECT_SYSTEM_PROMPT = `You transcribe one browser screenshot for a data-collection agent mid-sweep. You get the OBJECTIVE and, when a table is defined, its COLUMNS. Read EVERY item (card, row, list entry) visible in the screenshot that matches the objective and transcribe its fields exactly as rendered.

Reply ONLY with a JSON object: {"items":[{...}, ...]}
${SWEEP_FIELD_RULES}
- Transcribe ONLY what is legible. A word you cannot read clearly is NOT transcribed from memory or plausibility — omit that field entirely. A wrong company name is worse than a missing one.`;

const SWEEP_TEXT_SYSTEM_PROMPT = `You parse one screenful of page text for a data-collection agent mid-sweep. You get the OBJECTIVE, the COLUMNS when a table is defined, and the TEXT extracted from the browser viewport (one line per content block — an item's fields usually share one line). List EVERY item in the text that matches the objective.

Reply ONLY with a JSON object: {"items":[{...}, ...]}
${SWEEP_FIELD_RULES}
- Copy field values VERBATIM from the text — character for character; never normalize, correct, or rephrase them.`;

export async function collectFromText(
  args: { objective: string; columns?: string[]; pageText: string },
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: { items: Array<Record<string, unknown>> }; usage: CallUsage }> {
  const { navigatorModel } = await chatSettingsStore.getSettings();
  const content =
    `OBJECTIVE: ${args.objective}` +
    (args.columns?.length ? `\nCOLUMNS: ${args.columns.join(' | ')}` : '') +
    `\n\nTEXT OF THE CURRENT SCREENFUL:\n${args.pageText}`;
  const { value, usage } = await callOrchestrator<{ items?: Array<Record<string, unknown>> }>(
    SWEEP_TEXT_SYSTEM_PROMPT,
    content,
    signal,
    onProgress,
    { modelOverride: navigatorModel || undefined, lowLatency: true },
  );
  return { result: { items: Array.isArray(value.items) ? value.items : [] }, usage };
}

export async function collectFromScreenshot(
  args: { objective: string; columns?: string[]; screenshotDataUrl: string },
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ result: { items: Array<Record<string, unknown>> }; usage: CallUsage }> {
  const { navigatorModel } = await chatSettingsStore.getSettings();
  const content =
    `OBJECTIVE: ${args.objective}` +
    (args.columns?.length ? `\nCOLUMNS: ${args.columns.join(' | ')}` : '') +
    '\n\nTranscribe every matching item visible in the screenshot.';
  const { value, usage } = await callOrchestrator<{ items?: Array<Record<string, unknown>> }>(
    SWEEP_COLLECT_SYSTEM_PROMPT,
    content,
    signal,
    onProgress,
    { imageDataUrl: args.screenshotDataUrl, modelOverride: navigatorModel || undefined, lowLatency: true },
  );
  return { result: { items: Array.isArray(value.items) ? value.items : [] }, usage };
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
  const tabsSection = args.openTabs
    ? `\n\nRUN TABS (each site this run opened lives in its OWN tab, all still open with their state intact — to return to one, decide a navigate to its URL and the runtime SWITCHES to that tab without reloading; never re-find an already-open document via a site's home page):\n${args.openTabs}`
    : '';
  const deliverableSection = args.deliverable
    ? `\n\nDELIVERABLE TABLE (maintained by the runtime — this IS the objective's output; the Status line is computed, trust it over your memory):\n${args.deliverable}\nRules: work ONLY on missing cells — a filled cell is DONE, never re-fetch it. Record data with collect using OBJECT items whose keys are the columns ({"do":"collect","items":[{"name":"Acme","website":"acme.com"}]}) — fields merge into the named row; a plain line "Acme — website: acme.com" also merges. Rows not in this table do not exist — never enrich a remembered candidate that is not listed. VALUES MUST BE THE REAL THING: eyeball the filled cells — a "website" cell holding a URL on the SOURCE site's own domain is that directory's profile page, NOT the company's website (live failure 2026-07-22: ten projectstartups.com profile URLs shipped as "websites"); such a cell counts as WRONG, and the fix is the item's own detail page ("Visit Website" opens the real site — the runtime follows new tabs) or one direct search per item. "done" is accepted only when Status meets the target AND the cells hold what the objective actually asked for.`
    : '';
  const collectedSection =
    !args.deliverable && args.collectedSample
      ? `\n\nCOLLECTED ITEMS — THE LEDGER (verbatim, unlike the journal's truncated view). This is what the run actually holds: check it BEFORE re-collecting or re-verifying anything (an item already carrying the needed field is DONE — never look it up again), and when enriching per item, work ONLY items on this list — never a candidate you remember but cannot see here. When composing text in someone's voice, imitate THESE:\n${args.collectedSample}`
      : '';
  const buildContent = (withScreenshot: boolean) =>
    `OBJECTIVE: ${args.objective}${todayLine()}${platformLine()}${pseudonymSection()}${budgetLine}${strategySection}${skillsSection}${catalogSection}${tabsSection}${deliverableSection}${collectedSection}` +
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
    'clear_focused',
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
- "stop": ONLY the user can resolve it, and the OBSERVATION positively shows the blocker (a visible sign-in form, a permission/consent prompt, a CAPTCHA) or the objective is genuinely impossible. Never infer a user-only blocker from a symptom — a control being disabled, greyed, or unresponsive is NOT evidence of one. And the blocker must sit on a site the objective REQUIRES (the user named it, or it holds the user's account or data): a wall on a site that is merely one possible source for the data blocks that SITE, not the objective — verdict "replan" toward an alternative source, with the walled site named as dead in "reason".

${STEP_FORMS}

Reason from the OBSERVATION and the journal, never from guesses — the observation tells you what the page really shows, and your diagnosis is only as good as your reading of it. If the observation says the page could not be READ (a perception/tooling problem — "could not read the page"), that is NOT evidence the step or the site failed: retry the same step (fix_step with the same action) or wait, and never conclude the site is broken or the objective impossible from a read failure. State only causes the observation actually supports; do not name a cause (e.g. "not signed in", "no permission") unless the page visibly shows it. A control that is disabled/greyed/blocked means a PRECONDITION has not been met yet — work out which earlier action would satisfy it (e.g. a submit control is inert until its input has the required content) and prefer replanning to establish that precondition over declaring the task blocked. Always consider what state the FAILED ATTEMPT ITSELF left behind: an action that failed verification may still have partially taken effect, and whatever you decide must account for those leftovers rather than blindly redoing work on top of them. Put the ROOT CAUSE in "reason" — a replan is only as good as the planner's understanding of why the last plan failed. SIDE-EFFECT RULE: if the failed step has sideEffect true, it may have taken effect even though verification failed — NEVER fix_step a repeat of that action; verdict must be replan with a verification-first approach, or stop.`;

const REPORT_SYSTEM_PROMPT = `You are writing the final user-facing answer for a browser agent run. You get the OBJECTIVE, the STATUS (achieved or partial), the JOURNAL of what happened, and the COLLECTED ITEMS (complete, deduplicated data gathered during the run).

Reply ONLY with a JSON object: {"answer": "<the answer>"}

Ground every fact ONLY in the journal and collected items — never invent data. For achieved: confirm what was done and present the results. For partial: lead with what WAS accomplished and found (list the actual data), then say briefly what could not be completed and why. If nothing useful was gathered, say so honestly in one sentence.

URLS AND IDENTIFIERS ARE OBSERVED, NEVER DERIVED. Report a URL, email address, or handle ONLY if it appears in the journal or collected items as something actually read off a page. Never construct one from a name — "Feathery" does not imply feathery.com (many real companies live on .io or an unrelated domain), and a derived URL presented as found is a fabrication (live failure 2026-07-22: four "confirmed" websites in a report were name-pattern guesses, at least two wrong). An item whose URL was never observed gets "not found" — that is an honest, useful answer.

A COUNT A PAGE ADVERTISES ("119 speakers", "200+ companies") is the site's claim, not ground truth about what the page renders. EXHAUSTION HAS A STRICT DEFINITION: the journal shows a completed runtime sweep, or repeated full passes that yielded nothing new. A single scroll-through — however far it got — is NOT exhaustion, and reaching the page bottom via large scroll jumps proves nothing about what was skipped in between (live 2026-07-23: a single x3-jump pass delivered 52 of a page that renders ~101, framed as "the page renders 52"). Only when the journal meets that strict definition and the collection still holds fewer items than the advertised count is the collection the complete result: report "the page renders N items (the page's own header claims M)", present the data as delivered, and note the discrepancy in one sentence without speculating about the missing items. When exhaustion was NOT verified, a shortfall against the advertised count is honestly a partial — say what was collected and that the rest of the page was not fully read.

A journal with NO executed steps means the run performed NO actions — never describe navigation, clicks, tab switches, or changes as having happened (live failure 2026-07-20: a zero-step run's answer claimed "I opened the Posts with replies tab"). Report only what was observed and, if the objective needed actions, that none were performed.

Distinguish PROVEN from UNKNOWN. A verified step or an extract's answer is evidence; a failed VERIFICATION is only evidence that the check did not pass — NOT proof the action had no effect (side-effecting actions often land despite a failed check). If the journal never confirms a side-effect's outcome either way, do not assert it succeeded OR failed — say its outcome is unconfirmed and tell the user exactly what to check.

When the run WROTE content somewhere (a doc, sheet, post), report what the journal shows was ACTUALLY written and judged on screen — never re-derive that list from the collected items. The collection accumulates everything sighted during the run, including candidates that were later dropped; describing collection items as the delivered content misstates what the user will find.

SURFACE OBSERVED ALTERNATIVES. When the journal shows the run SAW a materially better option just outside the user's constraints (a far cheaper fare that has one stop when the user asked for direct), honor the constraint in the answer, then note the alternative in one sentence ("the only direct flight is $720; if you'd accept one stop, fares start at $479"). Only alternatives the journal actually records — never speculate that better options might exist.

SCOPE SUPERLATIVES to their evidence. Claim "the cheapest/best/fastest X" ONLY when the journal shows the candidates were sorted by that attribute or exhaustively read; otherwise say exactly what was compared ("the cheapest among the results shown, sorted by Best") — an honest scope beats a confident overclaim. And when the objective was a CORRECTION of a previous answer, never rubber-stamp it: "confirmed" requires the journal to show fresh verification of the user's claim, and the answer should plainly acknowledge that the earlier answer was wrong before giving the corrected one.`;

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
type MessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

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
    priceCap = true,
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
      // The ceiling is tuned for the cheap-navigator class — a model whose
      // every host exceeds it 404s ("No endpoints found that satisfy the max
      // price", live failure 2026-07-22 on qwen3.5-122b and GLM 5.2 reviews)
      // — so `request` below retries once WITHOUT the cap (default routing).
      provider: {
        data_collection: 'deny',
        ...(priceCap && (opts?.lowLatency || opts?.deepReview || opts?.prose)
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
          'HTTP-Referer': 'https://github.com/koretex-ai/koretex-browser-agent',
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
      if (signal.aborted) throw error;
      // Price-ceiling miss: the model has no host under the cheap-tier cap —
      // a model-tier mismatch, not a transient fault. Retry without the cap.
      const message = error instanceof Error ? error.message : String(error);
      if (/max price|No endpoints found/i.test(message)) {
        logger.warning('no host under the price ceiling for this model — retrying without the cap');
        return attemptRequest(messages, false);
      }
      if (!isTransientNetworkError(error)) throw error;
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
  const sum = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
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
    `OBJECTIVE: ${objective}${todayLine()}\n\nPLANS USED: ${plansUsed} of ${maxPlans}` +
    pageSection +
    journalSection(journal);
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

Rules: return kept items EXACTLY as given (same text, same field separators — do not reformat, do not add or invent fields). Drop items that clearly do not match the objective (wrong role, wrong location, off-topic, obvious duplicates, junk). If the objective asks for N items and more than N genuinely qualify, keep the N best. COMPLETENESS BREAKS TIES: when the objective names per-item fields (a name AND a website, a title AND an email), an item carrying every required field beats an equally on-target item missing one — never drop a field-complete item while keeping an incomplete one (live failure 2026-07-22: a verified-website company was dropped while eight unverified ones were kept). When duplicates describe the same entity, keep the one with the most fields filled. If you cannot tell whether an item qualifies, KEEP it (better a borderline include than dropping real data). Never fabricate items.

DROP ONLY FOR FAILING THE OBJECTIVE'S QUALIFIERS — NEVER for a missing, odd, or unverifiable cell. An item on the requested list whose source genuinely shows no value for one field is still a genuine item (a conference speaker whose card omits the company is still a speaker); dropping it deletes real data the run worked to collect (live failure 2026-07-23: a speaker recovered by a dedicated second pass, plus another genuine speaker, were silently dropped at curation — the final table contradicted the run's own narrative). Incompleteness is reported, not culled.`;

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
  opts?: { runtimeTable?: boolean; memory?: string },
): Promise<{ answer: string; usage: CallUsage }> {
  const collectionSection = collection.length
    ? `\n\nCOLLECTED ITEMS (complete, deduplicated):\n${collection.slice(0, 100).join('\n').slice(0, 8000)}`
    : '';
  // Schema runs: the deliverable table is appended by the RUNTIME, straight
  // from its row store — a model-retyped table silently drops rows when the
  // output budget runs out (live 2026-07-23: 107 curated rows, the reply
  // truncated at exactly 100 and narrated "collected 100 speakers" as fact)
  const tableNote = opts?.runtimeTable
    ? `\n\nNOTE: the deliverable TABLE is rendered by the runtime directly from its row store and appended below your answer automatically. Do NOT reproduce the table or enumerate the collected items — write ONLY the narrative: what was done, where the data came from, the EXACT row count as given above, and any caveats (missing cells, rendered-vs-advertised count discrepancies).`
    : '';
  const userContent =
    `OBJECTIVE: ${objective}${todayLine()}\n\nSTATUS: ${status}` +
    memorySection(opts?.memory) +
    journalSection(journal) +
    collectionSection +
    tableNote;
  const { value, usage } = await callOrchestrator<{ answer: string }>(
    REPORT_SYSTEM_PROMPT,
    userContent,
    signal,
    onProgress,
  );
  if (!value.answer) throw new Error('Report returned no answer');
  return { answer: value.answer, usage };
}

// ---- DISTILL (recorded steps → skill draft) ----
// Turns a record of a task being performed — a hand demonstration the user
// recorded, or the journal of a successful agent run — plus notes into a
// SKILL: a playbook the navigator reads as a prior, never a replayable macro.
const DISTILL_SYSTEM_PROMPT = `You are distilling a record of a browser task being performed successfully into a SKILL for a browser agent. The record is either a user's hand-performed demonstration or the step journal of the agent's own successful run — either way it shows a working route to the objective. A skill is a short playbook of site knowledge the agent reads as a STRONG PRIOR while working — the agent still judges every step from the live page, so a skill teaches routes, traps, and expectations; it is NEVER a literal macro.

You get the RECORD (a chronological log: navigations with URLs, clicks with element descriptions, typed text, key presses, and — for agent runs — step judgments including failed attempts, which reveal the traps), the user's NOTES (these carry the WHY and outrank your inferences), and possibly INTERVIEW ANSWERS from a previous round. If the record contains failed or retried steps, distill the route that WORKED and note the trap that caused the failures.

PROVENANCE — the route you recommend must be the one that DELIVERED. Trace the run's final data back to the steps that actually yielded it; those steps are the working route. A strategy that was PROPOSED mid-run (e.g. by a strategic review) but whose subsequent steps the record shows failing or never producing data is a FAILED BRANCH — record it as a trap ("the X view looks promising but does not advance/work; use Y"), never as the recommendation. Attempted is not validated; a skill built from the failed branch actively misleads every future run. If the record leaves genuinely unclear which branch produced the answer, ask in "questions" instead of guessing.

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
  /** Where the record came from: a hand demonstration (default) or a successful agent run */
  origin?: 'demo' | 'run';
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
  const recordLabel =
    input.origin === 'run' ? 'RECORD (journal of a successful agent run, chronological)' : 'RECORD (chronological)';
  const content =
    `${recordLabel}:\n${input.events.join('\n') || '(no events were recorded)'}` +
    (input.notes.length ? `\n\nNOTES from the user:\n${input.notes.join('\n')}` : '') +
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

// ---- MEMORY DISTILL (run journal → updated long-term memory) ----
// After every completed run (success or failure) one cheap call REWRITES the
// agent's long-term memory: the previous memory merged with what this run
// taught. Rewrite-whole, never append — the memory rides in every strategic
// prompt, so the distiller merges, generalizes, and prunes under a hard cap
// the caller enforces in code. Division of labor: site lore belongs in
// SKILLS (playbooks); memory holds only CROSS-TASK knowledge — the user's
// context/preferences and approach-level lessons.
const MEMORY_MAX_LINES_HINT = 30;

const MEMORY_DISTILL_SYSTEM_PROMPT = `You maintain the long-term memory of a personal browser agent. After each task run you REWRITE the memory: the CURRENT MEMORY merged with whatever this run genuinely taught. The memory is read before every future task, for ALL tasks — so it must stay small, general, and true.

You get the agent's PROFILE (name and what the user said they'd use it for), the CURRENT MEMORY, and this run's OBJECTIVE, OUTCOME (delivered or failed/partial) and JOURNAL (chronological step log with judgments).

Return the COMPLETE new memory text, organized as three sections with these exact headers (omit an empty section):
WHAT WORKS: approach-level moves this agent's runs have validated (e.g. "open data gathering beats walled databases for public facts").
WHAT FAILS: approaches runs have shown failing, phrased as what to avoid.
ABOUT THE USER: durable facts and preferences the user's objectives and messages reveal (their domain, recurring targets, format preferences, tone).

Rules:
- MERGE, don't append: fold the new lesson into an existing line when they overlap; a lesson seen again is confirmation, not a new line.
- Every line must be EARNED by an actual run — never speculation, never a restatement of common sense the agent would apply anyway.
- OBSERVED, NOT THEORIZED: a WHAT FAILS line records the action and its OBSERVED result ("clicking X repeatedly opened Y instead"), never an unconfirmed theory of the cause ("shortcuts fail because overlays intercept focus") — the run's own guesses about WHY are hypotheses, and a failed run whose root cause was never confirmed on screen teaches nothing storable yet.
- ABOUT THE USER needs evidence beyond one task: a durable fact requires the user stating it, or a pattern across MULTIPLE runs (the profile says how many runs are distilled so far). One task's topic or site is a candidate at most — leave it out until it recurs; "did one Discord task" must not become "uses Discord for community interactions".
- GENERAL over specific: distill the principle, not the anecdote. Site-specific routes and traps belong in site playbooks, NOT here — leave them out entirely ("verify the server header on Discord" is playbook lore; "verify a context switch landed before acting in it" is a memory-worthy principle only if runs on different sites keep proving it).
- One run teaches at most 1-3 things; most runs teach nothing new — returning the current memory unchanged (or lightly tightened) is the common, correct outcome.
- PRUNE: drop lines that newer evidence contradicts, and the least useful lines when space is tight. Hard budget: at most ${MEMORY_MAX_LINES_HINT} short lines total.
- NEVER store secrets, passwords, payment details, or raw personal identifiers (emails, phone numbers). Pseudonym tokens like ⟨email-1⟩ are run-scoped and meaningless later — never store them.
- Plain short lines, one lesson per line, no numbering.

Reply ONLY with JSON: {"memory":"<the complete new memory text, lines separated by \\n>"}`;

export interface MemoryDistillInput {
  agentName: string;
  purpose: string;
  currentMemory: string;
  /** Runs already distilled into the memory — the distiller's evidence bar
   * for ABOUT THE USER facts scales with this */
  runsDistilled: number;
  objective: string;
  outcome: 'delivered' | 'failed';
  journal: string[];
}

export async function distillRunMemory(
  input: MemoryDistillInput,
  signal: AbortSignal,
): Promise<{ memory: string; usage: CallUsage }> {
  // STRATEGIC TIER: distilling memory is rule-dense judgment work, and the
  // cheap navigator model half-ignored the rules (live 2026-07-25: kept a
  // line the run had just disproven, wrote Discord-specific lore into the
  // general memory). Same model policy + fallback chain as reviews/kickoff:
  // strategist first, navigator if the strategist call fails.
  const { strategistModel, navigatorModel } = await chatSettingsStore.getSettings();
  const content =
    `PROFILE: agent name "${input.agentName || '(unnamed)'}"; the user said they'll use it for: ${input.purpose || '(not stated)'}; runs distilled into memory so far: ${input.runsDistilled}` +
    `\n\nCURRENT MEMORY:\n${input.currentMemory || '(empty — first runs)'}` +
    `\n\nTHIS RUN — OBJECTIVE: ${input.objective}\nOUTCOME: ${input.outcome}` +
    journalSection(input.journal);
  const callDistill = (modelOverride: string | undefined) =>
    callOrchestrator<{ memory?: string }>(MEMORY_DISTILL_SYSTEM_PROMPT, content, signal, undefined, {
      modelOverride,
      deepReview: true,
    });
  let value: { memory?: string };
  let usage: CallUsage;
  try {
    ({ value, usage } = await callDistill(strategistModel?.trim() || undefined));
  } catch (error) {
    if (signal.aborted) throw error;
    ({ value, usage } = await callDistill(navigatorModel?.trim() || undefined));
  }
  if (typeof value.memory !== 'string') throw new Error('Memory distiller returned no memory text');
  return { memory: value.memory, usage };
}
