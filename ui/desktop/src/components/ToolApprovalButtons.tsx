import { useState, useEffect, useSyncExternalStore } from 'react';
import { Button } from './ui/button';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
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

const i18n = defineMessages({
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
  availableActions?: ToolPermissionAction[];
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
    availableActions = ['allow_once', 'deny_once'],
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
  const scopeLabel = intl.formatMessage(i18n.allowByScope, { scope: authorizationScope });
  const scopeHint =
    authorizationScope === 'session' ? intl.formatMessage(i18n.sessionAllowHint) : undefined;

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
    const scopedAllowed = intl.formatMessage(i18n.allowedByScope, {
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
      <div
        className="flex flex-wrap items-center justify-end gap-2 mt-4"
        data-testid="tool-approval-actions"
        data-tool-approval-actions=""
      >
        {actions.has('deny_once') && (
          <Button
            type="button"
            size="sm"
            className="rounded-full"
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
            className="rounded-full"
            variant="outline"
            onClick={() => handleAction('always_deny')}
          >
            {intl.formatMessage(i18n.denyByScope, {
              scope: authorizationScope,
            })}
          </Button>
        )}
        {(canAllowOnce || canAllowScope) && (
          <div className="flex items-center">
            <Button
              type="button"
              size="sm"
              className={
                canAllowOnce && canAllowScope ? 'rounded-l-full rounded-r-none' : 'rounded-full'
              }
              onClick={() => handleAction(canAllowOnce ? 'allow_once' : 'always_allow')}
              title={canAllowOnce ? undefined : scopeHint}
            >
              {canAllowOnce ? intl.formatMessage(i18n.allowOnce) : scopeLabel}
            </Button>
            {canAllowOnce && canAllowScope && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    className="rounded-l-none rounded-r-full px-2 has-[>svg]:px-2"
                    aria-label={scopeLabel}
                    title={scopeHint}
                  >
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" data-tool-approval-actions="">
                  <DropdownMenuItem onSelect={() => handleAction('always_allow')} title={scopeHint}>
                    {scopeLabel}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
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
