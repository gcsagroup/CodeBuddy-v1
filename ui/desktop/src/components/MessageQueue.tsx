import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GripVertical, Pencil, Trash2, Send, LoaderCircle } from 'lucide-react';
import { Button } from './ui/button';
import type { ImageData } from '../types/message';
import { defineMessages, useIntl } from '../i18n';
import { isLargeText, useCompactTextInput } from './pastedText';
import { PastedTextPreview } from './PastedTextPreview';
import { followUpMessages } from './followUpMessages';

const queuePreview = (text: string) => isLargeText(text) ? text.slice(0, 160) + '…' : text;
const i18n = defineMessages({
  prioritySend: { id: 'messageQueue.prioritySend', defaultMessage: 'Send sooner' },
  prioritySendHint: { id: 'messageQueue.prioritySendHint', defaultMessage: 'Send when the current action finishes, without interrupting the task.' },
  edit: { id: 'messageQueue.edit', defaultMessage: 'Edit message' },
  attachments: { id: 'messageQueue.attachments', defaultMessage: '{count, plural, one {# image} other {# images}}' },
  save: { id: 'messageQueue.save', defaultMessage: 'Save' },
  cancel: { id: 'messageQueue.cancel', defaultMessage: 'Cancel' },
  removeFromQueue: { id: 'messageQueue.removeFromQueue', defaultMessage: 'Remove this message from queue' },
  nativeWaiting: { id: 'messageQueue.nativeWaiting', defaultMessage: 'Already received by the task; send a new message to continue processing.' },
  verifyDelivery: { id: 'messageQueue.verifyDelivery', defaultMessage: 'Sending result unknown. Check the conversation before retrying.' },
  checkAndRequeue: { id: 'messageQueue.checkAndRequeue', defaultMessage: 'Check sending status and requeue' },
});

export interface QueuedMessage {
  localOnly?: true;
  attachmentCount?: number;
  deliveryTarget?: 'next-step';
  deliveryState?: 'pending' | 'dispatching' | 'admitted' | 'uncertain';
  admitted?: boolean;
  queuedWhileBusy?: true;
  id: string;
  content: string;
  timestamp: number;
  desktopGeneration?: string;
  images: ImageData[];
  delivery?: 'pending' | 'submitting';
  presentation?: { afterMessageId: string };
}
interface MessageQueueProps {
  operationPending?: boolean;
  onBeginEdit?: (id: string) => Promise<boolean>;
  onConfirmNotSent?: (id: string) => void;
  queuedMessages: QueuedMessage[];
  onRemoveMessage: (id: string) => void;
  onClearQueue?: () => void;
  onSendNow?: () => void;
  onSteerMessage?: (id: string) => void;
  onEditMessage?: (id: string, content: string) => void | boolean | Promise<boolean>;
  editingMessageIdRef?: React.MutableRefObject<string | null>;
  onReorderMessages?: (messages: QueuedMessage[]) => void;
  sendingMessageIds?: ReadonlySet<string>;
  waitingMessageId?: string | null;
  className?: string;
  isPaused?: boolean;
  isBusy?: boolean;
  hasActiveRun?: boolean;
  blockedReason?: string;
}

export const MessageQueue: React.FC<MessageQueueProps> = ({
  operationPending = false, onBeginEdit, onConfirmNotSent, queuedMessages, onRemoveMessage,
  onSteerMessage, onEditMessage, editingMessageIdRef, onReorderMessages,
  sendingMessageIds, waitingMessageId, className = '', isPaused = false, isBusy = false,
  hasActiveRun = isBusy, blockedReason,
}) => {
  const intl = useIntl();
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [openingMessage, setOpeningMessage] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const compactEdit = useCompactTextInput(editContent);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const followingEnd = useRef(true);
  const latestMessages = useRef(queuedMessages);
  latestMessages.current = queuedMessages;
  const editRequest = useRef(0);
  const previousEditor = useRef<string | null>(null);
  useEffect(() => () => { editRequest.current++; }, []);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && followingEnd.current && !editingMessage) list.scrollTop = list.scrollHeight;
  }, [queuedMessages[queuedMessages.length - 1]?.id, queuedMessages.length, editingMessage]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!editingMessage && previousEditor.current) {
      const trigger = [...(list?.querySelectorAll<HTMLButtonElement>('[data-queue-edit-trigger]') ?? [])]
        .find(button => button.dataset.queueEditTrigger === previousEditor.current);
      trigger?.focus({ preventScroll: true });
    }
    previousEditor.current = editingMessage;
    if (!editingMessage || !editorRef.current || !list) return;
    editorRef.current.focus({ preventScroll: true });
    const row = editorRef.current.closest('[data-queue-row]')?.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    if (row && row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
    else if (row && row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
  }, [editingMessage]);
  useEffect(() => {
    if (editingMessage && !queuedMessages.some(message => message.id === editingMessage)) {
      setEditingMessage(null); setEditContent('');
      if (editingMessageIdRef?.current === editingMessage) editingMessageIdRef.current = null;
    }
  }, [queuedMessages, editingMessage, editingMessageIdRef]);

  const isUncertain = (message: QueuedMessage) => message.localOnly ? false : message.deliveryState !== undefined
    ? message.deliveryState === 'uncertain'
    : message.delivery === 'submitting' && !message.admitted && !sendingMessageIds?.has(message.id);
  const isSending = (message: QueuedMessage) => Boolean(message.localOnly || sendingMessageIds?.has(message.id) || message.delivery === 'submitting');
  const hasUncertain = queuedMessages.some(isUncertain);
  const hasSubmission = queuedMessages.some(message => sendingMessageIds?.has(message.id));
  const draftMode = isPaused && !waitingMessageId && !hasSubmission && !hasUncertain;
  const locked = operationPending || !!editingMessage || !!openingMessage;
  const finishEditing = async (save: boolean) => {
    if (operationPending) return;
    if (save && editingMessage && await onEditMessage?.(editingMessage, editContent) === false) return;
    setEditingMessage(null); setEditContent('');
    if (editingMessageIdRef) editingMessageIdRef.current = null;
  };
  const edit = (message: QueuedMessage) => {
    if (locked || isSending(message) || isUncertain(message) || waitingMessageId === message.id || !onEditMessage) return;
    const open = () => {
      if (editingMessageIdRef) editingMessageIdRef.current = message.id;
      setEditContent(message.content); setEditingMessage(message.id);
    };
    if (!onBeginEdit) { open(); return; }
    const request = ++editRequest.current;
    setOpeningMessage(message.id);
    void onBeginEdit(message.id).then(accepted => {
      if (request === editRequest.current && accepted && latestMessages.current.some(row => row.id === message.id)) open();
    }, () => {}).finally(() => {
      if (request === editRequest.current) setOpeningMessage(null);
    });
  };
  if (!queuedMessages.length) return null;

  return (
    <div className={'relative min-w-0 ' + className} data-testid={draftMode ? 'saved-message-drafts' : 'message-queue'}>
      <div ref={listRef} data-testid="queue-message-list"
        className={'overflow-y-auto overscroll-contain p-1 ' + (editingMessage ? 'max-h-[min(12rem,35vh)]' : 'max-h-[min(6.5rem,20vh)]')}
        onScroll={event => {
          const list = event.currentTarget;
          followingEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 8;
        }}>
        {queuedMessages.map(message => {
          const unknown = isUncertain(message);
          const sending = isSending(message);
          const canDrag = !!onReorderMessages && !locked && !sending && !hasUncertain;
          const sendDisabled = locked || (hasActiveRun && hasSubmission) || !!waitingMessageId ||
            (unknown ? hasActiveRun || !onConfirmNotSent : sending || !onSteerMessage);
          return (
            <div key={message.id} data-queue-row={message.id}
              className="group rounded-lg text-sm text-text-primary hover:bg-background-primary focus-within:bg-background-primary"
              onDragStart={event => {
                if (!canDrag || !(event.target instanceof Element) || !event.target.closest('[data-queue-drag-handle]')) return;
                setDraggedItem(message.id); event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={event => { if (canDrag && draggedItem) event.preventDefault(); }}
              onDragEnd={() => setDraggedItem(null)}
              onDrop={event => {
                event.preventDefault();
                if (!canDrag || !draggedItem || !onReorderMessages) return;
                const from = queuedMessages.findIndex(row => row.id === draggedItem);
                const to = queuedMessages.findIndex(row => row.id === message.id);
                if (from >= 0 && to >= 0 && from !== to) {
                  const reordered = [...queuedMessages], [moved] = reordered.splice(from, 1);
                  reordered.splice(to, 0, moved); onReorderMessages(reordered);
                }
                setDraggedItem(null);
              }}>
              <div className={'flex min-h-8 min-w-0 gap-1 px-1 ' + (editingMessage === message.id ? 'items-start py-1' : 'items-center')}>
                <span aria-hidden="true" data-queue-drag-handle draggable={canDrag} className={'flex h-7 w-4 shrink-0 items-center justify-center text-text-secondary ' + (canDrag ? 'cursor-grab active:cursor-grabbing' : 'opacity-50')}>
                  <GripVertical className="size-3" strokeWidth={1.6} />
                </span>
                {editingMessage === message.id ? (
                  <div className="min-w-0 flex-1 space-y-1">
                    {compactEdit.prefix && <PastedTextPreview text={compactEdit.prefix} onRemove={() => {
                      compactEdit.collapse(''); setEditContent(compactEdit.editorValue);
                    }} />}
                    <textarea ref={editorRef} aria-label={intl.formatMessage(i18n.edit)} readOnly={operationPending}
                      className="block h-16 w-full resize-none overflow-y-auto rounded-md border border-border-primary bg-background-primary px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                      rows={2} value={compactEdit.editorValue}
                      onChange={event => setEditContent(compactEdit.prefix + event.target.value)}
                      onKeyDown={event => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === 'Escape' || event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                          event.preventDefault(); void finishEditing(event.key === 'Enter');
                        }
                      }} />
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={operationPending} onClick={() => { void finishEditing(true); }}>{intl.formatMessage(i18n.save)}</Button>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={operationPending} onClick={() => { void finishEditing(false); }}>{intl.formatMessage(i18n.cancel)}</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate leading-5" title={queuePreview(message.content)}>
                      {queuePreview(message.content) || intl.formatMessage(i18n.attachments, { count: message.attachmentCount ?? message.images.length })}
                      {message.content && (message.attachmentCount ?? message.images.length) > 0 && <span className="ml-1 text-xs text-text-secondary"> · {intl.formatMessage(followUpMessages.attachments, {count: message.attachmentCount ?? message.images.length})}</span>}
                    </span>
                    <div className="flex shrink-0 items-center">
                      <Button type="button" variant="ghost" size="sm" className="size-7 shrink-0 p-0 text-text-secondary hover:text-text-primary"
                        title={intl.formatMessage(unknown ? i18n.checkAndRequeue : i18n.prioritySendHint)}
                        aria-label={intl.formatMessage(unknown ? i18n.checkAndRequeue : i18n.prioritySend)}
                        disabled={sendDisabled}
                        onClick={() => unknown ? onConfirmNotSent?.(message.id) : onSteerMessage?.(message.id)}>
                        {sending && !unknown ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Send aria-hidden="true" className="size-3.5" strokeWidth={1.6} />}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="size-7 shrink-0 p-0 text-text-secondary hover:text-text-primary"
                        data-queue-edit-trigger={message.id}
                        title={intl.formatMessage(i18n.edit)} aria-label={intl.formatMessage(i18n.edit)}
                        disabled={locked || sending || unknown || !onEditMessage || waitingMessageId === message.id}
                        onClick={() => edit(message)}>
                        {openingMessage === message.id ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Pencil aria-hidden="true" className="size-3.5" strokeWidth={1.6} />}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="size-7 shrink-0 p-0 text-text-secondary hover:text-text-primary"
                        title={intl.formatMessage(i18n.removeFromQueue)} aria-label={intl.formatMessage(i18n.removeFromQueue)}
                        disabled={locked || sending || unknown} onClick={() => onRemoveMessage(message.id)}>
                        <Trash2 aria-hidden="true" className="size-3.5" strokeWidth={1.6} />
                      </Button>
                    </div>
                  </>
                )}
              </div>
              {(unknown || message.admitted || waitingMessageId === message.id && blockedReason) && (
                <p role="status" className="px-6 pb-1 text-xs text-text-secondary">
                  {unknown ? intl.formatMessage(i18n.verifyDelivery) : message.admitted
                    ? intl.formatMessage(!hasActiveRun && message.deliveryTarget === 'next-step' ? i18n.nativeWaiting : followUpMessages.admitted) : blockedReason}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
export default MessageQueue;
