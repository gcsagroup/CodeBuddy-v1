import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import type { Permission } from '../types/permissions';
import type {
  ToolAuthorizationScope,
  ToolPermissionAction,
  ToolPermissionClass,
} from '../types/message';
import { resolveAcpPermissionRequest } from '../acp/permissionRequests';
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
      '{scope, select, task {Allow for this task} session {Allow for this session} other {Always Allow}}',
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
      '{scope, select, task {Allowed for this task} session {Allowed for this session} other {Always allowed}}',
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

  if (isClicked && decision) {
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
        {toolName} - {statusMessages[decision]}
      </p>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mt-2" data-testid="tool-approval-actions">
        {allowActionsVisible && actions.has('allow_once') && (
          <Button
            className="rounded-full"
            variant="secondary"
            onClick={() => handleAction('allow_once')}
          >
            {intl.formatMessage(i18n.allowOnce)}
          </Button>
        )}
        {allowActionsVisible && scopedLongTermAllow && actions.has('always_allow') && (
          <Button
            className="rounded-full"
            variant="secondary"
            onClick={() => handleAction('always_allow')}
          >
            {intl.formatMessage(i18n.allowByScope, { scope: authorizationScope })}
          </Button>
        )}
        {actions.has('deny_once') && (
          <Button
            className="rounded-full"
            variant="outline"
            onClick={() => handleAction('deny_once')}
          >
            {intl.formatMessage(i18n.deny)}
          </Button>
        )}
        {actions.has('always_deny') && (
          <Button
            className="rounded-full"
            variant="outline"
            onClick={() => handleAction('always_deny')}
          >
            {intl.formatMessage(i18n.denyByScope, { scope: authorizationScope })}
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
