import type { Action } from '@extension/storage';
import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';
import { fetchWithTimeout } from '../net';
import { callOrchestrator } from './orchestrator';
import type { CallUsage } from './orchestrator';

const logger = createLogger('planner');

// Local text generation (extract reader on ~16k-char prefill) is slow but
// bounded; past this the model server is wedged
const LOCAL_TEXT_TIMEOUT_MS = 90_000;

export interface PlannerDecision {
  reasoning: string;
  action: 'click' | 'type' | 'type_focused' | 'key' | 'extract' | 'scroll' | 'navigate' | 'back' | 'done' | 'respond';
  index?: number;
  /** Visual description for the grounder when the element is not in the PAGE list */
  target?: string;
  text?: string;
  url?: string;
  direction?: 'up' | 'down';
  /** What to read from the page text, for action=extract */
  query?: string;
  /** Key to press, for action=key (e.g. "Enter", "Escape") */
  combo?: string;
  message?: string;
}

export interface Verdict {
  valid: boolean;
  reason: string;
}

/**
 * Where planner calls go. Local = Ollama (default). Cloud = an escalated
 * OpenAI-compatible endpoint driving the executor after the local model got
 * stuck. Cloud planners see the same TEXT-ONLY observation the local one
 * does — element labels and page text, never screenshots.
 */
export type PlannerEndpoint =
  | { kind: 'local' }
  | { kind: 'cloud'; baseUrl: string; apiKey: string; model: string; tier: number };

export const LOCAL_ENDPOINT: PlannerEndpoint = { kind: 'local' };

// Tolerant JSON extraction: strip code fences, fall back to the first {...} block
function parseJsonObject<T>(content: string): T {
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as T;
    throw new Error(`Model did not return JSON: ${content.slice(0, 120)}`);
  }
}

// One non-streaming call to the local model via Ollama.
// NOTE: Ollama's schema-constrained `format` is unreliable with think:false on
// qwen3.5 (returns prose), so we use plain json mode + the shape in the prompt.
async function callLocal(
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal,
  json: boolean,
): Promise<string> {
  const { baseUrl, model } = await chatSettingsStore.getSettings();
  const response = await fetchWithTimeout(
    `${baseUrl}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        stream: false,
        think: false,
        ...(json ? { format: 'json' } : {}),
        options: { temperature: 0.1 },
      }),
    },
    signal,
    LOCAL_TEXT_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Ollama request failed (HTTP ${response.status}). Is Ollama running at ${baseUrl}?`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.message?.content ?? '';
}

// Cloud page reading goes through the ONE cloud gateway (callOrchestrator,
// prose mode) so it inherits every check by default — bounded connection and
// body reads, transient retry, no-retention routing, fast-host-under-price-
// ceiling, reasoning off, output cap. This path used to carry its own copy
// of that ladder and drifted (an unguarded response.json() and an unmuzzled
// MiMo each killed a live run, 2026-07-16); per-call-site contracts are how
// checks get missed, so no cloud call may bypass the gateway.
async function callCloud(
  endpoint: Extract<PlannerEndpoint, { kind: 'cloud' }>,
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal,
): Promise<{ content: string; usage: CallUsage }> {
  const { value, usage } = await callOrchestrator<string>(systemPrompt, userContent, signal, undefined, {
    modelOverride: endpoint.model,
    prose: true,
  });
  return { content: value, usage };
}

async function callText(
  endpoint: PlannerEndpoint,
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal,
  json: boolean,
): Promise<{ content: string; usage: CallUsage | null }> {
  if (endpoint.kind === 'cloud') {
    const { content, usage } = await callCloud(endpoint, systemPrompt, userContent, signal);
    logger.info(`response (${endpoint.model}):`, content.slice(0, 300));
    return { content, usage };
  }
  const content = await callLocal(systemPrompt, userContent, signal, json);
  logger.info('response (local):', content.slice(0, 300));
  return { content, usage: null };
}

export interface PlanResult {
  decision: PlannerDecision;
  /** Cost attribution when the decision came from an escalated cloud planner */
  usage: CallUsage | null;
}

export async function planNextAction(
  systemPrompt: string,
  turn: string,
  signal: AbortSignal,
  endpoint: PlannerEndpoint = LOCAL_ENDPOINT,
): Promise<PlanResult> {
  const { content, usage } = await callText(endpoint, systemPrompt, turn, signal, true);
  const decision = parseJsonObject<PlannerDecision>(content);
  if (typeof decision.action !== 'string') throw new Error('Planner returned no action');
  return { decision, usage };
}

export async function validateCompletion(systemPrompt: string, turn: string, signal: AbortSignal): Promise<Verdict> {
  const { content } = await callText(LOCAL_ENDPOINT, systemPrompt, turn, signal, true);
  const verdict = parseJsonObject<Verdict>(content);
  return { valid: Boolean(verdict.valid), reason: verdict.reason ?? '' };
}

export const EXTRACTOR_SYSTEM_PROMPT = `You read web page text on behalf of a browser agent. Given a QUERY and the PAGE TEXT (readable text extracted from the page, viewport-first; each LINE is one content block — one post, card, or row), answer the query using ONLY the page text.

- Quote names, numbers, prices and percentages exactly as they appear.
- ATTRIBUTION: attribute content to an author/account ONLY when both appear on the SAME line (the same post/card). Never combine an author from one line with content from another. If a post is a repost/quote of someone else, attribute the quoted content to its original author or mark it "(reposted by X)". If attribution is unclear, skip the item.
- For each item you report, include a short VERBATIM quote from the page text as evidence, in quotation marks.
- If an ALREADY COLLECTED list is provided, do NOT repeat those items — report only NEW information. If the page contains nothing new beyond it, reply exactly: NOTHING NEW
- If the page text does not contain the answer, reply exactly: NOT FOUND — followed by one short sentence saying what is missing.
- Be concise: a short list or a few sentences, no preamble.`;

/** The extract action: answer a query from the page's readable text. Uses the
 * same endpoint tier as the planner that requested it. `known` items are
 * excluded so repeated extracts only report NEW information. */
export async function extractFromPage(
  query: string,
  pageText: string,
  signal: AbortSignal,
  endpoint: PlannerEndpoint = LOCAL_ENDPOINT,
  known: string[] = [],
): Promise<{ answer: string; usage: CallUsage | null }> {
  const knownSection = known.length
    ? `\n\nALREADY COLLECTED (do not repeat; report only NEW items):\n${known.join('\n')}`
    : '';
  const { content, usage } = await callText(
    endpoint,
    EXTRACTOR_SYSTEM_PROMPT,
    `QUERY: ${query}${knownSection}\n\nPAGE TEXT:\n${pageText || '(no text could be extracted from this page)'}`,
    signal,
    false,
  );
  return { answer: content.trim(), usage };
}

// Convert a planner decision into a typed executor action.
// Returns null for respond/done/extract (loop handles those) and for
// click-by-target (loop routes it through the vision grounder first).
export function decisionToAction(decision: PlannerDecision): Action | { error: string } | null {
  switch (decision.action) {
    case 'click':
      if (decision.index === undefined) {
        if (decision.target) return null; // grounder path
        return { error: 'click requires an element index or a target description' };
      }
      return { type: 'click', index: decision.index };
    case 'type':
      if (decision.index === undefined || !decision.text) return { error: 'type requires an index and text' };
      return { type: 'type', index: decision.index, text: decision.text };
    case 'key':
      if (!decision.combo) return { error: 'key requires a combo, e.g. "Enter"' };
      return { type: 'key', combo: decision.combo };
    case 'type_focused':
      if (!decision.text) return { error: 'type_focused requires text' };
      return { type: 'type_focused', text: decision.text };
    case 'extract':
      if (!decision.query) return { error: 'extract requires a query' };
      return null; // loop handles extraction (needs an LLM call over page text)
    case 'scroll':
      return { type: 'scroll', direction: decision.direction ?? 'down' };
    case 'navigate':
      if (!decision.url) return { error: 'navigate requires a url' };
      return { type: 'navigate', url: decision.url };
    case 'back':
      return { type: 'back' };
    case 'done':
    case 'respond':
      return null;
  }
}
