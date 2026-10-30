import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { BUSINESS_SESSION_OPTION, readBusinessApproval } from '../../types/businessApproval';
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
  const businessApproval = request.options.some(
    (option) => option.optionId === BUSINESS_SESSION_OPTION
  )
    ? readBusinessApproval(request._meta)
    : undefined;
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
          ...(businessApproval ? { businessApproval } : {}),
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
  authorizationGroup?: 'computer_control' | 'mcp_module' | 'web_read';
  authorizationModule?: { name: string; displayName: string };
  authorizationTarget?: string;
  taskWorkspaceRoot?: string;
} {
  const codepro = isRecord(meta) && isRecord(meta.codepro) ? meta.codepro : {};
  const module = codepro.authorizationModule;
  const moduleValid =
    isRecord(module) &&
    typeof module.name === 'string' &&
    /^[A-Za-z0-9_-]{1,32}$/.test(module.name) &&
    typeof module.displayName === 'string' &&
    module.displayName.trim().length > 0 &&
    module.displayName.length <= 160;
  const moduleContext =
    codepro.authorizationScope === 'session' &&
    codepro.authorizationGroup === 'mcp_module' &&
    moduleValid
      ? {
          authorizationGroup: 'mcp_module' as const,
          authorizationModule: {
            name: module.name as string,
            displayName: module.displayName as string,
          },
        }
      : {};

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
    ...moduleContext,
    ...(codepro.authorizationScope === 'session' && codepro.authorizationGroup === 'web_read' && codepro.permissionClass === 'read_only'
      ? { authorizationGroup: 'web_read' as const } : {}),
    ...(codepro.authorizationScope === 'session' &&
    typeof codepro.authorizationTarget === 'string' &&
    codepro.authorizationTarget.length <= 2048
      ? { authorizationTarget: codepro.authorizationTarget }
      : {}),
    taskWorkspaceRoot:
      typeof codepro.taskWorkspaceRoot === 'string' && codepro.taskWorkspaceRoot.trim()
        ? codepro.taskWorkspaceRoot
        : undefined,
    ...(codepro.authorizationScope === 'session' &&
    codepro.authorizationGroup === 'computer_control'
      ? { authorizationGroup: 'computer_control' as const }
      : {}),
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
        if (option.optionId === BUSINESS_SESSION_OPTION && !readBusinessApproval(request._meta))
          break;
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
