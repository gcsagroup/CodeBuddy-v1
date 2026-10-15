import type { ComputerToolOutcome } from './computerToolOutcome';
import { ChevronRight, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import type {
  ToolAuditOutcome,
  ToolAuditPermissionClass,
  ToolAuditReceipt,
} from '../acp/adapter/toolAudit';
import { defineMessages, useIntl } from '../i18n';
import { cn } from '../utils';
import { formatCodeProFailureKind } from './codepro/codeProPresentation';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';

const i18n = defineMessages({
  businessWorked: { id: 'toolAudit.business.worked', defaultMessage: 'Operation verified' },
  businessUnknown: {
    id: 'toolAudit.business.unknown',
    defaultMessage: 'Operation result unconfirmed',
  },
  businessFailed: { id: 'toolAudit.business.failed', defaultMessage: 'Operation failed' },
  businessRejected: { id: 'toolAudit.business.rejected', defaultMessage: 'Operation rejected' },
  transportOutcome: { id: 'toolAudit.transportOutcome', defaultMessage: 'Tool call outcome' },
  audited: { id: 'toolAudit.audited', defaultMessage: 'Safety check' },
  summary: {
    id: 'toolAudit.summary',
    defaultMessage: '{audit}: {permission} · {outcome}',
  },
  technicalDetails: {
    id: 'toolAudit.technicalDetails',
    defaultMessage: 'Technical audit details',
  },
  auditId: { id: 'toolAudit.auditId', defaultMessage: 'Audit ID' },
  actor: { id: 'toolAudit.actor', defaultMessage: 'Actor' },
  model: { id: 'toolAudit.model', defaultMessage: 'Model' },
  source: { id: 'toolAudit.source', defaultMessage: 'Source' },
  tool: { id: 'toolAudit.tool', defaultMessage: 'Tool' },
  permission: { id: 'toolAudit.permission', defaultMessage: 'Permission' },
  authorization: { id: 'toolAudit.authorization', defaultMessage: 'Authorization' },
  scope: { id: 'toolAudit.scope', defaultMessage: 'Scope' },
  taskScope: { id: 'toolAudit.taskScope', defaultMessage: 'Task' },
  sessionScope: { id: 'toolAudit.sessionScope', defaultMessage: 'Session' },
  started: { id: 'toolAudit.started', defaultMessage: 'Started' },
  completed: { id: 'toolAudit.completed', defaultMessage: 'Completed' },
  duration: { id: 'toolAudit.duration', defaultMessage: 'Duration' },
  schema: { id: 'toolAudit.schema', defaultMessage: 'Schema' },
  failure: { id: 'toolAudit.failure', defaultMessage: 'Failure reason' },
  outcomeSuccess: { id: 'toolAudit.outcome.success', defaultMessage: 'Tool call succeeded' },
  outcomeToolError: { id: 'toolAudit.outcome.toolError', defaultMessage: 'Could not complete' },
  outcomeCancelled: { id: 'toolAudit.outcome.cancelled', defaultMessage: 'Cancelled' },
  outcomeTimedOut: { id: 'toolAudit.outcome.timedOut', defaultMessage: 'Took too long' },
  outcomeReplaySuppressed: {
    id: 'toolAudit.outcome.replaySuppressed',
    defaultMessage: 'Duplicate execution avoided',
  },
  outcomeAmbiguous: { id: 'toolAudit.outcome.ambiguous', defaultMessage: 'Waiting for review' },
  outcomePolicyDenied: {
    id: 'toolAudit.outcome.policyDenied',
    defaultMessage: 'Needs a safer action',
  },
  outcomeUserDenied: { id: 'toolAudit.outcome.userDenied', defaultMessage: 'Not authorized' },
  actorPrimary: { id: 'toolAudit.actor.primary', defaultMessage: 'Main agent' },
  actorPlanner: { id: 'toolAudit.actor.planner', defaultMessage: 'CodePro Planner' },
  actorCoder: { id: 'toolAudit.actor.coder', defaultMessage: 'CodePro Coder' },
  actorTester: { id: 'toolAudit.actor.tester', defaultMessage: 'CodePro Tester' },
  actorReviewer: { id: 'toolAudit.actor.reviewer', defaultMessage: 'CodePro Reviewer' },
  actorHost: { id: 'toolAudit.actor.host', defaultMessage: 'Host' },
  permissionReadOnly: { id: 'toolAudit.permission.readOnly', defaultMessage: 'Read-only access' },
  permissionWorkspaceWrite: {
    id: 'toolAudit.permission.workspaceWrite',
    defaultMessage: 'Changes limited to this project',
  },
  permissionExternalWrite: {
    id: 'toolAudit.permission.externalWrite',
    defaultMessage: 'External action',
  },
  permissionHighRisk: { id: 'toolAudit.permission.highRisk', defaultMessage: 'Sensitive action' },
  permissionForbidden: { id: 'toolAudit.permission.forbidden', defaultMessage: 'Unsafe action' },
  permissionLegacy: {
    id: 'toolAudit.permission.legacy',
    defaultMessage: 'Safety level unavailable',
  },
  authorizationPolicyAllowed: {
    id: 'toolAudit.authorization.policyAllowed',
    defaultMessage: 'Allowed automatically',
  },
  authorizationUserConfirmed: {
    id: 'toolAudit.authorization.userConfirmed',
    defaultMessage: 'User confirmed',
  },
  authorizationPolicyDenied: {
    id: 'toolAudit.authorization.policyDenied',
    defaultMessage: 'Action needs adjustment',
  },
  authorizationUserDenied: {
    id: 'toolAudit.authorization.userDenied',
    defaultMessage: 'User denied',
  },
});

const outcomeMessages: Record<ToolAuditOutcome, MessageDescriptor> = {
  success: i18n.outcomeSuccess,
  tool_error: i18n.outcomeToolError,
  cancelled: i18n.outcomeCancelled,
  timed_out: i18n.outcomeTimedOut,
  replay_suppressed: i18n.outcomeReplaySuppressed,
  ambiguous: i18n.outcomeAmbiguous,
  policy_denied: i18n.outcomePolicyDenied,
  user_denied: i18n.outcomeUserDenied,
};

const permissionMessages: Record<ToolAuditPermissionClass, MessageDescriptor> = {
  read_only: i18n.permissionReadOnly,
  workspace_write: i18n.permissionWorkspaceWrite,
  external_write: i18n.permissionExternalWrite,
  high_risk: i18n.permissionHighRisk,
  forbidden: i18n.permissionForbidden,
  legacy: i18n.permissionLegacy,
};

function technicalValue(value: string): string {
  return value
    .split('_')
    .map((part) => {
      if (part === 'codepro') return 'CodePro';
      if (part === 'http') return 'HTTP';
      if (part === 'stdio') return 'stdio';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

export function ToolAuditSummary({
  receipt,
  businessOutcome,
}: {
  receipt: ToolAuditReceipt;
  businessOutcome?: ComputerToolOutcome;
}) {
  const intl = useIntl();
  const failureKind = receipt.schemaVersion === 2 ? receipt.failureKind : null;
  const businessMessages = {
    worked: i18n.businessWorked,
    unknown: i18n.businessUnknown,
    failed: i18n.businessFailed,
    rejected: i18n.businessRejected,
  };
  const success = businessOutcome ? businessOutcome === 'worked' : receipt.outcome === 'success';
  const StatusIcon = success ? ShieldCheck : TriangleAlert;
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-border-primary px-4 py-2 text-xs text-text-secondary">
      <StatusIcon
        className={cn(
          'h-3.5 w-3.5',
          success ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
        )}
        aria-hidden="true"
      />
      <span>
        {intl.formatMessage(i18n.summary, {
          audit: intl.formatMessage(i18n.audited),
          permission: intl.formatMessage(permissionMessages[receipt.permissionClass]),
          outcome: intl.formatMessage(
            businessOutcome ? businessMessages[businessOutcome] : outcomeMessages[receipt.outcome]
          ),
        })}
      </span>
      {failureKind && failureKind !== 'cancelled' && (
        <span>{formatCodeProFailureKind(intl, failureKind)}</span>
      )}
    </div>
  );
}

export function ToolAuditDetails({ receipt }: { receipt: ToolAuditReceipt }) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const rows = [
    [
      intl.formatMessage(i18n.transportOutcome),
      intl.formatMessage(outcomeMessages[receipt.outcome]),
    ],
    [intl.formatMessage(i18n.auditId), receipt.auditId],
    [intl.formatMessage(i18n.actor), technicalValue(receipt.actor)],
    [intl.formatMessage(i18n.model), receipt.effectiveModel],
    [intl.formatMessage(i18n.source), technicalValue(receipt.extensionSource)],
    [intl.formatMessage(i18n.tool), receipt.toolName],
    [intl.formatMessage(i18n.permission), technicalValue(receipt.permissionClass)],
    [intl.formatMessage(i18n.authorization), technicalValue(receipt.authorization)],
    ...(receipt.schemaVersion === 2 && receipt.failureKind
      ? [[intl.formatMessage(i18n.failure), technicalValue(receipt.failureKind)]]
      : []),
    [
      intl.formatMessage(i18n.scope),
      intl.formatMessage(receipt.taskScoped ? i18n.taskScope : i18n.sessionScope),
    ],
    [intl.formatMessage(i18n.started), receipt.startedAt],
    [intl.formatMessage(i18n.completed), receipt.completedAt],
    [intl.formatMessage(i18n.duration), `${receipt.durationMs} ms`],
    [intl.formatMessage(i18n.schema), `v${receipt.schemaVersion}`],
  ];

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="border-t border-border-primary"
    >
      <CollapsibleTrigger
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-text-secondary hover:text-text-primary"
      >
        {intl.formatMessage(i18n.technicalDetails)}
        <ChevronRight
          className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="codepro-disclosure-content">
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-border-primary px-4 py-3 text-xs">
          {rows.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-text-secondary">{label}</dt>
              <dd className="min-w-0 break-all font-mono text-text-primary">{value}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolAuditReceiptView({ receipt }: { receipt: ToolAuditReceipt }) {
  return (
    <div>
      <ToolAuditSummary receipt={receipt} />
      <ToolAuditDetails receipt={receipt} />
    </div>
  );
}
