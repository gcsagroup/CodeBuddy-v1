import type { ActionRequired, Message } from '../../types/message';
import type { AcpElicitationRequest } from '../elicitationRequests';
import {
  type AcpChatStateChange,
  type AdapterState,
  DEFAULT_VISIBLE_MESSAGE_METADATA,
  messagesChange,
} from './shared';

export type ElicitationStatus = 'submitted' | 'cancelled';

export function elicitationContent(
  request: AcpElicitationRequest
): ActionRequired & { type: 'actionRequired' } {
  const schema = request.request.requestedSchema;
  const fieldHints = request.request._meta?.['codepro.dev/questionFields'];
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([key, field]) => {
      const hint =
        fieldHints && typeof fieldHints === 'object' && !Array.isArray(fieldHints)
          ? (fieldHints as Record<string, unknown>)[key]
          : undefined;
      return [
        key,
        hint && typeof hint === 'object' && !Array.isArray(hint)
          ? { ...field, _meta: hint }
          : field,
      ];
    })
  );
  return {
    type: 'actionRequired',
    data: {
      actionType: 'elicitation',
      id: request.id,
      message: request.request.message,
      requested_schema: { ...schema, properties },
    },
  };
}

export function applyElicitationRequest(
  state: AdapterState,
  request: AcpElicitationRequest
): AcpChatStateChange[] {
  if (hasExistingElicitation(state, request.id)) {
    return messagesChange(state);
  }

  state.messages.push({
    id: request.id,
    role: 'assistant',
    created: Math.floor(Date.now() / 1000),
    content: [elicitationContent(request)],
    metadata: { ...DEFAULT_VISIBLE_MESSAGE_METADATA },
  });

  return messagesChange(state);
}

export function applyElicitationStatus(
  state: AdapterState,
  elicitationId: string,
  status: ElicitationStatus
): AcpChatStateChange[] {
  const statusData = {
    isSubmitted: status === 'submitted',
    isCancelled: status === 'cancelled',
  };
  let changed = false;

  state.messages = state.messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((content) => {
      if (
        content.type !== 'actionRequired' ||
        content.data.actionType !== 'elicitation' ||
        content.data.id !== elicitationId
      ) {
        return content;
      }

      messageChanged = true;
      changed = true;
      return {
        ...content,
        data: {
          ...content.data,
          ...statusData,
        },
      };
    });

    return messageChanged ? { ...message, content } : message;
  });

  return changed ? messagesChange(state) : [];
}

function hasExistingElicitation(state: AdapterState, elicitationId: string): boolean {
  return state.messages.some((message: Message) =>
    message.content.some(
      (content) =>
        content.type === 'actionRequired' &&
        content.data.actionType === 'elicitation' &&
        content.data.id === elicitationId
    )
  );
}
