import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { getConfiguredExtensions, testConfigExtension } from '../../../acp/extensions';
import { GITHUB_VERIFICATION_URI } from '../../../github/githubCliTypes';
import type { GitHubCliChallenge, GitHubCliStatus } from '../../../github/githubCliTypes';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { ConfirmationModal } from '../../ui/ConfirmationModal';
import { connectGitHubMcp } from '../../../acp/diagnostics';
import { selectNativeText } from '../../../utils/nativeLocalization';

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
// Bound display checks independently of a remote MCP server's tool execution timeout.
function connectionCheck<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection check timed out')), 25_000);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

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

export default function GitHubConnections({
  allowLogin,
  onConnected,
  onBusyChange,
}: {
  allowLogin: boolean;
  onConnected?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const intl = useIntl();
  const t = (en: string, cn: string, tw: string) => selectNativeText(intl.locale, en, cn, tw);
  const [connectingMcp, setConnectingMcp] = useState(false);
  const [mcpConnectError, setMcpConnectError] = useState<string | null>(null);
  const mcpConnectPending = useRef(false);
  const [status, setStatus] = useState<GitHubCliStatus | null>(null);
  const [mcp, setMcp] = useState<McpState | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingAccount, setCheckingAccount] = useState(false);
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
  useEffect(() => {
    onBusyChange?.(checking || starting || signingOut || connectingMcp || !!challenge);
    return () => onBusyChange?.(false);
  }, [checking, starting, signingOut, connectingMcp, challenge, onBusyChange]);
  const connectAccount = useCallback(
    async (login: string | undefined) => {
      if (mcpConnectPending.current || !login) return;
      mcpConnectPending.current = true;
      setConnectingMcp(true);
      setMcp(null);
      setMcpConnectError(null);
      // Invalidate an older check before its result can replace this action's receipt.
      ++generation.current;
      try {
        const result = await connectGitHubMcp(login);
        if (mounted.current) {
          if (result.success) {
            setMcp('connected');
            onConnected?.();
          } else {
            setMcp('failed');
            setMcpConnectError(result.code ?? 'connection_failed');
          }
        }
      } catch {
        if (mounted.current) {
          setMcp('failed');
          setMcpConnectError('connection_failed');
        }
      } finally {
        mcpConnectPending.current = false;
        if (mounted.current) {
          setConnectingMcp(false);
          setChecking(false);
          setCheckingAccount(false);
        }
      }
    },
    [onConnected]
  );
  const check = async () => {
    if (logoutPending.current || mcpConnectPending.current) return;
    const current = ++generation.current;
    setChecking(true);
    setCheckingAccount(true);
    const apply = () => mounted.current && generation.current === current;
    await Promise.all([
      (async () => {
        let next: GitHubCliStatus;
        try {
          next = hasLoginBridge()
            ? await connectionCheck(window.electron.githubCliStatus())
            : { state: 'restart_required' };
        } catch (error) {
          next = { state: isMissingLoginHandler(error) ? 'restart_required' : 'check_failed' };
        }
        if (apply()) {
          setStatus(next);
          setCheckingAccount(false);
        }
      })(),
      (async () => {
        let next: McpState;
        try {
          const { extensions } = await connectionCheck(getConfiguredExtensions());
          const github = extensions.find(
            (entry) => entry.configKey === 'github_official' || entry.name === 'github_official'
          );
          next = !github
            ? 'missing'
            : !github.enabled
              ? 'off'
              : (await connectionCheck(testConfigExtension(github))).success
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
        // This login was explicitly started by Connect GitHub. Finish the same
        // connection flow without requiring a second credentials setup step.
        await connectAccount(result.login);
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
  }, [challenge, connectAccount]);
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
    if (!logoutAccount || logoutPending.current || mcpConnectPending.current) return;
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
            {mcp === 'connected'
              ? t('GitHub: connected', 'GitHub：已连接', 'GitHub：已連線')
              : mcp === 'off'
                ? t('GitHub: disabled', 'GitHub：已停用', 'GitHub：已停用')
                : mcp === 'missing'
                  ? t('GitHub: not connected', 'GitHub：未连接', 'GitHub：未連線')
                  : t(
                      'GitHub: connection failed. Check the network and reconnect.',
                      'GitHub：连接失败，请检查网络后重新连接。',
                      'GitHub：連線失敗，請檢查網路後重新連線。'
                    )}
          </p>
        )}
      </div>
      {allowLogin && status?.state === 'connected' && mcp !== 'connected' && !challenge && (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary">
            {t(
              'Connect with your signed-in account. Its credential is verified and stored encrypted on this computer.',
              '使用已登录账号连接，验证后将凭据加密保存在本机。',
              '使用已登入帳號連線，驗證後將憑據加密儲存在本機。'
            )}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={checking || connectingMcp || signingOut || starting}
            onClick={() => void connectAccount(status.login)}
          >
            {connectingMcp
              ? t('Connecting…', '连接中…', '連線中…')
              : t('Connect GitHub', '连接 GitHub', '連線 GitHub')}
          </Button>
          {mcpConnectError && (
            <p role="alert" className="text-sm text-red-600">
              {mcpConnectError === 'account_changed'
                ? t(
                    'The account changed. Check the connection and try again.',
                    '账号已变化，请检查连接后重试。',
                    '帳號已變更，請檢查連線後重試。'
                  )
                : mcpConnectError === 'endpoint_changed'
                  ? t(
                      'This extension uses a custom endpoint. Configure it in Toolbox.',
                      '此扩展使用自定义地址，请在工具箱配置。',
                      '此擴充功能使用自訂位址，請在工具箱設定。'
                    )
                  : t(
                      'GitHub connection was not completed. Check network access and account permissions, then retry.',
                      'GitHub 连接未完成，请检查网络和账号权限后重试。',
                      'GitHub 連線未完成，請檢查網路與帳號權限後重試。'
                    )}
            </p>
          )}
        </div>
      )}
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
            disabled={checking || starting || signingOut || connectingMcp}
            onClick={() => void check()}
          >
            <RefreshCw className="h-4 w-4" />
            {intl.formatMessage(checking ? messages.checking : messages.check)}
          </Button>
          {status?.state === 'connected' && status.login && (
            <details className="w-full text-xs text-text-secondary">
              <summary className="cursor-pointer py-2">
                {t('Advanced account options', '高级账号选项', '進階帳號選項')}
              </summary>
              <p className="mb-2">
                {t(
                  'The CLI account is shared with other tools. Signing out here leaves CodeBuddy’s saved connection credential unchanged.',
                  'CLI 账号与其他工具共享。在此退出不会删除 CodeBuddy 已保存的连接凭据。',
                  'CLI 帳號與其他工具共用。在此登出不會刪除 CodeBuddy 已儲存的連線憑據。'
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={checking || starting || signingOut || connectingMcp}
                onClick={() => {
                  setLogoutFailed(false);
                  setLogoutAccount(status.login!);
                }}
              >
                <LogOut className="h-4 w-4" />
                {intl.formatMessage(messages.logout)}
              </Button>
            </details>
          )}
          {allowLogin &&
            status?.state !== 'connected' &&
            status?.state !== 'unavailable' &&
            status?.state !== 'restart_required' && (
              <Button
                size="sm"
                disabled={!status || checkingAccount || starting || signingOut || connectingMcp}
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
