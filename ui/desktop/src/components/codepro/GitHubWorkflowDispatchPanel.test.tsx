import { render as testingRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import {
  GitHubWorkflowDispatchPanel,
  type GitHubWorkflowDispatchPanelApi,
} from './GitHubWorkflowDispatchPanel';

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

const workflow = {
  id: 42,
  name: 'Release',
  path: '.github/workflows/release.yml',
  inputs: [
    {
      name: 'channel',
      description: 'Release channel',
      inputType: 'choice' as const,
      required: true,
      options: ['beta', 'stable'],
    },
    {
      name: 'dry_run',
      description: 'Do not publish',
      inputType: 'boolean' as const,
      required: false,
      defaultValue: 'false',
      options: [],
    },
    {
      name: 'count',
      description: 'Replica count',
      inputType: 'number' as const,
      required: false,
      options: [],
    },
    {
      name: 'environment',
      description: 'Target environment',
      inputType: 'environment' as const,
      required: false,
      options: [],
    },
    {
      name: 'note',
      description: 'Release note',
      inputType: 'string' as const,
      required: false,
      options: [],
    },
  ],
};

const catalog = {
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  defaultBranch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: true,
  workflows: [workflow],
};

const preview = {
  preflightId: 'a'.repeat(64),
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  defaultBranch: 'main',
  headSha: '1'.repeat(40),
  workingTreeDirty: true,
  workflow,
  inputSummary: [
    { name: 'channel', inputType: 'choice' as const, source: 'provided' as const },
    { name: 'dry_run', inputType: 'boolean' as const, source: 'default' as const },
    { name: 'count', inputType: 'number' as const, source: 'omitted' as const },
    { name: 'environment', inputType: 'environment' as const, source: 'omitted' as const },
    { name: 'note', inputType: 'string' as const, source: 'omitted' as const },
  ],
};

const receipt = {
  repositoryOwner: 'octo',
  repositoryName: 'demo',
  repositoryUrl: 'https://github.com/octo/demo',
  defaultBranch: 'main',
  headSha: '1'.repeat(40),
  workflowId: 42,
  workflowName: 'Release',
  workflowPath: '.github/workflows/release.yml',
  runId: 9001,
  runUrl: 'https://github.com/octo/demo/actions/runs/9001',
  auditId: 'audit-1',
  acceptedAt: '2026-08-05T01:00:00Z',
};

function api(
  overrides: Partial<GitHubWorkflowDispatchPanelApi> = {}
): GitHubWorkflowDispatchPanelApi {
  return {
    load: vi.fn().mockResolvedValue(catalog),
    preview: vi.fn().mockResolvedValue(preview),
    dispatch: vi.fn().mockResolvedValue(receipt),
    ...overrides,
  };
}

describe('GitHubWorkflowDispatchPanel', () => {
  it('loads once under strict effects and renders schema-driven controls', async () => {
    let resolveCatalog: (value: typeof catalog) => void = () => {};
    const load = vi
      .fn()
      .mockImplementation(
        () => new Promise<typeof catalog>((resolve) => (resolveCatalog = resolve))
      );
    const service = api({ load });
    render(
      <StrictMode>
        <GitHubWorkflowDispatchPanel workingDirectory={'D:\\project'} api={service} />
      </StrictMode>
    );

    expect(service.load).toHaveBeenCalledTimes(1);
    resolveCatalog(catalog);
    expect(await screen.findByText('Run a workflow')).toBeVisible();
    expect(await screen.findByRole('combobox', { name: 'Workflow' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Workflow' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Release channel' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Do not publish' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Replica count' })).toHaveAttribute(
      'inputmode',
      'decimal'
    );
    expect(screen.getByRole('textbox', { name: 'Target environment' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Release note' })).toBeVisible();
  });

  it('previews details without input values and closing performs no write', async () => {
    const user = userEvent.setup();
    const service = api();
    render(<GitHubWorkflowDispatchPanel workingDirectory={'D:\\project'} api={service} />);

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Release channel' }),
      'beta'
    );
    await user.click(screen.getByRole('button', { name: 'Review workflow run' }));

    expect(service.preview).toHaveBeenCalledWith({
      workingDir: 'D:\\project',
      workflowId: 42,
      inputs: [{ name: 'channel', value: 'beta' }],
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('octo/demo');
    expect(dialog).toHaveTextContent('.github/workflows/release.yml');
    expect(dialog).toHaveTextContent('channel');
    expect(dialog).toHaveTextContent('provided');
    expect(dialog).not.toHaveTextContent('beta');

    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(service.dispatch).not.toHaveBeenCalled();
  });

  it('confirms once, blocks double submission, and refreshes exactly once', async () => {
    const user = userEvent.setup();
    let resolveDispatch: (value: typeof receipt) => void = () => {};
    const dispatch = vi
      .fn()
      .mockImplementation(
        () => new Promise<typeof receipt>((resolve) => (resolveDispatch = resolve))
      );
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    const service = api({ dispatch });
    render(
      <GitHubWorkflowDispatchPanel
        workingDirectory={'D:\\project'}
        api={service}
        onAccepted={onAccepted}
      />
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Release channel' }),
      'beta'
    );
    await user.click(screen.getByRole('button', { name: 'Review workflow run' }));
    const confirm = await screen.findByRole('button', { name: 'Run workflow' });
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(dispatch).toHaveBeenCalledTimes(1);

    resolveDispatch(receipt);
    expect(await screen.findByText('Workflow run accepted.')).toBeVisible();
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it('clears preview on project change and permanently blocks retry after an uncertain outcome', async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn().mockRejectedValue({ data: { code: 'outcome_uncertain' } });
    const service = api({ dispatch });
    const view = render(
      <GitHubWorkflowDispatchPanel workingDirectory={'D:\\first'} api={service} />
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Release channel' }),
      'beta'
    );
    await user.click(screen.getByRole('button', { name: 'Review workflow run' }));
    expect(await screen.findByRole('dialog')).toBeVisible();

    view.rerender(<GitHubWorkflowDispatchPanel workingDirectory={'D:\\second'} api={service} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(dispatch).not.toHaveBeenCalled();

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Release channel' }),
      'beta'
    );
    await user.click(screen.getByRole('button', { name: 'Review workflow run' }));
    await user.click(await screen.findByRole('button', { name: 'Run workflow' }));
    expect(await screen.findByText(/Inspect GitHub before taking another action/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review workflow run' })).toBeDisabled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
