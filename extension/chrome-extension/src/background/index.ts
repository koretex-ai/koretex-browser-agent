import 'webextension-polyfill';
import { createLogger } from './log';
import { runSitting, getProgress, requestAbort, recoverOrphanedSitting } from './prospecting';
import { initAutopilot, enableAutopilot, disableAutopilot, getAutopilotState } from './autopilot';
import { sendLinkedInMessage } from './outreach';
import { handleCommand } from './commands';
import { runAgentTask } from './agent/loop';
import { streamChatReply } from './agent/chat';
import { handleTeachMessage } from './recorder/teach';
import { initSchedules, setUserTaskProbe, cancelScheduledRun } from './schedules';
import { acquireTaskTab, hasSessionTab } from './taskWindow';
import { postExecutionEvent } from './events';
import { Actors, chatHistoryStore } from '@extension/storage';

const logger = createLogger('background');

const SIDE_PANEL_URL = chrome.runtime.getURL('side-panel/index.html');

let currentPort: chrome.runtime.Port | null = null;
let currentAbort: AbortController | null = null;
let teachAbort: AbortController | null = null;
// Session of the task in flight — lets a panel that connects MID-RUN (the
// trace viewer) backfill the transcript so far from chat history
let currentTaskSessionId: string | null = null;

// Every connected side panel — the agent window's own panel included. Agent
// task events BROADCAST to all of them so the trace is watchable next to the
// pages being driven (user feedback 2026-07-20: trace only showed in the
// window the task was typed in). Only the ORIGINATING panel has the session
// loaded, so only it persists messages to chat history — a fresh panel in
// the agent window displays live events without double-writing them.
const connectedPorts = new Set<chrome.runtime.Port>();
const broadcastPort = (origin: chrome.runtime.Port): chrome.runtime.Port =>
  ({
    postMessage: (message: unknown) => {
      let delivered = false;
      for (const port of connectedPorts) {
        try {
          port.postMessage(message);
          delivered = true;
        } catch {
          /* that panel is gone — the disconnect listener prunes it */
        }
      }
      // Every panel closed: fall back to the origin port's own error path
      if (!delivered) origin.postMessage(message);
    },
  }) as chrome.runtime.Port;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

logger.info('background loaded');

// Recurring user schedules: alarms fire agent runs even with the panel closed
setUserTaskProbe(() => currentAbort !== null);
initSchedules();

// Manifest content scripts only reach pages loaded AFTER the extension starts,
// so a dashboard tab that was already open would never gain the bridge (and
// would wrongly report "extension not running"). Inject it into any open
// Koretex tab at startup and after an update.
const BRIDGE_MATCHES = [
  'http://localhost:3000/*',
  'http://127.0.0.1:3000/*',
  'https://koretex.ai/*',
  'https://*.koretex.ai/*',
];

async function injectBridgeIntoOpenTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: BRIDGE_MATCHES });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['pass2-bridge.js'] })
        .catch(() => {
          /* tab closed or not scriptable — harmless */
        });
    }
  } catch (error) {
    logger.warning('bridge injection failed:', error);
  }
}

void injectBridgeIntoOpenTabs();
chrome.runtime.onInstalled.addListener(() => void injectBridgeIntoOpenTabs());

// Pass 2 prospecting worker — driven from the dashboard, independent of the
// agent loop. Hands only: it visits profiles and ships the text to the server.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pass2_run_sitting') {
    runSitting(Number(message.count) || 3)
      .then(summary => sendResponse({ ok: true, summary }))
      .catch(error => sendResponse({ ok: false, summary: (error as Error).message }));
    return true; // async response
  }
  if (message?.type === 'pass2_progress') {
    getProgress()
      .then(progress => sendResponse(progress))
      .catch(() => sendResponse(null));
    return true;
  }
  if (message?.type === 'pass2_stop') {
    requestAbort();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'pass2_autopilot_set') {
    (message.enabled ? enableAutopilot() : disableAutopilot())
      .then(state => sendResponse(state))
      .catch(() => sendResponse(null));
    return true;
  }
  if (message?.type === 'pass2_autopilot_status') {
    getAutopilotState()
      .then(state => sendResponse(state))
      .catch(() => sendResponse(null));
    return true;
  }
  if (message?.type === 'pass2_send_message') {
    const payload = message.payload as { messageId?: string; profileUrl?: string; body?: string } | undefined;
    sendLinkedInMessage({
      messageId: String(payload?.messageId ?? ''),
      profileUrl: String(payload?.profileUrl ?? ''),
      body: String(payload?.body ?? ''),
    })
      .then(outcome => sendResponse(outcome))
      .catch(error => sendResponse({ ok: false, reason: (error as Error).message }));
    return true;
  }
  return false;
});

// Autopilot alarms fire sittings even while the dashboard is closed.
initAutopilot();
// A "running" sitting at boot belongs to a worker Chrome already killed.
void recoverOrphanedSitting();

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'side-panel-connection') return;

  const senderUrl = port.sender?.url;
  const senderId = port.sender?.id;
  if (!senderUrl || senderId !== chrome.runtime.id || senderUrl !== SIDE_PANEL_URL) {
    logger.warning('Blocked unauthorized side-panel-connection', senderId, senderUrl);
    port.disconnect();
    return;
  }

  currentPort = port;
  connectedPorts.add(port);

  // A task is already running: seed this panel with the transcript so far
  // (the originating panel persists every message as it happens)
  if (currentAbort && currentTaskSessionId) {
    const sessionId = currentTaskSessionId;
    chatHistoryStore
      .getSession(sessionId)
      .then(session => {
        // taskRunning tells a mid-run panel (the trace viewer) to show the
        // Stop button — cancel_task works from ANY port, the panel just never
        // knew a task was live (live failure 2026-07-21: the agent window's
        // panel had no way to stop the run). Sent even with an empty
        // transcript so the button appears regardless.
        // sessionId lets the panel bind to the watched session, so replies
        // typed here (clarify answers) carry a valid taskId
        port.postMessage({ type: 'session_backfill', messages: session?.messages ?? [], taskRunning: true, sessionId });
      })
      .catch(error => logger.warning('session backfill failed:', error));
  }

  port.onMessage.addListener(async message => {
    try {
      switch (message.type) {
        case 'heartbeat':
          port.postMessage({ type: 'heartbeat_ack' });
          break;

        case 'new_task':
        case 'follow_up_task': {
          if (!message.task) return port.postMessage({ type: 'error', error: 'No task provided' });
          if (!message.taskId) return port.postMessage({ type: 'error', error: 'No task ID provided' });
          logger.info(message.type, message.taskId, message.tabId, message.task);

          currentAbort?.abort();
          // The user's task takes the tab — never let a scheduled run share it
          cancelScheduledRun();
          const abort = new AbortController();
          currentAbort = abort;
          currentTaskSessionId = message.taskId;
          try {
            if (message.tabId) {
              // Capture what the user was LOOKING AT before the run leaves
              // their window — deictic objectives ("fill out this form") are
              // unresolvable without it (live failure 2026-07-21: an agent-
              // window run invented a Gmail errand because "this form" on the
              // user's tab was invisible to every model).
              const userTab = await chrome.tabs.get(message.tabId).catch(() => null);
              const userPage =
                userTab?.url && /^https?:/i.test(userTab.url) ? { url: userTab.url, title: userTab.title ?? '' } : null;
              // Agent mode runs in the DEDICATED agent window, never in the
              // tab the user is browsing (user decision 2026-07-20). Same
              // session reuses its tab so "continue" sees the stalled page.
              // Announce BEFORE opening and give the user a beat to read it
              // (feedback: the window popped before the message was legible).
              // Follow-ups that reuse the session's live tab announce nothing
              // — no window opens, and the replayed notice + 3s pause read as
              // a new window being spawned (user feedback 2026-07-21).
              if (!(await hasSessionTab(message.taskId))) {
                postExecutionEvent(
                  port,
                  Actors.SYSTEM,
                  'step.ok',
                  message.taskId,
                  '🪟 This task runs in a separate agent window, opening in front so you can watch it work — switch back to your own window anytime, the agent keeps going. A small trace window opens next to it with the live steps.',
                );
                await sleep(3000);
              }
              const acquired = await acquireTaskTab(message.taskId);
              // The loop decides whether the task needs the browser
              // (a 'respond' decision falls back to plain streaming chat)
              await runAgentTask(
                broadcastPort(port),
                acquired?.tabId ?? message.tabId,
                message.taskId,
                message.task,
                abort.signal,
                userPage,
              );
            } else {
              await streamChatReply(port, message.taskId, message.task, abort.signal);
            }
          } finally {
            if (currentAbort === abort) {
              currentAbort = null;
              currentTaskSessionId = null;
            }
          }
          break;
        }

        case 'command': {
          if (!message.command) return port.postMessage({ type: 'error', error: 'No command provided' });
          if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });
          logger.info('command', message.tabId, message.command);
          try {
            const result = await handleCommand(message.command, message.tabId, message.taskId ?? 'adhoc');
            port.postMessage({ type: 'command_result', text: result.text, image: result.image });
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            port.postMessage({ type: 'command_result', text: `Command failed: ${text}` });
          }
          break;
        }

        case 'cancel_task': {
          if (!currentAbort) return port.postMessage({ type: 'error', error: 'No running task' });
          currentAbort.abort();
          break;
        }

        case 'skillify_start':
        case 'teach_start':
        case 'teach_note':
        case 'teach_stop':
        case 'teach_answer':
        case 'teach_save':
        case 'teach_discard': {
          teachAbort ??= new AbortController();
          await handleTeachMessage(m => port.postMessage(m), message, teachAbort.signal);
          if (message.type === 'teach_save' || message.type === 'teach_discard') teachAbort = null;
          break;
        }

        default:
          return port.postMessage({ type: 'error', error: `Unknown command: ${message.type}` });
      }
    } catch (error) {
      console.error('Error handling port message:', error);
      port.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('Side panel disconnected');
    connectedPorts.delete(port);
    if (currentPort === port) {
      currentPort = null;
    }
    // Only kill the running task when NO panel remains — closing the agent
    // window's viewer panel (or the originating one) must not abort a run
    // the user is still watching elsewhere
    if (connectedPorts.size === 0) {
      currentAbort?.abort();
      teachAbort?.abort();
      teachAbort = null;
    }
  });
});
