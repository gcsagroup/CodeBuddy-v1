import type { FixedExtensionEntry } from '../components/ConfigContext';
import type { Session } from '../types/session';
import { createSession } from '../sessions';
import { findOrCreateCodeProProject, type CodeProProjectBinding } from '../acp/sources';
import { releaseWorkspaceLease, type WorkspaceLease } from '../acp/workspaceLease';
import { suggestedProjectId, workspaceDisplayName } from './projectWorkspace';
import { CodeProRollbackError } from './failureSemantics';

interface StartAllocatedCodeProSessionInput {
  lease: WorkspaceLease;
  allExtensions: FixedExtensionEntry[];
}

interface Dependencies {
  findOrCreateProject: typeof findOrCreateCodeProProject;
  createSession: typeof createSession;
  releaseWorkspaceLease: typeof releaseWorkspaceLease;
  deleteCreatedProject: (project: CodeProProjectBinding) => Promise<void>;
  addRecentDir: (workingDir: string) => Promise<unknown>;
}

const defaultDependencies = (): Dependencies => ({
  findOrCreateProject: findOrCreateCodeProProject,
  createSession,
  releaseWorkspaceLease,
  deleteCreatedProject: async (project) => {
    if (!project.created || !project.source.path) return;
    const { getAcpClient } = await import('../acp/acpConnection');
    const client = await getAcpClient();
    await client.goose.sourcesDelete_unstable({ type: 'project', path: project.source.path });
  },
  addRecentDir: (workingDir) => window.electron.addRecentDir(workingDir),
});

export async function startAllocatedCodeProSession(
  input: StartAllocatedCodeProSessionInput,
  overrides: Partial<Dependencies> = {}
): Promise<{ session: Session; projectId: string }> {
  if (!input.lease.created) throw new Error('Allocated project workspace must be newly created');
  const dependencies = { ...defaultDependencies(), ...overrides };
  const displayName = workspaceDisplayName(input.lease.workingDir);
  let project: CodeProProjectBinding | undefined;
  let sessionCreated = false;
  try {
    project = await dependencies.findOrCreateProject({
      workingDir: input.lease.workingDir,
      normalizedIdentity: input.lease.normalizedIdentity,
      displayName,
      suggestedProjectId: suggestedProjectId(input.lease.normalizedIdentity, displayName),
    });
    const session = await dependencies.createSession(input.lease.workingDir, {
      allExtensions: input.allExtensions,
      workspaceMode: 'codepro',
      workspaceBinding: 'writable_project',
      projectId: project.projectId,
      workspaceLeaseId: input.lease.leaseId,
    });
    sessionCreated = true;
    await dependencies.addRecentDir(input.lease.workingDir).catch(() => undefined);
    return { session, projectId: project.projectId };
  } catch (primary) {
    const cleanupErrors: unknown[] = [];
    if (project?.created) {
      try {
        await dependencies.deleteCreatedProject(project);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!sessionCreated) {
      try {
        await dependencies.releaseWorkspaceLease(input.lease.leaseId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new CodeProRollbackError(
        'Allocated CodePro session failed and rollback left an orphan that requires review',
        [primary, ...cleanupErrors]
      );
    }
    throw primary;
  }
}
