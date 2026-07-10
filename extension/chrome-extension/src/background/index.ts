import 'webextension-polyfill';
import { Actors, chatHistoryStore, chatSettingsStore } from '@extension/storage';
import { createLogger } from './log';
import { handleCommand } from './commands';

const logger = createLogger('background');

const SIDE_PANEL_URL = chrome.runtime.getURL('side-panel/index.html');

const SYSTEM_PROMPT =
  'You are a helpful assistant running fully locally in a browser side panel. ' +
  'Answer the user directly and concisely. Use plain text, not markdown.';

let currentPort: chrome.runtime.Port | null = null;
let currentAbort: AbortController | null = null;

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

logger.info('background loaded');

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function postExecutionEvent(port: chrome.runtime.Port, actor: Actors, state: string, taskId: string, details = '') {
  try {
    port.postMessage({
      type: 'execution',
      actor,
      state,
      data: { taskId, step: 0, maxSteps: 0, details },
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error('Failed to send message to side panel:', error);
  }
}

// Rebuild the model conversation from the persisted chat session.
// The side panel saves the user message before sending the task, but the
// write may still be in flight, so append the task if it is not there yet.
async function buildChatMessages(taskId: string, task: string): Promise<OllamaChatMessage[]> {
  const messages: OllamaChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  const session = await chatHistoryStore.getSession(taskId).catch(() => null);
  if (session) {
    for (const message of session.messages) {
      if (message.actor === Actors.USER) {
        // Slash commands drive the executor, not the model — keep them out of chat context
        if (message.content.startsWith('/')) continue;
        messages.push({ role: 'user', content: message.content });
      } else if (message.actor === Actors.ASSISTANT) {
        messages.push({ role: 'assistant', content: message.content });
      }
      // SYSTEM messages are UI notices (errors, cancellations), not model context
    }
  }

  const last = messages[messages.length - 1];
  if (!(last.role === 'user' && last.content === task)) {
    messages.push({ role: 'user', content: task });
  }
  return messages;
}

async function runChat(port: chrome.runtime.Port, taskId: string, task: string) {
  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;

  const { baseUrl, model } = await chatSettingsStore.getSettings();
  postExecutionEvent(port, Actors.SYSTEM, 'task.start', taskId);

  try {
    const messages = await buildChatMessages(taskId, task);
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // think: false — qwen3.5 supports non-thinking mode; skip reasoning tokens for snappy chat
      body: JSON.stringify({ model, messages, stream: true, think: false }),
      signal: abort.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama request failed (HTTP ${response.status}). Is Ollama running at ${baseUrl}?`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    // Ollama streams newline-delimited JSON chunks
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error(chunk.error);
        const delta: string = chunk.message?.content ?? '';
        if (delta) {
          fullText += delta;
          port.postMessage({ type: 'stream_chunk', taskId, delta });
        }
      }
    }

    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, fullText);
  } catch (error) {
    if (abort.signal.aborted) {
      postExecutionEvent(port, Actors.SYSTEM, 'task.cancel', taskId, 'Stopped.');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Chat failed:', message);
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, message);
    }
  } finally {
    if (currentAbort === abort) {
      currentAbort = null;
    }
  }
}

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
          logger.info(message.type, message.taskId, message.task);
          await runChat(port, message.taskId, message.task);
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
    if (currentPort === port) {
      currentPort = null;
    }
    currentAbort?.abort();
  });
});
