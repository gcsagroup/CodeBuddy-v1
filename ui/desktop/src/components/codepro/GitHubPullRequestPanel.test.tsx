import { render as testingRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { GitHubPullRequestPanel } from './GitHubPullRequestPanel';

const acp = vi.hoisted(() => ({
  status: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  previewState: vi.fn(),
  changeState: vi.fn(),
  previewContent: vi.fn(),
  updateContent: vi.fn(),
}));

vi.mock('../../acp/githubPullRequests', () => ({
  acpGitHubDeliveryStatus: acp.status,
  acpPreviewGitHubPullRequest: acp.preview,
  acpCreateGitHubPullRequest: acp.create,
  acpPreviewGitHubPullRequestState: acp.previewState,
  acpChangeGitHubPullRequestState: acp.changeState,
  acpPreviewGitHubPullRequestContent: acp.previewContent,
  acpUpdateGitHubPullRequestContent: acp.updateContent,
}));

vi.mock('./GitHubIssuesPanel', () => ({
  GitHubIssuesPanel: () => <div>GitHub Issues panel</div>,
}));

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

const delivery = {
  cliStatus: 'ready' as const,
  accountLogin: 'octocat',
  repository: {
    owner: 'octo',
    name: 'demo',
    url: 'https://github.com/octo/demo',
    headBranch: 'feature/pr-flow',
  },
  pullRequest: {
    number: 42,
    title: 'Add bounded PR flow',
    body: 'Current Pull Request description.',
    state: 'open' as const,
    url: 'https://github.com/octo/demo/pull/42',
    headBranch: 'feature/pr-flow',
    baseBranch: 'main',
    draft: false,
  },
  requiredChecks: [
    {
      name: 'build',
      state: 'QUEUED',
      bucket: 'pending' as const,
      url: 'https://github.com/octo/demo/actions/runs/1',
      description: 'Required build',
    },
  ],
};

describe('GitHubPullRequestPanel delivery view', () => {
  beforeEach(() => {
    acp.status.mockReset().mockResolvedValue(delivery);
    acp.preview.mockReset().mockResolvedValue({
      preflightId: 'a'.repeat(64),
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      headBranch: 'feature/pr-flow',
      headSha: '1'.repeat(40),
      baseBranch: 'main',
      baseSha: '2'.repeat(40),
      commitCount: 2,
      changedFileCount: 3,
      draft: false,
      maintainerCanModify: false,
    });
    acp.create.mockReset();
    acp.previewState.mockReset().mockResolvedValue({
      preflightId: 'b'.repeat(64),
      number: 42,
      title: 'Add bounded PR flow',
      currentState: 'open',
      targetState: 'closed',
      url: 'https://github.com/octo/demo/pull/42',
      headBranch: 'feature/pr-flow',
      baseBranch: 'main',
    });
    acp.changeState.mockReset().mockResolvedValue({
      number: 42,
      state: 'closed',
      url: 'https://github.com/octo/demo/pull/42',
    });
    acp.previewContent.mockReset().mockResolvedValue({
      preflightId: 'd'.repeat(64),
      number: 42,
      currentTitle: 'Add bounded PR flow',
      currentBody: 'Current Pull Request description.',
      targetTitle: 'Clarify bounded PR flow',
      targetBody: 'Updated Pull Request description.',
      state: 'open',
      url: 'https://github.com/octo/demo/pull/42',
      headBranch: 'feature/pr-flow',
      baseBranch: 'main',
    });
    acp.updateContent.mockReset().mockResolvedValue({
      number: 42,
      title: 'Clarify bounded PR flow',
      body: 'Updated Pull Request description.',
      state: 'open',
      url: 'https://github.com/octo/demo/pull/42',
    });
    window.electron.openExternal = vi.fn().mockResolvedValue(undefined);
  });

  it('creates only after the successful preflight is explicitly confirmed', async () => {
    const user = userEvent.setup();
    acp.status.mockResolvedValue({ ...delivery, pullRequest: undefined, requiredChecks: [] });
    acp.create.mockResolvedValue({
      number: 42,
      title: 'Ship verified CodePro changes',
      state: 'open',
      htmlUrl: 'https://github.com/octo/demo/pull/42',
      headBranch: 'feature/pr-flow',
      baseBranch: 'main',
      draft: false,
    });
    render(
      <GitHubPullRequestPanel
        workingDirectory={'D:\\project'}
        suggestedTitle="Ship verified CodePro changes"
        suggestedBody="Tests passed locally."
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Prepare Pull Request' }));
    await user.click(screen.getByRole('button', { name: 'Run preflight' }));
    expect(
      await screen.findByText(
        'The next confirmation pushes the verified branch and creates a Pull Request on GitHub.'
      )
    ).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Create on GitHub' }));

    await waitFor(() =>
      expect(acp.create).toHaveBeenCalledWith(
        expect.objectContaining({
          preflightId: 'a'.repeat(64),
          title: 'Ship verified CodePro changes',
          body: 'Tests passed locally.',
        })
      )
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps creation at zero side effects until a preview and second confirmation', async () => {
    const user = userEvent.setup();
    acp.status.mockResolvedValue({ ...delivery, pullRequest: undefined, requiredChecks: [] });
    render(
      <GitHubPullRequestPanel
        workingDirectory={'D:\\project'}
        suggestedTitle="Ship verified CodePro changes"
        suggestedBody="Tests passed locally."
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Prepare Pull Request' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Ship verified CodePro changes'
    );
    expect(acp.preview).not.toHaveBeenCalled();
    expect(acp.create).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Run preflight' }));
    expect(acp.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDir: 'D:\\project',
        title: 'Ship verified CodePro changes',
        body: 'Tests passed locally.',
      })
    );
    expect(await screen.findByText('2 commits · 3 files')).toBeVisible();
    expect(acp.create).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(acp.create).not.toHaveBeenCalled();
  });

  it('fails closed after an uncertain remote write and requires inspection before retry', async () => {
    const user = userEvent.setup();
    acp.status.mockResolvedValue({ ...delivery, pullRequest: undefined, requiredChecks: [] });
    acp.create.mockRejectedValue({ data: { code: 'uncertain_effect' } });
    render(
      <GitHubPullRequestPanel
        workingDirectory={'D:\\project'}
        suggestedTitle="Ship verified CodePro changes"
        suggestedBody="Tests passed locally."
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Prepare Pull Request' }));
    await user.click(screen.getByRole('button', { name: 'Run preflight' }));
    await user.click(await screen.findByRole('button', { name: 'Create on GitHub' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The remote result is uncertain. Inspect the branch and Pull Requests on GitHub before retrying.'
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare Pull Request' })).not.toBeInTheDocument();
    expect(acp.create).toHaveBeenCalledTimes(1);
  });

  it('requires a session working directory before refresh', () => {
    render(<GitHubPullRequestPanel />);

    expect(screen.getByText('Open a CodePro project to inspect delivery status.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh delivery status' })).toBeDisabled();
    expect(acp.status).not.toHaveBeenCalled();
  });

  it('shows the current branch, Pull Request, and required checks', async () => {
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    expect(await screen.findByRole('heading', { name: 'Delivery' })).toBeVisible();
    await waitFor(() => expect(acp.status).toHaveBeenCalledWith({ workingDir: 'D:\\project' }));
    expect(await screen.findByText('feature/pr-flow')).toBeVisible();
    expect(screen.getByText('Pull Request #42')).toBeVisible();
    expect(screen.getByText('build')).toBeVisible();
    expect(screen.getByText('Pending')).toBeVisible();
  });

  it('closes the current Pull Request only after a fresh preview and second confirmation', async () => {
    const user = userEvent.setup();
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Close Pull Request' }));
    expect(acp.previewState).not.toHaveBeenCalled();
    expect(acp.changeState).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Run state preflight' }));
    expect(acp.previewState).toHaveBeenCalledWith({
      workingDir: 'D:\\project',
      number: 42,
      targetState: 'closed',
    });
    expect(await screen.findByText(/will close Pull Request #42/)).toBeVisible();
    expect(acp.changeState).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close on GitHub' }));
    await waitFor(() =>
      expect(acp.changeState).toHaveBeenCalledWith({
        workingDir: 'D:\\project',
        number: 42,
        targetState: 'closed',
        preflightId: 'b'.repeat(64),
      })
    );
  });

  it('offers reopen only for a closed Pull Request', async () => {
    const user = userEvent.setup();
    acp.status.mockResolvedValue({
      ...delivery,
      pullRequest: { ...delivery.pullRequest, state: 'closed' as const },
      requiredChecks: [],
    });
    acp.previewState.mockResolvedValue({
      preflightId: 'c'.repeat(64),
      number: 42,
      title: 'Add bounded PR flow',
      currentState: 'closed',
      targetState: 'open',
      url: 'https://github.com/octo/demo/pull/42',
      headBranch: 'feature/pr-flow',
      baseBranch: 'main',
    });
    acp.changeState.mockResolvedValue({
      number: 42,
      state: 'open',
      url: 'https://github.com/octo/demo/pull/42',
    });
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    expect(await screen.findByRole('button', { name: 'Reopen Pull Request' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close Pull Request' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reopen Pull Request' }));
    await user.click(screen.getByRole('button', { name: 'Run state preflight' }));
    await user.click(await screen.findByRole('button', { name: 'Reopen on GitHub' }));
    await waitFor(() =>
      expect(acp.changeState).toHaveBeenCalledWith(
        expect.objectContaining({ targetState: 'open', preflightId: 'c'.repeat(64) })
      )
    );
  });

  it('fails closed when a Pull Request state write has an uncertain effect', async () => {
    const user = userEvent.setup();
    acp.changeState.mockRejectedValue({ data: { code: 'uncertain_effect' } });
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Close Pull Request' }));
    await user.click(screen.getByRole('button', { name: 'Run state preflight' }));
    await user.click(await screen.findByRole('button', { name: 'Close on GitHub' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The remote result is uncertain. Inspect the branch and Pull Requests on GitHub before retrying.'
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(acp.changeState).toHaveBeenCalledTimes(1);
  });

  it('rejects a substituted state preview before any remote write', async () => {
    const user = userEvent.setup();
    acp.previewState.mockResolvedValue({
      preflightId: 'b'.repeat(64),
      number: 99,
      title: 'Add bounded PR flow',
      currentState: 'open',
      targetState: 'closed',
      url: 'https://github.com/octo/demo/pull/99',
      headBranch: 'feature/pr-flow',
      baseBranch: 'main',
    });
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Close Pull Request' }));
    await user.click(screen.getByRole('button', { name: 'Run state preflight' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pull Request state preflight failed.'
    );
    expect(screen.queryByRole('button', { name: 'Close on GitHub' })).not.toBeInTheDocument();
    expect(acp.changeState).not.toHaveBeenCalled();
  });

  it('updates the Pull Request title and body only after a fresh preview and second confirmation', async () => {
    const user = userEvent.setup();
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Edit Pull Request' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    const body = screen.getByRole('textbox', { name: 'Description' });
    expect(title).toHaveValue('Add bounded PR flow');
    expect(body).toHaveValue('Current Pull Request description.');
    await user.clear(title);
    await user.type(title, 'Clarify bounded PR flow');
    await user.clear(body);
    await user.type(body, 'Updated Pull Request description.');

    expect(acp.previewContent).not.toHaveBeenCalled();
    expect(acp.updateContent).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Run update preflight' }));
    expect(acp.previewContent).toHaveBeenCalledWith({
      workingDir: 'D:\\project',
      number: 42,
      title: 'Clarify bounded PR flow',
      body: 'Updated Pull Request description.',
    });
    expect(await screen.findByText(/will update Pull Request #42/)).toBeVisible();
    expect(acp.updateContent).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Update on GitHub' }));
    await waitFor(() =>
      expect(acp.updateContent).toHaveBeenCalledWith({
        workingDir: 'D:\\project',
        number: 42,
        title: 'Clarify bounded PR flow',
        body: 'Updated Pull Request description.',
        preflightId: 'd'.repeat(64),
      })
    );
  });

  it('rejects a substituted content preview before any remote write', async () => {
    const user = userEvent.setup();
    acp.previewContent.mockResolvedValue({
      preflightId: 'd'.repeat(64),
      number: 99,
      currentTitle: 'Add bounded PR flow',
      currentBody: 'Current Pull Request description.',
      targetTitle: 'Attacker replacement',
      targetBody: 'Updated Pull Request description.',
      state: 'open',
      url: 'https://github.com/octo/demo/pull/99',
      headBranch: 'feature/pr-flow',
      baseBranch: 'main',
    });
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Edit Pull Request' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Clarify bounded PR flow');
    await user.click(screen.getByRole('button', { name: 'Run update preflight' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pull Request update preflight failed.'
    );
    expect(screen.queryByRole('button', { name: 'Update on GitHub' })).not.toBeInTheDocument();
    expect(acp.updateContent).not.toHaveBeenCalled();
  });

  it('fails closed when a Pull Request content update has an uncertain effect', async () => {
    const user = userEvent.setup();
    acp.updateContent.mockRejectedValue({ data: { code: 'uncertain_effect' } });
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Edit Pull Request' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    const body = screen.getByRole('textbox', { name: 'Description' });
    await user.clear(title);
    await user.type(title, 'Clarify bounded PR flow');
    await user.clear(body);
    await user.type(body, 'Updated Pull Request description.');
    await user.click(screen.getByRole('button', { name: 'Run update preflight' }));
    await user.click(await screen.findByRole('button', { name: 'Update on GitHub' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The remote result is uncertain. Inspect the branch and Pull Requests on GitHub before retrying.'
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(acp.updateContent).toHaveBeenCalledTimes(1);
  });

  it('keeps merged Pull Requests read-only', async () => {
    acp.status.mockResolvedValue({
      ...delivery,
      pullRequest: { ...delivery.pullRequest, state: 'merged' as const },
      requiredChecks: [],
    });
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    expect(await screen.findByText('Pull Request #42')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit Pull Request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Pull Request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen Pull Request' })).not.toBeInTheDocument();
  });

  it('opens only the validated GitHub Pull Request URL', async () => {
    const user = userEvent.setup();
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Open on GitHub' }));
    expect(window.electron.openExternal).toHaveBeenCalledWith(
      'https://github.com/octo/demo/pull/42'
    );
  });

  it('opens the official GitHub CLI download only after confirmation', async () => {
    const user = userEvent.setup();
    acp.status.mockResolvedValue({
      ...delivery,
      cliStatus: 'unavailable',
      accountLogin: undefined,
      pullRequest: undefined,
      requiredChecks: [],
    });
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Install GitHub CLI' }));
    expect(
      screen.getByText('Open the official GitHub CLI download page in your browser?')
    ).toBeVisible();
    expect(window.electron.openExternal).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Open GitHub CLI download page' }));
    expect(window.electron.openExternal).toHaveBeenCalledWith('https://cli.github.com/');
  });

  it('copies the fixed GitHub CLI login command without starting authentication', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    acp.status.mockResolvedValue({
      ...delivery,
      cliStatus: 'not_authenticated',
      accountLogin: undefined,
      pullRequest: undefined,
      requiredChecks: [],
    });
    render(<GitHubPullRequestPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Copy GitHub login command' }));
    expect(writeText).toHaveBeenCalledWith('gh auth login --hostname github.com --web');
    expect(screen.getByText(/Login command copied/)).toBeVisible();
    expect(window.electron.openExternal).not.toHaveBeenCalled();
  });

  it('ignores stale status after the project changes and shows a recovery action', async () => {
    let resolveFirst: (value: typeof delivery) => void = () => {};
    acp.status
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockRejectedValueOnce({ data: { code: 'no_remote' } });
    const view = render(<GitHubPullRequestPanel workingDirectory={'D:\\first'} />);

    view.rerender(<GitHubPullRequestPanel workingDirectory={'D:\\second'} />);
    resolveFirst(delivery);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Add a GitHub origin remote before refreshing.'
    );
    expect(screen.queryByText('Pull Request #42')).not.toBeInTheDocument();
  });
});
