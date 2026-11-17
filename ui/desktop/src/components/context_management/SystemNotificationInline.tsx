import React from 'react';
import { CheckCircle2, CircleAlert, CircleSlash2 } from 'lucide-react';
import { parseCompactionLifecycle } from '../../types/compactionLifecycle';
import type { Message, SystemNotificationContent } from '../../types/message';
import { parseSubagentLifecycle } from '../../types/subagentLifecycle';
import { SubagentAvatar } from '../SubagentAvatar';
import { openSubagentConversation } from '../../workspace-panel/subagentPanel';
import { defineMessages, useIntl } from '../../i18n';
import { formatSubagentLabel } from '../toolActionPresentation';
import { isRecord } from '../../acp/adapter/shared';
import { ProjectBrief } from './ProjectBrief';

const m = defineMessages({
  compactAuto: { id: 'compaction.completedAuto', defaultMessage: 'Context automatically compacted' },
  compactManual: { id: 'compaction.completedManual', defaultMessage: 'Context compacted' },
  compactFailed: { id: 'compaction.failed', defaultMessage: 'Context compaction failed. The previous context is preserved.' },
  compactCancelled: { id: 'compaction.cancelled', defaultMessage: 'Context compaction cancelled. The previous context is preserved.' },
  compactDetails: { id: 'compaction.details', defaultMessage: 'View details' },
  start: { id: 'subagentLifecycle.start', defaultMessage: 'started working' },
  end: { id: 'subagentLifecycle.end', defaultMessage: 'ended' },
});

interface SystemNotificationInlineProps {
  notification: SystemNotificationContent;
  sessionId?: string;
}

export const SystemNotificationInline: React.FC<SystemNotificationInlineProps> = ({
  notification,
  sessionId,
}) => {
  const intl = useIntl();
  const data = notification.data;
  if (sessionId && isRecord(data) && data.event === 'managed_turn_result' && data.outcome === 'completed' &&
      typeof data.sessionId === 'string' && typeof data.requestId === 'string')
    return <ProjectBrief key={JSON.stringify([sessionId, data.sessionId, data.requestId])}
      mainId={sessionId} childId={data.sessionId} requestId={data.requestId} snapshot={data.brief} title={typeof data.title === 'string' ? data.title : undefined} />;
  const compaction = parseCompactionLifecycle(notification.data);
  if (compaction) {
    if (compaction.status === 'started') return null;
    const completed = compaction.status === 'completed';
    const Icon = completed ? CheckCircle2 : compaction.status === 'failed' ? CircleAlert : CircleSlash2;
    const label = completed ? (compaction.trigger === 'auto' ? m.compactAuto : m.compactManual)
      : compaction.status === 'failed' ? m.compactFailed : m.compactCancelled;
    return <div role="status" className="my-3 flex items-center gap-2 rounded-lg border border-border-primary bg-background-secondary/50 px-3 py-2 text-xs text-text-secondary">
      <Icon className="size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span>{intl.formatMessage(label)}{isRecord(data) && typeof data.repeatCount === 'number' && data.repeatCount > 1 && ` × ${data.repeatCount}`}</span>
        {compaction.status === 'failed' && compaction.error && (
          <details className="mt-1">
            <summary className="cursor-pointer text-text-secondary hover:text-text-primary">{intl.formatMessage(m.compactDetails)}</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-xs">{compaction.error}</p>
          </details>
        )}
      </div>
    </div>;
  }
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

// Group repeated automatic failures within a turn for display only. Lifecycle
// records keep their original operation IDs in the session and in history.
export function groupCompactionFailures(messages: Message[]): Message[] {
  const output: Message[] = [];
  const groups = new Map<string, { index: number; count: number }>();
  for (const message of messages) {
    const notification = getInlineSystemNotification(message);
    const data = notification?.data;
    const lifecycle = parseCompactionLifecycle(data);
    if (lifecycle && (lifecycle.status === 'completed' || lifecycle.trigger !== 'auto')) groups.clear();
    if (message.content.length !== 1 || lifecycle?.trigger !== 'auto' || lifecycle.status !== 'failed' ||
        !isRecord(data) || !isRecord(data.diagnostic) || typeof data.diagnostic.code !== 'string') {
      output.push(message);
      continue;
    }
    const key = JSON.stringify([lifecycle.runId, lifecycle.workerSessionId, data.diagnostic.code, lifecycle.error]);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { index: output.length, count: 1 });
      output.push(message);
      continue;
    }
    const first = output[group.index];
    const content = first.content[0];
    if (content.type === 'systemNotification' && isRecord(content.data)) {
      group.count++;
      output[group.index] = { ...first, content: [{ ...content, data: { ...content.data, repeatCount: group.count } }] };
    }
  }
  return output;
}

export function getInlineSystemNotification(
  message: Message
): SystemNotificationContent | undefined {
  return message.content.find(
    (content): content is SystemNotificationContent & { type: 'systemNotification' } =>
      content.type === 'systemNotification' &&
      (content.notificationType === 'inlineMessage' ||
        content.notificationType === 'codeProActivity' ||
        !!parseCompactionLifecycle(content.data))
  );
}
