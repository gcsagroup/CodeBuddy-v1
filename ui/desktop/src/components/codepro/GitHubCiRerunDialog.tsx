import type { GitHubCiRerunPreviewResponse } from '../../acp/githubCi';
import { defineMessages, useIntl } from '../../i18n';
import { ConfirmationModal } from '../ui/ConfirmationModal';

const i18n = defineMessages({
  title: { id: 'githubCi.rerun.confirmTitle', defaultMessage: 'Rerun failed jobs?' },
  message: {
    id: 'githubCi.rerun.confirmMessage',
    defaultMessage:
      'This writes to GitHub. CodePro will recheck the pushed commit before submitting.',
  },
  run: {
    id: 'githubCi.rerun.runDetail',
    defaultMessage: '{name} · run #{number} · attempt {attempt}',
  },
  target: {
    id: 'githubCi.rerun.targetDetail',
    defaultMessage: '{branch} · {sha}',
  },
  cost: {
    id: 'githubCi.rerun.costWarning',
    defaultMessage:
      'This may consume GitHub Actions minutes and reruns only failed jobs and their dependencies.',
  },
  confirm: { id: 'githubCi.rerun.confirm', defaultMessage: 'Rerun failed jobs' },
  cancel: { id: 'githubCi.rerun.cancel', defaultMessage: 'Cancel' },
});

interface GitHubCiRerunDialogProps {
  preview?: GitHubCiRerunPreviewResponse;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function GitHubCiRerunDialog({
  preview,
  busy,
  onCancel,
  onConfirm,
}: GitHubCiRerunDialogProps) {
  const intl = useIntl();

  return (
    <ConfirmationModal
      isOpen={Boolean(preview)}
      title={intl.formatMessage(i18n.title)}
      message={intl.formatMessage(i18n.message)}
      confirmLabel={intl.formatMessage(i18n.confirm)}
      cancelLabel={intl.formatMessage(i18n.cancel)}
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
              {intl.formatMessage(i18n.cost)}
            </p>
          </div>
        )
      }
    />
  );
}
