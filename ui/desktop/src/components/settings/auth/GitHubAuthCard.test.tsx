import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_VERIFICATION_URI,
  acpCancelGitHubAuth,
  acpDisconnectGitHubAuth,
  acpPollGitHubAuth,
  acpStartGitHubAuth,
  acpGitHubAuthStatus,
} from '../../../acp/githubAuth';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import GitHubAuthCard from './GitHubAuthCard';

vi.mock('./GitHubConnections', () => ({
  default: ({ allowLogin }: { allowLogin: boolean }) => (
    <div data-testid="connections">{allowLogin ? 'CLI login available' : 'Check connections'}</div>
  ),
}));

vi.mock('../../../acp/githubAuth', () => ({
  GITHUB_VERIFICATION_URI: 'https://github.com/login/device',
  acpGitHubAuthStatus: vi.fn(),
  acpStartGitHubAuth: vi.fn(),
  acpPollGitHubAuth: vi.fn(),
  acpCancelGitHubAuth: vi.fn(),
  acpDisconnectGitHubAuth: vi.fn(),
}));

const mockedStatus = vi.mocked(acpGitHubAuthStatus);
const mockedStart = vi.mocked(acpStartGitHubAuth);
const mockedPoll = vi.mocked(acpPollGitHubAuth);
const mockedCancel = vi.mocked(acpCancelGitHubAuth);
const mockedDisconnect = vi.mocked(acpDisconnectGitHubAuth);

const disconnectedStatus = {
  clientConfigured: true,
  secureStorageAvailable: true,
  state: 'disconnected' as const,
};

const challenge = {
  flowId: 'flow-1',
  userCode: 'ABCD-EFGH',
  verificationUri: GITHUB_VERIFICATION_URI,
  expiresAt: '2027-01-01T12:00:00Z',
  retryAfterSeconds: 5,
};

function renderCard() {
  return render(<GitHubAuthCard />, { wrapper: IntlTestWrapper });
}

describe('GitHubAuthCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStatus.mockResolvedValue(disconnectedStatus);
    mockedStart.mockResolvedValue(challenge);
    mockedPoll.mockResolvedValue({ state: 'pending', retryAfterSeconds: 5 });
    mockedCancel.mockResolvedValue(undefined);
    mockedDisconnect.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers the CLI connection flow when this build has no OAuth client', async () => {
    mockedStatus.mockResolvedValue({
      clientConfigured: false,
      secureStorageAvailable: true,
      state: 'disconnected',
    });
    renderCard();
    expect(await screen.findByTestId('connections')).toHaveTextContent('CLI login available');
    expect(
      screen.queryByText('GitHub login is not configured in this build.')
    ).not.toBeInTheDocument();
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it('shows and copies the device code while opening only the fixed GitHub URL', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const openExternal = vi.fn().mockResolvedValue(undefined);
    window.electron.openExternal = openExternal;
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Sign in to GitHub' }));

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: 'Open GitHub' }));
    expect(openExternal).toHaveBeenCalledWith(GITHUB_VERIFICATION_URI);
  });

  it('polls using only the retry intervals returned by the backend and stops on success', async () => {
    vi.useFakeTimers();
    mockedPoll
      .mockResolvedValueOnce({ state: 'pending', retryAfterSeconds: 7 })
      .mockResolvedValueOnce({
        state: 'connected',
        accountLogin: 'octocat',
        accountId: 583231,
        accessTokenExpiresAt: '2027-01-01T12:00:00Z',
      });
    renderCard();
    await act(async () => undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }));
    await act(async () => undefined);
    expect(mockedPoll).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(mockedPoll).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mockedPoll).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(6_999));
    expect(mockedPoll).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mockedPoll).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Connected as octocat')).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mockedPoll).toHaveBeenCalledTimes(2);
  });

  it('counts down the device-code lifetime and expires the local flow', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
    mockedStart.mockResolvedValue({
      ...challenge,
      expiresAt: '2027-01-01T12:02:00Z',
    });
    renderCard();
    await act(async () => undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }));
    await act(async () => undefined);
    expect(screen.getByText('Code expires in 2:00')).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText('Code expires in 1:00')).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(
      screen.getByText('The saved GitHub authorization has expired. Sign in again to continue.')
    ).toBeInTheDocument();
    expect(mockedCancel).toHaveBeenCalledWith('flow-1');
  });

  it('cancels an active device flow and prevents later polls', async () => {
    vi.useFakeTimers();
    renderCard();
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }));
    await act(async () => undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => undefined);

    expect(mockedCancel).toHaveBeenCalledWith('flow-1');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mockedPoll).not.toHaveBeenCalled();
  });

  it('cancels an active device flow when unmounted', async () => {
    const view = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to GitHub' }));
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();

    view.unmount();

    await waitFor(() => expect(mockedCancel).toHaveBeenCalledWith('flow-1'));
  });

  it('cancels a device flow that starts after the card has unmounted', async () => {
    let resolveStart: (value: typeof challenge) => void = () => undefined;
    mockedStart.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        })
    );
    const view = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to GitHub' }));

    view.unmount();
    await act(async () => resolveStart(challenge));

    expect(mockedCancel).toHaveBeenCalledWith('flow-1');
    expect(mockedPoll).not.toHaveBeenCalled();
  });

  it('requires confirmation before disconnecting the GitHub account', async () => {
    const user = userEvent.setup();
    mockedStatus
      .mockResolvedValueOnce({
        clientConfigured: true,
        secureStorageAvailable: true,
        state: 'connected',
        accountLogin: 'octocat',
        accountId: 583231,
      })
      .mockResolvedValueOnce(disconnectedStatus);
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Disconnect GitHub' }));
    expect(screen.getByText('Disconnect GitHub account?')).toBeInTheDocument();
    expect(mockedDisconnect).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mockedDisconnect).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Sign in to GitHub' })).toBeEnabled();
  });

  it('never renders token-shaped response fields or arbitrary verification URLs', async () => {
    mockedStart.mockResolvedValue({
      ...challenge,
      verificationUri: 'https://evil.example/device',
      accessToken: 'gho_super_secret',
    } as typeof challenge);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to GitHub' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub returned an unexpected verification address.'
    );
    expect(screen.queryByText('gho_super_secret')).not.toBeInTheDocument();
    expect(screen.queryByText('https://evil.example/device')).not.toBeInTheDocument();
  });
});
