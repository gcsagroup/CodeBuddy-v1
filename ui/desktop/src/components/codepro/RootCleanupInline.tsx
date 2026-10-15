import { useRef, useState } from 'react';
import type { SystemNotificationContent } from '../../types/message';
import {
  auditRootCleanup,
  cancelRootCleanup,
  executeRootCleanup,
  listRootCleanupRecoveries,
  permanentlyDeleteQuarantinedCleanup,
  retryRootCleanupRecovery,
  restoreQuarantinedCleanup,
  type RootCleanupAudit,
  type RootCleanupQuarantine,
  type RootCleanupRecoveryDiagnostic,
} from '../../acp/rootCleanup';
import { isRootCapabilityContext, type RootCapabilityContext } from '../../acp/workspaceLease';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  readOnlyExpired: {
    id: 'rootCleanup.readOnlyExpired',
    defaultMessage:
      'This audit authorization has expired. Send a new cleanup audit request to continue.',
  },
  readOnly: {
    id: 'rootCleanup.readOnly',
    defaultMessage:
      'Read-only audit. Quarantine, deletion and recovery are unavailable on this backend.',
  },
  completed: { id: 'rootCleanup.completed', defaultMessage: 'Exact cleanup completed.' },
  restricted: {
    id: 'rootCleanup.restricted',
    defaultMessage:
      'Cleanup is restricted to one exact target under {rootPath}. No project directory is created.',
  },
  selectAndAudit: {
    id: 'rootCleanup.selectAndAudit',
    defaultMessage: 'Select exact target and audit',
  },
  bytes: { id: 'rootCleanup.bytes', defaultMessage: '{bytes} bytes' },
  quarantined: {
    id: 'rootCleanup.quarantined',
    defaultMessage:
      'The exact target is quarantined. Permanent deletion needs one final confirmation.',
  },
  recoverableMove: {
    id: 'rootCleanup.recoverableMove',
    defaultMessage:
      'The first confirmation only moves the exact target into a recoverable same-volume quarantine.',
  },
  confirmDelete: {
    id: 'rootCleanup.confirmDelete',
    defaultMessage: 'Confirm permanent deletion',
  },
  confirmQuarantine: {
    id: 'rootCleanup.confirmQuarantine',
    defaultMessage: 'Confirm quarantine move',
  },
  restore: {
    id: 'rootCleanup.restore',
    defaultMessage: 'Restore quarantined target',
  },
  cancel: { id: 'rootCleanup.cancel', defaultMessage: 'Cancel' },
  authorizationExpired: {
    id: 'rootCleanup.authorizationExpired',
    defaultMessage: 'Cleanup authorization expired or was safely restored. Select and audit again.',
  },
  checkRecoveries: {
    id: 'rootCleanup.checkRecoveries',
    defaultMessage: 'Check recoverable cleanup items',
  },
  retryOriginal: {
    id: 'rootCleanup.retryOriginal',
    defaultMessage: 'Retry original location',
  },
  remainsQuarantined: {
    id: 'rootCleanup.remainsQuarantined',
    defaultMessage: 'Recovery remains quarantined at {path}',
  },
});

interface RootCleanupRequiredEvent {
  event: 'codepro.cleanup_audit_required';
  rootContainerPath: string;
  writableRoot: null;
  writeCount: 0;
  capability: RootCapabilityContext;
  executionAvailable?: boolean;
}

export function parseRootCleanupRequiredEvent(data: unknown): RootCleanupRequiredEvent | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (
    value.event !== 'codepro.cleanup_audit_required' ||
    typeof value.rootContainerPath !== 'string' ||
    !value.rootContainerPath ||
    value.writableRoot !== null ||
    value.writeCount !== 0 ||
    (value.executionAvailable !== undefined && typeof value.executionAvailable !== 'boolean') ||
    !isRootCapabilityContext(value.capability)
  ) {
    return null;
  }
  return value as unknown as RootCleanupRequiredEvent;
}

interface RootCleanupPromptProps {
  executionAvailable?: boolean;
  rootPath: string;
  selectAndAudit: () => Promise<RootCleanupAudit | null>;
  execute: (auditToken: string) => Promise<RootCleanupQuarantine>;
  permanentlyDelete: (quarantineToken: string) => Promise<void>;
  restore: (quarantineToken: string) => Promise<void>;
  cancel: (auditToken: string) => Promise<void>;
}

export function RootCleanupPrompt({
  executionAvailable,
  rootPath,
  selectAndAudit,
  execute,
  permanentlyDelete,
  restore,
  cancel,
}: RootCleanupPromptProps) {
  const intl = useIntl();
  const [audit, setAudit] = useState<RootCleanupAudit | null>(null);
  const [quarantine, setQuarantine] = useState<RootCleanupQuarantine | null>(null);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [readOnlyExpired, setReadOnlyExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canExecute = executionAvailable !== false && audit?.executionAvailable !== false;
  if (complete) return <div>{intl.formatMessage(i18n.completed)}</div>;
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (/missing|expired|already consumed/i.test(message)) {
        setAudit(null);
        setQuarantine(null);
        if (!canExecute) setReadOnlyExpired(true);
        setError(intl.formatMessage(canExecute ? i18n.authorizationExpired : i18n.readOnlyExpired));
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-md border border-border bg-background-muted p-3 text-sm">
      <p>{intl.formatMessage(i18n.restricted, { rootPath })}</p>
      {!canExecute && <p>{intl.formatMessage(i18n.readOnly)}</p>}
      {!audit ? (
        <button
          type="button"
          disabled={busy || readOnlyExpired}
          onClick={() =>
            void run(async () => {
              const result = await selectAndAudit();
              if (result) setAudit(result);
            })
          }
        >
          {intl.formatMessage(i18n.selectAndAudit)}
        </button>
      ) : (
        <div>
          <p className="font-mono text-xs">{audit.target.relativePath}</p>
          <p>
            {audit.target.targetType} ·{' '}
            {intl.formatMessage(i18n.bytes, { bytes: audit.target.bytes })}
          </p>
          {canExecute && (
            <p>
              {quarantine
                ? intl.formatMessage(i18n.quarantined)
                : intl.formatMessage(i18n.recoverableMove)}
            </p>
          )}
          {canExecute && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (quarantine) {
                    await permanentlyDelete(quarantine.quarantineToken);
                    setComplete(true);
                  } else {
                    setQuarantine(await execute(audit.auditToken));
                  }
                })
              }
            >
              {quarantine
                ? intl.formatMessage(i18n.confirmDelete)
                : intl.formatMessage(i18n.confirmQuarantine)}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (quarantine) {
                  await restore(quarantine.quarantineToken);
                  setQuarantine(null);
                } else {
                  await cancel(audit.auditToken);
                }
                setAudit(null);
              })
            }
          >
            {quarantine ? intl.formatMessage(i18n.restore) : intl.formatMessage(i18n.cancel)}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function RootCleanupInline({ notification }: { notification: SystemNotificationContent }) {
  const event = parseRootCleanupRequiredEvent(notification.data);
  if (!event) return null;
  return (
    <div>
      <RootCleanupPrompt
        executionAvailable={event.executionAvailable}
        rootPath={event.rootContainerPath}
        selectAndAudit={async () => {
          const target = await window.electron.selectRootCleanupTarget(event.rootContainerPath);
          return target
            ? auditRootCleanup(event.rootContainerPath, target, event.capability)
            : null;
        }}
        execute={(auditToken) => executeRootCleanup(auditToken, event.capability)}
        permanentlyDelete={(quarantineToken) =>
          permanentlyDeleteQuarantinedCleanup(quarantineToken, event.capability)
        }
        restore={(quarantineToken) => restoreQuarantinedCleanup(quarantineToken, event.capability)}
        cancel={(auditToken) => cancelRootCleanup(auditToken, event.capability)}
      />
      {event.executionAvailable !== false && (
        <RootCleanupRecoveryPanel capability={event.capability} />
      )}
    </div>
  );
}

export function RootCleanupRecoveryPanel({
  capability,
  list = listRootCleanupRecoveries,
  retry = retryRootCleanupRecovery,
}: {
  capability: RootCapabilityContext;
  list?: typeof listRootCleanupRecoveries;
  retry?: typeof retryRootCleanupRecovery;
}) {
  const intl = useIntl();
  const [recoveries, setRecoveries] = useState<RootCleanupRecoveryDiagnostic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setRecoveries(await list(capability));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 rounded-md border border-border p-3 text-sm">
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {intl.formatMessage(i18n.checkRecoveries)}
      </button>
      {recoveries.map((recovery) => (
        <div key={recovery.quarantineToken} className="mt-2">
          <p>
            {recovery.phase}: {recovery.originalPath}
          </p>
          <button
            type="button"
            disabled={busy || !recovery.retryOriginalAvailable}
            onClick={() =>
              void (async () => {
                if (inFlight.current) return;
                inFlight.current = true;
                setBusy(true);
                const result = await retry(capability, recovery.quarantineToken);
                if (result.revealPath) {
                  setError(
                    intl.formatMessage(i18n.remainsQuarantined, { path: result.revealPath })
                  );
                }
                setRecoveries(await list(capability));
              })()
                .catch((reason) =>
                  setError(reason instanceof Error ? reason.message : String(reason))
                )
                .finally(() => {
                  inFlight.current = false;
                  setBusy(false);
                })
            }
          >
            {intl.formatMessage(i18n.retryOriginal)}
          </button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
