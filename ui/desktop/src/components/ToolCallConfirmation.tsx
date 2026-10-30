import type { ActionRequired } from '../types/message';
import { AlertTriangle } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { formatToolAction } from './toolActionPresentation';
import ToolApprovalButtons from './ToolApprovalButtons';
import { ToolActivityIcon } from './ToolActivityIcon';
import BusinessApprovalScope, { businessApprovalName } from './BusinessApprovalScope';
import ProjectMemoryApprovalSummary, {
  filterProjectMemoryApprovalActions,
  parseProjectMemoryApproval,
} from './ProjectMemoryApprovalSummary';

const i18n = defineMessages({
  allowToolCallWithName: {
    id: 'toolConfirmation.allowToolCallWithName',
    defaultMessage: 'Allow {toolName}?',
  },
  gooseWouldLikeToCallWithName: {
    id: 'toolConfirmation.gooseWouldLikeToCallWithName',
    defaultMessage: 'CodeBuddy would like to call {toolName}. Allow?',
  },
  risk: { id: 'toolConfirmation.risk', defaultMessage: 'Risk' },
  source: { id: 'toolConfirmation.source', defaultMessage: 'Source' },
  scope: { id: 'toolConfirmation.scope', defaultMessage: 'Scope' },
  riskValue: {
    id: 'toolConfirmation.riskValue',
    defaultMessage:
      '{risk, select, read_only {Read only} workspace_write {Workspace write} external_write {Extension action (confirmation required)} high_risk {High risk} forbidden {Forbidden} other {Legacy / unknown risk}}',
  },
  sourceValue: {
    id: 'toolConfirmation.sourceValue',
    defaultMessage:
      '{source, select, platform {Platform extension} builtin {Built-in extension} external_stdio {External local extension} external_http {External network extension} frontend {Frontend tool} inline_python {Inline Python tool} other {Unknown source}}',
  },
  scopeValue: {
    id: 'toolConfirmation.scopeValue',
    defaultMessage:
      '{scope, select, task {This task} session {This session} global {Global} other {Unknown scope}}',
  },
  forcePushTitle: {
    id: 'toolConfirmation.forcePushTitle',
    defaultMessage: 'Force push confirmation',
  },
  forcePushWarning: {
    id: 'toolConfirmation.forcePushWarning',
    defaultMessage:
      'This operation rewrites the remote branch. Verify every value before allowing it.',
  },
  remote: { id: 'toolConfirmation.remote', defaultMessage: 'Remote' },
  branch: { id: 'toolConfirmation.branch', defaultMessage: 'Branch' },
  localHead: { id: 'toolConfirmation.localHead', defaultMessage: 'Local HEAD' },
  expectedRemoteTip: {
    id: 'toolConfirmation.expectedRemoteTip',
    defaultMessage: 'Expected remote tip',
  },
  localOnlyCommits: {
    id: 'toolConfirmation.localOnlyCommits',
    defaultMessage: 'Local-only commits',
  },
  remoteOnlyCommits: {
    id: 'toolConfirmation.remoteOnlyCommits',
    defaultMessage: 'Remote commits to overwrite',
  },
  command: { id: 'codeProActivity.command', defaultMessage: 'Command' },
  path: { id: 'codeProActivity.path', defaultMessage: 'Path' },
  browserTab: { id: 'toolConfirmation.browserTab', defaultMessage: 'Tab {id}' },
  browserNode: { id: 'toolConfirmation.browserNode', defaultMessage: 'Element {node}' },
  browserTargetMissing: {
    id: 'toolConfirmation.browserTargetMissing',
    defaultMessage: 'Target not provided',
  },
  taskWorkspaceGrant: {
    id: 'toolConfirmation.taskWorkspaceGrant',
    defaultMessage:
      'Allow for this task: create and edit files anywhere inside {root}. Shell commands, network, dependency installation, Git operations, and writes outside this workspace are not included.',
  },
});

type ToolConfirmationData = Extract<ActionRequired['data'], { actionType: 'toolConfirmation' }>;

interface ForcePushSummary {
  remote: string;
  branch: string;
  head: string;
  expectedRemoteOid: string;
  localOnlyCommitCount: number;
  remoteOnlyCommitCount: number;
}

interface ApprovalTarget {
  kind: 'command' | 'path';
  value: string;
}

function approvalTarget(
  toolName: string,
  argumentsValue: Record<string, unknown>
): ApprovalTarget | undefined {
  const toolNameParts = toolName.split('__');
  const localToolName = (toolNameParts[toolNameParts.length - 1] ?? toolName).toLowerCase();
  if (localToolName === 'shell' || localToolName === 'bash') {
    const command = argumentsValue.command;
    return typeof command === 'string' && command.trim()
      ? { kind: 'command', value: command }
      : undefined;
  }

  const field = localToolName === 'read_image' ? 'source' : 'path';
  if (!['read', 'write', 'edit', 'tree', 'read_image', 'read_document'].includes(localToolName)) {
    return undefined;
  }
  const path = ['read', 'write', 'edit'].includes(localToolName)
    ? (argumentsValue.file_path ?? argumentsValue.path)
    : argumentsValue[field];
  return typeof path === 'string' && path.trim() ? { kind: 'path', value: path } : undefined;
}

export function ToolApprovalTarget({
  toolName,
  argumentsValue,
}: {
  toolName: string;
  argumentsValue: Record<string, unknown>;
}) {
  const intl = useIntl();
  const target = approvalTarget(toolName, argumentsValue);
  if (toolName.split(/__|::/).pop() === 'browser_control') {
    const { operation, url, path, htmlPath, id, node, text, key } = argumentsValue;
    const localPath = typeof path === 'string' ? path : htmlPath;
    let displayUrl: string | undefined;
    if (typeof url === 'string') {
      try {
        const parsed = new URL(url);
        displayUrl = `${parsed.origin}${parsed.pathname}`;
      } catch {
        /* Invalid URLs are rejected by the tool. */
      }
    }
    const hasTarget =
      operation === 'open'
        ? [url, localPath].some((value) => typeof value === 'string' && value.trim())
        : typeof id === 'string' && id.trim();
    return (
      <section className="mt-3 min-w-0">
        <h3 className="text-xs font-medium text-text-secondary">
          {formatToolAction(intl, toolName, argumentsValue, undefined, 'name')}
        </h3>
        <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all text-sm text-text-primary">
          {!hasTarget && <p>{intl.formatMessage(i18n.browserTargetMissing)}</p>}
          {displayUrl && <p>{displayUrl}</p>}
          {typeof localPath === 'string' && <p>{localPath}</p>}
          {typeof id === 'string' && <p>{intl.formatMessage(i18n.browserTab, { id })}</p>}
          {Number.isSafeInteger(node) && Number(node) > 0 && (
            <p>{intl.formatMessage(i18n.browserNode, { node: Number(node) })}</p>
          )}
          {operation === 'type' && typeof text === 'string' && <pre>{text}</pre>}
          {operation === 'key' && typeof key === 'string' && <pre>{key}</pre>}
        </div>
      </section>
    );
  }
  if (!target) return null;
  return (
    <section className="mt-3">
      <h3 className="text-xs font-medium text-text-secondary">
        {intl.formatMessage(target.kind === 'command' ? i18n.command : i18n.path)}
      </h3>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-sm text-text-primary">
        {target.value}
      </pre>
    </section>
  );
}

function forcePushSummary(
  toolName: string,
  permissionClass: string,
  extensionSource: string,
  argumentsValue: Record<string, unknown>
): ForcePushSummary | undefined {
  if (
    toolName !== 'git_force_push' ||
    permissionClass !== 'high_risk' ||
    extensionSource !== 'platform'
  ) {
    return undefined;
  }

  const remote = argumentsValue.remote;
  const branch = argumentsValue.branch;
  const head = argumentsValue.head;
  const expectedRemoteOid = argumentsValue.expected_remote_oid;
  const localOnlyCommitCount = argumentsValue.local_only_commit_count;
  const remoteOnlyCommitCount = argumentsValue.remote_only_commit_count;
  const validOid = (value: unknown): value is string =>
    typeof value === 'string' && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value);
  const validCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

  if (
    typeof remote !== 'string' ||
    !remote ||
    typeof branch !== 'string' ||
    !branch ||
    !validOid(head) ||
    !validOid(expectedRemoteOid) ||
    !validCount(localOnlyCommitCount) ||
    !validCount(remoteOnlyCommitCount)
  ) {
    return undefined;
  }

  return {
    remote,
    branch,
    head,
    expectedRemoteOid,
    localOnlyCommitCount,
    remoteOnlyCommitCount,
  };
}

interface ToolConfirmationProps {
  sessionId: string;
  isClicked: boolean;
  actionRequiredContent: ActionRequired & { type: 'actionRequired' };
}

export default function ToolConfirmation({
  sessionId,
  isClicked,
  actionRequiredContent,
}: ToolConfirmationProps) {
  const intl = useIntl();
  const data = actionRequiredContent.data as ToolConfirmationData;
  const {
    id,
    toolName,
    prompt,
    permissionClass = 'legacy',
    extensionSource = 'unknown',
    authorizationScope = 'unknown',
    authorizationGroup,
    authorizationModule,
    authorizationTarget,
    taskWorkspaceRoot,
    businessApproval,
    availableActions,
    arguments: toolArguments,
  } = data;
  const displayName = businessApproval
    ? businessApprovalName(intl, businessApproval)
    : formatToolAction(intl, toolName, toolArguments ?? {}, undefined, 'name');
  const forcePush = forcePushSummary(toolName, permissionClass, extensionSource, toolArguments);
  const memoryApproval = parseProjectMemoryApproval(toolName, extensionSource, toolArguments);
  const filteredActions = filterProjectMemoryApprovalActions(memoryApproval, availableActions);
  const facts = [
    [i18n.risk, intl.formatMessage(i18n.riskValue, { risk: permissionClass }), true],
    [i18n.source, intl.formatMessage(i18n.sourceValue, { source: extensionSource }), false],
    [i18n.scope, intl.formatMessage(i18n.scopeValue, { scope: authorizationScope }), false],
  ] as const;

  return (
    <div className="goose-message-content bg-background-primary border border-border-primary rounded-2xl p-4">
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <ToolActivityIcon name={toolName} status="warning" />
        {displayName}
      </div>
      <p className="mt-3 text-sm font-medium text-text-primary">
        {prompt
          ? intl.formatMessage(i18n.allowToolCallWithName, { toolName: displayName })
          : intl.formatMessage(i18n.gooseWouldLikeToCallWithName, { toolName: displayName })}
      </p>
      <div className="pt-3">
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
          {facts.map(([label, value, isRisk]) => (
            <div key={label.id}>
              <dt className="flex items-center gap-1 text-text-secondary">
                {isRisk && (
                  <AlertTriangle
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0"
                    data-testid="tool-permission-risk-icon"
                  />
                )}
                {intl.formatMessage(label)}
              </dt>
              <dd className="mt-1 font-medium text-text-primary">{value}</dd>
            </div>
          ))}
        </dl>
        {prompt && <p className="mt-3 text-sm text-text-secondary">{prompt}</p>}
        {businessApproval && <BusinessApprovalScope approval={businessApproval} />}
        {taskWorkspaceRoot && (
          <p className="mt-3 text-sm text-text-secondary" data-testid="task-workspace-grant-scope">
            {intl.formatMessage(i18n.taskWorkspaceGrant, { root: taskWorkspaceRoot })}
          </p>
        )}
        <ToolApprovalTarget toolName={toolName} argumentsValue={toolArguments} />
        {forcePush && (
          <section
            aria-label={intl.formatMessage(i18n.forcePushTitle)}
            className="mt-3 rounded-xl border border-red-500/40 bg-red-500/5 p-3"
          >
            <h3 className="text-sm font-semibold text-text-primary">
              {intl.formatMessage(i18n.forcePushTitle)}
            </h3>
            <p className="mt-1 text-xs text-text-secondary">
              {intl.formatMessage(i18n.forcePushWarning)}
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              {(
                [
                  [i18n.remote, forcePush.remote, false],
                  [i18n.branch, forcePush.branch, false],
                  [i18n.localHead, forcePush.head, true],
                  [i18n.expectedRemoteTip, forcePush.expectedRemoteOid, true],
                  [i18n.localOnlyCommits, String(forcePush.localOnlyCommitCount), false],
                  [i18n.remoteOnlyCommits, String(forcePush.remoteOnlyCommitCount), false],
                ] as const
              ).map(([label, value, isOid]) => (
                <div key={label.id} className="rounded-lg bg-background-primary px-3 py-2">
                  <dt className="text-text-secondary">{intl.formatMessage(label)}</dt>
                  <dd
                    className={`mt-1 break-all font-medium text-text-primary ${isOid ? 'font-mono' : ''}`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <ProjectMemoryApprovalSummary result={memoryApproval} />
      </div>
      <ToolApprovalButtons
        data={{
          id,
          toolName,
          prompt: prompt ?? undefined,
          sessionId,
          isClicked,
          permissionClass,
          authorizationScope,
          businessApproval,
          authorizationGroup,
          authorizationModule,
          authorizationTarget,
          availableActions: filteredActions,
        }}
      />
    </div>
  );
}
