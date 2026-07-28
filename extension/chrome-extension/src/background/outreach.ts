import { accountStore } from '@extension/storage';
import { createLogger } from './log';
import { showWorkerBadge } from './prospecting';

const logger = createLogger('outreach');

/**
 * Sends ONE LinkedIn message through the user's own logged-in session.
 *
 * Deliberately narrow: the user pressed Send on the dashboard for one specific
 * person and one specific piece of text — this module just performs that click
 * for them. Deterministic DOM automation, no model calls; anything ambiguous
 * (no Message button, compose did not open, send stayed disabled) fails
 * honestly rather than guessing. The server records the outcome so history is
 * only ever marked SENT when the compose box actually cleared.
 */

const CHECKPOINT_URLS = /linkedin\.com\/(checkpoint|authwall|uas\/(login|consumer-email-challenge))/i;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const jitter = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));

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

function waitForLoad(tabId: number, timeoutMs = 30000): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') done();
    });
  });
}

interface SendRequest {
  messageId: string;
  profileUrl: string;
  body: string;
}

interface SendOutcome {
  ok: boolean;
  reason?: string;
}

/** The in-page half: open the compose, insert the text, press Send, verify. */
async function driveCompose(tabId: number, text: string): Promise<SendOutcome> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (message: string) => {
      const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

      // Premium/Sales Navigator upsell modals sit over the page and swallow
      // clicks (live failure 2026-07-27: one killed a send). Their close
      // buttons are artdeco-modal dismissals — the message compose overlay is
      // NOT an artdeco modal, so this can never close our own compose.
      const dismissUpsells = (): boolean => {
        let hit = false;
        for (const b of Array.from(
          document.querySelectorAll<HTMLElement>(
            '.artdeco-modal__dismiss, button[aria-label="Dismiss"], button[data-test-modal-close-btn]',
          ),
        )) {
          b.click();
          hit = true;
        }
        return hit;
      };
      if (dismissUpsells()) await pause(800);

      // What is actually on screen when something fails — the recorded reason
      // names the blocking dialog instead of guessing (debugging aid
      // 2026-07-27: a send died twice with no way to see which popup did it).
      const dialogSummary = (): string => {
        const texts = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .artdeco-modal'))
          .map(d => (d.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 90))
          .filter(Boolean)
          .slice(0, 3);
        return texts.length ? ` Visible dialogs: ${texts.join(' | ')}` : '';
      };

      // 1. The Message button on the profile. aria-label is the stable handle
      // ("Message Jane Doe"); fall back to visible text, then to the More
      // menu — some layouts tuck Message inside it.
      let btn: HTMLElement | null = document.querySelector<HTMLElement>(
        'main button[aria-label^="Message"], main a[aria-label^="Message"]',
      );
      if (!btn) {
        btn =
          Array.from(document.querySelectorAll<HTMLElement>('main button, main a')).find(
            el => el.textContent?.trim() === 'Message',
          ) ?? null;
      }
      if (!btn) {
        const more = Array.from(document.querySelectorAll<HTMLElement>('main button')).find(b =>
          /more actions|^more$/i.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()),
        );
        if (more) {
          more.click();
          await pause(800);
          btn =
            Array.from(document.querySelectorAll<HTMLElement>('div[role="button"], button, a')).find(
              el => el.textContent?.trim() === 'Message',
            ) ?? null;
        }
      }
      if (!btn) {
        return { ok: false, reason: `No Message button — possibly not a 1st-degree connection.${dialogSummary()}` };
      }
      btn.click();

      // 2. Wait for the compose box (messaging overlay renders lazily). An
      // upsell modal can pop AFTER the Message click and block the overlay —
      // halfway through the wait, clear modals and press Message once more.
      let box: HTMLElement | null = null;
      for (let i = 0; i < 24; i++) {
        box = document.querySelector<HTMLElement>('.msg-form__contenteditable[contenteditable="true"]');
        if (box) break;
        if (i === 10 && dismissUpsells()) {
          await pause(800);
          btn.click();
        }
        await pause(500);
      }
      if (!box) return { ok: false, reason: `The message compose box did not open.${dialogSummary()}` };

      // 3. Type the text. execCommand fires the input events LinkedIn's
      // editor listens for; direct innerText assignment does not.
      box.focus();
      await pause(300);
      document.execCommand('insertText', false, message);
      await pause(800);

      const typed = (box.innerText ?? '').trim();
      if (!typed.includes(message.trim().slice(0, 40))) {
        return { ok: false, reason: 'The text did not register in the compose box.' };
      }

      // 4. Send — only via an enabled send button; never the Enter key.
      let send: HTMLButtonElement | null = null;
      for (let i = 0; i < 10; i++) {
        send =
          document.querySelector<HTMLButtonElement>('button.msg-form__send-button:not([disabled])') ??
          Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
            b => b.textContent?.trim() === 'Send' && !b.disabled,
          ) ??
          null;
        if (send) break;
        await pause(400);
      }
      if (!send) return { ok: false, reason: `The Send button never became clickable.${dialogSummary()}` };
      send.click();

      // 5. Verify: a successful send clears the compose box.
      for (let i = 0; i < 12; i++) {
        await pause(500);
        const after = document.querySelector<HTMLElement>('.msg-form__contenteditable[contenteditable="true"]');
        if (!after || (after.innerText ?? '').trim().length === 0) return { ok: true };
      }
      return { ok: false, reason: 'Clicked Send but the compose box never cleared — the message may not have gone out.' };
    },
    args: [text],
  });
  return (result?.result as SendOutcome | undefined) ?? { ok: false, reason: 'Could not reach the page.' };
}

let sending = false;

/** One send, end to end: open the profile in a worker window, drive the
 *  compose, report the outcome to the server, clean up. */
export async function sendLinkedInMessage(request: SendRequest): Promise<SendOutcome> {
  if (sending) return { ok: false, reason: 'Another message is being sent right now — try again in a moment.' };
  if (!request.messageId || !request.profileUrl || !request.body.trim()) {
    return { ok: false, reason: 'Missing message details.' };
  }
  sending = true;
  let windowId: number | undefined;
  let tabIdForBadge: number | undefined;
  let outcome: SendOutcome | undefined;

  const finish = async (outcome: SendOutcome): Promise<SendOutcome> => {
    await api('/api/pass2/outreach/result', {
      messageId: request.messageId,
      ok: outcome.ok,
      reason: outcome.reason,
    }).catch(error => logger.warning('result report failed:', error));
    return outcome;
  };

  try {
    const win = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1200, height: 900 });
    windowId = win?.id;
    const tabId = win?.tabs?.[0]?.id;
    tabIdForBadge = tabId;
    if (!tabId) return await finish({ ok: false, reason: 'Could not open a working tab.' });

    await chrome.tabs.update(tabId, { url: request.profileUrl });
    await waitForLoad(tabId);
    await showWorkerBadge(tabId, 'Koretex · Opening the conversation to send your message');
    await wait(jitter(2500, 5000));

    const landedUrl = (await chrome.tabs.get(tabId)).url ?? '';
    if (CHECKPOINT_URLS.test(landedUrl)) {
      outcome = { ok: false, reason: 'LinkedIn redirected to a security check — not sending today.' };
      return await finish(outcome);
    }

    outcome = await driveCompose(tabId, request.body);
    return await finish(outcome);
  } catch (error) {
    outcome = { ok: false, reason: (error as Error).message };
    return await finish(outcome);
  } finally {
    sending = false;
    if (windowId !== undefined) {
      if (outcome?.ok) {
        // A short beat so the send settles before the window vanishes.
        await wait(1500);
        await chrome.windows.remove(windowId).catch(() => {});
      } else {
        // Leave the evidence on screen: the user sees exactly which popup or
        // page state blocked the send instead of a vanishing window.
        if (tabIdForBadge !== undefined) {
          await showWorkerBadge(tabIdForBadge, `Koretex · Could not send: ${outcome?.reason ?? 'unknown'}`);
        }
        await chrome.windows.update(windowId, { focused: true }).catch(() => {});
      }
    }
  }
}
