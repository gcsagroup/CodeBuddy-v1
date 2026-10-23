import React from 'react';
import type { Message, SystemNotificationContent } from '../../types/message';
import { parseSubagentLifecycle } from '../../types/subagentLifecycle';
import { SubagentAvatar } from '../SubagentAvatar';
import { openSubagentConversation } from '../../workspace-panel/subagentPanel';
import { defineMessages, useIntl } from '../../i18n';
import { formatSubagentLabel } from '../toolActionPresentation';

const m = defineMessages({
  start: { id: 'subagentLifecycle.start', defaultMessage: 'started working' },
  end: { id: 'subagentLifecycle.end', defaultMessage: 'ended' },
});

interface SystemNotificationInlineProps {
  notification: SystemNotificationContent;
}

export const SystemNotificationInline: React.FC<SystemNotificationInlineProps> = ({
  notification,
}) => {
  const intl = useIntl();
  const lifecycle = parseSubagentLifecycle(notification.data);
  if (lifecycle)
    return (
      <button
        type="button"
        className="flex min-h-7 max-w-full items-center gap-1.5 py-1 text-left text-sm text-text-secondary hover:text-text-primary"
        onClick={() =>
          openSubagentConversation({
            parentSessionId: lifecycle.session_id,
            childSessionId: lifecycle.child_session_id,
            title: formatSubagentLabel(intl, lifecycle.label),
          })
        }
      >
        <SubagentAvatar sessionId={lifecycle.child_session_id} small />
        <span className="min-w-0 break-words">
          {formatSubagentLabel(intl, lifecycle.label)} {intl.formatMessage(m[lifecycle.phase])}
        </span>
      </button>
    );
  return <div className="text-xs text-gray-400 py-2 text-left">{notification.msg}</div>;
};

export function getInlineSystemNotification(
  message: Message
): SystemNotificationContent | undefined {
  return message.content.find(
    (content): content is SystemNotificationContent & { type: 'systemNotification' } =>
      content.type === 'systemNotification' &&
      (content.notificationType === 'inlineMessage' ||
        content.notificationType === 'codeProActivity')
  );
}
