import { render as testingRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { GitHubIssuesPanel } from './GitHubIssuesPanel';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  previewCreate: vi.fn(),
  create: vi.fn(),
  previewContent: vi.fn(),
  updateContent: vi.fn(),
  previewState: vi.fn(),
  changeState: vi.fn(),
}));

vi.mock('../../acp/githubIssues', () => ({
  acpListGitHubIssues: api.list,
  acpPreviewGitHubIssueCreate: api.previewCreate,
  acpCreateGitHubIssue: api.create,
  acpPreviewGitHubIssueContent: api.previewContent,
  acpUpdateGitHubIssueContent: api.updateContent,
  acpPreviewGitHubIssueState: api.previewState,
  acpChangeGitHubIssueState: api.changeState,
}));

const issue = {
  number: 7,
  title: 'Bounded issue',
  body: 'Current details.',
  state: 'open' as const,
  url: 'https://github.com/octo/demo/issues/7',
};

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

describe('GitHubIssuesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({
      repositoryUrl: 'https://github.com/octo/demo',
      issues: [issue],
    });
    api.previewCreate.mockImplementation(async (request) => ({
      preflightId: 'a'.repeat(64),
      operationId: request.operationId,
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      headBranch: 'feature/issues',
      title: 'New issue',
      body: 'New details.',
    }));
    api.create.mockResolvedValue({
      issue: {
        number: 8,
        title: 'New issue',
        body: 'New details.',
        state: 'open',
        url: 'https://github.com/Octo/Demo/issues/8',
      },
    });
    api.previewContent.mockResolvedValue({
      preflightId: 'b'.repeat(64),
      currentIssue: issue,
      targetTitle: 'Updated issue',
      targetBody: 'Updated details.',
    });
    api.updateContent.mockResolvedValue({
      issue: { ...issue, title: 'Updated issue', body: 'Updated details.' },
    });
    api.previewState.mockResolvedValue({
      preflightId: 'c'.repeat(64),
      issue,
      targetState: 'closed',
    });
    api.changeState.mockResolvedValue({
      issue: { ...issue, state: 'closed' },
    });
    window.electron.openExternal = vi.fn().mockResolvedValue(undefined);
  });

  it('lists the bounded repository issues', async () => {
    render(<GitHubIssuesPanel workingDirectory={'D:\\project'} />);

    expect(await screen.findByRole('heading', { name: 'Issues' })).toBeVisible();
    expect(screen.getByText('Issue #7')).toBeVisible();
    expect(screen.getByText('Bounded issue')).toBeVisible();
    expect(api.list).toHaveBeenCalledWith({ workingDir: 'D:\\project' });
  });

  it('rejects Issue URLs that escape the inspected repository', async () => {
    api.list.mockResolvedValue({
      repositoryUrl: 'https://github.com/octo/demo',
      issues: [{ ...issue, url: 'https://github.com/other/repo/issues/7' }],
    });

    render(<GitHubIssuesPanel workingDirectory={'D:\\project'} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub Issues could not be refreshed.'
    );
    expect(screen.queryByText('Issue #7')).not.toBeInTheDocument();
  });

  it('accepts GitHub repository casing in issue URLs', async () => {
    api.list.mockResolvedValue({
      repositoryUrl: 'https://github.com/octo/demo',
      issues: [{ ...issue, url: 'https://github.com/Octo/Demo/issues/7' }],
    });

    render(<GitHubIssuesPanel workingDirectory={'D:\\project'} />);

    expect(await screen.findByText('Issue #7')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('creates an issue only after a fresh preview and second confirmation', async () => {
    const user = userEvent.setup();
    render(<GitHubIssuesPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Create Issue' }));
    await user.type(screen.getByRole('textbox', { name: 'Issue title' }), 'New issue');
    await user.type(screen.getByRole('textbox', { name: 'Issue description' }), 'New details.');
    expect(api.create).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Run create preflight' }));
    expect(api.previewCreate).toHaveBeenCalledWith({
      workingDir: 'D:\\project',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      title: 'New issue',
      body: 'New details.',
    });
    await user.click(await screen.findByRole('button', { name: 'Create on GitHub' }));

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        workingDir: 'D:\\project',
        operationId: api.previewCreate.mock.calls[0][0].operationId,
        title: 'New issue',
        body: 'New details.',
        preflightId: 'a'.repeat(64),
      })
    );
  });

  it('edits issue content only after a fresh preview and second confirmation', async () => {
    const user = userEvent.setup();
    render(<GitHubIssuesPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Edit Issue #7' }));
    const title = screen.getByRole('textbox', { name: 'Issue title' });
    const body = screen.getByRole('textbox', { name: 'Issue description' });
    await user.clear(title);
    await user.type(title, 'Updated issue');
    await user.clear(body);
    await user.type(body, 'Updated details.');
    await user.click(screen.getByRole('button', { name: 'Run update preflight' }));
    await user.click(await screen.findByRole('button', { name: 'Update on GitHub' }));

    await waitFor(() =>
      expect(api.updateContent).toHaveBeenCalledWith({
        workingDir: 'D:\\project',
        number: 7,
        title: 'Updated issue',
        body: 'Updated details.',
        preflightId: 'b'.repeat(64),
      })
    );
  });

  it('closes and reopens only after state preflight', async () => {
    const user = userEvent.setup();
    render(<GitHubIssuesPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Close Issue #7' }));
    expect(api.changeState).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Run state preflight' }));
    await user.click(await screen.findByRole('button', { name: 'Close on GitHub' }));

    await waitFor(() =>
      expect(api.changeState).toHaveBeenCalledWith({
        workingDir: 'D:\\project',
        number: 7,
        targetState: 'closed',
        preflightId: 'c'.repeat(64),
      })
    );
  });

  it('fails closed after an uncertain issue write', async () => {
    const user = userEvent.setup();
    api.changeState.mockRejectedValue({ data: { code: 'uncertain_effect' } });
    render(<GitHubIssuesPanel workingDirectory={'D:\\project'} />);

    await user.click(await screen.findByRole('button', { name: 'Close Issue #7' }));
    await user.click(screen.getByRole('button', { name: 'Run state preflight' }));
    await user.click(await screen.findByRole('button', { name: 'Close on GitHub' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The remote result is uncertain. Inspect Issues on GitHub before retrying.'
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.changeState).toHaveBeenCalledTimes(1);
  });
});
