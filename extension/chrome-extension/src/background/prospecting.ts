import { accountStore } from '@extension/storage';
import { createLogger } from './log';

const logger = createLogger('prospecting');

/**
 * Pass 2 worker — HANDS ONLY.
 *
 * Leases a sitting of profiles from the site, opens each one in this browser's
 * own logged-in session, captures the page text and posts it back. Every
 * decision (who is next, how many, when to stop, what the page means) belongs
 * to the server; nothing here reasons about anything. There is no model call
 * and no API key in this file by design.
 */

export interface SittingProgress {
  running: boolean;
  /** Index of the profile being visited, 1-based. */
  current: number;
  total: number;
  visited: number;
  failed: number;
  currentName: string;
  message: string;
  halted: boolean;
  finishedAt?: number;
}

const PROGRESS_KEY = 'pass2_progress';

/**
 * A checkpoint is a challenge aimed at the ACCOUNT, and the only reliable
 * signal is the URL LinkedIn sends you to. Text matching alone was a mistake:
 * the word "challenge" appears in ordinary profile prose ("our biggest
 * challenge was…") and halted a whole day on a perfectly normal profile.
 */
const CHECKPOINT_URLS = /linkedin\.com\/(checkpoint|authwall|uas\/(login|consumer-email-challenge))/i;

/**
 * Text phrases specific enough to be worth acting on — but only as a soft
 * signal: one occurrence skips the profile, two in a row stop the day.
 */
const CHECKPOINT_TEXT =
  /(let'?s do a quick security check|we'?ve restricted your account|verify your identity to continue|unusual activity (from|on) your account|confirm you'?re not a robot)/i;

/** Pages that mean "this profile is unavailable" — skip it, keep going. */
const WALL_MARKERS = /(sign in to view|join linkedin to see|this profile is not available|page not found)/i;

let abortRequested = false;

async function setProgress(patch: Partial<SittingProgress>): Promise<void> {
  const current = await getProgress();
  await chrome.storage.local.set({ [PROGRESS_KEY]: { ...current, ...patch } });
}

export async function getProgress(): Promise<SittingProgress> {
  const stored = await chrome.storage.local.get(PROGRESS_KEY);
  return (
    (stored[PROGRESS_KEY] as SittingProgress | undefined) ?? {
      running: false,
      current: 0,
      total: 0,
      visited: 0,
      failed: 0,
      currentName: '',
      message: '',
      halted: false,
    }
  );
}

export function requestAbort(): void {
  abortRequested = true;
}

async function api(path: string, body?: unknown): Promise<Record<string, unknown> | null> {
  const account = await accountStore.get();
  if (!account.token) throw new Error('No account connected — connect one in Settings → Account.');
  const base = account.apiBase.replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    // Scoring a capture takes the server up to ~2 min; a hung call must fail
    // rather than freeze the sitting forever.
    signal: AbortSignal.timeout(180_000),
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data?.success) {
    throw new Error((data?.message as string) ?? `Server returned ${res.status}`);
  }
  return data;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Human pacing: never the same gap twice. */
const jitter = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));

/** Waits for a tab to finish loading, or gives up. */
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

/**
 * Reads the profile the way a person would: let it settle, scroll far enough
 * for the activity section to render, then take the visible text. Also grabs
 * the /company/ links the page holds — the server uses them to find the
 * employer's own page for the staff-count read.
 */
async function capturePage(tabId: number): Promise<{ text: string; companyLinks: string[] }> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
      // LinkedIn renders activity lazily — scroll through, then return to top.
      for (let y = 0; y < 4; y++) {
        window.scrollTo({ top: window.innerHeight * y, behavior: 'auto' });
        await pause(600);
      }
      window.scrollTo({ top: 0, behavior: 'auto' });
      await pause(300);
      // Document order matters: the experience section (current employer)
      // renders before "similar pages", and the server trusts that ordering.
      const companyLinks: string[] = [];
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/company/"]'))) {
        if (!companyLinks.includes(a.href)) companyLinks.push(a.href);
        if (companyLinks.length >= 10) break;
      }
      return { text: document.body?.innerText ?? '', companyLinks };
    },
  });
  const value = result?.result as { text?: string; companyLinks?: string[] } | undefined;
  return { text: String(value?.text ?? ''), companyLinks: value?.companyLinks ?? [] };
}

/**
 * One company-page read: open the employer's About page, capture, submit.
 * Deterministic on the server (no coins) but a page load here, so it gets the
 * same human dwell as a profile. Failures are silently dropped — the company
 * read is a bonus, never worth failing a sitting over.
 */
async function readCompanyPage(tabId: number, visit: { url: string; key: string }): Promise<'ok' | 'checkpoint'> {
  await chrome.tabs.update(tabId, { url: visit.url });
  await waitForLoad(tabId);
  await wait(jitter(2500, 5000));
  const landedUrl = (await chrome.tabs.get(tabId)).url ?? '';
  if (CHECKPOINT_URLS.test(landedUrl)) return 'checkpoint';
  const { text } = await capturePage(tabId);
  if (!text || text.length < 100) return 'ok';
  await api('/api/pass2/company-capture', { companyKey: visit.key, text });
  return 'ok';
}

/**
 * Runs one sitting. Returns a short human summary for the UI.
 */
export async function runSitting(count: number): Promise<string> {
  abortRequested = false;
  const existing = await getProgress();
  if (existing.running) return 'A sitting is already running.';

  await setProgress({
    running: true,
    current: 0,
    total: 0,
    visited: 0,
    failed: 0,
    currentName: '',
    message: 'Asking the server what to visit…',
    halted: false,
    finishedAt: undefined,
  });

  let windowId: number | undefined;
  let tabId: number | undefined;

  try {
    const lease = (await api('/api/pass2/next', { count })) as unknown as {
      contacts: Array<{ id: string; profileUrl: string; firstName: string; lastName: string }>;
      halted: boolean;
      haltReason?: string;
      cap: number;
      remainingToday: number;
      outOfCoins?: boolean;
      coinBalance?: number;
    };

    if (lease.halted) {
      await setProgress({ running: false, halted: true, message: `Paused for today — ${lease.haltReason ?? 'unusual page seen'}` });
      return `Paused for today: ${lease.haltReason ?? 'unusual page seen'}`;
    }
    if (lease.outOfCoins) {
      const message = 'Out of coins — top up to read more profiles.';
      await setProgress({ running: false, message });
      return message;
    }
    if (lease.contacts.length === 0) {
      await setProgress({ running: false, message: "Nothing left in the queue for today." });
      return 'Nothing to visit — the queue is empty or today’s limit is reached.';
    }

    await setProgress({ total: lease.contacts.length, message: `Visiting ${lease.contacts.length} profiles…` });

    // The worker gets its own window so it never steals the tab you are using.
    const win = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1200, height: 900 });
    windowId = win?.id;
    tabId = win?.tabs?.[0]?.id;
    if (!tabId) throw new Error('Could not open a working tab.');

    let visited = 0;
    let failed = 0;
    let consecutiveSuspicious = 0;

    for (const [i, contact] of lease.contacts.entries()) {
      if (abortRequested) {
        await setProgress({ message: 'Stopped — remaining profiles returned to the queue.' });
        break;
      }

      const name = `${contact.firstName} ${contact.lastName}`.trim();
      await setProgress({ current: i + 1, currentName: name, message: `Opening ${name}…` });

      await chrome.tabs.update(tabId, { url: contact.profileUrl });
      await waitForLoad(tabId);
      // Let the page settle before reading, as a person's eyes would.
      await wait(jitter(2500, 5000));

      let text = '';
      let companyLinks: string[] = [];
      let landedUrl = '';
      try {
        landedUrl = (await chrome.tabs.get(tabId)).url ?? '';
        await setProgress({ message: `Reading ${name}'s profile…` });
        ({ text, companyLinks } = await capturePage(tabId));
      } catch (error) {
        logger.warning('capture failed:', error);
      }

      // Redirected to a checkpoint: unambiguous, stop immediately.
      if (CHECKPOINT_URLS.test(landedUrl)) {
        const reason = `LinkedIn redirected to a security check (${landedUrl.slice(0, 120)})`;
        await api('/api/pass2/halt', { reason }).catch(() => {});
        await setProgress({ running: false, halted: true, message: `Stopped — ${reason}` });
        return `Stopped for today: ${reason}`;
      }

      // Text-only signal: skip this one, and only stop if it happens twice in
      // a row — a single match can be a false positive on ordinary prose.
      if (CHECKPOINT_TEXT.test(text)) {
        consecutiveSuspicious++;
        if (consecutiveSuspicious >= 2) {
          const reason = 'two profiles in a row looked like a security check';
          await api('/api/pass2/halt', { reason }).catch(() => {});
          await setProgress({ running: false, halted: true, message: `Stopped — ${reason}` });
          return `Stopped for today: ${reason}`;
        }
        failed++;
        await setProgress({ failed, message: `${name}: page looked unusual — skipped.` });
        if (i < lease.contacts.length - 1) await wait(jitter(8000, 20000));
        continue;
      }
      consecutiveSuspicious = 0;

      if (!text || text.length < 200 || WALL_MARKERS.test(text)) {
        failed++;
        await setProgress({ failed, message: `${name}: profile could not be read — skipped.` });
      } else {
        try {
          // Scoring runs server-side and takes 30-90s — say so, or a healthy
          // sitting reads as stuck (live confusion 2026-07-27).
          await setProgress({ message: `Scoring ${name} (takes a minute)…` });
          const captureRes = await api('/api/pass2/capture', {
            contactId: contact.id,
            text,
            url: contact.profileUrl,
            companyLinks,
          });
          visited++;
          await setProgress({ visited, message: `${name}: captured.` });

          // The server may want the employer's page read once — do it now,
          // while we are naturally browsing, like a person clicking through.
          const visitCompany = captureRes?.visitCompany as { url: string; key: string } | null | undefined;
          if (visitCompany?.url && visitCompany.key && !abortRequested) {
            await wait(jitter(4000, 9000));
            await setProgress({ message: `Reading ${name}'s company page…` });
            const outcome = await readCompanyPage(tabId, visitCompany).catch(error => {
              logger.warning('company read failed:', error);
              return 'ok' as const;
            });
            if (outcome === 'checkpoint') {
              const reason = 'LinkedIn redirected to a security check on a company page';
              await api('/api/pass2/halt', { reason }).catch(() => {});
              await setProgress({ running: false, halted: true, message: `Stopped — ${reason}` });
              return `Stopped for today: ${reason}`;
            }
          }
        } catch (error) {
          failed++;
          await setProgress({ failed, message: `${name}: ${(error as Error).message}` });
        }
      }

      if (i < lease.contacts.length - 1 && !abortRequested) {
        const gap = jitter(8000, 20000);
        await setProgress({ message: `Pausing ${Math.round(gap / 1000)}s…` });
        await wait(gap);
      }
    }

    const summary = `Sitting finished — ${visited} read${failed ? `, ${failed} skipped` : ''}.`;
    await setProgress({ running: false, message: summary, finishedAt: Date.now() });
    return summary;
  } catch (error) {
    const message = (error as Error).message;
    await setProgress({ running: false, message: `Stopped: ${message}` });
    return `Stopped: ${message}`;
  } finally {
    // Close the working window; anything unvisited expires back to the queue.
    if (windowId !== undefined) await chrome.windows.remove(windowId).catch(() => {});
  }
}
