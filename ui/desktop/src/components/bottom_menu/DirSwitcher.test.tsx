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
});
