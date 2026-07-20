import 'webextension-polyfill';
import { createLogger } from './log';
import { handleCommand } from './commands';
import { runAgentTask } from './agent/loop';
import { streamChatReply } from './agent/chat';
import { handleTeachMessage } from './recorder/teach';
import { initSchedules, setUserTaskProbe, cancelScheduledRun } from './schedules';
import { acquireTaskTab } from './taskWindow';
import { postExecutionEvent } from './events';
import { Actors } from '@extension/storage';

const logger = createLogger('background');

const SIDE_PANEL_URL = chrome.runtime.getURL('side-panel/index.html');

let currentPort: chrome.runtime.Port | null = null;
let currentAbort: AbortController | null = null;
let teachAbort: AbortController | null = null;

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
          try {
            if (message.tabId) {
              // Agent mode runs in the DEDICATED agent window, never in the
              // tab the user is browsing (user decision 2026-07-20). Same
              // session reuses its tab so "continue" sees the stalled page.
              // Announce BEFORE opening and give the user a beat to read it
              // (feedback: the window popped before the message was legible).
              postExecutionEvent(
                port,
                Actors.SYSTEM,
                'step.ok',
                message.taskId,
                '🪟 This task runs in a separate agent window, opening in a moment — keep using your current window. A small trace window opens next to it so you can watch the steps live.',
              );
              await sleep(3000);
              const acquired = await acquireTaskTab(message.taskId);
              // The loop decides whether the task needs the browser
              // (a 'respond' decision falls back to plain streaming chat)
              await runAgentTask(
                broadcastPort(port),
                acquired?.tabId ?? message.tabId,
                message.taskId,
                message.task,
                abort.signal,
              );
            } else {
              await streamChatReply(port, message.taskId, message.task, abort.signal);
            }
          } finally {
            if (currentAbort === abort) currentAbort = null;
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
