import { useEffect, useMemo, useRef } from 'react';
import ImagePreview from './ImagePreview';
import { formatMessageTimestamp } from '../utils/timeUtils';
import MarkdownContent from './MarkdownContent';
import './ui/stream-prose.css';
import ThinkingContent from './ThinkingContent';
import ToolCallWithResponse from './ToolCallWithResponse';
import {
  getTextAndImageContent,
  getThinkingContent,
  getToolRequests,
  getToolResponses,
  getToolConfirmationContent,
  getElicitationContent,
  getPendingToolConfirmationIds,
  getAnyToolConfirmationData,
  ToolConfirmationData,
  NotificationEvent,
  type Message,
  type ToolResponseMessageContent,
} from '../types/message';
import ToolCallConfirmation from './ToolCallConfirmation';
import ElicitationRequest from './ElicitationRequest';
import MessageCopyLink from './MessageCopyLink';
import MessageUsageStats from './MessageUsageStats';
import { cn } from '../utils';
import { identifyConsecutiveToolCalls, shouldHideTimestamp } from '../utils/toolCallChaining';
import { defineMessages, useIntl } from '../i18n';
import {
  getTurnTerminalRecord,
  type MessageEditType,
  type TurnTerminalRecord,
  type TurnTerminalReport,
} from '../types/turnTerminal';
import { getResponsePhase } from '../types/responsePhase';
import {
  getAssistantMessageActionPolicy,
  resolveAssistantCopyText,
  resolveAssistantRetryMode,
} from './messageActionsModel';
import {
  formatCodeProSummaryStatus,
  formatCodeProTerminalVerdict,
} from './codepro/codeProPresentation';

type CodeProTerminalPresentation = {
  summaryStatus: 'completed' | 'failed' | 'paused' | 'cancelled';
  verdict: 'PASS' | 'NOT_RUN' | 'FAIL' | 'BLOCKED' | 'WAITING_FOR_USER';
};

export function shouldSuppressProviderThinking(suppressProviderThinking: boolean): boolean {
  return suppressProviderThinking;
}

// The host can split one response into several tool messages with copied thinking.
// Hide only the repeated view in that contiguous tool sequence; retain all source messages.
export function isRepeatedToolThinking(message: Message, messages: Message[]): boolean {
  const thinking = getThinkingContent(message);
  if (
    !thinking ||
    !getToolRequests(message).length ||
    getTextAndImageContent(message).textContent.trim()
  )
    return false;
  const index = messages.findIndex(
    (candidate) => candidate === message || (!!message.id && candidate.id === message.id)
  );
  for (let i = index - 1; i >= 0; i--) {
    const previous = messages[i];
    if (getToolResponses(previous).length) continue;
    if (previous.role === 'user' || getTextAndImageContent(previous).textContent.trim()) break;
    if (!getToolRequests(previous).length) break;
    if (
      previous.metadata.userVisible &&
      previous.created === message.created &&
      getThinkingContent(previous) === thinking
    )
      return true;
  }
  return false;
}

export function codeProTerminalPresentation(
  terminal: Pick<TurnTerminalRecord, 'status'> & {
    report?: Pick<TurnTerminalReport, 'outcome'> &
      Partial<Pick<TurnTerminalReport, 'verification_summary'>>;
    report_parse_failed?: true;
  }
): CodeProTerminalPresentation | undefined {
  if (terminal.report_parse_failed) {
    return { summaryStatus: 'paused', verdict: 'BLOCKED' };
  }
  switch (terminal.report?.outcome) {
    case 'completed': {
      const verification = terminal.report.verification_summary ?? [];
      if (verification.some((entry) => entry.verdict === 'failed')) {
        return { summaryStatus: 'failed', verdict: 'FAIL' };
      }
      if (
        verification.some(
          (entry) => entry.verdict === 'unverified' || entry.verdict === 'unavailable'
        )
      ) {
        return { summaryStatus: 'paused', verdict: 'BLOCKED' };
      }
      const allPassed =
        verification.length > 0 && verification.every((entry) => entry.verdict === 'passed');
      return { summaryStatus: 'completed', verdict: allPassed ? 'PASS' : 'NOT_RUN' };
    }
    case 'skipped':
      return { summaryStatus: 'completed', verdict: 'NOT_RUN' };
    case 'failed':
      return { summaryStatus: 'failed', verdict: 'FAIL' };
    case 'cancelled':
      return { summaryStatus: 'cancelled', verdict: 'BLOCKED' };
    case 'waiting_for_user':
      return { summaryStatus: 'paused', verdict: 'WAITING_FOR_USER' };
    case 'partial':
    case 'paused':
    case 'planning_failed':
    case 'scheduling_failed':
    case 'review_failed':
      return { summaryStatus: 'paused', verdict: 'BLOCKED' };
  }

  switch (terminal.status) {
    case 'completed':
      return undefined;
    case 'failed':
      return { summaryStatus: 'failed', verdict: 'FAIL' };
    case 'cancelled':
      return { summaryStatus: 'cancelled', verdict: 'BLOCKED' };
    case 'interrupted':
      return { summaryStatus: 'paused', verdict: 'BLOCKED' };
  }
}

const i18n = defineMessages({
  pausedStatus: { id: 'codeProControlPlane.paused', defaultMessage: 'Paused' },
  cancelledExplanation: {
    id: 'gooseMessage.cancelledExplanation',
    defaultMessage:
      'Stopped at your request. Actions already taken are not undone; any unconfirmed results still need checking.',
  },
  interruptedExplanation: {
    id: 'gooseMessage.interruptedExplanation',
    defaultMessage:
      'This task was interrupted and completion has not been confirmed. The conversation and operation records are available above.',
  },
  turnStopped: {
    id: 'gooseMessage.turnStopped',
    defaultMessage: 'Stopped',
  },
  turnStoppedSummary: {
    id: 'gooseMessage.turnStoppedSummary',
    defaultMessage:
      '{count, plural, one {# tool action was preserved.} other {# tool actions were preserved.}}',
  },
});

interface GooseMessageProps {
  activePlanRequestId?: string;
  compactTools?: boolean;
  sessionId: string;
  message: Message;
  messages: Message[];
  toolResponses?: ReadonlyMap<string, ToolResponseMessageContent>;
  toolChains?: number[][];
  suppressProviderThinking?: boolean;
  metadata?: string[];
  toolCallNotifications: Map<string, NotificationEvent[]>;
  append: (value: string) => void;
  isStreaming: boolean;
  isTurnRunning?: boolean;
  activeToolCallIds?: string[];
  thinkingActivity?: { messageId?: string; receivedAt: number };
  onRetryMessage?: (
    messageId: string,
    content: string,
    editType?: MessageEditType
  ) => void | Promise<void>;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
  ) => Promise<boolean>;
}

export function shouldShowMessageActions(
  displayText: string,
  isStreaming: boolean,
  turnTerminal?: Pick<TurnTerminalRecord, 'status' | 'retry_strategy'>,
  supersededByTurnTerminal = false
): boolean {
  return getAssistantMessageActionPolicy({
    displayText,
    isStreaming,
    superseded: supersededByTurnTerminal,
    terminal: turnTerminal
      ? { checkpoint_id: null, retry_strategy: turnTerminal.retry_strategy }
      : undefined,
  }).showActionGroup;
}

export function codeProRetryMode(
  _displayText: string,
  turnTerminal?: Pick<TurnTerminalRecord, 'checkpoint_id' | 'retry_strategy'>
): 'continue' | 'replay' | 'retry_validation' | 'resubmit' | 'none' {
  return resolveAssistantRetryMode(turnTerminal);
}

export function isRetryableUserMessage(message: Message): boolean {
  const content = getTextAndImageContent(message);
  return (
    message.role === 'user' &&
    Boolean(message.id) &&
    message.metadata.userVisible &&
    (content.textContent.trim().length > 0 || content.imagePaths.length > 0)
  );
}

export function isTurnTerminalSuperseded(message: Message, messages: Message[]): boolean {
  const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (messageIndex < 0) {
    return false;
  }
  const sourceUserMessageId = getTurnTerminalRecord(message)?.source_user_message_id;
  return messages.slice(messageIndex + 1).some((candidate) => {
    const candidateTerminal = getTurnTerminalRecord(candidate);
    return (
      candidateTerminal?.retry_of_terminal_message_id === message.id ||
      (sourceUserMessageId !== undefined &&
        candidateTerminal?.source_user_message_id === sourceUserMessageId)
    );
  });
}

export function shouldShowTextMessageActions(
  showMessageActions: boolean,
  hasTurnTerminal: boolean
): boolean {
  return showMessageActions && !hasTurnTerminal;
}

// Only an explicitly bound answer phase can distinguish a streamed handoff
// from earlier progress. An empty or unrelated phase still needs the fallback.
function hasPriorAnswerText(terminal: TurnTerminalRecord, messages: Message[]): boolean {
  if (terminal.status !== 'interrupted' || !terminal.visible_text_available) return false;
  const terminalIndex = messages.findIndex(
    (message) => message.id === terminal.terminal_message_id
  );
  let hasAnswerText = false;
  for (let index = terminalIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === 'user' ||
      getToolRequests(message).length > 0 ||
      getTurnTerminalRecord(message)
    )
      return false;
    const phase = getResponsePhase(message);
    if (phase) {
      return (
        hasAnswerText &&
        phase.session_id === terminal.session_id &&
        phase.run_id === terminal.run_id &&
        phase.source_user_message_id === terminal.source_user_message_id
      );
    }
    if (message.role === 'assistant' && message.metadata.userVisible) {
      hasAnswerText ||= getTextAndImageContent(message).textContent.trim().length > 0;
    }
  }
  return false;
}

export default function GooseMessage({
  activePlanRequestId,
  compactTools = false,
  sessionId,
  message,
  messages,
  toolResponses,
  toolChains,
  suppressProviderThinking = false,
  toolCallNotifications,
  append,
  isStreaming,
  isTurnRunning = isStreaming,
  onRetryMessage,
  activeToolCallIds,
  thinkingActivity,
  submitElicitationResponse,
}: GooseMessageProps) {
  const intl = useIntl();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const plainTextCopyRef = useRef<HTMLDivElement | null>(null);

  const { textContent, imagePaths } = getTextAndImageContent(message);
  const thinkingContent = getThinkingContent(message);
  const thinkingActive = !!message.id && thinkingActivity?.messageId === message.id;
  const providerThinkingSuppressed =
    shouldSuppressProviderThinking(suppressProviderThinking) ||
    isRepeatedToolThinking(message, messages);
  const turnTerminal = getTurnTerminalRecord(message);
  const plainTerminal =
    turnTerminal?.status === 'cancelled' || turnTerminal?.status === 'interrupted';
  const priorAnswerText =
    turnTerminal?.session_id === sessionId && hasPriorAnswerText(turnTerminal, messages);
  const displayText =
    textContent.trim() ||
    (plainTerminal && !priorAnswerText
      ? intl.formatMessage(
          turnTerminal.status === 'cancelled'
            ? i18n.cancelledExplanation
            : i18n.interruptedExplanation
        )
      : textContent);
  // Preserve the source timeline. Only adjacent fragments of the same kind may
  // share a renderer; a later thought must never move above intervening prose/tools.
  const contentBlocks = useMemo(() => {
    const blocks: { start: number; content: Message['content'] }[] = [];
    message.content.forEach((content, start) => {
      const previous = blocks[blocks.length - 1];
      if (
        (content.type === 'text' || content.type === 'thinking') &&
        previous?.content[0].type === content.type
      ) {
        previous.content.push(content);
      } else {
        blocks.push({ start, content: [content] });
      }
    });
    if (!textContent.trim() && displayText.trim()) {
      blocks.push({
        start: message.content.length,
        content: [{ type: 'text', text: displayText }],
      });
    }
    return blocks;
  }, [message.content, textContent, displayText]);
  const textBlockCount = contentBlocks.filter((block) => block.content[0].type === 'text').length;
  const streamRenderProbe = useRef({ messageId: '', lastAt: 0, updates: 0, active: false });
  const displayUnits = displayText.length;
  useEffect(() => {
    // Development E2E probe: React committed this text, not proof of screen paint.
    // Sample progress at most once per second; first and final commits are immediate.
    if (
      !import.meta.env.DEV ||
      message.role !== 'assistant' ||
      !message.id ||
      !message.metadata.userVisible
    )
      return;
    if (streamRenderProbe.current.messageId !== message.id) {
      streamRenderProbe.current = { messageId: message.id, lastAt: 0, updates: 0, active: false };
    }
    const probe = streamRenderProbe.current;
    if ((!isStreaming && !probe.active) || (isStreaming && !displayUnits)) return;
    probe.active = isStreaming;
    probe.updates += 1;
    const now = window.performance.now();
    if (isStreaming && probe.lastAt && now - probe.lastAt < 1000) return;
    probe.lastAt = now;
    try {
      window.electron.logInfo(
        JSON.stringify({
          tag: 'stream_timing',
          stage: 'ui_text_committed',
          at_ms: Date.now(),
          session_id: sessionId,
          message_id: message.id,
          utf16_units: displayUnits,
          text_updates: probe.updates,
          streaming: isStreaming,
          document_visibility: document.visibilityState,
          text_mounted: !!contentRef.current,
        })
      );
    } catch {
      /* Diagnostics must not affect rendering. */
    }
  }, [
    displayUnits,
    isStreaming,
    message.id,
    message.metadata.userVisible,
    message.role,
    sessionId,
  ]);
  const terminalPresentation = turnTerminal ? codeProTerminalPresentation(turnTerminal) : undefined;
  const terminalCopyText = useMemo(
    () => (turnTerminal ? resolveAssistantCopyText(displayText, turnTerminal, messages) : ''),
    [displayText, messages, turnTerminal]
  );

  const timestamp = useMemo(() => formatMessageTimestamp(message.created), [message.created]);
  const toolRequests = getToolRequests(message);
  const messageIndex = messages.findIndex((msg) => msg.id === message.id);
  const initialThinking = useMemo(() => {
    if (!thinkingContent || messageIndex < 0) return false;
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const prior = messages[index];
      if (isRetryableUserMessage(prior)) break;
      if (!prior.metadata.userVisible) continue;
      if (
        getThinkingContent(prior) ||
        getToolRequests(prior).length > 0 ||
        getTextAndImageContent(prior).textContent.trim()
      )
        return false;
    }
    return true;
  }, [messageIndex, messages, thinkingContent]);
  const retrySource = useMemo(() => {
    if (messageIndex <= 0) return undefined;
    if (turnTerminal?.source_user_message_id) {
      return messages.find(
        (candidate) =>
          candidate.id === turnTerminal.source_user_message_id && isRetryableUserMessage(candidate)
      );
    }
    return [...messages.slice(0, messageIndex)].reverse().find(isRetryableUserMessage);
  }, [messageIndex, messages, turnTerminal?.source_user_message_id]);
  const supersededByTurnTerminal = useMemo(
    () => isTurnTerminalSuperseded(message, messages),
    [message, messages]
  );
  const actionPolicy = getAssistantMessageActionPolicy({
    displayText,
    isStreaming,
    superseded: supersededByTurnTerminal,
    terminal: turnTerminal,
  });
  const showMessageActions = actionPolicy.showActionGroup;
  const showTextMessageActions = actionPolicy.showTextActionGroup;
  const retryMode = actionPolicy.retryMode;
  const retryMessage =
    onRetryMessage && message.id
      ? retryMode === 'none'
        ? undefined
        : retryMode === 'continue'
          ? () => onRetryMessage(message.id!, '继续执行', 'continue')
          : retryMode === 'retry_validation'
            ? () => onRetryMessage(message.id!, '重新运行失败验证', 'retry_validation')
            : retryMode === 'replay' && retrySource
              ? () =>
                  onRetryMessage(
                    message.id!,
                    getTextAndImageContent(retrySource).textContent,
                    'replay'
                  )
              : retryMode === 'resubmit' && retrySource
                ? () =>
                    onRetryMessage(
                      retrySource.id!,
                      getTextAndImageContent(retrySource).textContent,
                      'retry'
                    )
                : undefined
      : undefined;
  const toolConfirmationContent = getToolConfirmationContent(message);
  const elicitationContent = getElicitationContent(message);

  const findConfirmationForToolAcrossMessages = (
    toolRequestId: string
  ): ToolConfirmationData | undefined => {
    for (const msg of messages) {
      const confirmationData = getAnyToolConfirmationData(msg);
      if (confirmationData && confirmationData.id === toolRequestId) {
        return confirmationData;
      }
    }
    return undefined;
  };
  const toolCallChains = useMemo(
    () => toolChains ?? identifyConsecutiveToolCalls(messages),
    [toolChains, messages]
  );
  const hideTimestamp = useMemo(
    () => shouldHideTimestamp(messageIndex, toolCallChains),
    [messageIndex, toolCallChains]
  );
  const hasToolConfirmation = toolConfirmationContent !== undefined;
  const hasElicitation = elicitationContent !== undefined;
  const elicitationData =
    elicitationContent?.data.actionType === 'elicitation'
      ? (elicitationContent.data as typeof elicitationContent.data & {
          isSubmitted?: boolean;
          isCancelled?: boolean;
        })
      : undefined;

  const toolConfirmationShownInline = useMemo(() => {
    if (!toolConfirmationContent) return false;
    const confirmationData = getAnyToolConfirmationData(message);
    if (!confirmationData) return false;

    for (const msg of messages) {
      const requests = getToolRequests(msg);
      if (requests.some((req) => req.id === confirmationData.id)) {
        return true;
      }
    }
    return false;
  }, [toolConfirmationContent, message, messages]);

  const toolResponsesMap = useMemo(() => {
    const responseMap = new Map();

    if (toolResponses) {
      for (const request of toolRequests) {
        const response = toolResponses.get(request.id);
        if (response) responseMap.set(request.id, response);
      }
    } else if (messageIndex !== undefined && messageIndex >= 0) {
      for (let i = messageIndex + 1; i < messages.length; i++) {
        const responses = getToolResponses(messages[i]);

        for (const response of responses) {
          const matchingRequest = toolRequests.find((req) => req.id === response.id);
          if (matchingRequest) {
            responseMap.set(response.id, response);
          }
        }
      }
    }

    return responseMap;
  }, [messages, messageIndex, toolRequests, toolResponses]);

  const pendingConfirmationIds = getPendingToolConfirmationIds(messages);

  return (
    <div
      data-live-message={compactTools && isStreaming ? '' : undefined}
      className={cn(
        'goose-message flex justify-start min-w-0',
        compactTools ? 'w-full max-w-[52rem]' : 'w-[90%]',
        compactTools &&
          !displayText.trim() &&
          imagePaths.length === 0 &&
          !hasElicitation &&
          !toolConfirmationContent &&
          !turnTerminal &&
          (toolRequests.length > 0 || thinkingContent) &&
          'codepro-process-record'
      )}
    >
      <div className="flex flex-col w-full min-w-0">
        {contentBlocks.map((block, index) => {
          const content = block.content[0];
          const key = `${content.type}-${block.start}`;
          if (content.type === 'thinking') {
            if (providerThinkingSuppressed) return null;
            const active = thinkingActive && index === contentBlocks.length - 1;
            return (
              <ThinkingContent
                key={key}
                content={getThinkingContent({ ...message, content: block.content }) ?? ''}
                isStreaming={active}
                storageKey={
                  message.id
                    ? `provider-${message.id}${block.start === 0 ? '' : `-${block.start}`}`
                    : undefined
                }
                isExpanded={active && initialThinking && index === 0}
              />
            );
          }
          if (content.type === 'text') {
            const text = getTextAndImageContent({ ...message, content: block.content }).textContent;
            return text.trim() ? (
              <div key={key} ref={contentRef} className="w-full" aria-busy={isStreaming}>
                <MarkdownContent
                  content={text}
                  animateIncoming={isStreaming}
                  className="codepro-assistant-prose codepro-stream-prose"
                />
              </div>
            ) : null;
          }
          if (content.type === 'image') {
            return (
              <div key={key} className="mt-4">
                <ImagePreview src={`data:${content.mimeType};base64,${content.data}`} />
              </div>
            );
          }
          if (content.type === 'toolRequest') {
            const toolRequest = content;
            const hasResponse = toolResponsesMap.has(toolRequest.id);
            const isPending = pendingConfirmationIds.has(toolRequest.id);
            const confirmationContent = findConfirmationForToolAcrossMessages(toolRequest.id);
            const isApprovalClicked = confirmationContent && !isPending && hasResponse;
            return (
              <div className="goose-message-tool mt-1" key={key}>
                <ToolCallWithResponse
                  planActive={activePlanRequestId === toolRequest.id}
                  compact={compactTools}
                  sessionId={sessionId}
                  isCancelledMessage={false}
                  toolRequest={toolRequest}
                  toolResponse={toolResponsesMap.get(toolRequest.id)}
                  notifications={toolCallNotifications.get(toolRequest.id)}
                  isStreamingMessage={
                    activeToolCallIds ? activeToolCallIds.includes(toolRequest.id) : isStreaming
                  }
                  isPendingApproval={isPending}
                  append={append}
                  confirmationContent={confirmationContent}
                  isApprovalClicked={isApprovalClicked}
                />
              </div>
            );
          }
          return null;
        })}

        {(displayText.trim() || imagePaths.length > 0) && (
          <div className="flex min-h-6 items-center justify-between gap-3 pt-1">
            {!isStreaming && (
              <div className="text-xs font-mono text-text-secondary">{timestamp}</div>
            )}
            {!isTurnRunning && !isStreaming && (
              <div className="codepro-message-actions ml-auto flex items-center gap-3">
                {(showTextMessageActions || (plainTerminal && showMessageActions)) && (
                  <MessageCopyLink
                    text={displayText}
                    contentRef={textBlockCount > 1 ? plainTextCopyRef : contentRef}
                    onRetry={retryMessage}
                    alwaysVisible
                  />
                )}
                {message.metadata.usage && (
                  <MessageUsageStats usage={message.metadata.usage} compact={compactTools} />
                )}
              </div>
            )}
          </div>
        )}
        {toolRequests.length > 0 && !compactTools && !displayText.trim() && (
          <div className="flex items-center justify-between">
            <div
              className={cn(
                'text-xs text-text-secondary pt-1',
                message.metadata.usage &&
                  'transition-all duration-200 group-hover:-translate-y-4 group-hover:opacity-0'
              )}
            >
              {!isStreaming && !hideTimestamp && timestamp}
            </div>
            {!isStreaming && message.metadata.usage && (
              <div className="pt-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <MessageUsageStats usage={message.metadata.usage} compact={compactTools} />
              </div>
            )}
          </div>
        )}

        {priorAnswerText && !textContent.trim() && (
          <div role="status" className="mt-2 text-xs text-text-secondary">
            {intl.formatMessage(i18n.pausedStatus)}
          </div>
        )}

        {turnTerminal &&
          terminalPresentation?.summaryStatus !== 'completed' &&
          terminalPresentation &&
          !plainTerminal && (
            <div
              ref={contentRef}
              role="status"
              className="group mt-2 rounded-lg border border-border-subtle bg-background-subtle px-3 py-2"
            >
              <div className="font-medium text-text-primary">
                {formatCodeProSummaryStatus(intl, terminalPresentation.summaryStatus)}
              </div>
              <div className="text-sm text-text-secondary">
                <span className="font-semibold text-text-primary">
                  {formatCodeProTerminalVerdict(intl, terminalPresentation.verdict)}
                </span>
                {terminalPresentation.verdict === 'BLOCKED' && (
                  <span>
                    {' · '}
                    {intl.formatMessage(i18n.turnStoppedSummary, {
                      count: turnTerminal.tool_action_count,
                    })}
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="text-xs font-mono text-text-secondary">{timestamp}</div>
                {showMessageActions && (
                  <MessageCopyLink
                    text={terminalCopyText}
                    contentRef={contentRef}
                    onRetry={retryMessage}
                    alwaysVisible
                  />
                )}
              </div>
            </div>
          )}

        {hasToolConfirmation && !toolConfirmationShownInline && (
          <ToolCallConfirmation
            sessionId={sessionId}
            isClicked={false}
            actionRequiredContent={toolConfirmationContent}
          />
        )}

        {hasElicitation && submitElicitationResponse && (
          <ElicitationRequest
            isCancelledMessage={elicitationData?.isCancelled === true}
            isClicked={elicitationData?.isSubmitted === true}
            actionRequiredContent={elicitationContent}
            onSubmit={submitElicitationResponse}
          />
        )}
      </div>
    </div>
  );
}
