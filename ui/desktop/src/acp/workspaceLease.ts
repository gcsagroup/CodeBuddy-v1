import { getAcpClient, getAcpInitializeResponse } from './acpConnection';
import type { CodeProConfirmableWorkspaceState } from '../codepro/projectWorkspace';

const ACQUIRE_WORKSPACE_LEASE_METHOD = '_goose/unstable/workspace/lease/acquire';
const ALLOCATE_WORKSPACE_CHILD_METHOD = '_goose/unstable/workspace/lease/allocate-child';
const RELEASE_WORKSPACE_LEASE_METHOD = '_goose/unstable/workspace/lease/release';

export interface AcquireWorkspaceLeaseInput {
  requestedPath: string;
  expectedState: CodeProConfirmableWorkspaceState;
  expectedIdentity: string;
}

export interface WorkspaceLease {
  leaseId: string;
  workingDir: string;
  normalizedIdentity: string;
  created: boolean;
}

export interface RootCapabilityContext {
  sessionId: string;
  runId: string;
  sourceMessageId: string;
  nonce: string;
}

export function isRootCapabilityContext(value: unknown): value is RootCapabilityContext {
  if (!value || typeof value !== 'object') return false;
  const capability = value as Record<string, unknown>;
  return (
    typeof capability.sessionId === 'string' &&
    capability.sessionId.length > 0 &&
    typeof capability.runId === 'string' &&
    capability.runId.length > 0 &&
    typeof capability.sourceMessageId === 'string' &&
    capability.sourceMessageId.length > 0 &&
    typeof capability.nonce === 'string' &&
    capability.nonce.length > 0
  );
}

export interface AllocateWorkspaceChildInput {
  containerPath: string;
  suggestedName: string;
  capability: RootCapabilityContext;
}

function parseWorkspaceLease(response: Record<string, unknown>): WorkspaceLease {
  if (
    typeof response.leaseId !== 'string' ||
    !response.leaseId ||
    typeof response.workingDir !== 'string' ||
    !response.workingDir ||
    typeof response.normalizedIdentity !== 'string' ||
    !response.normalizedIdentity ||
    typeof response.created !== 'boolean'
  ) {
    throw new Error('Invalid workspace lease response');
  }
  return {
    leaseId: response.leaseId,
    workingDir: response.workingDir,
    normalizedIdentity: response.normalizedIdentity,
    created: response.created,
  };
}

export async function acquireWorkspaceLease(
  input: AcquireWorkspaceLeaseInput
): Promise<WorkspaceLease> {
  const client = await getAcpClient();
  const response = await client.extMethod(ACQUIRE_WORKSPACE_LEASE_METHOD, { ...input });
  return parseWorkspaceLease(response);
}

export async function allocateWorkspaceChild(
  input: AllocateWorkspaceChildInput
): Promise<WorkspaceLease> {
  const client = await getAcpClient();
  const response = await client.extMethod(ALLOCATE_WORKSPACE_CHILD_METHOD, { ...input });
  return parseWorkspaceLease(response);
}

export async function releaseWorkspaceLease(leaseId: string): Promise<void> {
  const client = await getAcpClient();
  await client.extMethod(RELEASE_WORKSPACE_LEASE_METHOD, { leaseId });
}

export class ProjectContainerUpgradeRequiredError extends Error {
  constructor() {
    super('Upgrade the backend to support project containers version 1');
    this.name = 'ProjectContainerUpgradeRequiredError';
  }
}

export class WorkspaceConfirmationUpgradeRequiredError extends Error {
  constructor() {
    super('Update the app and backend to refresh workspace confirmations');
    this.name = 'WorkspaceConfirmationUpgradeRequiredError';
  }
}

export async function refreshWorkspaceConfirmation(
  input: Omit<RootCapabilityContext, 'nonce'>
): Promise<Record<string, unknown>> {
  const response = await getAcpInitializeResponse();
  const goose = response.agentCapabilities?._meta?.goose as Record<string, unknown> | undefined;
  if (goose?.workspaceConfirmationRefresh !== 1) {
    throw new WorkspaceConfirmationUpgradeRequiredError();
  }
  const client = await getAcpClient();
  return client.extMethod('_goose/unstable/workspace/confirmation/v1/refresh', { ...input });
}

export async function allocateProjectChild(
  input: AllocateWorkspaceChildInput
): Promise<WorkspaceLease> {
  const response = await getAcpInitializeResponse();
  const goose = response.agentCapabilities?._meta?.goose as Record<string, unknown> | undefined;
  if (goose?.projectContainers !== 1) {
    throw new ProjectContainerUpgradeRequiredError();
  }
  const client = await getAcpClient();
  return parseWorkspaceLease(
    await client.extMethod('_goose/unstable/workspace/project-container/v1/allocate-child', {
      ...input,
    })
  );
}
