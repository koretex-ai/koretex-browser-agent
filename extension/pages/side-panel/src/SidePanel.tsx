import { useState, useEffect, useCallback, useRef } from 'react';
import { FiSettings, FiClock, FiHelpCircle } from 'react-icons/fi';
import { PiPlusBold, PiGraduationCapBold, PiBugBold } from 'react-icons/pi';
import { GrHistory } from 'react-icons/gr';
import { type Message, Actors, chatHistoryStore, trajectoryStore, onboardingStore } from '@extension/storage';
import favoritesStorage, { type FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import { t } from '@extension/i18n';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import ChatHistoryList from './components/ChatHistoryList';
import BookmarkList from './components/BookmarkList';
import ScheduleList from './components/ScheduleList';
import ReportDialog from './components/ReportDialog';
import OnboardingDialog from './components/OnboardingDialog';
import { EventType, type AgentEvent, ExecutionState } from './types/event';
import './SidePanel.css';

// Declare chrome API types
declare global {
  interface Window {
    chrome: typeof chrome;
  }
}

const PROGRESS_MESSAGE = 'Showing progress...';

const SidePanel = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputEnabled, setInputEnabled] = useState(true);
  const [showStopButton, setShowStopButton] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; createdAt: number }>>([]);
  const [isFollowUpMode, setIsFollowUpMode] = useState(false);
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);
  // Always-dark theme keyed to the logo
  const isDarkMode = true;
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  // null = not streaming; '' = waiting for first token; otherwise partial reply
  const [streamingText, setStreamingText] = useState<string | null>(null);
  // Teach-by-demonstration flow: null = not teaching
  const [teachPhase, setTeachPhase] = useState<null | 'recording' | 'distilling' | 'reviewing'>(null);
  // A task just succeeded — offer to distill the run into a skill
  const [skillOffer, setSkillOffer] = useState(false);
  // Bug-report dialog for the current session (user-initiated only)
  const [showReport, setShowReport] = useState(false);
  // First-run tour: auto-opens once (onboardingStore flag), replayable via "?"
  const [showOnboarding, setShowOnboarding] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const appendMessage = useCallback((newMessage: Message, sessionId?: string | null) => {
    setMessages(prev => [...prev, newMessage]);

    // Use provided sessionId if available, otherwise fall back to sessionIdRef.current
    const effectiveSessionId = sessionId !== undefined ? sessionId : sessionIdRef.current;

    if (effectiveSessionId) {
      chatHistoryStore
        .addMessage(effectiveSessionId, newMessage)
        .catch(err => console.error('Failed to save message to history:', err));
    }
  }, []);

  const finishTask = useCallback(() => {
    setInputEnabled(true);
    setShowStopButton(false);
    setStreamingText(null);
  }, []);

  const handleExecutionEvent = useCallback(
    (event: AgentEvent) => {
      const { actor, state, timestamp, data } = event;
      const content = data?.details ?? '';
      const meta = data?.meta;

      switch (state) {
        case ExecutionState.TASK_START:
          setIsHistoricalSession(false);
          setSkillOffer(false);
          setStreamingText('');
          break;
        case ExecutionState.STEP_OK:
          // Agent-loop progress: narrate the step, keep the task running
          appendMessage({
            actor: Actors.SYSTEM,
            content,
            timestamp,
            meta,
          });
          setStreamingText('');
          break;
        case ExecutionState.TASK_OK:
          finishTask();
          setIsFollowUpMode(true);
          appendMessage({
            actor: Actors.ASSISTANT,
            content,
            timestamp,
            meta,
          });
          break;
        case ExecutionState.TASK_FAIL:
          finishTask();
          setIsFollowUpMode(true);
          appendMessage({
            actor: Actors.SYSTEM,
            content: content || t('errors_unknown'),
            timestamp,
            meta,
          });
          break;
        case ExecutionState.TASK_CANCEL:
          finishTask();
          setIsFollowUpMode(false);
          appendMessage({
            actor: Actors.SYSTEM,
            content: content || 'Stopped.',
            timestamp,
          });
          break;
        default:
          console.error('Unexpected execution state', actor, state);
      }
    },
    [appendMessage, finishTask],
  );

  // Stop heartbeat and close connection
  const stopConnection = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (portRef.current) {
      portRef.current.disconnect();
      portRef.current = null;
    }
  }, []);

  // Setup connection management
  const setupConnection = useCallback(() => {
    // Only setup if no existing connection
    if (portRef.current) {
      return;
    }

    try {
      portRef.current = chrome.runtime.connect({ name: 'side-panel-connection' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      portRef.current.onMessage.addListener((message: any) => {
        if (message && message.type === EventType.EXECUTION) {
          handleExecutionEvent(message);
        } else if (message && message.type === 'stream_chunk') {
          setStreamingText(prev => (prev ?? '') + message.delta);
        } else if (message && message.type === 'command_result') {
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.text || '',
            image: message.image,
            timestamp: Date.now(),
          });
          finishTask();
        } else if (message && message.type === 'error') {
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('errors_unknown'),
            timestamp: Date.now(),
          });
          finishTask();
        } else if (message && message.type === 'heartbeat_ack') {
          console.log('Heartbeat acknowledged');
        } else if (message && message.type === 'skillify_offer') {
          setSkillOffer(true);
        } else if (message && typeof message.type === 'string' && message.type.startsWith('teach_')) {
          const content = message.message ?? message.text ?? message.error ?? '';
          if (content) {
            appendMessage({
              actor:
                message.type === 'teach_draft' || message.type === 'teach_saved' ? Actors.ASSISTANT : Actors.SYSTEM,
              content,
              timestamp: Date.now(),
            });
          }
          if (message.teachPhase) {
            setTeachPhase(message.teachPhase === 'idle' ? null : message.teachPhase);
          }
        }
      });

      portRef.current.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Connection disconnected', error ? `Error: ${error.message}` : '');
        portRef.current = null;
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        finishTask();
      });

      // Setup heartbeat interval
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = window.setInterval(() => {
        if (portRef.current?.name === 'side-panel-connection') {
          try {
            portRef.current.postMessage({ type: 'heartbeat' });
          } catch (error) {
            console.error('Heartbeat failed:', error);
            stopConnection(); // Stop connection if heartbeat fails
          }
        } else {
          stopConnection(); // Stop if port is invalid
        }
      }, 25000);
    } catch (error) {
      console.error('Failed to establish connection:', error);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_conn_serviceWorker'),
        timestamp: Date.now(),
      });
      // Clear any references since connection failed
      portRef.current = null;
    }
  }, [handleExecutionEvent, appendMessage, stopConnection, finishTask]);

  // Add safety check for message sending
  const sendMessage = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (message: any) => {
      if (portRef.current?.name !== 'side-panel-connection') {
        throw new Error('No valid connection available');
      }
      try {
        portRef.current.postMessage(message);
      } catch (error) {
        console.error('Failed to send message:', error);
        stopConnection(); // Stop connection when message sending fails
        throw error;
      }
    },
    [stopConnection],
  );

  // Export logged trajectories as training-ready JSONL (runs in the panel:
  // pages can trigger downloads, the service worker cannot)
  const handleExport = async () => {
    try {
      const sessionIds = await trajectoryStore.getSessionIds();
      const lines: string[] = [];
      let plannerExamples = 0;
      let groundingExamples = 0;

      for (const sessionId of sessionIds) {
        const [steps, subtasks, tasks] = await Promise.all([
          trajectoryStore.getSteps(sessionId),
          trajectoryStore.getSubtasks(sessionId),
          trajectoryStore.getTasks(sessionId),
        ]);
        const subtaskById = new Map(subtasks.map(s => [s.id, s]));
        const taskById = new Map(tasks.map(t => [t.id, t]));

        for (const task of tasks) {
          lines.push(JSON.stringify({ type: 'task_record', ...task }));
        }
        for (const subtask of subtasks) {
          lines.push(JSON.stringify({ type: 'subtask_record', ...subtask }));
        }
        for (const step of steps) {
          const subtask = step.subtaskId ? subtaskById.get(step.subtaskId) : undefined;
          const task = subtask ? taskById.get(subtask.taskRecordId) : undefined;
          const labels = {
            action_ok: step.ok,
            subtask_ok: subtask ? subtask.status === 'ok' : null,
            task_ok: task ? task.outcome === 'ok' : null,
          };
          if (step.decision) {
            plannerExamples++;
            lines.push(
              JSON.stringify({
                type: 'planner_step',
                goal: subtask?.goal ?? null,
                history: step.historyContext ?? [],
                page: {
                  url: step.before.url,
                  title: step.before.title,
                  scroll: step.before.scroll,
                  elements: step.before.elements.map(el => {
                    const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
                    return `[${el.index}]<${kind}> ${el.text || el.placeholder || el.href || ''}`.trim();
                  }),
                },
                decision: step.decision,
                model: step.plannerModel ?? null,
                error: step.error ?? null,
                labels,
                timestamp: step.timestamp,
              }),
            );
          }
          if (step.action?.type === 'click_at' && step.action.target) {
            groundingExamples++;
            lines.push(
              JSON.stringify({
                type: 'grounding',
                screenshot: step.before.screenshot,
                instruction: step.action.target,
                x: step.action.x,
                y: step.action.y,
                labels,
                timestamp: step.timestamp,
              }),
            );
          }
        }
      }

      const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `local-browser-use-trajectories-${new Date().toISOString().slice(0, 10)}.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);

      appendMessage({
        actor: Actors.SYSTEM,
        content:
          `Exported ${lines.length} records (${plannerExamples} planner examples, ` +
          `${groundingExamples} grounding examples) from ${sessionIds.length} sessions.`,
        timestamp: Date.now(),
      });
    } catch (err) {
      appendMessage({
        actor: Actors.SYSTEM,
        content: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    }
  };

  // Slash commands drive the perception/executor layer against the active tab
  const handleCommand = async (command: string) => {
    if (command.trim() === '/export') {
      appendMessage({ actor: Actors.USER, content: command, timestamp: Date.now() });
      await handleExport();
      return;
    }
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No active tab found');

      setInputEnabled(false);
      setShowStopButton(false);

      // Commands need a session too: it keys the trajectory log and persists
      // the command exchange into chat history
      if (!sessionIdRef.current) {
        const newSession = await chatHistoryStore.createSession(command.substring(0, 50));
        setCurrentSessionId(newSession.id);
        sessionIdRef.current = newSession.id;
        setIsFollowUpMode(true);
      }

      appendMessage({
        actor: Actors.USER,
        content: command,
        timestamp: Date.now(),
      });

      if (!portRef.current) {
        setupConnection();
      }

      await sendMessage({
        type: 'command',
        command,
        taskId: sessionIdRef.current,
        tabId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      finishTask();
    }
  };

  const handleSendMessage = async (text: string, displayText?: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) return;

    // Block sending messages in historical sessions
    if (isHistoricalSession) {
      console.log('Cannot send messages in historical sessions');
      return;
    }

    if (trimmedText.startsWith('/')) {
      await handleCommand(trimmedText);
      return;
    }

    // Teach mode: the input feeds the recording (notes) or the draft review
    // (interview answers) instead of starting a task
    if (teachPhase === 'distilling') return;
    if (teachPhase === 'recording' || teachPhase === 'reviewing') {
      appendMessage({ actor: Actors.USER, content: trimmedText, timestamp: Date.now() });
      try {
        sendMessage({ type: teachPhase === 'recording' ? 'teach_note' : 'teach_answer', text: trimmedText });
      } catch (err) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
      }
      return;
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;

      setInputEnabled(false);
      setShowStopButton(true);

      // Create a new chat session for this conversation if not in follow-up mode
      if (!isFollowUpMode) {
        const titleText = displayText || text;
        const newSession = await chatHistoryStore.createSession(
          titleText.substring(0, 50) + (titleText.length > 50 ? '...' : ''),
        );

        const sessionId = newSession.id;
        setCurrentSessionId(sessionId);
        sessionIdRef.current = sessionId;
      }

      const userMessage = {
        actor: Actors.USER,
        content: displayText || text,
        timestamp: Date.now(),
      };

      // Pass the sessionId directly to appendMessage
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      await sendMessage({
        type: isFollowUpMode ? 'follow_up_task' : 'new_task',
        task: text,
        taskId: sessionIdRef.current,
        tabId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      finishTask();
      stopConnection();
    }
  };

  const handleStopTask = async () => {
    try {
      portRef.current?.postMessage({
        type: 'cancel_task',
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('cancel_task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
    }
    finishTask();
  };

  const sendTeach = useCallback(
    (message: { type: string; tabId?: number; text?: string }) => {
      try {
        if (!portRef.current) setupConnection();
        sendMessage(message);
      } catch (err) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
        setTeachPhase(null);
      }
    },
    [sendMessage, setupConnection, appendMessage],
  );

  const handleTeach = async () => {
    if (teachPhase || !inputEnabled || isHistoricalSession) return;
    setSkillOffer(false);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    setTeachPhase('recording');
    sendTeach({ type: 'teach_start', tabId: tabs[0]?.id });
  };

  // Distill the just-finished successful run into a skill (offer button)
  const handleSkillify = () => {
    if (teachPhase || !inputEnabled) return;
    setSkillOffer(false);
    setTeachPhase('distilling');
    sendTeach({ type: 'skillify_start' });
  };

  const handleNewChat = () => {
    if (teachPhase) sendTeach({ type: 'teach_discard' });
    setTeachPhase(null);
    setSkillOffer(false);
    // Clear messages and start a new chat
    setMessages([]);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    setInputEnabled(true);
    setShowStopButton(false);
    setStreamingText(null);
    setIsFollowUpMode(false);
    setIsHistoricalSession(false);

    // Disconnect any existing connection
    stopConnection();
  };

  const loadChatSessions = useCallback(async () => {
    try {
      const sessions = await chatHistoryStore.getSessionsMetadata();
      setChatSessions(sessions.sort((a, b) => b.createdAt - a.createdAt));
    } catch (error) {
      console.error('Failed to load chat sessions:', error);
    }
  }, []);

  const handleLoadHistory = async () => {
    await loadChatSessions();
    setShowHistory(true);
  };

  const handleBackToChat = (reset = false) => {
    setShowHistory(false);
    if (reset) {
      setCurrentSessionId(null);
      setMessages([]);
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);
    }
  };

  const handleSessionSelect = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (fullSession && fullSession.messages.length > 0) {
        setCurrentSessionId(fullSession.id);
        setMessages(fullSession.messages);
        // Allow continuing a past conversation: the background rebuilds
        // the model context from the stored session messages.
        setIsFollowUpMode(true);
        setIsHistoricalSession(false);
      }
      setShowHistory(false);
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  };

  const handleSessionDelete = async (sessionId: string) => {
    try {
      await chatHistoryStore.deleteSession(sessionId);
      await loadChatSessions();
      if (sessionId === currentSessionId) {
        setMessages([]);
        setCurrentSessionId(null);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleSessionBookmark = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);

      if (fullSession && fullSession.messages.length > 0) {
        // Get the session title
        const sessionTitle = fullSession.title;
        // Get the first 8 words of the title
        const title = sessionTitle.split(' ').slice(0, 8).join(' ');

        // Get the first message content (the task)
        const taskContent = fullSession.messages[0]?.content || '';

        // Add to favorites storage
        await favoritesStorage.addPrompt(title, taskContent);

        // Update favorites in the UI
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);

        // Return to chat view after pinning
        handleBackToChat(true);
      }
    } catch (error) {
      console.error('Failed to pin session to favorites:', error);
    }
  };

  const handleBookmarkSelect = (content: string) => {
    if (setInputTextRef.current) {
      setInputTextRef.current(content);
    }
  };

  const handleBookmarkUpdateTitle = async (id: number, title: string) => {
    try {
      await favoritesStorage.updatePromptTitle(id, title);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to update favorite prompt title:', error);
    }
  };

  const handleBookmarkDelete = async (id: number) => {
    try {
      await favoritesStorage.removePrompt(id);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to delete favorite prompt:', error);
    }
  };

  const handleBookmarkReorder = async (draggedId: number, targetId: number) => {
    try {
      // Directly pass IDs to storage function - it now handles the reordering logic
      await favoritesStorage.reorderPrompts(draggedId, targetId);

      // Fetch the updated list from storage to get the new IDs and reflect the authoritative order
      const updatedPromptsFromStorage = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(updatedPromptsFromStorage);
    } catch (error) {
      console.error('Failed to reorder favorite prompts:', error);
    }
  };

  // Load favorite prompts from storage
  useEffect(() => {
    const loadFavorites = async () => {
      try {
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);
      } catch (error) {
        console.error('Failed to load favorite prompts:', error);
      }
    };

    loadFavorites();
  }, []);

  // First-run tour: open automatically until the user has been through it once
  useEffect(() => {
    onboardingStore
      .get()
      .then(seen => {
        if (!seen) setShowOnboarding(true);
      })
      .catch(error => console.error('Failed to read onboarding flag:', error));
  }, []);

  const closeOnboarding = useCallback(() => {
    setShowOnboarding(false);
    onboardingStore.markSeen().catch(error => console.error('Failed to persist onboarding flag:', error));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopConnection();
    };
  }, [stopConnection]);

  // Messages to render: the persisted ones plus the live streaming reply
  const displayMessages =
    streamingText !== null
      ? [
          ...messages,
          {
            actor: Actors.ASSISTANT,
            content: streamingText === '' ? PROGRESS_MESSAGE : streamingText,
            timestamp: Date.now(),
          },
        ]
      : messages;

  // Scroll to bottom when new messages arrive
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const teachBar = teachPhase && (
    <div className="mx-2 mb-1 flex items-center justify-between gap-2 rounded-md border border-[#3D3D3D]/50 bg-[#0A0A0A] px-3 py-2 text-xs text-gray-300">
      <span>
        {teachPhase === 'recording' && '⏺ Recording your demonstration — act in the page, type notes below'}
        {teachPhase === 'distilling' && '⏳ Distilling the skill…'}
        {teachPhase === 'reviewing' && '📘 Draft ready — reply below to refine it, or save'}
      </span>
      <span className="flex shrink-0 gap-2">
        {teachPhase === 'recording' && (
          <button
            type="button"
            onClick={() => {
              setTeachPhase('distilling');
              sendTeach({ type: 'teach_stop' });
            }}
            className="rounded bg-[#E8E8E8] px-2 py-0.5 font-medium text-[#000000] hover:bg-[#FFFFFF]">
            Finish
          </button>
        )}
        {teachPhase === 'reviewing' && (
          <button
            type="button"
            onClick={() => sendTeach({ type: 'teach_save' })}
            className="rounded bg-[#E8E8E8] px-2 py-0.5 font-medium text-[#000000] hover:bg-[#FFFFFF]">
            Save skill
          </button>
        )}
        {teachPhase !== 'distilling' && (
          <button
            type="button"
            onClick={() => {
              setTeachPhase(null);
              sendTeach({ type: 'teach_discard' });
            }}
            className="rounded border border-[#3D3D3D]/60 px-2 py-0.5 text-gray-400 hover:text-gray-200">
            Discard
          </button>
        )}
      </span>
    </div>
  );

  // Offered after a successful run: one click starts the skill distillation
  // interview (key objective + follow-up questions), then Save/Discard
  const skillOfferBar = skillOffer && !teachPhase && (
    <div className="mx-2 mb-1 flex items-center justify-between gap-2 rounded-md border border-[#3D3D3D]/50 bg-[#0A0A0A] px-3 py-2 text-xs text-gray-300">
      <span>✨ That worked — save these steps as a skill for next time?</span>
      <span className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={handleSkillify}
          className="rounded bg-[#E8E8E8] px-2 py-0.5 font-medium text-[#000000] hover:bg-[#FFFFFF]">
          Save as skill
        </button>
        <button
          type="button"
          onClick={() => setSkillOffer(false)}
          className="rounded border border-[#3D3D3D]/60 px-2 py-0.5 text-gray-400 hover:text-gray-200">
          Dismiss
        </button>
      </span>
    </div>
  );

  return (
    <div>
      <div className="relative flex h-screen flex-col overflow-hidden rounded-2xl border border-[#3D3D3D]/40 bg-[#000000]">
        {showReport && currentSessionId && (
          <ReportDialog sessionId={currentSessionId} onClose={() => setShowReport(false)} />
        )}
        {showOnboarding && <OnboardingDialog onClose={closeOnboarding} />}
        <header className="header relative">
          <div className="header-logo">
            {showHistory || showSchedules ? (
              <button
                type="button"
                onClick={() => (showSchedules ? setShowSchedules(false) : handleBackToChat(false))}
                className={`${isDarkMode ? 'text-[#E8E8E8] hover:text-[#FFFFFF]' : 'text-[#E8E8E8] hover:text-[#FFFFFF]'} cursor-pointer`}
                aria-label={t('nav_back_a11y')}>
                {t('nav_back')}
              </button>
            ) : (
              <img src="/icon-128.png" alt="Extension Logo" className="size-6" />
            )}
          </div>
          <div className="header-icons">
            {!showHistory && !showSchedules && (
              <>
                <button
                  type="button"
                  onClick={handleTeach}
                  onKeyDown={e => e.key === 'Enter' && handleTeach()}
                  className={`header-icon cursor-pointer ${teachPhase ? 'opacity-40' : ''} text-[#E8E8E8] hover:text-[#FFFFFF]`}
                  aria-label="Teach a skill by demonstrating it"
                  title="Teach a skill: record yourself doing a task"
                  tabIndex={0}>
                  <PiGraduationCapBold size={20} />
                </button>
                <button
                  type="button"
                  onClick={handleNewChat}
                  onKeyDown={e => e.key === 'Enter' && handleNewChat()}
                  className={`header-icon ${isDarkMode ? 'text-[#E8E8E8] hover:text-[#FFFFFF]' : 'text-[#E8E8E8] hover:text-[#FFFFFF]'} cursor-pointer`}
                  aria-label={t('nav_newChat_a11y')}
                  tabIndex={0}>
                  <PiPlusBold size={20} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowSchedules(true)}
                  onKeyDown={e => e.key === 'Enter' && setShowSchedules(true)}
                  className="header-icon cursor-pointer text-[#E8E8E8] hover:text-[#FFFFFF]"
                  aria-label="Manage scheduled tasks"
                  title="Schedules: run tasks automatically on a repeating timer"
                  tabIndex={0}>
                  <FiClock size={20} />
                </button>
                {currentSessionId && (
                  <button
                    type="button"
                    onClick={() => setShowReport(true)}
                    onKeyDown={e => e.key === 'Enter' && setShowReport(true)}
                    className="header-icon cursor-pointer text-[#E8E8E8] hover:text-[#FFFFFF]"
                    aria-label="Report a problem with this task"
                    title="Report a problem: send this task's trace to the Koretex team"
                    tabIndex={0}>
                    <PiBugBold size={20} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleLoadHistory}
                  onKeyDown={e => e.key === 'Enter' && handleLoadHistory()}
                  className={`header-icon ${isDarkMode ? 'text-[#E8E8E8] hover:text-[#FFFFFF]' : 'text-[#E8E8E8] hover:text-[#FFFFFF]'} cursor-pointer`}
                  aria-label={t('nav_loadHistory_a11y')}
                  tabIndex={0}>
                  <GrHistory size={20} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setShowOnboarding(true)}
              onKeyDown={e => e.key === 'Enter' && setShowOnboarding(true)}
              className="header-icon cursor-pointer text-[#E8E8E8] hover:text-[#FFFFFF]"
              aria-label="What can Koretex do? Replay the intro tour"
              title="What can Koretex do? Replay the intro tour"
              tabIndex={0}>
              <FiHelpCircle size={20} />
            </button>
            <button
              type="button"
              onClick={() => chrome.runtime.openOptionsPage()}
              onKeyDown={e => e.key === 'Enter' && chrome.runtime.openOptionsPage()}
              className={`header-icon ${isDarkMode ? 'text-[#E8E8E8] hover:text-[#FFFFFF]' : 'text-[#E8E8E8] hover:text-[#FFFFFF]'} cursor-pointer`}
              aria-label={t('nav_settings_a11y')}
              tabIndex={0}>
              <FiSettings size={20} />
            </button>
          </div>
        </header>
        {showSchedules ? (
          <div className="flex-1 overflow-hidden">
            <ScheduleList
              onOpenRun={sessionId => {
                setShowSchedules(false);
                handleSessionSelect(sessionId);
              }}
            />
          </div>
        ) : showHistory ? (
          <div className="flex-1 overflow-hidden">
            <ChatHistoryList
              sessions={chatSessions}
              onSessionSelect={handleSessionSelect}
              onSessionDelete={handleSessionDelete}
              onSessionBookmark={handleSessionBookmark}
              visible={true}
              isDarkMode={isDarkMode}
            />
          </div>
        ) : (
          <>
            {displayMessages.length === 0 && (
              <>
                {teachBar}
                <div
                  className={`border-t ${isDarkMode ? 'border-[#333333]' : 'border-[#333333]'} mb-2 p-2 shadow-sm backdrop-blur-sm`}>
                  <ChatInput
                    onSendMessage={handleSendMessage}
                    onStopTask={handleStopTask}
                    disabled={!inputEnabled || isHistoricalSession}
                    showStopButton={showStopButton}
                    setContent={setter => {
                      setInputTextRef.current = setter;
                    }}
                    isDarkMode={isDarkMode}
                  />
                </div>
                <div className="flex-1 overflow-y-auto">
                  <BookmarkList
                    bookmarks={favoritePrompts}
                    onBookmarkSelect={handleBookmarkSelect}
                    onBookmarkUpdateTitle={handleBookmarkUpdateTitle}
                    onBookmarkDelete={handleBookmarkDelete}
                    onBookmarkReorder={handleBookmarkReorder}
                    isDarkMode={isDarkMode}
                  />
                </div>
              </>
            )}
            {displayMessages.length > 0 && (
              <div
                className={`scrollbar-gutter-stable flex-1 overflow-x-hidden overflow-y-scroll scroll-smooth p-2 ${isDarkMode ? 'bg-[#000000]/80' : ''}`}>
                <MessageList messages={displayMessages} isDarkMode={isDarkMode} />
                <div ref={messagesEndRef} />
              </div>
            )}
            {displayMessages.length > 0 && (
              <div
                className={`border-t ${isDarkMode ? 'border-[#333333]' : 'border-[#333333]'} p-2 shadow-sm backdrop-blur-sm`}>
                {skillOfferBar}
                {teachBar}
                <ChatInput
                  onSendMessage={handleSendMessage}
                  onStopTask={handleStopTask}
                  disabled={!inputEnabled || isHistoricalSession}
                  showStopButton={showStopButton}
                  setContent={setter => {
                    setInputTextRef.current = setter;
                  }}
                  isDarkMode={isDarkMode}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default SidePanel;
