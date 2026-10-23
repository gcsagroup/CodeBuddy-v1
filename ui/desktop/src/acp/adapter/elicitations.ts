import type { ActionRequired, Message } from '../../types/message';
import type { AcpElicitationRequest } from '../elicitationRequests';
import {
  type AcpChatStateChange,
  type AdapterState,
  DEFAULT_VISIBLE_MESSAGE_METADATA,
  messagesChange,
} from './shared';

export type ElicitationStatus = 'submitted' | 'cancelled' | 'expired';

export function elicitationContent(
  request: AcpElicitationRequest
): ActionRequired & { type: 'actionRequired' } {
  const schema = request.request.requestedSchema;
  const fieldHints = request.request._meta?.['codepro.dev/questionFields'];
  const hints = request.request._meta?.['codepro/questionFields'];
  const properties: Record<
    string,
    NonNullable<typeof schema.properties>[string] & {
      _meta?: Record<string, unknown>;
    }
  > = { ...schema.properties };
  if (hints && typeof hints === 'object' && !Array.isArray(hints)) {
    for (const [key, hint] of Object.entries(hints)) {
      if (
        !properties[key] ||
        !hint ||
        typeof hint !== 'object' ||
        !('options' in hint) ||
        !Array.isArray(hint.options)
      )
        continue;
      const options = hint.options.filter(
        (option: unknown): option is { label: string; description?: string } =>
          option !== null &&
          typeof option === 'object' &&
          'label' in option &&
          typeof option.label === 'string' &&
          (!('description' in option) ||
            option.description === undefined ||
            typeof option.description === 'string')
      );
      const customKey =
        'customKey' in hint &&
        typeof hint.customKey === 'string' &&
        schema.properties?.[hint.customKey]?.type === 'string'
          ? hint.customKey
          : undefined;
      properties[key] = {
        ...properties[key],
        _meta: {
          'codepro.dev/suggestedOptions': options.map(
            (option: { label: string; description?: string }) => ({
              const: option.label,
              title: option.label,
              description: option.description,
            })
          ),
          ...(customKey ? { 'codepro.dev/feedbackField': customKey } : {}),
        },
      };
    }
  }
  // Normalize old saved cards above; live producers use one canonical hint map.
  if (fieldHints && typeof fieldHints === 'object' && !Array.isArray(fieldHints)) {
    for (const [key, hint] of Object.entries(fieldHints)) {
      if (!properties[key] || !hint || typeof hint !== 'object' || Array.isArray(hint)) continue;
      properties[key] = { ...properties[key], _meta: { ...properties[key]._meta, ...hint } };
    }
  }
  return {
    type: 'actionRequired',
    data: {
      actionType: 'elicitation',
      id: request.id,
      message: request.request.message,
      requested_schema: { ...schema, properties },
      expiresAt: request.expiresAt,
      ...(request.nativeQuestion
        ? { nativeQuestion: true, continued: request.continued === true }
        : {}),
    },
  };
}

export function applyElicitationRequest(
  state: AdapterState,
  request: AcpElicitationRequest
): AcpChatStateChange[] {
  if (hasExistingElicitation(state, request.id)) {
    state.messages = state.messages.map((message) => ({
      ...message,
      content: message.content.map((content) =>
        content.type === 'actionRequired' &&
        content.data.actionType === 'elicitation' &&
        content.data.id === request.id
          ? elicitationContent(request)
          : content
      ),
    }));
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
    isExpired: status === 'expired',
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
