import { useState, useEffect, useSyncExternalStore } from 'react';
import { Button } from './ui/button';
import { localizePlatformExtension } from './settings/extensions/platformExtensionLocalization';
import { formatToolAction } from './toolActionPresentation';
import type { Permission } from '../types/permissions';
import type {
  ToolAuthorizationScope,
  ToolPermissionAction,
  ToolPermissionClass,
} from '../types/message';
import {
  isAcpPermissionRequestPending,
  resolveAcpPermissionRequest,
  subscribeAcpPermissionRequests,
} from '../acp/permissionRequests';
import { defineMessages, useIntl } from '../i18n';
import type { BusinessApproval } from '../types/businessApproval';
import { businessApprovalName } from './BusinessApprovalScope';

const i18n = defineMessages({
  allowBusiness: {
    id: 'businessApproval.allowSession',
    defaultMessage: 'Allow {business} for this session',
  },
  allowedBusiness: {
    id: 'businessApproval.allowedSession',
    defaultMessage: '{business} allowed for this session',
  },
  allowOnce: {
    id: 'toolApprovalButtons.allowOnce',
    defaultMessage: 'Allow Once',
  },
  alwaysAllow: {
    id: 'toolApprovalButtons.alwaysAllow',
    defaultMessage: 'Always Allow',
  },
  allowByScope: {
    id: 'toolApprovalButtons.allowByScope',
    defaultMessage:
      '{scope, select, task {Allow for this task} session {Allow this tool for this session} other {Always Allow}}',
  },
  sessionAllowHint: {
    id: 'toolApprovalButtons.sessionAllowHint',
    defaultMessage:
      'Only this tool in this conversation. Restarting the app or reconnecting the tool clears this choice.',
  },
  allowWebRead: { id: 'toolApprovalButtons.allowWebRead', defaultMessage: 'Allow public web reading for this session' },
  webReadAllowed: { id: 'toolApprovalButtons.webReadAllowed', defaultMessage: 'Public web reading allowed for this session' },
  webReadHint: { id: 'toolApprovalButtons.webReadHint', defaultMessage: 'Anonymous public web reading across websites in this conversation. Does not include login, submissions, credentials, or private networks. Restarting the app clears this choice.' },
  allowNamed: {
    id: 'toolApprovalButtons.allowNamed',
    defaultMessage: 'Allow {name} for this session',
  },
  namedAllowed: {
    id: 'toolApprovalButtons.namedAllowed',
    defaultMessage: '{name} allowed for this session',
  },
  moduleHint: {
    id: 'toolApprovalButtons.moduleHint',
    defaultMessage:
      'Allow the current tools and resource access of {name} in this conversation. Explicit tool rules and operations requiring individual confirmation still apply. Restarting, reconnecting, disabling, reconfiguring, or changing the tool catalog requires confirmation again.',
  },
  allowComputer: {
    id: 'toolApprovalButtons.allowComputer',
    defaultMessage: 'Allow computer control for this session',
  },
  computerAllowed: {
    id: 'toolApprovalButtons.computerAllowed',
    defaultMessage: 'Computer control allowed for this session',
  },
  computerHint: {
    id: 'toolApprovalButtons.computerHint',
    defaultMessage:
      'All computer-control tools in this conversation: screen reading, clicks, keyboard input, dragging, scrolling, and opening local paths. Restarting, reconnecting, or changing the tool catalog clears this choice.',
  },
  deny: {
    id: 'toolApprovalButtons.deny',
    defaultMessage: 'Deny Once',
  },
  denyByScope: {
    id: 'toolApprovalButtons.denyByScope',
    defaultMessage:
      '{scope, select, task {Deny for this task} session {Deny for this session} other {Always Deny}}',
  },
  allowedOnce: {
    id: 'toolApprovalButtons.allowedOnce',
    defaultMessage: 'Allowed once',
  },
  alwaysAllowed: {
    id: 'toolApprovalButtons.alwaysAllowed',
    defaultMessage: 'Always allowed',
  },
  allowedByScope: {
    id: 'toolApprovalButtons.allowedByScope',
    defaultMessage:
      '{scope, select, task {Allowed for this task} session {Tool allowed for this session} other {Always allowed}}',
  },
  denied: {
    id: 'toolApprovalButtons.denied',
    defaultMessage: 'Denied',
  },
  deniedOnce: {
    id: 'toolApprovalButtons.deniedOnce',
    defaultMessage: 'Denied once',
  },
  cancelled: {
    id: 'toolApprovalButtons.cancelled',
    defaultMessage: 'Cancelled',
  },
  staleApprovalRequest: {
    id: 'toolApprovalButtons.staleApprovalRequest',
    defaultMessage: 'This approval request is no longer active.',
  },
});

const globalApprovalState = new Map<
  string,
  {
    decision: Permission | null;
    isClicked: boolean;
  }
>();

function approvalStateKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}

export interface ToolApprovalData {
  id: string;
  toolName: string;
  prompt?: string;
  sessionId: string;
  isClicked?: boolean;
  permissionClass?: ToolPermissionClass;
  authorizationScope?: ToolAuthorizationScope;
  authorizationGroup?: 'computer_control' | 'mcp_module' | 'web_read';
  authorizationModule?: { name: string; displayName: string };
  authorizationTarget?: string;
  availableActions?: ToolPermissionAction[];
  businessApproval?: BusinessApproval;
}

export default function ToolApprovalButtons({ data }: { data: ToolApprovalData }) {
  const intl = useIntl();
  const {
    id,
    toolName,
    sessionId,
    isClicked: initialIsClicked,
    permissionClass = 'legacy',
    authorizationScope = 'unknown',
    authorizationGroup,
    authorizationModule,
    authorizationTarget,
    availableActions = ['allow_once', 'deny_once'],
    businessApproval,
  } = data;
  const stateKey = approvalStateKey(sessionId, id);
  const isPending = useSyncExternalStore(subscribeAcpPermissionRequests, () =>
    isAcpPermissionRequestPending(sessionId, id)
  );
  const storedState = globalApprovalState.get(stateKey);
  const [approvalState, setApprovalState] = useState(() => ({
    key: stateKey,
    decision: storedState?.decision ?? null,
    isClicked: storedState?.isClicked ?? initialIsClicked ?? false,
  }));
  const displayedState =
    approvalState.key === stateKey
      ? approvalState
      : {
          key: stateKey,
          decision: storedState?.decision ?? null,
          isClicked: storedState?.isClicked ?? initialIsClicked ?? false,
        };
  const { decision, isClicked } = displayedState;
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const actions = new Set(availableActions);
  const allowActionsVisible = permissionClass !== 'forbidden';
  const scopedLongTermAllow =
    authorizationScope === 'task' ||
    authorizationScope === 'session' ||
    (authorizationScope === 'global' &&
      permissionClass !== 'external_write' &&
      permissionClass !== 'high_risk' &&
      permissionClass !== 'legacy');
  const canAllowOnce = allowActionsVisible && actions.has('allow_once');
  const canAllowScope = allowActionsVisible && scopedLongTermAllow && actions.has('always_allow');
  const webReadGroup = authorizationScope === 'session' && authorizationGroup === 'web_read' && permissionClass === 'read_only';
  const computerGroup =
    authorizationScope === 'session' && authorizationGroup === 'computer_control';
  const moduleGroup =
    authorizationScope === 'session' && authorizationGroup === 'mcp_module' && authorizationModule;
  const localizedModule = moduleGroup
    ? localizePlatformExtension({ type: 'platform', name: moduleGroup.name }, intl)
    : undefined;
  const moduleName = moduleGroup
    ? (localizedModule?.name ?? moduleGroup.displayName)
    : undefined;
  const targetName = moduleGroup
    ? localizedModule || moduleName === moduleGroup.name
      ? moduleName
      : moduleName + ' (' + moduleGroup.name + ')'
    : authorizationScope === 'session' && authorizationTarget
      ? authorizationTarget === toolName
        ? formatToolAction(intl, toolName, {}, undefined, 'name')
        : authorizationTarget
      : undefined;
  const scopeLabel = businessApproval ? intl.formatMessage(i18n.allowBusiness, { business: businessApprovalName(intl, businessApproval) }) : webReadGroup ? intl.formatMessage(i18n.allowWebRead) : targetName
    ? intl.formatMessage(i18n.allowNamed, { name: targetName })
    : computerGroup
      ? intl.formatMessage(i18n.allowComputer)
      : intl.formatMessage(i18n.allowByScope, { scope: authorizationScope });
  const scopeHint = businessApproval ? undefined : webReadGroup ? intl.formatMessage(i18n.webReadHint) : moduleGroup
    ? intl.formatMessage(i18n.moduleHint, { name: targetName })
    : computerGroup
      ? intl.formatMessage(i18n.computerHint)
      : authorizationScope === 'session'
        ? intl.formatMessage(i18n.sessionAllowHint)
        : undefined;

  const setResolvedDecision = (action: Permission) => {
    setApprovalState({ key: stateKey, decision: action, isClicked: true });
    setApprovalError(null);
  };

  useEffect(() => {
    const currentState = globalApprovalState.get(stateKey);
    setApprovalState({
      key: stateKey,
      decision: currentState?.decision ?? null,
      isClicked: currentState?.isClicked ?? initialIsClicked ?? false,
    });
    setApprovalError(null);
  }, [stateKey, initialIsClicked]);

  useEffect(() => {
    if (approvalState.key === stateKey) {
      globalApprovalState.set(stateKey, {
        decision: approvalState.decision,
        isClicked: approvalState.isClicked,
      });
    }
  }, [stateKey, approvalState]);

  const handleAction = async (action: Permission) => {
    try {
      if (resolveAcpPermissionRequest(sessionId, id, action)) {
        setResolvedDecision(action);
      } else {
        setApprovalError(intl.formatMessage(i18n.staleApprovalRequest));
      }
    } catch (err) {
      console.error('Error confirming tool action:', err);
    }
  };

  if (!isPending && isClicked && decision) {
    const scopedAllowed = businessApproval ? intl.formatMessage(i18n.allowedBusiness, { business: businessApprovalName(intl, businessApproval) }) : webReadGroup ? intl.formatMessage(i18n.webReadAllowed) : targetName
      ? intl.formatMessage(i18n.namedAllowed, { name: targetName })
      : computerGroup
        ? intl.formatMessage(i18n.computerAllowed)
        : intl.formatMessage(i18n.allowedByScope, {
            scope: authorizationScope,
          });
    const statusMessages: Record<Permission, string> = {
      allow_once: intl.formatMessage(i18n.allowedOnce),
      always_allow: scopedLongTermAllow ? scopedAllowed : intl.formatMessage(i18n.alwaysAllowed),
      always_deny: intl.formatMessage(i18n.denied),
      deny_once: intl.formatMessage(i18n.deniedOnce),
      cancel: intl.formatMessage(i18n.cancelled),
    };
    return (
      <p className="text-sm text-muted-foreground mt-2">
        {formatToolAction(intl, toolName, {}, undefined, 'name')} - {statusMessages[decision]}
      </p>
    );
  }

  // A replayed approval card is history unless its transport RPC is still live.
  // Inactivity does not tell us whether it was allowed, rejected or timed out.
  if (!isPending || approvalError) {
    return (
      <p className="text-sm text-muted-foreground mt-2">
        {intl.formatMessage(i18n.staleApprovalRequest)}
      </p>
    );
  }

  return (
    <>
      {(moduleGroup || computerGroup || webReadGroup) && canAllowScope && (
        <p className="mt-3 text-sm text-text-secondary">{scopeHint}</p>
      )}
      <div
        className="flex flex-wrap items-center justify-end gap-2 mt-4"
        data-testid="tool-approval-actions"
        data-tool-approval-actions=""
      >
        {actions.has('deny_once') && (
          <Button
            type="button"
            size="sm"
            className="rounded-full border-border-primary bg-background-primary text-text-primary"
            variant="outline"
            onClick={() => handleAction('deny_once')}
          >
            {intl.formatMessage(i18n.deny)}
          </Button>
        )}
        {actions.has('always_deny') && (
          <Button
            type="button"
            size="sm"
            className="rounded-full border-border-primary bg-background-primary text-text-primary"
            variant="outline"
            onClick={() => handleAction('always_deny')}
          >
            {intl.formatMessage(i18n.denyByScope, {
              scope: authorizationScope,
            })}
          </Button>
        )}
        {canAllowOnce && (
          <Button
            type="button"
            size="sm"
            className="rounded-full border-border-primary bg-background-primary text-text-primary"
            variant="outline"
            onClick={() => handleAction('allow_once')}
          >
            {intl.formatMessage(i18n.allowOnce)}
          </Button>
        )}
        {canAllowScope && (
          <Button
            type="button"
            size="sm"
            className="rounded-full border-border-primary bg-background-primary text-text-primary"
            variant="outline"
            onClick={() => handleAction('always_allow')}
            title={scopeHint}
          >
            {scopeLabel}
          </Button>
        )}
      </div>
      {approvalError && (
        <p className="text-sm text-red-500 mt-2" role="alert">
          {approvalError}
        </p>
      )}
    </>
  );
}
