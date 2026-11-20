import type { FixedExtensionEntry } from '../components/ConfigContext';
import type { UserInput } from '../types/message';
import type { Session } from '../types/session';
import { createSession } from '../sessions';
import {
  acquireWorkspaceLease,
  releaseWorkspaceLease,
  type WorkspaceLease,
} from '../acp/workspaceLease';
import { findOrCreateCodeProProject, type CodeProProjectBinding } from '../acp/sources';
import {
  type CodeProConfirmableWorkspaceState,
  type CodeProWorkspaceConfirmation,
  type CodeProWorkspaceInspection,
} from './projectWorkspace';
import { normalizeWorkspaceIdentity } from './workspaceIdentity';
import { CodeProRollbackError } from './failureSemantics';

interface StartCodeProSessionInput {
  workspaceOrigin?: 'default' | 'selected';
  initialPermissionPreset?: Session['goose_mode'];
  candidate: CodeProWorkspaceInspection;
  initialMessage: UserInput;
  allExtensions: FixedExtensionEntry[];
  recipeDeeplink?: string;
  recipeId?: string;
}

interface StartCodeProSessionDependencies {
  requiresWorkspaceLease: () => boolean;
  acquireWorkspaceLease: typeof acquireWorkspaceLease;
  releaseWorkspaceLease: typeof releaseWorkspaceLease;
  confirmWorkspace: (input: {
    normalizedPath: string;
    expectedState: CodeProConfirmableWorkspaceState;
    expectedIdentity: string;
  }) => Promise<CodeProWorkspaceConfirmation>;
  findOrCreateProject: (input: {
    workingDir: string;
    normalizedIdentity: string;
    displayName: string;
    suggestedProjectId: string;
  }) => Promise<CodeProProjectBinding>;
  createSession: typeof createSession;
  addRecentDir: (workingDir: string) => Promise<unknown>;
  deleteCreatedProject: (project: CodeProProjectBinding) => Promise<void>;
}

const defaultDependencies = (): StartCodeProSessionDependencies => ({
  requiresWorkspaceLease: () => ['win32', 'darwin'].includes(window.electron.platform),
  acquireWorkspaceLease,
  releaseWorkspaceLease,
  confirmWorkspace: (input) => window.electron.confirmCodeProWorkspace(input),
  findOrCreateProject: findOrCreateCodeProProject,
  createSession,
  addRecentDir: (workingDir) => window.electron.addRecentDir(workingDir),
  deleteCreatedProject: async (project) => {
    if (!project.created || !project.source.path) return;
    const { getAcpClient } = await import('../acp/acpConnection');
    const client = await getAcpClient();
    await client.goose.sourcesDelete_unstable({ type: 'project', path: project.source.path });
  },
});

function isConfirmableWorkspaceState(
  state: CodeProWorkspaceInspection['state']
): state is CodeProConfirmableWorkspaceState {
  return state === 'missing' || state === 'empty-directory' || state === 'non-empty-directory';
}

export async function startCodeProSession(
  input: StartCodeProSessionInput,
  overrides: Partial<StartCodeProSessionDependencies> = {}
): Promise<{
  session: Session;
  projectId: string;
  confirmation: CodeProWorkspaceConfirmation;
}> {
  if (!isConfirmableWorkspaceState(input.candidate.state)) {
    throw new Error('Workspace candidate is not confirmable');
  }
  const dependencies = { ...defaultDependencies(), ...overrides };
  let lease: WorkspaceLease | undefined;
  let sessionCreated = false;
  let project: CodeProProjectBinding | undefined;
  try {
    if (dependencies.requiresWorkspaceLease()) {
      lease = await dependencies.acquireWorkspaceLease({
        requestedPath: input.candidate.normalizedPath,
        expectedState: input.candidate.state,
        expectedIdentity: input.candidate.normalizedIdentity,
      });
      if (lease.normalizedIdentity !== input.candidate.normalizedIdentity) {
        throw new Error('Workspace lease identity mismatch');
      }
      if (normalizeWorkspaceIdentity(lease.workingDir) !== lease.normalizedIdentity) {
        throw new Error('Workspace lease working directory mismatch');
      }
    }
    const confirmed = await dependencies.confirmWorkspace({
      normalizedPath: lease?.workingDir ?? input.candidate.normalizedPath,
      expectedState: lease?.created ? 'empty-directory' : input.candidate.state,
      expectedIdentity: lease?.normalizedIdentity ?? input.candidate.normalizedIdentity,
    });
    if (lease && confirmed.normalizedIdentity !== lease.normalizedIdentity) {
      throw new Error('Workspace confirmation does not match its lease');
    }
    const confirmation = {
      ...confirmed,
      workingDir: lease?.workingDir ?? confirmed.workingDir,
      normalizedIdentity: lease?.normalizedIdentity ?? confirmed.normalizedIdentity,
      created: lease?.created ?? confirmed.created,
    };
    project = await dependencies.findOrCreateProject({
      workingDir: confirmation.workingDir,
      normalizedIdentity: confirmation.normalizedIdentity,
      displayName: confirmation.displayName,
      suggestedProjectId: confirmation.suggestedProjectId,
    });
    const session = await dependencies.createSession(confirmation.workingDir, {
      ...(input.workspaceOrigin ? { workspaceOrigin: input.workspaceOrigin } : {}),
      allExtensions: input.allExtensions,
      workspaceMode: 'codepro',
      ...(input.initialPermissionPreset
        ? { initialPermissionPreset: input.initialPermissionPreset }
        : {}),
      projectId: project.projectId,
      ...(lease ? { workspaceLeaseId: lease.leaseId } : {}),
      ...(input.recipeDeeplink ? { recipeDeeplink: input.recipeDeeplink } : {}),
      ...(input.recipeId ? { recipeId: input.recipeId } : {}),
    });
    sessionCreated = true;
    void dependencies.addRecentDir(confirmation.workingDir).catch(() => undefined);
    return { session, projectId: project.projectId, confirmation };
  } catch (primary) {
    const cleanupErrors: unknown[] = [];
    if (project?.created) {
      try {
        await dependencies.deleteCreatedProject(project);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (lease && !sessionCreated) {
      try {
        await dependencies.releaseWorkspaceLease(lease.leaseId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new CodeProRollbackError(
        'CodePro session setup failed and rollback left an orphan that requires review',
        [primary, ...cleanupErrors]
      );
    }
    throw primary;
  }
}
