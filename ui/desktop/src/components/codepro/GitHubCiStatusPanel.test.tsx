import { render as testingRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { GitHubCiStatusPanel, type GitHubCiStatusPanelApi } from './GitHubCiStatusPanel';

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

const status: Awaited<ReturnType<GitHubCiStatusPanelApi['load']>> = {
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  branch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: true,
  aggregateStatus: 'in_progress',
  totalCount: 8,
  truncated: true,
  runs: [
    {
      id: 42,
      name: 'CI',
      runNumber: 9,
      attempt: 1,
      event: 'push',
      status: 'in_progress' as const,
      conclusion: null,
      htmlUrl: 'https://github.com/octo/demo/actions/runs/42',
      createdAt: '2026-08-05T01:00:00Z',
      updatedAt: '2026-08-05T01:01:00Z',
    },
    {
      id: 40,
      name: 'Linux',
      runNumber: 7,
      attempt: 2,
      event: 'push',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      htmlUrl: 'https://github.com/octo/demo/actions/runs/40',
      createdAt: '2026-08-04T23:00:00Z',
      updatedAt: '2026-08-04T23:10:00Z',
    },
    {
      id: 41,
      name: 'Security',
      runNumber: 8,
      attempt: 2,
      event: 'pull_request',
      status: 'completed' as const,
      conclusion: 'success' as const,
      htmlUrl: 'https://github.com/octo/demo/actions/runs/41',
      createdAt: '2026-08-05T00:00:00Z',
      updatedAt: '2026-08-05T00:10:00Z',
    },
  ],
};

const rerunPreview: Awaited<ReturnType<GitHubCiStatusPanelApi['preview']>> = {
  preflightId: 'a'.repeat(64),
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  branch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: true,
  run: status.runs[1],
};

const cancelPreview: Awaited<ReturnType<GitHubCiStatusPanelApi['cancelPreview']>> = {
  preflightId: 'c'.repeat(64),
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  branch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: true,
  run: status.runs[0],
};

function makeApi(
  load: GitHubCiStatusPanelApi['load'],
  preview: GitHubCiStatusPanelApi['preview'] = vi.fn(),
  rerun: GitHubCiStatusPanelApi['rerun'] = vi.fn(),
  cancelPreviewApi: GitHubCiStatusPanelApi['cancelPreview'] = vi.fn(),
  cancel: GitHubCiStatusPanelApi['cancel'] = vi.fn()
): GitHubCiStatusPanelApi {
  return { load, preview, rerun, cancelPreview: cancelPreviewApi, cancel };
}

describe('GitHubCiStatusPanel', () => {
  beforeEach(() => {
    window.electron.openExternal = vi.fn().mockResolvedValue(undefined);
  });

  it('waits for a CodePro project before loading CI', () => {
    const api = makeApi(vi.fn());

    render(<GitHubCiStatusPanel api={api} />);

    expect(screen.getByText('Open a CodePro project to view CI status.')).toBeVisible();
    expect(api.load).not.toHaveBeenCalled();
  });

  it('does not duplicate the initial request under React strict effects', async () => {
    const load = vi.fn().mockResolvedValue(status);

    render(
      <StrictMode>
        <GitHubCiStatusPanel workingDirectory={'D:\\project'} api={makeApi(load)} />
      </StrictMode>
    );

    expect(await screen.findByText('octo/demo')).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads once, shows the exact pushed commit, and prevents duplicate refreshes', async () => {
    const user = userEvent.setup();
    let resolveRefresh: (value: typeof status) => void = () => {};
    const load = vi
      .fn()
      .mockResolvedValueOnce(status)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          })
      );
    const api = makeApi(load);

    render(<GitHubCiStatusPanel workingDirectory={'D:\\project'} api={api} />);

    expect(await screen.findByText('Running')).toBeVisible();
    expect(load).toHaveBeenCalledWith({ workingDir: 'D:\\project' });
    expect(screen.getByText('octo/demo')).toBeVisible();
    expect(screen.getByText(/main/)).toHaveTextContent('1111111');
    expect(screen.getByText('Local changes are not included in this CI result.')).toBeVisible();
    expect(screen.getByText('Showing 3 of 8 workflow runs.')).toBeVisible();

    const refresh = screen.getByRole('button', { name: 'Refresh CI status' });
    await user.click(refresh);
    expect(refresh).toBeDisabled();
    await user.click(refresh);
    expect(load).toHaveBeenCalledTimes(2);

    resolveRefresh({ ...status, aggregateStatus: 'success' });
    expect(await screen.findByText('Passed')).toBeVisible();
  });

  it('ignores a stale response after the project changes', async () => {
    let resolveFirst: (value: typeof status) => void = () => {};
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        ...status,
        repositoryName: 'second',
        repositoryUrl: 'https://github.com/octo/second',
        runs: [],
        totalCount: 0,
        truncated: false,
        aggregateStatus: 'no_runs',
      });
    const view = render(<GitHubCiStatusPanel workingDirectory={'D:\\first'} api={makeApi(load)} />);

    view.rerender(<GitHubCiStatusPanel workingDirectory={'D:\\second'} api={makeApi(load)} />);
    expect(await screen.findByText('octo/second')).toBeVisible();
    resolveFirst(status);

    await waitFor(() => expect(screen.queryByText('octo/demo')).not.toBeInTheDocument());
    expect(load).toHaveBeenNthCalledWith(2, { workingDir: 'D:\\second' });
  });

  it('opens only an exact GitHub workflow run URL', async () => {
    const user = userEvent.setup();
    const invalid = {
      ...status,
      runs: [
        status.runs[0],
        {
          ...status.runs[1],
          id: 99,
          name: 'Forged',
          htmlUrl: 'https://attacker.invalid/actions/runs/99',
        },
      ],
    };
    render(
      <GitHubCiStatusPanel
        workingDirectory={'D:\\project'}
        api={makeApi(vi.fn().mockResolvedValue(invalid))}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Open CI run #9' }));
    expect(window.electron.openExternal).toHaveBeenCalledWith(
      'https://github.com/octo/demo/actions/runs/42'
    );
    expect(screen.queryByRole('button', { name: 'Open Forged run #8' })).not.toBeInTheDocument();
  });

  it('offers click-only artifact metadata on every exact run card', async () => {
    const user = userEvent.setup();
    const artifacts = vi.fn().mockResolvedValue({
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      branch: 'main',
      headSha: '1'.repeat(40),
      workingTreeDirty: true,
      run: {
        id: 41,
        name: 'Security',
        runNumber: 8,
        attempt: 2,
        event: 'pull_request',
        status: 'completed' as const,
        conclusion: 'success' as const,
      },
      totalCount: 0,
      artifacts: [],
    });
    const api = { ...makeApi(vi.fn().mockResolvedValue(status)), artifacts };

    render(<GitHubCiStatusPanel workingDirectory={'D:\\project'} api={api} />);

    expect(
      await screen.findByRole('button', { name: 'View artifacts for CI run #9' })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'View artifacts for Linux run #7' })).toBeVisible();
    const security = screen.getByRole('button', {
      name: 'View artifacts for Security run #8',
    });
    expect(artifacts).not.toHaveBeenCalled();
    await user.click(security);
    expect(await screen.findByText('No artifacts found for this run.')).toBeVisible();
    expect(artifacts).toHaveBeenCalledWith({ workingDir: 'D:\\project', runId: 41 });
  });

  it('offers only eligible failed runs, previews details, and cancels without writing', async () => {
    const user = userEvent.setup();
    const preview = vi.fn().mockResolvedValue(rerunPreview);
    const rerun = vi.fn();
    render(
      <GitHubCiStatusPanel
        workingDirectory={'D:\\project'}
        api={makeApi(vi.fn().mockResolvedValue(status), preview, rerun)}
      />
    );

    const action = await screen.findByRole('button', {
      name: 'Rerun failed jobs for Linux run #7',
    });
    expect(
      screen.queryByRole('button', { name: 'Rerun failed jobs for Security run #8' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Rerun failed jobs for CI run #9' })
    ).not.toBeInTheDocument();

    await user.click(action);
    expect(preview).toHaveBeenCalledWith({ workingDir: 'D:\\project', runId: 40 });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('octo/demo');
    expect(dialog).toHaveTextContent('Linux');
    expect(dialog).toHaveTextContent('attempt 2');
    expect(dialog).toHaveTextContent('main');
    expect(dialog).toHaveTextContent('1111111');
    expect(dialog).toHaveTextContent('may consume GitHub Actions minutes');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(rerun).not.toHaveBeenCalled();
  });

  it('confirms once, prevents duplicate writes, and refreshes status exactly once on success', async () => {
    const user = userEvent.setup();
    let resolveRerun: (
      value: Awaited<ReturnType<GitHubCiStatusPanelApi['rerun']>>
    ) => void = () => {};
    const load = vi
      .fn()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, aggregateStatus: 'success' });
    const preview = vi.fn().mockResolvedValue(rerunPreview);
    const rerun = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRerun = resolve;
        })
    );
    render(
      <GitHubCiStatusPanel workingDirectory={'D:\\project'} api={makeApi(load, preview, rerun)} />
    );

    await user.click(
      await screen.findByRole('button', { name: 'Rerun failed jobs for Linux run #7' })
    );
    const confirm = await screen.findByRole('button', { name: 'Rerun failed jobs' });
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(rerun).toHaveBeenCalledWith({
      workingDir: 'D:\\project',
      runId: 40,
      preflightId: 'a'.repeat(64),
    });

    resolveRerun({
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      branch: 'main',
      headSha: '1'.repeat(40),
      runId: 40,
      runUrl: 'https://github.com/octo/demo/actions/runs/40',
      previousAttempt: 2,
      auditId: 'audit-42',
      acceptedAt: '2026-08-05T02:00:00Z',
    });

    expect(await screen.findByText('Rerun request accepted.')).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
    expect(rerun).toHaveBeenCalledTimes(1);
  });

  it('discards a stale rerun preview after the project changes', async () => {
    const user = userEvent.setup();
    let resolvePreview: (value: typeof rerunPreview) => void = () => {};
    const preview = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        })
    );
    const api = makeApi(vi.fn().mockResolvedValue(status), preview, vi.fn());
    const view = render(<GitHubCiStatusPanel workingDirectory={'D:\\first'} api={api} />);
    await user.click(
      await screen.findByRole('button', { name: 'Rerun failed jobs for Linux run #7' })
    );

    view.rerender(<GitHubCiStatusPanel workingDirectory={'D:\\second'} api={api} />);
    resolvePreview(rerunPreview);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('clears a previous write result when starting a different CI action', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue(status);
    const rerun = vi.fn().mockResolvedValue({
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      branch: 'main',
      headSha: '1'.repeat(40),
      runId: 40,
      runUrl: 'https://github.com/octo/demo/actions/runs/40',
      previousAttempt: 2,
      auditId: 'audit-42',
      acceptedAt: '2026-08-05T02:00:00Z',
    });
    render(
      <GitHubCiStatusPanel
        workingDirectory={'D:\\project'}
        api={makeApi(
          load,
          vi.fn().mockResolvedValue(rerunPreview),
          rerun,
          vi.fn().mockResolvedValue(cancelPreview),
          vi.fn()
        )}
      />
    );

    await user.click(
      await screen.findByRole('button', { name: 'Rerun failed jobs for Linux run #7' })
    );
    await user.click(await screen.findByRole('button', { name: 'Rerun failed jobs' }));
    expect(await screen.findByText('Rerun request accepted.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Cancel CI run #9' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Cancel workflow run?');
    expect(screen.queryByText('Rerun request accepted.')).not.toBeInTheDocument();
  });

  it('reports an uncertain outcome without retrying or refreshing', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue(status);
    const rerun = vi
      .fn()
      .mockRejectedValue(
        new Error('The failed-jobs rerun outcome is uncertain; inspect GitHub before retrying')
      );
    render(
      <GitHubCiStatusPanel
        workingDirectory={'D:\\project'}
        api={makeApi(load, vi.fn().mockResolvedValue(rerunPreview), rerun)}
      />
    );

    await user.click(
      await screen.findByRole('button', { name: 'Rerun failed jobs for Linux run #7' })
    );
    await user.click(await screen.findByRole('button', { name: 'Rerun failed jobs' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('outcome is uncertain');
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('offers cancellation only for running runs and closes confirmation without writing', async () => {
    const user = userEvent.setup();
    const preview = vi.fn().mockResolvedValue(cancelPreview);
    const cancel = vi.fn();
    render(
      <GitHubCiStatusPanel
        workingDirectory={'D:\\project'}
        api={makeApi(vi.fn().mockResolvedValue(status), vi.fn(), vi.fn(), preview, cancel)}
      />
    );

    const action = await screen.findByRole('button', { name: 'Cancel CI run #9' });
    expect(screen.queryByRole('button', { name: 'Cancel Linux run #7' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel Security run #8' })
    ).not.toBeInTheDocument();

    await user.click(action);
    expect(preview).toHaveBeenCalledWith({ workingDir: 'D:\\project', runId: 42 });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Cancel workflow run?');
    expect(dialog).toHaveTextContent('CI');
    expect(dialog).toHaveTextContent('attempt 1');
    expect(dialog).toHaveTextContent('may stop jobs that are currently running');

    await user.click(screen.getByRole('button', { name: 'Keep running' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels once, prevents duplicate writes, and refreshes status exactly once on success', async () => {
    const user = userEvent.setup();
    let resolveCancel: (
      value: Awaited<ReturnType<GitHubCiStatusPanelApi['cancel']>>
    ) => void = () => {};
    const load = vi
      .fn()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, aggregateStatus: 'cancelled' });
    const cancel = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        })
    );
    render(
      <GitHubCiStatusPanel
        workingDirectory={'D:\\project'}
        api={makeApi(load, vi.fn(), vi.fn(), vi.fn().mockResolvedValue(cancelPreview), cancel)}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Cancel CI run #9' }));
    const confirm = await screen.findByRole('button', { name: 'Cancel workflow run' });
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith({
      workingDir: 'D:\\project',
      runId: 42,
      preflightId: 'c'.repeat(64),
    });

    resolveCancel({
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      branch: 'main',
      headSha: '1'.repeat(40),
      runId: 42,
      runUrl: 'https://github.com/octo/demo/actions/runs/42',
      attempt: 1,
      auditId: 'audit-cancel-42',
      acceptedAt: '2026-08-05T02:00:00Z',
    });

    expect(await screen.findByText('Cancellation request accepted.')).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports an uncertain cancellation without retrying or refreshing', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue(status);
    const cancel = vi
      .fn()
      .mockRejectedValue(
        new Error('The workflow cancellation outcome is uncertain; inspect GitHub before retrying')
      );
    render(
      <GitHubCiStatusPanel
        workingDirectory={'D:\\project'}
        api={makeApi(load, vi.fn(), vi.fn(), vi.fn().mockResolvedValue(cancelPreview), cancel)}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Cancel CI run #9' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel workflow run' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('outcome is uncertain');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
