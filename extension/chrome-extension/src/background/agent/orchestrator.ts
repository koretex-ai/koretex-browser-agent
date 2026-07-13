import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('orchestrator');

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
  mode: 'chat' | 'plan';
  /** Unused for chat (the reply is streamed separately with history) */
  reply?: string;
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
{"do":"type","target":"<label/placeholder of the input>","text":"..."}  (replaces the input's content)
{"do":"type_focused","text":"line1\\nline2"}  (trusted keyboard input into whatever has focus — the ONLY way to type into canvas editors like Google Docs/Sheets; they focus themselves when opened)
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
"expect": {"element": "<label of an element that will exist>"}
"expect": {"see": "<yes/no question for a local vision model>"}
Fields combine (all must hold). Prefer url/text/element — they are checked instantly against the live page and POLL for up to ~8 seconds, so you never need wait steps after navigation: the expect IS the wait. Use "see" ONLY for canvas editors (Google Docs/Sheets, where page text cannot see the document content) or purely visual outcomes — it costs a slow local vision call. Choose expects that are SPECIFIC to success: "the composer dialog closed and the feed shows the post text" beats "the page loaded". Read-only steps (extract, harvest, scroll, wait, wait_for) may omit expect.

SIDE EFFECTS — steps that post, send, submit a form, purchase, or delete MUST carry "sideEffect": true. The runtime never auto-retries them.

WRITING COLLECTED DATA: a type/type_focused step may use "textFrom":"collected" — the runtime inserts EVERY item collected so far, complete and verbatim, below the optional "text" (which becomes a header line). This is the ONLY reliable way to write a collected dataset — journal digests are truncated, so never paste them into "text" yourself. Harvest queries for data that will be written must ask for each item ALREADY FORMATTED for its destination, and the FORMAT DEPENDS ON THE DESTINATION:
- Google SHEETS (a grid): tab-separated, e.g. "format each record as: Name<TAB>Title<TAB>Company" — tabs move between cells.
- Google DOCS or any prose document: readable separators, NEVER tabs, e.g. "format each record on one line as: Name — Title — Company". Tabs in a doc render as literal gaps or the wrong layout.

Canvas editors (Google Docs/Sheets): the editor is ALREADY FOCUSED when the document opens — go straight to type_focused. Never click menus or toolbars first (clicking steals focus); if UI state is uncertain, use {"do":"key","combo":"Escape"} before typing. Type PLAIN TEXT — no markdown syntax. Verify canvas writes with a "see" expect (text extraction cannot see inside the canvas).`;

const PLAN_SYSTEM_PROMPT = `You are the planner for a browser agent running in a Chrome side panel. You compile the user's OBJECTIVE into a complete typed program that a deterministic runtime executes against the user's active tab, verifying every step's expect against the live page as it goes. Local models perceive (locate described elements, read page text, answer visual questions) but make no decisions. You may receive a JOURNAL — everything already tried and learned in this task, including why previous plans fell short: build on it, never repeat what it says failed.

Reply ONLY with a JSON object:
{"mode": "chat" | "plan", "steps": [...], "objective": [{...expect...}]}

- "chat": no browser needed (questions, conversation). The reply is streamed by a separate call.
- "plan": the COMPLETE program to achieve the objective end to end — including the final write/save/deliver steps, max 25 steps. If the task says to save/write/post something, the plan must contain the steps that actually do it, not just open the destination.

${STEP_FORMS}

OBJECTIVE EXPECTS: "objective" is 1-4 expects that define success of the WHOLE task, verified on the live page after the last step. Make them the user's actual deliverable ("text": the sheet shows the header row; "url": the doc URL), not intermediate progress.

SEARCH THOUGHTFULLY — a vague query returns vague people. Translate a ROLE-CLASS request ("decision makers in AI") into CONCRETE job-title queries the site actually indexes ("Head of AI", "VP Artificial Intelligence", "Chief AI Officer", "Director of Machine Learning"), not the literal phrase "AI decision maker" (which only matches people who typed that buzzword into their own headline). Combine the qualifiers the user gave — role AND location AND seniority — into the query or the search URL's filters. If the user names a count and one query is unlikely to yield enough QUALIFYING people, run 2-3 targeted searches (harvest from each) rather than one broad harvest. The harvested items are quality-filtered before writing, so it is fine to over-collect; it is NOT fine to search for the wrong thing.

Rules: prefer navigating directly to known URLs (including search-results URLs with the query embedded) over typing into search boxes; when you do type into a search box, the next step must be {"do":"key","combo":"Enter"}. Steps that submit content come AFTER the steps that enter it. When writing into a document that may ALREADY hold content from a previous attempt (a replan after a failed write), select-all and clear first: {"do":"key","combo":"cmd+a"} then {"do":"key","combo":"Backspace"} before the type step — this prevents duplicated content. Never plan logging in or handling credentials — if the task requires being signed in, assume the user is; if a login wall appears, the run will stop and tell them. You are told PLANS USED n/N: when on the LAST plan, deliver the objective with the data already collected (a delivered partial beats an undelivered perfect).`;

const REFLECT_SYSTEM_PROMPT = `You are the reflector for a browser agent. One step of the current plan failed verification (or failed to execute). You get the OBJECTIVE, the JOURNAL, the PLAN, the FAILED STEP with its expect, and the OBSERVATION — what the page or verifier actually shows. Decide whether the STEP was wrong or the PLAN is wrong.

Reply ONLY with a JSON object:
{"verdict": "fix_step" | "replan" | "stop", "step": {...corrected step with expect...}, "reason": "<short diagnosis>"}

- "fix_step": the plan is right, this one action was wrong — wrong element label, wrong URL, a dialog needs dismissing first is NOT this (that changes the plan). Provide the corrected step (same intent, with expect). It replaces the failed step and the plan continues.
- "replan": the plan's assumption about the page is false (unexpected state, the approach cannot work from here, a precondition is missing). Say why in "reason" — the planner is called again with it.
- "stop": only the user can fix it: login required, permission prompt, CAPTCHA, or the objective is impossible.

${STEP_FORMS}

Diagnose from the OBSERVATION, not guesses: "no element matching X" with a list of visible labels usually means a wrong label (fix_step with the right one); a wrong URL or an unexpected page means the plan drifted (replan). A canvas WRITE that failed its "see" check may have PARTIALLY landed — do not fix_step a blind re-type onto existing content (it duplicates); replan with a clear-first sequence (cmd+a, Backspace, then re-type). SIDE-EFFECT RULE: if the failed step has sideEffect true, it may have taken effect even though verification failed — NEVER fix_step a repeat of that action; verdict must be replan with a verification-first approach, or stop.`;

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
    const response = await fetch(`${orchestratorBaseUrl.replace(/\/$/, '')}/chat/completions`, {
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
      signal,
    });
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
  if (!['chat', 'plan'].includes(result.mode)) {
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
