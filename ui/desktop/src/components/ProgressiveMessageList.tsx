/**
 * ProgressiveMessageList Component
 *
 * A performance-optimized message list that renders messages progressively
 * to prevent UI blocking when loading long chat sessions. This component
 * renders messages in batches with a loading indicator, maintaining full
 * compatibility with the search functionality.
 *
 * Key Features:
 * - Progressive rendering in configurable batches
 * - Loading indicator during batch processing
 * - Maintains search functionality compatibility
 * - Smooth user experience with responsive UI
 * - Configurable batch size and delay
 */

import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import ThinkingIcon from './ThinkingIcon';
import { UserRound } from 'lucide-react';
import { MainConversationAuthor } from './MainConversationAuthor';
import { defineMessages, useIntl } from '../i18n';
import GooseMessage, { codeProTerminalPresentation, hasMissingFinalReply, hasUnverifiedAcceptance } from './GooseMessage';
import { resolveToolLoadingStatus } from './ToolCallWithResponse';
import { parseToolAuditReceipt } from '../acp/adapter/toolAudit';
import { computerToolOutcome } from './computerToolOutcome';
import { computerActionTargets } from './computerActionTargets';
import {
  isAcpPermissionRequestPending,
  subscribeAcpPermissionRequests,
} from '../acp/permissionRequests';
import { isPlanTool, isProgressTool, presentedToolCall } from './codepro/CodeProToolContent';
import { isPlanContextMessage } from '../types/codeproPlan';
import { ToolCallExpandable } from './ToolCallExpandable';
import { WorkHistoryWindow } from './WorkHistoryWindow';
import { CodeProWorkStep } from './codepro/CodeProWorkStep';
import {
  formatToolAction,
  formatToolActionSummary,
  isTaskContractCheck,
} from './toolActionPresentation';
import { ToolActivityIcon } from './ToolActivityIcon';
import {
  CodeProActivity,
  CodeProActivityCard,
  CodeProActivityTimeline,
} from './codepro/CodeProActivity';
import { buildCodeProActivityRenderItems } from './codepro/codeProActivityModel';
import UserMessage from './UserMessage';
import {
  SystemNotificationInline,
  getInlineSystemNotification,
  groupCompactionFailures,
} from './context_management/SystemNotificationInline';
import {
  CreditsExhaustedNotification,
  getCreditsExhaustedNotification,
} from './context_management/CreditsExhaustedNotification';
import {
  getToolRequests,
  getToolResponses,
  isConversationTurnStart,
  isToolCallInProgress,
  getAnyToolConfirmationData,
  getPendingToolConfirmationIds,
  type Message,
  type NotificationEvent,
  type SystemNotificationContent,
  type UserInput,
  type ToolResponseMessageContent,
} from '../types/message';
import { messageContentParts, type MessageContentPart } from './messageContentParts';
import { conversationUsage } from './conversationUsage';
import {
  collectMediaJobs,
  mediaJobObservation,
  type MediaJobsByCall,
} from './mediaJobPresentation';
import { MediaTaskRows, MediaTaskCards, mediaProcessSummary } from './MediaTaskRows';
import { DeliveredMediaScope, mediaOutputPaths } from './GeneratedMedia';
import { useMediaJobs } from '../workspace-panel/WorkspaceGeneration';
import { isActivityEvent } from '../types/activityEvent';
import { getTurnTerminalRecord, type MessageEditType } from '../types/turnTerminal';
import { getResponsePhase } from '../types/responsePhase';
import { parseSubagentLifecycle } from '../types/subagentLifecycle';
import { CodeProConversationFiles } from './codepro/CodeProConversationFiles';
import { collectConversationChanges } from './codepro/conversationChanges';
import { AnswerFiles } from './remarkDeliveredFileLinks';
import { AnswerWorkspaceLinks } from './AnswerWorkspaceLinks';
import { useConversationChangeMessages } from '../workspace-panel/WorkspaceSubagents';
import LoadingGoose from './LoadingGoose';
import { useOrderedToolPresentation } from './useOrderedToolPresentation';
import { ScrollFollowingContext, ScrollLayoutAnchorContext } from './ui/scroll-follow-context';
import { ChatType } from '../types/chat';
import { identifyConsecutiveToolCalls, isInChain } from '../utils/toolCallChaining';
import { getModelDisplayName } from './settings/models/predefinedModelsUtils';
import {
  findNeedsWorkspaceSourceMessage,
  NeedsWorkspaceInline,
  parseNeedsWorkspaceEvent,
} from './codepro/NeedsWorkspaceInline';
import {
  RestrictedReadonlyInline,
  parseRestrictedReadonlyRequiredEvent,
} from './codepro/RestrictedReadonlyInline';
import { RootCleanupInline, parseRootCleanupRequiredEvent } from './codepro/RootCleanupInline';

const i18n = defineMessages({
  turnRecord: {
    id: 'conversation.turnRecord',
    defaultMessage: 'Work history {count} operations',
  },
  turnDuration: {
    id: 'conversation.turnDuration',
    defaultMessage: 'Time spent {minutes} min {seconds} sec',
  },
  turnWorkingFor: {
    id: 'conversation.turnWorkingFor',
    defaultMessage: 'Working for {duration}',
  },
  turnStoppedAfter: {
    id: 'conversation.turnStoppedAfter',
    defaultMessage: 'Stopped after {duration}',
  },
  stopping: { id: 'runAdvice.stopping', defaultMessage: 'Stopping…' },
  toolRecords: {
    id: 'progressiveMessageList.toolRecords',
    defaultMessage: 'Tool records {count}',
  },
  toolRecordsRegion: {
    id: 'progressiveMessageList.toolRecordsRegion',
    defaultMessage: 'Tool operation records',
  },
  taskCheckRecords: {
    id: 'progressiveMessageList.taskCheckRecords',
    defaultMessage: 'Task check records {count}',
  },
  loadingMessages: {
    id: 'progressiveMessageList.loadingMessages',
    defaultMessage: 'Loading messages... ({renderedCount}/{totalCount})',
  },
  searchHint: {
    id: 'progressiveMessageList.searchHint',
    defaultMessage: 'Press Cmd/Ctrl+F to load all messages immediately for search',
  },
  modelChanged: {
    id: 'progressiveMessageList.modelChanged',
    defaultMessage: 'Model changed: {previousModel} → {currentModel}',
  },
  stopped: { id: 'gooseMessage.turnStopped', defaultMessage: 'Stopped' },
  thinking: { id: 'thinkingContent.thinking', defaultMessage: 'Thinking' },
  thinkingLive: { id: 'thinkingContent.thinkingLive', defaultMessage: 'Thinking (updating)' },
  thinkingDetails: {
    id: 'progressiveMessageList.thinkingDetails',
    defaultMessage: 'Reasoning details',
  },
  turnProcessDuration: {
    id: 'progressiveMessageList.turnProcessDuration',
    defaultMessage: 'This turn: {minutes} min {seconds} sec',
  },
  loadEarlierMessages: {
    id: 'progressiveMessageList.loadEarlierMessages',
    defaultMessage: 'Load earlier messages ({remaining} remaining)',
  },
});

interface ProgressiveMessageListProps {
  mainConversation?: boolean;
  currentModel?: string | null;
  messages: Message[];
  sessionType?: import('../types/session').SessionType;
  readOnly?: boolean;
  messageEditingDisabled?: boolean;
  chat: Pick<ChatType, 'sessionId'>;
  activeRunId?: string | null;
  cancelling?: boolean;
  toolCallNotifications?: Map<string, NotificationEvent[]>; // Make optional
  append?: (value: string) => void; // Make optional
  isUserMessage: (message: Message) => boolean;
  batchSize?: number;
  batchDelay?: number;
  showLoadingThreshold?: number; // Only show loading if more than X messages
  maxVisibleMessages?: number; // Keep long-running chats from retaining an unbounded DOM
  searchActive?: boolean;
  // Custom render function for messages
  renderMessage?: (message: Message, index: number) => React.ReactNode | null;
  isStreamingMessage?: boolean; // Whether messages are currently being streamed
  planRunning?: boolean;
  activeToolCallIds?: string[];
  thinkingActivity?: { messageId?: string; receivedAt: number };
  onMessageUpdate?: (messageId: string, newContent: string, editType?: MessageEditType, retainedImageIndexes?: number[]) => void;
  onRenderingComplete?: () => void; // Callback when all messages are rendered
  onHistoryRendered?: (sessionId: string) => void;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
  ) => Promise<boolean>;
  resubmitMessage?: (input: UserInput) => void | Promise<void>;
  resumeAfterWorkspace?: (message: Message, runId: string) => void | Promise<void>;
  suppressProviderThinking?: boolean;
  foldTurns?: boolean;
  workspaceRoot?: string;
  navigationTarget?: { messageId: string; request: number };
  onNavigationReady?: (element: HTMLElement) => void;
}

export default function ProgressiveMessageList(props: ProgressiveMessageListProps) {
  return <OrderedMessageList key={props.chat.sessionId} {...props} />;
}

function EarlierHistorySentinel({ onLoad }: { onLoad: (element: HTMLDivElement) => void }) {
  const target = useRef<HTMLDivElement>(null);
  const following = useContext(ScrollFollowingContext);
  useEffect(() => {
    const element = target.current;
    // Initial layout and tail following can expose the sentinel before the
    // viewport reaches the bottom. Only a reader leaving the tail loads history.
    if (following || !element || typeof IntersectionObserver === 'undefined') return;
    let requested = false;
    const observer = new IntersectionObserver((entries) => {
      if (!requested && entries.some((entry) => entry.isIntersecting)) {
        requested = true;
        onLoad(element);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onLoad, following]);
  return <div ref={target} data-history-sentinel aria-hidden="true" className="h-px" />;
}

function OrderedMessageList(props: ProgressiveMessageListProps) {
  const navigationRoot = useRef<HTMLDivElement>(null);
  const navigatedRequest = useRef<number | undefined>(undefined);
  const [visibleLimit, setVisibleLimit] = useState(props.maxVisibleMessages ?? 40);
  const following = useContext(ScrollFollowingContext);
  const holdAnchor = useContext(ScrollLayoutAnchorContext);
  const releaseAnchor = useRef<(() => void) | null>(null);
  const firstVisibleId = useRef<string | null | undefined>(undefined);
  const windowed = props.foldTurns !== false && !props.renderMessage;
  const projectedMessages = useMemo(() => {
    if (props.renderMessage) return props.messages;
    const turns: Message[][] = [];
    for (const message of props.messages) {
      if (!turns.length || isConversationTurnStart(message)) turns.push([]);
      turns[turns.length - 1].push(message);
    }
    // History can replay terminal receipts after all conversation messages. Bind
    // them to their explicit source user instead of the last array slice.
    const turnOwners = new Map(
      turns.flatMap((turn) =>
        turn.filter((message) => message.role === 'user').map((message) => [message.id, turn] as const)
      )
    );
    for (const turn of turns) {
      for (let index = 0; index < turn.length; ) {
        const terminal = getTurnTerminalRecord(turn[index]);
        if (!terminal || terminal.session_id !== props.chat.sessionId) {
          index += 1;
          continue;
        }
        const owner = turnOwners.get(terminal.source_user_message_id);
        if (owner && owner !== turn) owner.push(...turn.splice(index, 1));
        else index += 1;
      }
    }
    return turns.flatMap((turn) => {
      // Harness already supplies native ACP calls and receipts. Its compatibility
      // activity feed also includes child audits, whose native cards belong to
      // the child conversation. Keep all those audits out of the parent display.
      const hasNativeHarnessTools = turn
        .flatMap(getToolRequests)
        .some((request) => request.metadata?.extensionName === 'harness');
      const terminalRuns = new Set(
        turn.flatMap((message) => {
          const terminal = getTurnTerminalRecord(message);
          return terminal ? [terminal.run_id] : [];
        })
      );
      const receipts = new Map(
        turn.flatMap(getToolResponses).map((response) => [response.id, response])
      );
      const statusReads = new Set(
        turn
          .flatMap(getToolRequests)
          .filter(
            (request) =>
              presentedToolCall(request)?.name === 'list_agents' &&
              receipts.get(request.id)?.toolResult.status === 'success'
          )
          .map((request) => request.id)
      );
      // Successful internal discovery stays in the native transcript and sidebar.
      // Pending approvals and errors remain visible; public prose is never hidden.
      const presented = turn.flatMap((message) => {
        const requests = getToolRequests(message);
        const onlyStatusReads =
          requests.length > 0 && requests.every((request) => statusReads.has(request.id));
        const content = message.content.filter(
          (item) =>
            !(
              (item.type === 'toolRequest' || item.type === 'toolResponse') &&
              statusReads.has(item.id)
            )
        );
        if (
          onlyStatusReads &&
          content.every(
            (item) => item.type === 'thinking' || (item.type === 'text' && !item.text.trim())
          )
        )
          return [];
        return content.length
          ? [content.length === message.content.length ? message : { ...message, content }]
          : [];
      });
      return groupCompactionFailures(presented).filter(
        (message) =>
          !message.content.every((content) => {
            if (
              content.type !== 'systemNotification' ||
              content.notificationType !== 'codeProActivity' ||
              !isActivityEvent(content.data)
            )
              return false;
            const event = content.data;
            return (
              (event.tool_call_id !== undefined && hasNativeHarnessTools) ||
              event.event_type === 'run_completed' ||
              (terminalRuns.has(event.run_id) &&
                ['run_failed', 'run_stopped'].includes(event.event_type))
            );
          })
      );
    });
  }, [props.messages, props.renderMessage, props.chat.sessionId]);
  let startIndex =
    windowed && !props.searchActive ? Math.max(0, projectedMessages.length - visibleLimit) : 0;
  if (startIndex > 0) {
    let turnStart = -1;
    for (let index = startIndex; index >= 0; index -= 1) {
      const message = projectedMessages[index];
      if (isConversationTurnStart(message)) {
        turnStart = index;
        break;
      }
    }
    if (turnStart >= 0) startIndex = turnStart;
    if (!following && firstVisibleId.current) {
      const previous = projectedMessages.findIndex(
        (message) => message.id === firstVisibleId.current
      );
      if (previous >= 0) startIndex = Math.min(startIndex, previous);
    }
  }
  const navigationIndex = props.navigationTarget
    ? projectedMessages.findIndex((message) => message.id === props.navigationTarget?.messageId)
    : -1;
  if (navigationIndex >= 0) startIndex = Math.min(startIndex, navigationIndex);
  useLayoutEffect(() => {
    // Search can visit any old match. Keep the prior reading window so closing
    // search cannot pin the entire history when the reader is away from the tail.
    if (!props.searchActive) firstVisibleId.current = projectedMessages[startIndex]?.id;
    releaseAnchor.current?.();
    releaseAnchor.current = null;
  }, [projectedMessages, startIndex, props.searchActive]);
  useEffect(() => () => releaseAnchor.current?.(), []);
  const visibleMessages = useMemo(
    () => projectedMessages.slice(startIndex),
    [projectedMessages, startIndex]
  );
  const responses = useMemo(
    () =>
      new Map(props.messages.flatMap(getToolResponses).map((response) => [response.id, response])),
    [props.messages]
  );
  const chains = useMemo(() => identifyConsecutiveToolCalls(props.messages), [props.messages]);
  const computerTargets = useMemo(() => computerActionTargets(props.messages), [props.messages]);
  const presentation = useOrderedToolPresentation(visibleMessages, !!props.isStreamingMessage);
  const mediaJobs = useMemo(
    () => collectMediaJobs(props.messages, presentation.messages),
    [props.messages, presentation.messages]
  );
  const historyMessageCount = props.messages.length;
  const historySessionId = props.chat.sessionId;
  const onHistoryRendered = props.onHistoryRendered;
  useLayoutEffect(() => {
    if (historyMessageCount > 0 && !presentation.pending) {
      onHistoryRendered?.(historySessionId);
    }
  }, [historyMessageCount, historySessionId, onHistoryRendered, presentation.pending]);
  // ScrollArea exposes its handle in a parent layout effect. Navigate only after
  // that commit, when both the historical anchor and the scroll handle exist.
  const { navigationTarget, onNavigationReady } = props;
  useEffect(() => {
    const target = navigationTarget;
    if (!target || navigatedRequest.current === target.request) return;
    const anchor = Array.from(
      navigationRoot.current?.querySelectorAll<HTMLElement>('[data-chat-turn-id]') ?? []
    ).find((element) => element.dataset.chatTurnId === target.messageId);
    if (anchor) {
      navigatedRequest.current = target.request;
      onNavigationReady?.(anchor);
    }
  }, [navigationTarget, onNavigationReady, presentation.messages]);
  return (
    <div ref={navigationRoot} className="contents">
      {startIndex > 0 && (
        <EarlierHistorySentinel
          onLoad={(element) => {
            releaseAnchor.current?.();
            releaseAnchor.current = holdAnchor?.(element.nextElementSibling ?? element) ?? null;
            setVisibleLimit(
              (limit) => limit + Math.max(props.batchSize ?? 20, props.maxVisibleMessages ?? 40)
            );
          }}
        />
      )}
      <ProgressiveMessageListContent
        {...props}
        messages={props.renderMessage ? props.messages : presentation.messages}
        sourceMessages={props.messages}
        sharedToolResponses={responses}
        sharedToolChains={chains}
        sharedComputerTargets={computerTargets}
        sharedMediaJobs={mediaJobs}
        presentationPending={!props.renderMessage && presentation.pending}
      />
    </div>
  );
}

function formatElapsed(intl: ReturnType<typeof useIntl>, seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const format = (value: number, unit: 'minute' | 'second') =>
    intl.formatNumber(value, { style: 'unit', unit, unitDisplay: 'short' });
  return [minutes > 0 && format(minutes, 'minute'), format(seconds % 60, 'second')].filter(Boolean).join(' ');
}

function LiveTurnDuration({ startedAt }: { startedAt: number }) {
  const intl = useIntl();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor(now / 1000 - startedAt));
  return <span role="timer" className="tabular-nums">{intl.formatMessage(i18n.turnWorkingFor, {
    duration: formatElapsed(intl, elapsed),
  })}</span>;
}

function TurnProcessHistory({
  settled,
  label,
  showTime,
  storageKey,
  children,
}: {
  settled: boolean;
  label: React.ReactNode;
  showTime: boolean;
  storageKey: string;
  children: React.ReactNode;
}) {
  return (
    <div data-turn-process-summary={settled ? '' : undefined}>
      {!settled && showTime && (
        <div className="min-h-6 py-0.5 text-sm text-text-secondary">{label}</div>
      )}
      <ToolCallExpandable
        compact
        groupHeading={settled}
        label={label}
        storageKey={storageKey}
        collapsible={settled}
        collapseOnSettle={settled}
        resetOnSettle
        autoExpandOnReading={false}
        scrollable={false}
        contentClassName={settled ? 'codepro-turn-history bg-transparent' : 'contents'}
      >
        {children}
      </ToolCallExpandable>
    </div>
  );
}

function ProgressiveMessageListContent({
  messages,
  mainConversation,
  currentModel,
  sessionType,
  readOnly = false,
  messageEditingDisabled = false,
  chat,
  activeRunId,
  cancelling,
  toolCallNotifications = new Map(),
  append = () => {},
  isUserMessage,
  batchSize = 20,
  batchDelay = 20,
  showLoadingThreshold = 50,
  maxVisibleMessages = 40,
  searchActive = false,
  renderMessage, // Custom render function
  isStreamingMessage = false, // Whether messages are currently being streamed
  planRunning = isStreamingMessage,
  activeToolCallIds,
  thinkingActivity,
  onMessageUpdate,
  onRenderingComplete,
  submitElicitationResponse,
  resubmitMessage,
  resumeAfterWorkspace,
  suppressProviderThinking = false,
  foldTurns = true,
  workspaceRoot,
  renderRange,
  sourceMessages = messages,
  presentationPending = false,
  sharedToolResponses,
  sharedToolChains,
  sharedComputerTargets,
  sharedMediaJobs,
  processSettled = false,
  contentClip,
  windowWorkHistory = false,
  footer,
}: ProgressiveMessageListProps & {
  renderRange?: readonly [number, number];
  sourceMessages?: Message[];
  presentationPending?: boolean;
  sharedToolResponses?: ReadonlyMap<string, ToolResponseMessageContent>;
  sharedToolChains?: number[][];
  sharedComputerTargets?: ReadonlyMap<string, string>;
  sharedMediaJobs?: MediaJobsByCall;
  processSettled?: boolean;
  windowWorkHistory?: boolean;
  contentClip?: readonly [number, number, number];
  footer?: { hidden?: boolean; messageIndex?: number; usage?: import('../types/message').MessageUsage; created?: number };
}) {
  const intl = useIntl();
  const mediaSnapshot = useMediaJobs(readOnly ? '' : chat.sessionId);
  const [renderedCount, setRenderedCount] = useState(() => {
    // Initialize with either all messages (if small) or first batch (if large)
    return (foldTurns && !renderMessage) || messages.length <= showLoadingThreshold
      ? messages.length
      : Math.min(batchSize, messages.length);
  });
  const livePermissionKey = useSyncExternalStore(
    subscribeAcpPermissionRequests,
    useCallback(
      () =>
        JSON.stringify(
          sourceMessages
            .flatMap(getToolRequests)
            .filter((request) => isAcpPermissionRequestPending(chat.sessionId, request.id))
            .map((request) => request.id)
        ),
      [sourceMessages, chat.sessionId]
    )
  );
  const livePermissions = useMemo(
    () => new Set<string>(JSON.parse(livePermissionKey)),
    [livePermissionKey]
  );
  // Native approval cards must be immediately available while awaiting input.
  const keepAllWorkHistoryMounted = livePermissions.size > 0;
  const [isLoading, setIsLoading] = useState(
    () => !(foldTurns && !renderMessage) && messages.length > showLoadingThreshold
  );
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(maxVisibleMessages);
  const timeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const hasOnlyToolResponses = (message: Message) =>
    message.content.every((c) => c.type === 'toolResponse');

  useEffect(() => {
    setVisibleMessageLimit(maxVisibleMessages);
  }, [chat.sessionId, maxVisibleMessages]);

  const getResolvedModel = useCallback((message: Message): string | null => {
    if (message.role !== 'assistant' || !message.metadata.userVisible) return null;
    return message.metadata.inference?.resolvedModel ?? null;
  }, []);

  const getPreviousResolvedModel = useCallback(
    (index: number): string | null => {
      for (let i = index - 1; i >= 0; i--) {
        const model = getResolvedModel(messages[i]);
        if (model) return model;
      }
      return null;
    },
    [getResolvedModel, messages]
  );

  const renderModelChangeDisclosure = useCallback(
    (previousModel: string, currentModel: string) => (
      <SystemNotificationInline
        notification={{
          msg: intl.formatMessage(i18n.modelChanged, {
            previousModel: getModelDisplayName(previousModel),
            currentModel: getModelDisplayName(currentModel),
          }),
          notificationType: 'inlineMessage',
        }}
      />
    ),
    [intl]
  );

  const getSystemNotification = (message: Message): SystemNotificationContent | undefined => {
    return getCreditsExhaustedNotification(message) ?? getInlineSystemNotification(message);
  };

  const renderSystemNotification = useCallback(
    (notification: SystemNotificationContent, isActiveActivity: boolean, messageIndex?: number) => {
      switch (notification.notificationType) {
        case 'progressMessage':
          return <SystemNotificationInline notification={notification} />;
        case 'creditsExhausted':
          return <CreditsExhaustedNotification notification={notification} />;
        case 'codeProActivity':
          return <CodeProActivity notification={notification} active={isActiveActivity} />;
        case 'inlineMessage': {
          if (parseRestrictedReadonlyRequiredEvent(notification.data) && resubmitMessage) {
            return (
              <RestrictedReadonlyInline
                messages={messages}
                notification={notification}
                sessionId={chat.sessionId}
                onResubmit={resubmitMessage}
              />
            );
          }
          if (parseRootCleanupRequiredEvent(notification.data)) {
            return <RootCleanupInline notification={notification} />;
          }
          const needsWorkspace = parseNeedsWorkspaceEvent(notification.data);
          if (needsWorkspace && messageIndex !== undefined) {
            const original = findNeedsWorkspaceSourceMessage(
              messages,
              messageIndex,
              needsWorkspace
            );
            if (original) {
              return (
                <NeedsWorkspaceInline
                  notification={notification}
                  originalMessage={original}
                  onResumeAfterWorkspace={resumeAfterWorkspace}
                />
              );
            }
          }
          return <SystemNotificationInline sessionId={chat.sessionId} notification={notification} />;
        }
        default:
          return null;
      }
    },
    [messages, chat.sessionId, resubmitMessage, resumeAfterWorkspace]
  );

  // Simple progressive loading - start immediately when component mounts if needed
  useEffect(() => {
    if (searchActive || (foldTurns && !renderMessage) || messages.length <= showLoadingThreshold) {
      setRenderedCount(messages.length);
      setIsLoading(false);
      // For small lists, call completion callback immediately
      if (onRenderingComplete) {
        setTimeout(() => onRenderingComplete(), 50);
      }
      return;
    }

    // Large list - start progressive loading
    const loadNextBatch = () => {
      setRenderedCount((current) => {
        const nextCount = Math.min(current + batchSize, messages.length);

        if (nextCount >= messages.length) {
          setIsLoading(false);
          // Call the completion callback after a brief delay to ensure DOM is updated
          if (onRenderingComplete) {
            setTimeout(() => onRenderingComplete(), 50);
          }
        } else {
          // Schedule next batch
          timeoutRef.current = window.setTimeout(loadNextBatch, batchDelay);
        }

        return nextCount;
      });
    };

    // Start loading after a short delay
    timeoutRef.current = window.setTimeout(loadNextBatch, batchDelay);

    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [
    messages.length,
    searchActive,
    foldTurns,
    renderMessage,
    batchSize,
    batchDelay,
    showLoadingThreshold,
    renderedCount,
    onRenderingComplete,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // React's development build records a measure for many component renders. Long-running
  // tool chains can otherwise retain hundreds of thousands of entries and exhaust Chromium.
  useEffect(() => {
    if (!import.meta.env.DEV || messages.length === 0 || messages.length % 20 !== 0) {
      return;
    }
    window.performance.clearMeasures();
    window.performance.clearMarks();
  }, [messages.length]);

  // Detect tool call chains
  const toolCallChains = useMemo(() => identifyConsecutiveToolCalls(messages), [messages]);
  // Share one history projection across visible turn cards, including during
  // search. Loading more turns must not rescan all receipts once per card.
  const changeSource = useConversationChangeMessages(
    readOnly ? undefined : chat.sessionId,
    sourceMessages
  );
  const conversationChanges = useMemo(
    () =>
      foldTurns && !renderMessage ? collectConversationChanges(changeSource, workspaceRoot) : [],
    [foldTurns, renderMessage, changeSource, workspaceRoot]
  );
  const representedActivityToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      const notification = getSystemNotification(message);
      if (
        notification?.notificationType === 'codeProActivity' &&
        isActivityEvent(notification.data)
      ) {
        ids.add(notification.data.event_id);
      }
    }
    return ids;
  }, [messages]);
  const isRepresentedToolTransport = useCallback(
    (message: Message) => {
      if (
        message.content.length === 0 ||
        !message.content.every(
          (content) => content.type === 'toolRequest' || content.type === 'toolResponse'
        )
      ) {
        return false;
      }
      const ids = [
        ...getToolRequests(message).map((request) => request.id),
        ...getToolResponses(message).map((response) => response.id),
      ];
      return ids.length > 0 && ids.every((id) => representedActivityToolIds.has(id));
    },
    [representedActivityToolIds]
  );

  // Presentation ranges must not truncate the source context used by retry,
  // workspace recovery and receipt lookup.
  const renderEndIndex = Math.min(
    renderRange?.[1] ?? (searchActive ? messages.length : renderedCount),
    messages.length
  );
  let renderStartIndex =
    renderRange?.[0] ?? (searchActive ? 0 : Math.max(0, renderEndIndex - visibleMessageLimit));
  // Keep the beginning of the current operation sequence mounted. A transport
  // pagination boundary is not a new stage, and must not change the group's key.
  {
    while (!renderRange && renderStartIndex > 0) {
      const previous = messages[renderStartIndex - 1];
      if (
        previous.metadata.userVisible &&
        previous.content.some(
          (content) =>
            content.type !== 'toolRequest' &&
            content.type !== 'toolResponse' &&
            content.type !== 'thinking'
        )
      )
        break;
      if (
        getToolRequests(previous).some(
          (request) =>
            isPlanTool(presentedToolCall(request)?.name ?? '') ||
            isProgressTool(presentedToolCall(request)?.name ?? '')
        )
      )
        break;
      renderStartIndex -= 1;
    }
  }

  // Render messages up to the current rendered count
  const renderMessages = useCallback(() => {
    // Consume the persisted request/response messages directly. These messages are also
    // the live ACP input; no synthetic ActivityEvent or inferred file change is needed.
    // History can arrive before session metadata. Presentation must not change on hydration.
    const compactTools = true;
    const responses =
      sharedToolResponses ??
      new Map(
        sourceMessages.flatMap((item) =>
          getToolResponses(item).map((response) => [response.id, response] as const)
        )
      );
    // Only the latest acknowledged plan in this turn can show live activity.
    // Old snapshots remain readable, but must not keep spinning after updates.
    const acknowledgedPlans = messages
      .flatMap(getToolRequests)
      .filter(
        (request) =>
          isPlanTool(presentedToolCall(request)?.name ?? '') &&
          resolveToolLoadingStatus(responses.get(request.id), false, request) === 'success'
      );
    const activePlanRequestId = planRunning
      ? acknowledgedPlans[acknowledgedPlans.length - 1]?.id
      : undefined;
    const parts = new Map<Message, MessageContentPart & { index: number; footer: boolean }>();
    const messagesToRender = messages
      .slice(renderStartIndex, renderEndIndex)
      .flatMap((message, offset) => {
        const sourceRanges = renderMessage
          ? [{ message, start: 0, end: message.content.length }]
          : messageContentParts(message);
        const ranges = sourceRanges.flatMap((range) => {
          if (!contentClip || renderStartIndex + offset !== contentClip[0]) return [range];
          const start = Math.max(range.start, contentClip[1]);
          const end = Math.min(range.end, contentClip[2]);
          return end > start ? [{ ...range, start, end }] : [];
        });
        const lastPublic = [...ranges]
          .reverse()
          .find((range) =>
            message.content
              .slice(range.start, range.end)
              .some(
                (content) =>
                  content.type === 'image' || (content.type === 'text' && !!content.text.trim())
              )
          );
        return ranges.map((range) => {
          const projected = {
            ...message,
            content: message.content.slice(range.start, range.end).filter((content) => {
              if (
                !renderMessage &&
                suppressProviderThinking &&
                (content.type === 'thinking' || content.type === 'redactedThinking')
              )
                return false;
              if (
                compactTools &&
                !renderMessage &&
                content.type === 'toolRequest' &&
                isPlanTool(presentedToolCall(content)?.name ?? '') &&
                resolveToolLoadingStatus(responses.get(content.id), false, content) === 'success'
              )
                return false;
              return true;
            }),
          };
          parts.set(projected, {
            ...range,
            index: renderStartIndex + offset,
            footer: ranges.length === 1 || lastPublic === range,
          });
          return projected;
        });
      });
    const approvals = getPendingToolConfirmationIds(sourceMessages);
    const mediaJobs =
      !foldTurns && !renderRange
        ? collectMediaJobs(sourceMessages, messages.slice(renderStartIndex, renderEndIndex))
        : (sharedMediaJobs ?? collectMediaJobs(sourceMessages, messages));
    const renderMediaRequest = (request: ReturnType<typeof getToolRequests>[number]) => {
      const job = mediaJobs.get(request.id);
      if (!job || approvals.has(request.id)) return undefined;
      if (job.anchorId !== request.id) return null;
      return <MediaTaskRows jobs={[job]} sessionId={chat.sessionId} readOnly={readOnly} detailsOnly />;
    };
    const requestIds = new Set(
      sourceMessages.flatMap(getToolRequests).map((request) => request.id)
    );
    const lifecycleNotification = (item: Message) => {
      const notification = getSystemNotification(item);
      return notification && parseSubagentLifecycle(notification.data) ? notification : undefined;
    };
    const isProcessToolMessage = (item: Message) => {
      if (
        !compactTools ||
        !item.metadata.userVisible ||
        item.role !== 'assistant' ||
        getToolRequests(item).length === 0 ||
        !item.content.every(
          (content) =>
            content.type === 'toolRequest' ||
            content.type === 'thinking' ||
            content.type === 'redactedThinking' ||
            (content.type === 'text' && !content.text.trim())
        ) ||
        isRepresentedToolTransport(item)
      )
        return false;
      return getToolRequests(item).every((request) => {
        const call = presentedToolCall(request);
        return !!call && !isPlanTool(call.name) && !isProgressTool(call.name);
      });
    };
    const successfulRequest = (request: ReturnType<typeof getToolRequests>[number]) => {
      const response = responses.get(request.id);
      const audit = parseToolAuditReceipt(response?.metadata?.toolAudit);
      const call = presentedToolCall(request);
      const outcome = call && computerToolOutcome(call.name, request.id, response);
      return (
        resolveToolLoadingStatus(response, false, request) === 'success' &&
        (!audit || audit.outcome === 'success') &&
        (!outcome || outcome === 'worked')
      );
    };
    const isFoldableToolMessage = (item: Message) => {
      if (!isProcessToolMessage(item)) return false;
      return getToolRequests(item).every((request) => {
        const call =
          request.toolCall.status === 'success' ? request.toolCall.value : request.toolCall;
        const name =
          call && typeof call === 'object' && 'name' in call && typeof call.name === 'string'
            ? call.name
            : '';
        return (
          !isPlanTool(name) &&
          !isProgressTool(name) &&
          !approvals.has(request.id) &&
          successfulRequest(request)
        );
      });
    };
    const isThinkingMessage = (item: Message) =>
      item.metadata.userVisible &&
      item.role === 'assistant' &&
      item.content.length > 0 &&
      item.content.some(
        (content) => content.type === 'thinking' || content.type === 'redactedThinking'
      ) &&
      item.content.every(
        (content) =>
          content.type === 'thinking' ||
          (content.type === 'text' && !content.text.trim()) ||
          content.type === 'redactedThinking'
      );
    const renderToolMessage = (
      item: Message,
      showThinking = false,
      hiddenToolRequestIds?: ReadonlySet<string>,
      range?: readonly [number, number]
    ) =>
      lifecycleNotification(item) ? (
        <Fragment key={item.id ?? item.created}>
          {renderSystemNotification(lifecycleNotification(item)!, false)}
        </Fragment>
      ) : (
        <GooseMessage
          activePlanRequestId={activePlanRequestId}
          key={`${item.id ?? getToolRequests(item)[0]?.id ?? `tool-${item.created}`}:${range?.[0] ?? parts.get(item)?.start ?? 0}`}
          compactTools
          sessionId={chat.sessionId}
          message={parts.get(item)?.message ?? item}
          contentRange={
            range ??
            (parts.has(item) &&
            (parts.get(item)!.start > 0 ||
              parts.get(item)!.end < parts.get(item)!.message.content.length)
              ? [parts.get(item)!.start, parts.get(item)!.end]
              : undefined)
          }
          groupedProcess
          showGroupedThinking={showThinking}
          hiddenToolRequestIds={hiddenToolRequestIds}
          renderToolRequest={renderMediaRequest}
          showMessageFooter={false}
          messages={sourceMessages}
          toolResponses={sharedToolResponses}
          toolChains={sharedToolChains}
          computerTargets={sharedComputerTargets}
          suppressProviderThinking={suppressProviderThinking}
          append={append}
          toolCallNotifications={toolCallNotifications}
          activeToolCallIds={isStreamingMessage ? (activeToolCallIds ?? []) : []}
          thinkingActivity={isStreamingMessage ? thinkingActivity : undefined}
          isStreaming={isStreamingMessage}
        />
      );
    const operationSummary = (group: Message[]) => {
      const requests = group.flatMap(getToolRequests);
      // Keep internal submissions out of artifact/action success and failure counts.
      // Their original receipts remain below; this summary does not decide completion.
      const checks = requests.filter((request) => {
        const call = presentedToolCall(request);
        return call && isTaskContractCheck(call);
      });
      const operations = requests.filter(
        (request) => !checks.includes(request) && !mediaJobs.has(request.id)
      );
      const successful = formatToolActionSummary(
        intl,
        operations.flatMap((request) => {
          if (!successfulRequest(request)) return [];
          const call = presentedToolCall(request);
          return call ? [call] : [];
        })
      );
      return [
        successful,
        checks.length ? intl.formatMessage(i18n.taskCheckRecords, { count: checks.length }) : '',
      ]
        .filter(Boolean)
        .join('\u2002');
    };
    const foldedIndices = new Set<number>();
    // Thinking is a detail within the operation sequence, not a new public
    // explanation. Keep the original messages/order and tool safety boundaries.
    const collectProcess = (start: number) => {
      const group: Message[] = [];
      let settled = processSettled || (!isStreamingMessage && !presentationPending);
      let atPublicBoundary = false;
      for (let next = start; next < messagesToRender.length; next += 1) {
        const candidate = messagesToRender[next];
        if (
          isProcessToolMessage(candidate) ||
          isThinkingMessage(candidate) ||
          lifecycleNotification(candidate)
        ) {
          group.push(candidate);
          foldedIndices.add(next);
        } else if (
          !candidate.metadata.userVisible ||
          isPlanContextMessage(candidate) ||
          getResponsePhase(candidate) ||
          isRepresentedToolTransport(candidate) ||
          candidate.content.length === 0 ||
          candidate.content.every((content) => content.type === 'text' && !content.text.trim()) ||
          candidate.content.every((content) => content.type === 'toolResponse') ||
          (getAnyToolConfirmationData(candidate) &&
            requestIds.has(getAnyToolConfirmationData(candidate)!.id))
        ) {
          continue;
        } else {
          atPublicBoundary =
            candidate.role === 'assistant' &&
            (candidate.content.some(
              (content) =>
                (content.type === 'text' && !!content.text.trim()) || content.type === 'image'
            ) ||
              getToolRequests(candidate).some((request) => {
                const call = presentedToolCall(request);
                return call && (isProgressTool(call.name) || isPlanTool(call.name));
              }));
          // A control record stays visible, but an unbound old terminal cannot
          // close current presentation. Public output can close settled details.
          if (!getTurnTerminalRecord(candidate)) settled = true;
          break;
        }
      }
      // A public boundary cannot hide live, approval-blocked or unknown work.
      settled &&= group.every(
        (item) =>
          isThinkingMessage(item) || lifecycleNotification(item) || isFoldableToolMessage(item)
      );
      return { group, settled, atPublicBoundary };
    };
    const disclosedModels = new Set<Message>();
    const history = messagesToRender
      .map((message, localIndex) => {
        const part = parts.get(message);
        const index = part?.index ?? renderStartIndex + localIndex;
        if (
          !message.metadata.userVisible ||
          isPlanContextMessage(message) ||
          getResponsePhase(message)
        ) {
          return null;
        }
        if (message.content.length === 0) return null;
        const terminal = getTurnTerminalRecord(message);
        const receiptOnly = message.content.every(
          (content) => content.type === 'systemNotification'
        );
        // The local cancellation anchor is not a native stop confirmation.
        if (cancelling && terminal?.status === 'cancelled' && receiptOnly) return null;
        const plainStopReceipt =
          terminal &&
          !terminal.stop_reason &&
          (terminal.status === 'cancelled' || terminal.status === 'interrupted') &&
          terminal.checkpoint_id === null &&
          terminal.retry_strategy === 'not_available' &&
          terminal.report?.outcome !== 'waiting_for_user' &&
          !terminal.report_parse_failed;
        if (
          plainStopReceipt &&
          (terminal.status === 'cancelled' || terminal.user_requested_stop === true) &&
          receiptOnly
        ) {
          return (
            <div key={message.id} role="status" className="mt-2 text-sm text-text-secondary">
              {intl.formatMessage(i18n.stopped)}
            </div>
          );
        }
        // Keep terminal facts for folding and recovery without adding a host-only
        // chat row. Actual reply text and actionable recovery still render.
        if (
          terminal &&
          (plainStopReceipt ||
            (codeProTerminalPresentation(terminal)?.summaryStatus === 'completed' &&
              !hasUnverifiedAcceptance(terminal) &&
              !hasMissingFinalReply(terminal))) &&
          message.content.every((content) => content.type === 'systemNotification')
        )
          return null;
        if (renderMessage) {
          return renderMessage(message, index);
        }

        // Replies are rendered with their request. Thinking retains its own
        // disclosure inside the process; it is not public commentary.
        if (
          compactTools &&
          message.content.length > 0 &&
          message.content.every((content) => content.type === 'toolResponse')
        )
          return null;

        // Default rendering logic (for BaseChat)
        if (!chat) {
          console.warn(
            'ProgressiveMessageList: chat prop is required when not using custom renderMessage'
          );
          return null;
        }

        if (isRepresentedToolTransport(message)) {
          return null;
        }

        if (foldedIndices.has(localIndex)) return null;
        const requests = getToolRequests(message);
        const progressRequest = requests.length === 1 ? requests[0] : undefined;
        const progressCall = progressRequest ? presentedToolCall(progressRequest) : undefined;
        if (
          compactTools &&
          message.content.every(
            (content) =>
              content.type === 'toolRequest' ||
              content.type === 'thinking' ||
              (content.type === 'text' && !content.text.trim())
          ) &&
          progressRequest &&
          progressCall &&
          isProgressTool(progressCall.name) &&
          typeof progressCall.arguments.text === 'string' &&
          (resolveToolLoadingStatus(responses.get(progressRequest.id), false, progressRequest) ===
            'success' ||
            (!responses.has(progressRequest.id) && activeToolCallIds?.includes(progressRequest.id)))
        ) {
          return (
            <CodeProWorkStep
              sessionId={chat.sessionId}
              key={`step-${progressRequest.id}`}
              text={progressCall.arguments.text}
              settled={false}
              operationCount={0}
              storageKey={`step-${progressRequest.id}`}
              summary=""
              streaming={
                (presentationPending && localIndex === messagesToRender.length - 1) ||
                (!!isStreamingMessage &&
                  !responses.has(progressRequest.id) &&
                  !!activeToolCallIds?.includes(progressRequest.id))
              }
            />
          );
        }
        if (
          isProcessToolMessage(message) ||
          isThinkingMessage(message) ||
          lifecycleNotification(message)
        ) {
          const { group, settled, atPublicBoundary } = collectProcess(localIndex);
          const groupRequests = group.flatMap(getToolRequests);
          const groupMedia = [
            ...new Set(
              groupRequests.flatMap((request) => {
                const job = mediaJobs.get(request.id);
                return job?.anchorId === request.id ? [job] : [];
              })
            ),
          ];
          const onlyMedia =
            groupRequests.length > 0 && groupRequests.every((request) => mediaJobs.has(request.id));
          const mediaOnlyView = onlyMedia && groupMedia.length > 0;
          // A hidden poll can leave an empty transport shell, but cannot hide
          // original thinking, ordinary tools, lifecycle events or approvals.
          if (
            onlyMedia &&
            groupMedia.length === 0 &&
            !group.some(
              (item) =>
                isThinkingMessage(item) ||
                lifecycleNotification(item) ||
                item.content.some(
                  (content) => content.type === 'thinking' || content.type === 'redactedThinking'
                )
            ) &&
            !groupRequests.some((request) => approvals.has(request.id))
          )
            return null;
          const summary = operationSummary(group);
          const mediaStates = groupMedia.map((job) => mediaJobObservation(job, mediaSnapshot));
          const mediaSummary = mediaProcessSummary(groupMedia, mediaStates);
          const awaitingApproval = group
            .flatMap(getToolRequests)
            .some(
              (request) =>
                livePermissions.has(request.id) &&
                approvals.has(request.id) &&
                !responses.has(request.id)
            );
          const pendingIds = new Set(
            group
              .flatMap(getToolRequests)
              .filter(
                (request) =>
                  livePermissions.has(request.id) &&
                  approvals.has(request.id) &&
                  !responses.has(request.id)
              )
              .map((request) => request.id)
          );
          // A late reasoning block changes content, never the group's identity.
          const groupIdentity = message.id ?? requests[0]?.id ?? index;
          const identity = `${groupIdentity}:${part?.start ?? 0}`;
          const attentionStates = group
            .flatMap(getToolRequests)
            .flatMap((request): ('failed' | 'unknown')[] => {
              const job = mediaJobs.get(request.id);
              if (job) {
                const observation = mediaJobObservation(job, mediaSnapshot);
                return observation.status === 'failed'
                  ? ['failed']
                  : observation.status === 'unavailable' ||
                      observation.status === 'submission_unknown'
                    ? ['unknown']
                    : [];
              }
              const response = responses.get(request.id);
              const active = isToolCallInProgress(request, !!isStreamingMessage, activeToolCallIds);
              const status = resolveToolLoadingStatus(response, active, request);
              const call = presentedToolCall(request);
              const outcome = call && computerToolOutcome(call.name, request.id, response);
              const audit = parseToolAuditReceipt(response?.metadata?.toolAudit);
              if (status === 'error') return ['failed'];
              return status === 'unknown' ||
                (!!audit && audit.outcome !== 'success') ||
                (!!outcome && outcome !== 'worked')
                ? ['unknown']
                : [];
            });
          const attention = attentionStates.includes('failed') ? 'failed' : attentionStates[0];
          const activeRequest = [...groupRequests]
            .reverse()
            .find(
              (request) =>
                !responses.has(request.id) &&
                (approvals.has(request.id) ||
                  isToolCallInProgress(request, !!isStreamingMessage, activeToolCallIds))
            );
          const latestPart = group[group.length - 1];
          const thinkingNow =
            !activeRequest &&
            !settled &&
            isStreamingMessage &&
            !!latestPart.id &&
            thinkingActivity?.messageId === latestPart.id &&
            isThinkingMessage(latestPart);
          const headlineRequest = activeRequest ?? groupRequests[groupRequests.length - 1];
          const headlineCall = headlineRequest ? presentedToolCall(headlineRequest) : undefined;
          const headlineStatus = headlineRequest
            ? resolveToolLoadingStatus(
                responses.get(headlineRequest.id),
                !!activeRequest,
                headlineRequest
              )
            : undefined;
          const currentLabel =
            !thinkingNow && headlineCall
              ? formatToolAction(
                  intl,
                  headlineCall.name,
                  headlineCall.arguments,
                  headlineStatus === 'loading' && !awaitingApproval
                    ? 'running'
                    : headlineRequest && successfulRequest(headlineRequest)
                      ? 'completed'
                      : undefined,
                  'detail',
                  typeof headlineRequest?.metadata?.title === 'string'
                    ? headlineRequest.metadata.title
                    : undefined,
                  headlineRequest ? sharedComputerTargets?.get(headlineRequest.id) : undefined
                )
              : lifecycleNotification(latestPart)?.msg ||
                intl.formatMessage(thinkingNow ? i18n.thinkingLive : i18n.thinking);
          // A closed history may contain unsuccessful receipts. Use the same
          // display boundary as folding without treating those receipts as success.
          const processClosed =
            processSettled ||
            settled ||
            (atPublicBoundary && groupRequests.every((request) => responses.has(request.id)));
          const label =
            onlyMedia && !groupMedia.length
              ? intl.formatMessage(thinkingNow ? i18n.thinkingLive : i18n.thinking)
              : mediaSummary
                ? [summary, mediaSummary].filter(Boolean).join('\u2002')
                : processClosed
                  ? summary ||
                    (groupRequests.length
                      ? intl.formatMessage(i18n.toolRecords, { count: groupRequests.length })
                      : currentLabel)
                  : currentLabel;
          return (
            <div
              key={`tools-${identity}`}
              className="my-0.5 w-full max-w-[52rem]"
              data-testid="message-container"
              data-process-group=""
            >
              <ToolCallExpandable
                compact
                storageKey={`operations-${identity}`}
                groupHeading
                scrollable={false}
                contentClassName="codepro-process-details bg-transparent py-0.5"
                label={label}
                icon={
                  thinkingNow ? (
                    <ToolActivityIcon name="thinking" status="loading" />
                  ) : !headlineCall ? (
                    <ThinkingIcon />
                  ) : (
                    <ToolActivityIcon
                      name={headlineCall.name}
                      status={
                        mediaOnlyView
                          ? mediaStates.some((state) => state.active)
                            ? 'loading'
                            : attention
                              ? 'warning'
                              : mediaStates.every((state) => state.status === 'completed')
                                ? 'success'
                                : 'pending'
                          : groupMedia.some((job) => mediaJobObservation(job, mediaSnapshot).active)
                            ? 'loading'
                            : awaitingApproval
                              ? 'pending'
                              : headlineStatus === 'loading'
                                ? 'loading'
                                : attention
                                  ? 'warning'
                                  : 'success'
                      }
                    />
                  )
                }
                isStartExpanded={false}
                collapseOnSettle={processClosed}
                resetOnSettle
                autoExpandOnReading={false}
                live={!processClosed && (isStreamingMessage || presentationPending)}
              >
                <div
                  data-testid="tool-message-group"
                  className="codepro-tool-group text-sm text-text-secondary"
                  tabIndex={0}
                  role="region"
                  aria-label={intl.formatMessage(i18n.toolRecordsRegion)}
                >
                  {windowWorkHistory ? (
                    <WorkHistoryWindow
                      rows={group.map((item) => renderToolMessage(item, true, pendingIds))}
                      keepAllMounted={keepAllWorkHistoryMounted}
                      prepareSearch={searchActive}
                    />
                  ) : group.map((item) => renderToolMessage(item, true, pendingIds))}
                </div>
              </ToolCallExpandable>
              {!renderRange && <MediaTaskCards jobs={groupMedia} sessionId={chat.sessionId} readOnly={readOnly} />}
              {awaitingApproval && (
                <div data-process-approval="">
                  {group.flatMap((item) => {
                    const source = parts.get(item)?.message ?? item;
                    return source.content.flatMap((content, offset) =>
                      content.type === 'toolRequest' &&
                      pendingIds.has(content.id) &&
                      offset >= (parts.get(item)?.start ?? 0) &&
                      offset < (parts.get(item)?.end ?? source.content.length)
                        ? [renderToolMessage(item, false, undefined, [offset, offset + 1])]
                        : []
                    );
                  })}
                </div>
              )}
            </div>
          );
        }

        const notification = getSystemNotification(message);
        if (notification) {
          if (notification.notificationType === 'codeProActivity') {
            let previousIndex = localIndex - 1;
            while (
              previousIndex >= 0 &&
              (isRepresentedToolTransport(messagesToRender[previousIndex]) ||
                (!messagesToRender[previousIndex].metadata.userVisible &&
                  messagesToRender[previousIndex].role !== 'user'))
            ) {
              previousIndex -= 1;
            }
            const previousNotification =
              previousIndex >= 0
                ? getSystemNotification(messagesToRender[previousIndex])
                : undefined;
            if (previousNotification?.notificationType === 'codeProActivity') {
              return null;
            }

            const activityNotifications = [notification];
            let activityEndIndex = localIndex;
            for (
              let nextIndex = localIndex + 1;
              nextIndex < messagesToRender.length;
              nextIndex += 1
            ) {
              const nextNotification = getSystemNotification(messagesToRender[nextIndex]);
              if (nextNotification?.notificationType === 'codeProActivity') {
                activityNotifications.push(nextNotification);
                activityEndIndex = nextIndex;
                continue;
              }
              if (
                isRepresentedToolTransport(messagesToRender[nextIndex]) ||
                (!messagesToRender[nextIndex].metadata.userVisible &&
                  messagesToRender[nextIndex].role !== 'user')
              ) {
                activityEndIndex = nextIndex;
                continue;
              }
              break;
            }

            // Successful routing bookkeeping is not a user operation. Keep the
            // receipt in history/storage, but do not give it a chat card/count.
            const activityItems = buildCodeProActivityRenderItems(activityNotifications).filter(
              (item) =>
                !(
                  item.kind === 'activity' &&
                  (item.activity.eventType === 'intent_started' ||
                    item.activity.eventType === 'intent_completed' ||
                    ((item.activity.state === 'running' || item.activity.state === 'completed') &&
                      (item.activity.eventType === 'plan_created' ||
                        item.activity.eventType === 'plan_updated')) ||
                    (item.activity.state === 'completed' &&
                      (item.activity.eventType === 'strategy_selected' ||
                        item.activity.eventType === 'strategy_updated')))
                )
            );
            if (activityItems.length === 0) return null;
            const isActiveGroup =
              isStreamingMessage &&
              messagesToRender
                .slice(activityEndIndex + 1)
                .every(
                  (next) =>
                    isRepresentedToolTransport(next) ||
                    (!next.metadata.userVisible && next.role !== 'user')
                );
            const activitySegments: (typeof activityItems)[] = [];
            for (const item of activityItems) {
              const activity = item.kind === 'read-group' ? item.activities[0] : item.activity;
              const previousSegment = activitySegments[activitySegments.length - 1];
              const previousItem = previousSegment?.[previousSegment.length - 1];
              const previousActivity = previousItem
                ? previousItem.kind === 'read-group'
                  ? previousItem.activities[0]
                  : previousItem.activity
                : null;
              const isThinking =
                activity.eventType === 'intent_started' ||
                activity.eventType === 'intent_completed' ||
                activity.eventId?.startsWith('thinking-');
              if (
                !previousSegment ||
                isThinking ||
                previousActivity?.eventType === 'intent_started' ||
                previousActivity?.eventType === 'intent_completed' ||
                previousActivity?.eventId?.startsWith('thinking-') ||
                previousActivity?.runId !== activity.runId ||
                previousActivity?.taskId !== activity.taskId
              ) {
                activitySegments.push([item]);
              } else {
                previousSegment.push(item);
              }
            }

            return (
              <div
                key={`activity-group-${message.id ?? `msg-${index}-${message.created}`}`}
                className={`relative ${localIndex === 0 ? 'mt-0' : 'mt-1'} assistant`}
                data-testid="message-container"
              >
                <div className="flex flex-col gap-1.5">
                  {activitySegments.map((segment, segmentIndex) => {
                    const isActiveItem =
                      isActiveGroup && segmentIndex === activitySegments.length - 1;
                    const item = segment[0];
                    const activity =
                      item.kind === 'read-group' ? item.activities[0] : item.activity;
                    if (
                      segment.length === 1 &&
                      item.kind === 'activity' &&
                      (activity.eventType === 'intent_started' ||
                        activity.eventType === 'intent_completed' ||
                        activity.eventId?.startsWith('thinking-'))
                    ) {
                      return (
                        <CodeProActivityCard
                          key={item.key}
                          activity={activity}
                          active={isActiveItem}
                        />
                      );
                    }
                    return (
                      <CodeProActivityTimeline
                        key={item.key}
                        items={segment}
                        active={isActiveItem}
                      />
                    );
                  })}
                </div>
              </div>
            );
          }

          return (
            <div
              key={`notification-${message.id ?? `msg-${index}-${message.created}`}`}
              className={`relative ${localIndex === 0 ? 'mt-0' : 'mt-4'} assistant`}
              data-testid="message-container"
            >
              {renderSystemNotification(notification, false, index)}
            </div>
          );
        }

        const isUser = isUserMessage(message);
        const messageIsInChain = isInChain(index, toolCallChains);
        const currentResolvedModel = getResolvedModel(message);
        const previousResolvedModel = currentResolvedModel ? getPreviousResolvedModel(index) : null;
        const showModelChangeDisclosure = Boolean(
          currentResolvedModel &&
          previousResolvedModel &&
          currentResolvedModel !== previousResolvedModel &&
          !disclosedModels.has(part?.message ?? message)
        );
        if (showModelChangeDisclosure) disclosedModels.add(part?.message ?? message);

        const messageKey = `${message.id ?? `msg-${index}-${message.created}`}:${part?.start ?? 0}`;

        return (
          <Fragment key={messageKey}>
            {showModelChangeDisclosure &&
              currentResolvedModel &&
              previousResolvedModel &&
              renderModelChangeDisclosure(previousResolvedModel, currentResolvedModel)}
            <div
              className={`relative ${localIndex === 0 ? 'mt-0' : compactTools ? 'mt-3' : 'mt-4'} ${isUser ? 'user' : 'assistant'} ${mainConversation && isUser ? 'pr-9' : ''} ${messageIsInChain ? 'in-chain' : ''}`}
              data-testid="message-container"
            >
              {isUser ? (
                !hasOnlyToolResponses(message) && (
                  <>
                  {mainConversation && <span aria-hidden="true" className="absolute right-0 top-0 grid size-7 place-items-center rounded-full bg-teal-500/15 text-teal-700 dark:text-teal-300"><UserRound size={17} /></span>}
                  <UserMessage
                    message={message}
                    readOnly={readOnly || messageEditingDisabled}
                    onMessageUpdate={onMessageUpdate}
                    sessionType={sessionType}
                  />
                  </>
                )
              ) : (
                <GooseMessage
                  activePlanRequestId={activePlanRequestId}
                  compactTools={compactTools}
                  sessionId={chat.sessionId}
                  message={part?.message ?? message}
                  contentRange={
                    part && (part.start > 0 || part.end < part.message.content.length)
                      ? [part.start, part.end]
                      : undefined
                  }
                  showMessageFooter={!footer?.hidden && (footer?.messageIndex === undefined || footer.messageIndex === index) && (!part || part.footer)}
                  usageOverride={footer?.usage}
                  createdOverride={footer?.created}
                  messages={sourceMessages}
                  toolResponses={sharedToolResponses}
                  toolChains={sharedToolChains}
                  renderToolRequest={renderMediaRequest}
                  suppressProviderThinking={suppressProviderThinking}
                  append={append}
                  onRetryMessage={onMessageUpdate}
                  toolCallNotifications={toolCallNotifications}
                  activeToolCallIds={isStreamingMessage ? (activeToolCallIds ?? []) : []}
                  thinkingActivity={isStreamingMessage ? thinkingActivity : undefined}
                  isTurnRunning={isStreamingMessage}
                  isStreaming={
                    (isStreamingMessage || presentationPending) &&
                    !isUser &&
                    localIndex === messagesToRender.length - 1 &&
                    message.role === 'assistant'
                  }
                  submitElicitationResponse={submitElicitationResponse}
                />
              )}
            </div>
          </Fragment>
        );
      })
      .filter(Boolean);
    return history;
  }, [
    messages,
    cancelling,
    sourceMessages,
    sharedToolResponses,
    sharedToolChains,
    presentationPending,
    processSettled,
    contentClip,
    footer,
    sharedComputerTargets,
    sharedMediaJobs,
    mediaSnapshot,
    foldTurns,
    renderRange,
    livePermissions,
    windowWorkHistory,
    keepAllWorkHistoryMounted,
    searchActive,
    renderStartIndex,
    renderEndIndex,
    renderMessage,
    isUserMessage,
    chat,
    append,
    toolCallNotifications,
    isStreamingMessage,
    planRunning,
    activeToolCallIds,
    thinkingActivity,
    onMessageUpdate,
    sessionType,
    readOnly,
    messageEditingDisabled,
    toolCallChains,
    submitElicitationResponse,
    getPreviousResolvedModel,
    getResolvedModel,
    renderModelChangeDisclosure,
    mainConversation,
    isRepresentedToolTransport,
    renderSystemNotification,
    suppressProviderThinking,
    intl,
  ]);

  if (foldTurns && !renderMessage) {
    // Internal-only records can project to an empty list, including while the
    // ordered presenter is waiting to release the next visible message.
    if (messages.length === 0) return null;
    let cancellingStart: number | undefined;
    const starts = messages.flatMap((message, index) => {
      if (!isConversationTurnStart(message)) return [];
      // Queue previews have their own display row before native admission.
      if (cancelling && !message.metadata.pendingDelivery) cancellingStart = index;
      return [index];
    });
    if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
    const cancellingTurn = cancellingStart === undefined ? undefined : messages[cancellingStart];
    const renderSlice = (
      turn: Message[],
      start: number,
      end: number,
      streaming: boolean,
      pending = false,
      settled = false,
      clip?: readonly [number, number, number],
      footer?: {
        hidden?: boolean;
        messageIndex?: number;
        usage?: import('../types/message').MessageUsage;
        created?: number;
      },
      windowWorkHistory = false
    ) => (
      <ProgressiveMessageListContent
        messages={turn}
        sourceMessages={sourceMessages}
        sharedToolResponses={sharedToolResponses}
        sharedToolChains={sharedToolChains}
        sharedComputerTargets={sharedComputerTargets}
        sharedMediaJobs={sharedMediaJobs}
        presentationPending={pending}
        processSettled={settled}
        contentClip={clip}
        windowWorkHistory={windowWorkHistory}
        searchActive={searchActive}
        footer={footer}
        renderRange={[start, end]}
        sessionType={sessionType}
        mainConversation={mainConversation}
        readOnly={readOnly}
        messageEditingDisabled={messageEditingDisabled}
        chat={chat}
        activeRunId={activeRunId}
        cancelling={turn[0] === cancellingTurn}
        foldTurns={false}
        toolCallNotifications={toolCallNotifications}
        append={append}
        isUserMessage={isUserMessage}
        isStreamingMessage={streaming}
        planRunning={streaming && planRunning}
        activeToolCallIds={activeToolCallIds}
        thinkingActivity={streaming ? thinkingActivity : undefined}
        onMessageUpdate={onMessageUpdate}
        submitElicitationResponse={submitElicitationResponse}
        resubmitMessage={resubmitMessage}
        resumeAfterWorkspace={resumeAfterWorkspace}
        suppressProviderThinking={suppressProviderThinking}
        workspaceRoot={workspaceRoot}
        maxVisibleMessages={turn.length}
        showLoadingThreshold={Number.MAX_SAFE_INTEGER}
      />
    );
    return (
      <>
        {starts.map((start, turnIndex) => {
          const items = messages.slice(start, starts[turnIndex + 1] ?? messages.length);
          // An incoming project report has its own author and lifetime. Keep it
          // outside the current prompt's collapsible tool history and footer.
          const reports = mainConversation ? items.filter(message => {
            const data = getInlineSystemNotification(message)?.data;
            return data && typeof data === 'object' && 'event' in data && data.event === 'managed_turn_result' &&
              'outcome' in data && data.outcome === 'completed';
          }) : [];
          const reportRows = reports.map(message => <Fragment key={message.id}>
            {renderSystemNotification(getInlineSystemNotification(message)!, false)}
          </Fragment>);
          const turn = reports.length ? items.filter(message => !reports.includes(message)) : items;
          if (!turn.length) return <Fragment key={items[0].id ?? start}>{reportRows}</Fragment>;
          const latest = turnIndex === starts.length - 1;
          const streaming = isStreamingMessage && latest;
          // Queued presentation can outlive transport streaming. It belongs to
          // the latest turn's tail, never to already rendered historical prose.
          const pending = presentationPending && latest;
          const continuations = turn.filter(
            (message) => message.role === 'user' && message.metadata.presentation?.continuation === true
          );
          const continued = continuations.length > 0;
          const source = continuations[continuations.length - 1] ?? turn[0];
          const sourceUserId = source.id ?? turn[0]?.id;
          let lastReplyIndex = -1;
          let terminalIndex = -1;
          let lastToolIndex = -1;
          let answerBoundaryIndex = -1;
          let answerMessageId: string | undefined;
          turn.forEach((message, index) => {
            if (getToolRequests(message).length > 0) lastToolIndex = index;
            const record = getTurnTerminalRecord(message);
            if (
              message.role === 'assistant' &&
              message.metadata.userVisible &&
              !record &&
              message.content.some(
                (part) => part.type === 'image' || (part.type === 'text' && !!part.text.trim())
              )
            ) {
              lastReplyIndex = index;
            }
            if (
              record &&
              record.session_id === chat.sessionId &&
              record.source_user_message_id === sourceUserId
            )
              terminalIndex = index;
          });
          const terminal =
            terminalIndex >= 0 ? getTurnTerminalRecord(turn[terminalIndex]) : undefined;
          turn.forEach((message, index) => {
            const phase = getResponsePhase(message);
            if (
              phase &&
              phase.session_id === chat.sessionId &&
              phase.source_user_message_id === sourceUserId &&
              (!streaming || !activeRunId || phase.run_id === activeRunId) &&
              (!terminal || phase.run_id === terminal.run_id)
            ) {
              answerBoundaryIndex = index;
              answerMessageId = phase.answer_message_id;
            }
          });
          const hasAnswerBoundary = answerBoundaryIndex > lastToolIndex;
          const hasTerminalBoundary =
            !!terminal &&
            terminalIndex > lastToolIndex &&
            (!streaming || !activeRunId || terminal.run_id === activeRunId);
          const boundary = turn[hasAnswerBoundary ? answerBoundaryIndex : terminalIndex];
          const rawBoundaryIndex = boundary
            ? sourceMessages.findIndex(
                (message) => message === boundary || (!!boundary.id && message.id === boundary.id)
              )
            : -1;
          let laterToolReceived = false;
          for (
            let index = rawBoundaryIndex + 1;
            rawBoundaryIndex >= 0 && index < sourceMessages.length;
            index += 1
          ) {
            const message = sourceMessages[index];
            if (isConversationTurnStart(message)) break;
            if (getToolRequests(message).length > 0) {
              laterToolReceived = true;
              break;
            }
          }
          // A bound host boundary folds stage text with work history and keeps
          // the final reply outside. It never executes or seals a turn.
          const awaitingNativePermission = turn
            .flatMap(getToolRequests)
            .some((request) => livePermissions.has(request.id));
          const settled =
            !laterToolReceived &&
            !awaitingNativePermission &&
            (hasAnswerBoundary || hasTerminalBoundary);
          const timedTurn = isConversationTurnStart(turn[0]) && Number.isFinite(source.created);
          const elapsed =
            timedTurn && settled && terminal && hasTerminalBoundary
              ? Math.floor(Date.parse(terminal.finished_at) / 1000 - source.created)
              : NaN;
          const hasProcess = turn.some((message) =>
            message.content.some(
              (content) =>
                content.type === 'toolRequest' ||
                content.type === 'thinking' ||
                content.type === 'redactedThinking'
            )
          );
          const timedEnd = Number.isFinite(elapsed) && elapsed >= 0;
          const liveTime = timedTurn && streaming && !hasTerminalBoundary;
          const turnCancelling = start === cancellingStart;
          let processLabel: React.ReactNode;
          // Local sealing inserts a terminal before the native cancellation
          // barrier settles. It cannot confirm that execution has stopped.
          if (turnCancelling) {
            processLabel = intl.formatMessage(i18n.stopping);
          } else if (timedEnd) {
            processLabel = terminal?.user_requested_stop || terminal?.status === 'cancelled'
              ? intl.formatMessage(i18n.turnStoppedAfter, { duration: formatElapsed(intl, elapsed) })
              : intl.formatMessage(i18n.turnDuration, { minutes: Math.floor(elapsed / 60), seconds: elapsed % 60 });
          } else if (liveTime) {
            processLabel = <LiveTurnDuration startedAt={source.created} />;
          } else {
            processLabel = intl.formatMessage(i18n.turnRecord, { count: turn.flatMap(getToolRequests).length });
          }
          const userEnd = turn[0]?.role === 'user' ? 1 : 0;
          // A bound host boundary selects display history. Never classify
          // prose by wording or treat the final-looking paragraph as a result.
          let answerIndex = -1;
          let answerStart = 0;
          if (
            settled &&
            terminal?.last_response_text_available !== false &&
            (hasAnswerBoundary ||
              terminal?.status === 'completed' ||
              terminal?.last_response_text_available === true)
          ) {
            turn.forEach((message, index) => {
              if (index < lastToolIndex || getTurnTerminalRecord(message)) return;
              if (
                hasAnswerBoundary &&
                (answerMessageId ? message.id !== answerMessageId : index <= answerBoundaryIndex)
              )
                return;
              if (message.role !== 'assistant') return;
              let afterTool = 0;
              if (index === lastToolIndex)
                message.content.forEach((part, offset) => {
                  if (part.type === 'toolRequest') afterTool = offset + 1;
                });
              const start = message.content.findIndex(
                (part, offset) =>
                  offset >= afterTool &&
                  (part.type === 'image' || (part.type === 'text' && !!part.text.trim()))
              );
              if (start >= 0) {
                answerIndex = index;
                answerStart = start;
              }
            });
          }
          // A continuation extends the existing reply. Keep its earlier prose
          // in place rather than folding it away when the next run completes.
          const historyEnd = continued ? userEnd :
            answerIndex >= 0
              ? answerIndex + (answerStart > 0 ? 1 : 0)
              : hasTerminalBoundary
                ? terminalIndex
                : turn.length;
          const answerFrom = continued ? userEnd : answerIndex >= 0 ? answerIndex : historyEnd;
          const hasHistory =
            hasProcess ||
            turn
              .slice(userEnd, historyEnd)
              .some(
                (message) =>
                  message.role === 'assistant' &&
                  message.content.some(
                    (part) => part.type === 'image' || (part.type === 'text' && !!part.text.trim())
                  )
              );
          const rawStart = sourceMessages.findIndex(
            (message) => message === turn[0] || (!!turn[0]?.id && message.id === turn[0].id)
          );
          let rawEnd = sourceMessages.length;
          for (let index = rawStart + 1; rawStart >= 0 && index < sourceMessages.length; index++) {
            const message = sourceMessages[index];
            if (isConversationTurnStart(message)) {
              rawEnd = index;
              break;
            }
          }
          // Both the body and a stop notice can render a footer. Assign the
          // turn's actions and usage once, including chats without a terminal.
          const footerIndex = continued || !hasTerminalBoundary
            ? lastReplyIndex
            : answerIndex >= 0 ? answerIndex : terminalIndex;
          const messageIndex = isConversationTurnStart(turn[0]) && footerIndex >= 0 ? footerIndex : undefined;
          const usage = hasTerminalBoundary || (messageIndex !== undefined && !streaming && !pending)
            ? conversationUsage(rawStart >= 0 ? sourceMessages.slice(rawStart, rawEnd) : turn, {
                attributedOnly: true,
              })
            : undefined;
          const completedAt =
            hasTerminalBoundary && terminal ? Date.parse(terminal.finished_at) / 1000 : undefined;
          const turnMedia = [...new Set(turn.flatMap(getToolRequests).flatMap(request => {
            const job = sharedMediaJobs?.get(request.id);
            return job ? [job] : [];
          }))];
          const deliveredPaths = turnMedia.flatMap(job => mediaOutputPaths(mediaJobObservation(job, mediaSnapshot).receipt));
          return (
            <DeliveredMediaScope key={turn[0]?.id ?? start} paths={deliveredPaths}>
            <section data-chat-turn-id={turn[0]?.id} className={mainConversation ? 'main-conversation-turn mb-6' : 'mb-6'}>
              {renderSlice(turn, 0, userEnd, streaming, pending, settled)}
              {mainConversation && (hasProcess || lastReplyIndex >= 0 || streaming) && <MainConversationAuthor
                model={turn.find(m => getResolvedModel(m))?.metadata.inference?.resolvedModel ??
                  source.metadata.inference?.requestedModel ?? (streaming ? currentModel : null)} />}
              <div className={mainConversation ? 'pl-9' : 'contents'}>
              <TurnProcessHistory
                settled={!continued && settled && hasHistory}
                label={processLabel}
                showTime={timedEnd || liveTime || turnCancelling}
                storageKey={`turn-process-${chat.sessionId}-${turn[0]?.id ?? start}`}
              >
                {renderSlice(
                  turn,
                  userEnd,
                  historyEnd,
                  streaming && !settled,
                  pending && !settled,
                  settled,
                  !continued && answerIndex >= 0 ? [answerIndex, 0, answerStart] : undefined,
                  { hidden: settled || streaming || pending, messageIndex, usage },
                  true
                )}
              </TurnProcessHistory>
              <AnswerFiles.Provider value={conversationChanges.find(change => change.id === turn[0]?.id)?.files ?? []}>
              {renderSlice(
                turn,
                answerFrom,
                turn.length,
                streaming,
                pending,
                settled,
                !continued && answerIndex >= 0
                  ? [answerIndex, answerStart, turn[answerIndex].content.length]
                  : undefined,
                { usage, created: completedAt, messageIndex, hidden: continued && (streaming || pending) }
              )}
              </AnswerFiles.Provider>
              {terminal?.status === 'completed' && !continued && turn[0]?.role === 'user' && turn.some(m => getToolRequests(m).length > 0) && (
                <AnswerWorkspaceLinks
                  sessionId={chat.sessionId}
                  request={turn[0].content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')}
                  answer={turn[answerIndex]?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') ?? ''}
                />
              )}
              <MediaTaskCards jobs={turnMedia} sessionId={chat.sessionId} readOnly={readOnly} />
              {(hasTerminalBoundary || (hasAnswerBoundary && answerMessageId && !pending)) && (
                <CodeProConversationFiles
                  messages={turn}
                  sourceChanges={conversationChanges}
                  sessionId={chat.sessionId}
                  workspaceRoot={workspaceRoot}
                />
              )}
              </div>
            </section>
            {reportRows}
            </DeliveredMediaScope>
          );
        })}
      </>
    );
  }

  return (
    <>
      {!renderRange && renderStartIndex > 0 && (
        <EarlierHistorySentinel
          onLoad={() =>
            setVisibleMessageLimit((current) =>
              Math.min(messages.length, current + Math.max(batchSize, maxVisibleMessages))
            )
          }
        />
      )}

      {windowWorkHistory ? (
        <WorkHistoryWindow rows={renderMessages()} keepAllMounted={keepAllWorkHistoryMounted}
          prepareSearch={searchActive} />
      ) : renderMessages()}

      {/* Loading indicator when progressively rendering */}
      {isLoading && (
        <div className="flex flex-col items-center justify-center py-8">
          <LoadingGoose
            message={intl.formatMessage(i18n.loadingMessages, {
              renderedCount,
              totalCount: messages.length,
            })}
          />
          <div className="text-xs text-text-secondary mt-2">
            {intl.formatMessage(i18n.searchHint)}
          </div>
        </div>
      )}
    </>
  );
}
