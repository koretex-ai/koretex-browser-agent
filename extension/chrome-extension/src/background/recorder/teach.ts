import { createLogger } from '../log';
import { skillStore } from '@extension/storage';
import { distillSkill, type SkillDraft } from '../agent/orchestrator';

const logger = createLogger('teach');

/**
 * TEACH-BY-DEMONSTRATION: the user presses Teach, performs a task by hand in
 * the live tab, optionally types notes, and stops. What is recorded is a
 * SEMANTIC EVENT LOG — actions described in the navigator's vocabulary
 * (labels, roles, context), not video and not a DOM stream — which a cloud
 * call distills into a draft SKILL (a playbook prior; never a replayable
 * macro). The user answers the distiller's interview questions, reviews, and
 * saves; the skill then pins into runs exactly like any custom skill.
 *
 * Privacy: password fields are always masked at capture time; screenshots
 * are not captured; the event log leaves the machine only for the distill
 * call (same no-retention routing as every orchestrator call).
 */

interface TeachEvent {
  kind: 'navigate' | 'click' | 'type' | 'key' | 'scroll';
  url?: string;
  target?: string;
  field?: string;
  value?: string;
  combo?: string;
}

interface TeachSession {
  tabId: number;
  status: 'recording' | 'reviewing';
  events: string[];
  notes: string[];
  qa: { question: string; answer: string }[];
  draft: SkillDraft | null;
  startedAt: number;
}

let session: TeachSession | null = null;

const MAX_EVENTS = 400;

// ---- page-injected recorder (self-contained: serialized by executeScript) ----
function installPageRecorder() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__lbuTeachInstalled) {
    w.__lbuTeachOn = true;
    return;
  }
  w.__lbuTeachInstalled = true;
  w.__lbuTeachOn = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = (event: any) => {
    if (!w.__lbuTeachOn) return;
    try {
      chrome.runtime.sendMessage({ __lbuTeach: true, ...event, url: location.host + location.pathname });
    } catch {
      /* extension reloaded mid-recording — nothing to do */
    }
  };

  const describe = (node: EventTarget | null): { target: string } => {
    let el = node instanceof Element ? node : null;
    // Walk up to the closest interactive element so the description names
    // the control, not a text node inside it
    const INTERACTIVE = 'a,button,input,select,textarea,[role],[onclick],[contenteditable],summary,label';
    if (el && !el.matches(INTERACTIVE)) el = el.closest(INTERACTIVE) ?? el;
    if (!el) return { target: '(unknown element)' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyEl = el as any;
    const label = (
      el.getAttribute('aria-label') ||
      (el.textContent ?? '').trim().slice(0, 60) ||
      anyEl.placeholder ||
      el.getAttribute('title') ||
      anyEl.alt ||
      anyEl.name ||
      el.tagName.toLowerCase()
    ).replace(/\s+/g, ' ');
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    // Nearest named container gives the "place" half of the description
    const region = el.closest('dialog,[role="dialog"],nav,header,footer,aside,form,[role="menu"]');
    const regionName = region
      ? (region.getAttribute('aria-label') || region.tagName.toLowerCase()).replace(/\s+/g, ' ').slice(0, 40)
      : '';
    return { target: `"${label}" (${role}${regionName ? ` in ${regionName}` : ''})` };
  };

  // Typing is buffered per field and flushed as ONE event with the final
  // value — a keystroke stream is noise the distiller has to undo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let typing: any = null;
  const flushTyping = () => {
    if (typing) {
      send(typing);
      typing = null;
    }
  };

  document.addEventListener(
    'click',
    event => {
      flushTyping();
      send({ kind: 'click', ...describe(event.target) });
    },
    true,
  );

  document.addEventListener(
    'input',
    event => {
      const el = event.target;
      if (!(el instanceof HTMLElement)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyEl = el as any;
      const isField = 'value' in anyEl || el.isContentEditable;
      if (!isField) return;
      const masked = anyEl.type === 'password';
      const raw = el.isContentEditable ? (el.textContent ?? '') : String(anyEl.value ?? '');
      typing = {
        kind: 'type',
        field: describe(el).target,
        value: masked ? '••••••' : raw.slice(0, 300),
      };
    },
    true,
  );

  document.addEventListener('blur', flushTyping, true);

  document.addEventListener(
    'keydown',
    event => {
      if (!['Enter', 'Tab', 'Escape'].includes(event.key) && !(event.metaKey || event.ctrlKey)) return;
      flushTyping();
      const mods = `${event.metaKey ? 'Cmd+' : ''}${event.ctrlKey ? 'Ctrl+' : ''}${event.shiftKey ? 'Shift+' : ''}`;
      if (event.key.length === 1 && !mods) return; // plain characters are typing, not commands
      send({ kind: 'key', combo: `${mods}${event.key}` });
    },
    true,
  );

  let lastScrollAt = 0;
  window.addEventListener(
    'scroll',
    () => {
      const now = Date.now();
      if (now - lastScrollAt < 3000) return;
      lastScrollAt = now;
      send({ kind: 'scroll' });
    },
    true,
  );
}

function disablePageRecorder() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__lbuTeachOn = false;
}

// ---- event intake ----

function renderEvent(event: TeachEvent): string {
  const at = event.url ? ` (${event.url})` : '';
  switch (event.kind) {
    case 'navigate':
      return `navigate → ${event.url}`;
    case 'click':
      return `click ${event.target}${at}`;
    case 'type':
      return `type "${event.value}" into ${event.field}${at}`;
    case 'key':
      return `press ${event.combo}${at}`;
    case 'scroll':
      return `scroll${at}`;
    default:
      return JSON.stringify(event).slice(0, 120);
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message?.__lbuTeach) return;
  if (!session || session.status !== 'recording' || sender.tab?.id !== session.tabId) return;
  if (session.events.length >= MAX_EVENTS) return;
  const line = renderEvent(message as TeachEvent);
  // Collapse immediate duplicates (repeated scrolls, double-fired clicks)
  if (session.events[session.events.length - 1] === line) return;
  session.events.push(line);
});

const onTabUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
  if (!session || session.status !== 'recording' || tabId !== session.tabId) return;
  if (changeInfo.status !== 'complete') return;
  if (tab.url && !/^https?:/i.test(tab.url)) return;
  session.events.push(`navigate → ${tab.url ?? '(unknown)'}`);
  chrome.scripting
    .executeScript({ target: { tabId }, func: installPageRecorder })
    .catch(error => logger.warning('recorder re-inject failed:', error));
};

// The demonstration follows the USER, not a tab: opening a result in a new
// tab or switching tabs mid-demo re-binds the recording to the active tab
// (a tab-bound recording silently captured nothing after a tab switch)
const onTabActivated = async (activeInfo: chrome.tabs.TabActiveInfo) => {
  if (!session || session.status !== 'recording' || activeInfo.tabId === session.tabId) return;
  session.tabId = activeInfo.tabId;
  const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
  if (tab?.url && /^https?:/i.test(tab.url)) {
    session.events.push(`switched tab → ${tab.url}`);
    await chrome.scripting
      .executeScript({ target: { tabId: activeInfo.tabId }, func: installPageRecorder })
      .catch(error => logger.warning('recorder inject on tab switch failed:', error));
  }
};

// ---- side-panel message handling ----

type Post = (message: unknown) => void;

/** UI phase implied by the current session — sent with every teach message */
const phase = (): 'recording' | 'reviewing' | 'idle' => session?.status ?? 'idle';

function renderDraftMessage(draft: SkillDraft): string {
  const lines = [
    `Here's the skill I learned from your demonstration:`,
    ``,
    `**${draft.name}**`,
    `Sites: ${draft.hosts.join(', ') || '(none — task-triggered only)'}`,
    `Task match: ${draft.intent || '(none — site-triggered only)'}`,
    ``,
    draft.guidance,
  ];
  if (draft.questions?.length) {
    lines.push(
      ``,
      `A few things I'd like to confirm — reply in chat and I'll refine the draft:`,
      ...draft.questions.map((question, i) => `${i + 1}. ${question}`),
    );
  }
  lines.push(``, `Reply to refine, or press Save skill / Discard above the input.`);
  return lines.join('\n');
}

export async function handleTeachMessage(
  post: Post,
  message: { type: string; tabId?: number; text?: string },
  signal: AbortSignal,
): Promise<void> {
  switch (message.type) {
    case 'teach_start': {
      if (!message.tabId)
        return post({ type: 'teach_error', error: 'No tab to record — open the site first.', teachPhase: phase() });
      if (session)
        return post({ type: 'teach_error', error: 'A teaching session is already in progress.', teachPhase: phase() });
      session = {
        tabId: message.tabId,
        status: 'recording',
        events: [],
        notes: [],
        qa: [],
        draft: null,
        startedAt: Date.now(),
      };
      // On a real page: attach now. On a chrome://newtab or similar: start
      // anyway — the navigation/tab-switch listeners attach the recorder the
      // moment the user reaches an actual website.
      const tab = await chrome.tabs.get(message.tabId).catch(() => null);
      const onRealPage = Boolean(tab?.url && /^https?:/i.test(tab.url));
      if (onRealPage) {
        session.events.push(`navigate → ${tab!.url} (starting page)`);
        await chrome.scripting
          .executeScript({ target: { tabId: message.tabId }, func: installPageRecorder })
          .catch(error => logger.warning('recorder inject at start failed:', error));
      }
      chrome.tabs.onUpdated.addListener(onTabUpdated);
      chrome.tabs.onActivated.addListener(onTabActivated);
      post({
        type: 'teach_update',
        text: onRealPage
          ? '⏺ Recording. Perform the task by hand in the page — I am watching what you do (passwords are always masked). Type notes here anytime ("this filter is paywalled — skip it"), and press Finish when done.'
          : '⏺ Recording. Navigate to the website you want to demonstrate on — I start watching the moment you get there (passwords are always masked). Type notes here anytime, and press Finish when done.',
        teachPhase: 'recording',
      });
      return;
    }

    case 'teach_note': {
      if (!session || session.status !== 'recording') return;
      const note = (message.text ?? '').trim();
      if (!note) return;
      session.notes.push(note);
      session.events.push(`note: ${note}`);
      post({ type: 'teach_update', text: '📝 Noted.', teachPhase: 'recording' });
      return;
    }

    case 'teach_stop': {
      if (!session)
        return post({ type: 'teach_error', error: 'No teaching session in progress.', teachPhase: 'idle' });
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.tabs.onActivated.removeListener(onTabActivated);
      await chrome.scripting
        .executeScript({ target: { tabId: session.tabId }, func: disablePageRecorder })
        .catch(() => {});
      if (session.events.length === 0) {
        session = null;
        return post({ type: 'teach_error', error: 'Nothing was recorded — no skill to distill.', teachPhase: 'idle' });
      }
      session.status = 'reviewing';
      post({
        type: 'teach_update',
        text: `⏹ Recorded ${session.events.length} step(s). Distilling what you showed me…`,
        teachPhase: 'distilling',
      });
      try {
        const { result } = await distillSkill({ events: session.events, notes: session.notes, qa: [] }, signal);
        session.draft = result;
        post({ type: 'teach_draft', draft: result, message: renderDraftMessage(result), teachPhase: 'reviewing' });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        post({
          type: 'teach_error',
          error: `Distilling failed: ${text}. The recording is kept — reply anything to retry.`,
          teachPhase: 'reviewing',
        });
      }
      return;
    }

    case 'teach_answer': {
      if (!session) return post({ type: 'teach_error', error: 'No teaching session in progress.', teachPhase: 'idle' });
      const answer = (message.text ?? '').trim();
      if (!answer) return;
      if (session.draft) {
        const outstanding = session.draft.questions?.join(' / ') || '(user comment on the draft)';
        session.qa.push({ question: outstanding, answer });
      } else {
        // Distilling previously failed — treat the reply as a note and retry
        session.notes.push(answer);
      }
      post({ type: 'teach_update', text: 'Refining the skill with your answer…', teachPhase: 'distilling' });
      try {
        const { result } = await distillSkill(
          { events: session.events, notes: session.notes, qa: session.qa, priorDraft: session.draft ?? undefined },
          signal,
        );
        session.draft = result;
        post({ type: 'teach_draft', draft: result, message: renderDraftMessage(result), teachPhase: 'reviewing' });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        post({
          type: 'teach_error',
          error: `Refining failed: ${text}.${session.draft ? ' You can still Save the current draft.' : ' Reply anything to retry.'}`,
          teachPhase: 'reviewing',
        });
      }
      return;
    }

    case 'teach_save': {
      if (!session?.draft)
        return post({ type: 'teach_error', error: 'No skill draft to save.', teachPhase: phase() });
      const { draft } = session;
      await skillStore.upsert({
        name: draft.name,
        hosts: draft.hosts,
        intent: draft.intent,
        guidance: draft.guidance,
        source: {
          recordedAt: session.startedAt,
          events: session.events,
          notes: session.notes,
          qa: session.qa,
        },
      });
      session = null;
      post({
        type: 'teach_saved',
        name: draft.name,
        message: `✅ Skill "${draft.name}" saved. It will pin automatically when a task or site matches (watch for the 📘 line). Try it now with a related task — and you can edit it anytime in Options → Site playbooks.`,
        teachPhase: 'idle',
      });
      return;
    }

    case 'teach_discard': {
      if (session) {
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
        chrome.tabs.onActivated.removeListener(onTabActivated);
        await chrome.scripting
          .executeScript({ target: { tabId: session.tabId }, func: disablePageRecorder })
          .catch(() => {});
      }
      session = null;
      post({ type: 'teach_update', text: 'Teaching session discarded.', teachPhase: 'idle' });
      return;
    }

    default:
      post({ type: 'teach_error', error: `Unknown teach message: ${message.type}`, teachPhase: phase() });
  }
}

/** Whether a teach session is currently active (recording or reviewing). */
export function teachActive(): boolean {
  return session !== null;
}
