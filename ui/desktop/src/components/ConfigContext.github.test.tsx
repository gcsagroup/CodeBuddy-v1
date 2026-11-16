import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConfigProvider, useConfig } from './ConfigContext';
import { getConfiguredExtensions } from '../acp/extensions';
import { connectGitHubMcp } from '../acp/diagnostics';
vi.mock('../acp/config', () => ({
  acpReadAllConfig: vi.fn(async () => ({ config: {}, blockedMutationKeys: [] })),
}));
vi.mock('../acp/providers', () => ({ acpListProviderDetails: vi.fn(async () => []) }));
vi.mock('../acp/extensions', () => ({
  getConfiguredExtensions: vi.fn(),
  addConfigExtension: vi.fn(),
  removeConfigExtension: vi.fn(),
  setConfigExtensionEnabled: vi.fn(),
}));
vi.mock('../acp/diagnostics', () => ({ connectGitHubMcp: vi.fn() }));
vi.mock('./settings/extensions', () => ({
  pruneDeprecatedBundledExtensions: vi.fn(async (entries) => entries),
  syncBundledExtensions: vi.fn(),
}));
vi.mock('./settings/extensions/managed-capabilities', () => ({
  enableManagedCapabilities: vi.fn(),
}));
vi.mock('./settings/extensions/bundled-extensions', () => ({ consolidateGitExtensions: vi.fn() }));
const github = {
  name: 'github_official',
  configKey: 'github_official',
  type: 'streamable_http' as const,
  uri: 'https://api.githubcopilot.com/mcp/',
  enabled: true,
};
function Ready() {
  const { extensionsList } = useConfig();
  return <div>{extensionsList.length ? 'ready' : 'loading'}</div>;
}
function mount() {
  return render(
    <ConfigProvider>
      <Ready />
    </ConfigProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getConfiguredExtensions)
    .mockResolvedValue({ extensions: [github], warnings: [] })
    .mockResolvedValueOnce({ extensions: [], warnings: [] });
  window.electron.githubCliStatus = vi
    .fn()
    .mockResolvedValue({ state: 'connected', login: 'octocat' });
  vi.mocked(connectGitHubMcp).mockResolvedValue({ success: true });
});
it('connects an existing signed-in account for a fresh install without opening Settings', async () => {
  mount();
  await screen.findByText('ready');
  await waitFor(() => expect(connectGitHubMcp).toHaveBeenCalledExactlyOnceWith('octocat'));
});
it('defers the fresh-install account probe until network consent and runs it only once', async () => {
  let allowed = false;
  vi.spyOn(window.electron, 'getSetting').mockImplementation(async () => allowed);
  let granted: (() => void) | undefined;
  vi.spyOn(window.electron, 'on').mockImplementation((channel, callback) => {
    if (channel === 'network-access-granted') granted = () => callback({} as Electron.IpcRendererEvent);
  });
  mount();
  await screen.findByText('ready');
  expect(window.electron.githubCliStatus).not.toHaveBeenCalled();
  allowed = true;
  await act(async () => { granted!(); granted!(); });
  expect(window.electron.githubCliStatus).toHaveBeenCalledOnce();
  expect(connectGitHubMcp).toHaveBeenCalledExactlyOnceWith('octocat');
});

it('keeps first launch usable without a GitHub login', async () => {
  window.electron.githubCliStatus = vi.fn().mockResolvedValue({ state: 'disconnected' });
  mount();
  await screen.findByText('ready');
  await act(async () => undefined);
  expect(connectGitHubMcp).not.toHaveBeenCalled();
});
it.each([false, true])(
  'preserves an existing enabled=%s connection without reading its account',
  async (enabled) => {
    vi.mocked(getConfiguredExtensions)
      .mockReset()
      .mockResolvedValue({ extensions: [{ ...github, enabled }], warnings: [] });
    mount();
    await screen.findByText('ready');
    expect(window.electron.githubCliStatus).not.toHaveBeenCalled();
    expect(connectGitHubMcp).not.toHaveBeenCalled();
  }
);
it('does not block application readiness on a failed automatic connection', async () => {
  vi.mocked(connectGitHubMcp).mockRejectedValue(new Error('offline'));
  mount();
  await screen.findByText('ready');
  await waitFor(() => expect(connectGitHubMcp).toHaveBeenCalledOnce());
});
