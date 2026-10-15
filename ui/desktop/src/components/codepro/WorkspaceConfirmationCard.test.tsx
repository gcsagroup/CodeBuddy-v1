import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'react-intl';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { CodeProWorkspaceInspection } from '../../codepro/projectWorkspace';
import { WorkspaceConfirmationCard } from './WorkspaceConfirmationCard';
import zhCnMessages from '../../i18n/messages/zh-CN.json';
import esMessages from '../../i18n/messages/es.json';

function candidate(
  normalizedPath: string,
  overrides: Partial<CodeProWorkspaceInspection> = {}
): CodeProWorkspaceInspection {
  return {
    requestedPath: normalizedPath,
    normalizedPath,
    normalizedIdentity: normalizedPath.toLowerCase(),
    canonicalPath: null,
    source: 'prompt',
    state: 'missing',
    isGitRepository: false,
    displayName: normalizedPath.split('\\').slice(-1)[0] || normalizedPath,
    suggestedProjectId: 'project-a1b2c3d4e5f6',
    error: null,
    ...overrides,
  };
}

describe('WorkspaceConfirmationCard', () => {
  it('uses Chinese confirmation copy in a zh-CN desktop session', () => {
    render(
      <WorkspaceConfirmationCard
        candidates={[candidate('D:\\CodeProCp01\\Ledger App')]}
        confirming={false}
        error={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
      {
        wrapper: ({ children }) => (
          <IntlProvider
            locale="zh-CN"
            messages={Object.fromEntries(
              Object.entries(zhCnMessages).map(([id, message]) => [id, message.defaultMessage])
            )}
          >
            {children}
          </IntlProvider>
        ),
      }
    );

    expect(screen.getByRole('heading', { name: '确认项目工作目录' })).toBeVisible();
    expect(screen.getByRole('button', { name: '确认并开始' })).toBeVisible();
    expect(screen.getByRole('button', { name: '取消' })).toBeVisible();
  });

  it('reformats visible copy when the selected locale changes', () => {
    const props = {
      candidates: [candidate('D:\\CodeProCp01\\Ledger App')],
      confirming: false,
      error: null,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    const { rerender } = render(
      <IntlProvider locale="en" messages={{}}>
        <WorkspaceConfirmationCard {...props} />
      </IntlProvider>
    );

    expect(screen.getByRole('heading', { name: 'Confirm project workspace' })).toBeVisible();

    rerender(
      <IntlProvider
        locale="zh-CN"
        messages={Object.fromEntries(
          Object.entries(zhCnMessages).map(([id, message]) => [id, message.defaultMessage])
        )}
      >
        <WorkspaceConfirmationCard {...props} />
      </IntlProvider>
    );

    expect(screen.getByRole('heading', { name: '确认项目工作目录' })).toBeVisible();
  });

  it('uses the complete catalog for the currently selected non-Chinese locale', () => {
    render(
      <IntlProvider
        locale="es"
        messages={Object.fromEntries(
          Object.entries(esMessages).map(([id, message]) => [id, message.defaultMessage])
        )}
      >
        <WorkspaceConfirmationCard
          candidates={[candidate('D:\\CodeProCp01\\Ledger App')]}
          confirming={false}
          error={null}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </IntlProvider>
    );

    expect(
      screen.getByRole('heading', { name: 'Confirmar espacio de trabajo del proyecto' })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirmar e iniciar' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeVisible();
  });

  it('shows the exact missing path and explains that confirmation creates it', () => {
    render(
      <WorkspaceConfirmationCard
        candidates={[candidate('D:\\CodeProCp01\\Ledger App')]}
        confirming={false}
        error={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByRole('heading', { name: 'Confirm project workspace' })).toBeVisible();
    expect(screen.getByText('D:\\CodeProCp01\\Ledger App')).toBeVisible();
    expect(screen.getByText(/does not exist.*created only after confirmation/i)).toBeVisible();
    expect(screen.getByText('Local project directory')).toBeVisible();
    expect(screen.getByText('Writable root: D:\\CodeProCp01\\Ledger App')).toBeVisible();
    expect(screen.getByText('Worktree isolation: Off')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm and start' })).toHaveFocus();
  });

  it('requires an explicit choice when the prompt contains multiple paths', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const first = candidate('D:\\CodePro\\Old', { state: 'non-empty-directory' });
    const second = candidate('E:\\CodePro\\New');
    render(
      <WorkspaceConfirmationCard
        candidates={[first, second]}
        confirming={false}
        error={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByRole('button', { name: 'Confirm and start' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /E:\\CodePro\\New/u }));
    await user.click(screen.getByRole('button', { name: 'Confirm and start' }));

    expect(onConfirm).toHaveBeenCalledWith(second);
  });

  it('shows existing content and Git state without relying on color', () => {
    render(
      <WorkspaceConfirmationCard
        candidates={[
          candidate('D:\\Repos\\Ledger', {
            state: 'non-empty-directory',
            isGitRepository: true,
            canonicalPath: 'D:\\Repos\\Ledger',
          }),
        ]}
        confirming={false}
        error={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Existing directory with files')).toBeVisible();
    expect(screen.getByText('Git repository detected')).toBeVisible();
  });

  it('requires an explicit scope choice for a folder with files', async () => {
    const user = userEvent.setup();
    const existing = candidate('D:\\SchoolSystem', {
      state: 'non-empty-directory',
      isGitRepository: true,
    });
    const onConfirm = vi.fn();
    const onCreateSeparateProject = vi.fn();
    render(
      <WorkspaceConfirmationCard
        candidates={[existing]}
        confirming={false}
        error={null}
        onConfirm={onConfirm}
        onCreateSeparateProject={onCreateSeparateProject}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText(/already contains files/i)).toBeVisible();
    expect(
      screen.getByText(/File changes and Git operations will take place in this folder/i)
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Choose this conversation’s project' })
    ).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onCreateSeparateProject).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Create a separate project' }));
    expect(onCreateSeparateProject).toHaveBeenCalledWith(existing);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not imply a previous project exists for an ordinary non-Git folder', async () => {
    const user = userEvent.setup();
    const folder = candidate('D:\\Documents\\Notes', {
      state: 'non-empty-directory',
      isGitRepository: false,
    });
    const onConfirm = vi.fn();
    render(
      <WorkspaceConfirmationCard
        candidates={[folder]}
        confirming={false}
        error={null}
        onConfirm={onConfirm}
        onCreateSeparateProject={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText(/already contains files/i)).toBeVisible();
    expect(screen.queryByText(/already contains a project|with the existing project/i)).toBeNull();
    expect(screen.queryByText('Git repository detected')).toBeNull();
    expect(screen.getByText(/Project memory is grouped by this folder/i)).toBeVisible();
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(onConfirm).toHaveBeenCalledWith(folder);
  });

  it('shows the canonical destination when a junction changes the resolved workspace path', () => {
    render(
      <WorkspaceConfirmationCard
        candidates={[
          candidate('D:\\Links\\Ledger\\new-app', {
            canonicalPath: 'E:\\Canonical\\Ledger\\new-app',
            normalizedIdentity: 'e:\\canonical\\ledger\\new-app',
          }),
        ]}
        confirming={false}
        error={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Resolved location: E:\\Canonical\\Ledger\\new-app')).toBeVisible();
  });

  it('allows confirming a filesystem root as a non-writable container', async () => {
    const user = userEvent.setup();
    const root = candidate('D:\\', { state: 'filesystem-root' });
    const onConfirm = vi.fn();
    render(
      <WorkspaceConfirmationCard
        candidates={[root]}
        confirming={false}
        error={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Drive root selected as a container only')).toBeVisible();
    expect(
      screen.getByText('Confirming this root does not grant permission to write anywhere on it.')
    ).toBeVisible();
    expect(screen.getByText('Writable root: None')).toBeVisible();
    const confirm = screen.getByRole('button', { name: 'Confirm container' });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(root);
  });

  it.each([
    ['file', 'The selected path is a file, not a directory'],
    ['unavailable', 'The directory cannot be inspected'],
  ] as const)('blocks confirmation for %s', (state, explanation) => {
    render(
      <WorkspaceConfirmationCard
        candidates={[
          candidate('D:\\', { state, error: state === 'unavailable' ? 'denied' : null }),
        ]}
        confirming={false}
        error={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText(explanation)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm and start' })).toBeDisabled();
  });

  it('announces setup errors and allows cancellation', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <WorkspaceConfirmationCard
        candidates={[candidate('D:\\CodePro\\Ledger')]}
        confirming={false}
        error="Project setup failed"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Project setup failed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
