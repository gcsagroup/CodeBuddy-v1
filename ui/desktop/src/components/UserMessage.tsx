import { Clock3, ChevronDown, X } from 'lucide-react';
import { nativeScheduleMessages } from './schedule/nativeScheduleMessages';
import { useCallback, useEffect, useRef, useState } from 'react';
import ImagePreview from './ImagePreview';
import MarkdownContent from './MarkdownContent';
import { getTextAndImageContent, type Message } from '../types/message';
import MessageCopyLink from './MessageCopyLink';
import { formatMessageTimestamp } from '../utils/timeUtils';
import Edit from './icons/Edit';
import { Button } from './ui/button';
import { defineMessages, useIntl } from '../i18n';
import type { MessageEditType } from '../types/turnTerminal';
import type { SessionType } from '../types/session';
import { isLargeText, useCompactTextInput } from './pastedText';
import { PastedTextPreview } from './PastedTextPreview';

const i18n = defineMessages({
  removeEditedImage: { id: 'userMessage.removeEditedImage', defaultMessage: 'Remove image {number} from this resend' },
  pending: { id: 'userMessage.pending', defaultMessage: 'Waiting to send' },
  unconfirmed: { id: 'userMessage.unconfirmed', defaultMessage: 'Awaiting confirmation' },
  editPlaceholder: {
    id: 'userMessage.editPlaceholder',
    defaultMessage: 'Edit your message...',
  },
  editAriaLabel: {
    id: 'userMessage.editAriaLabel',
    defaultMessage: 'Edit message content',
  },
  emptyError: {
    id: 'userMessage.emptyError',
    defaultMessage: 'Message cannot be empty',
  },
  editInPlaceDescription: {
    id: 'userMessage.editInPlaceDescription',
    defaultMessage:
      '<b>Edit in Place</b> updates this session • <b>Fork Session</b> creates a new session',
  },
  cancel: {
    id: 'userMessage.cancel',
    defaultMessage: 'Cancel',
  },
  cancelAriaLabel: {
    id: 'userMessage.cancelAriaLabel',
    defaultMessage: 'Cancel editing',
  },
  editInPlace: {
    id: 'userMessage.editInPlace',
    defaultMessage: 'Edit and resend',
  },
  editInPlaceAriaLabel: {
    id: 'userMessage.editInPlaceAriaLabel',
    defaultMessage: 'Edit and resend message',
  },
  editInPlaceTitle: {
    id: 'userMessage.editInPlaceTitle',
    defaultMessage: 'Replace this request and regenerate the conversation from here',
  },
  forkSession: {
    id: 'userMessage.forkSession',
    defaultMessage: 'Fork Session',
  },
  forkSessionAriaLabel: {
    id: 'userMessage.forkSessionAriaLabel',
    defaultMessage: 'Fork session with edited message',
  },
  forkSessionTitle: {
    id: 'userMessage.forkSessionTitle',
    defaultMessage: 'Create a new session with the edited message',
  },
  editButton: {
    id: 'userMessage.editButton',
    defaultMessage: 'Edit',
  },
  editMessageAriaLabel: {
    id: 'userMessage.editMessageAriaLabel',
    defaultMessage: 'Edit message: {preview}',
  },
  editMessageTitle: {
    id: 'userMessage.editMessageTitle',
    defaultMessage: 'Edit message',
  },
});

interface UserMessageProps {
  message: Message;
  sessionType?: SessionType;
  readOnly?: boolean;
  onMessageUpdate?: (messageId: string, newContent: string, editType?: MessageEditType, retainedImageIndexes?: number[]) => void;
}

export default function UserMessage({
  message,
  onMessageUpdate,
  readOnly = false,
}: UserMessageProps) {
  const intl = useIntl();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [retainedImageIndexes, setRetainedImageIndexes] = useState<number[]>([]);
  const compactEdit = useCompactTextInput(editContent);
  const [error, setError] = useState<string | null>(null);

  const { textContent, imagePaths } = getTextAndImageContent(message);
  const timestamp = formatMessageTimestamp(message.created);
  const pendingDelivery = message.metadata.pendingDelivery;
  const canEdit = !readOnly && !pendingDelivery;

  // Initialize edit mode with current message content
  const initializeEditMode = useCallback(() => {
    setEditContent(textContent);
    setRetainedImageIndexes(message.content.filter(content => content.type === 'image').map((_, index) => index));
    setError(null);
  }, [textContent, message.content]);

  // Handle edit button click
  const handleEditClick = useCallback(() => {
    if (!canEdit) return;
    const newEditingState = !isEditing;
    setIsEditing(newEditingState);

    // Initialize edit content when entering edit mode
    if (newEditingState) {
      initializeEditMode();

      // Focus the textarea after a brief delay to ensure it's rendered
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(
            textareaRef.current.value.length,
            textareaRef.current.value.length
          );
        }
      }, 50);
    }
  }, [canEdit, isEditing, initializeEditMode]);

  // Handle content changes in edit mode
  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = compactEdit.prefix + e.target.value;
    setEditContent(newContent);
    setError(null); // Clear any previous errors
  };

  const handleSave = useCallback(() => {
    if (!canEdit) return;
    if (editContent.trim().length === 0) {
      setError(intl.formatMessage(i18n.emptyError));
      return;
    }

    setIsEditing(false);

    if (onMessageUpdate && message.id) {
      if (retainedImageIndexes.length === imagePaths.length) onMessageUpdate(message.id, editContent, 'edit');
      else onMessageUpdate(message.id, editContent, 'edit', retainedImageIndexes);
    }
  }, [canEdit, editContent, onMessageUpdate, message.id, intl, retainedImageIndexes, imagePaths.length]);

  // Handle cancel action
  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditContent(textContent); // Reset to original content
    setError(null);
  }, [textContent]);

  // Handle keyboard events for accessibility
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
    },
    [handleCancel, handleSave]
  );

  // Auto-resize textarea based on content
  useEffect(() => {
    if (textareaRef.current && isEditing) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [compactEdit.editorValue, isEditing]);

  if (message.metadata.scheduled)
    return (
      <details className="native-schedule-notice group/schedule my-4 rounded-2xl border border-border-primary bg-background-secondary/30 text-sm text-text-secondary">
        <summary className="native-schedule-summary flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <Clock3 className="size-4" />
          <span className="flex-1">{intl.formatMessage(nativeScheduleMessages.title)}</span>
          <time className="text-xs">{timestamp}</time>
          <ChevronDown className="size-3.5 transition-transform group-open/schedule:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="border-t border-border-primary px-4 py-3 whitespace-pre-wrap break-words text-xs leading-5">
          {textContent}
        </div>
      </details>
    );
  return (
    <div className="w-full mt-[16px] opacity-0 animate-[appear_150ms_ease-in_forwards]">
      <div className="flex flex-col group">
        {isEditing && canEdit ? (
          // Truly wide, centered, in-place edit box replacing the bubble
          <div className="w-full max-w-4xl mx-auto text-text-primary rounded-xl border border-border-primary shadow-lg py-4 px-4 my-2 transition-all duration-200 ease-in-out">
            {compactEdit.prefix && (
              <PastedTextPreview
                text={compactEdit.prefix}
                onRemove={() => {
                  compactEdit.collapse('');
                  setEditContent(compactEdit.editorValue);
                }}
              />
            )}
            <textarea
              ref={textareaRef}
              value={compactEdit.editorValue}
              onChange={handleContentChange}
              onKeyDown={handleKeyDown}
              className="w-full resize-none bg-transparent text-text-primary placeholder:text-text-secondary border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 transition-all duration-200 text-base leading-relaxed"
              style={{
                minHeight: '120px',
                maxHeight: '300px',
                padding: '16px',
                fontFamily: 'inherit',
                lineHeight: '1.6',
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
              }}
              placeholder={intl.formatMessage(i18n.editPlaceholder)}
              aria-label={intl.formatMessage(i18n.editAriaLabel)}
              aria-describedby={error ? `error-${message.id}` : undefined}
            />
            {retainedImageIndexes.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {retainedImageIndexes.map(index => (
                  <div key={index} className="relative rounded-lg border border-border-primary p-1">
                    <img src={imagePaths[index]} alt={String(index + 1)} className="h-20 w-20 rounded object-contain" />
                    <button type="button" className="absolute right-0 top-0 rounded-full bg-background-primary p-1 text-text-primary shadow-sm"
                      aria-label={intl.formatMessage(i18n.removeEditedImage, { number: index + 1 })}
                      onClick={() => setRetainedImageIndexes(current => current.filter(value => value !== index))}>
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Error message */}
            {error && (
              <div
                id={`error-${message.id}`}
                className="text-red-400 text-xs mt-2 mb-2"
                role="alert"
                aria-live="polite"
              >
                {error}
              </div>
            )}
            <div className="flex justify-end items-center mt-4">
              <div className="flex gap-3">
                <Button
                  onClick={handleCancel}
                  variant="ghost"
                  aria-label={intl.formatMessage(i18n.cancelAriaLabel)}
                >
                  {intl.formatMessage(i18n.cancel)}
                </Button>
                <Button
                  onClick={handleSave}
                  aria-label={intl.formatMessage(i18n.editInPlaceAriaLabel)}
                  title={intl.formatMessage(i18n.editInPlaceTitle)}
                >
                  {intl.formatMessage(i18n.editInPlace)}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          // Normal message display
          <div className="message flex justify-end w-full">
            <div className="flex-col max-w-[85%] w-fit">
              <div className="flex flex-col group">
                {textContent.trim() && (
                  <div
                    className={
                      isLargeText(textContent)
                        ? 'flex min-w-0 text-text-primary'
                        : 'flex bg-text-primary text-background-primary rounded-xl py-2.5 px-4'
                    }
                  >
                    <div>
                      {isLargeText(textContent) ? (
                        <PastedTextPreview text={textContent} />
                      ) : (
                        <MarkdownContent
                          content={textContent}
                          className="!text-inherit prose-a:!text-inherit prose-headings:!text-inherit prose-strong:!text-inherit prose-em:!text-inherit prose-li:!text-inherit prose-p:!text-inherit user-message"
                        />
                      )}
                    </div>
                  </div>
                )}

                {imagePaths.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {imagePaths.map((imagePath, index) => (
                      <ImagePreview key={index} src={imagePath} />
                    ))}
                  </div>
                )}

                {pendingDelivery && (
                  <span role="status" className="mt-1 text-right text-xs text-text-secondary">
                    {intl.formatMessage(i18n[pendingDelivery])}
                  </span>
                )}
                <div className="relative h-[22px] flex justify-end text-right">
                  <div className="codepro-user-message-actions absolute right-0 flex w-max items-center gap-2 whitespace-nowrap pt-1 transition-all duration-200 opacity-0 -translate-y-4 group-hover:opacity-100 group-hover:translate-y-0 focus-within:opacity-100 focus-within:translate-y-0">
                    <span className="shrink-0 font-mono text-xs text-text-secondary">
                      {timestamp}
                    </span>
                    {canEdit && (
                      <button
                        onClick={handleEditClick}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleEditClick();
                          }
                        }}
                        className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-text-secondary hover:cursor-pointer hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50 rounded"
                        aria-label={intl.formatMessage(i18n.editMessageAriaLabel, {
                          preview: `${textContent.substring(0, 50)}${textContent.length > 50 ? '...' : ''}`,
                        })}
                        aria-expanded={isEditing}
                        title={intl.formatMessage(i18n.editMessageTitle)}
                      >
                        <Edit className="h-3 w-3" />
                        <span>{intl.formatMessage(i18n.editButton)}</span>
                      </button>
                    )}
                    <MessageCopyLink text={textContent} alwaysVisible />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
