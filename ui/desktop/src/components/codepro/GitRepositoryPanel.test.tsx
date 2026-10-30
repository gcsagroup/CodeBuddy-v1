import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'react-intl';
import { GitRepositoryPanel, type GitRepositoryPanelApi } from './GitRepositoryPanel';

const repository = {
  status: {
    repositoryRoot: 'D:/repo',
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    truncated: false,
    entries: [
      {
        path: 'src/app.ts',
        originalPath: null,
        indexStatus: ' ',
        worktreeStatus: 'M',
      },
      {
        path: 'src/staged.ts',
        originalPath: null,
        indexStatus: 'M',
        worktreeStatus: ' ',
      },
    ],
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
      {
        name: 'feature/existing',
        current: false,
        remote: false,
        upstream: null,
        commit: 'def5678',
      },
    ],
  },
  conflicts: {
    hasConflicts: false,
    operation: 'none',
    totalConflicts: 0,
    truncated: false,
    conflicts: [],
  },
  diff: { scope: 'working' as const, text: 'diff --git a/src/app.ts', truncated: false },
  stagedDiff: { scope: 'staged' as const, text: 'diff --git a/src/staged.ts', truncated: false },
};

function renderPanel(api: Partial<GitRepositoryPanelApi>) {
  const completeApi: GitRepositoryPanelApi = {
    runtimeStatus: vi.fn().mockResolvedValue({
      available: true,
      version: 'git version 2.51.0.windows.1',
      installUrl: 'https://git-scm.com/download/win',
    }),
    githubStatus: vi.fn().mockResolvedValue({
      available: true,
      authenticated: true,
      version: 'gh version 2.80.0 (2026-08-13)',
      hostname: 'github.com',
      installUrl: 'https://cli.github.com/',
      loginCommand: 'gh auth login --hostname github.com --web',
    }),
    load: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    restorePreview: vi.fn(),
    restore: vi.fn(),
    continueConflict: vi.fn(),
    conflictAbortPreview: vi.fn(),
    abortConflict: vi.fn(),
    createBranch: vi.fn(),
    switchBranch: vi.fn(),
    commit: vi.fn(),
    pull: vi.fn(),
    pushPreview: vi.fn(),
    push: vi.fn(),
    ...api,
  };
  return render(
    <IntlProvider locale="en">
      <GitRepositoryPanel sessionId="session-1" workingDirectory="D:/repo" api={completeApi} />
    </IntlProvider>
  );
}

describe('GitRepositoryPanel', () => {
  it('does not count an untracked file as staged or offer to unstage it', async () => {
    renderPanel({
      load: vi
        .fn()
        .mockResolvedValue({
          ...repository,
          status: {
            ...repository.status,
            entries: [
              ...repository.status.entries,
              { path: 'new.txt', originalPath: null, indexStatus: '?', worktreeStatus: '?' },
            ],
          },
        }),
    });
    expect(
      await screen.findByRole('button', { name: 'Commit 1 staged file' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unstage new.txt' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select new.txt' })).toBeEnabled();
  });
  it('asks before opening the official Git download when Git is unavailable', async () => {
    const load = vi.fn();
    const githubStatus = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.electron.openExternal = openExternal;

    renderPanel({
      runtimeStatus: vi.fn().mockResolvedValue({
        available: false,
        version: null,
        installUrl: 'https://git-scm.com/download/win',
      }),
      githubStatus,
      load,
    });

    expect(
      await screen.findByText('Git is required for repository operations.')
    ).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
    expect(githubStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download Git' }));
    expect(
      await screen.findByText('Open the official Git download page in your browser?')
    ).toBeInTheDocument();
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open download page' }));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://git-scm.com/download/win')
    );
    expect(
      screen.getByText('After installing Git, refresh the repository to check again.')
    ).toBeInTheDocument();
  });

  it('shows when GitHub CLI is installed but still needs authentication', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPanel({
      load: vi.fn().mockResolvedValue(repository),
      githubStatus: vi.fn().mockResolvedValue({
        available: true,
        authenticated: false,
        version: 'gh version 2.80.0 (2026-08-13)',
        hostname: 'github.com',
        installUrl: 'https://cli.github.com/',
        loginCommand: 'gh auth login --hostname github.com --web',
      }),
    });

    expect(await screen.findByText('GitHub CLI is not signed in.')).toBeInTheDocument();
    expect(screen.getByText('gh auth login --hostname github.com --web')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy GitHub login command' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('gh auth login --hostname github.com --web')
    );
    expect(await screen.findByText(/Login command copied/)).toBeInTheDocument();
  });

  it('keeps ordinary Git available when GitHub CLI is not installed', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.electron.openExternal = openExternal;
    renderPanel({
      load: vi.fn().mockResolvedValue(repository),
      githubStatus: vi.fn().mockResolvedValue({
        available: false,
        authenticated: false,
        version: null,
        hostname: 'github.com',
        installUrl: 'https://cli.github.com/',
        loginCommand: 'gh auth login --hostname github.com --web',
      }),
    });

    expect(
      await screen.findByText(
        'GitHub CLI is not installed. Git push and pull can still use Git; PR and Issue operations need GitHub CLI.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pull' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Push' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Install GitHub CLI' }));
    expect(
      screen.getByText('Open the official GitHub CLI download page in your browser?')
    ).toBeInTheDocument();
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub CLI download page' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://cli.github.com/'));
  });

  it('shows branch, sync state, changes, staged scope, and diff', async () => {
    renderPanel({
      load: vi.fn().mockResolvedValue(repository),
      stage: vi.fn(),
      unstage: vi.fn(),
      restorePreview: vi.fn(),
      restore: vi.fn(),
      createBranch: vi.fn(),
      switchBranch: vi.fn(),
      commit: vi.fn(),
      pull: vi.fn(),
      pushPreview: vi.fn(),
      push: vi.fn(),
    });

    expect((await screen.findAllByText('main')).length).toBeGreaterThan(0);
    expect(screen.getByText('1 outgoing · 0 incoming')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('src/staged.ts')).toBeInTheDocument();
    expect(screen.getByText(/diff --git a\/src\/app\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/diff --git a\/src\/staged\.ts/)).toBeInTheDocument();
  });

  it('disables path selection while a refreshed snapshot is replacing repository state', async () => {
    let finishRefresh!: (value: typeof repository) => void;
    const pendingRefresh = new Promise<typeof repository>((resolve) => {
      finishRefresh = resolve;
    });
    const load = vi.fn().mockResolvedValueOnce(repository).mockReturnValueOnce(pendingRefresh);
    renderPanel({ load });

    const path = await screen.findByRole('checkbox', { name: 'Select src/app.ts' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh repository' }));

    await waitFor(() => expect(path).toBeDisabled());
    finishRefresh(repository);
    await waitFor(() => expect(path).toBeEnabled());
  });

  it('stages selected paths and commits only after showing the staged scope', async () => {
    const stage = vi.fn().mockResolvedValue({ stagedPaths: ['src/app.ts'] });
    const commit = vi.fn().mockResolvedValue({
      commit: 'def5678',
      branch: 'main',
      subject: 'focused change',
      committedPaths: ['src/staged.ts'],
    });
    const load = vi.fn().mockResolvedValue(repository);
    renderPanel({
      load,
      stage,
      unstage: vi.fn(),
      restorePreview: vi.fn(),
      restore: vi.fn(),
      createBranch: vi.fn(),
      switchBranch: vi.fn(),
      commit,
      pull: vi.fn(),
      pushPreview: vi.fn(),
      push: vi.fn(),
    });

    await screen.findByText('src/app.ts');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select src/app.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage selected (1)' }));
    await waitFor(() => expect(stage).toHaveBeenCalledWith('session-1', ['src/app.ts']));

    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: 'focused change' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1 staged file' }));
    await waitFor(() => expect(commit).toHaveBeenCalledWith('session-1', 'focused change'));
  });

  it('confirms and pulls the exact upstream with fast-forward-only semantics', async () => {
    const pull = vi.fn().mockResolvedValue({
      operation: 'pull',
      remote: 'origin',
      branch: 'main',
      status: 'completed',
    });
    renderPanel({
      load: vi.fn().mockResolvedValue(repository),
      stage: vi.fn(),
      unstage: vi.fn(),
      restorePreview: vi.fn(),
      restore: vi.fn(),
      createBranch: vi.fn(),
      switchBranch: vi.fn(),
      commit: vi.fn(),
      pull,
      pushPreview: vi.fn(),
      push: vi.fn(),
    });

    await screen.findByRole('combobox', { name: 'Local branch' });
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
    expect(await screen.findByText('Pull origin/main with fast-forward only?')).toBeInTheDocument();
    expect(pull).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pull' }));
    await waitFor(() =>
      expect(pull).toHaveBeenCalledWith('session-1', { remote: 'origin', branch: 'main' })
    );
  });

  it('requires an exact push preview and confirmation before pushing', async () => {
    const pushPreview = vi.fn().mockResolvedValue({
      remote: 'origin',
      remoteDestination: 'github.com/acme/repo',
      branch: 'main',
      head: 'a'.repeat(40),
      outgoingCommitCount: 1,
      outgoingCommits: [{ id: 'abc1234', subject: 'focused change' }],
      changedPaths: ['src/app.ts'],
      pathsTruncated: false,
      sensitivePaths: [],
      blockedReasons: [],
      preflightId: 'p'.repeat(64),
    });
    const push = vi.fn().mockResolvedValue({
      operation: 'push',
      remote: 'origin',
      branch: 'main',
      status: 'completed',
    });
    renderPanel({
      load: vi.fn().mockResolvedValue(repository),
      stage: vi.fn(),
      unstage: vi.fn(),
      restorePreview: vi.fn(),
      restore: vi.fn(),
      createBranch: vi.fn(),
      switchBranch: vi.fn(),
      commit: vi.fn(),
      pull: vi.fn(),
      pushPreview,
      push,
    });

    await screen.findByRole('combobox', { name: 'Local branch' });
    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    await waitFor(() =>
      expect(pushPreview).toHaveBeenCalledWith('session-1', {
        remote: 'origin',
        branch: 'main',
      })
    );
    expect(await screen.findByText('Push 1 commit to origin/main?')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm push' }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('session-1', {
        remote: 'origin',
        branch: 'main',
        preflightId: 'p'.repeat(64),
      })
    );
  });

  it('recovers detached HEAD by creating a validated branch', async () => {
    const createBranch = vi.fn().mockResolvedValue({ branch: 'recovery/work', created: true });
    renderPanel({
      load: vi.fn().mockResolvedValue({
        ...repository,
        status: {
          ...repository.status,
          branch: 'abc1234',
          detached: true,
          upstream: null,
        },
      }),
      stage: vi.fn(),
      unstage: vi.fn(),
      restorePreview: vi.fn(),
      restore: vi.fn(),
      createBranch,
      switchBranch: vi.fn(),
      commit: vi.fn(),
      pull: vi.fn(),
      pushPreview: vi.fn(),
      push: vi.fn(),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Create or switch to a branch before committing, pulling, or pushing.'
    );
    expect(screen.getByRole('button', { name: 'Commit 1 staged file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pull' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Push' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New branch name'), {
      target: { value: 'recovery/work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    await waitFor(() => expect(createBranch).toHaveBeenCalledWith('session-1', 'recovery/work'));
    const review = screen.getByRole('button', { name: 'Review changes' });
    expect(review).toBeEnabled();
    fireEvent.click(review);
    expect(screen.getByRole('region', { name: 'Code review' })).toBeInTheDocument();
  });

  it('switches local branches and unstages an explicit path', async () => {
    const switchBranch = vi.fn().mockResolvedValue({ branch: 'feature/existing', created: false });
    const unstage = vi.fn().mockResolvedValue({ unstagedPaths: ['src/staged.ts'] });
    renderPanel({
      load: vi.fn().mockResolvedValue(repository),
      stage: vi.fn(),
      unstage,
      restorePreview: vi.fn(),
      restore: vi.fn(),
      createBranch: vi.fn(),
      switchBranch,
      commit: vi.fn(),
      pull: vi.fn(),
      pushPreview: vi.fn(),
      push: vi.fn(),
    });

    await screen.findByRole('combobox', { name: 'Local branch' });
    fireEvent.click(screen.getByRole('button', { name: 'Unstage src/staged.ts' }));
    await waitFor(() => expect(unstage).toHaveBeenCalledWith('session-1', ['src/staged.ts']));
    await waitFor(() => expect(screen.getByLabelText('Local branch')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Local branch'), {
      target: { value: 'feature/existing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));
    await waitFor(() => expect(switchBranch).toHaveBeenCalledWith('session-1', 'feature/existing'));
  });

  it('previews the exact selected path before confirming destructive restore', async () => {
    const preview = {
      paths: ['src/app.ts'],
      changedPaths: ['src/app.ts'],
      diff: 'diff --git a/src/app.ts b/src/app.ts\n-old\n+new',
      diffTruncated: false,
      blockedReasons: [],
      preflightId: 'a'.repeat(64),
    };
    const restorePreview = vi.fn().mockResolvedValue(preview);
    const restore = vi.fn().mockResolvedValue({ restoredPaths: ['src/app.ts'] });
    renderPanel({
      load: vi.fn().mockResolvedValue(repository),
      stage: vi.fn(),
      unstage: vi.fn(),
      restorePreview,
      restore,
      createBranch: vi.fn(),
      switchBranch: vi.fn(),
      commit: vi.fn(),
      pull: vi.fn(),
      pushPreview: vi.fn(),
      push: vi.fn(),
    });

    await screen.findByText('src/app.ts');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select src/app.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview restore (1)' }));
    await waitFor(() => expect(restorePreview).toHaveBeenCalledWith('session-1', ['src/app.ts']));
    expect(await screen.findByText('Restore 1 selected path?')).toBeInTheDocument();
    expect(screen.getByText(/-old\s+\+new/u)).toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('session-1', preview));
  });

  it('shows merge conflicts, blocks continue, and confirms a hashed abort preview', async () => {
    const conflictedRepository = {
      ...repository,
      conflicts: {
        hasConflicts: true,
        operation: 'merge',
        totalConflicts: 1,
        truncated: false,
        conflicts: [{ path: 'src/app.ts', code: 'UU', kind: 'both_modified', stages: [1, 2, 3] }],
      },
    };
    const preview = {
      operation: 'merge',
      head: 'abc1234',
      changedPaths: ['src/app.ts'],
      conflictedPaths: ['src/app.ts'],
      workingDiff: 'conflict diff',
      workingDiffTruncated: false,
      stagedDiff: '',
      stagedDiffTruncated: false,
      blockedReasons: [],
      preflightId: 'b'.repeat(64),
    };
    const conflictAbortPreview = vi.fn().mockResolvedValue(preview);
    const abortConflict = vi.fn().mockResolvedValue({
      operation: 'merge',
      status: 'aborted',
      head: 'abc1234',
    });
    renderPanel({
      load: vi.fn().mockResolvedValue(conflictedRepository),
      conflictAbortPreview,
      abortConflict,
    });

    expect(
      await screen.findByText('Merge in progress · 1 unresolved conflict')
    ).toBeInTheDocument();
    expect(screen.getByText('src/app.ts · UU')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue merge' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview abort' }));
    await waitFor(() => expect(conflictAbortPreview).toHaveBeenCalledWith('session-1'));
    expect(
      await screen.findByText('Abort merge and restore its pre-operation state?')
    ).toBeInTheDocument();
    expect(abortConflict).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm abort' }));
    await waitFor(() => expect(abortConflict).toHaveBeenCalledWith('session-1', preview));
  });

  it('continues a merge only after all conflicts are resolved', async () => {
    const continueConflict = vi.fn().mockResolvedValue({
      operation: 'merge',
      status: 'completed',
      head: 'def5678',
    });
    renderPanel({
      load: vi.fn().mockResolvedValue({
        ...repository,
        conflicts: {
          hasConflicts: false,
          operation: 'merge',
          totalConflicts: 0,
          truncated: false,
          conflicts: [],
        },
      }),
      continueConflict,
    });

    const button = await screen.findByRole('button', { name: 'Continue merge' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(continueConflict).toHaveBeenCalledWith('session-1', 'merge'));
  });

  it('continues and previews abort for a resolved rebase', async () => {
    const continueConflict = vi.fn().mockResolvedValue({
      operation: 'rebase',
      status: 'completed',
      head: 'def5678',
    });
    const conflictAbortPreview = vi.fn().mockResolvedValue({
      operation: 'rebase',
      head: 'abc1234',
      changedPaths: ['src/app.ts'],
      conflictedPaths: [],
      workingDiff: '',
      workingDiffTruncated: false,
      stagedDiff: 'resolved diff',
      stagedDiffTruncated: false,
      blockedReasons: [],
      preflightId: 'c'.repeat(64),
    });
    renderPanel({
      load: vi.fn().mockResolvedValue({
        ...repository,
        conflicts: {
          hasConflicts: false,
          operation: 'rebase',
          totalConflicts: 0,
          truncated: false,
          conflicts: [],
        },
      }),
      continueConflict,
      conflictAbortPreview,
    });

    const continueButton = await screen.findByRole('button', { name: 'Continue rebase' });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    await waitFor(() => expect(continueConflict).toHaveBeenCalledWith('session-1', 'rebase'));

    fireEvent.click(screen.getByRole('button', { name: 'Preview abort' }));
    await waitFor(() => expect(conflictAbortPreview).toHaveBeenCalledWith('session-1'));
    expect(
      await screen.findByText('Abort rebase and restore its pre-operation state?')
    ).toBeInTheDocument();
  });
});
