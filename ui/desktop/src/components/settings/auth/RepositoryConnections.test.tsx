import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { getConfiguredExtensions, setConfigExtensionEnabled } from '../../../acp/extensions';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import RepositoryConnections from './RepositoryConnections';
vi.mock('../../../acp/extensions', () => ({
  getConfiguredExtensions: vi.fn(),
  setConfigExtensionEnabled: vi.fn(),
}));
vi.mock('./GitHubConnections', () => ({ default: () => <div>GitHub: connected</div> }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getConfiguredExtensions).mockResolvedValue({
    warnings: [],
    extensions: [
      { type: 'platform', name: 'git', enabled: false },
      {
        type: 'stdio',
        name: 'local_git',
        configKey: 'local_git',
        cmd: 'node',
        args: [],
        enabled: true,
      },
      {
        type: 'streamable_http',
        name: 'github_official',
        configKey: 'github_official',
        uri: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
      },
    ],
  });
});
it('keeps local and remote controls independent and only changes the selected existing configuration', async () => {
  render(<RepositoryConnections />, { wrapper: IntlTestWrapper });
  await screen.findByText('Local Git is enabled.');
  expect(setConfigExtensionEnabled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Disable local Git' }));
  await waitFor(() =>
    expect(setConfigExtensionEnabled).toHaveBeenCalledExactlyOnceWith('local_git', false)
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Disable GitHub for new tasks' })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole('button', { name: 'Disable GitHub for new tasks' }));
  await waitFor(() =>
    expect(setConfigExtensionEnabled).toHaveBeenLastCalledWith('github_official', false)
  );
  expect(screen.getByText('GitHub: connected')).toBeVisible();
});
it('does not turn a local inspection failure into a GitHub failure or claim local readiness', async () => {
  vi.mocked(getConfiguredExtensions).mockRejectedValueOnce(new Error('fixture failure'));
  render(<RepositoryConnections />, { wrapper: IntlTestWrapper });
  await screen.findByText('Local Git status could not be checked.');
  expect(screen.getByText('GitHub: connected')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Disable local Git' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByText('Local Git is enabled.');
});
