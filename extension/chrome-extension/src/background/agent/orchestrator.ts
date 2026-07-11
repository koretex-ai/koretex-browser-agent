import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('orchestrator');

/**
 * Cloud orchestrator: a strong model that triages tasks, decomposes them into
 * subtasks for the local executor, checkpoints progress, and produces the
 * final validated answer.
 *
 * HARD RULE: payloads are digest-only. This module has no access to
 * screenshots or raw element lists by construction — only the task text,
 * plan state, and structured subtask outcome summaries cross the boundary.
 */

export interface Subtask {
  goal: string;
  /** How the checkpoint judges whether this subtask succeeded */
  success: string;
}

export interface SubtaskOutcome {
  goal: string;
  status: 'ok' | 'fail';
  /** The local loop's final message or failure reason */
  summary: string;
  /** Last few action->result lines from the local loop */
  actions: string[];
  url?: string;
  title?: string;
}

export interface TriageResult {
  mode: 'chat' | 'execute' | 'plan';
  /** Direct answer for mode=chat */
  reply?: string;
  /** Ordered subtasks for mode=plan */
  subtasks?: Subtask[];
}

export interface CheckpointResult {
  decision: 'continue' | 'replan' | 'done' | 'fail';
  /** Final user-facing answer for decision=done */
  answer?: string;
  reason?: string;
  /** Remaining subtasks for decision=replan */
  subtasks?: Subtask[];
}

const TRIAGE_SYSTEM_PROMPT = `You are the orchestrator for a browser agent that runs in a Chrome side panel. A small local model executes browser actions (click, type into fields, scroll, navigate, go back) against the user's active tab, up to ~10 actions per subtask. It is reliable on short concrete goals and unreliable on long or vague ones. You never see the page yourself — plan from the task alone.

Classify the user's request and reply ONLY with a JSON object:
{"mode": "chat" | "execute" | "plan", "reply": "<answer for chat>", "subtasks": [{"goal": "...", "success": "..."}]}

- "chat": no browser needed (questions, conversation). Answer it yourself, fully, in "reply".
- "execute": one concrete browser goal achievable in ~6 actions or fewer (e.g. "open site X and click Y"). No subtasks needed.
- "plan": anything multi-part or long. Break it into 2-8 ordered subtasks. Each subtask must be a short, concrete, independently completable browser goal (<=10 simple actions) with a verifiable "success" criterion. Include information-gathering criteria explicitly (e.g. "the price of X is known").

Rules: goals must be self-contained (the executor sees only its own goal, not the others). Prefer navigating directly to known URLs. Never ask the executor to log in, pay, or handle credentials — if the task requires that, note it in the relevant subtask goal as "requires the user to be signed in".`;

const CHECKPOINT_SYSTEM_PROMPT = `You are the orchestrator for a browser agent. A small local executor just ran one subtask of your plan. You never see the page — judge from the structured outcomes.

Reply ONLY with a JSON object:
{"decision": "continue" | "replan" | "done" | "fail", "answer": "<final user answer for done>", "reason": "<short>", "subtasks": [{"goal": "...", "success": "..."}]}

- "continue": the plan is on track; run the next subtask.
- "replan": the last outcome requires changing course. Provide the REMAINING subtasks (2-6, same format as before) that replace the rest of the plan.
- "done": the user's TASK is fully accomplished. Write the final answer for the user in "answer", grounded ONLY in the outcome summaries — never invent facts that are not in them.
- "fail": the task cannot be completed (explain in "reason").

Be strict: if an outcome summary does not actually contain the information or confirmation the task needs, do not declare done.`;

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

async function callOrchestrator<T>(systemPrompt: string, userContent: string, signal: AbortSignal): Promise<T> {
  const { orchestratorBaseUrl, orchestratorApiKey, orchestratorModel } = await chatSettingsStore.getSettings();
  const response = await fetch(`${orchestratorBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${orchestratorApiKey}`,
      // OpenRouter attribution headers (ignored by other providers)
      'HTTP-Referer': 'https://github.com/koretex-ai/local-browser-use',
      'X-Title': 'Local Browser Use',
    },
    body: JSON.stringify({
      model: orchestratorModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
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
  return parseJsonObject<T>(content);
}

export async function triageTask(task: string, signal: AbortSignal): Promise<TriageResult> {
  const result = await callOrchestrator<TriageResult>(TRIAGE_SYSTEM_PROMPT, `TASK: ${task}`, signal);
  if (!['chat', 'execute', 'plan'].includes(result.mode)) {
    throw new Error(`Orchestrator returned invalid mode: ${String(result.mode)}`);
  }
  if (result.mode === 'plan' && (!Array.isArray(result.subtasks) || result.subtasks.length === 0)) {
    // A plan with no subtasks degrades to direct execution
    return { mode: 'execute' };
  }
  return result;
}

export async function checkpoint(
  task: string,
  plan: Subtask[],
  outcomes: SubtaskOutcome[],
  signal: AbortSignal,
): Promise<CheckpointResult> {
  const userContent =
    `TASK: ${task}\n\n` +
    `PLAN:\n${plan.map((s, i) => `${i + 1}. ${s.goal} (success: ${s.success})`).join('\n')}\n\n` +
    `OUTCOMES SO FAR (JSON):\n${JSON.stringify(outcomes, null, 1)}`;
  const result = await callOrchestrator<CheckpointResult>(CHECKPOINT_SYSTEM_PROMPT, userContent, signal);
  if (!['continue', 'replan', 'done', 'fail'].includes(result.decision)) {
    throw new Error(`Orchestrator returned invalid decision: ${String(result.decision)}`);
  }
  return result;
}
