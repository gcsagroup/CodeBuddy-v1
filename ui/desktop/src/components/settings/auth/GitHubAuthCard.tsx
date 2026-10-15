import GitHubConnections from './GitHubConnections';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, Github, Loader2, LogIn, Unplug } from 'lucide-react';
import {
  GITHUB_VERIFICATION_URI,
  acpCancelGitHubAuth,
  acpDisconnectGitHubAuth,
  acpGitHubAuthStatus,
  acpPollGitHubAuth,
  acpStartGitHubAuth,
  type GitHubAuthStartResponse_unstable,
  type GitHubAuthStatusResponse_unstable,
} from '../../../acp/githubAuth';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { ConfirmationModal } from '../../ui/ConfirmationModal';

const i18n = defineMessages({
  title: { id: 'githubAuth.title', defaultMessage: 'GitHub' },
  description: {
    id: 'githubAuth.description',
    defaultMessage: 'Connect GitHub for repository and pull request actions.',
  },
  loading: { id: 'githubAuth.loading', defaultMessage: 'Checking GitHub connection...' },
  signIn: { id: 'githubAuth.signIn', defaultMessage: 'Sign in to GitHub' },
  notConfigured: {
    id: 'githubAuth.notConfigured',
    defaultMessage: 'GitHub login is not configured in this build.',
  },
  storageUnavailable: {
    id: 'githubAuth.storageUnavailable',
    defaultMessage: 'Secure credential storage is unavailable on this device.',
  },
  expired: {
    id: 'githubAuth.expired',
    defaultMessage: 'The saved GitHub authorization has expired. Sign in again to continue.',
  },
  connectedAs: { id: 'githubAuth.connectedAs', defaultMessage: 'Connected as {login}' },
  connected: { id: 'githubAuth.connected', defaultMessage: 'GitHub is connected.' },
  expires: { id: 'githubAuth.expires', defaultMessage: 'Authorization expires {date}' },
  disconnect: { id: 'githubAuth.disconnect', defaultMessage: 'Disconnect GitHub' },
  disconnectTitle: {
    id: 'githubAuth.disconnectTitle',
    defaultMessage: 'Disconnect GitHub account?',
  },
  disconnectMessage: {
    id: 'githubAuth.disconnectMessage',
    defaultMessage: 'CodeBuddy will remove the GitHub authorization from secure storage.',
  },
  disconnectConfirm: { id: 'githubAuth.disconnectConfirm', defaultMessage: 'Disconnect' },
  cancel: { id: 'githubAuth.cancel', defaultMessage: 'Cancel' },
  deviceInstructions: {
    id: 'githubAuth.deviceInstructions',
    defaultMessage: 'Copy this one-time code, then open GitHub to authorize CodeBuddy.',
  },
  copyCode: { id: 'githubAuth.copyCode', defaultMessage: 'Copy code' },
  openGitHub: { id: 'githubAuth.openGitHub', defaultMessage: 'Open GitHub' },
  waiting: { id: 'githubAuth.waiting', defaultMessage: 'Waiting for GitHub authorization...' },
  countdown: { id: 'githubAuth.countdown', defaultMessage: 'Code expires in {time}' },
  unexpectedAddress: {
    id: 'githubAuth.unexpectedAddress',
    defaultMessage: 'GitHub returned an unexpected verification address.',
  },
  failedToLoad: {
    id: 'githubAuth.failedToLoad',
    defaultMessage: 'Unable to check the GitHub connection.',
  },
  failedToStart: {
    id: 'githubAuth.failedToStart',
    defaultMessage: 'Unable to start GitHub sign-in.',
  },
  failedToPoll: {
    id: 'githubAuth.failedToPoll',
    defaultMessage: 'GitHub sign-in could not be completed.',
  },
  failedToDisconnect: {
    id: 'githubAuth.failedToDisconnect',
    defaultMessage: 'Unable to disconnect GitHub.',
  },
});

function validRetryDelay(seconds: number | null | undefined): seconds is number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0;
}

export default function GitHubAuthCard() {
  const intl = useIntl();
  const [status, setStatus] = useState<GitHubAuthStatusResponse_unstable | null>(null);
  const [challenge, setChallenge] = useState<GitHubAuthStartResponse_unstable | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const activeFlowRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const pollRef = useRef<(flowId: string) => Promise<void>>(async () => undefined);

  const clearPollTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const nextStatus = await acpGitHubAuthStatus();
      if (mountedRef.current) {
        setStatus(nextStatus);
        setError(null);
      }
    } catch {
      if (mountedRef.current) {
        setError(intl.formatMessage(i18n.failedToLoad));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [intl]);

  const schedulePoll = useCallback(
    (flowId: string, retryAfterSeconds: number) => {
      clearPollTimer();
      timerRef.current = setTimeout(() => void pollRef.current(flowId), retryAfterSeconds * 1000);
    },
    [clearPollTimer]
  );

  pollRef.current = async (flowId: string) => {
    if (!mountedRef.current || activeFlowRef.current !== flowId) {
      return;
    }
    try {
      const result = await acpPollGitHubAuth(flowId);
      if (!mountedRef.current || activeFlowRef.current !== flowId) {
        return;
      }
      if (result.state === 'pending') {
        if (!validRetryDelay(result.retryAfterSeconds)) {
          throw new Error('invalid retry interval');
        }
        schedulePoll(flowId, result.retryAfterSeconds);
        return;
      }

      activeFlowRef.current = null;
      clearPollTimer();
      setChallenge(null);
      setError(null);
      setStatus({
        clientConfigured: true,
        secureStorageAvailable: true,
        state: 'connected',
        accountLogin: result.accountLogin,
        accountId: result.accountId,
        accessTokenExpiresAt: result.accessTokenExpiresAt,
      });
    } catch {
      if (mountedRef.current && activeFlowRef.current === flowId) {
        activeFlowRef.current = null;
        clearPollTimer();
        setChallenge(null);
        setError(intl.formatMessage(i18n.failedToPoll));
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void loadStatus();
    return () => {
      mountedRef.current = false;
      clearPollTimer();
      const flowId = activeFlowRef.current;
      activeFlowRef.current = null;
      if (flowId) {
        void acpCancelGitHubAuth(flowId).catch(() => undefined);
      }
    };
  }, [clearPollTimer, loadStatus]);

  useEffect(() => {
    if (!challenge) {
      setRemainingSeconds(null);
      return;
    }

    const expiresAt = Date.parse(challenge.expiresAt);
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setRemainingSeconds(remaining);
      if (remaining > 0) {
        return;
      }

      const flowId = activeFlowRef.current;
      activeFlowRef.current = null;
      clearPollTimer();
      setChallenge(null);
      setStatus((current) =>
        current
          ? { ...current, state: 'expired' }
          : {
              clientConfigured: true,
              secureStorageAvailable: true,
              state: 'expired',
            }
      );
      if (flowId) {
        void acpCancelGitHubAuth(flowId).catch(() => undefined);
      }
    };

    tick();
    const countdownTimer = setInterval(tick, 1000);
    return () => clearInterval(countdownTimer);
  }, [challenge, clearPollTimer]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const nextChallenge = await acpStartGitHubAuth();
      if (!mountedRef.current) {
        await acpCancelGitHubAuth(nextChallenge.flowId).catch(() => undefined);
        return;
      }
      if (nextChallenge.verificationUri !== GITHUB_VERIFICATION_URI) {
        await acpCancelGitHubAuth(nextChallenge.flowId).catch(() => undefined);
        if (mountedRef.current) {
          setError(intl.formatMessage(i18n.unexpectedAddress));
        }
        return;
      }
      if (!validRetryDelay(nextChallenge.retryAfterSeconds)) {
        await acpCancelGitHubAuth(nextChallenge.flowId).catch(() => undefined);
        if (mountedRef.current) {
          setError(intl.formatMessage(i18n.failedToStart));
        }
        return;
      }
      const expiresAt = Date.parse(nextChallenge.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await acpCancelGitHubAuth(nextChallenge.flowId).catch(() => undefined);
        if (mountedRef.current) {
          setError(intl.formatMessage(i18n.failedToStart));
        }
        return;
      }
      if (!mountedRef.current) {
        await acpCancelGitHubAuth(nextChallenge.flowId).catch(() => undefined);
        return;
      }
      activeFlowRef.current = nextChallenge.flowId;
      setChallenge(nextChallenge);
      schedulePoll(nextChallenge.flowId, nextChallenge.retryAfterSeconds);
    } catch {
      if (mountedRef.current) {
        setError(intl.formatMessage(i18n.failedToStart));
      }
    } finally {
      if (mountedRef.current) {
        setStarting(false);
      }
    }
  };

  const cancel = async () => {
    const flowId = activeFlowRef.current;
    activeFlowRef.current = null;
    clearPollTimer();
    setChallenge(null);
    if (flowId) {
      await acpCancelGitHubAuth(flowId).catch(() => undefined);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await acpDisconnectGitHubAuth();
      setShowDisconnect(false);
      await loadStatus();
    } catch {
      setError(intl.formatMessage(i18n.failedToDisconnect));
    } finally {
      setDisconnecting(false);
    }
  };

  const canStart = Boolean(status?.clientConfigured && status.secureStorageAvailable);
  const connected = status?.state === 'connected';
  const connectedLabel = status?.accountLogin
    ? intl.formatMessage(i18n.connectedAs, { login: status.accountLogin })
    : intl.formatMessage(i18n.connected);
  const countdownLabel =
    remainingSeconds === null
      ? null
      : intl.formatMessage(i18n.countdown, {
          time: `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`,
        });

  return (
    <>
      <Card className="pb-2">
        <CardHeader className="pb-0">
          <CardTitle className="flex items-center gap-2">
            <Github className="h-4 w-4" />
            {intl.formatMessage(i18n.title)}
          </CardTitle>
          <CardDescription>{intl.formatMessage(i18n.description)}</CardDescription>
        </CardHeader>
        <CardContent className="px-4 py-2">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {intl.formatMessage(i18n.loading)}
            </div>
          ) : connected ? (
            <div className="flex flex-col gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
                  <span className="break-all">{connectedLabel}</span>
                </div>
                {status.accessTokenExpiresAt && (
                  <p className="mt-1 text-xs text-text-secondary">
                    {intl.formatMessage(i18n.expires, {
                      date: intl.formatDate(new Date(status.accessTokenExpiresAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }),
                    })}
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowDisconnect(true)}>
                <Unplug className="h-4 w-4" />
                {intl.formatMessage(i18n.disconnect)}
              </Button>
            </div>
          ) : challenge ? (
            <div className="space-y-3 py-2">
              <p className="text-sm text-text-secondary">
                {intl.formatMessage(i18n.deviceInstructions)}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="select-all rounded-md border border-border-primary bg-background-secondary px-3 py-2 text-center font-mono text-lg font-semibold tracking-wider text-text-primary">
                  {challenge.userCode}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(challenge.userCode)}
                >
                  <Copy className="h-4 w-4" />
                  {intl.formatMessage(i18n.copyCode)}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void window.electron.openExternal(GITHUB_VERIFICATION_URI)}
                >
                  <ExternalLink className="h-4 w-4" />
                  {intl.formatMessage(i18n.openGitHub)}
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className="flex items-center gap-2 text-xs text-text-secondary"
                  aria-live="polite"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {intl.formatMessage(i18n.waiting)}
                </span>
                {countdownLabel && (
                  <span className="text-xs tabular-nums text-text-secondary" aria-live="polite">
                    {countdownLabel}
                  </span>
                )}
                <Button variant="ghost" size="sm" onClick={() => void cancel()}>
                  {intl.formatMessage(i18n.cancel)}
                </Button>
              </div>
            </div>
          ) : !status?.clientConfigured ? null : (
            <div className="flex flex-col gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-text-secondary">
                {!status?.clientConfigured
                  ? intl.formatMessage(i18n.notConfigured)
                  : !status.secureStorageAvailable
                    ? intl.formatMessage(i18n.storageUnavailable)
                    : status.state === 'expired'
                      ? intl.formatMessage(i18n.expired)
                      : intl.formatMessage(i18n.description)}
              </p>
              <Button size="sm" disabled={!canStart || starting} onClick={() => void start()}>
                {starting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                {intl.formatMessage(i18n.signIn)}
              </Button>
            </div>
          )}
          {!loading && <GitHubConnections allowLogin={!status?.clientConfigured} />}
          {error && (
            <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      <ConfirmationModal
        isOpen={showDisconnect}
        title={intl.formatMessage(i18n.disconnectTitle)}
        message={intl.formatMessage(i18n.disconnectMessage)}
        onConfirm={() => void disconnect()}
        onCancel={() => setShowDisconnect(false)}
        confirmLabel={intl.formatMessage(i18n.disconnectConfirm)}
        cancelLabel={intl.formatMessage(i18n.cancel)}
        confirmVariant="destructive"
        isSubmitting={disconnecting}
      />
    </>
  );
}
