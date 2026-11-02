import React, { useEffect, useState } from 'react';
import { X, Send, GripVertical, LoaderCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from './ui/button';
import type { ImageData } from '../types/message';
import { defineMessages, useIntl } from '../i18n';

const i18n = defineMessages({
  savedDrafts: {
    id: 'messageQueue.savedDrafts',
    defaultMessage: '{count, plural, one {# saved draft} other {# saved drafts}}',
  },
  expandDrafts: {
    id: 'messageQueue.expandDrafts',
    defaultMessage: 'Expand saved drafts',
  },
  collapseDrafts: {
    id: 'messageQueue.collapseDrafts',
    defaultMessage: 'Collapse saved drafts',
  },
  sendDrafts: { id: 'messageQueue.sendDrafts', defaultMessage: 'Send saved drafts' },
  pending: { id: 'messageQueue.pending', defaultMessage: 'Waiting to send' },
  sendNow: { id: 'messageQueue.sendNow', defaultMessage: 'Send now' },
  sendAllNow: { id: 'messageQueue.sendAllNow', defaultMessage: 'Send all now' },
  sendTogether: {
    id: 'messageQueue.sendTogether',
    defaultMessage: 'Send all waiting messages together now',
  },
  expandQueue: { id: 'messageQueue.expandQueue', defaultMessage: 'Expand queue' },
  collapseQueue: { id: 'messageQueue.collapseQueue', defaultMessage: 'Collapse queue' },
  continueSending: {
    id: 'messageQueue.continueSending',
    defaultMessage: 'Messages kept. Send now when you are ready.',
  },
  messageCount: {
    id: 'messageQueue.messageCount',
    defaultMessage: '{count, plural, one {# message} other {# messages}} {status}',
  },
  queued: { id: 'messageQueue.queued', defaultMessage: 'queued' },
  clearAll: { id: 'messageQueue.clearAll', defaultMessage: 'Clear All' },
  save: { id: 'messageQueue.save', defaultMessage: 'Save' },
  cancel: { id: 'messageQueue.cancel', defaultMessage: 'Cancel' },
  clickToEdit: { id: 'messageQueue.clickToEdit', defaultMessage: '{content} (Click to edit)' },
  cannotSendWhileEditing: {
    id: 'messageQueue.cannotSendWhileEditing',
    defaultMessage: 'Cannot send while editing',
  },
  removeFromQueue: {
    id: 'messageQueue.removeFromQueue',
    defaultMessage: 'Remove this message from queue',
  },
});

export interface QueuedMessage {
  id: string;
  content: string;
  timestamp: number;
  desktopGeneration?: string;
  images: ImageData[];
  delivery?: 'pending' | 'submitting';
  presentation?: { afterMessageId: string };
}

interface MessageQueueProps {
  onConfirmNotSent?: (id: string) => void;
  queuedMessages: QueuedMessage[];
  onRemoveMessage: (id: string) => void;
  onClearQueue: () => void;
  onSendNow?: () => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onTriggerQueueProcessing?: () => void;
  editingMessageIdRef?: React.MutableRefObject<string | null>;
  onReorderMessages?: (reorderedMessages: QueuedMessage[]) => void;
  sendingMessageIds?: ReadonlySet<string>;
  waitingMessageId?: string | null;
  className?: string;
  isPaused?: boolean;
  isBusy?: boolean;
  blockedReason?: string;
}

export const MessageQueue: React.FC<MessageQueueProps> = ({
  onConfirmNotSent,
  queuedMessages,
  onRemoveMessage,
  onClearQueue,
  onSendNow,
  onEditMessage,
  onTriggerQueueProcessing,
  editingMessageIdRef,
  onReorderMessages,
  sendingMessageIds,
  waitingMessageId,
  className = '',
  isPaused = false,
  isBusy = false,
  blockedReason,
}) => {
  const intl = useIntl();
  const [isExpanded, setIsExpanded] = useState(false);
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const hasUncertainDelivery = queuedMessages.some(
    (message) => message.delivery === 'submitting' && !sendingMessageIds?.has(message.id)
  );
  const hasActiveSubmission = queuedMessages.some((message) => sendingMessageIds?.has(message.id));
  const isDraftMode =
    isPaused && !waitingMessageId && !hasActiveSubmission && !hasUncertainDelivery;
  // Stop and cold restore preserve the queue as drafts, not an active steer.
  // Do not hide unresolved deliveries behind this collapsed presentation.
  useEffect(() => {
    setIsExpanded(false);
  }, [isDraftMode]);
  useEffect(() => {
    if (queuedMessages.length < 2) setIsExpanded(false);
  }, [queuedMessages.length]);
  useEffect(() => {
    if (editingMessage && !queuedMessages.some((message) => message.id === editingMessage)) {
      setEditingMessage(null);
      setEditContent('');
      if (editingMessageIdRef?.current === editingMessage) editingMessageIdRef.current = null;
    }
  }, [queuedMessages, editingMessage, editingMessageIdRef]);
  if (queuedMessages.length === 0) return null;

  const isSending = (message: QueuedMessage) =>
    Boolean(sendingMessageIds?.has(message.id) || message.delivery === 'submitting');
  const pendingCount = queuedMessages.filter((message) => !isSending(message)).length;
  // Unknown delivery must keep its reconciliation controls visible, so it
  // must not advertise a collapsed list while already showing every entry.
  const canExpand = (queuedMessages.length > 1 || isDraftMode) && !hasUncertainDelivery;
  const expanded = canExpand && isExpanded;
  const showList = expanded || hasUncertainDelivery || editingMessage !== null;
  const waiting = Boolean(waitingMessageId);
  const nextMessage = queuedMessages[0];
  const hasSending = queuedMessages.some(isSending);
  const sendLabel = isDraftMode
    ? i18n.sendDrafts
    : pendingCount > 1
      ? i18n.sendAllNow
      : i18n.sendNow;
  const finishEditing = (save: boolean) => {
    if (save && editingMessage) onEditMessage?.(editingMessage, editContent);
    setEditingMessage(null);
    if (editingMessageIdRef) editingMessageIdRef.current = null;
    setEditContent('');
    onTriggerQueueProcessing?.();
  };
  const edit = (message: QueuedMessage) => {
    if (isSending(message) || !onEditMessage) return;
    if (editingMessageIdRef) editingMessageIdRef.current = message.id;
    setEditContent(message.content);
    setEditingMessage(message.id);
  };

  return (
    <div
      className={`relative ${className}`}
      data-testid={isDraftMode ? 'saved-message-drafts' : 'message-queue'}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs text-text-secondary">
        {canExpand ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-text-primary"
            aria-label={intl.formatMessage(
              isDraftMode
                ? expanded
                  ? i18n.collapseDrafts
                  : i18n.expandDrafts
                : expanded
                  ? i18n.collapseQueue
                  : i18n.expandQueue
            )}
            aria-expanded={expanded}
            title={nextMessage.content}
            onClick={() => setIsExpanded(!expanded)}
          >
            <span className="shrink-0">
              {isDraftMode
                ? intl.formatMessage(i18n.savedDrafts, { count: queuedMessages.length })
                : intl.formatMessage(i18n.messageCount, {
                    count: queuedMessages.length,
                    status: intl.formatMessage(i18n.queued),
                  })}
            </span>
            {!showList && !isDraftMode && (
              <span className="min-w-0 truncate">{nextMessage.content}</span>
            )}
            {expanded ? (
              <ChevronUp className="size-3 shrink-0" />
            ) : (
              <ChevronDown className="size-3 shrink-0" />
            )}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0">
              {queuedMessages.length > 1
                ? intl.formatMessage(i18n.messageCount, {
                    count: queuedMessages.length,
                    status: intl.formatMessage(i18n.queued),
                  })
                : intl.formatMessage(i18n.pending)}
            </span>
            {!showList && (
              <button
                type="button"
                className="min-w-0 truncate text-left hover:text-text-primary"
                title={intl.formatMessage(i18n.clickToEdit, { content: nextMessage.content })}
                onClick={() => edit(nextMessage)}
              >
                {nextMessage.content}
              </button>
            )}
          </div>
        )}
        {onSendNow && (!isDraftMode || expanded) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs text-text-secondary hover:text-text-primary"
            title={intl.formatMessage(
              editingMessage
                ? i18n.cannotSendWhileEditing
                : isDraftMode
                  ? i18n.sendTogether
                  : isBusy
                    ? i18n.sendNow
                    : i18n.sendTogether
            )}
            disabled={
              Boolean(editingMessage) || pendingCount === 0 || waiting || (isDraftMode && isBusy)
            }
            aria-label={intl.formatMessage(sendLabel)}
            aria-busy={waiting || hasActiveSubmission}
            onClick={() => onSendNow()}
          >
            {intl.formatMessage(sendLabel)}
            {waiting || hasActiveSubmission ? (
              <LoaderCircle className="size-3 animate-spin" aria-label={blockedReason} />
            ) : (
              <Send className="size-3" aria-hidden="true" />
            )}
          </Button>
        )}
        {!showList && !canExpand && (
          <Button
            variant="ghost"
            size="sm"
            className="size-6 shrink-0 p-0 text-text-secondary"
            title={intl.formatMessage(i18n.removeFromQueue)}
            disabled={isSending(nextMessage)}
            onClick={() => onRemoveMessage(nextMessage.id)}
          >
            <X className="size-3" />
          </Button>
        )}
        {expanded && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs text-text-secondary"
            disabled={hasSending}
            onClick={onClearQueue}
          >
            {intl.formatMessage(i18n.clearAll)}
          </Button>
        )}
      </div>
      {!isDraftMode && (blockedReason || (isPaused && !waiting && !hasUncertainDelivery)) && (
        <p role="status" className="px-3 pb-2 text-xs text-text-secondary">
          {blockedReason ?? intl.formatMessage(i18n.continueSending)}
        </p>
      )}
      {showList && (
        <div className="max-h-72 overflow-y-auto px-3 pb-2">
          {queuedMessages.map((message) => (
            <div
              key={message.id}
              className="group py-2 text-sm text-text-primary"
              draggable={Boolean(onReorderMessages && !isSending(message) && !editingMessage)}
              onDragStart={(event) => {
                setDraggedItem(message.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (!isSending(message) && draggedItem) event.preventDefault();
              }}
              onDragEnd={() => setDraggedItem(null)}
              onDrop={(event) => {
                event.preventDefault();
                if (!draggedItem || !onReorderMessages || isSending(message)) return;
                const from = queuedMessages.findIndex((item) => item.id === draggedItem);
                const to = queuedMessages.findIndex((item) => item.id === message.id);
                if (from >= 0 && to >= 0 && from !== to) {
                  const reordered = [...queuedMessages];
                  const [moved] = reordered.splice(from, 1);
                  reordered.splice(to, 0, moved);
                  onReorderMessages(reordered);
                }
                setDraggedItem(null);
              }}
            >
              <div className="flex items-start gap-2">
                {onReorderMessages && !isSending(message) && (
                  <GripVertical className="mt-1 size-3 shrink-0 cursor-grab text-text-secondary opacity-0 group-hover:opacity-70" />
                )}
                {editingMessage === message.id ? (
                  <div className="min-w-0 flex-1 space-y-2">
                    <textarea
                      autoFocus
                      rows={3}
                      className="w-full resize-y rounded-md border border-border-primary bg-background-primary px-2 py-1 text-sm"
                      value={editContent}
                      onChange={(event) => setEditContent(event.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => finishEditing(true)}
                      >
                        {intl.formatMessage(i18n.save)}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => finishEditing(false)}
                      >
                        {intl.formatMessage(i18n.cancel)}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={isSending(message)}
                    className="min-w-0 flex-1 whitespace-pre-wrap break-words text-left leading-5"
                    title={intl.formatMessage(i18n.clickToEdit, { content: message.content })}
                    onClick={() => edit(message)}
                  >
                    {message.content}
                  </button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-6 shrink-0 p-0 text-text-secondary"
                  title={intl.formatMessage(i18n.removeFromQueue)}
                  disabled={isSending(message)}
                  onClick={() => onRemoveMessage(message.id)}
                >
                  <X className="size-3" />
                </Button>
              </div>
              {message.delivery === 'submitting' && !sendingMessageIds?.has(message.id) && (
                <div className="mt-2 space-y-2 text-xs text-text-secondary" role="status">
                  <p>
                    {intl.formatMessage({
                      id: 'messageQueue.verifyDelivery',
                      defaultMessage:
                        'Sending result unknown. Check the conversation before retrying.',
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => onRemoveMessage(message.id)}>
                      {intl.formatMessage({
                        id: 'messageQueue.confirmSent',
                        defaultMessage: 'Confirmed sent: remove',
                      })}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onConfirmNotSent?.(message.id)}
                    >
                      {intl.formatMessage({
                        id: 'messageQueue.confirmNotSent',
                        defaultMessage: 'Confirmed not sent: queue again',
                      })}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
export default MessageQueue;
