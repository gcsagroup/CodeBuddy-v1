import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';
import type { Message } from '../types/message';
import { parseSubagentLifecycle } from '../types/subagentLifecycle';
import {
  applyElicitationRequest as applyElicitationRequestToState,
  applyElicitationStatus as applyElicitationStatusToState,
  type ElicitationStatus,
} from './adapter/elicitations';
import { applyGooseSessionNotification } from './adapter/gooseSessionNotifications';
import { applyContentChunk, applyThoughtChunk } from './adapter/messages';
import { applyPermissionRequest as applyPermissionRequestToState } from './adapter/permissions';
import {
  type AcpChatStateChange,
  type AdapterState,
  cloneMessage,
  getGooseActiveRunId,
  getGooseMessageMeta,
  isRecord,
  messagesChange,
} from './adapter/shared';
import { applyToolCall, applyToolCallUpdate } from './adapter/tools';
import type { AcpElicitationRequest } from './elicitationRequests';

export type { AcpChatStateChange } from './adapter/shared';

export interface AcpSessionNotificationAdapter {
  apply(notification: SessionNotification): AcpChatStateChange[];
  applyGoose(
    notification: GooseSessionNotification_unstable,
    isSessionReplay?: boolean
  ): AcpChatStateChange[];
  applyPermissionRequest(request: RequestPermissionRequest): AcpChatStateChange[];
  applyElicitationRequest(request: AcpElicitationRequest): AcpChatStateChange[];
  applyElicitationStatus(elicitationId: string, status: ElicitationStatus): AcpChatStateChange[];
  getMessages(): Message[];
}

export function createAcpSessionNotificationAdapter(
  initialMessages: Message[] = [],
  localSteerTextByMessageId: Map<string, string> = new Map()
): AcpSessionNotificationAdapter {
  const state: AdapterState = {
    messages: initialMessages.map(cloneMessage),
    localSteerTextByMessageId: new Map(localSteerTextByMessageId),
  };

  return {
    apply(notification) {
      return applyAcpSessionNotification(state, notification);
    },
    applyGoose(notification, isSessionReplay = false) {
      return applyGooseSessionNotification(state, notification, isSessionReplay);
    },
    applyPermissionRequest(request) {
      return applyPermissionRequestToState(state, request);
    },
    applyElicitationRequest(request) {
      return applyElicitationRequestToState(state, request);
    },
    applyElicitationStatus(elicitationId, status) {
      return applyElicitationStatusToState(state, elicitationId, status);
    },
    getMessages() {
      return state.messages.map(cloneMessage);
    },
  };
}

function applyAcpSessionNotification(
  state: AdapterState,
  notification: SessionNotification
): AcpChatStateChange[] {
  const update = notification.update;
  // Only the host timing probe emits this metadata. Do not log content or
  // raw notifications, and never let diagnostics interfere with delivery.
  const timing = update._meta?.streamTiming;
  const receivedAt = Date.now();
  let timingFields: Record<string, string | number> | undefined;
  if (
    isRecord(timing) &&
    typeof timing.requestId === 'string' &&
    /^[0-9a-f-]{36}$/.test(timing.requestId) &&
    typeof timing.parsedSequence === 'number' &&
    Number.isSafeInteger(timing.parsedSequence) &&
    typeof timing.sentAtMs === 'number' &&
    Number.isFinite(timing.sentAtMs)
  ) {
    const messageId =
      ('messageId' in update && typeof update.messageId === 'string'
        ? update.messageId
        : undefined) ?? getGooseMessageMeta(update).messageId;
    timingFields = {
      tag: 'stream_timing',
      request_id: timing.requestId,
      session_id: notification.sessionId,
      parsed_sequence: timing.parsedSequence,
      sent_at_ms: timing.sentAtMs,
      kind: update.sessionUpdate,
      ...(messageId ? { message_id: messageId } : {}),
    };
    try {
      window.electron.logInfo(
        JSON.stringify({
          ...timingFields,
          stage: 'ui_received',
          at_ms: receivedAt,
        })
      );
    } catch {
      /* Observability is best effort. */
    }
  }

  const changes = applyAcpSessionUpdate(state, notification);
  if (timingFields) {
    try {
      window.electron.logInfo(
        JSON.stringify({
          ...timingFields,
          stage: 'ui_adapter_applied',
          at_ms: Date.now(),
          elapsed_ms: Date.now() - receivedAt,
          change_count: changes.length,
        })
      );
    } catch {
      /* Diagnostics do not decide whether a message is delivered. */
    }
  }
  return changes;
}

function applyAcpSessionUpdate(
  state: AdapterState,
  notification: SessionNotification
): AcpChatStateChange[] {
  const update = notification.update;
  const goose = isRecord(update._meta?.goose) ? update._meta.goose : undefined;
  const lifecycle = parseSubagentLifecycle(goose?.subagentLifecycle);
  if (lifecycle) {
    if (lifecycle.session_id !== notification.sessionId) return [];
    if (!state.messages.some((message) => message.id === lifecycle.event_id))
      state.messages.push({
        id: lifecycle.event_id,
        role: 'assistant',
        created: lifecycle.created_at,
        content: [
          {
            type: 'systemNotification',
            notificationType: 'inlineMessage',
            msg: '',
            data: lifecycle,
          },
        ],
        metadata: { userVisible: true, agentVisible: false },
      });
    return messagesChange(state);
  }
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return applyContentChunk(state, 'user', update);
    case 'agent_message_chunk':
      return applyContentChunk(state, 'assistant', update);
    case 'agent_thought_chunk':
      return applyThoughtChunk(state, update);
    case 'tool_call':
      return applyToolCall(state, update);
    case 'tool_call_update':
      return applyToolCallUpdate(state, update);
    case 'session_info_update': {
      const activeRunId = getGooseActiveRunId(update);
      if (!update.title && activeRunId === undefined) {
        return [];
      }

      return [
        {
          type: 'sessionInfo',
          ...(update.title ? { name: update.title } : {}),
          ...(activeRunId !== undefined ? { activeRunId } : {}),
        },
      ];
    }
    case 'usage_update':
      return [];
    default:
      return [];
  }
}
