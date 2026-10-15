import { useEffect, useRef, useState } from 'react';
import type { Message, SystemNotificationContent, UserInput } from '../../types/message';
import {
  allocateWorkspaceChild,
  allocateProjectChild,
  ProjectContainerUpgradeRequiredError,
  refreshWorkspaceConfirmation,
  WorkspaceConfirmationUpgradeRequiredError,
  isRootCapabilityContext,
  type RootCapabilityContext,
} from '../../acp/workspaceLease';
import { bindAllocatedCodeProSession } from '../../codepro/resumeCodeProSession';
import { isFilesystemRoot } from '../../codepro/projectWorkspace';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  refresh: {
    id: 'needsWorkspace.refresh',
    defaultMessage: 'Refresh project confirmation',
  },
  refreshing: {
    id: 'needsWorkspace.refreshing',
    defaultMessage: 'Refreshing…',
  },
  refreshFailed: {
    id: 'needsWorkspace.refreshFailed',
    defaultMessage:
      'This task could not renew its project confirmation. Check that it is still waiting for a project folder.',
  },
  refreshUpgrade: {
    id: 'needsWorkspace.refreshUpgrade',
    defaultMessage: 'Update the app and backend together to refresh this project confirmation.',
  },
  upgradeBackend: {
    id: 'needsWorkspace.upgradeBackend',
    defaultMessage:
      'Update the app and backend together to create projects in a parent folder. No directory was created.',
  },
  chooseProjectParent: {
    id: 'needsWorkspace.chooseProjectParent',
    defaultMessage: 'Choose project parent folder',
  },
  projectParentHelp: {
    id: 'needsWorkspace.projectParentHelp',
    defaultMessage:
      'Choose a writable folder. Only the new project inside it will receive write access.',
  },
  projectParentInvalid: {
    id: 'needsWorkspace.projectParentInvalid',
    defaultMessage: 'Choose an existing local folder below the filesystem root.',
  },
  projectParentFailed: {
    id: 'needsWorkspace.projectParentFailed',
    defaultMessage: 'Could not inspect the project parent folder. Choose another folder.',
  },

  projectCreationCancelled: {
    id: 'needsWorkspace.projectCreationCancelled',
    defaultMessage: 'Project creation cancelled. No directory was created.',
  },
  writableProjectRequired: {
    id: 'needsWorkspace.writableProjectRequired',
    defaultMessage: 'Creating a safe project folder here, then continuing in this conversation.',
  },
  creating: { id: 'needsWorkspace.creating', defaultMessage: 'Creating…' },
  created: { id: 'needsWorkspace.created', defaultMessage: 'Created' },
  createdAt: {
    id: 'needsWorkspace.createdAt',
    defaultMessage: 'Project created at {path}. Continuing here now.',
  },
  confirmProject: { id: 'needsWorkspace.confirmProject', defaultMessage: 'Confirm project' },
  retry: { id: 'appsView.retry', defaultMessage: 'Retry' },
  cancel: { id: 'needsWorkspace.cancel', defaultMessage: 'Cancel' },
  chooseFilesystemRoot: {
    id: 'needsWorkspace.chooseFilesystemRoot',
    defaultMessage: 'Choose a filesystem root to use only as a project container.',
  },
  reviewExactChildPath: {
    id: 'needsWorkspace.reviewExactChildPath',
    defaultMessage:
      'No directory will be created until you review and confirm the exact child path.',
  },
  selectFilesystemRoot: {
    id: 'needsWorkspace.selectFilesystemRoot',
    defaultMessage: 'Select a filesystem root to use as the project container',
  },
  choosing: { id: 'needsWorkspace.choosing', defaultMessage: 'Choosing…' },
  chooseRootContainer: {
    id: 'needsWorkspace.chooseRootContainer',
    defaultMessage: 'Choose root container',
  },
  retryablePermission: {
    id: 'needsWorkspace.retryablePermission',
    defaultMessage: 'Workspace access was denied. Retry to use the same authorization.',
  },
  setupUnknown: {
    id: 'needsWorkspace.setupUnknown',
    defaultMessage:
      'Workspace setup failed. The project state is unknown and may require manual review.',
  },
  continuationFailed: {
    id: 'needsWorkspace.continuationFailed',
    defaultMessage:
      'The project was created at {path}, but continuing was interrupted. Retry to continue here.',
  },
  rootSelectionFailed: {
    id: 'needsWorkspace.rootSelectionFailed',
    defaultMessage: 'Unable to choose a filesystem root. Try again.',
  },
  containerConfirmationMissing: {
    id: 'needsWorkspace.containerConfirmationMissing',
    defaultMessage: 'Project container confirmation is missing',
  },
});

export interface NeedsWorkspaceEvent {
  event: 'codepro.needs_workspace' | 'codepro.needs_project_workspace_v1';
  rootContainerPath: string | null;
  suggestedChildName: string;
  writableRoot: null;
  capability: RootCapabilityContext;
}

class WorkspaceSetupError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'WorkspaceSetupError';
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRetryableWorkspacePermissionError(reason: unknown): boolean {
  const error = objectRecord(reason);
  if (!error) return false;
  const envelope = hasOwn(error, 'error') ? objectRecord(error.error) : error;
  if (!envelope || !hasOwn(envelope, 'data')) return false;
  const data = objectRecord(envelope?.data);
  if (
    !data ||
    !hasOwn(data, 'code') ||
    !hasOwn(data, 'retryable') ||
    !hasOwn(data, 'capabilityPreserved')
  ) {
    return false;
  }
  return (
    data.code === 'workspace_permission_denied' &&
    data.retryable === true &&
    data.capabilityPreserved === true
  );
}

function isReservedWindowsChildName(name: string): boolean {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.split('.')[0]);
}

export function parseNeedsWorkspaceEvent(data: unknown): NeedsWorkspaceEvent | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (
    (value.event !== 'codepro.needs_workspace' &&
      value.event !== 'codepro.needs_project_workspace_v1') ||
    (value.rootContainerPath !== null && typeof value.rootContainerPath !== 'string') ||
    typeof value.suggestedChildName !== 'string' ||
    !/^[\p{L}\p{N}][\p{L}\p{N}-]{0,47}$/u.test(value.suggestedChildName) ||
    isReservedWindowsChildName(value.suggestedChildName) ||
    value.writableRoot !== null ||
    !isRootCapabilityContext(value.capability)
  ) {
    return null;
  }
  return value as unknown as NeedsWorkspaceEvent;
}

export function findNeedsWorkspaceSourceMessage(
  messages: Message[],
  notificationIndex: number,
  event: NeedsWorkspaceEvent
): Message | undefined {
  const currentTurn = messages.slice(0, notificationIndex);
  const exact = currentTurn.find(
    (message) => message.role === 'user' && message.id === event.capability.sourceMessageId
  );
  if (exact) return exact;
  const fallback = currentTurn.reverse().find((message) => message.role === 'user');
  return fallback ? { ...fallback, id: event.capability.sourceMessageId } : undefined;
}

interface NeedsWorkspacePromptProps {
  event: NeedsWorkspaceEvent;
  onConfirm: () => Promise<void>;
  automatic?: boolean;
  completedPath?: string | null;
  onRefresh?: () => Promise<void>;
}

export function NeedsWorkspacePrompt({
  event,
  onConfirm,
  automatic = false,
  completedPath = null,
  onRefresh,
}: NeedsWorkspacePromptProps) {
  const intl = useIntl();
  const automaticStarted = useRef(false);
  const [state, setState] = useState<'idle' | 'creating' | 'cancelled' | 'complete' | 'failed'>(
    'idle'
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    setError(null);
    void onRefresh()
      .catch((reason) => {
        setError(
          intl.formatMessage(
            reason instanceof WorkspaceConfirmationUpgradeRequiredError
              ? i18n.refreshUpgrade
              : i18n.refreshFailed
          )
        );
      })
      .finally(() => setRefreshing(false));
  };
  const refreshButton = onRefresh && state !== 'creating' && state !== 'complete' && (
    <button type="button" disabled={refreshing} onClick={refresh}>
      {intl.formatMessage(refreshing ? i18n.refreshing : i18n.refresh)}
    </button>
  );
  const begin = () => {
    setState('creating');
    setError(null);
    void onConfirm()
      .then(() => setState('complete'))
      .catch((reason) => {
        const failure =
          reason instanceof WorkspaceSetupError
            ? reason
            : new WorkspaceSetupError(intl.formatMessage(i18n.setupUnknown), false);
        setError(failure.message);
        setState(failure.retryable ? 'idle' : 'failed');
      });
  };
  useEffect(() => {
    if (!automatic || automaticStarted.current) return;
    automaticStarted.current = true;
    begin();
  });
  if (state === 'cancelled') return <div>{intl.formatMessage(i18n.projectCreationCancelled)}</div>;
  if (state === 'complete' && completedPath) {
    return <div>{intl.formatMessage(i18n.createdAt, { path: completedPath })}</div>;
  }
  if (automatic) {
    if (!error) return null;
    return (
      <div className="rounded-md border border-border bg-background-muted p-3 text-sm">
        <p role="alert">{error}</p>
        {state === 'idle' && (
          <button type="button" className="mt-2" disabled={refreshing} onClick={begin}>
            {intl.formatMessage(i18n.retry)}
          </button>
        )}
        {refreshButton}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-background-muted p-3 text-sm">
      <p>{intl.formatMessage(i18n.writableProjectRequired)}</p>
      <p className="mt-1 font-mono text-xs">
        {event.rootContainerPath
          ? `${event.rootContainerPath}${event.event === 'codepro.needs_project_workspace_v1' && !event.rootContainerPath.endsWith('/') ? '/' : ''}${event.suggestedChildName}`
          : event.suggestedChildName}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={state !== 'idle' || refreshing} onClick={begin}>
          {state === 'creating'
            ? intl.formatMessage(i18n.creating)
            : state === 'complete'
              ? intl.formatMessage(i18n.created)
              : intl.formatMessage(i18n.confirmProject)}
        </button>
        <button
          type="button"
          disabled={state === 'creating' || state === 'complete' || refreshing}
          onClick={() => setState('cancelled')}
        >
          {intl.formatMessage(i18n.cancel)}
        </button>
        {refreshButton}
      </div>
    </div>
  );
}

interface NeedsWorkspaceInlineProps {
  notification: SystemNotificationContent;
  originalMessage: Message | UserInput;
  onResumeAfterWorkspace?: WorkspaceContinuationHandler;
}

type WorkspaceContinuationHandler = (message: Message, runId: string) => void | Promise<void>;

const workspaceContinuationFlights = new Map<string, Promise<string>>();

function workspaceContinuationKey(event: NeedsWorkspaceEvent): string {
  return JSON.stringify([
    event.event,
    event.capability.sessionId,
    event.capability.runId,
    event.capability.sourceMessageId,
    event.capability.nonce,
    event.rootContainerPath,
    event.suggestedChildName,
  ]);
}

export function NeedsWorkspaceInline({
  notification,
  originalMessage,
  onResumeAfterWorkspace,
}: NeedsWorkspaceInlineProps) {
  const intl = useIntl();
  const originalEvent = parseNeedsWorkspaceEvent(notification.data);
  const [refreshed, setRefreshed] = useState<{
    sourceKey: string;
    event: NeedsWorkspaceEvent;
    revision: number;
  } | null>(null);
  const sourceKey = originalEvent ? workspaceContinuationKey(originalEvent) : '';
  const event = refreshed?.sourceKey === sourceKey ? refreshed.event : originalEvent;
  const [selectedContainerPath, setSelectedContainerPath] = useState<string | null>(null);
  const [completedPath, setCompletedPath] = useState<string | null>(null);
  const boundWorkspaceRef = useRef<string | null>(null);
  const [selectionState, setSelectionState] = useState<'idle' | 'selecting' | 'cancelled'>('idle');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  if (!event) return null;
  const projectContainer = event.event === 'codepro.needs_project_workspace_v1';

  if (!event.rootContainerPath && !selectedContainerPath) {
    if (selectionState === 'cancelled') {
      return <div>{intl.formatMessage(i18n.projectCreationCancelled)}</div>;
    }
    return (
      <div className="rounded-md border border-border bg-background-muted p-3 text-sm">
        <p>
          {intl.formatMessage(
            projectContainer ? i18n.projectParentHelp : i18n.chooseFilesystemRoot
          )}
        </p>
        <p>{intl.formatMessage(i18n.reviewExactChildPath)}</p>
        {selectionError && <p role="alert">{selectionError}</p>}
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={selectionState !== 'idle'}
            onClick={() => {
              setSelectionState('selecting');
              setSelectionError(null);
              void window.electron
                .directoryChooser()
                .then(async (selection) => {
                  if (selection.canceled || selection.filePaths.length !== 1) {
                    setSelectionState('idle');
                    return;
                  }
                  let [containerPath] = selection.filePaths;
                  if (projectContainer) {
                    const [inspection] = await window.electron.inspectCodeProWorkspace({
                      prompt: '',
                      selectedWorkingDir: containerPath,
                    });
                    if (
                      !inspection?.canonicalPath ||
                      !['empty-directory', 'non-empty-directory'].includes(inspection.state) ||
                      !inspection.canonicalPath.startsWith('/') ||
                      isFilesystemRoot(inspection.canonicalPath)
                    ) {
                      throw new Error(intl.formatMessage(i18n.projectParentInvalid));
                    }
                    containerPath = inspection.canonicalPath;
                  } else if (!containerPath || !isFilesystemRoot(containerPath)) {
                    throw new Error(intl.formatMessage(i18n.selectFilesystemRoot));
                  }
                  setSelectedContainerPath(containerPath);
                  setSelectionState('idle');
                })
                .catch(() => {
                  setSelectionError(
                    intl.formatMessage(
                      projectContainer ? i18n.projectParentFailed : i18n.rootSelectionFailed
                    )
                  );
                  setSelectionState('idle');
                });
            }}
          >
            {selectionState === 'selecting'
              ? intl.formatMessage(i18n.choosing)
              : intl.formatMessage(
                  projectContainer ? i18n.chooseProjectParent : i18n.chooseRootContainer
                )}
          </button>
          <button type="button" onClick={() => setSelectionState('cancelled')}>
            {intl.formatMessage(i18n.cancel)}
          </button>
        </div>
      </div>
    );
  }

  const confirmedEvent = {
    ...event,
    rootContainerPath: event.rootContainerPath ?? selectedContainerPath,
  };

  const confirm = async () => {
    const containerPath = confirmedEvent.rootContainerPath;
    if (!containerPath) throw new Error(intl.formatMessage(i18n.containerConfirmationMissing));
    if (
      projectContainer
        ? !containerPath.startsWith('/') || isFilesystemRoot(containerPath)
        : !isFilesystemRoot(containerPath)
    ) {
      throw new Error(
        intl.formatMessage(projectContainer ? i18n.projectParentInvalid : i18n.selectFilesystemRoot)
      );
    }

    const createAndBindWorkspace = async () => {
      const lease = await (projectContainer ? allocateProjectChild : allocateWorkspaceChild)({
        containerPath,
        suggestedName: confirmedEvent.suggestedChildName,
        capability: confirmedEvent.capability,
      }).catch((reason) => {
        if (reason instanceof ProjectContainerUpgradeRequiredError) {
          throw new WorkspaceSetupError(intl.formatMessage(i18n.upgradeBackend), false);
        }
        if (isRetryableWorkspacePermissionError(reason)) {
          throw new WorkspaceSetupError(intl.formatMessage(i18n.retryablePermission), true);
        }
        throw new WorkspaceSetupError(intl.formatMessage(i18n.setupUnknown), false);
      });
      const bound = await bindAllocatedCodeProSession({
        sessionId: confirmedEvent.capability.sessionId,
        lease,
      });
      return bound.workingDir;
    };

    const resume = async (workingDir: string) => {
      if (!('role' in originalMessage)) return;
      try {
        await onResumeAfterWorkspace?.(originalMessage, confirmedEvent.capability.runId);
      } catch {
        throw new WorkspaceSetupError(
          intl.formatMessage(i18n.continuationFailed, { path: workingDir }),
          true
        );
      }
    };

    if (onResumeAfterWorkspace) {
      const key = workspaceContinuationKey(confirmedEvent);
      let inFlight = workspaceContinuationFlights.get(key);
      if (!inFlight) {
        inFlight = (async () => {
          const workingDir = boundWorkspaceRef.current ?? (await createAndBindWorkspace());
          boundWorkspaceRef.current = workingDir;
          await resume(workingDir);
          return workingDir;
        })();
        workspaceContinuationFlights.set(key, inFlight);
        void inFlight
          .finally(() => {
            if (workspaceContinuationFlights.get(key) === inFlight) {
              workspaceContinuationFlights.delete(key);
            }
          })
          .catch(() => undefined);
      }
      const workingDir = await inFlight;
      boundWorkspaceRef.current = workingDir;
      setCompletedPath(workingDir);
      return;
    }

    if (!boundWorkspaceRef.current) {
      boundWorkspaceRef.current = await createAndBindWorkspace();
      setCompletedPath(boundWorkspaceRef.current);
    }
    await resume(boundWorkspaceRef.current);
  };

  const refresh = async () => {
    const { sessionId, runId, sourceMessageId } = event.capability;
    const response = await refreshWorkspaceConfirmation({ sessionId, runId, sourceMessageId });
    const next = parseNeedsWorkspaceEvent(response);
    if (
      !next ||
      next.event !== event.event ||
      next.capability.sessionId !== sessionId ||
      next.capability.runId !== runId ||
      next.capability.sourceMessageId !== sourceMessageId
    ) {
      throw new Error('Workspace confirmation response does not match the original task');
    }
    setRefreshed((previous) => ({
      sourceKey,
      event: next,
      revision: (previous?.revision ?? 0) + 1,
    }));
  };

  return (
    <NeedsWorkspacePrompt
      key={`${sourceKey}:${refreshed?.revision ?? 0}`}
      event={confirmedEvent}
      onConfirm={confirm}
      automatic={!projectContainer && refreshed?.sourceKey !== sourceKey}
      onRefresh={boundWorkspaceRef.current ? undefined : refresh}
      completedPath={completedPath}
    />
  );
}
