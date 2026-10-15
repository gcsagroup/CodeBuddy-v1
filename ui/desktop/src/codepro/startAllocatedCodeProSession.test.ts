import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/session';
import { startAllocatedCodeProSession } from './startAllocatedCodeProSession';

const lease = {
  leaseId: 'lease-1',
  workingDir: 'D:\\invoice-parser',
  normalizedIdentity: 'd:\\invoice-parser',
  created: true,
};

const session = {
  id: 'session-2',
  name: 'untitled',
  message_count: 0,
  created_at: '2026-08-17T00:00:00Z',
  updated_at: '2026-08-17T00:00:00Z',
  working_dir: lease.workingDir,
  project_id: 'invoice-parser-id',
  extension_data: {},
} as Session;

describe('startAllocatedCodeProSession', () => {
  it('binds the allocated lease to a writable Project session before exposing recent state', async () => {
    const calls: string[] = [];
    const findOrCreateProject = vi.fn(async () => {
      calls.push('project');
      return { projectId: 'invoice-parser-id', source: {} as never, created: false };
    });
    const createSession = vi.fn(async () => {
      calls.push('session');
      return session;
    });
    const addRecentDir = vi.fn(async () => {
      calls.push('recent');
    });
    const releaseWorkspaceLease = vi.fn();

    await expect(
      startAllocatedCodeProSession(
        { lease, allExtensions: [] },
        { findOrCreateProject, createSession, addRecentDir, releaseWorkspaceLease }
      )
    ).resolves.toEqual({ session, projectId: 'invoice-parser-id' });

    expect(calls).toEqual(['project', 'session', 'recent']);
    expect(createSession).toHaveBeenCalledWith(lease.workingDir, {
      allExtensions: [],
      workspaceMode: 'codepro',
      workspaceBinding: 'writable_project',
      projectId: 'invoice-parser-id',
      workspaceLeaseId: 'lease-1',
    });
    expect(releaseWorkspaceLease).not.toHaveBeenCalled();
  });

  it('rolls back only the exact created Project and lease when session binding fails', async () => {
    const project = {
      projectId: 'invoice-parser-id',
      source: { path: 'source-path' },
      created: true,
    };
    const deleteCreatedProject = vi.fn().mockResolvedValue(undefined);
    const releaseWorkspaceLease = vi.fn().mockResolvedValue(undefined);

    await expect(
      startAllocatedCodeProSession(
        { lease, allExtensions: [] },
        {
          findOrCreateProject: vi.fn().mockResolvedValue(project),
          createSession: vi.fn().mockRejectedValue(new Error('new_session failed')),
          deleteCreatedProject,
          releaseWorkspaceLease,
          addRecentDir: vi.fn(),
        }
      )
    ).rejects.toThrow('new_session failed');

    expect(deleteCreatedProject).toHaveBeenCalledWith(project);
    expect(releaseWorkspaceLease).toHaveBeenCalledWith('lease-1');
  });
});
