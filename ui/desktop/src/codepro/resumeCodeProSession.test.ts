import { describe, expect, it, vi } from 'vitest';
import { bindAllocatedCodeProSession, resumeCodeProSession } from './resumeCodeProSession';

const candidate = {
  requestedPath: 'D:\\Projects\\Ledger',
  normalizedPath: 'D:\\Projects\\Ledger',
  normalizedIdentity: 'd:\\projects\\ledger',
  canonicalPath: 'D:\\Projects\\Ledger',
  source: 'selected' as const,
  state: 'non-empty-directory' as const,
  isGitRepository: true,
  displayName: 'Ledger',
  suggestedProjectId: 'ledger-a1b2c3d4e5f6',
  error: null,
};

function dependencies() {
  const calls: string[] = [];
  return {
    calls,
    acquireWorkspaceLease: vi.fn(async () => {
      calls.push('lease');
      return {
        leaseId: 'lease-resume-1',
        workingDir: 'D:\\Projects\\Ledger',
        normalizedIdentity: candidate.normalizedIdentity,
        created: false,
      };
    }),
    confirmWorkspace: vi.fn(async () => {
      calls.push('confirm');
      return {
        workingDir: 'D:\\Projects\\Ledger',
        normalizedIdentity: candidate.normalizedIdentity,
        created: false,
        displayName: candidate.displayName,
        suggestedProjectId: candidate.suggestedProjectId,
      };
    }),
    loadSession: vi.fn(async () => {
      calls.push('load');
    }),
    releaseWorkspaceLease: vi.fn(async () => {
      calls.push('release');
    }),
  };
}

describe('resumeCodeProSession', () => {
  it('uses a fresh exact workspace lease before loading the persisted session', async () => {
    const deps = dependencies();

    await resumeCodeProSession({ sessionId: 'session-1', candidate }, deps);

    expect(deps.calls).toEqual(['lease', 'confirm', 'load']);
    expect(deps.acquireWorkspaceLease).toHaveBeenCalledWith({
      requestedPath: candidate.normalizedPath,
      expectedState: candidate.state,
      expectedIdentity: candidate.normalizedIdentity,
    });
    expect(deps.confirmWorkspace).toHaveBeenCalledWith({
      normalizedPath: 'D:\\Projects\\Ledger',
      expectedState: candidate.state,
      expectedIdentity: candidate.normalizedIdentity,
    });
    expect(deps.loadSession).toHaveBeenCalledWith('session-1', {
      cwd: 'D:\\Projects\\Ledger',
      workspaceLeaseId: 'lease-resume-1',
    });
    expect(deps.releaseWorkspaceLease).not.toHaveBeenCalled();
  });

  it('fails closed and releases the lease when the native identity differs from the candidate', async () => {
    const deps = dependencies();
    deps.acquireWorkspaceLease.mockResolvedValue({
      leaseId: 'lease-resume-1',
      workingDir: 'D:\\Changed\\Ledger',
      normalizedIdentity: 'd:\\changed\\ledger',
      created: false,
    });

    await expect(resumeCodeProSession({ sessionId: 'session-1', candidate }, deps)).rejects.toThrow(
      'Workspace lease identity mismatch'
    );

    expect(deps.confirmWorkspace).not.toHaveBeenCalled();
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-resume-1');
  });

  it('does not load and releases the lease when exact confirmation fails', async () => {
    const deps = dependencies();
    deps.confirmWorkspace.mockRejectedValue(new Error('Workspace changed since inspection'));

    await expect(resumeCodeProSession({ sessionId: 'session-1', candidate }, deps)).rejects.toThrow(
      'Workspace changed since inspection'
    );

    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-resume-1');
  });

  it('attempts release when load fails before the client can prove token consumption', async () => {
    const deps = dependencies();
    deps.loadSession.mockRejectedValue(new Error('ACP load failed'));

    await expect(resumeCodeProSession({ sessionId: 'session-1', candidate }, deps)).rejects.toThrow(
      'ACP load failed'
    );

    expect(deps.releaseWorkspaceLease).toHaveBeenCalledWith('lease-resume-1');
  });

  it('rejects missing and unavailable candidates without acquiring a lease', async () => {
    for (const state of ['missing', 'unavailable'] as const) {
      const deps = dependencies();

      await expect(
        resumeCodeProSession({ sessionId: 'session-1', candidate: { ...candidate, state } }, deps)
      ).rejects.toThrow('Persisted CodePro workspaces must already exist');

      expect(deps.acquireWorkspaceLease).not.toHaveBeenCalled();
      expect(deps.confirmWorkspace).not.toHaveBeenCalled();
      expect(deps.loadSession).not.toHaveBeenCalled();
    }
  });
});

describe('bindAllocatedCodeProSession', () => {
  const lease = {
    leaseId: 'lease-created-1',
    workingDir: 'D:\\invoice-parser',
    normalizedIdentity: 'd:\\invoice-parser',
    created: true,
  };

  function bindDependencies() {
    const calls: string[] = [];
    return {
      calls,
      loadSession: vi.fn(async () => {
        calls.push('load');
      }),
      addRecentDir: vi.fn(async () => {
        calls.push('recent');
      }),
      releaseWorkspaceLease: vi.fn(async () => {
        calls.push('release');
      }),
    };
  }

  it('binds the created directory to the existing session before recording it', async () => {
    const deps = bindDependencies();

    await expect(
      bindAllocatedCodeProSession({ sessionId: 'session-1', lease }, deps)
    ).resolves.toEqual({ workingDir: lease.workingDir });

    expect(deps.calls).toEqual(['load', 'recent']);
    expect(deps.loadSession).toHaveBeenCalledWith('session-1', {
      cwd: lease.workingDir,
      workspaceLeaseId: lease.leaseId,
    });
    expect(deps.releaseWorkspaceLease).not.toHaveBeenCalled();
  });

  it('releases the lease when the existing session cannot be rebound', async () => {
    const deps = bindDependencies();
    deps.loadSession.mockRejectedValue(new Error('load failed'));

    await expect(
      bindAllocatedCodeProSession({ sessionId: 'session-1', lease }, deps)
    ).rejects.toThrow('load failed');

    expect(deps.addRecentDir).not.toHaveBeenCalled();
    expect(deps.releaseWorkspaceLease).toHaveBeenCalledWith(lease.leaseId);
  });

  it('rejects an existing-directory lease without loading the session', async () => {
    const deps = bindDependencies();

    await expect(
      bindAllocatedCodeProSession(
        { sessionId: 'session-1', lease: { ...lease, created: false } },
        deps
      )
    ).rejects.toThrow('newly created directory');

    expect(deps.loadSession).not.toHaveBeenCalled();
  });
});
