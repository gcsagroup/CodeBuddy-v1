import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AppEvents } from '../constants/events';
import { maybeHandlePlatformEvent } from '../utils/platform_events';
import { toolNotificationEvent } from './adapter/toolNotifications';
import { acpChatSessionActions, acpChatSessionStore } from './chatSessionStore';
import { isTerminalActivityEventStatus, parseActivityEvent } from '../types/activityEvent';
import { isTurnTerminalRecord } from '../types/turnTerminal';
import { applyNativeQuestionSnapshot } from './elicitationRequests';
import { applySubagentViewNotification } from './subagentConversation';
import {
  expireAcpPermissionRequestForTool,
  expireAcpPermissionRequestsForTurn,
} from './permissionRequests';

export function handleAcpSessionNotification(
  notification: SessionNotification,
  signal?: globalThis.AbortSignal
): Promise<void> {
  if (applySubagentViewNotification(notification, signal)) return Promise.resolve();
  const sessionNameBeforeNotification = acpChatSessionStore.getSnapshot(notification.sessionId)
    ?.session?.name;
  const updatedName =
    notification.update.sessionUpdate === 'session_info_update'
      ? notification.update.title
      : undefined;
  acpChatSessionActions.applyAcpSessionNotification(notification);
  const update = notification.update;
  if (update.sessionUpdate === 'session_info_update' && update._meta?.['codebuddy/questions'])
    applyNativeQuestionSnapshot(
      notification.sessionId,
      update._meta['codebuddy/questions'],
      signal
    );
  if (
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
    (update.status === 'completed' || update.status === 'failed')
  ) {
    expireAcpPermissionRequestForTool(notification.sessionId, update.toolCallId);
  }
  maybeHandleLivePlatformEvent(notification);

  if (updatedName && updatedName !== sessionNameBeforeNotification) {
    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_RENAMED, {
        detail: { sessionId: notification.sessionId, newName: updatedName },
      })
    );
  }

  return Promise.resolve();
}

function maybeHandleLivePlatformEvent(notification: SessionNotification): void {
  const update = notification.update;
  if (
    update.sessionUpdate !== 'tool_call_update' ||
    update.status === 'completed' ||
    update.status === 'failed'
  ) {
    return;
  }

  const event = toolNotificationEvent(update);
  if (event?.message.method === 'platform_event') {
    maybeHandlePlatformEvent(event.message, notification.sessionId);
  }
}

export function handleAcpGooseSessionNotification(
  notification: GooseSessionNotification_unstable
): Promise<void> {
  acpChatSessionActions.applyAcpGooseSessionNotification(notification);
  const update = notification.update;
  if (update.sessionUpdate === 'status_message' && update.status.type === 'progress') {
    const data = update.status.data;
    if (isTurnTerminalRecord(data) && data.session_id === notification.sessionId) {
      expireAcpPermissionRequestsForTurn(
        notification.sessionId,
        data.run_id,
        data.source_user_message_id
      );
    }
    const activity = parseActivityEvent(data);
    if (
      activity?.session_id === notification.sessionId &&
      activity.tool_call_id &&
      activity.status !== 'unknown' &&
      isTerminalActivityEventStatus(activity.status) &&
      [
        'tool_completed',
        'command_completed',
        'test_completed',
        'file_read',
        'file_changed',
        'approval_resolved',
      ].includes(activity.event_type)
    ) {
      expireAcpPermissionRequestForTool(
        notification.sessionId,
        activity.tool_call_id,
        activity.run_id,
        true
      );
    }
  }
  return Promise.resolve();
}
