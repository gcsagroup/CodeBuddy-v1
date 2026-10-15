import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpControlClient } from './acpConnection';
import {
  abortGitConflict,
  continueGitConflict,
  createGitBranch,
  loadGitHubRuntimeStatus,
  loadGitRuntimeStatus,
  loadGitRepository,
  previewGitConflictAbort,
  previewGitRestore,
  restoreGitPaths,
  stageGitPaths,
  switchGitBranch,
  unstageGitPaths,
} from './git';

vi.mock('./acpConnection', () => ({ getAcpControlClient: vi.fn() }));

describe('CodePro Git ACP bridge', () => {
  const call = vi.fn();

  beforeEach(() => {
    call.mockReset();
    vi.mocked(getAcpControlClient).mockReset();
    vi.mocked(getAcpControlClient).mockResolvedValue({
      goose: { toolsCall_unstable: call },
    } as unknown as Awaited<ReturnType<typeof getAcpControlClient>>);
  });

  it('loads the local Git runtime status before repository operations', async () => {
    call.mockResolvedValueOnce({
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            available: true,
            version: 'git version 2.51.0.windows.1',
            install_url: 'https://git-scm.com/download/win',
          }),
        },
      ],
    });

    await expect(loadGitRuntimeStatus('session-1')).resolves.toEqual({
      available: true,
      version: 'git version 2.51.0.windows.1',
      installUrl: 'https://git-scm.com/download/win',
    });
    expect(call).toHaveBeenCalledWith({
      sessionId: 'session-1',
      name: 'git_runtime_status',
      arguments: {},
    });
  });

  it('serializes overlapping panel requests per session without retrying failures or blocking other sessions', async () => {
    let rejectFirst!: (error: Error) => void;
    const response = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            available: true,
            version: 'git fixture',
            install_url: 'https://git-scm.com/download/win',
          }),
        },
      ],
    };
    call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        })
    );
    call.mockResolvedValue(response);
    const first = loadGitRuntimeStatus('queue-session');
    const firstResult = first.catch((error) => error);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    const second = loadGitRuntimeStatus('queue-session');
    await expect(loadGitRuntimeStatus('other-session')).resolves.toMatchObject({ available: true });
    expect(call).toHaveBeenCalledTimes(2);
    rejectFirst(new Error('original failure'));
    expect(await firstResult).toMatchObject({ message: 'original failure' });
    await expect(second).resolves.toMatchObject({ available: true });
    expect(call).toHaveBeenCalledTimes(3);
    await expect(loadGitRuntimeStatus('queue-session')).resolves.toMatchObject({ available: true });
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('loads GitHub CLI authentication readiness without accepting an untrusted install URL', async () => {
    call.mockResolvedValueOnce({
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            available: true,
            authenticated: false,
            version: 'gh version 2.80.0 (2026-08-13)',
            hostname: 'github.com',
            install_url: 'https://cli.github.com/',
            login_command: 'gh auth login --hostname github.com --web',
          }),
        },
      ],
    });

    await expect(loadGitHubRuntimeStatus('session-1')).resolves.toEqual({
      available: true,
      authenticated: false,
      version: 'gh version 2.80.0 (2026-08-13)',
      hostname: 'github.com',
      installUrl: 'https://cli.github.com/',
      loginCommand: 'gh auth login --hostname github.com --web',
    });
    expect(call).toHaveBeenCalledWith({
      sessionId: 'session-1',
      name: 'github_runtime_status',
      arguments: {},
    });
  });

  it.each(['https://example.com/download', 'https://user@cli.github.com/'])(
    'rejects a substituted GitHub CLI installation URL: %s',
    async (installUrl) => {
      call.mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              available: false,
              authenticated: false,
              version: null,
              hostname: 'github.com',
              install_url: installUrl,
              login_command: 'gh auth login --hostname github.com --web',
            }),
          },
        ],
      });

      await expect(loadGitHubRuntimeStatus('session-1')).rejects.toThrow(
        'invalid Git response: install_url'
      );
    }
  );

  it('loads status, branches, and the working diff through the structured Git tools', async () => {
    call.mockResolvedValueOnce({
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: {
              repository_root: 'D:/repo',
              branch: 'main',
              detached: false,
              upstream: 'origin/main',
              ahead: 1,
              behind: 0,
              truncated: false,
              entries: [
                {
                  path: 'src/app.ts',
                  original_path: null,
                  index_status: ' ',
                  worktree_status: 'M',
                },
              ],
            },
            conflicts: {
              has_conflicts: false,
              operation: 'none',
              total_conflicts: 0,
              truncated: false,
              conflicts: [],
            },
            branches: {
              truncated: false,
              branches: [
                {
                  name: 'main',
                  current: true,
                  remote: false,
                  upstream: 'origin/main',
                  commit: 'abc1234',
                },
              ],
            },
            diff: {
              scope: 'working',
              text: 'diff --git a/src/app.ts',
              truncated: false,
            },
            staged_diff: {
              scope: 'staged',
              text: 'diff --git a/src/staged.ts',
              truncated: false,
            },
          }),
        },
      ],
    });

    const repository = await loadGitRepository('session-1');

    expect(repository.status.branch).toBe('main');
    expect(repository.status.entries[0]?.path).toBe('src/app.ts');
    expect(repository.conflicts.operation).toBe('none');
    expect(repository.branches.branches[0]?.current).toBe(true);
    expect(repository.diff.text).toContain('src/app.ts');
    expect(repository.stagedDiff.text).toContain('src/staged.ts');
    expect(call.mock.calls.map(([request]) => request.name)).toEqual(['git_repository_snapshot']);
    expect(getAcpControlClient).toHaveBeenCalledTimes(1);
  });

  it('stages only the explicit paths supplied by the user', async () => {
    call.mockResolvedValue({
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ staged_paths: ['src/app.ts'] }),
        },
      ],
    });

    await stageGitPaths('session-1', ['src/app.ts']);

    expect(call).toHaveBeenCalledWith({
      sessionId: 'session-1',
      name: 'git_stage',
      arguments: { paths: ['src/app.ts'] },
    });
  });

  it('uses structured tools for unstage and local branch mutations', async () => {
    call
      .mockResolvedValueOnce({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ unstaged_paths: ['src/app.ts'] }) }],
      })
      .mockResolvedValueOnce({
        isError: false,
        content: [
          { type: 'text', text: JSON.stringify({ branch: 'feature/fast', created: true }) },
        ],
      })
      .mockResolvedValueOnce({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ branch: 'main', created: false }) }],
      });

    await expect(unstageGitPaths('session-1', ['src/app.ts'])).resolves.toEqual({
      unstagedPaths: ['src/app.ts'],
    });
    await expect(createGitBranch('session-1', 'feature/fast')).resolves.toEqual({
      branch: 'feature/fast',
      created: true,
    });
    await expect(switchGitBranch('session-1', 'main')).resolves.toEqual({
      branch: 'main',
      created: false,
    });
    expect(call.mock.calls).toEqual([
      [
        {
          sessionId: 'session-1',
          name: 'git_unstage',
          arguments: { paths: ['src/app.ts'] },
        },
      ],
      [
        {
          sessionId: 'session-1',
          name: 'git_branch_create',
          arguments: { name: 'feature/fast' },
        },
      ],
      [
        {
          sessionId: 'session-1',
          name: 'git_branch_switch',
          arguments: { name: 'main' },
        },
      ],
    ]);
  });

  it('rejects tool failures and malformed success payloads', async () => {
    call.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'not a repository' }],
    });
    await expect(loadGitRepository('session-1')).rejects.toThrow('not a repository');

    call.mockResolvedValueOnce({ isError: false, content: [{ type: 'text', text: '{}' }] });
    await expect(stageGitPaths('session-1', ['src/app.ts'])).rejects.toThrow(
      'invalid Git response'
    );
  });

  it('preserves ACP error data so Git failures are actionable', async () => {
    call.mockRejectedValue(
      Object.assign(new Error('Internal error'), {
        data: 'git restore failed: index.lock already exists',
      })
    );

    await expect(unstageGitPaths('session-1', ['src/app.ts'])).rejects.toThrow(
      'git restore failed: index.lock already exists'
    );
  });

  it('binds destructive restore to the exact preview receipt', async () => {
    call
      .mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              paths: ['src/app.ts'],
              changed_paths: ['src/app.ts'],
              diff: 'diff --git a/src/app.ts b/src/app.ts',
              diff_truncated: false,
              blocked_reasons: [],
              preflight_id: 'a'.repeat(64),
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ restored_paths: ['src/app.ts'] }) }],
      });

    const preview = await previewGitRestore('session-1', ['src/app.ts']);
    await expect(restoreGitPaths('session-1', preview)).resolves.toEqual({
      restoredPaths: ['src/app.ts'],
    });
    expect(call.mock.calls.slice(-2)).toEqual([
      [
        {
          sessionId: 'session-1',
          name: 'git_restore_preview',
          arguments: { paths: ['src/app.ts'] },
        },
      ],
      [
        {
          sessionId: 'session-1',
          name: 'git_restore',
          arguments: { paths: ['src/app.ts'], preflight_id: 'a'.repeat(64) },
        },
      ],
    ]);
  });

  it('continues conflict operations and binds destructive abort to its exact preview', async () => {
    call
      .mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              operation: 'merge',
              head: 'abc1234',
              changed_paths: ['src/app.ts'],
              conflicted_paths: ['src/app.ts'],
              working_diff: 'conflict diff',
              working_diff_truncated: false,
              staged_diff: '',
              staged_diff_truncated: false,
              blocked_reasons: [],
              preflight_id: 'b'.repeat(64),
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ operation: 'merge', status: 'aborted', head: 'abc1234' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ operation: 'rebase', status: 'completed', head: 'def5678' }),
          },
        ],
      });

    const preview = await previewGitConflictAbort('session-1');
    await expect(abortGitConflict('session-1', preview)).resolves.toEqual({
      operation: 'merge',
      status: 'aborted',
      head: 'abc1234',
    });
    await expect(continueGitConflict('session-1', 'rebase')).resolves.toEqual({
      operation: 'rebase',
      status: 'completed',
      head: 'def5678',
    });
    expect(call.mock.calls.slice(-3)).toEqual([
      [
        {
          sessionId: 'session-1',
          name: 'git_conflict_abort_preview',
          arguments: {},
        },
      ],
      [
        {
          sessionId: 'session-1',
          name: 'git_conflict_abort',
          arguments: { operation: 'merge', preflight_id: 'b'.repeat(64) },
        },
      ],
      [
        {
          sessionId: 'session-1',
          name: 'git_conflict_continue',
          arguments: { operation: 'rebase' },
        },
      ],
    ]);
  });
});
