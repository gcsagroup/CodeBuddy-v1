import type { CodeProWorkspaceConfirmation, CodeProWorkspaceInspection } from './projectWorkspace';
import { acpLoadSession } from '../acp/sessions';
import { releaseWorkspaceLease, type WorkspaceLease } from '../acp/workspaceLease';

interface BindAllocatedCodeProSessionInput {
  sessionId: string;
  lease: WorkspaceLease;
}

interface BindAllocatedCodeProSessionDependencies {
  loadSession(
    sessionId: string,
    input: { cwd: string; workspaceLeaseId: string }
  ): Promise<unknown>;
  addRecentDir(workingDir: string): Promise<unknown>;
  releaseWorkspaceLease(leaseId: string): Promise<void>;
}

const bindAllocatedDependencies: BindAllocatedCodeProSessionDependencies = {
  loadSession: acpLoadSession,
  addRecentDir: (workingDir) => window.electron.addRecentDir(workingDir),
  releaseWorkspaceLease,
};

export async function bindAllocatedCodeProSession(
  input: BindAllocatedCodeProSessionInput,
  dependencies: BindAllocatedCodeProSessionDependencies = bindAllocatedDependencies
): Promise<{ workingDir: string }> {
  if (!input.lease.created) {
    throw new Error('Allocated workspace lease must identify a newly created directory');
  }

  let loaded = false;
  try {
    await dependencies.loadSession(input.sessionId, {
      cwd: input.lease.workingDir,
      workspaceLeaseId: input.lease.leaseId,
    });
    loaded = true;
    await dependencies.addRecentDir(input.lease.workingDir).catch(() => undefined);
    return { workingDir: input.lease.workingDir };
  } finally {
    if (!loaded) {
      await dependencies.releaseWorkspaceLease(input.lease.leaseId).catch(() => undefined);
    }
  }
}

interface ResumeCodeProSessionInput {
  sessionId: string;
  candidate: CodeProWorkspaceInspection;
}

export interface CodeProWorkspaceReconfirmationRequest {
  sessionId: string;
  workingDir: string;
}

export class CodeProWorkspaceReconfirmationRequiredError extends Error {
  readonly request: CodeProWorkspaceReconfirmationRequest;

  constructor(request: CodeProWorkspaceReconfirmationRequest) {
    super('CodePro workspace must be re-confirmed before this session can be resumed');
    this.name = 'CodeProWorkspaceReconfirmationRequiredError';
    this.request = request;
  }
}

interface ResumeCodeProSessionDependencies {
  acquireWorkspaceLease(input: {
    requestedPath: string;
    expectedState: 'empty-directory' | 'non-empty-directory';
    expectedIdentity: string;
  }): Promise<WorkspaceLease>;
  confirmWorkspace(input: {
    normalizedPath: string;
    expectedState: 'empty-directory' | 'non-empty-directory';
    expectedIdentity: string;
  }): Promise<CodeProWorkspaceConfirmation>;
  loadSession(sessionId: string, input: { cwd: string; workspaceLeaseId: string }): Promise<void>;
  releaseWorkspaceLease(leaseId: string): Promise<void>;
}

function isExistingWorkspace(
  candidate: CodeProWorkspaceInspection
): candidate is CodeProWorkspaceInspection & {
  state: 'empty-directory' | 'non-empty-directory';
} {
  return candidate.state === 'empty-directory' || candidate.state === 'non-empty-directory';
}

export async function resumeCodeProSession(
  input: ResumeCodeProSessionInput,
  dependencies: ResumeCodeProSessionDependencies
): Promise<void> {
  if (!isExistingWorkspace(input.candidate)) {
    throw new Error('Persisted CodePro workspaces must already exist');
  }

  let lease: WorkspaceLease | undefined;
  let loaded = false;
  try {
    lease = await dependencies.acquireWorkspaceLease({
      requestedPath: input.candidate.normalizedPath,
      expectedState: input.candidate.state,
      expectedIdentity: input.candidate.normalizedIdentity,
    });
    if (lease.created || lease.normalizedIdentity !== input.candidate.normalizedIdentity) {
      throw new Error('Workspace lease identity mismatch');
    }

    const confirmation = await dependencies.confirmWorkspace({
      normalizedPath: lease.workingDir,
      expectedState: input.candidate.state,
      expectedIdentity: input.candidate.normalizedIdentity,
    });
    if (confirmation.normalizedIdentity !== lease.normalizedIdentity) {
      throw new Error('Workspace confirmation does not match its lease');
    }

    await dependencies.loadSession(input.sessionId, {
      cwd: lease.workingDir,
      workspaceLeaseId: lease.leaseId,
    });
    loaded = true;
  } finally {
    if (lease && !loaded) {
      await dependencies.releaseWorkspaceLease(lease.leaseId).catch(() => undefined);
    }
  }
}
