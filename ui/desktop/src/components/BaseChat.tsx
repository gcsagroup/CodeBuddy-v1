import { AppEvents } from '../constants/events';
import { useWorkStatus } from './codepro/useWorkStatus';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { useLocation, useNavigate } from 'react-router-dom';
import { SearchView } from './conversation/SearchView';
import LoadingGoose, {
  getLoadingIndicatorPresentation,
  isCheckingExecutionResults,
} from './LoadingGoose';
import ProgressiveMessageList from './ProgressiveMessageList';
import ConversationLoading from './ConversationLoading';
import { ConversationTimeline } from './ConversationTimeline';
import ElicitationDock, { partitionElicitationMessages } from './ElicitationDock';
import { elicitationContent } from '../acp/adapter/elicitations';
import { MainPanelLayout } from './Layout/MainPanelLayout';
import ChatInput from './ChatInput';
import { SessionPermissionSummary } from './SessionPermissionSummary';
import { CodeProPlanDock } from './codepro/CodeProPlanDock';
import { currentWorkStage, latestReturnedAction } from './codepro/currentWorkStage';
import { ScrollArea, ScrollAreaHandle } from './ui/scroll-area';
import { useFileDrop } from '../hooks/useFileDrop';
import { ChatState } from '../types/chatState';
import { stoppedRequestToContinue } from '../types/turnTerminal';
import { ChatType } from '../types/chat';
import { useIsMobile } from '../hooks/use-mobile';
import { useNavigationContextSafe } from './Layout/NavigationContext';
import { cn } from '../utils';
import { useChatSession } from '../hooks/useChatSession';
import { acpDeleteSession, acpUpdateWorkingDir } from '../acp/sessions';
import { useNavigation } from '../hooks/useNavigation';
import { RecipeHeader } from './RecipeHeader';
import { RecipeWarningModal } from './ui/RecipeWarningModal';
import { scanRecipe } from '../recipe';
import type { Recipe } from '../recipe';
import RecipeActivities from './recipes/RecipeActivities';
import {
  getTextAndImageContent,
  getToolRequests,
  insertPresentedUserMessage,
  type Message,
  type UserInput,
} from '../types/message';
import { presentedToolCall } from './codepro/CodeProToolContent';
import { formatToolAction } from './toolActionPresentation';
import { substituteParameters } from '../utils/parameterSubstitution';
import { useAutoSubmit } from '../hooks/useAutoSubmit';
import { CodeBuddyMark } from './CodeBuddyMark';
import { MainConversationAuthor } from './MainConversationAuthor';
import EnvironmentBadge from './GooseSidebar/EnvironmentBadge';
import { isAcpRecovering, subscribeToAcpRecovery } from '../acp/acpConnection';
import { CodeProStepSummary } from './codepro/CodeProStepSummary';
import { shouldShowFloatingProgress } from './codepro/CodeProProgress';
import { PromptErrorBanner } from './PromptErrorBanner';
import { RunAdviceCard } from './RunAdviceCard';
import { shouldUpdateSessionWorkingDir } from '../codepro/sessionWorkspace';
import { CodeProWorkspaceReconfirmation } from './codepro/CodeProWorkspaceReconfirmation';
import type { CodeProWorkspaceInspection } from '../codepro/projectWorkspace';
import { errorMessage } from '../utils/conversionUtils';
import { createChatInputSubmitHandler } from './baseChatSubmission';
import './chat-history.css';
import './conversation-presentation.css';
import { finishSessionLoadTiming, traceSessionLoad } from '../acp/sessionLoadTiming';

const conversationColumn = 'mx-auto w-full max-w-[52rem]';

const i18n = defineMessages({
  mainConversationHeading: { id: 'baseChat.mainConversationHeading', defaultMessage: 'Hi, I’m CodeBuddy, your project assistant.' },
  mainConversationHelp: {
    id: 'baseChat.mainConversationHelp',
    defaultMessage: 'I can check how a project is going, find an earlier requirement, or adjust permissions for a single chat. I can also create a project folder, hand the work to a project chat, and bring you a brief when it’s done.',
  },
  mainConversationExample: { id: 'baseChat.mainConversationExample', defaultMessage: 'Try asking me, “Can you check my project’s progress?”' },
  readonlyHistory: {
    id: 'baseChat.readonlyHistory',
    defaultMessage: 'Imported history is read-only. Start a new task to continue working.',
  },
  awaitingModel: {
    id: 'baseChat.awaitingModel',
    defaultMessage: 'Waiting for the model response…',
  },
  receivingReasoning: { id: 'baseChat.receivingReasoning', defaultMessage: 'Receiving reasoning…' },
  checkingResults: {
    id: 'baseChat.checkingResults',
    defaultMessage: 'Checking execution results…',
  },
  lastTool: { id: 'baseChat.lastTool', defaultMessage: 'Last tool result: {action}' },
  lastStage: { id: 'baseChat.lastStage', defaultMessage: 'Last update: {stage}' },
  changingPermissions: { id: 'sessionPermissions.saving', defaultMessage: 'Changing permissions…' },
  failedToLoadSession: {
    id: 'baseChat.failedToLoadSession',
    defaultMessage: 'Failed to Load Session',
  },
  goHome: {
    id: 'baseChat.goHome',
    defaultMessage: 'Go home',
  },
  dismissPromptError: {
    id: 'baseChat.dismissPromptError',
    defaultMessage: 'Dismiss error',
  },
  reconnecting: {
    id: 'baseChat.reconnecting',
    defaultMessage: 'Connection lost. Reconnecting…',
  },
  latest: { id: 'baseChat.latest', defaultMessage: 'Back to latest' },
});

interface BaseChatProps {
  setChat: (chat: ChatType) => void;
  onMessageSubmit?: (message: string) => void;
  renderHeader?: () => React.ReactNode;
  customChatInputProps?: Record<string, unknown>;
  customMainLayoutProps?: Record<string, unknown>;
  contentClassName?: string;
  disableSearch?: boolean;
  suppressEmptyState: boolean;
  sessionId: string;
  isActiveSession: boolean;
  initialMessage?: UserInput;
  noAutoSubmit?: boolean;
}

export default function BaseChat({
  setChat,
  renderHeader,
  customChatInputProps = {},
  customMainLayoutProps = {},
  sessionId,
  initialMessage,
  noAutoSubmit,
  isActiveSession,
}: BaseChatProps) {
  const intl = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const scrollRef = useRef<ScrollAreaHandle>(null);
  const [navigationTarget, setNavigationTarget] = useState<{ sessionId: string; messageId: string; request: number }>();
  const navigationSequence = useRef(0);
  const navigateToTurn = useCallback((messageId: string) => {
    const scroller = scrollRef.current;
    // Stop tail following before older history is mounted.
    scroller?.scrollToPosition({ top: scroller.viewportRef.current?.scrollTop ?? 0, behavior: 'auto' });
    setNavigationTarget({ sessionId, messageId, request: ++navigationSequence.current });
  }, [sessionId]);
  const revealTurn = useCallback((element: HTMLElement) => {
    const viewport = scrollRef.current?.viewportRef.current;
    if (!viewport) return;
    scrollRef.current?.scrollToPosition({
      top: viewport.scrollTop + element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12,
      behavior: 'auto',
    });
  }, []);
  const [atLatest, setAtLatest] = useState(true);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const disableAnimation = location.state?.disableAnimation || false;
  const [hasStartedUsingRecipe, setHasStartedUsingRecipe] = React.useState(false);
  const [hasNotAcceptedRecipe, setHasNotAcceptedRecipe] = useState<boolean>();
  const [hasRecipeSecurityWarnings, setHasRecipeSecurityWarnings] = useState(false);
  const [acpRecovering, setAcpRecovering] = useState(isAcpRecovering);
  const [savingModeSessionId, setSavingModeSessionId] = useState<string>();
  const [permissionOpenRequest, setPermissionOpenRequest] = useState(0);
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const [chooseModelAfterStop, setChooseModelAfterStop] = useState<string>();
  const [searchActive, setSearchActive] = useState(false);
  const [searchBarContainer, setSearchBarContainer] = useState<HTMLDivElement | null>(null);
  const modeSaving = savingModeSessionId === sessionId;
  const isMobile = useIsMobile();
  const navContext = useNavigationContextSafe();
  const setView = useNavigation();
  const isNavCollapsed = !navContext?.isNavExpanded;
  const contentClassName = cn('pr-1 pb-10 pt-12', (isMobile || isNavCollapsed) && 'pt-16');
  const { droppedFiles, setDroppedFiles, handleDrop, handleDragOver } = useFileDrop();
  const onStreamFinish = useCallback(() => {}, []);

  useEffect(() => subscribeToAcpRecovery(setAcpRecovering), []);

  const {
    session,
    messages,
    chatState,
    progressMessage,
    compactionLifecycle,
    updateSession,
    handleSubmit,
    resumeAfterWorkspace,
    onSteerQueuedMessage,
    submitElicitationResponse,
    pendingElicitationRequests,
    stopStreaming,
    sessionLoadError,
    workspaceReconfirmation,
    reconfirmCodeProWorkspace,
    promptError,
    clearPromptError,
    tokenState,
    notifications: toolCallNotifications,
    activeToolCallIds,
    thinkingActivity,
    promptActivity,
    cancelling,
    activeRunId,
    pauseQueueOnStop,
    queueProcessingBlocked,
    canSubmitQueuedMessageWhileLoading,
    onMessageUpdate,
  } = useChatSession({
    sessionId,
    onStreamFinish,
  });
  const sessionTitle = session?.name || 'CodeBuddy';
  const readonlyHistory = session?.extension_data.readonlyHistory === true;
  const stoppedRequest = useMemo(
    () => chatState === ChatState.Idle && !readonlyHistory ? stoppedRequestToContinue(messages) : undefined,
    [chatState, messages, readonlyHistory]
  );
  const elicitationPresentation = useMemo(
    () =>
      partitionElicitationMessages(
        messages,
        (pendingElicitationRequests ?? []).map(elicitationContent)
      ),
    [messages, pendingElicitationRequests]
  );
  const pendingSession = useRef(sessionId);
  pendingSession.current = sessionId;
  const [pendingMessage, setPendingMessage] = useState<{
    sessionId: string;
    message: Message;
  }>();
  const onPendingMessageChange = useCallback(
    (sourceSessionId: string, message: Message | undefined) => {
      if (sourceSessionId !== pendingSession.current) return;
      setPendingMessage(message ? { sessionId: sourceSessionId, message } : undefined);
    },
    []
  );
  const presentedHistory = useMemo(() => {
    const history = elicitationPresentation.history;
    const pending = pendingMessage?.sessionId === sessionId ? pendingMessage.message : undefined;
    if (!pending || history.some((item) => item.id === pending.id)) return history;
    return insertPresentedUserMessage(history, pending);
  }, [elicitationPresentation.history, pendingMessage, sessionId]);
  const [workspaceReconfirmationPending, setWorkspaceReconfirmationPending] = useState(false);
  const [workspaceReconfirmationError, setWorkspaceReconfirmationError] = useState<string | null>(
    null
  );

  useEffect(() => {
    setWorkspaceReconfirmationPending(false);
    setWorkspaceReconfirmationError(null);
  }, [workspaceReconfirmation?.sessionId, workspaceReconfirmation?.workingDir]);

  const handleWorkspaceReconfirmation = useCallback(
    async (candidate: CodeProWorkspaceInspection) => {
      setWorkspaceReconfirmationPending(true);
      setWorkspaceReconfirmationError(null);
      try {
        await reconfirmCodeProWorkspace(candidate);
      } catch (error) {
        setWorkspaceReconfirmationError(errorMessage(error));
      } finally {
        setWorkspaceReconfirmationPending(false);
      }
    },
    [reconfirmCodeProWorkspace]
  );
  const loadingIndicatorPresentation = getLoadingIndicatorPresentation(
    location.pathname,
    progressMessage
  );
  const showFloatingProgress = shouldShowFloatingProgress(location.pathname);
  const conversationLayout =
    location.pathname.startsWith('/codepro') ||
    session?.session_type === 'code_pro' ||
    session?.session_type === 'sub_agent';
  const currentTool = useMemo(() => {
    if (chatState === ChatState.WaitingForUserInput || chatState === ChatState.Compacting)
      return undefined;
    const active = new Set(activeToolCallIds ?? []);
    const request = messages.flatMap(getToolRequests).find((item) => active.has(item.id));
    const call = request ? presentedToolCall(request) : undefined;
    return call && request
      ? {
          id: request.id,
          name: call.name,
          title: formatToolAction(intl, call.name, call.arguments, 'running', 'headline'),
          awaitingResult: call.arguments.__inputPreview !== true,
        }
      : undefined;
  }, [messages, activeToolCallIds, chatState, intl]);
  const currentAction = currentTool?.title;
  const sourceId = promptActivity?.sourceUserMessageId;
  const lastAction = useMemo(() => {
    if (!sourceId || currentAction) return undefined;
    const call = latestReturnedAction(messages, sourceId);
    return call ? formatToolAction(intl, call.name, call.arguments, undefined, 'name') : undefined;
  }, [sourceId, currentAction, messages, intl]);
  const currentStage = useMemo(
    () =>
      promptActivity ? currentWorkStage(messages, promptActivity.sourceUserMessageId) : undefined,
    [messages, promptActivity]
  );
  // Translate the existing host-owned progress notice, never infer completion
  // from model prose. The host clears this notice after the check returns.
  const checkingResults = isCheckingExecutionResults(progressMessage);
  const workStatus = useWorkStatus({
    chatState,
    activity: promptActivity,
    stage: currentStage,
    action: currentAction,
    actionId: currentTool?.id,
    checking: checkingResults,
    cancelling,
    toolPending: currentTool?.awaitingResult,
    thinking: !!thinkingActivity,
  });
  useEffect(() => {
    if (!chooseModelAfterStop) return;
    if (chooseModelAfterStop !== sessionId) { setChooseModelAfterStop(undefined); return; }
    // Wait for the existing controller to settle cancellation before opening
    // configuration. Never submit/replay the original task from this advice.
    if (chatState === ChatState.Idle && !cancelling) {
      setChooseModelAfterStop(undefined);
      setModelOpenRequest(value => value + 1);
    }
  }, [chooseModelAfterStop, sessionId, chatState, cancelling]);

  const activityProbe = useRef('');
  useEffect(() => {
    if (!import.meta.env.DEV || !conversationLayout) return;
    // Observe the presentation selector. This is a React
    // commit, not proof of screen paint or of the model's internal activity.
    const visible = !acpRecovering && !cancelling && chatState !== ChatState.Idle;
    const source = visible ? workStatus.source : 'hidden';
    const fields = {
      session_id: sessionId,
      run_id: activeRunId ?? null,
      chat_state: chatState,
      source,
      active_tool_ids: activeToolCallIds ?? [],
      has_presentable_tool: Boolean(currentAction),
      has_host_progress: Boolean(progressMessage),
      has_published_stage: Boolean(currentStage),
      published_stage: currentStage ?? null,
      last_stage_visible: visible && source === 'stage',
      prolonged_silence: 'quietSeconds' in workStatus && workStatus.quietSeconds !== undefined,
    };
    const key = JSON.stringify(fields);
    if (activityProbe.current === key) return;
    activityProbe.current = key;
    try {
      window.electron.logInfo(
        JSON.stringify({
          tag: 'stream_timing',
          stage: 'ui_activity_selection',
          at_ms: Date.now(),
          ...fields,
          last_thought_message_id: thinkingActivity?.messageId ?? null,
          last_thought_received_at_ms: thinkingActivity?.receivedAt ?? null,
          prompt_attempt_id: promptActivity?.promptAttemptId ?? null,
          last_output_received_at_ms: promptActivity?.receivedAt ?? null,
          last_output_kind: promptActivity?.kind ?? null,
          document_visibility: document.visibilityState,
        })
      );
    } catch {
      /* Diagnostics must not affect the status or the execution. */
    }
  }, [
    sessionId,
    activeRunId,
    conversationLayout,
    acpRecovering,
    chatState,
    currentAction,
    checkingResults,
    workStatus,
    promptActivity,
    activeToolCallIds,
    progressMessage,
    currentStage,
    thinkingActivity,
    cancelling,
  ]);

  const handleWorkingDirChange = useCallback(
    async (newDir: string) => {
      if (!session) {
        throw new Error('Cannot update working directory before ACP session is loaded');
      }
      if (
        !shouldUpdateSessionWorkingDir({
          isCodePro: location.pathname.startsWith('/codepro'),
          currentWorkingDir: session.working_dir,
          nextWorkingDir: newDir,
        })
      ) {
        return;
      }
      await acpUpdateWorkingDir(session.id, newDir);
      updateSession((currentSession) => ({ ...currentSession, working_dir: newDir }));
    },
    [location.pathname, session, updateSession]
  );

  const recipe = session?.recipe as Recipe | null | undefined;
  const handleUserSubmissionAccepted = useCallback(() => scrollRef.current?.scrollToBottom(), []);

  const chatInputSubmit = useMemo(
    () =>
      createChatInputSubmitHandler(handleSubmit, Boolean(recipe), () =>
        setHasStartedUsingRecipe(true)
      ),
    [handleSubmit, recipe]
  );

  const resolvedInitialMessage = useMemo((): UserInput | undefined => {
    if (!initialMessage) return undefined;
    if (recipe?.prompt && session?.user_recipe_values) {
      return {
        ...initialMessage,
        msg: substituteParameters(initialMessage.msg, session.user_recipe_values),
      };
    }
    return initialMessage;
  }, [initialMessage, recipe?.prompt, session?.user_recipe_values]);

  // noAutoSubmit only suppresses auto-submitting the initial prompt of a fresh session
  // (codebuddy://new-session?prompt=...). Once the conversation has messages, later flows
  // such as forks or resumes should auto-submit normally.
  const suppressInitialAutoSubmit = noAutoSubmit && messages.length === 0;
  const canAutoSubmit =
    !readonlyHistory &&
    !acpRecovering &&
    !suppressInitialAutoSubmit &&
    (session?.session_type === 'scheduled' || !recipe || hasNotAcceptedRecipe === false);

  useAutoSubmit({
    sessionId,
    session,
    messages,
    chatState,
    initialMessage: resolvedInitialMessage,
    canAutoSubmit,
    handleSubmit: chatInputSubmit,
  });

  useEffect(() => {
    let streamState: 'idle' | 'loading' | 'streaming' | 'error' = 'idle';
    if (chatState === ChatState.LoadingConversation) {
      streamState = 'loading';
    } else if (
      chatState === ChatState.Streaming ||
      chatState === ChatState.Thinking ||
      chatState === ChatState.Compacting ||
      chatState === ChatState.RestartingAgent
    ) {
      streamState = 'streaming';
    } else if (sessionLoadError) {
      streamState = 'error';
    }

    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_STATUS_UPDATE, {
        detail: {
          sessionId,
          streamState,
        },
      })
    );
  }, [sessionId, chatState, sessionLoadError]);

  // Generate command history from user messages (most recent first)
  const commandHistory = useMemo(() => {
    return messages
      .reduce<string[]>((history, message) => {
        if (message.role === 'user') {
          const text = getTextAndImageContent(message).textContent.trim();
          if (text) {
            history.push(text);
          }
        }
        return history;
      }, [])
      .reverse();
  }, [messages]);

  const sessionModel = session?.model_config?.model_name ?? null;
  const sessionProvider = session?.provider_name ?? null;
  const sessionLoaded = session !== undefined;
  const latestInference = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.role === 'assistant' &&
        message.metadata.userVisible &&
        message.metadata.inference
      ) {
        return message.metadata.inference;
      }
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (!recipe || !isActiveSession || session?.session_type === 'scheduled') return;

    (async () => {
      const accepted = await window.electron.hasAcceptedRecipeBefore(recipe);
      setHasNotAcceptedRecipe(!accepted);

      if (!accepted) {
        const scanResult = await scanRecipe(recipe);
        setHasRecipeSecurityWarnings(scanResult.has_security_warnings);
      }
    })();
  }, [recipe, isActiveSession, session?.session_type]);

  const handleRecipeAccept = async (accept: boolean) => {
    if (recipe && accept) {
      await window.electron.recordRecipeHash(recipe);
      setHasNotAcceptedRecipe(false);
      return;
    }

    if (sessionId) {
      try {
        await acpDeleteSession(sessionId);
        window.dispatchEvent(new CustomEvent(AppEvents.SESSION_DELETED, { detail: { sessionId } }));
      } catch (error) {
        console.error('Failed to delete declined recipe session:', error);
      }
    }
    setView('chat');
  };

  const [readyHistorySessionId, setReadyHistorySessionId] = useState<string>();
  const historyFrames = useRef<{ first?: number; second?: number }>({});
  const loadingHistory = chatState === ChatState.LoadingConversation || !!workspaceReconfirmation;
  const hasHistory = messages.length > 0;

  useLayoutEffect(() => {
    if (!isActiveSession || loadingHistory) setReadyHistorySessionId(undefined);
    else if (!hasHistory) setReadyHistorySessionId(sessionId);
    return () => {
      if (historyFrames.current.first !== undefined)
        cancelAnimationFrame(historyFrames.current.first);
      if (historyFrames.current.second !== undefined)
        cancelAnimationFrame(historyFrames.current.second);
      historyFrames.current = {};
    };
  }, [sessionId, isActiveSession, loadingHistory, hasHistory]);

  const handleHistoryRendered = useCallback(
    (renderedSessionId: string) => {
      if (
        !isActiveSession ||
        loadingHistory ||
        renderedSessionId !== sessionId ||
        readyHistorySessionId === sessionId ||
        historyFrames.current.first !== undefined
      )
        return;
      // Replay completion is not a paint acknowledgement. Start this boundary only
      // after the message list has committed the target conversation's DOM.
      traceSessionLoad(sessionId, 'history_dom_committed');
      historyFrames.current.first = requestAnimationFrame(() => {
        scrollRef.current?.scrollToBottom();
        historyFrames.current.second = requestAnimationFrame(() => {
          historyFrames.current = {};
          // Position the committed history before removing its loading cover.
          // The second frame includes child layout changes from the first commit.
          scrollRef.current?.scrollToBottom();
          setReadyHistorySessionId(sessionId);
        });
      });
    },
    [sessionId, isActiveSession, loadingHistory, readyHistorySessionId]
  );
  const showHistoryLoading = loadingHistory || (hasHistory && readyHistorySessionId !== sessionId);

  useLayoutEffect(() => {
    // Cached conversations remain mounted under display:none. Their old scroll
    // range cannot position the newly visible viewport; jump before its paint.
    if (isActiveSession && !showHistoryLoading) scrollRef.current?.scrollToBottom();
  }, [sessionId, isActiveSession, showHistoryLoading]);

  useLayoutEffect(() => {
    if (isActiveSession && sessionLoaded && !showHistoryLoading)
      finishSessionLoadTiming(sessionId, 'visible_commit', { messages: messages.length });
  }, [sessionId, sessionLoaded, showHistoryLoading, messages.length, isActiveSession]);

  // Listen for global scroll-to-bottom requests (e.g., from MCP App message actions)
  useEffect(() => {
    const handleGlobalScrollRequest = () => {
      // Add a small delay to ensure content has been rendered
      setTimeout(() => {
        if (scrollRef.current?.scrollToBottom) {
          scrollRef.current.scrollToBottom();
        }
      }, 200);
    };

    window.addEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, handleGlobalScrollRequest);
    return () =>
      window.removeEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, handleGlobalScrollRequest);
  }, []);

  useEffect(() => {
    if (
      isActiveSession &&
      sessionId &&
      chatInputRef.current &&
      chatState !== ChatState.LoadingConversation
    ) {
      const timeoutId = setTimeout(() => {
        // Cancellation may have just opened the picker. Refocusing the composer
        // would dismiss that popover through its normal outside-focus handling.
        if (document.querySelector('[data-model-picker-list]')) return;
        chatInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [isActiveSession, sessionId, chatState]);

  useEffect(() => {
    const handleSessionForked = (event: Event) => {
      const customEvent = event as CustomEvent<{
        newSessionId: string;
        shouldStartAgent?: boolean;
        editedMessage?: string;
      }>;
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
      const { newSessionId, shouldStartAgent, editedMessage } = customEvent.detail;

      const params = new URLSearchParams();
      params.set('resumeSessionId', newSessionId);
      if (shouldStartAgent) {
        params.set('shouldStartAgent', 'true');
      }

      navigate(`/pair?${params.toString()}`, {
        state: {
          disableAnimation: true,
          initialMessage: editedMessage ? { msg: editedMessage, images: [] } : undefined,
        },
      });
    };

    window.addEventListener(AppEvents.SESSION_FORKED, handleSessionForked);

    return () => {
      window.removeEventListener(AppEvents.SESSION_FORKED, handleSessionForked);
    };
  }, [location.pathname, navigate]);

  const lastSetNameRef = useRef<string>('');

  useEffect(() => {
    const currentSessionName = session?.name;
    if (currentSessionName && currentSessionName !== lastSetNameRef.current) {
      lastSetNameRef.current = currentSessionName;
      setChat({
        messages,
        recipe,
        sessionId,
        name: currentSessionName,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.name, setChat]);

  // If we have a recipe prompt and user recipe values, substitute parameters
  let recipePrompt = '';
  if (messages.length === 0 && recipe?.prompt) {
    recipePrompt = session?.user_recipe_values
      ? substituteParameters(recipe.prompt, session.user_recipe_values)
      : recipe.prompt;
  }

  const initialPrompt =
    noAutoSubmit && messages.length === 0 && resolvedInitialMessage?.msg
      ? resolvedInitialMessage.msg
      : recipePrompt;

  const routeDraft = location.state as { draftOnly?: boolean; initialMessage?: UserInput } | null;
  const draftDelivery = routeDraft?.draftOnly &&
    new URLSearchParams(location.search).get('resumeSessionId') === sessionId &&
    typeof routeDraft.initialMessage?.msg === 'string'
    ? { id: location.key, text: routeDraft.initialMessage.msg }
    : undefined;

  if (sessionLoadError) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <MainPanelLayout
          backgroundColor={'bg-background-primary'}
          removeTopPadding={true}
          {...customMainLayoutProps}
        >
          {renderHeader && renderHeader()}
          <div className="flex flex-col flex-1 min-h-0 relative">
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center justify-center p-8">
                <div className="text-red-700 dark:text-red-300 bg-red-400/50 p-4 rounded-lg mb-4 max-w-md">
                  <h3 className="font-semibold mb-2">
                    {intl.formatMessage(i18n.failedToLoadSession)}
                  </h3>
                  <p className="text-sm">{sessionLoadError}</p>
                </div>
                <button
                  onClick={() => {
                    setView('chat');
                  }}
                  className="px-4 py-2 text-center cursor-pointer text-text-primary border border-border-primary hover:bg-background-secondary rounded-lg transition-all duration-150"
                >
                  {intl.formatMessage(i18n.goHome)}
                </button>
              </div>
            </div>
          </div>
        </MainPanelLayout>
      </div>
    );
  }

  return (
    <div
      className={`h-full flex flex-col min-h-0 ${conversationLayout ? 'codepro-conversation' : ''}`}
    >
      <MainPanelLayout
        backgroundColor={'bg-background-primary'}
        removeTopPadding={true}
        {...customMainLayoutProps}
      >
        {/* Custom header */}
        {renderHeader && renderHeader()}
        {conversationLayout && !renderHeader && (
          <header className="shell-chat-header flex h-12 shrink-0 items-center gap-3 px-6 pr-16 pl-[var(--navigation-toolbar-inset,3.5rem)]">
            <h1
              className="min-w-0 flex-1 truncate text-base font-medium text-text-primary"
              title={session?.name}
            >
              {sessionTitle}
            </h1>
            <div
              ref={setSearchBarContainer}
              className="ml-auto w-[min(20rem,70%)] shrink-0 empty:hidden"
            />
          </header>
        )}

        {workspaceReconfirmation && (
          <div className="mx-auto w-full max-w-2xl px-6">
            <CodeProWorkspaceReconfirmation
              request={workspaceReconfirmation}
              confirming={workspaceReconfirmationPending}
              error={workspaceReconfirmationError}
              onConfirm={handleWorkspaceReconfirmation}
              onCancel={() => setView('chat')}
            />
          </div>
        )}

        {/* Chat container with sticky recipe header */}
        <div className="flex flex-col flex-1 min-h-0 relative">
          {/* Product watermark - top right */}
          {!conversationLayout && (
            <div className="absolute top-[14px] right-4 z-[60] flex flex-row items-center gap-1">
              <div className="no-drag flex flex-row items-center gap-1">
                <CodeBuddyMark className="size-5" />
                <span className="text-sm leading-none text-text-secondary -translate-y-px">
                  CodeBuddy
                </span>
              </div>
              <EnvironmentBadge className="translate-y-px" />
            </div>
          )}

          <ScrollArea
            ref={scrollRef}
            className={`flex-1 min-h-0 relative ${conversationLayout ? 'pr-1 pb-2 pt-1' : contentClassName}`}
            autoScroll={isActiveSession && !showHistoryLoading}
            onBottomChange={setAtLatest}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            data-drop-zone="true"
            data-conversation-scroll=""
            data-more-below={!atLatest}
            paddingX={6}
            paddingY={0}
          >
            {session?.global_conversation && chatState === ChatState.Idle && !showHistoryLoading &&
              !hasHistory && presentedHistory.length === 0 && (
                <article className={cn(conversationColumn, 'pt-5')}>
                  <MainConversationAuthor />
                  <div className="max-w-prose space-y-2 pl-9 text-sm leading-relaxed text-text-primary">
                    <h2 className="text-base font-medium">{intl.formatMessage(i18n.mainConversationHeading)}</h2>
                    <p>{intl.formatMessage(i18n.mainConversationHelp)}</p>
                    <p className="text-text-secondary">{intl.formatMessage(i18n.mainConversationExample)}</p>
                  </div>
                </article>
              )}
            {recipe?.title && (
              <div className="sticky top-0 z-10 bg-background-primary px-0 -mx-6 mb-6 pt-6">
                <RecipeHeader title={recipe.title} />
              </div>
            )}

            {recipe && !readonlyHistory && (
              <div className={hasStartedUsingRecipe ? 'mb-6' : ''}>
                <RecipeActivities
                  append={(text: string) => handleSubmit({ msg: text, images: [] })}
                  activities={Array.isArray(recipe.activities) ? recipe.activities : null}
                  title={recipe.title}
                  parameterValues={session?.user_recipe_values || {}}
                />
              </div>
            )}

            {messages.length > 0 || recipe ? (
              <>
                <div
                  className={cn(
                    'codepro-chat-history',
                    conversationLayout && conversationColumn
                  )}
                >
                  <SearchView
                    active={isActiveSession}
                    onVisibilityChange={setSearchActive}
                    searchBarContainer={searchBarContainer}
                    showNavigation
                  >
                    <ProgressiveMessageList
                      mainConversation={session?.global_conversation}
                      currentModel={sessionModel}
                      searchActive={searchActive}
                      messages={presentedHistory}
                      navigationTarget={navigationTarget?.sessionId === sessionId ? navigationTarget : undefined}
                      onNavigationReady={revealTurn}
                      sessionType={session?.session_type}
                      workspaceRoot={session?.working_dir}
                      chat={{ sessionId }}
                      activeRunId={activeRunId}
                      cancelling={cancelling}
                      toolCallNotifications={toolCallNotifications}
                      append={
                        readonlyHistory
                          ? undefined
                          : (text: string) => handleSubmit({ msg: text, images: [] })
                      }
                      isUserMessage={(m: Message) => m.role === 'user'}
                      isStreamingMessage={chatState !== ChatState.Idle}
                      planRunning={
                        !acpRecovering &&
                        (chatState === ChatState.Thinking || chatState === ChatState.Streaming)
                      }
                      activeToolCallIds={activeToolCallIds}
                      thinkingActivity={thinkingActivity}
                      onHistoryRendered={handleHistoryRendered}
                      messageEditingDisabled={
                        readonlyHistory ||
                        acpRecovering ||
                        cancelling ||
                        chatState !== ChatState.Idle ||
                        Boolean(activeRunId)
                      }
                      onMessageUpdate={readonlyHistory ? undefined : onMessageUpdate}
                      submitElicitationResponse={
                        readonlyHistory ? undefined : submitElicitationResponse
                      }
                      resubmitMessage={readonlyHistory ? undefined : handleSubmit}
                      resumeAfterWorkspace={readonlyHistory ? undefined : resumeAfterWorkspace}
                    />
                  </SearchView>
                </div>

                <div className={conversationLayout ? 'block h-4' : 'block h-8'} />
              </>
            ) : null}
          </ScrollArea>

          {!showHistoryLoading && <ConversationTimeline
            key={sessionId} messages={presentedHistory} scrollRef={scrollRef} onNavigate={navigateToTurn}
          />}
          {showHistoryLoading && <ConversationLoading />}

          {!atLatest && !showHistoryLoading && (
            <button
              type="button"
              aria-label={intl.formatMessage(i18n.latest)}
              title={intl.formatMessage(i18n.latest)}
              className="absolute bottom-4 left-1/2 z-30 flex size-[34px] -translate-x-1/2 items-center justify-center rounded-full border border-border-primary bg-background-primary text-text-primary shadow-sm hover:bg-background-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => { setNavigationTarget(undefined); scrollRef.current?.scrollToBottom(); }}
            >
              <ArrowDown
                className="size-[17px] translate-x-[0.5px]"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            </button>
          )}
          {atLatest &&
            !showHistoryLoading &&
            !readonlyHistory &&
            !acpRecovering &&
            !cancelling &&
            (chatState === ChatState.Thinking ||
              chatState === ChatState.Streaming ||
              chatState === ChatState.Compacting ||
              chatState === ChatState.RestartingAgent) && (
              <div
                data-testid="chat-running-indicator"
                aria-hidden="true"
                className="absolute bottom-4 left-1/2 z-30 flex size-10 -translate-x-1/2 items-center justify-center gap-1 rounded-full border border-border-primary bg-background-primary text-text-secondary shadow-sm pointer-events-none"
              >
                <span className="chat-running-dot" />
                <span className="chat-running-dot" />
                <span className="chat-running-dot" />
              </div>
            )}

          {!showHistoryLoading &&
            chatState !== ChatState.Idle &&
            showFloatingProgress &&
            !conversationLayout && (
              <div className="absolute bottom-1 left-4 right-4 z-20 pointer-events-none">
                <LoadingGoose
                  chatState={chatState}
                  compactionLifecycle={compactionLifecycle}
                  {...loadingIndicatorPresentation}
                />
              </div>
            )}
        </div>

        <div className={conversationLayout ? 'mx-auto w-full max-w-[55rem] px-2' : undefined}>
          {acpRecovering && (
            <div role="status" className="mx-4 mb-2 text-sm text-text-secondary">
              {intl.formatMessage(i18n.reconnecting)}
            </div>
          )}

          {conversationLayout
            ? !acpRecovering &&
              !showHistoryLoading &&
              !cancelling &&
              !(promptActivity && !loadingHistory && !readonlyHistory && workStatus.advice) &&
              chatState !== ChatState.Idle && (
                <div className={cn('mx-4', workStatus.source === 'question' &&
                  elicitationPresentation.requests.some(
                    (request) => request.data.actionType === 'elicitation' && !request.data.continued
                  ) && 'sr-only')}>
                  <LoadingGoose
                    key={sessionId}
                    chatState={chatState}
                    compactionLifecycle={compactionLifecycle}
                    message={workStatus.message}
                    hint={workStatus.hint}
                    announcement={workStatus.announcement}
                    assistantName="CodePro"
                    workStatusSource={workStatus.source}
                    activeToolName={workStatus.source === 'toolInput' ? workStatus.preview.name : currentTool?.name}
                  />
                  {!currentAction &&
                    !checkingResults &&
                    (currentStage || lastAction) &&
                    (chatState === ChatState.Thinking || chatState === ChatState.Streaming) && (
                      <p className="pb-2 text-xs text-text-secondary truncate" title={currentStage || lastAction}>
                        {currentStage ? intl.formatMessage(i18n.lastStage, { stage: currentStage })
                          : intl.formatMessage(i18n.lastTool, { action: lastAction })}
                      </p>
                    )}
                </div>
              )
            : location.pathname.startsWith('/codepro') && (
                <CodeProStepSummary sessionId={sessionId} />
              )}

          {promptError && (
            <PromptErrorBanner
              message={promptError}
              dismissLabel={intl.formatMessage(i18n.dismissPromptError)}
              onDismiss={clearPromptError}
            />
          )}

          {conversationLayout && !readonlyHistory && (
            <CodeProPlanDock
              key={`plan:${sessionId}`}
              sessionId={sessionId}
              activeRunId={activeRunId}
              messages={messages}
              running={
                !acpRecovering &&
                (chatState === ChatState.Thinking || chatState === ChatState.Streaming)
              }
            />
          )}

          {!readonlyHistory && (
            <ElicitationDock
              key={`elicitation:${sessionId}`}
              requests={elicitationPresentation.requests}
              onSubmit={submitElicitationResponse}
            />
          )}

          {readonlyHistory ? (
            <div role="status" className="mx-4 mb-4 text-sm text-text-secondary">
              {intl.formatMessage(i18n.readonlyHistory)}
            </div>
          ) : (
            <>
            {promptActivity && !acpRecovering && !loadingHistory && (
              <RunAdviceCard
                key={sessionId}
                advice={workStatus.advice}
                statusMessage={workStatus.message}
                attemptId={promptActivity.promptAttemptId}
                stopping={chooseModelAfterStop === sessionId || Boolean(cancelling)}
                onStopAndChoose={() => {
                  if (chooseModelAfterStop || cancelling) return;
                  setChooseModelAfterStop(sessionId);
                  stopStreaming();
                }}
              />
            )}
            <div
              className={cn(
                'relative z-10 mx-4 mb-1',
                !disableAnimation && 'animate-[fadein_400ms_ease-in_forwards]'
              )}
            >
              <ChatInput
                externalModelOpenRequest={modelOpenRequest}
                onOpenPermissions={() => setPermissionOpenRequest((value) => value + 1)}
                modelToolbarSlot={
                  session && (
                    <SessionPermissionSummary
                      openRequest={permissionOpenRequest}
                      inline
                      key={sessionId}
                      session={session}
                      busy={loadingHistory || chatState !== ChatState.Idle || acpRecovering}
                      onSavingChange={(saving) =>
                        setSavingModeSessionId((current) =>
                          saving ? sessionId : current === sessionId ? undefined : current
                        )
                      }
                    />
                  )
                }
                inputRef={chatInputRef}
                sessionId={sessionId}
                handleSubmit={chatInputSubmit}
                onSubmissionAccepted={handleUserSubmissionAccepted}
                chatState={loadingHistory ? ChatState.LoadingConversation : chatState}
                onStop={stopStreaming}
                onContinue={stoppedRequest && chatState === ChatState.Idle && !activeRunId &&
                  !loadingHistory && !cancelling && !queueProcessingBlocked && !acpRecovering &&
                  !modeSaving && !workspaceReconfirmation
                  ? () => onMessageUpdate(stoppedRequest, '', 'resume_stopped') : undefined}
                onPendingMessageChange={onPendingMessageChange}
                onSteerQueuedMessage={onSteerQueuedMessage}
                automaticSteeringAllowed={Boolean(activeRunId) && !cancelling && !acpRecovering &&
                  !loadingHistory && !modeSaving && !workspaceReconfirmation}
                globalConversation={session?.global_conversation}
                pauseQueueOnStop={pauseQueueOnStop}
                queueProcessingBlocked={
                  queueProcessingBlocked || acpRecovering || modeSaving || !!workspaceReconfirmation
                }
                queueBlockedReason={
                  modeSaving ? intl.formatMessage(i18n.changingPermissions) : undefined
                }
                canSubmitQueuedMessageWhileLoading={
                  canSubmitQueuedMessageWhileLoading && !acpRecovering && !loadingHistory
                }
                commandHistory={commandHistory}
                initialValue={initialPrompt}
                draftDelivery={draftDelivery}
                setView={setView}
                totalTokens={
                  tokenState.contextUsageKnown === false
                    ? (session?.usage?.total_tokens ?? undefined)
                    : tokenState.totalTokens
                }
                contextLimit={
                  tokenState.contextLimit ?? session?.model_config?.context_limit ?? undefined
                }
                requestBudget={tokenState.requestBudget}
                pressureThreshold={tokenState.pressureThreshold}
                contextUsageSource={tokenState.contextUsageSource}
                sessionStats={tokenState.sessionStats}
                liveSpeed={tokenState.liveSpeed}
                lastSampledSpeed={tokenState.lastSampledSpeed}
                contextCapacitySource={tokenState.contextCapacitySource}
                accumulatedInputTokens={
                  tokenState?.accumulatedInputTokens ??
                  session?.accumulated_usage?.input_tokens ??
                  undefined
                }
                accumulatedOutputTokens={
                  tokenState?.accumulatedOutputTokens ??
                  session?.accumulated_usage?.output_tokens ??
                  undefined
                }
                accumulatedCost={
                  tokenState?.accumulatedCost ?? session?.accumulated_cost ?? undefined
                }
                droppedFiles={droppedFiles}
                onFilesProcessed={() => setDroppedFiles([])} // Clear dropped files after processing
                messages={messages}
                disableAnimation={disableAnimation}
                recipe={recipe}
                recipeAccepted={!hasNotAcceptedRecipe}
                initialPrompt={initialPrompt}
                sessionModel={sessionModel}
                sessionProvider={sessionProvider}
                sessionLoaded={sessionLoaded}
                workingDir={session?.working_dir}
                onWorkingDirChange={
                  location.pathname.startsWith('/codepro') ? undefined : handleWorkingDirChange
                }
                latestInference={latestInference}
                {...customChatInputProps}
              />
            </div>
            </>
          )}
        </div>
      </MainPanelLayout>

      {recipe && isActiveSession && session?.session_type !== 'scheduled' && (
        <RecipeWarningModal
          isOpen={!!hasNotAcceptedRecipe}
          onConfirm={() => handleRecipeAccept(true)}
          onCancel={() => handleRecipeAccept(false)}
          recipeDetails={{
            title: recipe.title,
            description: recipe.description,
            instructions: recipe.instructions || undefined,
          }}
          hasSecurityWarnings={hasRecipeSecurityWarnings}
        />
      )}
    </div>
  );
}
