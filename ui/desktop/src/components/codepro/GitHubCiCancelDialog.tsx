import type { GitHubCiCancelPreviewResponse } from '../../acp/githubCi';
import { defineMessages, useIntl } from '../../i18n';
import { ConfirmationModal } from '../ui/ConfirmationModal';

const i18n = defineMessages({
  title: { id: 'githubCi.cancel.confirmTitle', defaultMessage: 'Cancel workflow run?' },
  message: {
    id: 'githubCi.cancel.confirmMessage',
    defaultMessage:
      'This writes to GitHub. CodePro will recheck the pushed commit and run state before submitting.',
  },
  run: {
    id: 'githubCi.cancel.runDetail',
    defaultMessage: '{name} · run #{number} · attempt {attempt}',
  },
  target: {
    id: 'githubCi.cancel.targetDetail',
    defaultMessage: 'Branch {branch} · commit {sha}',
  },
  warning: {
    id: 'githubCi.cancel.warning',
    defaultMessage:
      'Cancellation may stop jobs that are currently running. CodePro will not force-cancel the run.',
  },
  confirm: { id: 'githubCi.cancel.confirm', defaultMessage: 'Cancel workflow run' },
  keepRunning: { id: 'githubCi.cancel.keepRunning', defaultMessage: 'Keep running' },
});

interface GitHubCiCancelDialogProps {
  preview?: GitHubCiCancelPreviewResponse;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function GitHubCiCancelDialog({
  preview,
  busy,
  onCancel,
  onConfirm,
}: GitHubCiCancelDialogProps) {
  const intl = useIntl();

  return (
    <ConfirmationModal
      isOpen={Boolean(preview)}
      title={intl.formatMessage(i18n.title)}
      message={intl.formatMessage(i18n.message)}
      confirmLabel={intl.formatMessage(i18n.confirm)}
      cancelLabel={intl.formatMessage(i18n.keepRunning)}
      isSubmitting={busy}
      onCancel={() => !busy && onCancel()}
      onConfirm={onConfirm}
      detail={
        preview && (
          <div className="grid gap-3 text-text-primary">
            <div className="rounded-md border border-border-primary bg-background-secondary p-3">
              <p className="font-medium">
                {preview.repositoryOwner}/{preview.repositoryName}
              </p>
              <p className="mt-1 text-text-secondary">
                {intl.formatMessage(i18n.run, {
                  name: preview.run.name,
                  number: preview.run.runNumber,
                  attempt: preview.run.attempt,
                })}
              </p>
              <p className="mt-1 font-mono text-xs text-text-secondary">
                {intl.formatMessage(i18n.target, {
                  branch: preview.branch,
                  sha: preview.headSha.slice(0, 7),
                })}
              </p>
            </div>
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
              {intl.formatMessage(i18n.warning)}
            </p>
          </div>
        )
      }
    />
  );
}
