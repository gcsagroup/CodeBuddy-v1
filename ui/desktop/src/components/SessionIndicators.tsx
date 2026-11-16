import { AlertCircle, CircleDot, MessageCircleQuestionMark } from 'lucide-react';
import React from 'react';
import { defineMessages, useIntl } from '../i18n';
import AnimatedIcons from './AnimatedIcons';

const i18n = defineMessages({
  error: {
    id: 'sessionIndicators.error',
    defaultMessage: 'Session encountered an error',
  },
  streaming: {
    id: 'sessionIndicators.streaming',
    defaultMessage: 'Streaming',
  },
  newActivity: {
    id: 'sessionIndicators.newActivity',
    defaultMessage: 'Has new activity',
  },
});

interface SessionIndicatorsProps {
  isStreaming: boolean;
  hasUnread: boolean;
  hasError: boolean;
  awaitingReply?: boolean;
}

/**
 * Visual indicators for session status (priority order: error > streaming > unread)
 */
export const SessionIndicators = React.memo<SessionIndicatorsProps>(
  ({ isStreaming, hasUnread, hasError, awaitingReply }) => {
    const intl = useIntl();
    const errorLabel = intl.formatMessage(i18n.error);
    const streamingLabel = intl.formatMessage(i18n.streaming);
    const unreadLabel = intl.formatMessage(i18n.newActivity);

    if (awaitingReply) return (
      <span role="status" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        <MessageCircleQuestionMark aria-hidden="true" className="size-3.5" />
        {intl.formatMessage({ id: 'sessionIndicators.awaitingReply', defaultMessage: 'Awaiting reply' })}
      </span>
    );

    if (hasError) {
      return (
        <div
          className="flex items-center gap-1"
          role="img"
          aria-label={errorLabel}
          title={errorLabel}
        >
          <AlertCircle className="w-3.5 h-3.5 text-red-500" aria-hidden="true" />
        </div>
      );
    }

    if (isStreaming) {
      return (
        <div
          className="flex items-center gap-1"
          role="img"
          aria-label={streamingLabel}
          title={streamingLabel}
        >
          <AnimatedIcons variant="waiting" />
        </div>
      );
    }

    if (hasUnread) {
      return (
        <div
          className="flex items-center gap-1"
          role="img"
          aria-label={unreadLabel}
          title={unreadLabel}
        >
          <CircleDot className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
        </div>
      );
    }

    return null;
  }
);

SessionIndicators.displayName = 'SessionIndicators';
