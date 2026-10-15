import { getAcpClient } from './acpConnection';
import type { RootCapabilityContext } from './workspaceLease';

const AUDIT_METHOD = '_goose/unstable/root-cleanup/audit';
const EXECUTE_METHOD = '_goose/unstable/root-cleanup/execute';
const PERMANENT_DELETE_METHOD = '_goose/unstable/root-cleanup/permanent-delete';
const RESTORE_QUARANTINE_METHOD = '_goose/unstable/root-cleanup/restore-quarantine';
const CANCEL_METHOD = '_goose/unstable/root-cleanup/cancel';
const LIST_RECOVERY_METHOD = '_goose/unstable/root-cleanup/recovery/list';
const RETRY_RECOVERY_METHOD = '_goose/unstable/root-cleanup/recovery/retry-original';

export interface RootCleanupAudit {
  auditToken: string;
  rootIdentity: string;
  target: {
    relativePath: string;
    targetType: 'file' | 'empty-directory';
    bytes: number;
    modifiedMillis: number;
    hash: string | null;
  };
  destructiveConfirmationRequired: true;
  executionAvailable?: boolean;
}

export interface RootCleanupQuarantine {
  quarantineToken: string;
  target: RootCleanupAudit['target'];
  permanentConfirmationRequired: true;
}

export interface RootCleanupRecoveryDiagnostic {
  quarantineToken: string;
  phase: string;
  originalPath: string;
  quarantinePath: string;
  retryOriginalAvailable: boolean;
}

export interface RootCleanupRecoveryResult {
  restored: boolean;
  revealPath: string | null;
}

export async function auditRootCleanup(
  rootPath: string,
  target: string,
  capability: RootCapabilityContext
): Promise<RootCleanupAudit> {
  const client = await getAcpClient();
  const response = await client.extMethod(AUDIT_METHOD, {
    rootPath,
    targets: [target],
    capability,
  });
  if (
    typeof response.auditToken !== 'string' ||
    !response.auditToken ||
    typeof response.rootIdentity !== 'string' ||
    !response.rootIdentity ||
    response.destructiveConfirmationRequired !== true ||
    (response.executionAvailable !== undefined &&
      typeof response.executionAvailable !== 'boolean') ||
    !response.target ||
    typeof response.target !== 'object'
  ) {
    throw new Error('Invalid root cleanup audit response');
  }
  const targetSummary = response.target as Record<string, unknown>;
  if (
    typeof targetSummary.relativePath !== 'string' ||
    !targetSummary.relativePath ||
    (targetSummary.targetType !== 'file' && targetSummary.targetType !== 'empty-directory') ||
    typeof targetSummary.bytes !== 'number' ||
    typeof targetSummary.modifiedMillis !== 'number' ||
    (targetSummary.hash !== null && typeof targetSummary.hash !== 'string')
  ) {
    throw new Error('Invalid root cleanup target summary');
  }
  return response as unknown as RootCleanupAudit;
}

export async function executeRootCleanup(
  auditToken: string,
  capability: RootCapabilityContext
): Promise<RootCleanupQuarantine> {
  const client = await getAcpClient();
  const response = await client.extMethod(EXECUTE_METHOD, { auditToken, capability });
  if (
    typeof response.quarantineToken !== 'string' ||
    !response.quarantineToken ||
    response.permanentConfirmationRequired !== true ||
    !response.target ||
    typeof response.target !== 'object'
  ) {
    throw new Error('Invalid cleanup quarantine response');
  }
  return response as unknown as RootCleanupQuarantine;
}

export async function permanentlyDeleteQuarantinedCleanup(
  quarantineToken: string,
  capability: RootCapabilityContext
): Promise<void> {
  const client = await getAcpClient();
  await client.extMethod(PERMANENT_DELETE_METHOD, { quarantineToken, capability });
}

export async function restoreQuarantinedCleanup(
  quarantineToken: string,
  capability: RootCapabilityContext
): Promise<void> {
  const client = await getAcpClient();
  await client.extMethod(RESTORE_QUARANTINE_METHOD, { quarantineToken, capability });
}

export async function cancelRootCleanup(
  auditToken: string,
  capability: RootCapabilityContext
): Promise<void> {
  const client = await getAcpClient();
  await client.extMethod(CANCEL_METHOD, { auditToken, capability });
}

export async function listRootCleanupRecoveries(
  capability: RootCapabilityContext
): Promise<RootCleanupRecoveryDiagnostic[]> {
  const client = await getAcpClient();
  const response = await client.extMethod(LIST_RECOVERY_METHOD, { capability });
  if (!Array.isArray(response.recoveries)) {
    throw new Error('Invalid cleanup recovery list response');
  }
  for (const recovery of response.recoveries) {
    if (
      !recovery ||
      typeof recovery !== 'object' ||
      typeof recovery.quarantineToken !== 'string' ||
      !recovery.quarantineToken ||
      typeof recovery.phase !== 'string' ||
      typeof recovery.originalPath !== 'string' ||
      typeof recovery.quarantinePath !== 'string' ||
      typeof recovery.retryOriginalAvailable !== 'boolean'
    ) {
      throw new Error('Invalid cleanup recovery diagnostic');
    }
  }
  return response.recoveries as RootCleanupRecoveryDiagnostic[];
}

export async function retryRootCleanupRecovery(
  capability: RootCapabilityContext,
  quarantineToken: string
): Promise<RootCleanupRecoveryResult> {
  const client = await getAcpClient();
  const response = await client.extMethod(RETRY_RECOVERY_METHOD, {
    capability,
    quarantineToken,
  });
  if (
    typeof response.restored !== 'boolean' ||
    (response.revealPath !== null && typeof response.revealPath !== 'string')
  ) {
    throw new Error('Invalid cleanup recovery response');
  }
  return response as unknown as RootCleanupRecoveryResult;
}
