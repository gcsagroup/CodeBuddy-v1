import { render as testingRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubCiArtifactsResponse, GitHubCiStatusResponse } from '../../acp/githubCi';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { GitHubCiArtifactsPanel } from './GitHubCiArtifactsPanel';

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

const status: GitHubCiStatusResponse = {
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  branch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: false,
  aggregateStatus: 'success',
  totalCount: 1,
  truncated: false,
  runs: [
    {
      id: 42,
      name: 'CI',
      runNumber: 9,
      attempt: 2,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      htmlUrl: 'https://github.com/octo/demo/actions/runs/42',
      createdAt: '2026-08-05T01:00:00Z',
      updatedAt: '2026-08-05T01:10:00Z',
    },
  ],
};

const response: GitHubCiArtifactsResponse = {
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  branch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: false,
  run: {
    id: 42,
    name: 'CI',
    runNumber: 9,
    attempt: 2,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  },
  totalCount: 1,
  artifacts: [
    {
      id: 7,
      name: 'test-results',
      sizeBytes: 12345,
      expired: false,
      createdAt: '2026-08-05T01:05:00Z',
      expiresAt: '2026-09-05T01:05:00Z',
      digest: `sha256:${'a'.repeat(64)}`,
    },
  ],
};

describe('GitHubCiArtifactsPanel', () => {
  it('loads only on click, suppresses a double click, and exposes no download action', async () => {
    const user = userEvent.setup();
    let resolveLoad: (value: GitHubCiArtifactsResponse) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<GitHubCiArtifactsResponse>((resolve) => {
          resolveLoad = resolve;
        })
    );
    render(
      <GitHubCiArtifactsPanel
        workingDirectory={'D:\\project'}
        status={status}
        run={status.runs[0]}
        load={load}
      />
    );

    expect(load).not.toHaveBeenCalled();
    const action = screen.getByRole('button', { name: 'View artifacts for CI run #9' });
    await user.dblClick(action);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ workingDir: 'D:\\project', runId: 42 });

    resolveLoad(response);
    expect(await screen.findByText('test-results')).toBeVisible();
    expect(screen.getByText('12.1 KiB')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/archive_download_url/i)).not.toBeInTheDocument();
  });

  it('shows empty and expired metadata without manufacturing a download URL', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue({
      ...response,
      totalCount: 0,
      artifacts: [],
    });
    const view = render(
      <GitHubCiArtifactsPanel
        workingDirectory={'D:\\project'}
        status={status}
        run={status.runs[0]}
        load={load}
      />
    );
    await user.click(screen.getByRole('button', { name: 'View artifacts for CI run #9' }));
    expect(await screen.findByText('No artifacts found for this run.')).toBeVisible();

    view.rerender(
      <IntlTestWrapper>
        <GitHubCiArtifactsPanel
          workingDirectory={'D:\\second'}
          status={status}
          run={status.runs[0]}
          load={vi.fn().mockResolvedValue({
            ...response,
            artifacts: [{ ...response.artifacts[0], expired: true }],
          })}
        />
      </IntlTestWrapper>
    );
    await user.click(screen.getByRole('button', { name: 'View artifacts for CI run #9' }));
    expect(await screen.findByText('Expired')).toBeVisible();
  });

  it('clears metadata and ignores a stale response when the project or run changes', async () => {
    const user = userEvent.setup();
    let resolveFirst: (value: GitHubCiArtifactsResponse) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<GitHubCiArtifactsResponse>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const view = render(
      <GitHubCiArtifactsPanel
        workingDirectory={'D:\\first'}
        status={status}
        run={status.runs[0]}
        load={load}
      />
    );
    await user.click(screen.getByRole('button', { name: 'View artifacts for CI run #9' }));

    view.rerender(
      <IntlTestWrapper>
        <GitHubCiArtifactsPanel
          workingDirectory={'D:\\second'}
          status={status}
          run={{ ...status.runs[0], id: 43, runNumber: 10 }}
          load={load}
        />
      </IntlTestWrapper>
    );
    resolveFirst(response);

    await waitFor(() => expect(screen.queryByText('test-results')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'View artifacts for CI run #10' })).toBeVisible();
  });

  it('rejects metadata that does not match the selected exact run', async () => {
    const user = userEvent.setup();
    render(
      <GitHubCiArtifactsPanel
        workingDirectory={'D:\\project'}
        status={status}
        run={status.runs[0]}
        load={vi.fn().mockResolvedValue({ ...response, headSha: '2'.repeat(40) })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'View artifacts for CI run #9' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'CodePro could not verify artifact metadata for this run.'
    );
    expect(screen.queryByText('test-results')).not.toBeInTheDocument();
  });
});
