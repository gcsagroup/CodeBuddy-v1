import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { TokenState } from '../../types/chat';
import type { Message, NotificationEvent } from '../../types/message';
import type { CompactionLifecycle } from '../../types/compactionLifecycle';

export type AcpChatStateChange =
  | { type: 'messages'; messages: Message[] }
  | { type: 'tokenState'; tokenState: Partial<TokenState> }
  | { type: 'progressMessage'; message: string | undefined }
  | { type: 'compactionLifecycle'; lifecycle: CompactionLifecycle }
  | {
      type: 'sessionInfo';
      name?: string;
      activeRunId?: string | null;
    }
  | { type: 'localSteerConfirmed'; messageId: string }
  | { type: 'notification'; notification: NotificationEvent };

export interface AdapterState {
  messages: Message[];
  localSteerTextByMessageId: Map<string, string>;
}

export interface GooseMessageMeta {
  inference?: Message['metadata']['inference'];
  messageId?: string;
  created?: number;
  steer?: boolean;
  presentation?: Message['metadata']['presentation'];
  transcriptReplayStarted?: boolean;
  scheduled?: true;
}

export interface ToolIdentity {
  toolName?: string;
  extensionName?: string;
}

export const DEFAULT_VISIBLE_MESSAGE_METADATA: Message['metadata'] = {
  userVisible: true,
  agentVisible: true,
};

const publishedMessages = new WeakMap<AdapterState, Message[]>();

// The adapter still owns mutable input. Publish isolated snapshots, retaining
// unchanged messages for a known single-message change. Only a caller that
// inserted exactly one message may supply the insertion hint.
export function messagesChange(
  state: AdapterState,
  changed?: Message,
  inserted = false
): AcpChatStateChange[] {
  const previous = publishedMessages.get(state);
  const index = changed ? state.messages.indexOf(changed) : -1;
  let messages: Message[];
  if (
    inserted &&
    previous &&
    previous.length + 1 === state.messages.length &&
    index >= 0 &&
    changed
  ) {
    messages = previous.slice();
    messages.splice(index, 0, cloneMessage(changed));
  } else if (previous && previous.length === state.messages.length && index >= 0 && changed) {
    messages = previous.slice();
    messages[index] = cloneMessage(changed);
  } else {
    messages = state.messages.map(cloneMessage);
  }
  publishedMessages.set(state, messages);
  return [{ type: 'messages', messages }];
}

export function cloneMessage(message: Message): Message {
  return {
    ...message,
    content: message.content.map((content) => ({ ...content })),
    metadata: { ...message.metadata },
  };
}

export function getGooseMessageMeta(update: { _meta?: unknown }): GooseMessageMeta {
  if (!isRecord(update._meta)) {
    return {};
  }

  const goose = update._meta.goose;
  if (!isRecord(goose)) {
    return {};
  }

  return {
    created: typeof goose.created === 'number' ? goose.created : undefined,
    inference: isRecord(goose.inference) && typeof goose.inference.provider === 'string' &&
      typeof goose.inference.requestedModel === 'string'
      ? { provider: goose.inference.provider, requestedModel: goose.inference.requestedModel } : undefined,
    messageId: typeof goose.messageId === 'string' ? goose.messageId : undefined,
    steer: goose.steer === true ? true : undefined,
    scheduled: goose.scheduled === true ? true : undefined,
    presentation:
      isRecord(goose.presentation) &&
      typeof goose.presentation.afterMessageId === 'string' &&
      goose.presentation.afterMessageId.length > 0 &&
      goose.presentation.afterMessageId.length <= 2048
        ? { afterMessageId: goose.presentation.afterMessageId,
            ...(goose.presentation.continuation === true ? { continuation: true as const } : {}) }
        : undefined,
    transcriptReplayStarted: goose.transcriptReplayStarted === true ? true : undefined,
  };
}

export function getGooseActiveRunId(update: { _meta?: unknown }): string | null | undefined {
  if (!isRecord(update._meta)) {
    return undefined;
  }

  const goose = update._meta.goose;
  if (!isRecord(goose) || !('activeRunId' in goose)) {
    return undefined;
  }

  return typeof goose.activeRunId === 'string' || goose.activeRunId === null
    ? goose.activeRunId
    : undefined;
}

export function hasDirectToolOrigin(meta: unknown): boolean {
  if (!isRecord(meta)) return false;
  return isRecord(meta.goose) && meta.goose.directToolCall === true;
}

export function rawInputToArguments(rawInput: unknown): Record<string, unknown> {
  return isRecord(rawInput) ? rawInput : {};
}

export function toolIdentity(update: ToolCall | ToolCallUpdate): ToolIdentity {
  if (!isRecord(update._meta)) {
    return {};
  }

  const goose = update._meta.goose;
  if (!isRecord(goose) || !isRecord(goose.toolCall)) {
    return {};
  }

  return {
    toolName: typeof goose.toolCall.toolName === 'string' ? goose.toolCall.toolName : undefined,
    extensionName:
      typeof goose.toolCall.extensionName === 'string' ? goose.toolCall.extensionName : undefined,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
