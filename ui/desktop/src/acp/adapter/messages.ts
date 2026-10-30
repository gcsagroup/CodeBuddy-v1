import type {
  ContentBlock as AcpContentBlock,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { insertPresentedUserMessage, type ContentBlock, type Message } from '../../types/message';
import {
  type AcpChatStateChange,
  type AdapterState,
  DEFAULT_VISIBLE_MESSAGE_METADATA,
  getGooseMessageMeta,
  messagesChange,
} from './shared';

type StreamedContentBlock = Extract<ContentBlock, { type: 'text' | 'image' }>;

export function applyContentChunk(
  state: AdapterState,
  role: Message['role'],
  update: Extract<
    SessionNotification['update'],
    { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' }
  >
): AcpChatStateChange[] {
  const content = messageContentFromAcpContentBlock(update.content);
  if (!content) {
    return [];
  }

  const gooseMeta = getGooseMessageMeta(update);
  const messageId = update.messageId ?? gooseMeta.messageId;
  const existing = findMessageForChunk(state, role, messageId, gooseMeta.created);

  if (existing) {
    const lastContent = existing.content[existing.content.length - 1];
    if (reconcileLocalSteerTextChunk(state, existing, content, gooseMeta.steer)) {
      return messagesChangeWithLocalSteerConfirmation(state, existing, gooseMeta.steer);
    }
    if (
      role === 'user' &&
      messageId &&
      !existing.metadata.steer &&
      content.type === 'text' &&
      existing.content
        .filter((item) => item.type === 'text')
        .some((item) => item.text === content.text)
    ) {
      return messagesChangeWithLocalSteerConfirmation(state, existing, gooseMeta.steer);
    }

    if (lastContent?.type === 'text' && content.type === 'text') {
      lastContent.text += content.text;
    } else if (content.type === 'image' && hasImageContent(existing, content)) {
      return messagesChangeWithLocalSteerConfirmation(state, existing, gooseMeta.steer);
    } else {
      existing.content.push(content);
    }

    return messagesChangeWithLocalSteerConfirmation(state, existing, gooseMeta.steer);
  } else {
    const message: Message = {
      ...(messageId ? { id: messageId } : {}),
      role,
      created: gooseMeta.created ?? Math.floor(Date.now() / 1000),
      content: [content],
      metadata: {
        ...DEFAULT_VISIBLE_MESSAGE_METADATA,
        ...(gooseMeta.steer ? { steer: true } : {}),
        ...(role === 'user' && gooseMeta.scheduled ? { scheduled: true } : {}),
        ...(role === 'user' && gooseMeta.presentation
          ? { presentation: gooseMeta.presentation }
          : {}),
      },
    };
    if (role === 'user') state.messages = insertPresentedUserMessage(state.messages, message);
    else state.messages.push(message);
    return messagesChange(state, message, true);
  }
}

export function applyThoughtChunk(
  state: AdapterState,
  update: Extract<SessionNotification['update'], { sessionUpdate: 'agent_thought_chunk' }>
): AcpChatStateChange[] {
  if (update.content.type !== 'text') {
    return [];
  }

  const gooseMeta = getGooseMessageMeta(update);
  const messageId = update.messageId ?? gooseMeta.messageId;
  const existing = findMessageForChunk(state, 'assistant', messageId, gooseMeta.created);

  if (existing) {
    const lastContent = existing.content[existing.content.length - 1];
    if (lastContent?.type === 'thinking') {
      lastContent.thinking += update.content.text;
    } else {
      existing.content.push({ type: 'thinking', thinking: update.content.text, signature: '' });
    }
  } else {
    const message: Message = {
      ...(messageId ? { id: messageId } : {}),
      role: 'assistant',
      created: gooseMeta.created ?? Math.floor(Date.now() / 1000),
      content: [{ type: 'thinking', thinking: update.content.text, signature: '' }],
      metadata: { ...DEFAULT_VISIBLE_MESSAGE_METADATA },
    };
    state.messages.push(message);
    return messagesChange(state, message, true);
  }

  return messagesChange(state, existing);
}

function messageContentFromAcpContentBlock(
  content: AcpContentBlock
): StreamedContentBlock | undefined {
  switch (content.type) {
    case 'text':
      return {
        type: 'text',
        text: content.text,
        ...(content._meta ? { _meta: content._meta } : {}),
        ...(content.annotations ? { annotations: content.annotations } : {}),
      };
    case 'image':
      return {
        type: 'image',
        data: content.data,
        mimeType: content.mimeType,
        ...(content._meta ? { _meta: content._meta } : {}),
        ...(content.annotations ? { annotations: content.annotations } : {}),
      };
    default:
      return undefined;
  }
}

export function findMessageForChunk(
  state: AdapterState,
  role: Message['role'],
  messageId: string | undefined,
  created: number | undefined
): Message | undefined {
  if (!messageId) {
    return lastMergeableMessageWithRole(state, role);
  }

  const existing = state.messages.find(
    (message) => message.id === messageId && message.role === role
  );
  if (existing) {
    if (
      existing.content.length === 0 &&
      existing.metadata.usage &&
      !existing.metadata.userVisible &&
      !existing.metadata.agentVisible
    ) {
      // A receipt arrived before this content. Preserve the legacy adoption
      // of an adjacent anonymous chunk, without creating another visible row.
      const index = state.messages.indexOf(existing);
      const previous = state.messages[index - 1];
      if (
        index === state.messages.length - 1 &&
        previous?.role === role &&
        !previous.id &&
        previous.metadata.agentVisible
      ) {
        state.messages.splice(index, 1);
        previous.id = messageId;
        previous.created = created ?? previous.created;
        previous.metadata = { ...previous.metadata, usage: existing.metadata.usage };
        return previous;
      }
      existing.created = created ?? existing.created;
      existing.metadata = { ...existing.metadata, ...DEFAULT_VISIBLE_MESSAGE_METADATA };
    }
    return existing;
  }

  const pending = lastMergeableMessageWithRole(state, role);
  if (pending && !pending.id) {
    pending.id = messageId;
    pending.created = created ?? pending.created;
    return pending;
  }

  return undefined;
}

function lastMergeableMessageWithRole(
  state: AdapterState,
  role: Message['role']
): Message | undefined {
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage?.role !== role || lastMessage.metadata.agentVisible === false) {
    return undefined;
  }
  return lastMessage;
}

function hasImageContent(
  message: Message,
  image: Extract<StreamedContentBlock, { type: 'image' }>
) {
  return message.content.some(
    (content) =>
      content.type === 'image' && content.data === image.data && content.mimeType === image.mimeType
  );
}

function messagesChangeWithLocalSteerConfirmation(
  state: AdapterState,
  message: Message,
  isSteerChunk: boolean | undefined
): AcpChatStateChange[] {
  const changes = messagesChange(state, message);
  if (isSteerChunk && message.metadata.steer && message.role === 'user' && message.id) {
    changes.push({ type: 'localSteerConfirmed', messageId: message.id });
  }
  return changes;
}

function reconcileLocalSteerTextChunk(
  state: AdapterState,
  message: Message,
  content: StreamedContentBlock,
  isSteerChunk: boolean | undefined
): boolean {
  if (!isSteerChunk || !message.metadata.steer || message.role !== 'user') {
    return false;
  }

  if (
    content.type !== 'text' ||
    message.content.length === 0 ||
    message.content[0].type !== 'text'
  ) {
    return false;
  }

  const text = (message.id ? state.localSteerTextByMessageId.get(message.id) : undefined) ?? '';
  const nextText = text + content.text;
  if (message.id) {
    state.localSteerTextByMessageId.set(message.id, nextText);
  }

  message.content = [{ ...content, text: nextText }, ...message.content.slice(1)];
  message.metadata = { ...message.metadata, steer: true };
  return true;
}
