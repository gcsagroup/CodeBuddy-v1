import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import {
  type AcpChatStateChange,
  type AdapterState,
  DEFAULT_VISIBLE_MESSAGE_METADATA,
  messagesChange,
  rawInputToArguments,
  isRecord,
  toolIdentity,
} from './shared';
import type {
  ToolAuthorizationScope,
  ToolExtensionSource,
  ToolPermissionAction,
  ToolPermissionClass,
} from '../../types/message';

const PERMISSION_CLASSES = new Set<ToolPermissionClass>([
  'read_only',
  'workspace_write',
  'external_write',
  'high_risk',
  'forbidden',
  'legacy',
]);
const EXTENSION_SOURCES = new Set<ToolExtensionSource>([
  'platform',
  'builtin',
  'external_stdio',
  'external_http',
  'frontend',
  'inline_python',
  'unknown',
]);
const AUTHORIZATION_SCOPES = new Set<ToolAuthorizationScope>([
  'task',
  'session',
  'global',
  'unknown',
]);

export function applyPermissionRequest(
  state: AdapterState,
  request: RequestPermissionRequest
): AcpChatStateChange[] {
  const toolCallId = request.toolCall.toolCallId;
  const existing = state.messages.some((message) =>
    message.content.some(
      (content) =>
        content.type === 'actionRequired' &&
        content.data.actionType === 'toolConfirmation' &&
        content.data.id === toolCallId
    )
  );
  if (existing) {
    return messagesChange(state);
  }

  const identity = toolIdentity(request.toolCall);
  const prompt = permissionPrompt(request);
  const permissionContext = parsePermissionContext(request._meta);
  const availableActions = permissionActions(request, permissionContext.permissionClass);

  state.messages.push({
    id: `acp_permission_${toolCallId}`,
    role: 'assistant',
    created: Math.floor(Date.now() / 1000),
    content: [
      {
        type: 'actionRequired',
        data: {
          actionType: 'toolConfirmation',
          id: toolCallId,
          toolName: identity.toolName ?? request.toolCall.title ?? toolCallId,
          arguments: rawInputToArguments(request.toolCall.rawInput),
          ...permissionContext,
          availableActions,
          ...(prompt ? { prompt } : {}),
        },
      },
    ],
    metadata: { ...DEFAULT_VISIBLE_MESSAGE_METADATA },
  });

  return messagesChange(state);
}

function parsePermissionContext(meta: unknown): {
  permissionClass: ToolPermissionClass;
  extensionSource: ToolExtensionSource;
  authorizationScope: ToolAuthorizationScope;
  taskWorkspaceRoot?: string;
} {
  const codepro = isRecord(meta) && isRecord(meta.codepro) ? meta.codepro : {};
  return {
    permissionClass:
      typeof codepro.permissionClass === 'string' &&
      PERMISSION_CLASSES.has(codepro.permissionClass as ToolPermissionClass)
        ? (codepro.permissionClass as ToolPermissionClass)
        : 'legacy',
    extensionSource:
      typeof codepro.extensionSource === 'string' &&
      EXTENSION_SOURCES.has(codepro.extensionSource as ToolExtensionSource)
        ? (codepro.extensionSource as ToolExtensionSource)
        : 'unknown',
    authorizationScope:
      typeof codepro.authorizationScope === 'string' &&
      AUTHORIZATION_SCOPES.has(codepro.authorizationScope as ToolAuthorizationScope)
        ? (codepro.authorizationScope as ToolAuthorizationScope)
        : 'unknown',
    taskWorkspaceRoot:
      typeof codepro.taskWorkspaceRoot === 'string' && codepro.taskWorkspaceRoot.trim()
        ? codepro.taskWorkspaceRoot
        : undefined,
  };
}

function permissionActions(
  request: RequestPermissionRequest,
  permissionClass: ToolPermissionClass
): ToolPermissionAction[] {
  const actions = new Set<ToolPermissionAction>();
  for (const option of request.options) {
    switch (option.kind) {
      case 'allow_once':
        if (permissionClass !== 'forbidden') actions.add('allow_once');
        break;
      case 'allow_always':
        if (permissionClass !== 'forbidden') actions.add('always_allow');
        break;
      case 'reject_once':
        actions.add('deny_once');
        break;
      case 'reject_always':
        actions.add('always_deny');
        break;
    }
  }
  return [...actions];
}

function permissionPrompt(request: RequestPermissionRequest): string | undefined {
  for (const content of request.toolCall.content ?? []) {
    if (content.type === 'content' && content.content.type === 'text') {
      return content.content.text;
    }
  }

  return undefined;
}
