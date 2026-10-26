import { IntlProvider } from 'react-intl';
import { loadMessages } from '../../../i18n';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfiguredExtensions, testConfigExtension } from '../../../acp/extensions';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import GitHubConnections from './GitHubConnections';
import { connectGitHubMcp } from '../../../acp/diagnostics';
vi.mock('../../../acp/diagnostics', () => ({ connectGitHubMcp: vi.fn() }));
vi.mock('../../../acp/extensions', () => ({
  getConfiguredExtensions: vi.fn(),
  testConfigExtension: vi.fn(),
}));
function renderConnections() {
  return render(<GitHubConnections allowLogin />, { wrapper: IntlTestWrapper });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(connectGitHubMcp).mockResolvedValue({ success: true });
  window.electron.githubCliStatus = vi.fn().mockResolvedValue({ state: 'disconnected' });
  window.electron.githubCliLogout = vi.fn().mockResolvedValue({ state: 'disconnected' });
  window.electron.githubCliLoginStart = vi.fn().mockResolvedValue({
    flowId: 'test-flow',
    userCode: 'ABCD-EFGH',
    expiresAt: Date.now() + 60000,
  });
  window.electron.githubCliLoginPoll = vi.fn().mockResolvedValue({ state: 'pending' });
  window.electron.githubCliLoginCancel = vi.fn().mockResolvedValue(undefined);
  window.electron.openExternal = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getConfiguredExtensions).mockResolvedValue({
    extensions: [
      {
        name: 'github_official',
        configKey: 'github_official',
        type: 'streamable_http',
        uri: 'https://api.githubcopilot.com/mcp/',
        description: '',
        enabled: true,
      },
    ],
    warnings: [],
  });
  vi.mocked(testConfigExtension).mockResolvedValue({
    success: true,
    latencyMs: 1,
    tools: [],
    resourceCount: 0,
    supportsResources: false,
  });
});
afterEach(() => vi.useRealTimers());
describe('GitHubConnections', () => {
  it('automatically connects an enabled GitHub account and offers retry only after real failure', async () => {
    vi.mocked(window.electron.githubCliStatus).mockResolvedValue({
      state: 'connected',
      login: 'octocat',
    });
    vi.mocked(testConfigExtension).mockResolvedValue({
      success: false,
      latencyMs: 1,
      tools: [],
      resourceCount: 0,
      supportsResources: false,
    });
    vi.mocked(connectGitHubMcp)
      .mockResolvedValueOnce({ success: false, code: 'connection_failed' })
      .mockResolvedValueOnce({ success: true });
    renderConnections();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled()
    );
    expect(connectGitHubMcp).toHaveBeenCalledExactlyOnceWith('octocat');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub connection was not completed'
    );
    expect(screen.queryByText('GitHub: connected')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await screen.findByText('GitHub: connected');
    expect(connectGitHubMcp).toHaveBeenNthCalledWith(2, 'octocat');
  });
  it('confirms logout, prevents duplicate requests, refreshes the account and permits login again', async () => {
    vi.mocked(window.electron.githubCliStatus).mockResolvedValue({
      state: 'connected',
      login: 'octocat',
    });
    let finish!: (value: { state: 'disconnected' }) => void;
    vi.mocked(window.electron.githubCliLogout).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    renderConnections();
    await screen.findByText('GitHub account: octocat');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Other tools using this CLI account/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(window.electron.githubCliLogout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Processing...' })
    ).toBeDisabled();
    await act(async () => finish({ state: 'disconnected' }));
    expect(window.electron.githubCliLogout).toHaveBeenCalledExactlyOnceWith('octocat');
    expect(screen.getByText('Sign in to use GitHub.')).toBeInTheDocument();
    expect(screen.getByText('GitHub: connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
  });
  it('keeps the account visible when logout fails', async () => {
    vi.mocked(window.electron.githubCliStatus).mockResolvedValue({
      state: 'connected',
      login: 'octocat',
    });
    vi.mocked(window.electron.githubCliLogout).mockRejectedValue(new Error('failed'));
    renderConnections();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out failed');
    expect(screen.getByText('GitHub account: octocat')).toBeInTheDocument();
  });
  it('requests a restart when the running preload has no logout bridge', async () => {
    vi.mocked(window.electron.githubCliStatus).mockResolvedValue({
      state: 'connected',
      login: 'octocat',
    });
    Object.defineProperty(window.electron, 'githubCliLogout', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    renderConnections();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByText(/desktop app is still running an older version/)
    ).toBeInTheDocument();
  });
  it('requires a restart for an old preload instead of claiming a network failure', async () => {
    Object.defineProperty(window.electron, 'githubCliStatus', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    renderConnections();
    await screen.findByText(
      'The desktop app is still running an older version. Restart CodeBuddy to enable GitHub sign-in.'
    );
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Connection check failed. Check your network or sign in again.')
    ).not.toBeInTheDocument();
    expect(await screen.findByText('GitHub: connected')).toBeInTheDocument();
  });
  it('detects a new preload calling an old main process', async () => {
    vi.mocked(window.electron.githubCliStatus).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'github-cli-status': Error: No handler registered for 'github-cli-status'"
      )
    );
    renderConnections();
    expect(
      await screen.findByText(
        'The desktop app is still running an older version. Restart CodeBuddy to enable GitHub sign-in.'
      )
    ).toBeInTheDocument();
    expect(window.electron.githubCliLoginStart).not.toHaveBeenCalled();
  });

  it.each([
    ['zh-CN', '检查连接', '连接 GitHub', '连接检查失败，请检查网络或重新登录。', 'GitHub：已连接'],
    ['zh-TW', '檢查連線', '連線 GitHub', '連線檢查失敗，請檢查網路或重新登入。', 'GitHub：已連線'],
    [
      'en',
      'Check connection',
      'Connect GitHub',
      'Connection check failed. Check your network or sign in again.',
      'GitHub: connected',
    ],
  ])(
    'uses the real %s catalog for connection results and actions',
    async (locale, check, connect, error, mcp) => {
      vi.mocked(window.electron.githubCliStatus).mockResolvedValue({ state: 'check_failed' });
      const messages = await loadMessages(locale);
      const onError = vi.fn();
      render(
        <IntlProvider locale={locale} messages={messages} onError={onError}>
          <GitHubConnections allowLogin />
        </IntlProvider>
      );
      expect(await screen.findByText(error)).toBeInTheDocument();
      expect(await screen.findByText(mcp)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: check })).toBeEnabled();
      expect(screen.getByRole('button', { name: connect })).toBeEnabled();
      expect(onError).not.toHaveBeenCalled();
    }
  );

  it('recognizes existing MCP credentials while independently offering account login', async () => {
    renderConnections();
    expect(await screen.findByText('GitHub: connected')).toBeInTheDocument();
    expect(screen.getByText('Sign in to use GitHub.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
  });
  it('rechecks actual state and replaces a stale success with an error', async () => {
    const view = renderConnections();
    await screen.findByText('GitHub: connected');
    view.unmount();
    vi.mocked(testConfigExtension).mockRejectedValueOnce(new Error('network'));
    renderConnections();
    await waitFor(() => expect(screen.queryByText('Connecting…')).toBeNull());
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
    expect(screen.queryByText('GitHub: connected')).not.toBeInTheDocument();
  });
  it('opens the official page and cancels the active flow on unmount', async () => {
    const view = renderConnections();
    await screen.findByText('GitHub: connected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(window.electron.openExternal).toHaveBeenCalledWith('https://github.com/login/device');
    view.unmount();
    expect(window.electron.githubCliLoginCancel).toHaveBeenCalledWith('test-flow');
  });
  it('shows the verified login after the owned process finishes', async () => {
    vi.useFakeTimers();
    renderConnections();
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await act(async () => undefined);
    vi.mocked(window.electron.githubCliLoginPoll).mockResolvedValueOnce({
      state: 'connected',
      login: 'octocat',
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('GitHub account: octocat')).toBeInTheDocument();
    expect(screen.queryByText('ABCD-EFGH')).not.toBeInTheDocument();
    expect(connectGitHubMcp).toHaveBeenCalledExactlyOnceWith('octocat');
    expect(screen.getByText('GitHub: connected')).toBeInTheDocument();
  });
  it('offers installation only when the CLI is actually missing', async () => {
    vi.mocked(window.electron.githubCliStatus).mockResolvedValueOnce({ state: 'unavailable' });
    renderConnections();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Get GitHub CLI' })).toBeEnabled()
    );
    expect(window.electron.githubCliLoginStart).not.toHaveBeenCalled();
  });
  it('keeps account sign-in distinct from a failed final connection and offers a single retry', async () => {
    vi.useFakeTimers();
    vi.mocked(connectGitHubMcp).mockResolvedValue({ success: false, code: 'connection_failed' });
    renderConnections();
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await act(async () => undefined);
    vi.mocked(window.electron.githubCliLoginPoll).mockResolvedValueOnce({
      state: 'connected',
      login: 'octocat',
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(connectGitHubMcp).toHaveBeenCalledExactlyOnceWith('octocat');
    expect(screen.getByText('GitHub account: octocat')).toBeVisible();
    expect(screen.queryByText('GitHub: connected')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('GitHub connection was not completed');
    expect(screen.getAllByRole('button', { name: 'Connect GitHub' })).toHaveLength(1);
  });
});

describe('independent bounded connection checks', () => {
  it('allows account login while a slow MCP check is pending, then settles its spinner', async () => {
    vi.useFakeTimers();
    vi.mocked(testConfigExtension).mockImplementation(() => new Promise(() => undefined));
    renderConnections();
    await act(async () => undefined);
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(25_000));
    expect(screen.queryByText('Connecting…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
    expect(screen.getByText('Sign in to use GitHub.')).toBeVisible();
  });

  it('bounds a stalled account bridge and ignores its late success after a refresh', async () => {
    vi.useFakeTimers();
    let finish!: (value: { state: 'connected'; login: string }) => void;
    vi.mocked(window.electron.githubCliStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    renderConnections();
    await act(async () => vi.advanceTimersByTimeAsync(25_000));
    expect(
      screen.getByText('Connection check failed. Check your network or sign in again.')
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check connection' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    await act(async () => undefined);
    await act(async () => finish({ state: 'connected', login: 'stale' }));
    expect(screen.getByText('Sign in to use GitHub.')).toBeVisible();
    expect(screen.queryByText('GitHub account: stale')).not.toBeInTheDocument();
  });
});


it.each(['disabled', 'custom'])('does not automatically replace a %s existing connection', async (kind) => {
  vi.mocked(window.electron.githubCliStatus).mockResolvedValue({ state: 'connected', login: 'octocat' });
  vi.mocked(getConfiguredExtensions).mockResolvedValue({ extensions: [{ name: 'github_official', configKey: 'github_official', type: 'streamable_http', uri: kind === 'custom' ? 'https://example.com/mcp' : 'https://api.githubcopilot.com/mcp/', enabled: kind !== 'disabled' }], warnings: [] });
  vi.mocked(testConfigExtension).mockResolvedValue({ success: false, latencyMs: 1, tools: [], resourceCount: 0, supportsResources: false });
  renderConnections();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled());
  expect(connectGitHubMcp).not.toHaveBeenCalled();
});
