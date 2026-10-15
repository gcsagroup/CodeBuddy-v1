import { AlertCircle, CircleDot, Loader2 } from 'lucide-react';
import React from 'react';
import { defineMessages, useIntl } from '../i18n';

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
}

/**
 * Visual indicators for session status (priority order: error > streaming > unread)
 */
export const SessionIndicators = React.memo<SessionIndicatorsProps>(
  ({ isStreaming, hasUnread, hasError }) => {
    const intl = useIntl();
    const errorLabel = intl.formatMessage(i18n.error);
    const streamingLabel = intl.formatMessage(i18n.streaming);
    const unreadLabel = intl.formatMessage(i18n.newActivity);

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
          <Loader2 className="w-3 h-3 text-blue-500 animate-spin" aria-hidden="true" />
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
