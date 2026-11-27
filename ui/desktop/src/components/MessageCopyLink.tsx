/* global ClipboardItem */

import React, { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Copy } from './icons';
import { defineMessages, useIntl } from '../i18n';
import { cn } from '../utils';
import MessageSpeechButton from './MessageSpeechButton';

const i18n = defineMessages({
  copied: {
    id: 'messageCopyLink.copied',
    defaultMessage: 'Copied!',
  },
  copy: {
    id: 'messageCopyLink.copy',
    defaultMessage: 'Copy',
  },
  retry: {
    id: 'messageCopyLink.retry',
    defaultMessage: 'Retry',
  },
});

interface MessageCopyLinkProps {
  text: string;
  contentRef?: React.RefObject<HTMLDivElement | null>;
  onRetry?: () => void;
  alwaysVisible?: boolean;
  speakable?: boolean;
}

export default function MessageCopyLink({
  text,
  contentRef,
  onRetry,
  alwaysVisible = false,
  speakable = false,
}: MessageCopyLinkProps) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  const copyLabel = intl.formatMessage(i18n.copy);
  const retryLabel = intl.formatMessage(i18n.retry);

  const handleCopy = async () => {
    try {
      if (contentRef?.current) {
        // Create a temporary container to handle HTML content
        const container = document.createElement('div');
        container.innerHTML = contentRef.current.innerHTML;

        // Clean up any copy buttons from the content
        const copyButtons = container.querySelectorAll('button');
        copyButtons.forEach((button) => button.remove());

        // Create the clipboard data
        const clipboardData = new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([container.innerHTML], { type: 'text/html' }),
        });

        await navigator.clipboard.write([clipboardData]);
      } else {
        await navigator.clipboard.writeText(text);
      }

      setCopied(true);
      setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
    } catch (err) {
      console.error('Failed to copy text: ', err);
      // Fallback to plain text if HTML copy fails
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (fallbackErr) {
        console.error('Failed to copy text (fallback): ', fallbackErr);
      }
    }
  };

  const actionClass =
    'flex shrink-0 items-center gap-1 whitespace-nowrap text-xs leading-4 text-text-secondary hover:cursor-pointer hover:text-text-primary';

  return (
    <div
      className={cn(
        'flex items-center gap-3 transition-all duration-200',
        alwaysVisible
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
      )}
    >
      {speakable && text.trim() && <MessageSpeechButton text={text} className={actionClass} />}
      <button
        type="button"
        onClick={handleCopy}
        className={actionClass}
        aria-label={copyLabel}
        title={copyLabel}
      >
        <Copy className="h-3 w-3" aria-hidden="true" />
        <span>{copied ? intl.formatMessage(i18n.copied) : copyLabel}</span>
      </button>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={actionClass}
          aria-label={retryLabel}
          title={retryLabel}
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          <span>{retryLabel}</span>
        </button>
      )}
    </div>
  );
}
