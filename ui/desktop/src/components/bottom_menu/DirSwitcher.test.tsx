import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { DirSwitcher } from './DirSwitcher';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod: request }) }));

describe('DirSwitcher while the workspace is unbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue({ directories: ['D:/Agents/Writer'] });
    window.electron.listRecentDirs = vi.fn().mockResolvedValue(['D:\\Recent']);
    window.electron.listGitWorktreeDirs = vi.fn().mockResolvedValue(['D:\\Worktree']);
    window.electron.openDirectoryInExplorer = vi.fn().mockResolvedValue(undefined);
  });

  it('does not query worktrees or expose empty-path explorer actions', async () => {
    const { container } = render(<DirSwitcher className="" sessionId={undefined} workingDir="" />, {
      wrapper: IntlTestWrapper,
    });

    const trigger = container.querySelector('button');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);

    await waitFor(() => expect(window.electron.listRecentDirs).toHaveBeenCalledOnce());
    expect(await screen.findByText('Writer')).toBeVisible();
    expect(request).toHaveBeenCalledWith('_codebuddy/agents/workspaces', {});
    expect(window.electron.listGitWorktreeDirs).not.toHaveBeenCalled();
    expect(window.electron.openDirectoryInExplorer).not.toHaveBeenCalled();
  });

  it('opens the directory menu from a plain click instead of showing only a tooltip', async () => {
    const { container } = render(<DirSwitcher className="" sessionId={undefined} workingDir="" />, {
      wrapper: IntlTestWrapper,
    });

    const trigger = container.querySelector('button');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);

    await waitFor(() => expect(window.electron.listRecentDirs).toHaveBeenCalledOnce());
  });

  it('keeps older workspaces in a bounded vertical list and the chooser outside it', async () => {
    window.electron.listRecentDirs = vi.fn().mockResolvedValue(Array.from({ length: 12 }, (_, i) => `D:\\Workspace${i + 1}`));
    render(<DirSwitcher className="" sessionId={undefined} workingDir="" />, { wrapper: IntlTestWrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Select workspace' }));
    expect(await screen.findByText('Workspace4')).toBeVisible();
    expect(screen.getByText('Workspace12')).toBeInTheDocument();
    const list = screen.getByText('Workspace12').closest('.overflow-y-auto');
    expect(list).toHaveClass('max-h-44', 'overflow-x-hidden');
    const choose = screen.getByRole('menuitem', { name: 'Choose workspace…' });
    expect(choose).toBeVisible();
    expect(choose.closest('.overflow-y-auto')).toBeNull();
  });

  it('does not render an empty section separator before the only workspace action', async () => {
    window.electron.listRecentDirs = vi.fn().mockResolvedValue([]);
    render(<DirSwitcher className="" sessionId={undefined} workingDir="" />, { wrapper: IntlTestWrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Select workspace' }));
    expect(await screen.findByRole('menuitem', { name: 'Choose workspace…' })).toBeVisible();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});
