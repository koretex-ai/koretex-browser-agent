import { Actors, chatHistoryStore, accountStore } from '@extension/storage';
import { createLogger } from './log';
import { runAgentTask } from './agent/loop';
import { acquireTaskTab } from './taskWindow';

const logger = createLogger('outreach');

/**
 * Sends ONE LinkedIn message through the user's own logged-in session — by
 * running the full browser agent, not a script.
 *
 * The first implementation drove the DOM with hardcoded selectors and died on
 * the first surprise (live 2026-07-27: a dismissable Sales Navigator upsell
 * intercepted the Message click three ways). The agent's act-observe loop
 * plus the linkedin playbook handle surprises by design, the run shows live
 * in the agent window + trace viewer, and every run is inspectable in
 * History afterwards.
 *
 * Safety stays in code: the objective demands the EXACT text, forbids
 * improvising routes, caps Send at one press, and requires an explicit
 * MESSAGE_SENT / MESSAGE_NOT_SENT / MESSAGE_UNCERTAIN verdict — anything but
 * a confirmed send is recorded as not sent, with the reason in the history.
 */

interface OutreachHooks {
  /** Fan execution events out to every connected side panel (the trace viewer). */
  broadcast: (message: unknown) => void;
  /** A live user/scheduled agent task wins — never stack agent runs. */
  isBusy: () => boolean;
  /** Lets index.ts show the Stop button and route cancel_task to this run. */
  onRunStart: (sessionId: string, abort: AbortController) => void;
  onRunEnd: () => void;
}

let hooks: OutreachHooks = {
  broadcast: () => {},
  isBusy: () => false,
  onRunStart: () => {},
  onRunEnd: () => {},
};
export function setOutreachHooks(next: OutreachHooks): void {
  hooks = next;
}

async function api(path: string, body: unknown): Promise<void> {
  const account = await accountStore.get();
  if (!account.token) throw new Error('No account connected.');
  const base = account.apiBase.replace(/\/+$/, '');
  await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface SendRequest {
  messageId: string;
  profileUrl: string;
  body: string;
  name?: string;
}

interface SendOutcome {
  ok: boolean;
  reason?: string;
}

function buildObjective(request: SendRequest): string {
  const who = request.name?.trim() || 'this person';
  return (
    `Open ${request.profileUrl} and send ${who} this exact LinkedIn message:\n\n` +
    `"${request.body}"\n\n` +
    `Close any promotional or upsell dialog that gets in the way (Sales Navigator ads and the like), ` +
    `open the message compose with the Message button, type the message EXACTLY as given — do not add, ` +
    `remove or rephrase a single word — send it, and confirm it appears in the conversation thread.\n` +
    `Hard rules: press Send at most ONCE in this entire run. If sending is impossible (no Message button, ` +
    `LinkedIn demands payment or InMail, a security checkpoint appears), do not improvise another route — stop and explain.\n` +
    `Your final answer MUST end with exactly one of these lines:\n` +
    `MESSAGE_SENT — only if you can SEE the message in the thread.\n` +
    `MESSAGE_UNCERTAIN — you pressed Send but could not confirm it landed.\n` +
    `MESSAGE_NOT_SENT: <short reason> — you never pressed Send.`
  );
}

function parseOutcome(finalState: string, answer: string): SendOutcome {
  if (/\bMESSAGE_UNCERTAIN\b/.test(answer)) {
    return {
      ok: false,
      reason: 'The agent pressed Send but could not confirm it landed — check the thread on LinkedIn before retrying.',
    };
  }
  const notSent = answer.match(/MESSAGE_NOT_SENT:?\s*(.*)/);
  if (notSent) {
    return { ok: false, reason: (notSent[1] || 'the agent could not send it').trim().slice(0, 280) };
  }
  if (finalState === 'task.ok' && /\bMESSAGE_SENT\b/.test(answer)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'The run ended without a confirmed send — open the run in History for the full trace.',
  };
}

let sending = false;

export async function sendLinkedInMessage(request: SendRequest): Promise<SendOutcome> {
  if (sending) return { ok: false, reason: 'Another message is being sent right now — try again in a moment.' };
  if (hooks.isBusy()) {
    return { ok: false, reason: 'The agent is busy with another task — try again when it finishes.' };
  }
  if (!request.messageId || !request.profileUrl || !request.body.trim()) {
    return { ok: false, reason: 'Missing message details.' };
  }
  sending = true;

  const finish = async (outcome: SendOutcome): Promise<SendOutcome> => {
    await api('/api/pass2/outreach/result', {
      messageId: request.messageId,
      ok: outcome.ok,
      reason: outcome.reason,
    }).catch(error => logger.warning('result report failed:', error));
    return outcome;
  };

  try {
    const objective = buildObjective(request);
    const session = await chatHistoryStore.createSession(
      `✉️ Message ${request.name?.trim() || 'a lead'}`.slice(0, 60),
    );
    await chatHistoryStore.addMessage(session.id, {
      actor: Actors.USER,
      content: objective,
      timestamp: Date.now(),
    });

    // The agent window + docked trace viewer — the user watches the send live.
    const acquisition = await acquireTaskTab(session.id);
    if (!acquisition) {
      return await finish({ ok: false, reason: 'Could not open the agent window.' });
    }

    let finalState = 'task.fail';
    let lastAnswer = '';
    const port = {
      postMessage: (message: { type?: string; state?: string; data?: { details?: string; meta?: string } }) => {
        hooks.broadcast(message);
        if (message?.type !== 'execution' || !message.state) return;
        if (['task.ok', 'task.fail', 'task.cancel'].includes(message.state)) {
          finalState = message.state;
          if (message.state === 'task.ok') lastAnswer = message.data?.details ?? '';
          chatHistoryStore
            .addMessage(session.id, {
              actor: message.state === 'task.ok' ? Actors.ASSISTANT : Actors.SYSTEM,
              content: message.data?.details || (message.state === 'task.ok' ? 'Done.' : 'Failed.'),
              timestamp: Date.now(),
              meta: message.data?.meta,
            })
            .catch(err => logger.error('failed to persist outreach message', err));
        }
      },
    } as unknown as chrome.runtime.Port;

    const abort = new AbortController();
    hooks.onRunStart(session.id, abort);
    try {
      await runAgentTask(port, acquisition.tabId, session.id, objective, abort.signal);
    } catch (error) {
      logger.error('outreach agent run crashed', error);
      return await finish({ ok: false, reason: (error as Error).message.slice(0, 200) });
    } finally {
      hooks.onRunEnd();
    }
    if (abort.signal.aborted) {
      return await finish({ ok: false, reason: 'Stopped by the user before the send completed.' });
    }

    return await finish(parseOutcome(finalState, lastAnswer));
  } finally {
    sending = false;
  }
}
