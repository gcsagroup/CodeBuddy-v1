import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/session';
import type { CodeProWorkspaceConfirmation, CodeProWorkspaceInspection } from './projectWorkspace';
import { startCodeProSession } from './startCodeProSession';

const candidate: CodeProWorkspaceInspection = {
  requestedPath: 'D:\\CodeProCp01\\Ledger',
  normalizedPath: 'D:\\CodeProCp01\\Ledger',
  normalizedIdentity: 'd:\\codeprocp01\\ledger',
  canonicalPath: null,
  source: 'prompt',
  state: 'missing',
  isGitRepository: false,
  displayName: 'Ledger',
  suggestedProjectId: 'ledger-a1b2c3d4e5f6',
  error: null,
};

const confirmation: CodeProWorkspaceConfirmation = {
  workingDir: 'D:\\CodeProCp01\\Ledger',
  normalizedIdentity: 'd:\\codeprocp01\\ledger',
  created: true,
  displayName: 'Ledger',
  suggestedProjectId: 'ledger-a1b2c3d4e5f6',
};

const session: Session = {
  id: 'session-1',
  name: 'untitled',
  message_count: 0,
  created_at: '2026-08-08T00:00:00Z',
  updated_at: '2026-08-08T00:00:00Z',
  working_dir: confirmation.workingDir,
  project_id: 'ledger-a1b2c3d4e5f6',
  extension_data: {},
};

const lease = {
  leaseId: 'lease-1',
  workingDir: confirmation.workingDir,
  normalizedIdentity: confirmation.normalizedIdentity,
  created: true,
};

const leaseDependencies = (overrides: Partial<typeof lease> = {}) => ({
  requiresWorkspaceLease: vi.fn().mockReturnValue(true),
  acquireWorkspaceLease: vi.fn().mockResolvedValue({ ...lease, ...overrides }),
  releaseWorkspaceLease: vi.fn().mockResolvedValue(undefined),
});

describe('startCodeProSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('acquires and passes the native Mac lease with case-sensitive POSIX identity', async () => {
    vi.stubGlobal('window', { electron: { platform: 'darwin' } });
    const workingDir = '/Users/test/Projects/中文 App';
    const acquired = { ...lease, workingDir, normalizedIdentity: workingDir, created: false };
    const acquireWorkspaceLease = vi.fn().mockResolvedValue(acquired);
    const createSession = vi.fn().mockResolvedValue({ ...session, working_dir: workingDir });
    const dependencies = {
      acquireWorkspaceLease,
      releaseWorkspaceLease: vi.fn(),
      confirmWorkspace: vi.fn().mockResolvedValue({ ...confirmation, ...acquired }),
      findOrCreateProject: vi
        .fn()
        .mockResolvedValue({ projectId: 'mac-project', source: {}, created: false }),
      createSession,
      addRecentDir: vi.fn().mockResolvedValue(true),
    };
    const input = {
      candidate: {
        ...candidate,
        requestedPath: workingDir,
        normalizedPath: workingDir,
        normalizedIdentity: workingDir,
        state: 'empty-directory' as const,
      },
      initialMessage: 'test' as never,
      allExtensions: [],
    };
    await startCodeProSession(input, dependencies);
    expect(acquireWorkspaceLease).toHaveBeenCalledWith({
      requestedPath: workingDir,
      expectedIdentity: workingDir,
      expectedState: 'empty-directory',
    });
    expect(createSession).toHaveBeenCalledWith(
      workingDir,
      expect.objectContaining({ workspaceLeaseId: 'lease-1' })
    );
    acquireWorkspaceLease.mockResolvedValue({ ...acquired, workingDir: workingDir.toLowerCase() });
    await expect(startCodeProSession(input, dependencies)).rejects.toThrow(
      'working directory mismatch'
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(dependencies.releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });

  it('confirms the exact directory, binds its Project, then creates one session', async () => {
    const calls: string[] = [];
    const acquireWorkspaceLease = vi.fn(async () => {
      calls.push('lease');
      return lease;
    });
    const confirmWorkspace = vi.fn(async () => {
      calls.push('confirm');
      return confirmation;
    });
    const findOrCreateProject = vi.fn(async () => {
      calls.push('project');
      return { projectId: 'ledger-a1b2c3d4e5f6', source: {} as never, created: true };
    });
    const createSession = vi.fn(async () => {
      calls.push('session');
      return session;
    });
    const addRecentDir = vi.fn(async () => {
      calls.push('recent');
      return true;
    });
    const releaseWorkspaceLease = vi.fn();

    const result = await startCodeProSession(
      {
        candidate,
        initialMessage: { msg: '开发一个记账应用', images: [] },
        allExtensions: [],
        recipeDeeplink: 'recipe://ledger',
        recipeId: 'recipe-1',
      },
      {
        requiresWorkspaceLease: vi.fn().mockReturnValue(true),
        acquireWorkspaceLease,
        releaseWorkspaceLease,
        confirmWorkspace,
        findOrCreateProject,
        createSession,
        addRecentDir,
      }
    );

    expect(calls).toEqual(['lease', 'confirm', 'project', 'session', 'recent']);
    expect(acquireWorkspaceLease).toHaveBeenCalledWith({
      requestedPath: candidate.normalizedPath,
      expectedState: 'missing',
      expectedIdentity: candidate.normalizedIdentity,
    });
    expect(confirmWorkspace).toHaveBeenCalledWith({
      normalizedPath: lease.workingDir,
      expectedState: 'empty-directory',
      expectedIdentity: 'd:\\codeprocp01\\ledger',
    });
    expect(findOrCreateProject).toHaveBeenCalledWith({
      workingDir: confirmation.workingDir,
      normalizedIdentity: confirmation.normalizedIdentity,
      displayName: confirmation.displayName,
      suggestedProjectId: confirmation.suggestedProjectId,
    });
    expect(createSession).toHaveBeenCalledWith(confirmation.workingDir, {
      allExtensions: [],
      workspaceMode: 'codepro',
      projectId: 'ledger-a1b2c3d4e5f6',
      workspaceLeaseId: 'lease-1',
      recipeDeeplink: 'recipe://ledger',
      recipeId: 'recipe-1',
    });
    expect(result).toEqual({
      session,
      projectId: 'ledger-a1b2c3d4e5f6',
      confirmation,
    });
    expect(releaseWorkspaceLease).not.toHaveBeenCalled();
  });

  it('does not create Project, Session, or recent state when confirmation fails', async () => {
    const findOrCreateProject = vi.fn();
    const createSession = vi.fn();
    const addRecentDir = vi.fn();
    const leaseDeps = leaseDependencies();

    await expect(
      startCodeProSession(
        { candidate, initialMessage: { msg: '开发', images: [] }, allExtensions: [] },
        {
          ...leaseDeps,
          confirmWorkspace: vi.fn().mockRejectedValue(new Error('confirmation failed')),
          findOrCreateProject,
          createSession,
          addRecentDir,
        }
      )
    ).rejects.toThrow('confirmation failed');

    expect(findOrCreateProject).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(addRecentDir).not.toHaveBeenCalled();
    expect(leaseDeps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });

  it('binds an existing workspace confirmation to its inspected canonical identity', async () => {
    const existingCandidate: CodeProWorkspaceInspection = {
      ...candidate,
      canonicalPath: 'D:\\Canonical\\Ledger',
      normalizedIdentity: 'd:\\canonical\\ledger',
      state: 'empty-directory',
    };
    const confirmWorkspace = vi.fn().mockRejectedValue(new Error('stop after contract check'));
    const leaseDeps = leaseDependencies({
      workingDir: existingCandidate.canonicalPath!,
      normalizedIdentity: existingCandidate.normalizedIdentity,
      created: false,
    });

    await expect(
      startCodeProSession(
        {
          candidate: existingCandidate,
          initialMessage: { msg: '开发', images: [] },
          allExtensions: [],
        },
        {
          ...leaseDeps,
          confirmWorkspace,
        }
      )
    ).rejects.toThrow('stop after contract check');

    expect(leaseDeps.acquireWorkspaceLease).toHaveBeenCalledWith({
      requestedPath: existingCandidate.normalizedPath,
      expectedState: 'empty-directory',
      expectedIdentity: existingCandidate.normalizedIdentity,
    });
    expect(confirmWorkspace).toHaveBeenCalledWith({
      normalizedPath: existingCandidate.canonicalPath,
      expectedState: 'empty-directory',
      expectedIdentity: 'd:\\canonical\\ledger',
    });
  });

  it('does not create a Session when Project binding fails', async () => {
    const createSession = vi.fn();
    const addRecentDir = vi.fn();
    const leaseDeps = leaseDependencies();

    await expect(
      startCodeProSession(
        { candidate, initialMessage: { msg: '开发', images: [] }, allExtensions: [] },
        {
          ...leaseDeps,
          confirmWorkspace: vi.fn().mockResolvedValue(confirmation),
          findOrCreateProject: vi.fn().mockRejectedValue(new Error('project failed')),
          createSession,
          addRecentDir,
        }
      )
    ).rejects.toThrow('project failed');

    expect(createSession).not.toHaveBeenCalled();
    expect(addRecentDir).not.toHaveBeenCalled();
    expect(leaseDeps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });

  it('releases the lease when ACP new_session fails before consuming the token', async () => {
    const leaseDeps = leaseDependencies();
    await expect(
      startCodeProSession(
        { candidate, initialMessage: { msg: 'build', images: [] }, allExtensions: [] },
        {
          ...leaseDeps,
          confirmWorkspace: vi.fn().mockResolvedValue(confirmation),
          findOrCreateProject: vi.fn().mockResolvedValue({
            projectId: 'ledger-a1b2c3d4e5f6',
            source: {} as never,
            created: false,
          }),
          createSession: vi.fn().mockRejectedValue(new Error('new_session failed')),
          addRecentDir: vi.fn(),
        }
      )
    ).rejects.toThrow('new_session failed');
    expect(leaseDeps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });

  it('rolls back a newly created Project and exposes any orphan cleanup failure', async () => {
    const leaseDeps = leaseDependencies();
    leaseDeps.releaseWorkspaceLease.mockRejectedValue(new Error('directory is not empty'));
    const project = {
      projectId: 'ledger-a1b2c3d4e5f6',
      source: { path: 'project-source-path' },
      created: true,
    };
    const deleteCreatedProject = vi.fn().mockResolvedValue(undefined);

    await expect(
      startCodeProSession(
        { candidate, initialMessage: { msg: 'build', images: [] }, allExtensions: [] },
        {
          ...leaseDeps,
          confirmWorkspace: vi.fn().mockResolvedValue(confirmation),
          findOrCreateProject: vi.fn().mockResolvedValue(project),
          createSession: vi.fn().mockRejectedValue(new Error('new_session failed')),
          deleteCreatedProject,
          addRecentDir: vi.fn(),
        }
      )
    ).rejects.toThrow('rollback left an orphan');
    expect(deleteCreatedProject).toHaveBeenCalledWith(project);
    expect(leaseDeps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });

  it('fails before Project or Session when the lease identity differs from inspection', async () => {
    const findOrCreateProject = vi.fn();
    const createSession = vi.fn();
    const leaseDeps = leaseDependencies({ normalizedIdentity: 'd:\\changed\\ledger' });

    await expect(
      startCodeProSession(
        { candidate, initialMessage: { msg: 'build', images: [] }, allExtensions: [] },
        {
          ...leaseDeps,
          confirmWorkspace: vi.fn(),
          findOrCreateProject,
          createSession,
          addRecentDir: vi.fn(),
        }
      )
    ).rejects.toThrow('Workspace lease identity mismatch');
    expect(findOrCreateProject).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(leaseDeps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });

  it('fails before confirmation, Project, or Session when lease workingDir contradicts its identity', async () => {
    const confirmWorkspace = vi.fn().mockResolvedValue(confirmation);
    const findOrCreateProject = vi.fn().mockResolvedValue({
      projectId: 'ledger-a1b2c3d4e5f6',
      source: {} as never,
      created: false,
    });
    const createSession = vi.fn().mockResolvedValue(session);
    const leaseDeps = leaseDependencies({ workingDir: 'D:\\Changed\\Ledger' });

    await expect(
      startCodeProSession(
        { candidate, initialMessage: { msg: 'build', images: [] }, allExtensions: [] },
        {
          ...leaseDeps,
          confirmWorkspace,
          findOrCreateProject,
          createSession,
          addRecentDir: vi.fn().mockResolvedValue(true),
        }
      )
    ).rejects.toThrow('Workspace lease working directory mismatch');

    expect(confirmWorkspace).not.toHaveBeenCalled();
    expect(findOrCreateProject).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(leaseDeps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });

  it('acquires a lease for an existing non-empty workspace before confirmation', async () => {
    const existingCandidate = { ...candidate, state: 'non-empty-directory' as const };
    const leaseDeps = leaseDependencies({ created: false });
    const confirmWorkspace = vi.fn().mockRejectedValue(new Error('stop after contract check'));

    await expect(
      startCodeProSession(
        {
          candidate: existingCandidate,
          initialMessage: { msg: 'build', images: [] },
          allExtensions: [],
        },
        { ...leaseDeps, confirmWorkspace }
      )
    ).rejects.toThrow('stop after contract check');
    expect(leaseDeps.acquireWorkspaceLease).toHaveBeenCalledWith({
      requestedPath: existingCandidate.normalizedPath,
      expectedState: 'non-empty-directory',
      expectedIdentity: existingCandidate.normalizedIdentity,
    });
    expect(leaseDeps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });

  it('preserves the non-Windows confirmation flow without acquiring a Windows lease', async () => {
    const acquireWorkspaceLease = vi.fn();
    const releaseWorkspaceLease = vi.fn();
    const confirmWorkspace = vi.fn().mockResolvedValue(confirmation);

    await expect(
      startCodeProSession(
        { candidate, initialMessage: { msg: 'build', images: [] }, allExtensions: [] },
        {
          requiresWorkspaceLease: vi.fn().mockReturnValue(false),
          acquireWorkspaceLease,
          releaseWorkspaceLease,
          confirmWorkspace,
          findOrCreateProject: vi.fn().mockResolvedValue({
            projectId: 'ledger-a1b2c3d4e5f6',
            source: {} as never,
            created: true,
          }),
          createSession: vi.fn().mockResolvedValue(session),
          addRecentDir: vi.fn().mockResolvedValue(true),
        }
      )
    ).resolves.toMatchObject({ session });

    expect(acquireWorkspaceLease).not.toHaveBeenCalled();
    expect(releaseWorkspaceLease).not.toHaveBeenCalled();
    expect(confirmWorkspace).toHaveBeenCalledWith({
      normalizedPath: candidate.normalizedPath,
      expectedState: candidate.state,
      expectedIdentity: candidate.normalizedIdentity,
    });
  });

  it('returns the created Session when recording the recent directory fails', async () => {
    const addRecentDir = vi.fn().mockRejectedValue(new Error('recent directory failed'));

    await expect(
      startCodeProSession(
        { candidate, initialMessage: { msg: '开发', images: [] }, allExtensions: [] },
        {
          ...leaseDependencies(),
          confirmWorkspace: vi.fn().mockResolvedValue(confirmation),
          findOrCreateProject: vi.fn().mockResolvedValue({
            projectId: 'ledger-a1b2c3d4e5f6',
            source: {} as never,
            created: false,
          }),
          createSession: vi.fn().mockResolvedValue(session),
          addRecentDir,
        }
      )
    ).resolves.toEqual({
      session,
      projectId: 'ledger-a1b2c3d4e5f6',
      confirmation,
    });
    expect(addRecentDir).toHaveBeenCalledWith(confirmation.workingDir);
  });

  it('rejects a non-confirmable candidate before invoking the host', async () => {
    const confirmWorkspace = vi.fn();

    await expect(
      startCodeProSession(
        {
          candidate: { ...candidate, state: 'filesystem-root' },
          initialMessage: { msg: '开发', images: [] },
          allExtensions: [],
        },
        { ...leaseDependencies(), confirmWorkspace }
      )
    ).rejects.toThrow('Workspace candidate is not confirmable');
    expect(confirmWorkspace).not.toHaveBeenCalled();
  });
});
