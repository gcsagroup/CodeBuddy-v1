import { computerToolOutcome } from './computerToolOutcome';
import { GeneratedMedia } from './GeneratedMedia';
import { fileChangeReceipt, FileChangeCount } from './codepro/CodeProFileChange';
import {
  CodeProPlan,
  CodeProToolContent,
  hasReadableToolContent,
  isPlanTool,
  isProgressTool,
  toolPlanContent,
} from './codepro/CodeProToolContent';
import { AppEvents } from '../constants/events';
import { ToolIconWithStatus, ToolCallStatus } from './ToolCallStatusIndicator';
import { getToolCallIcon } from '../utils/toolIconMapping';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  isAcpPermissionRequestPending,
  subscribeAcpPermissionRequests,
} from '../acp/permissionRequests';
import { openSubagentConversation } from '../workspace-panel/subagentPanel';
import { openConversationChange } from '../workspace-panel/conversationChangePanel';
import { openWorkspaceFile } from '../workspace-panel/workspaceFilePanel';
import { ToolCallArguments, ToolCallArgumentValue } from './ToolCallArguments';
import MarkdownContent from './MarkdownContent';
import {
  ToolRequestMessageContent,
  ToolResponseMessageContent,
  NotificationEvent,
  ToolConfirmationData,
} from '../types/message';
import { cn } from '../utils';
import {
  formatToolAction,
  formatToolCompleted,
  isTaskContractCheck,
  isWebSearchTool,
  toolFilePath,
  webSearchDetails,
} from './toolActionPresentation';
import type { LoadingStatus as ExecutionLoadingStatus } from './ui/Dot';
import { SubagentAvatar } from './SubagentAvatar';
import { TooltipWrapper } from './settings/providers/subcomponents/buttons/TooltipWrapper';
import { ToolCallExpandable } from './ToolCallExpandable';
import { ToolActivityIcon } from './ToolActivityIcon';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ContentBlock } from '../types/message';
import { parseToolAuditReceipt } from '../acp/adapter/toolAudit';

import McpAppRenderer from './McpApps/McpAppRenderer';
import ToolApprovalButtons from './ToolApprovalButtons';
import BusinessApprovalScope from './BusinessApprovalScope';
import { ToolApprovalTarget } from './ToolCallConfirmation';
import { ToolAuditDetails, ToolAuditSummary } from './ToolAuditReceiptView';
import { defineMessages, useIntl } from '../i18n';
import { formatCodeProActivityState } from './codepro/codeProPresentation';
import ProjectMemoryApprovalSummary, {
  filterProjectMemoryApprovalActions,
  parseProjectMemoryApproval,
} from './ProjectMemoryApprovalSummary';

type LoadingStatus = ExecutionLoadingStatus | 'unknown' | 'cancelled' | 'pending';

export function resolveToolLoadingStatus(
  toolResponse: ToolResponseMessageContent | undefined,
  isStreamingMessage: boolean,
  toolRequest?: ToolRequestMessageContent
): LoadingStatus {
  if (!toolResponse) return isStreamingMessage ? 'loading' : 'unknown';
  const result = toolResponse.toolResult;
  if (!result || typeof result !== 'object') return 'unknown';
  if (result.status === 'error') return 'error';
  if (result.status !== 'success') return 'unknown';
  const value = result.value;
  if (!value || typeof value !== 'object') return 'unknown';
  if ('isError' in value && value.isError === true) return 'error';
  const call = toolRequest?.toolCall.status === 'success' ? toolRequest.toolCall.value : undefined;
  const output = 'structuredContent' in value ? value.structuredContent : undefined;
  if (
    toolRequest?.metadata?.extensionName === 'harness' &&
    call !== null &&
    typeof call === 'object' &&
    'name' in call &&
    (call.name === 'pwsh' || call.name === 'bash') &&
    output !== null &&
    typeof output === 'object' &&
    'kind' in output &&
    output.kind === 'foreground' &&
    'exitCode' in output &&
    typeof output.exitCode === 'number' &&
    Number.isInteger(output.exitCode) &&
    output.exitCode !== 0
  ) {
    // A successful tool transport can still return a failed foreground command.
    return 'error';
  }
  return 'content' in value && Array.isArray(value.content) ? 'success' : 'unknown';
}

const i18n = defineMessages({
  unsuccessful: { id: 'operation.unsuccessful', defaultMessage: 'Unsuccessful' },
  desktopStopped: { id: 'toolCallWithResponse.desktopStopped', defaultMessage: 'Computer control stopped' },
  desktopPaused: { id: 'toolCallWithResponse.desktopPaused', defaultMessage: 'Desktop control paused' },
  desktopStale: { id: 'toolCallWithResponse.desktopStale', defaultMessage: 'Observation expired; observe again' },
  desktopWithdrawn: { id: 'toolCallWithResponse.desktopWithdrawn', defaultMessage: 'Withdrawn from desktop queue' },
  searchQuery: { id: 'toolCallWithResponse.searchQuery', defaultMessage: 'Query' },
  searchSources: { id: 'toolCallWithResponse.searchSources', defaultMessage: 'Sources' },
  searchResponse: { id: 'toolCallWithResponse.searchResponse', defaultMessage: 'Search response' },
  diagnostics: { id: 'operation.diagnostics', defaultMessage: 'Diagnostic record' },
  checkNotAccepted: {
    id: 'toolCallWithResponse.checkNotAccepted',
    defaultMessage: 'Not accepted, view details',
  },
  checkResultScope: {
    id: 'toolCallWithResponse.checkResultScope',
    defaultMessage:
      'This task-check call did not succeed. The reason is below; this is not the overall task result.',
  },
  draft: {
    id: 'operation.draft',
    defaultMessage: 'Generating content — not executed or saved yet',
  },
  draftStopped: {
    id: 'operation.draftStopped',
    defaultMessage: 'Generation stopped — execution was not confirmed',
  },
  modelPlan: {
    id: 'toolCallWithResponse.modelPlan',
    defaultMessage: 'Model plan',
  },
  viewSubagentSession: {
    id: 'toolCallWithResponse.viewSubagentSession',
    defaultMessage: 'View subagent session',
  },
  subagentStarted: {
    id: 'toolCallWithResponse.subagentStarted',
    defaultMessage: 'Started {name}',
  },
  subagentBudget: {
    id: 'toolCallWithResponse.subagentBudget',
    defaultMessage: 'Partial result, delegated work limit reached',
  },
  subagentUnavailable: {
    id: 'toolCallWithResponse.subagentUnavailable',
    defaultMessage: 'Partial result, model service unavailable',
  },
  toolDetails: {
    id: 'toolCallWithResponse.toolDetails',
    defaultMessage: 'Tool Details',
  },
  code: {
    id: 'toolCallWithResponse.code',
    defaultMessage: 'Code',
  },
  output: {
    id: 'toolCallWithResponse.output',
    defaultMessage: 'Output',
  },
  toolResultAlt: {
    id: 'toolCallWithResponse.toolResultAlt',
    defaultMessage: 'Tool result',
  },
  activityCount: {
    id: 'toolCallWithResponse.activityCount',
    defaultMessage: 'Activity ({count})',
  },
  logs: {
    id: 'toolCallWithResponse.logs',
    defaultMessage: 'Logs',
  },
  loadingSpinner: {
    id: 'toolCallWithResponse.loadingSpinner',
    defaultMessage: 'Loading spinner',
  },
});

interface ToolGraphNode {
  tool: string;
  description: string;
  depends_on: number[];
}

type UiMeta = {
  extensionName?: string;
  toolName?: string;
  ui?: {
    resourceUri?: string;
  };
  subagent_session_id?: string;
  terminal_outcome?: 'completed' | 'action_budget_exhausted' | 'provider_unavailable';
};

type ToolResultValue = {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError: boolean;
  _meta?: UiMeta;
};

type ToolResultWithMeta = {
  status?: string;
  value?: ToolResultValue & {
    _meta?: UiMeta;
  };
};

type ToolRequestWithMeta = ToolRequestMessageContent & {
  _meta?: UiMeta;
  toolCall: {
    status: 'success';
    value: {
      name: string;
      arguments?: Record<string, unknown>;
    };
  };
};

interface ToolCallWithResponseProps {
  showGeneratedMedia?: boolean;
  computerTarget?: string;
  planActive?: boolean;
  compact?: boolean;
  sessionId?: string;
  isCancelledMessage: boolean;
  toolRequest: ToolRequestMessageContent;
  toolResponse?: ToolResponseMessageContent;
  notifications?: NotificationEvent[];
  isStreamingMessage?: boolean;
  isPendingApproval: boolean;
  append?: (value: string) => void;
  confirmationContent?: ToolConfirmationData;
  isApprovalClicked?: boolean;
}

function getSubagentSessionId(
  toolResponse?: ToolResponseMessageContent,
  notifications?: NotificationEvent[]
): string | null {
  const result = toolResponse?.toolResult as ToolResultWithMeta | undefined;
  const sessionId =
    result?.status === 'success' ? result?.value?._meta?.subagent_session_id : undefined;
  if (typeof sessionId === 'string') return sessionId;
  const native = toolResponse?.metadata?.rawOutput;
  if (
    native &&
    typeof native === 'object' &&
    'kind' in native &&
    native.kind === 'activation' &&
    'subagentId' in native &&
    typeof native.subagentId === 'string'
  )
    return native.subagentId;

  // Fallback: extract from subagent notifications (e.g. when delegate was cancelled mid-stream)
  if (notifications) {
    for (const n of notifications) {
      const message = n.message as { method?: string; params?: Record<string, unknown> };
      if (message.method !== 'notifications/message') continue;
      const data = message.params?.data;
      if (data && typeof data === 'object' && 'type' in data && 'subagent_id' in data) {
        const record = data as Record<string, unknown>;
        if (record.type === 'subagent_tool_request' && typeof record.subagent_id === 'string') {
          return record.subagent_id;
        }
      }
    }
  }

  return null;
}

function getToolResultContent(toolResult: Record<string, unknown>): ContentBlock[] {
  if (toolResult.status !== 'success') {
    return typeof toolResult.error === 'string' ? [{ type: 'text', text: toolResult.error }] : [];
  }
  const value = toolResult.value as ToolResultValue | undefined;
  if (!value || !Array.isArray(value.content)) return [];
  return value.content.filter((item) => {
    const annotations = (item as { annotations?: { audience?: string[] } }).annotations;
    return !annotations?.audience || annotations.audience.includes('user');
  });
}

interface McpAppWrapperProps {
  toolRequest: ToolRequestMessageContent;
  toolResponse?: ToolResponseMessageContent;
  sessionId: string;
  append?: (value: string) => void;
}

function McpAppWrapper({
  toolRequest,
  toolResponse,
  sessionId,
  append,
}: McpAppWrapperProps): React.ReactNode {
  const requestWithMeta = toolRequest as ToolRequestWithMeta;
  const resultWithMeta = toolResponse?.toolResult as ToolResultWithMeta | undefined;
  const appMeta = resultWithMeta?.value?._meta ?? requestWithMeta._meta;
  let resourceUri = requestWithMeta._meta?.ui?.resourceUri;

  if (!resourceUri && toolResponse) {
    const resultWithMeta = toolResponse.toolResult as ToolResultWithMeta;
    if (resultWithMeta?.status === 'success' && resultWithMeta.value) {
      resourceUri = resultWithMeta.value._meta?.ui?.resourceUri;
    }
  }

  // Tool names are formatted as "{extension_name}__{tool_name}".
  // Extension names can contain underscores (special chars like parentheses are normalized to "_"),
  // so we must use lastIndexOf to find the delimiter.
  // e.g., "my_server(local)" -> "my_server_local_" -> "my_server_local___get_time"
  const toolCallName =
    requestWithMeta.toolCall.status === 'success' ? requestWithMeta.toolCall.value.name : '';
  const delimiterIndex = toolCallName.lastIndexOf('__');
  const extensionName =
    appMeta?.extensionName ??
    (delimiterIndex === -1 ? '' : toolCallName.substring(0, delimiterIndex));
  const toolName =
    appMeta?.toolName ??
    (delimiterIndex === -1 ? toolCallName : toolCallName.substring(delimiterIndex + 2));

  const toolArguments =
    requestWithMeta.toolCall.status === 'success'
      ? requestWithMeta.toolCall.value.arguments
      : undefined;

  const toolInput = { arguments: toolArguments || {} };

  const toolResult =
    resultWithMeta?.status === 'success' && resultWithMeta.value
      ? (resultWithMeta.value as unknown as CallToolResult)
      : undefined;

  if (!resourceUri) return null;
  if (requestWithMeta.toolCall.status !== 'success') return null;

  return (
    <div className="mt-3">
      <McpAppRenderer
        resourceUri={resourceUri}
        toolInput={toolInput}
        toolResult={toolResult}
        extensionName={extensionName}
        toolName={toolName}
        sessionId={sessionId}
        append={append}
      />
    </div>
  );
}

export default function ToolCallWithResponse({
  showGeneratedMedia = true,
  computerTarget,
  planActive,
  compact = false,
  sessionId,
  isCancelledMessage,
  toolRequest,
  toolResponse,
  notifications,
  isStreamingMessage,
  isPendingApproval: requestedApproval,
  append,
  confirmationContent,
  isApprovalClicked,
}: ToolCallWithResponseProps) {
  const liveApproval = useSyncExternalStore(
    subscribeAcpPermissionRequests,
    () =>
      !!sessionId &&
      isAcpPermissionRequestPending(sessionId, confirmationContent?.id ?? toolRequest.id)
  );
  const isPendingApproval = requestedApproval && liveApproval;
  // Handle both the wrapped ToolResult format and the unwrapped format
  // The server serializes ToolResult<T> as { status: "success", value: T } or { status: "error", error: string }
  const toolCallData = toolRequest.toolCall as Record<string, unknown>;
  const toolCall =
    toolCallData?.status === 'success'
      ? (toolCallData.value as { name: string; arguments: Record<string, unknown> })
      : (toolCallData as { name: string; arguments: Record<string, unknown> });

  if (!toolCall || !toolCall.name) {
    return null;
  }

  const requestWithMeta = toolRequest as ToolRequestWithMeta;
  const resultWithMeta = toolResponse?.toolResult as ToolResultWithMeta;
  const hasMcpAppResourceURI = Boolean(
    requestWithMeta._meta?.ui?.resourceUri || resultWithMeta?.value?._meta?.ui?.resourceUri
  );

  const shouldShowMcpContent = !isPendingApproval;

  const showInlineApproval = isPendingApproval && confirmationContent && sessionId;
  const memoryApproval = confirmationContent
    ? parseProjectMemoryApproval(
        confirmationContent.toolName,
        confirmationContent.extensionSource ?? 'unknown',
        confirmationContent.arguments
      )
    : { kind: 'not_applicable' as const };
  const filteredApprovalActions = confirmationContent
    ? filterProjectMemoryApprovalActions(memoryApproval, confirmationContent.availableActions)
    : undefined;

  return (
    <>
      <div
        className={cn(
          'w-full text-sm font-sans overflow-hidden',
          showInlineApproval
            ? 'rounded-2xl border border-border-primary bg-background-primary p-2'
            : compact
              ? 'text-text-secondary'
              : 'rounded-lg border border-border-primary'
        )}
      >
        <ToolCallView
          {...{
            computerTarget,
            sessionId,
            planActive,
            isCancelledMessage,
            compact,
            displayTitle:
              typeof toolRequest.metadata?.title === 'string'
                ? toolRequest.metadata.title
                : undefined,
            isPendingApproval,
            requestId: toolRequest.id,
            toolRequest,
            toolCall,
            toolResponse,
            notifications,
            isStreamingMessage,
          }}
        />
        {/* Inline approval UI */}
        {showGeneratedMedia && sessionId && !isPendingApproval && (
          <GeneratedMedia sessionId={sessionId} toolName={toolCall.name} response={toolResponse} />
        )}
        {showInlineApproval && (
          <div className="px-2 pb-2">
            {confirmationContent.prompt && (
              <div className="py-2 text-sm font-medium text-text-primary">
                {confirmationContent.prompt}
              </div>
            )}
            <div>
              <ToolApprovalTarget
                toolName={confirmationContent.toolName}
                argumentsValue={confirmationContent.arguments}
              />
              {confirmationContent.businessApproval && (
                <BusinessApprovalScope approval={confirmationContent.businessApproval} />
              )}
              <ProjectMemoryApprovalSummary result={memoryApproval} />
              <ToolApprovalButtons
                data={{
                  id: confirmationContent.id,
                  toolName: confirmationContent.toolName,
                  prompt: confirmationContent.prompt ?? undefined,
                  sessionId,
                  isClicked: isApprovalClicked,
                  permissionClass: confirmationContent.permissionClass,
                  authorizationScope: confirmationContent.authorizationScope,
                  authorizationGroup: confirmationContent.authorizationGroup,
                  authorizationModule: confirmationContent.authorizationModule,
                  authorizationTarget: confirmationContent.authorizationTarget,
                  businessApproval: confirmationContent.businessApproval,
                  availableActions: filteredApprovalActions,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* MCP App */}
      {shouldShowMcpContent && hasMcpAppResourceURI && sessionId && (
        <McpAppWrapper
          toolRequest={toolRequest}
          toolResponse={toolResponse}
          sessionId={sessionId}
          append={append}
        />
      )}
    </>
  );
}

interface ToolCallViewProps {
  computerTarget?: string;
  sessionId?: string;
  planActive?: boolean;
  compact?: boolean;
  displayTitle?: string;
  requestId: string;
  toolRequest: ToolRequestMessageContent;
  isPendingApproval: boolean;
  isCancelledMessage: boolean;
  toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  };
  toolResponse?: ToolResponseMessageContent;
  notifications?: NotificationEvent[];
  isStreamingMessage?: boolean;
}

interface Progress {
  progress: number;
  progressToken: string;
  total?: number;
  message?: string;
}

interface SubagentToolRequestData {
  type: 'subagent_tool_request';
  subagent_id: string;
  tool_call: {
    name: string;
    arguments?: { tool_graph?: ToolGraphNode[] };
  };
}

const isSubagentToolRequestData = (data: unknown): data is SubagentToolRequestData => {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const record = data as Record<string, unknown>;
  if (record.type !== 'subagent_tool_request') {
    return false;
  }
  if (typeof record.subagent_id !== 'string') {
    return false;
  }
  if (!record.tool_call || typeof record.tool_call !== 'object') {
    return false;
  }
  const toolCall = record.tool_call as Record<string, unknown>;
  return typeof toolCall.name === 'string';
};

const formatSubagentToolCall = (data: SubagentToolRequestData): string => {
  const subagentId = data.subagent_id;
  const toolCall = data.tool_call;
  const toolCallName = toolCall.name;

  const shortId = subagentId?.split('_').pop() || subagentId;

  const parts = toolCallName.split('__').reverse();
  const toolName = parts[0] || 'unknown';
  const extensionName = parts.slice(1).reverse().join('__') || '';
  const toolGraph = toolCall.arguments?.tool_graph;

  if (toolName === 'execute_typescript' && toolGraph && toolGraph.length > 0) {
    const plural = toolGraph.length === 1 ? '' : 's';
    const header = `[subagent:${shortId}] ${toolGraph.length} tool call${plural} | execute_typescript`;
    const lines = toolGraph.map((node, idx) => {
      const deps =
        node.depends_on && node.depends_on.length > 0
          ? ` (uses ${node.depends_on.map((d) => d + 1).join(', ')})`
          : '';
      return `  ${idx + 1}. ${node.tool}: ${node.description}${deps}`;
    });
    return [header, ...lines].join('\n');
  }

  return extensionName
    ? `[subagent:${shortId}] ${toolName} | ${extensionName}`
    : `[subagent:${shortId}] ${toolName}`;
};

const logToString = (logMessage: NotificationEvent) => {
  const message = logMessage.message as { method: string; params: unknown };
  const params = message.params as Record<string, unknown>;

  if (
    params &&
    params.data &&
    typeof params.data === 'object' &&
    'type' in params.data &&
    params.data.type === 'subagent_tool_request'
  ) {
    if (isSubagentToolRequestData(params.data)) {
      return formatSubagentToolCall(params.data);
    }
  }

  // Special case for the developer system shell logs
  if (
    params &&
    params.data &&
    typeof params.data === 'object' &&
    'output' in params.data &&
    'stream' in params.data
  ) {
    return `[${params.data.stream}] ${params.data.output}`;
  }

  return typeof params.data === 'string' ? params.data : JSON.stringify(params.data);
};

const notificationToProgress = (notification: NotificationEvent): Progress => {
  const message = notification.message as { method: string; params: unknown };
  return message.params as Progress;
};

// Helper function to extract extension name for tooltip
const getExtensionTooltip = (toolCallName: string): string | null => {
  const lastIndex = toolCallName.lastIndexOf('__');
  if (lastIndex === -1) return null;

  const extensionName = toolCallName.substring(0, lastIndex);
  if (!extensionName) return null;

  return `${extensionName} extension`;
};

function ToolCallView({
  computerTarget,
  sessionId,
  compact = false,
  displayTitle,
  requestId,
  toolRequest,
  isPendingApproval,
  isCancelledMessage,
  toolCall,
  toolResponse,
  notifications,
  isStreamingMessage = false,
}: ToolCallViewProps) {
  const intl = useIntl();
  const [responseStyle, setResponseStyle] = useState<string>('concise');

  useEffect(() => {
    // Load initial value from settings
    window.electron.getSetting('responseStyle').then(setResponseStyle);

    const handleStyleChange = () => {
      window.electron.getSetting('responseStyle').then(setResponseStyle);
    };

    window.addEventListener(AppEvents.RESPONSE_STYLE_CHANGED, handleStyleChange);

    return () => {
      window.removeEventListener(AppEvents.RESPONSE_STYLE_CHANGED, handleStyleChange);
    };
  }, []);

  const isExpandToolDetails = (() => {
    switch (responseStyle) {
      case 'concise':
        return false;
      case 'detailed':
      default:
        return true;
    }
  })();

  const businessOutcome = computerToolOutcome(toolCall.name, requestId, toolResponse);
  const transportStatus = resolveToolLoadingStatus(toolResponse, !!isStreamingMessage, toolRequest);
  const toolAudit = parseToolAuditReceipt(toolResponse?.metadata?.toolAudit);
  const cancelled =
    (!toolResponse && isCancelledMessage) ||
    (toolResponse?.id === requestId && toolAudit?.outcome === 'cancelled');
  const loadingStatus: LoadingStatus = cancelled
    ? 'cancelled'
    : !toolResponse && isPendingApproval
      ? 'pending'
      : businessOutcome === 'unknown'
        ? 'unknown'
        : businessOutcome === 'failed' || businessOutcome === 'rejected'
          ? 'error'
          : transportStatus;
  const inputPreview = !toolResponse && toolCall.arguments?.__inputPreview === true;
  const preparingInput = inputPreview && loadingStatus === 'loading';
  const visiblePhase = preparingInput ? 'preparing' : loadingStatus;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    try {
      window.electron.logInfo(
        JSON.stringify({
          tag: 'stream_timing',
          stage: 'ui_tool_committed',
          at_ms: Date.now(),
          session_id: sessionId,
          tool_call_id: requestId,
          phase: visiblePhase,
          document_visibility: document.visibilityState,
        })
      );
    } catch {
      // A committed row is not proof of a painted frame. Correlate with recording.
    }
  }, [sessionId, requestId, visiblePhase]);

  // Tool call timing tracking
  const [startTime, setStartTime] = useState<number | null>(null);

  // Track when tool call starts (when there's no response yet)
  useEffect(() => {
    if (!toolResponse && startTime === null) {
      setStartTime(Date.now());
    }
  }, [toolResponse, startTime]);

  const toolResults = toolResponse?.toolResult ? getToolResultContent(toolResponse.toolResult) : [];

  const logs = notifications
    ?.filter((notification) => {
      const message = notification.message as { method?: string };
      return message.method === 'notifications/message';
    })
    .map(logToString);

  const progress = notifications
    ?.filter((notification) => {
      const message = notification.message as { method?: string };
      return message.method === 'notifications/progress';
    })
    .map(notificationToProgress)
    .reduce((map, item) => {
      const key = item.progressToken;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(item);
      return map;
    }, new Map<string, Progress[]>());

  const progressEntries = [...(progress?.values() || [])].map(
    (entries) => entries.sort((a, b) => b.progress - a.progress)[0]
  );

  const isRenderingProgress =
    loadingStatus === 'loading' && (progressEntries.length > 0 || (logs || []).length > 0);

  const extensionTooltip = getExtensionTooltip(toolCall.name);
  const change = fileChangeReceipt(toolResponse, toolRequest);
  const actionTitle = formatToolAction(
    intl,
    toolCall.name,
    change
      ? { ...toolCall.arguments, path: change.path, file_path: change.path }
      : (toolCall.arguments ?? {}),
    loadingStatus === 'success' ? 'completed' : loadingStatus === 'loading' ? 'running' : undefined,
    'detail',
    compact ? displayTitle : undefined,
    computerTarget,
    toolResponse
  );
  const toolName = toolCall.name.split(/__|::/).pop();
  const compactTitle = isWebSearchTool(toolCall.name)
    ? actionTitle
    : compact && toolName === 'todo_write'
      ? intl.formatMessage(i18n.modelPlan)
      : actionTitle;
  const subagentOutcome = (toolResponse?.toolResult as ToolResultWithMeta | undefined)?.value?._meta
    ?.terminal_outcome;
  const partialSubagent =
    subagentOutcome === 'action_budget_exhausted' || subagentOutcome === 'provider_unavailable';
  const internalCheckError =
    compact &&
    loadingStatus === 'error' &&
    isTaskContractCheck({ name: toolCall.name, arguments: toolCall.arguments ?? {} }) &&
    (!toolAudit || toolAudit.outcome === 'tool_error');
  const desktopOutcome = toolResponse?.metadata?.desktopOutcome;
  const desktopLabel = desktopOutcome === 'stopped' ? intl.formatMessage(i18n.desktopStopped)
    : desktopOutcome === 'paused' ? intl.formatMessage(i18n.desktopPaused)
    : desktopOutcome === 'stale' ? intl.formatMessage(i18n.desktopStale)
      : desktopOutcome === 'withdrawn' ? intl.formatMessage(i18n.desktopWithdrawn) : undefined;
  const statusLabel = desktopLabel ?? (internalCheckError
    ? intl.formatMessage(i18n.checkNotAccepted)
    : partialSubagent
      ? intl.formatMessage(
          subagentOutcome === 'action_budget_exhausted'
            ? i18n.subagentBudget
            : i18n.subagentUnavailable
        )
      : loadingStatus === 'success'
        ? formatToolCompleted(intl)
        : compact && loadingStatus === 'error'
          ? intl.formatMessage(i18n.unsuccessful)
          : formatCodeProActivityState(
              intl,
              loadingStatus === 'loading'
                ? 'running'
                : loadingStatus === 'error'
                  ? 'failed'
                  : loadingStatus
            ));
  // Map LoadingStatus to ToolCallStatus
  const getToolCallStatus = (loadingStatus: LoadingStatus): ToolCallStatus => {
    switch (loadingStatus) {
      case 'success':
        return 'success';
      case 'error':
        return 'error';
      case 'loading':
        return 'loading';
      default:
        return 'pending';
    }
  };

  const toolCallStatus =
    businessOutcome === 'unknown' || partialSubagent || internalCheckError || desktopLabel
      ? 'warning'
      : getToolCallStatus(loadingStatus);
  const filePath = change?.path ?? toolFilePath(toolCall.name, toolCall.arguments ?? {});
  const hasFileAction = !!sessionId && !!filePath && !inputPreview;
  const rowTitle = hasFileAction
    ? formatToolAction(
        intl,
        toolCall.name,
        { ...toolCall.arguments, path: undefined, file_path: undefined },
        loadingStatus === 'success'
          ? 'completed'
          : loadingStatus === 'loading'
            ? 'running'
            : undefined
      )
    : compactTitle;
  const statusContent = (
    <>
      {change && <FileChangeCount change={change} />}
      {(!compact || loadingStatus !== 'success') && !preparingInput && (
        <span className="text-xs text-text-secondary shrink-0">{statusLabel}</span>
      )}
    </>
  );
  const fileAction = hasFileAction && (
    <button
      type="button"
      title={filePath}
      aria-label={filePath}
      className={cn(
        'min-w-0 truncate rounded py-1 text-left font-mono text-xs text-text-secondary underline decoration-current/30 underline-offset-2 hover:text-text-primary focus-visible:outline focus-visible:outline-2',
        compact ? 'px-0' : 'mx-1 px-1'
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openWorkspaceFile({ sessionId: sessionId!, filePath: filePath!, action: 'file-menu' });
      }}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey) {
          openWorkspaceFile({ sessionId: sessionId!, filePath: filePath!, action: 'open-external' });
        } else {
          openConversationChange({ sessionId: sessionId!, toolCallId: requestId, filePath });
        }
      }}
    >
      {filePath!.split(/[\\/]/).filter(Boolean).pop()}
    </button>
  );
  const toolLabel = (
    <span
      data-tool-call-id={requestId}
      data-tool-phase={visiblePhase}
      className={cn(
        'flex flex-1 items-center gap-2 min-w-0',
        extensionTooltip && 'cursor-pointer hover:opacity-80'
      )}
    >
      {!compact && (
        <ToolIconWithStatus ToolIcon={getToolCallIcon(toolCall.name)} status={toolCallStatus} />
      )}
      <span className="truncate flex-1 min-w-0 text-left" title={compactTitle}>
        {rowTitle}
      </span>
      {!hasFileAction && statusContent}
    </span>
  );
  if (
    compact &&
    isProgressTool(toolCall.name) &&
    loadingStatus === 'success' &&
    typeof toolCall.arguments?.text === 'string'
  ) {
    return (
      <div className="py-2 text-text-primary">
        <MarkdownContent content={toolCall.arguments.text} />
      </div>
    );
  }
  if (compact && isPlanTool(toolCall.name) && !isPendingApproval) {
    return (
      <>
        <CodeProPlan
          active={false}
          requestId={requestId}
          content={toolPlanContent(toolCall.arguments ?? {}, toolResponse)}
        >
          <CodeProToolContent
            request={toolRequest}
            name={toolCall.name}
            args={toolCall.arguments ?? {}}
            response={toolResponse}
          />
        </CodeProPlan>
        {loadingStatus !== 'success' && (
          <p className="text-xs text-text-secondary">{statusLabel}</p>
        )}
      </>
    );
  }
  const readable = compact && (hasReadableToolContent(toolCall.name) || loadingStatus === 'error');
  const childSessionId = getSubagentSessionId(toolResponse, notifications);
  const nativeChildReceipt = toolResponse?.metadata?.rawOutput;
  const childActivated =
    loadingStatus === 'success' &&
    nativeChildReceipt &&
    typeof nativeChildReceipt === 'object' &&
    'kind' in nativeChildReceipt &&
    nativeChildReceipt.kind === 'activation' &&
    'subagentId' in nativeChildReceipt &&
    nativeChildReceipt.subagentId === childSessionId;
  const childTitle =
    typeof toolCall.arguments?.description === 'string'
      ? toolCall.arguments.description
      : compactTitle;
  if (compact && sessionId && childSessionId) {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 py-1 text-left text-text-secondary hover:text-text-primary"
        onClick={() =>
          openSubagentConversation({
            parentSessionId: sessionId,
            childSessionId,
            title: childTitle,
          })
        }
        title={intl.formatMessage(i18n.viewSubagentSession)}
      >
        <SubagentAvatar sessionId={childSessionId} />
        <span className="min-w-0 flex-1 truncate">
          {childActivated
            ? intl.formatMessage(i18n.subagentStarted, { name: childTitle })
            : childTitle}
        </span>
      </button>
    );
  }
  if (isWebSearchTool(toolCall.name)) {
    const details = webSearchDetails(toolCall.arguments ?? {}, toolResponse);
    return (
      <ToolCallExpandable
        compact={compact}
        storageKey={requestId}
        label={toolLabel}
        icon={<ToolActivityIcon name={toolCall.name} status={toolCallStatus} />}
      >
        <div className="space-y-3 py-2 text-sm text-text-primary">
          {details.queries.length > 0 && (
            <section aria-label={intl.formatMessage(i18n.searchQuery)}>
              <h4 className="mb-1 text-xs text-text-secondary">
                {intl.formatMessage(i18n.searchQuery)}
              </h4>
              {details.queries.map((query) => (
                <p key={query} className="break-words">
                  {query}
                </p>
              ))}
            </section>
          )}
          {details.sources.length > 0 && (
            <section aria-label={intl.formatMessage(i18n.searchSources)}>
              <h4 className="mb-1 text-xs text-text-secondary">
                {intl.formatMessage(i18n.searchSources)}
              </h4>
              <ul className="space-y-2">
                {details.sources.map((source) => (
                  <li key={source.url}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-words underline underline-offset-2"
                      onClick={(event) => {
                        event.preventDefault();
                        void window.electron.openExternal(source.url);
                      }}
                    >
                      {source.title}
                    </a>
                    <p className="break-all text-xs text-text-secondary">{source.url}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {details.notice && (
            <section aria-label={intl.formatMessage(i18n.searchResponse)}>
              <p className="whitespace-pre-wrap break-words">{details.notice}</p>
            </section>
          )}
        </div>
      </ToolCallExpandable>
    );
  }
  if (compact) {
    const preview = toolCall.arguments?.__inputPreview === true;
    // Generic plumbing has no user-facing detail view. Full receipts remain
    // available in the diagnostic export, rather than an empty/raw JSON drawer.
    if (!readable && !preview && !childSessionId && !isProgressTool(toolCall.name)) {
      return (
        <div className="codepro-record-trigger flex min-h-7 items-center gap-1.5 py-1 text-sm">
          <span className="codepro-record-icon flex w-[18px] shrink-0 items-center justify-start">
            <ToolActivityIcon name={toolCall.name} status={toolCallStatus} />
          </span>
          <span className="min-w-0">{toolLabel}</span>
        </div>
      );
    }
    if (
      isProgressTool(toolCall.name) &&
      !toolResponse &&
      typeof toolCall.arguments?.text === 'string'
    ) {
      return (
        <div className="py-2 text-text-primary" aria-live="polite">
          <MarkdownContent content={toolCall.arguments.text} />
          <span className="text-xs text-text-secondary">
            {intl.formatMessage(isStreamingMessage ? i18n.draft : i18n.draftStopped)}
          </span>
        </div>
      );
    }
    return (
      <ToolCallExpandable
        compact
        icon={<ToolActivityIcon name={toolCall.name} status={toolCallStatus} />}
        storageKey={requestId}
        label={toolLabel}
        accessibleName={hasFileAction ? `${compactTitle} ${statusLabel}` : undefined}
        headerAction={fileAction}
        headerSuffix={statusContent}
        isStartExpanded={false}
      >
        <div className="py-1 space-y-2">
          {internalCheckError && (
            <p className="text-xs text-text-secondary">
              {intl.formatMessage(i18n.checkResultScope)}
            </p>
          )}
          {preview && (
            <p className="text-xs text-text-secondary">
              {intl.formatMessage(isStreamingMessage ? i18n.draft : i18n.draftStopped)}
            </p>
          )}
          {readable && (
            <CodeProToolContent
              request={toolRequest}
              name={toolCall.name}
              args={toolCall.arguments ?? {}}
              response={toolResponse}
            />
          )}
          {loadingStatus === 'loading' && logs && logs.length > 0 && (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">
              {logs.join('\n')}
            </pre>
          )}
          {childSessionId && (
            <button
              type="button"
              className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
              onClick={() =>
                sessionId &&
                openSubagentConversation({
                  parentSessionId: sessionId,
                  childSessionId,
                  title: childTitle,
                })
              }
            >
              <SubagentAvatar sessionId={childSessionId} small />
              {intl.formatMessage(i18n.viewSubagentSession)}
            </button>
          )}
        </div>
      </ToolCallExpandable>
    );
  }
  return (
    <>
      <ToolCallExpandable
        compact={compact}
        storageKey={compact ? requestId : undefined}
        isStartExpanded={isRenderingProgress || isExpandToolDetails}
        isForceExpand={loadingStatus === 'error' && !compact}
        accessibleName={hasFileAction ? `${compactTitle} ${statusLabel}` : undefined}
        headerAction={fileAction}
        headerSuffix={statusContent}
        label={
          extensionTooltip ? (
            <TooltipWrapper tooltipContent={extensionTooltip} side="top" align="start">
              {toolLabel}
            </TooltipWrapper>
          ) : (
            toolLabel
          )
        }
      >
        {readable && (
          <CodeProToolContent
            request={toolRequest}
            name={toolCall.name}
            args={toolCall.arguments ?? {}}
            response={toolResponse}
          />
        )}
        {(() => {
          if (readable) return null;
          const code = toolCall.arguments?.code as unknown as string | undefined;
          const toolGraph = toolCall.arguments?.tool_graph as unknown as
            | ToolGraphNode[]
            | undefined;

          if (
            toolCall.name === 'code_execution__execute_typescript' &&
            (typeof code === 'string' || Array.isArray(toolGraph))
          ) {
            return (
              <div className="border-t border-border-primary">
                <CodeModeView toolGraph={toolGraph} code={code} />
              </div>
            );
          }

          if (toolCall.name) {
            return (
              <div className="border-t border-border-primary">
                <ToolDetailsView toolCall={toolCall} isStartExpanded={isExpandToolDetails} />
              </div>
            );
          }

          return null;
        })()}

        {logs && logs.length > 0 && (
          <div className="border-t border-border-primary">
            <ToolLogsView
              logs={logs}
              working={loadingStatus === 'loading'}
              isStartExpanded={
                loadingStatus === 'loading' ||
                responseStyle === 'detailed' ||
                responseStyle === null
              }
            />
          </div>
        )}

        {toolResults.length === 0 &&
          progressEntries.length > 0 &&
          progressEntries.map((entry, index) => (
            <div className="p-3 border-t border-border-primary" key={index}>
              <ProgressBar progress={entry.progress} total={entry.total} message={entry.message} />
            </div>
          ))}

        {/* Tool Output */}
        {toolResults.some((result) => !readable || result.type !== 'text') && (
          <>
            {toolResults
              .filter((result) => !readable || result.type !== 'text')
              .map((result, index) => (
                <div key={index} className={cn('border-t border-border-primary')}>
                  <ToolResultView
                    toolCall={toolCall}
                    result={result}
                    isStartExpanded={isExpandToolDetails || loadingStatus === 'error'}
                  />
                </div>
              ))}
          </>
        )}

        {(() => {
          if (loadingStatus === 'loading') return null;
          const subagentSessionId = getSubagentSessionId(toolResponse, notifications);
          if (!subagentSessionId) return null;
          return (
            <div className="border-t border-border-primary">
              <button
                onClick={() => {
                  if (sessionId)
                    openSubagentConversation({
                      parentSessionId: sessionId,
                      childSessionId: subagentSessionId,
                      title: childTitle,
                    });
                }}
                className="w-full flex items-center gap-2 px-4 py-2 text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
              >
                <SubagentAvatar sessionId={subagentSessionId} small />
                <span>{intl.formatMessage(i18n.viewSubagentSession)}</span>
              </button>
            </div>
          );
        })()}
        {compact && (
          <details className="codepro-disclosure py-2 text-xs text-text-secondary">
            <summary className="cursor-pointer">{intl.formatMessage(i18n.toolDetails)}</summary>
            {readable && <ToolDetailsView toolCall={toolCall} isStartExpanded />}
            {toolAudit && <ToolAuditDetails receipt={toolAudit} />}
          </details>
        )}
      </ToolCallExpandable>
      {!compact && toolAudit && (
        <>
          <ToolAuditSummary receipt={toolAudit} businessOutcome={businessOutcome} />
          <ToolAuditDetails receipt={toolAudit} />
        </>
      )}
    </>
  );
}

interface ToolDetailsViewProps {
  toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  };
  isStartExpanded: boolean;
}

function ToolDetailsView({ toolCall, isStartExpanded }: ToolDetailsViewProps) {
  const intl = useIntl();
  return (
    <ToolCallExpandable
      label={<span className="pl-4 font-sans text-sm">{intl.formatMessage(i18n.toolDetails)}</span>}
      isStartExpanded={isStartExpanded}
    >
      <div className="pr-4 pl-8">
        <pre className="font-mono text-xs whitespace-pre-wrap break-all">{toolCall.name}</pre>
        {toolCall.arguments && (
          <ToolCallArguments args={toolCall.arguments as Record<string, ToolCallArgumentValue>} />
        )}
      </div>
    </ToolCallExpandable>
  );
}

interface CodeModeViewProps {
  toolGraph?: ToolGraphNode[];
  code?: string;
}

function CodeModeView({ toolGraph, code }: CodeModeViewProps) {
  const intl = useIntl();
  const renderGraph = () => {
    const graph = toolGraph ?? [];
    if (graph.length === 0) return null;

    const lines: string[] = [];

    graph.forEach((node, index) => {
      const deps =
        node.depends_on.length > 0 ? ` (uses ${node.depends_on.map((d) => d + 1).join(', ')})` : '';
      lines.push(`${index + 1}. ${node.tool}: ${node.description}${deps}`);
    });

    return lines.join('\n');
  };

  return (
    <div className="px-4 py-2">
      {toolGraph && (
        <pre className="font-mono text-xs text-textSubtle whitespace-pre-wrap">{renderGraph()}</pre>
      )}
      {code && (
        <div className="border-t border-border-primary -mx-4 mt-2">
          <ToolCallExpandable
            label={<span className="pl-4 font-sans text-sm">{intl.formatMessage(i18n.code)}</span>}
            isStartExpanded={false}
          >
            <MarkdownContent
              content={'```typescript\n' + code + '\n```'}
              className="whitespace-pre-wrap max-w-full overflow-x-auto"
            />
          </ToolCallExpandable>
        </div>
      )}
    </div>
  );
}

interface ToolResultViewProps {
  toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  };
  result: ContentBlock;
  isStartExpanded: boolean;
}

function ToolResultView({ result, isStartExpanded }: ToolResultViewProps) {
  const intl = useIntl();
  const hasText = (c: ContentBlock): c is ContentBlock & { text: string } =>
    'text' in c && typeof (c as Record<string, unknown>).text === 'string';

  const hasImage = (c: ContentBlock): c is ContentBlock & { data: string; mimeType: string } => {
    if (!('data' in c && 'mimeType' in c)) return false;
    const mimeType = (c as Record<string, unknown>).mimeType;
    return typeof mimeType === 'string' && mimeType.startsWith('image');
  };

  const hasResource = (c: ContentBlock): c is ContentBlock & { resource: unknown } =>
    'resource' in c;

  return (
    <ToolCallExpandable
      label={<span className="pl-4 py-1 font-sans text-sm">{intl.formatMessage(i18n.output)}</span>}
      isStartExpanded={isStartExpanded}
    >
      <div className="pl-4 pr-4 py-4">
        {hasText(result) && (
          <pre className="font-mono text-xs whitespace-pre-wrap max-w-full overflow-x-auto">
            {result.text.trim()}
          </pre>
        )}
        {hasImage(result) && (
          <img
            src={`data:${result.mimeType};base64,${result.data}`}
            alt={intl.formatMessage(i18n.toolResultAlt)}
            className="max-w-full h-auto rounded-md my-2"
            onError={(e) => {
              console.error('Failed to load image');
              e.currentTarget.style.display = 'none';
            }}
          />
        )}
        {hasResource(result) && (
          <pre className="font-sans text-sm">{JSON.stringify(result, null, 2)}</pre>
        )}
      </div>
    </ToolCallExpandable>
  );
}

function SubagentLogEntry({ log }: { log: string }) {
  const subagentMatch = log.match(/^\[subagent:(\w+)\]\s*([\s\S]*)/);
  if (!subagentMatch) {
    return <span className="font-sans text-sm text-textSubtle">{log}</span>;
  }

  const [, , rest] = subagentMatch;
  const [firstLine, ...detailLines] = rest.split('\n');
  const parts = firstLine.split(' | ');
  const toolName = parts[0]?.trim() || firstLine;
  const extensionName = parts[1]?.trim();

  return (
    <div className="font-sans text-sm text-textSubtle">
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
        <span className="font-medium text-text-secondary">{toolName}</span>
        {extensionName && <span className="text-textSubtle opacity-60">{extensionName}</span>}
      </span>
      {detailLines.length > 0 && (
        <pre className="ml-3 mt-0.5 text-xs text-textSubtle whitespace-pre-wrap">
          {detailLines.join('\n')}
        </pre>
      )}
    </div>
  );
}

function ToolLogsView({
  logs,
  working,
  isStartExpanded,
}: {
  logs: string[];
  working: boolean;
  isStartExpanded?: boolean;
}) {
  const intl = useIntl();
  const boxRef = useRef<HTMLDivElement>(null);

  // Whenever logs update, jump to the newest entry
  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [logs.length]);
  // normally we do not want to put .length on an array in react deps:
  //
  // if the objects inside the array change but length doesn't change you want updates
  //
  // in this case, this is array of strings which once added do not change so this cuts
  // down on the possibility of unwanted runs

  const subagentLogCount = logs.filter((l) => l.startsWith('[subagent:')).length;
  const labelText =
    subagentLogCount > 0
      ? intl.formatMessage(i18n.activityCount, { count: subagentLogCount })
      : intl.formatMessage(i18n.logs);

  return (
    <ToolCallExpandable
      label={
        <span className="pl-4 py-1 font-sans text-sm flex items-center">
          <span>{labelText}</span>
          {working && (
            <div className="mx-2 inline-block">
              <span
                className="inline-block animate-spin rounded-full border-2 border-t-transparent border-current"
                style={{ width: 8, height: 8 }}
                role="status"
                aria-label={intl.formatMessage(i18n.loadingSpinner)}
              />
            </div>
          )}
        </span>
      }
      isStartExpanded={isStartExpanded}
    >
      <div
        ref={boxRef}
        className={`flex flex-col items-start space-y-2 overflow-y-auto p-4 ${working ? 'max-h-[4rem]' : 'max-h-[20rem]'}`}
      >
        {logs.map((log, i) => (
          <SubagentLogEntry key={i} log={log} />
        ))}
      </div>
    </ToolCallExpandable>
  );
}

const ProgressBar = ({ progress, total, message }: Omit<Progress, 'progressToken'>) => {
  const isDeterminate = typeof total === 'number';
  const percent = isDeterminate ? Math.min((progress / total!) * 100, 100) : 0;

  return (
    <div className="w-full space-y-2">
      {message && <div className="font-sans text-sm text-textSubtle">{message}</div>}

      <div className="w-full bg-background-subtle rounded-full h-4 overflow-hidden relative">
        {isDeterminate ? (
          <div
            className="bg-primary h-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="absolute inset-0 animate-indeterminate bg-primary" />
        )}
      </div>
    </div>
  );
};
