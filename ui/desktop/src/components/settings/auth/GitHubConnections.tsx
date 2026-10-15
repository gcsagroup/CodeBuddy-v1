import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { getConfiguredExtensions, testConfigExtension } from '../../../acp/extensions';
import { GITHUB_VERIFICATION_URI } from '../../../acp/githubAuth';
import type { GitHubCliChallenge, GitHubCliStatus } from '../../../github/githubCliTypes';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { ConfirmationModal } from '../../ui/ConfirmationModal';

const messages = defineMessages({
  restartRequired: {
    id: 'githubConnections.restartRequired',
    defaultMessage:
      'The desktop app is still running an older version. Restart CodeBuddy to enable GitHub sign-in.',
  },
  restart: { id: 'githubConnections.restart', defaultMessage: 'Restart CodeBuddy' },
  check: { id: 'githubConnections.check', defaultMessage: 'Check connection' },
  checking: { id: 'githubConnections.checking', defaultMessage: 'Checking connections…' },
  connected: { id: 'githubConnections.connected', defaultMessage: 'GitHub account: {login}' },
  disconnected: {
    id: 'githubConnections.disconnected',
    defaultMessage: 'No GitHub CLI account is signed in.',
  },
  unavailable: {
    id: 'githubConnections.unavailable',
    defaultMessage: 'Install GitHub CLI to sign in with your browser.',
  },
  failed: {
    id: 'githubConnections.failed',
    defaultMessage: 'Connection check failed. Check your network or sign in again.',
  },
  login: { id: 'githubConnections.login', defaultMessage: 'Connect GitHub' },
  logout: { id: 'githubConnections.logout', defaultMessage: 'Sign out' },
  logoutTitle: { id: 'githubConnections.logoutTitle', defaultMessage: 'Sign out of GitHub?' },
  logoutMessage: {
    id: 'githubConnections.logoutMessage',
    defaultMessage:
      'Sign out {login} from the local GitHub CLI. Other tools using this CLI account will also be affected. Separately configured GitHub MCP credentials will remain unchanged.',
  },
  logoutFailed: {
    id: 'githubConnections.logoutFailed',
    defaultMessage:
      'Sign-out failed. Refresh the connection and try again. Accounts provided by environment variables must be removed from the launch environment.',
  },
  dismiss: { id: 'githubConnections.dismiss', defaultMessage: 'Cancel' },
  install: { id: 'githubConnections.install', defaultMessage: 'Get GitHub CLI' },
  instructions: {
    id: 'githubConnections.instructions',
    defaultMessage:
      'Copy this one-time code and authorize GitHub CLI in your browser. The account is shared with your local GitHub CLI.',
  },
  copy: { id: 'githubConnections.copy', defaultMessage: 'Copy code' },
  open: { id: 'githubConnections.open', defaultMessage: 'Open GitHub' },
  cancel: { id: 'githubConnections.cancel', defaultMessage: 'Cancel sign-in' },
  waiting: {
    id: 'githubConnections.waiting',
    defaultMessage: 'Waiting for browser authorization…',
  },
  loginFailed: {
    id: 'githubConnections.loginFailed',
    defaultMessage: 'Sign-in was not completed or expired. Check your connection and try again.',
  },
  mcpConnected: {
    id: 'githubConnections.mcpConnected',
    defaultMessage: 'GitHub MCP: connection verified',
  },
  mcpFailed: {
    id: 'githubConnections.mcpFailed',
    defaultMessage: 'GitHub MCP: connection failed. Check its credentials in Toolbox.',
  },
  mcpOff: { id: 'githubConnections.mcpOff', defaultMessage: 'GitHub MCP: disabled' },
  mcpMissing: { id: 'githubConnections.mcpMissing', defaultMessage: 'GitHub MCP: not configured' },
});
type McpState = 'connected' | 'failed' | 'off' | 'missing';
function hasLoginBridge(): boolean {
  return [
    'githubCliStatus',
    'githubCliLoginStart',
    'githubCliLoginPoll',
    'githubCliLoginCancel',
  ].every(
    (method) => typeof window.electron[method as keyof typeof window.electron] === 'function'
  );
}
function isMissingLoginHandler(error: unknown): boolean {
  return (
    error instanceof Error &&
    /No handler registered for ['"]github-cli-(?:status|login-start|login-poll|login-cancel|logout)['"]/.test(
      error.message
    )
  );
}

export default function GitHubConnections({ allowLogin }: { allowLogin: boolean }) {
  const intl = useIntl();
  const [status, setStatus] = useState<GitHubCliStatus | null>(null);
  const [mcp, setMcp] = useState<McpState | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutAccount, setLogoutAccount] = useState<string | null>(null);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const logoutPending = useRef(false);
  const [challenge, setChallenge] = useState<GitHubCliChallenge | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const flow = useRef<string | null>(null);
  const generation = useRef(0);
  const check = async () => {
    if (logoutPending.current) return;
    const current = ++generation.current;
    setChecking(true);
    const apply = () => mounted.current && generation.current === current;
    await Promise.all([
      (async () => {
        let next: GitHubCliStatus;
        try {
          next = hasLoginBridge()
            ? await window.electron.githubCliStatus()
            : { state: 'restart_required' };
        } catch (error) {
          next = { state: isMissingLoginHandler(error) ? 'restart_required' : 'check_failed' };
        }
        if (apply()) setStatus(next);
      })(),
      (async () => {
        let next: McpState;
        try {
          const { extensions } = await getConfiguredExtensions();
          const github = extensions.find(
            (entry) => entry.configKey === 'github_official' || entry.name === 'github_official'
          );
          next = !github
            ? 'missing'
            : !github.enabled
              ? 'off'
              : (await testConfigExtension(github)).success
                ? 'connected'
                : 'failed';
        } catch {
          next = 'failed';
        }
        if (apply()) setMcp(next);
      })(),
    ]);
    if (apply()) setChecking(false);
  };
  useEffect(() => {
    mounted.current = true;
    void check();
    return () => {
      mounted.current = false;
      if (flow.current)
        void window.electron.githubCliLoginCancel(flow.current).catch(() => undefined);
      flow.current = null;
    };
    // Connections are checked on entry and on explicit refresh.
  }, []);
  useEffect(() => {
    if (!challenge) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (Date.now() >= challenge.expiresAt) throw new Error('Expired');
        const result = await window.electron.githubCliLoginPoll(challenge.flowId);
        if (disposed || flow.current !== challenge.flowId) return;
        if (result.state === 'pending') {
          timer = setTimeout(() => void poll(), 2000);
          return;
        }
        flow.current = null;
        setChallenge(null);
        if (result.state !== 'connected') {
          setFailed(true);
          return;
        }
        setStatus({ state: 'connected', login: result.login });
      } catch {
        if (!disposed && flow.current === challenge.flowId) {
          void window.electron.githubCliLoginCancel(challenge.flowId).catch(() => undefined);
          flow.current = null;
          setChallenge(null);
          setFailed(true);
        }
      }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [challenge]);
  const start = async () => {
    if (!hasLoginBridge()) {
      setStatus({ state: 'restart_required' });
      setFailed(false);
      return;
    }
    setStarting(true);
    setFailed(false);
    try {
      const next = await window.electron.githubCliLoginStart();
      if (!mounted.current) {
        await window.electron.githubCliLoginCancel(next.flowId);
        return;
      }
      flow.current = next.flowId;
      setChallenge(next);
      // The official CLI owns the OAuth flow; only the fixed device page is opened here.
      await window.electron.openExternal(GITHUB_VERIFICATION_URI);
    } catch (error) {
      if (mounted.current) {
        if (isMissingLoginHandler(error)) {
          setStatus({ state: 'restart_required' });
          setFailed(false);
        } else setFailed(true);
      }
    } finally {
      if (mounted.current) setStarting(false);
    }
  };
  const cancel = async () => {
    const id = flow.current;
    flow.current = null;
    setChallenge(null);
    if (id)
      await window.electron.githubCliLoginCancel(id).catch(() => {
        if (mounted.current) setFailed(true);
      });
  };
  const logout = async () => {
    if (!logoutAccount || logoutPending.current) return;
    if (typeof window.electron.githubCliLogout !== 'function') {
      setStatus({ state: 'restart_required' });
      setLogoutAccount(null);
      return;
    }
    logoutPending.current = true;
    ++generation.current;
    setSigningOut(true);
    setLogoutFailed(false);
    try {
      const next = await window.electron.githubCliLogout(logoutAccount);
      if (mounted.current) setStatus(next);
    } catch (error) {
      if (mounted.current) {
        if (isMissingLoginHandler(error)) setStatus({ state: 'restart_required' });
        else setLogoutFailed(true);
      }
    } finally {
      logoutPending.current = false;
      if (mounted.current) {
        setSigningOut(false);
        setLogoutAccount(null);
      }
    }
  };
  return (
    <div className="space-y-3 py-3 text-sm">
      <div aria-live="polite">
        {status && (
          <p>
            {intl.formatMessage(
              status.state === 'restart_required'
                ? messages.restartRequired
                : status.state === 'connected'
                  ? messages.connected
                  : status.state === 'unavailable'
                    ? messages.unavailable
                    : status.state === 'disconnected'
                      ? messages.disconnected
                      : messages.failed,
              { login: status.login ?? '' }
            )}
          </p>
        )}
        {mcp && (
          <p className="mt-1 text-text-secondary">
            {intl.formatMessage(
              mcp === 'connected'
                ? messages.mcpConnected
                : mcp === 'off'
                  ? messages.mcpOff
                  : mcp === 'missing'
                    ? messages.mcpMissing
                    : messages.mcpFailed
            )}
          </p>
        )}
      </div>
      {challenge ? (
        <div className="space-y-2">
          <p>{intl.formatMessage(messages.instructions)}</p>
          <code className="block select-all font-mono text-lg">{challenge.userCode}</code>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(challenge.userCode).catch(() => setFailed(true))
              }
            >
              <Copy className="h-4 w-4" />
              {intl.formatMessage(messages.copy)}
            </Button>
            <Button
              size="sm"
              onClick={() => void window.electron.openExternal(GITHUB_VERIFICATION_URI)}
            >
              <ExternalLink className="h-4 w-4" />
              {intl.formatMessage(messages.open)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void cancel()}>
              {intl.formatMessage(messages.cancel)}
            </Button>
          </div>
          <p role="status">{intl.formatMessage(messages.waiting)}</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={checking || starting || signingOut}
            onClick={() => void check()}
          >
            <RefreshCw className="h-4 w-4" />
            {intl.formatMessage(checking ? messages.checking : messages.check)}
          </Button>
          {status?.state === 'connected' && status.login && (
            <Button
              size="sm"
              variant="outline"
              disabled={checking || starting || signingOut}
              onClick={() => {
                setLogoutFailed(false);
                setLogoutAccount(status.login!);
              }}
            >
              <LogOut className="h-4 w-4" />
              {intl.formatMessage(messages.logout)}
            </Button>
          )}
          {allowLogin &&
            status?.state !== 'connected' &&
            status?.state !== 'unavailable' &&
            status?.state !== 'restart_required' && (
              <Button
                size="sm"
                disabled={!status || checking || starting || signingOut}
                onClick={() => void start()}
              >
                {starting && <Loader2 className="h-4 w-4 animate-spin" />}
                {intl.formatMessage(messages.login)}
              </Button>
            )}
          {allowLogin && status?.state === 'unavailable' && (
            <Button
              size="sm"
              onClick={() => void window.electron.openExternal('https://cli.github.com/')}
            >
              {intl.formatMessage(messages.install)}
            </Button>
          )}
        </div>
      )}
      {failed && (
        <p role="alert" className="text-red-700 dark:text-red-300">
          {intl.formatMessage(messages.loginFailed)}
        </p>
      )}
      {logoutFailed && (
        <p role="alert" className="text-red-700 dark:text-red-300">
          {intl.formatMessage(messages.logoutFailed)}
        </p>
      )}
      <ConfirmationModal
        isOpen={logoutAccount !== null}
        title={intl.formatMessage(messages.logoutTitle)}
        message={intl.formatMessage(messages.logoutMessage, { login: logoutAccount ?? '' })}
        confirmLabel={intl.formatMessage(messages.logout)}
        cancelLabel={intl.formatMessage(messages.dismiss)}
        isSubmitting={signingOut}
        onConfirm={() => void logout()}
        onCancel={() => {
          if (!logoutPending.current) setLogoutAccount(null);
        }}
      />
    </div>
  );
}
