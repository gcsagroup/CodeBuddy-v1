import { useEffect, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { GITHUB_CLI_INSTALL_URL, GITHUB_CLI_LOGIN_COMMAND } from '../../acp/git';
import { defineMessages, useIntl } from '../../i18n';
import { ConfirmationModal } from '../ui/ConfirmationModal';

const i18n = defineMessages({
  install: { id: 'githubCliRecovery.install', defaultMessage: 'Install GitHub CLI' },
  installTitle: {
    id: 'githubCliRecovery.installTitle',
    defaultMessage: 'Install GitHub CLI?',
  },
  installMessage: {
    id: 'githubCliRecovery.installMessage',
    defaultMessage: 'Open the official GitHub CLI download page in your browser?',
  },
  openInstall: {
    id: 'githubCliRecovery.openInstall',
    defaultMessage: 'Open GitHub CLI download page',
  },
  installOpened: {
    id: 'githubCliRecovery.installOpened',
    defaultMessage: 'Install GitHub CLI, restart CodePro, then refresh.',
  },
  loginHelp: {
    id: 'githubCliRecovery.loginHelp',
    defaultMessage: 'Run this command in a terminal to connect GitHub:',
  },
  copyLogin: {
    id: 'githubCliRecovery.copyLogin',
    defaultMessage: 'Copy GitHub login command',
  },
  loginCopied: {
    id: 'githubCliRecovery.loginCopied',
    defaultMessage:
      'Login command copied. Run it in a terminal, finish browser authorization, then refresh.',
  },
  openFailed: {
    id: 'githubCliRecovery.openFailed',
    defaultMessage: 'Unable to open the GitHub CLI download page.',
  },
  copyFailed: {
    id: 'githubCliRecovery.copyFailed',
    defaultMessage: 'Unable to copy the GitHub login command.',
  },
  cancel: { id: 'githubCliRecovery.cancel', defaultMessage: 'Cancel' },
});

export interface GitHubCliRecoveryActionsProps {
  state: 'unavailable' | 'not_authenticated';
}

export function GitHubCliRecoveryActions({ state }: GitHubCliRecoveryActionsProps) {
  const intl = useIntl();
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    setConfirmingInstall(false);
    setFeedback(undefined);
    setFailure(undefined);
  }, [state]);

  const openInstallPage = async () => {
    setConfirmingInstall(false);
    setFeedback(undefined);
    setFailure(undefined);
    try {
      await window.electron.openExternal(GITHUB_CLI_INSTALL_URL);
      setFeedback(intl.formatMessage(i18n.installOpened));
    } catch {
      setFailure(intl.formatMessage(i18n.openFailed));
    }
  };

  const copyLoginCommand = async () => {
    setFeedback(undefined);
    setFailure(undefined);
    try {
      await navigator.clipboard.writeText(GITHUB_CLI_LOGIN_COMMAND);
      setFeedback(intl.formatMessage(i18n.loginCopied));
    } catch {
      setFailure(intl.formatMessage(i18n.copyFailed));
    }
  };

  return (
    <div className="mt-2 space-y-2">
      {state === 'unavailable' ? (
        <button
          type="button"
          onClick={() => setConfirmingInstall(true)}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-amber-500/50 px-2.5 font-medium"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          {intl.formatMessage(i18n.install)}
        </button>
      ) : (
        <>
          <p>{intl.formatMessage(i18n.loginHelp)}</p>
          <code className="block overflow-x-auto rounded bg-background-secondary p-1.5 text-[11px] text-text-primary">
            {GITHUB_CLI_LOGIN_COMMAND}
          </code>
          <button
            type="button"
            onClick={() => void copyLoginCommand()}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-amber-500/50 px-2.5 font-medium"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {intl.formatMessage(i18n.copyLogin)}
          </button>
        </>
      )}
      {feedback && (
        <p role="status" className="text-green-700 dark:text-green-300">
          {feedback}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-red-700 dark:text-red-300">
          {failure}
        </p>
      )}
      <ConfirmationModal
        isOpen={confirmingInstall}
        title={intl.formatMessage(i18n.installTitle)}
        message={intl.formatMessage(i18n.installMessage)}
        confirmLabel={intl.formatMessage(i18n.openInstall)}
        cancelLabel={intl.formatMessage(i18n.cancel)}
        onConfirm={() => void openInstallPage()}
        onCancel={() => setConfirmingInstall(false)}
      />
    </div>
  );
}
