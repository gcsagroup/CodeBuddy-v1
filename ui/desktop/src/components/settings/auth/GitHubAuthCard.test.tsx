import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from '../../../acp/acpConnection';
import { getConfiguredExtensions } from '../../../acp/extensions';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import GitHubAuthCard from './GitHubAuthCard';

vi.mock('../../../acp/acpConnection', () => ({ getAcpClient: vi.fn() }));
vi.mock('../../../acp/extensions', () => ({
  getConfiguredExtensions: vi.fn(),
  testConfigExtension: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAcpClient).mockRejectedValue(new Error('Retired Rust auth is absent'));
  vi.mocked(getConfiguredExtensions).mockResolvedValue({ extensions: [], warnings: [] });
  window.electron.githubCliStatus = vi.fn().mockResolvedValue({ state: 'disconnected' });
  window.electron.githubCliLoginStart = vi.fn().mockResolvedValue({
    flowId: 'cli-flow',
    userCode: 'ABCD-EFGH',
    expiresAt: Date.now() + 60_000,
  });
  window.electron.githubCliLoginPoll = vi.fn();
  window.electron.githubCliLoginCancel = vi.fn().mockResolvedValue(undefined);
  window.electron.openExternal = vi.fn().mockResolvedValue(undefined);
});

describe('GitHub account card on the Harness desktop', () => {
  it('loads and refreshes the real connection component without a retired ACP auth request', async () => {
    vi.mocked(window.electron.githubCliStatus).mockResolvedValue({ state: 'check_failed' });
    render(<GitHubAuthCard />, { wrapper: IntlTestWrapper });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check connection' })).toBeEnabled()
    );
    vi.mocked(window.electron.githubCliStatus).mockResolvedValue({
      state: 'connected',
      login: 'octocat',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(await screen.findByText('GitHub account: octocat')).toBeVisible();
    expect(getAcpClient).not.toHaveBeenCalled();
    expect(screen.queryByText('Unable to check the GitHub connection.')).not.toBeInTheDocument();
  });

  it('starts and cancels the existing CLI device flow from the account card', async () => {
    render(<GitHubAuthCard />, { wrapper: IntlTestWrapper });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText('ABCD-EFGH')).toBeVisible();
    expect(window.electron.openExternal).toHaveBeenCalledWith('https://github.com/login/device');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await waitFor(() =>
      expect(window.electron.githubCliLoginCancel).toHaveBeenCalledWith('cli-flow')
    );
    expect(getAcpClient).not.toHaveBeenCalled();
  });
});
