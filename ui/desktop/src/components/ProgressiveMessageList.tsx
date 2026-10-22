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
} from 'react';
import { defineMessages, useIntl } from '../i18n';
import GooseMessage, { codeProTerminalPresentation, hasMissingFinalReply } from './GooseMessage';
import { resolveToolLoadingStatus } from './ToolCallWithResponse';
import { parseToolAuditReceipt } from '../acp/adapter/toolAudit';
import { computerToolOutcome } from './computerToolOutcome';
import { isPlanTool, isProgressTool, presentedToolCall } from './codepro/CodeProToolContent';
import { isPlanContextMessage, planFromResponse } from '../types/codeproPlan';
import { ToolCallExpandable } from './ToolCallExpandable';
import { CodeProWorkStep } from './codepro/CodeProWorkStep';
import { formatToolActionSummary, isTaskContractCheck } from './toolActionPresentation';
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
} from './context_management/SystemNotificationInline';
import {
  CreditsExhaustedNotification,
  getCreditsExhaustedNotification,
} from './context_management/CreditsExhaustedNotification';
import {
  getToolRequests,
  getToolResponses,
  getAnyToolConfirmationData,
  type Message,
  type NotificationEvent,
  type SystemNotificationContent,
  type UserInput,
  type ToolResponseMessageContent,
} from '../types/message';
import { isActivityEvent } from '../types/activityEvent';
import { getTurnTerminalRecord, type MessageEditType } from '../types/turnTerminal';
import { getResponsePhase } from '../types/responsePhase';
import { CodeProConversationFiles } from './codepro/CodeProConversationFiles';
import { collectConversationChanges } from './codepro/conversationChanges';
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
  turnCompleted: {
    id: 'conversation.turnCompleted',
    defaultMessage: 'Completed {count} operations',
  },
  turnDuration: {
    id: 'conversation.turnDuration',
    defaultMessage: 'Time spent {minutes} min {seconds} sec',
  },
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
  loadEarlierMessages: {
    id: 'progressiveMessageList.loadEarlierMessages',
    defaultMessage: 'Load earlier messages ({remaining} remaining)',
  },
});

interface ProgressiveMessageListProps {
  messages: Message[];
  sessionType?: import('../types/session').SessionType;
  readOnly?: boolean;
  chat: Pick<ChatType, 'sessionId'>;
  activeRunId?: string | null;
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
  onMessageUpdate?: (messageId: string, newContent: string, editType?: MessageEditType) => void;
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
}

export default function ProgressiveMessageList(props: ProgressiveMessageListProps) {
  return <OrderedMessageList key={props.chat.sessionId} {...props} />;
}

function EarlierHistorySentinel({ onLoad }: { onLoad: (element: HTMLDivElement) => void }) {
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = target.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    let requested = false;
    const observer = new IntersectionObserver((entries) => {
      if (!requested && entries.some((entry) => entry.isIntersecting)) {
        requested = true;
        onLoad(element);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onLoad]);
  return <div ref={target} data-history-sentinel aria-hidden="true" className="h-px" />;
}

function OrderedMessageList(props: ProgressiveMessageListProps) {
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
      if (
        !turns.length ||
        (message.role === 'user' &&
          message.metadata.userVisible &&
          getToolResponses(message).length === 0)
      )
        turns.push([]);
      turns[turns.length - 1].push(message);
    }
    // History can replay terminal receipts after all conversation messages. Bind
    // them to their explicit source user instead of the last array slice.
    const turnOwners = new Map(
      turns.filter((turn) => turn[0]?.role === 'user').map((turn) => [turn[0].id, turn])
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
        return content.length ? [{ ...message, content }] : [];
      });
      return presented.filter(
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
      if (
        message.role === 'user' &&
        message.metadata.userVisible &&
        getToolResponses(message).length === 0
      ) {
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
  const presentation = useOrderedToolPresentation(visibleMessages, !!props.isStreamingMessage);
  const historyMessageCount = props.messages.length;
  const historySessionId = props.chat.sessionId;
  const onHistoryRendered = props.onHistoryRendered;
  useLayoutEffect(() => {
    if (historyMessageCount > 0 && !presentation.pending) {
      onHistoryRendered?.(historySessionId);
    }
  }, [historyMessageCount, historySessionId, onHistoryRendered, presentation.pending]);
  return (
    <>
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
        presentationPending={!props.renderMessage && presentation.pending}
      />
    </>
  );
}

function ProgressiveMessageListContent({
  messages,
  sessionType,
  readOnly = false,
  chat,
  activeRunId,
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
}: ProgressiveMessageListProps & {
  renderRange?: readonly [number, number];
  sourceMessages?: Message[];
  presentationPending?: boolean;
  sharedToolResponses?: ReadonlyMap<string, ToolResponseMessageContent>;
  sharedToolChains?: number[][];
}) {
  const intl = useIntl();
  const [renderedCount, setRenderedCount] = useState(() => {
    // Initialize with either all messages (if small) or first batch (if large)
    return (foldTurns && !renderMessage) || messages.length <= showLoadingThreshold
      ? messages.length
      : Math.min(batchSize, messages.length);
  });
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
          return <SystemNotificationInline notification={notification} />;
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
    const messagesToRender = messages.slice(renderStartIndex, renderEndIndex).map((message) => ({
      ...message,
      content: message.content.filter((content) => {
        if (
          compactTools &&
          !renderMessage &&
          content.type === 'toolRequest' &&
          isPlanTool(presentedToolCall(content)?.name ?? '') &&
          responses.has(content.id) &&
          !!planFromResponse(responses.get(content.id)!)
        )
          return false;
        return true;
      }),
    }));
    const approvals = new Set(
      messages.flatMap((item) => {
        const confirmation = getAnyToolConfirmationData(item);
        return confirmation ? [confirmation.id] : [];
      })
    );
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
    const isFoldableToolMessage = (item: Message) => {
      if (!isProcessToolMessage(item)) return false;
      return getToolRequests(item).every((request) => {
        const response = responses.get(request.id);
        const audit = parseToolAuditReceipt(response?.metadata?.toolAudit);
        const call =
          request.toolCall.status === 'success' ? request.toolCall.value : request.toolCall;
        const name =
          call && typeof call === 'object' && 'name' in call && typeof call.name === 'string'
            ? call.name
            : '';
        const outcome = computerToolOutcome(name, request.id, response);
        const status = resolveToolLoadingStatus(response, false, request);
        return (
          !isPlanTool(name) &&
          !isProgressTool(name) &&
          !approvals.has(request.id) &&
          (status === 'success' || status === 'error') &&
          (!audit || audit.outcome === 'success' || audit.outcome === 'tool_error') &&
          (!outcome || outcome === 'worked')
        );
      });
    };
    const isThinkingMessage = (item: Message) =>
      item.metadata.userVisible &&
      item.role === 'assistant' &&
      item.content.length > 0 &&
      item.content.some((content) => content.type === 'thinking') &&
      item.content.every(
        (content) =>
          content.type === 'thinking' || (content.type === 'text' && !content.text.trim())
      );
    const renderToolMessage = (item: Message) => (
      <GooseMessage
        activePlanRequestId={activePlanRequestId}
        key={item.id ?? getToolRequests(item)[0]?.id ?? `tool-${item.created}`}
        compactTools
        sessionId={chat.sessionId}
        message={item}
        messages={sourceMessages}
        toolResponses={sharedToolResponses}
        toolChains={sharedToolChains}
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
      const operations = requests.filter((request) => !checks.includes(request));
      const successful = formatToolActionSummary(
        intl,
        operations.flatMap((request) => {
          if (resolveToolLoadingStatus(responses.get(request.id), false, request) !== 'success')
            return [];
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
      let settled = !isStreamingMessage && !presentationPending;
      for (let next = start; next < messagesToRender.length; next += 1) {
        const candidate = messagesToRender[next];
        if (isProcessToolMessage(candidate) || isThinkingMessage(candidate)) {
          group.push(candidate);
          foldedIndices.add(next);
        } else if (
          !candidate.metadata.userVisible ||
          isPlanContextMessage(candidate) ||
          getResponsePhase(candidate) ||
          isRepresentedToolTransport(candidate) ||
          candidate.content.length === 0 ||
          candidate.content.every((content) => content.type === 'text' && !content.text.trim()) ||
          candidate.content.every((content) => content.type === 'toolResponse')
        ) {
          continue;
        } else {
          // Public text and separate approval UI remain outside this process.
          settled = true;
          break;
        }
      }
      // A public boundary cannot hide live, approval-blocked or unknown work.
      settled &&= group.every((item) => isThinkingMessage(item) || isFoldableToolMessage(item));
      return { group, settled };
    };
    const history = messagesToRender
      .map((message, localIndex) => {
        const index = renderStartIndex + localIndex;
        if (
          !message.metadata.userVisible ||
          isPlanContextMessage(message) ||
          getResponsePhase(message)
        ) {
          return null;
        }
        if (message.content.length === 0) return null;
        const terminal = getTurnTerminalRecord(message);
        if (
          terminal &&
          codeProTerminalPresentation(terminal)?.summaryStatus === 'completed' &&
          !hasMissingFinalReply(terminal) &&
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
            (content) => content.type === 'toolRequest' || content.type === 'thinking'
          ) &&
          progressRequest &&
          progressCall &&
          isProgressTool(progressCall.name) &&
          typeof progressCall.arguments.text === 'string' &&
          (resolveToolLoadingStatus(responses.get(progressRequest.id), false, progressRequest) ===
            'success' ||
            (!responses.has(progressRequest.id) && activeToolCallIds?.includes(progressRequest.id)))
        ) {
          const { group, settled } = collectProcess(localIndex + 1);
          const progressIndex = message.content.indexOf(progressRequest);
          const beforeProgress = message.content.slice(0, progressIndex);
          const afterProgress = message.content.slice(progressIndex + 1);
          if (afterProgress.length > 0) {
            group.unshift({ ...message, content: afterProgress });
          }
          return (
            <Fragment key={`step-${progressRequest.id}`}>
              {beforeProgress.length > 0
                ? renderToolMessage({ ...message, content: beforeProgress })
                : null}
              <CodeProWorkStep
                key={`step-${progressRequest.id}`}
                text={progressCall.arguments.text}
                settled={settled}
                operationCount={group.flatMap(getToolRequests).length}
                storageKey={`step-${progressRequest.id}`}
                summary={operationSummary(group)}
                streaming={
                  (presentationPending && localIndex === messagesToRender.length - 1) ||
                  (!!isStreamingMessage &&
                    !responses.has(progressRequest.id) &&
                    !!activeToolCallIds?.includes(progressRequest.id))
                }
              >
                {group.length > 0 ? group.map(renderToolMessage) : undefined}
              </CodeProWorkStep>
            </Fragment>
          );
        }
        if (isProcessToolMessage(message) || isThinkingMessage(message)) {
          const { group, settled } = collectProcess(localIndex);
          const summary = operationSummary(group);
          const operationCount = group.flatMap(getToolRequests).length;
          const awaitingApproval = group
            .flatMap(getToolRequests)
            .some((request) => approvals.has(request.id) && !responses.has(request.id));
          const identity = message.content.some((content) => content.type === 'thinking')
            ? (message.id ?? requests[0]?.id ?? index)
            : (requests[0]?.id ?? message.id ?? index);
          return (
            <div
              key={`tools-${identity}`}
              className="my-0.5 w-full max-w-[52rem]"
              data-testid="message-container"
            >
              <ToolCallExpandable
                compact
                storageKey={`operations-${identity}`}
                groupHeading
                scrollable={false}
                label={
                  settled && summary
                    ? summary
                    : intl.formatMessage(i18n.turnRecord, { count: operationCount })
                }
                isStartExpanded={!settled}
                collapsible={!awaitingApproval && operationCount > 1}
              >
                <div
                  data-testid="tool-message-group"
                  className="codepro-tool-group text-sm text-text-secondary"
                  tabIndex={0}
                  role="region"
                  aria-label={intl.formatMessage(i18n.toolRecordsRegion)}
                >
                  {/* Keep the actions readable; only code and raw receipts need
                      expanding. Public commentary remains outside this scroller. */}
                  {group.map(renderToolMessage)}
                </div>
              </ToolCallExpandable>
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
          currentResolvedModel !== previousResolvedModel
        );

        const messageKey = message.id ?? `msg-${index}-${message.created}`;

        return (
          <Fragment key={messageKey}>
            {showModelChangeDisclosure &&
              currentResolvedModel &&
              previousResolvedModel &&
              renderModelChangeDisclosure(previousResolvedModel, currentResolvedModel)}
            <div
              className={`relative ${localIndex === 0 ? 'mt-0' : compactTools ? 'mt-3' : 'mt-4'} ${isUser ? 'user' : 'assistant'} ${messageIsInChain ? 'in-chain' : ''}`}
              data-testid="message-container"
            >
              {isUser ? (
                !hasOnlyToolResponses(message) && (
                  <UserMessage
                    message={message}
                    readOnly={readOnly}
                    onMessageUpdate={onMessageUpdate}
                    sessionType={sessionType}
                  />
                )
              ) : (
                <GooseMessage
                  activePlanRequestId={activePlanRequestId}
                  compactTools={compactTools}
                  sessionId={chat.sessionId}
                  message={message}
                  messages={sourceMessages}
                  toolResponses={sharedToolResponses}
                  toolChains={sharedToolChains}
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
    sourceMessages,
    sharedToolResponses,
    sharedToolChains,
    presentationPending,
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
    toolCallChains,
    submitElicitationResponse,
    getPreviousResolvedModel,
    getResolvedModel,
    renderModelChangeDisclosure,
    isRepresentedToolTransport,
    renderSystemNotification,
    suppressProviderThinking,
    intl,
  ]);

  if (foldTurns && !renderMessage) {
    // Internal-only records can project to an empty list, including while the
    // ordered presenter is waiting to release the next visible message.
    if (messages.length === 0) return null;
    const starts = messages.flatMap((message, index) =>
      message.role === 'user' &&
      message.metadata.userVisible &&
      message.content.some((content) => content.type === 'text' || content.type === 'image')
        ? [index]
        : []
    );
    if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
    const renderSlice = (
      turn: Message[],
      start: number,
      end: number,
      streaming: boolean,
      pending = false
    ) => (
      <ProgressiveMessageListContent
        messages={turn}
        sourceMessages={sourceMessages}
        sharedToolResponses={sharedToolResponses}
        sharedToolChains={sharedToolChains}
        presentationPending={pending}
        renderRange={[start, end]}
        sessionType={sessionType}
        readOnly={readOnly}
        chat={chat}
        activeRunId={activeRunId}
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
          const turn = messages.slice(start, starts[turnIndex + 1] ?? messages.length);
          const latest = turnIndex === starts.length - 1;
          const streaming = isStreamingMessage && latest;
          // Queued presentation can outlive transport streaming. It belongs to
          // the latest turn's tail, never to already rendered historical prose.
          const pending = presentationPending && latest;
          const turnRequests = turn.flatMap(getToolRequests);
          const count = turnRequests.length;
          const turnResponses = new Map(
            turn.flatMap(getToolResponses).map((response) => [response.id, response] as const)
          );
          let terminalIndex = -1;
          let lastToolIndex = -1;
          let answerBoundaryIndex = -1;
          turn.forEach((message, index) => {
            if (getToolRequests(message).length > 0) lastToolIndex = index;
            const record = getTurnTerminalRecord(message);
            if (
              record &&
              record.session_id === chat.sessionId &&
              record.source_user_message_id === turn[0]?.id
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
              phase.source_user_message_id === turn[0]?.id &&
              (!streaming || !activeRunId || phase.run_id === activeRunId) &&
              (!terminal || phase.run_id === terminal.run_id)
            )
              answerBoundaryIndex = index;
          });
          const hasAnswerBoundary = answerBoundaryIndex > lastToolIndex;
          const hasTerminalBoundary =
            !!terminal &&
            terminalIndex > lastToolIndex &&
            (!streaming || !activeRunId || terminal.run_id === activeRunId);
          // Idle transport (or a later user message) is not proof that this turn
          // finished. A bound terminal is, even before the first tool or while
          // transport teardown is pending; its outcome need not be success.
          const userCount =
            turn[0]?.role === 'user' && getToolResponses(turn[0]).length === 0 ? 1 : 0;
          let finalIndex = -1;
          for (let index = userCount; index < turn.length; index += 1) {
            const message = turn[index];
            if (
              index > lastToolIndex &&
              message.role === 'assistant' &&
              message.metadata.userVisible &&
              getToolRequests(message).length === 0 &&
              message.content.some(
                (content) => content.type === 'text' && content.text.trim().length > 0
              )
            ) {
              // Without a bound answer phase, we cannot distinguish a delivery
              // explanation from a later host notice. Keep the entire public
              // text tail rather than letting the notice hide delivered work.
              finalIndex = index;
              break;
            }
          }
          if (finalIndex < 0) finalIndex = terminalIndex;
          const terminalHasText =
            terminalIndex >= 0 &&
            turn[terminalIndex].content.some(
              (content) => content.type === 'text' && content.text.trim().length > 0
            );
          const proposedHistoryEnd = hasAnswerBoundary
            ? answerBoundaryIndex
            : hasTerminalBoundary && lastToolIndex < userCount && terminalHasText
              ? terminalIndex
              : finalIndex >= userCount
                ? finalIndex
                : turn.length;
          // Presentation can delay a newly received tool. It cannot make an older
          // terminal or answer marker hide work the host has already delivered.
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
            if (message.role === 'user' && getToolResponses(message).length === 0) break;
            if (getToolRequests(message).length > 0) {
              laterToolReceived = true;
              break;
            }
          }
          // Final reasoning is part of the work, including when the provider
          // puts it in the same message as the public answer. This is a display
          // projection only; native messages, ordering and receipts stay intact.
          const answerThinking = turn.slice(proposedHistoryEnd).flatMap((message, offset) => {
            const content = message.content.filter((item) => item.type === 'thinking');
            return !suppressProviderThinking && message.role === 'assistant' && content.length
              ? [{ ...message, id: `${message.id ?? `answer:${offset}`}:work-thinking`, content }]
              : [];
          });
          const foldable =
            !laterToolReceived &&
            (hasAnswerBoundary || hasTerminalBoundary) &&
            (count > 0 ||
              answerThinking.length > 0 ||
              (!suppressProviderThinking &&
                turn
                  .slice(userCount, proposedHistoryEnd)
                  .some((message) =>
                    message.content.some((content) => content.type === 'thinking')
                  )) ||
              terminal?.status !== 'completed' ||
              turn.some((message) =>
                message.content.some(
                  (content) =>
                    content.type === 'systemNotification' &&
                    content.notificationType === 'codeProActivity' &&
                    isActivityEvent(content.data)
                )
              )) &&
            (proposedHistoryEnd > userCount || answerThinking.length > 0);
          const displayTurn = foldable
            ? [
                ...turn.slice(0, proposedHistoryEnd),
                ...answerThinking,
                ...turn
                  .slice(proposedHistoryEnd)
                  .map((message) =>
                    message.role === 'assistant' &&
                    message.content.some((content) => content.type === 'thinking')
                      ? {
                          ...message,
                          content: message.content.filter((content) => content.type !== 'thinking'),
                        }
                      : message
                  )
                  .filter((message) => message.content.length > 0),
              ]
            : turn;
          const historyEnd = foldable
            ? proposedHistoryEnd + answerThinking.length
            : displayTurn.length;
          const completed =
            terminal?.status === 'completed' &&
            !terminal.report_parse_failed &&
            (!terminal.report || terminal.report.outcome === 'completed') &&
            // A completed Harness turn can contain denied or failed operations.
            // This label describes tool receipts, not a second task verdict.
            turnRequests.every(
              (request) =>
                resolveToolLoadingStatus(turnResponses.get(request.id), false, request) ===
                'success'
            );
          const finishedAt = hasAnswerBoundary
            ? turn[answerBoundaryIndex].created
            : terminal
              ? Date.parse(terminal.finished_at) / 1000
              : NaN;
          const elapsed = Math.round(finishedAt - turn[0].created);
          const duration =
            elapsed >= 0 && Number.isFinite(elapsed)
              ? intl.formatMessage(i18n.turnDuration, {
                  minutes: Math.floor(elapsed / 60),
                  seconds: elapsed % 60,
                })
              : undefined;
          return (
            <section key={turn[0]?.id ?? start} className="mb-6">
              {renderSlice(displayTurn, 0, userCount, false)}
              <ToolCallExpandable
                compact
                // Keep this parent and its process subtree mounted across the
                // answer boundary so manual expansion and reading anchors survive.
                className={foldable ? 'text-text-secondary codepro-turn-history' : undefined}
                scrollable={false}
                collapsible={foldable}
                collapseOnSettle={foldable}
                storageKey={`${chat.sessionId}:turn:${turn[0]?.id ?? start}`}
                label={
                  duration
                    ? duration
                    : intl.formatMessage(completed ? i18n.turnCompleted : i18n.turnRecord, {
                        count,
                      })
                }
              >
                {renderSlice(
                  displayTurn,
                  userCount,
                  historyEnd,
                  streaming && !foldable,
                  pending && historyEnd === displayTurn.length
                )}
              </ToolCallExpandable>
              {renderSlice(displayTurn, historyEnd, displayTurn.length, streaming, pending)}
              {hasTerminalBoundary && (
                <CodeProConversationFiles
                  messages={turn}
                  sourceChanges={conversationChanges}
                  sessionId={chat.sessionId}
                  workspaceRoot={workspaceRoot}
                />
              )}
            </section>
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

      {renderMessages()}

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
