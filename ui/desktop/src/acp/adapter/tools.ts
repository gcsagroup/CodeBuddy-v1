import type {
  ContentBlock as AcpContentBlock,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { Message, ToolResponseMessageContent } from '../../types/message';
import type { ContentBlock as GooseContentBlock } from '../../types/message';
import { findMessageForChunk } from './messages';
import { toolAuditReceiptFromMeta } from './toolAudit';
import { toolNotificationChange } from './toolNotifications';
import {
  type AcpChatStateChange,
  type AdapterState,
  DEFAULT_VISIBLE_MESSAGE_METADATA,
  type GooseMessageMeta,
  getGooseMessageMeta,
  isRecord,
  messagesChange,
  rawInputToArguments,
  toolIdentity,
  type ToolIdentity,
} from './shared';

export function applyToolCall(state: AdapterState, update: ToolCall): AcpChatStateChange[] {
  if (
    state.messages.some((message) =>
      message.content.some(
        (content) => content.type === 'toolRequest' && content.id === update.toolCallId
      )
    )
  ) {
    mergeToolCallSnapshot(state, update, true);
    if (update.status === 'completed' || update.status === 'failed')
      return applyInitialToolResult(state, update);
    return messagesChange(state);
  }
  const gooseMeta = getGooseMessageMeta(update);
  const identity = toolIdentity(update);
  // Preview notifications have no model message ID. Giving each call a stable
  // display identity prevents them being appended to the previous explanation
  // (or another pending operation), which hides live progress until completion.
  const preview = isRecord(update.rawInput) && update.rawInput.__inputPreview === true;
  const isolated = preview || identity.toolName === 'codepro__publish_progress';
  const message: Message = isolated
    ? {
        id: `tool-${update.toolCallId}`,
        role: 'assistant',
        created: gooseMeta.created ?? Math.floor(Date.now() / 1000),
        content: [],
        metadata: { ...DEFAULT_VISIBLE_MESSAGE_METADATA },
      }
    : getOrCreateAssistantMessageForUpdate(state, gooseMeta);
  if (isolated) state.messages.push(message);
  const metadata = toolRequestMetadata(update, identity);

  message.content.push({
    type: 'toolRequest',
    id: update.toolCallId,
    toolCall: {
      status: 'success',
      value: {
        name: identity.toolName ?? update.title,
        arguments: rawInputToArguments(update.rawInput),
      },
    },
    ...(metadata ? { metadata } : {}),
    ...(update._meta ? { _meta: update._meta } : {}),
  });

  return update.status === 'completed' || update.status === 'failed'
    ? applyInitialToolResult(state, update)
    : messagesChange(state);
}

function applyInitialToolResult(state: AdapterState, update: ToolCall): AcpChatStateChange[] {
  if (findToolResponse(state, update.toolCallId)) return messagesChange(state);
  // This snapshot's messageId identifies the assistant call, not a native
  // result message. Keep the result unbound until it has its own identity.
  const meta = { ...update._meta };
  if (isRecord(meta.goose)) {
    const goose = { ...meta.goose };
    delete goose.messageId;
    meta.goose = goose;
  }
  return applyToolCallUpdate(state, { ...update, _meta: meta });
}

export function applyToolCallUpdate(
  state: AdapterState,
  update: ToolCallUpdate
): AcpChatStateChange[] {
  const requestChanged = mergeToolCallSnapshot(state, update);
  if (update.status !== 'completed' && update.status !== 'failed') {
    const notificationChange = toolNotificationChange(update);
    return [
      ...(requestChanged ? messagesChange(state) : []),
      ...(notificationChange ? [notificationChange] : []),
    ];
  }

  const gooseMeta = getGooseMessageMeta(update);
  const previous = findToolResponse(state, update.toolCallId);
  const message = previous?.message ?? getOrCreateToolResponseMessageForUpdate(state, gooseMeta);
  const identity = toolIdentity(update);
  const metadata = { ...previous?.response.metadata, ...toolResponseMetadata(update, identity) };
  // ACP updates contain only changed fields. Preserve previous result fields
  // when a terminal update supplies its native identity or other metadata.
  const resultUpdate: ToolCallUpdate = {
    ...update,
    ...(update.content == null && Array.isArray(metadata.content)
      ? { content: metadata.content as ToolCallUpdate['content'] }
      : {}),
    ...(update.rawOutput === undefined && 'rawOutput' in metadata
      ? { rawOutput: metadata.rawOutput }
      : {}),
  };
  const resultStatus = update.status === 'failed' ? 'error' : 'success';
  const keepResult =
    previous?.response.toolResult.status === resultStatus &&
    resultUpdate.content == null &&
    resultUpdate.rawOutput === undefined &&
    !mcpAppMetadata(update);

  const response: ToolResponseMessageContent = {
    type: 'toolResponse',
    id: update.toolCallId,
    toolResult:
      keepResult && previous
        ? previous.response.toolResult
        : update.status === 'failed'
          ? { status: 'error', error: toolError(resultUpdate) }
          : {
              status: 'success',
              value: {
                ...(previous?.response.toolResult.status === 'success' &&
                isRecord(previous.response.toolResult.value)
                  ? previous.response.toolResult.value
                  : {}),
                ...toolResultValue(resultUpdate, mcpAppMetadata(update)),
              },
            },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  if (previous) {
    message.content = message.content.map((content) =>
      content === previous.response ? response : content
    );
    bindToolResponseIdentity(state, message, response, gooseMeta);
  } else {
    message.content.push(response);
  }

  return messagesChange(state);
}

function mergeToolCallSnapshot(
  state: AdapterState,
  update: ToolCall | ToolCallUpdate,
  bindAssistantIdentity = false
): boolean {
  const owner = state.messages.find((message) =>
    message.content.some(
      (content) => content.type === 'toolRequest' && content.id === update.toolCallId
    )
  );
  const request = owner?.content.find(
    (content) => content.type === 'toolRequest' && content.id === update.toolCallId
  );
  if (!request || request.type !== 'toolRequest' || request.toolCall.status !== 'success') {
    return false;
  }
  if (!isRecord(request.toolCall.value)) {
    return false;
  }
  // Previous React snapshots share nested values. Replace, never mutate them
  // while a streamed argument snapshot is arriving.
  const toolValue = { ...request.toolCall.value };
  const identity = toolIdentity(update);
  const metadata = baseToolMetadata(update, identity);
  let changed = false;
  const messageMeta = getGooseMessageMeta(update);
  if (bindAssistantIdentity && owner && !owner.id && messageMeta.messageId) {
    owner.id = messageMeta.messageId;
    owner.created = messageMeta.created ?? owner.created;
    changed = true;
  }
  if (metadata) {
    request.metadata = { ...request.metadata, ...metadata };
    changed = true;
  }
  const argumentsFromUpdate = rawInputToArguments(update.rawInput);
  if (update.rawInput !== undefined) {
    // A partial JSON fragment may temporarily be undecodable (or exceed the
    // preview budget). Keep the last display snapshot until real input arrives.
    const emptyPreview =
      argumentsFromUpdate.__inputPreview === true && Object.keys(argumentsFromUpdate).length === 1;
    if (!emptyPreview || !isRecord(toolValue.arguments)) {
      toolValue.arguments = argumentsFromUpdate;
    }
    changed = true;
  }
  const name = identity.toolName;
  if (name && name.toLowerCase() !== 'unknown' && toolValue.name !== name) {
    toolValue.name = name;
    changed = true;
  }
  if (changed) request.toolCall = { ...request.toolCall, value: toolValue };
  return changed;
}

function getOrCreateAssistantMessageForUpdate(
  state: AdapterState,
  gooseMeta: GooseMessageMeta
): Message {
  const existing = findMessageForChunk(state, 'assistant', gooseMeta.messageId, gooseMeta.created);
  if (existing) {
    return existing;
  }

  const message: Message = {
    ...(gooseMeta.messageId ? { id: gooseMeta.messageId } : {}),
    role: 'assistant',
    created: gooseMeta.created ?? Math.floor(Date.now() / 1000),
    content: [],
    metadata: { ...DEFAULT_VISIBLE_MESSAGE_METADATA },
  };
  state.messages.push(message);
  return message;
}

function getOrCreateToolResponseMessageForUpdate(
  state: AdapterState,
  gooseMeta: GooseMessageMeta
): Message {
  if (gooseMeta.messageId) {
    const existing = state.messages.find(
      (message) => message.id === gooseMeta.messageId && message.role === 'user'
    );
    if (existing) {
      return existing;
    }
  }

  const message: Message = {
    ...(gooseMeta.messageId ? { id: gooseMeta.messageId } : {}),
    role: 'user',
    created: gooseMeta.created ?? Math.floor(Date.now() / 1000),
    content: [],
    metadata: { ...DEFAULT_VISIBLE_MESSAGE_METADATA },
  };
  state.messages.push(message);
  return message;
}

function findToolResponse(
  state: AdapterState,
  toolCallId: string
): { message: Message; response: ToolResponseMessageContent } | undefined {
  for (const message of state.messages) {
    const response = message.content.find(
      (content): content is ToolResponseMessageContent =>
        content.type === 'toolResponse' && content.id === toolCallId
    );
    if (response) return { message, response };
  }
  return undefined;
}

function bindToolResponseIdentity(
  state: AdapterState,
  message: Message,
  response: ToolResponseMessageContent,
  gooseMeta: GooseMessageMeta
): void {
  if (message.id || !gooseMeta.messageId) return;
  const target = state.messages.find(
    (item) => item.role === 'user' && item.id === gooseMeta.messageId
  );
  if (!target && message.content.length === 1) {
    message.id = gooseMeta.messageId;
    message.created = gooseMeta.created ?? message.created;
    return;
  }
  const result = target ?? getOrCreateToolResponseMessageForUpdate(state, gooseMeta);
  message.content = message.content.filter((content) => content !== response);
  result.content.push(response);
  if (message.content.length === 0) {
    state.messages = state.messages.filter((item) => item !== message);
  }
}

function toolRequestMetadata(
  update: ToolCall,
  identity: ToolIdentity
): Record<string, unknown> | undefined {
  return baseToolMetadata(update, identity);
}

function toolResponseMetadata(
  update: ToolCallUpdate,
  identity: ToolIdentity
): Record<string, unknown> | undefined {
  const metadata = baseToolMetadata(update, identity) ?? {};
  const toolAudit = toolAuditReceiptFromMeta(update._meta);
  if (toolAudit) {
    metadata.toolAudit = toolAudit;
  }
  if (update.rawOutput !== undefined) {
    metadata.rawOutput = update.rawOutput;
  }
  if (update.content) {
    metadata.content = update.content;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function baseToolMetadata(
  update: ToolCall | ToolCallUpdate,
  identity: ToolIdentity
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};

  if (update.title) {
    metadata.title = update.title;
  }
  if (update.status) {
    metadata.status = update.status;
  }
  if (identity.extensionName) {
    metadata.extensionName = identity.extensionName;
  }
  if (update.kind) {
    metadata.kind = update.kind;
  }
  if (update.locations) {
    metadata.locations = update.locations;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function toolResultValue(
  update: ToolCallUpdate,
  mcpAppMeta: DesktopMcpAppMeta | undefined
): ToolResultValue {
  const toolResult: ToolResultValue = {
    content: toolResultContent(update),
    isError: false,
    ...(mcpAppMeta ? { _meta: mcpAppMeta } : {}),
  };

  if (update.rawOutput !== undefined) {
    toolResult.structuredContent = update.rawOutput;
  }

  return toolResult;
}

function toolResultContent(update: ToolCallUpdate): GooseContentBlock[] {
  const content: GooseContentBlock[] = [];

  for (const item of update.content ?? []) {
    if (item.type !== 'content') {
      continue;
    }

    const block = apiContentBlockFromAcpContentBlock(item.content);
    if (block) {
      content.push(block);
    }
  }

  if (content.length > 0) {
    return content;
  }

  if (typeof update.rawOutput === 'string') {
    return [{ type: 'text', text: update.rawOutput }];
  }

  return [];
}

function apiContentBlockFromAcpContentBlock(
  content: AcpContentBlock
): GooseContentBlock | undefined {
  switch (content.type) {
    case 'text':
      return {
        type: 'text',
        text: content.text,
        ...(content._meta ? { _meta: content._meta } : {}),
      };
    case 'image':
      return {
        type: 'image',
        data: content.data,
        mimeType: content.mimeType,
        ...(content._meta ? { _meta: content._meta } : {}),
      };
    case 'audio':
      return {
        type: 'audio',
        data: content.data,
        mimeType: content.mimeType,
      };
    case 'resource_link':
      return {
        type: 'resource_link',
        uri: content.uri,
        name: content.name,
        ...(content.description ? { description: content.description } : {}),
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        ...(content.size !== undefined && content.size !== null ? { size: content.size } : {}),
        ...(content.title ? { title: content.title } : {}),
        ...(content._meta ? { _meta: content._meta } : {}),
      };
    case 'resource':
      return {
        type: 'resource',
        resource: apiResourceContentsFromAcpResource(content.resource),
        ...(content._meta ? { _meta: content._meta } : {}),
      };
    default:
      return undefined;
  }
}

function apiResourceContentsFromAcpResource(
  resource: Extract<AcpContentBlock, { type: 'resource' }>['resource']
): Extract<GooseContentBlock, { type: 'resource' }>['resource'] {
  if ('text' in resource) {
    return {
      uri: resource.uri,
      text: resource.text,
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(resource._meta ? { _meta: resource._meta } : {}),
    };
  }

  return {
    uri: resource.uri,
    blob: resource.blob,
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(resource._meta ? { _meta: resource._meta } : {}),
  };
}

function toolError(update: ToolCallUpdate): string {
  if (typeof update.rawOutput === 'string' && update.rawOutput.trim()) {
    return update.rawOutput;
  }

  const contentText = toolResultContent(update)
    .flatMap((content) => (content.type === 'text' ? [content.text] : []))
    .filter((text) => text.trim().length > 0)
    .join('\n');
  if (contentText) {
    return contentText;
  }

  return update.title ?? 'Tool call failed';
}

interface DesktopMcpAppMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
  };
  extensionName?: string;
  toolName?: string;
}

type ToolResultValue = {
  content: GooseContentBlock[];
  structuredContent?: unknown;
  isError: boolean;
  _meta?: DesktopMcpAppMeta;
};

function mcpAppMetadata(update: ToolCallUpdate): DesktopMcpAppMeta | undefined {
  if (!isRecord(update._meta)) {
    return undefined;
  }

  const goose = update._meta.goose;
  if (!isRecord(goose) || !isRecord(goose.mcpApp)) {
    return undefined;
  }

  const resourceUri = goose.mcpApp.resourceUri;
  if (typeof resourceUri !== 'string') {
    return undefined;
  }

  return {
    ui: {
      resourceUri,
    },
    extensionName:
      typeof goose.mcpApp.extensionName === 'string' ? goose.mcpApp.extensionName : undefined,
    toolName: typeof goose.mcpApp.toolName === 'string' ? goose.mcpApp.toolName : undefined,
  };
}
