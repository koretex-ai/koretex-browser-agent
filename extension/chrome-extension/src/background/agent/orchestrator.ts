import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';
import { fetchWithTimeout } from '../net';

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

AN EXPECT MUST BE SATISFIABLE ONLY BY SUCCESS — never by a state that is ALREADY TRUE before the step completes. The test: could this expect pass even if the action did nothing? If yes, it is worthless. In particular, verifying that content you just entered is still on the page does NOT prove it was submitted — that text was there the moment you typed it. For an action that SUBMITS / SENDS / CREATES / DELETES, verify the TRANSITION that only success produces — most reliably with "gone" (the input surface or dialog closed) and/or a confirmation "element" that only appears afterwards. E.g. after posting, the composer is gone: {"gone": "<the composer's placeholder or submit label>"}. Do NOT verify a submit by the persistence of the text you typed. The OBJECTIVE expects follow the same rule: they must describe the delivered outcome, checkable only after it truly happened.

SIDE EFFECTS — steps that post, send, submit a form, purchase, or delete MUST carry "sideEffect": true (the runtime never auto-retries them) AND their expect must verify the post-action transition above, never the persistence of the entered content.

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

Ground every fact ONLY in the journal and collected items — never invent data. For achieved: confirm what was done and present the results. For partial: lead with what WAS accomplished and found (list the actual data), then say briefly what could not be completed and why. If nothing useful was gathered, say so honestly in one sentence.`;

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
}

async function callOrchestrator<T>(
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal,
): Promise<{ value: T; usage: CallUsage }> {
  const { orchestratorBaseUrl, orchestratorApiKey, orchestratorModel } = await chatSettingsStore.getSettings();
  const model = orchestratorModel;

  const request = async (
    messages: { role: string; content: string }[],
  ): Promise<{ content: string; usage: CallUsage }> => {
    const response = await fetchWithTimeout(
      `${orchestratorBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${orchestratorApiKey}`,
          'HTTP-Referer': 'https://github.com/koretex-ai/local-browser-use',
          'X-Title': 'Local Browser Use',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          usage: { include: true },
        }),
      },
      signal,
      CLOUD_CALL_TIMEOUT_MS,
    );
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`Orchestrator request failed (HTTP ${response.status}): ${detail}`);
    }
    const data = await response.json();
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    const content: string = data.choices?.[0]?.message?.content ?? '';
    logger.info('orchestrator response:', content.slice(0, 300));
    return {
      content,
      usage: {
        model: data.model ?? model,
        cost: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
      },
    };
  };

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const first = await request(messages);
  try {
    return { value: parseJsonObject<T>(first.content), usage: first.usage };
  } catch (parseError) {
    // One malformed reply is worth a retry, not a dead task
    logger.warning('orchestrator returned non-JSON, retrying once:', parseError);
    const retry = await request([
      ...messages,
      { role: 'assistant', content: first.content.slice(0, 2000) },
      {
        role: 'user',
        content:
          'That was not valid JSON. Reply ONLY with the JSON object in the specified format — no prose, no code fences.',
      },
    ]);
    const sum = (a: number | null, b: number | null): number | null =>
      a === null && b === null ? null : (a ?? 0) + (b ?? 0);
    const usage: CallUsage = {
      model: retry.usage.model,
      cost: sum(first.usage.cost, retry.usage.cost),
      promptTokens: sum(first.usage.promptTokens, retry.usage.promptTokens),
      completionTokens: sum(first.usage.completionTokens, retry.usage.completionTokens),
    };
    return { value: parseJsonObject<T>(retry.content), usage };
  }
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
): Promise<{ result: PlanResult; usage: CallUsage }> {
  const pageSection = pageDigest ? `\n\nCURRENT PAGE (the active tab right now):\n${pageDigest}` : '';
  const userContent =
    `OBJECTIVE: ${objective}\n\nPLANS USED: ${plansUsed} of ${maxPlans}` + pageSection + journalSection(journal);
  const { value: result, usage } = await callOrchestrator<PlanResult>(PLAN_SYSTEM_PROMPT, userContent, signal);
  if (!['chat', 'plan', 'clarify'].includes(result.mode)) {
    throw new Error(`Planner returned invalid mode: ${String(result.mode)}`);
  }
  return { result, usage };
}

export async function reflectOnFailure(
  objective: string,
  journal: string[],
  planSteps: string[],
  failedStepIndex: number,
  failedStep: ProgramStep,
  observation: string,
  signal: AbortSignal,
): Promise<{ result: ReflectResult; usage: CallUsage }> {
  const userContent =
    `OBJECTIVE: ${objective}\n\n` +
    `PLAN:\n${planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
    `FAILED STEP (${failedStepIndex + 1} of ${planSteps.length}):\n${JSON.stringify(failedStep)}\n\n` +
    `OBSERVATION:\n${observation}` +
    journalSection(journal);
  const { value: result, usage } = await callOrchestrator<ReflectResult>(REFLECT_SYSTEM_PROMPT, userContent, signal);
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
): Promise<{ items: string[]; dropped: number; usage: CallUsage | null }> {
  if (items.length === 0) return { items, dropped: 0, usage: null };
  try {
    const userContent = `OBJECTIVE: ${objective}\n\nCOLLECTED ITEMS (one per line):\n${items.join('\n')}`;
    const { value, usage } = await callOrchestrator<{ items: string[]; dropped?: number }>(
      CURATE_SYSTEM_PROMPT,
      userContent,
      signal,
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
): Promise<{ answer: string; usage: CallUsage }> {
  const collectionSection = collection.length
    ? `\n\nCOLLECTED ITEMS (complete, deduplicated):\n${collection.slice(0, 100).join('\n').slice(0, 8000)}`
    : '';
  const userContent = `OBJECTIVE: ${objective}\n\nSTATUS: ${status}` + journalSection(journal) + collectionSection;
  const { value, usage } = await callOrchestrator<{ answer: string }>(REPORT_SYSTEM_PROMPT, userContent, signal);
  if (!value.answer) throw new Error('Report returned no answer');
  return { answer: value.answer, usage };
}
