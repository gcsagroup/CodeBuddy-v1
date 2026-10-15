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
import { canForkSession, sessionCapabilityMessages } from '../utils/sessionCapabilities';

const i18n = defineMessages({
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
    defaultMessage: 'Edit in Place',
  },
  editInPlaceAriaLabel: {
    id: 'userMessage.editInPlaceAriaLabel',
    defaultMessage: 'Edit message in place',
  },
  editInPlaceTitle: {
    id: 'userMessage.editInPlaceTitle',
    defaultMessage: 'Update the message in this session',
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
  onMessageUpdate?: (messageId: string, newContent: string, editType?: MessageEditType) => void;
}

export default function UserMessage({
  message,
  onMessageUpdate,
  sessionType,
  readOnly = false,
}: UserMessageProps) {
  const intl = useIntl();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { textContent, imagePaths } = getTextAndImageContent(message);
  const timestamp = formatMessageTimestamp(message.created);

  // Effect to handle message content changes and ensure persistence
  useEffect(() => {
    // If we're not editing, update the edit content to match the current message
    if (!isEditing) {
      setEditContent(textContent);
    }
  }, [message.content, textContent, message.id, isEditing]);

  // Initialize edit mode with current message content
  const initializeEditMode = useCallback(() => {
    setEditContent(textContent);
    setError(null);
  }, [textContent]);

  // Handle edit button click
  const handleEditClick = useCallback(() => {
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
  }, [isEditing, initializeEditMode]);

  // Handle content changes in edit mode
  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setEditContent(newContent);
    setError(null); // Clear any previous errors
  }, []);

  const handleSave = useCallback(
    (editType: 'fork' | 'edit' = 'fork') => {
      if (editType === 'fork' && !canForkSession(sessionType)) {
        setError(intl.formatMessage(sessionCapabilityMessages.forkUnavailable));
        return;
      }
      if (editContent.trim().length === 0) {
        setError(intl.formatMessage(i18n.emptyError));
        return;
      }

      setIsEditing(false);

      if (editType === 'edit' && editContent.trim() === textContent.trim()) {
        return;
      }

      if (onMessageUpdate && message.id) {
        onMessageUpdate(message.id, editContent, editType);
      }
    },
    [editContent, textContent, onMessageUpdate, message.id, intl, sessionType]
  );

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
  }, [editContent, isEditing]);

  return (
    <div className="w-full mt-[16px] opacity-0 animate-[appear_150ms_ease-in_forwards]">
      <div className="flex flex-col group">
        {isEditing && !readOnly ? (
          // Truly wide, centered, in-place edit box replacing the bubble
          <div className="w-full max-w-4xl mx-auto text-text-primary rounded-xl border border-border-primary shadow-lg py-4 px-4 my-2 transition-all duration-200 ease-in-out">
            <textarea
              ref={textareaRef}
              value={editContent}
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
            <div className="flex justify-between items-center mt-4">
              <div className="text-xs text-text-secondary">
                {canForkSession(sessionType)
                  ? intl.formatMessage(i18n.editInPlaceDescription, {
                      b: (chunks: React.ReactNode) => (
                        <span className="font-semibold">{chunks}</span>
                      ),
                    })
                  : intl.formatMessage(sessionCapabilityMessages.forkUnavailable)}
              </div>
              <div className="flex gap-3">
                <Button
                  onClick={handleCancel}
                  variant="ghost"
                  aria-label={intl.formatMessage(i18n.cancelAriaLabel)}
                >
                  {intl.formatMessage(i18n.cancel)}
                </Button>
                <Button
                  onClick={() => handleSave('edit')}
                  variant="secondary"
                  aria-label={intl.formatMessage(i18n.editInPlaceAriaLabel)}
                  title={intl.formatMessage(i18n.editInPlaceTitle)}
                >
                  {intl.formatMessage(i18n.editInPlace)}
                </Button>
                <Button
                  onClick={() => handleSave('fork')}
                  disabled={!canForkSession(sessionType)}
                  aria-label={intl.formatMessage(i18n.forkSessionAriaLabel)}
                  title={intl.formatMessage(i18n.forkSessionTitle)}
                >
                  {intl.formatMessage(i18n.forkSession)}
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
                  <div className="flex bg-text-primary text-background-primary rounded-xl py-2.5 px-4">
                    <div ref={contentRef}>
                      <MarkdownContent
                        content={textContent}
                        className="!text-inherit prose-a:!text-inherit prose-headings:!text-inherit prose-strong:!text-inherit prose-em:!text-inherit prose-li:!text-inherit prose-p:!text-inherit user-message"
                      />
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

                <div className="relative h-[22px] flex justify-end text-right">
                  <div className="absolute w-40 font-mono right-0 text-xs text-text-secondary pt-1 transition-all duration-200 group-hover:-translate-y-4 group-hover:opacity-0">
                    {timestamp}
                  </div>
                  <div className="absolute right-0 flex w-max items-center gap-2 whitespace-nowrap pt-1">
                    {!readOnly && (
                      <button
                        onClick={handleEditClick}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleEditClick();
                          }
                        }}
                        className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-text-secondary hover:cursor-pointer hover:text-text-primary transition-all duration-200 opacity-0 group-hover:opacity-100 -translate-y-4 group-hover:translate-y-0 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50 rounded"
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
                    <MessageCopyLink text={textContent} contentRef={contentRef} />
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
