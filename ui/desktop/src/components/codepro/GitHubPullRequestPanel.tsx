import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, GitBranch, GitPullRequest, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  acpChangeGitHubPullRequestState,
  acpCreateGitHubPullRequest,
  acpGitHubDeliveryStatus,
  acpPreviewGitHubPullRequest,
  acpPreviewGitHubPullRequestContent,
  acpPreviewGitHubPullRequestState,
  acpUpdateGitHubPullRequestContent,
  type GitHubDeliveryStatusResponse,
  type GitHubPullRequestContentPreviewResponse,
  type GitHubPullRequestCreateResponse,
  type GitHubPullRequestPreviewResponse,
  type GitHubPullRequestStatePreviewResponse,
} from '../../acp/githubPullRequests';
import { defineMessages, useIntl } from '../../i18n';
import { ConfirmationModal } from '../ui/ConfirmationModal';
import { GitHubCliRecoveryActions } from './GitHubCliRecoveryActions';
import { GitHubIssuesPanel } from './GitHubIssuesPanel';

const i18n = defineMessages({
  title: { id: 'githubDelivery.title', defaultMessage: 'Delivery' },
  description: {
    id: 'githubDelivery.description',
    defaultMessage: 'Current branch, Pull Request, and required GitHub checks.',
  },
  noProject: {
    id: 'githubDelivery.noProject',
    defaultMessage: 'Open a CodePro project to inspect delivery status.',
  },
  refresh: { id: 'githubDelivery.refresh', defaultMessage: 'Refresh delivery status' },
  refreshing: { id: 'githubDelivery.refreshing', defaultMessage: 'Refreshing…' },
  repository: { id: 'githubDelivery.repository', defaultMessage: 'Repository' },
  branch: { id: 'githubDelivery.branch', defaultMessage: 'Branch' },
  account: { id: 'githubDelivery.account', defaultMessage: 'Signed in as {login}' },
  noPullRequest: {
    id: 'githubDelivery.noPullRequest',
    defaultMessage: 'No Pull Request exists for this branch.',
  },
  pullRequest: { id: 'githubDelivery.pullRequest', defaultMessage: 'Pull Request #{number}' },
  draft: { id: 'githubDelivery.draft', defaultMessage: 'Draft' },
  open: { id: 'githubDelivery.open', defaultMessage: 'Open on GitHub' },
  requiredChecks: { id: 'githubDelivery.requiredChecks', defaultMessage: 'Required checks' },
  noRequiredChecks: {
    id: 'githubDelivery.noRequiredChecks',
    defaultMessage: 'No required checks were reported.',
  },
  pass: { id: 'githubDelivery.check.pass', defaultMessage: 'Passed' },
  fail: { id: 'githubDelivery.check.fail', defaultMessage: 'Failed' },
  pending: { id: 'githubDelivery.check.pending', defaultMessage: 'Pending' },
  skipping: { id: 'githubDelivery.check.skipping', defaultMessage: 'Skipped' },
  cancel: { id: 'githubDelivery.check.cancel', defaultMessage: 'Cancelled' },
  unavailable: {
    id: 'githubDelivery.unavailable',
    defaultMessage: 'GitHub CLI is unavailable.',
  },
  notAuthenticated: {
    id: 'githubDelivery.notAuthenticated',
    defaultMessage: 'GitHub CLI is not signed in.',
  },
  failed: {
    id: 'githubDelivery.failed',
    defaultMessage: 'Delivery status could not be refreshed.',
  },
  installCli: {
    id: 'githubDelivery.recovery.installCli',
    defaultMessage: 'Install GitHub CLI, then restart CodePro.',
  },
  signIn: {
    id: 'githubDelivery.recovery.signIn',
    defaultMessage: 'Run gh auth login in a terminal, then refresh.',
  },
  openGitRepository: {
    id: 'githubDelivery.recovery.openGitRepository',
    defaultMessage: 'Open a folder that contains a Git repository.',
  },
  checkoutBranch: {
    id: 'githubDelivery.recovery.checkoutBranch',
    defaultMessage: 'Check out a local branch before refreshing.',
  },
  addRemote: {
    id: 'githubDelivery.recovery.addRemote',
    defaultMessage: 'Add a GitHub origin remote before refreshing.',
  },
  useGitHubRemote: {
    id: 'githubDelivery.recovery.useGitHubRemote',
    defaultMessage: 'Use a canonical github.com origin remote.',
  },
  retry: {
    id: 'githubDelivery.recovery.retry',
    defaultMessage: 'Check the network and GitHub CLI, then refresh.',
  },
  prepare: { id: 'githubDelivery.prepare', defaultMessage: 'Prepare Pull Request' },
  prepareTitle: {
    id: 'githubDelivery.prepareTitle',
    defaultMessage: 'Review Pull Request proposal',
  },
  prepareMessage: {
    id: 'githubDelivery.prepareMessage',
    defaultMessage:
      'Edit the Agent proposal, run the local preflight, then confirm the GitHub write.',
  },
  titleLabel: { id: 'githubDelivery.titleLabel', defaultMessage: 'Title' },
  bodyLabel: { id: 'githubDelivery.bodyLabel', defaultMessage: 'Description' },
  preflight: { id: 'githubDelivery.preflight', defaultMessage: 'Run preflight' },
  create: { id: 'githubDelivery.create', defaultMessage: 'Create on GitHub' },
  dialogCancel: { id: 'githubDelivery.cancel', defaultMessage: 'Cancel' },
  counts: {
    id: 'githubDelivery.counts',
    defaultMessage:
      '{commits, plural, one {# commit} other {# commits}} · {files, plural, one {# file} other {# files}}',
  },
  writeWarning: {
    id: 'githubDelivery.writeWarning',
    defaultMessage:
      'The next confirmation pushes the verified branch and creates a Pull Request on GitHub.',
  },
  previewFailed: {
    id: 'githubDelivery.previewFailed',
    defaultMessage: 'Pull Request preflight failed.',
  },
  createFailed: {
    id: 'githubDelivery.createFailed',
    defaultMessage: 'GitHub did not create the Pull Request.',
  },
  uncertainEffect: {
    id: 'githubDelivery.uncertainEffect',
    defaultMessage:
      'The remote result is uncertain. Inspect the branch and Pull Requests on GitHub before retrying.',
  },
  closePullRequest: {
    id: 'githubDelivery.state.close',
    defaultMessage: 'Close Pull Request',
  },
  reopenPullRequest: {
    id: 'githubDelivery.state.reopen',
    defaultMessage: 'Reopen Pull Request',
  },
  stateTitle: {
    id: 'githubDelivery.state.title',
    defaultMessage: 'Confirm Pull Request state change',
  },
  stateMessage: {
    id: 'githubDelivery.state.message',
    defaultMessage: 'Run a fresh preflight, then confirm the GitHub state change.',
  },
  statePreflight: {
    id: 'githubDelivery.state.preflight',
    defaultMessage: 'Run state preflight',
  },
  closeOnGitHub: {
    id: 'githubDelivery.state.closeConfirm',
    defaultMessage: 'Close on GitHub',
  },
  reopenOnGitHub: {
    id: 'githubDelivery.state.reopenConfirm',
    defaultMessage: 'Reopen on GitHub',
  },
  stateWarning: {
    id: 'githubDelivery.state.warning',
    defaultMessage: 'This confirmed GitHub write will {action} Pull Request #{number}.',
  },
  closeAction: { id: 'githubDelivery.state.closeAction', defaultMessage: 'close' },
  reopenAction: { id: 'githubDelivery.state.reopenAction', defaultMessage: 'reopen' },
  statePreviewFailed: {
    id: 'githubDelivery.state.previewFailed',
    defaultMessage: 'Pull Request state preflight failed.',
  },
  stateChangeFailed: {
    id: 'githubDelivery.state.changeFailed',
    defaultMessage: 'GitHub did not change the Pull Request state.',
  },
  editPullRequest: {
    id: 'githubDelivery.content.edit',
    defaultMessage: 'Edit Pull Request',
  },
  contentMessage: {
    id: 'githubDelivery.content.message',
    defaultMessage:
      'Edit the title or description, run a fresh preflight, then confirm the update.',
  },
  contentPreflight: {
    id: 'githubDelivery.content.preflight',
    defaultMessage: 'Run update preflight',
  },
  updateOnGitHub: {
    id: 'githubDelivery.content.updateConfirm',
    defaultMessage: 'Update on GitHub',
  },
  contentWarning: {
    id: 'githubDelivery.content.warning',
    defaultMessage: 'This confirmed GitHub write will update Pull Request #{number}.',
  },
  contentPreviewFailed: {
    id: 'githubDelivery.content.previewFailed',
    defaultMessage: 'Pull Request update preflight failed.',
  },
  contentUpdateFailed: {
    id: 'githubDelivery.content.updateFailed',
    defaultMessage: 'GitHub did not update the Pull Request.',
  },
});

export interface GitHubPullRequestPanelApi {
  status: typeof acpGitHubDeliveryStatus;
  preview: typeof acpPreviewGitHubPullRequest;
  create: typeof acpCreateGitHubPullRequest;
  previewState: typeof acpPreviewGitHubPullRequestState;
  changeState: typeof acpChangeGitHubPullRequestState;
  previewContent: typeof acpPreviewGitHubPullRequestContent;
  updateContent: typeof acpUpdateGitHubPullRequestContent;
}

interface GitHubPullRequestPanelProps {
  workingDirectory?: string;
  suggestedTitle?: string;
  suggestedBody?: string;
  api?: GitHubPullRequestPanelApi;
}

const defaultApi: GitHubPullRequestPanelApi = {
  status: acpGitHubDeliveryStatus,
  preview: acpPreviewGitHubPullRequest,
  create: acpCreateGitHubPullRequest,
  previewState: acpPreviewGitHubPullRequestState,
  changeState: acpChangeGitHubPullRequestState,
  previewContent: acpPreviewGitHubPullRequestContent,
  updateContent: acpUpdateGitHubPullRequestContent,
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const data = 'data' in error ? error.data : undefined;
  if (!data || typeof data !== 'object' || !('code' in data)) return undefined;
  return typeof data.code === 'string' ? data.code : undefined;
}

function validGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function validCreatedUrl(
  created: GitHubPullRequestCreateResponse,
  preview: GitHubPullRequestPreviewResponse
): boolean {
  return (
    created.number > 0 &&
    validGitHubUrl(created.htmlUrl) &&
    created.htmlUrl ===
      `https://github.com/${preview.repositoryOwner}/${preview.repositoryName}/pull/${created.number}`
  );
}

function validPreflightId(value: string): boolean {
  return value.length === 64 && /^[0-9a-f]+$/.test(value);
}

function validStatePreview(
  preview: GitHubPullRequestStatePreviewResponse,
  pullRequest: NonNullable<GitHubDeliveryStatusResponse['pullRequest']>,
  targetState: 'open' | 'closed'
): boolean {
  return (
    validPreflightId(preview.preflightId) &&
    preview.number === pullRequest.number &&
    preview.title === pullRequest.title &&
    preview.currentState === pullRequest.state &&
    preview.targetState === targetState &&
    preview.url === pullRequest.url &&
    validGitHubUrl(preview.url) &&
    preview.headBranch === pullRequest.headBranch &&
    preview.baseBranch === pullRequest.baseBranch
  );
}

function validContentPreview(
  preview: GitHubPullRequestContentPreviewResponse,
  pullRequest: NonNullable<GitHubDeliveryStatusResponse['pullRequest']>,
  title: string,
  body: string
): boolean {
  return (
    validPreflightId(preview.preflightId) &&
    preview.number === pullRequest.number &&
    preview.currentTitle === pullRequest.title &&
    preview.currentBody === pullRequest.body &&
    preview.targetTitle === title &&
    preview.targetBody === body &&
    preview.state === pullRequest.state &&
    preview.url === pullRequest.url &&
    validGitHubUrl(preview.url) &&
    preview.headBranch === pullRequest.headBranch &&
    preview.baseBranch === pullRequest.baseBranch
  );
}

export function GitHubPullRequestPanel({
  workingDirectory,
  suggestedTitle = '',
  suggestedBody = '',
  api = defaultApi,
}: GitHubPullRequestPanelProps) {
  const intl = useIntl();
  const [status, setStatus] = useState<GitHubDeliveryStatusResponse>();
  const [failure, setFailure] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalTitle, setProposalTitle] = useState('');
  const [proposalBody, setProposalBody] = useState('');
  const [preview, setPreview] = useState<GitHubPullRequestPreviewResponse>();
  const [proposalError, setProposalError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string>();
  const [stateDialogOpen, setStateDialogOpen] = useState(false);
  const [stateTarget, setStateTarget] = useState<'open' | 'closed'>();
  const [statePreview, setStatePreview] = useState<GitHubPullRequestStatePreviewResponse>();
  const [stateError, setStateError] = useState<string>();
  const [contentDialogOpen, setContentDialogOpen] = useState(false);
  const [contentTitle, setContentTitle] = useState('');
  const [contentBody, setContentBody] = useState('');
  const [contentPreview, setContentPreview] = useState<GitHubPullRequestContentPreviewResponse>();
  const [contentError, setContentError] = useState<string>();
  const operationVersion = useRef(0);

  const recovery = useCallback(
    (code?: string) => {
      const message =
        {
          cli_unavailable: i18n.installCli,
          not_authenticated: i18n.signIn,
          not_git_repository: i18n.openGitRepository,
          detached_head: i18n.checkoutBranch,
          no_remote: i18n.addRemote,
          unsupported_remote: i18n.useGitHubRemote,
        }[code ?? ''] ?? i18n.retry;
      return intl.formatMessage(message);
    },
    [intl]
  );

  const refresh = useCallback(async () => {
    if (!workingDirectory) return;
    const version = ++operationVersion.current;
    setLoading(true);
    setFailure(undefined);
    try {
      const result = await api.status({ workingDir: workingDirectory });
      if (operationVersion.current === version) setStatus(result);
    } catch (cause) {
      if (operationVersion.current === version) {
        setStatus(undefined);
        setFailure(recovery(errorCode(cause)));
      }
    } finally {
      if (operationVersion.current === version) setLoading(false);
    }
  }, [api, recovery, workingDirectory]);

  useEffect(() => {
    operationVersion.current += 1;
    setStatus(undefined);
    setFailure(undefined);
    setLoading(false);
    setProposalOpen(false);
    setProposalTitle(suggestedTitle.slice(0, 256));
    setProposalBody(suggestedBody.slice(0, 65_536));
    setPreview(undefined);
    setProposalError(undefined);
    setSubmitting(false);
    setCreatedUrl(undefined);
    setStateDialogOpen(false);
    setStateTarget(undefined);
    setStatePreview(undefined);
    setStateError(undefined);
    setContentDialogOpen(false);
    setContentTitle('');
    setContentBody('');
    setContentPreview(undefined);
    setContentError(undefined);
    if (workingDirectory) void refresh();
    return () => {
      operationVersion.current += 1;
    };
  }, [refresh, suggestedBody, suggestedTitle, workingDirectory]);

  const editProposal = (update: () => void) => {
    update();
    setPreview(undefined);
    setProposalError(undefined);
  };

  const runPreflight = async () => {
    if (!workingDirectory || !proposalTitle.trim() || submitting) return;
    setSubmitting(true);
    setProposalError(undefined);
    try {
      setPreview(
        await api.preview({
          workingDir: workingDirectory,
          title: proposalTitle,
          body: proposalBody,
          baseBranch: undefined,
          draft: false,
          maintainerCanModify: false,
        })
      );
    } catch (cause) {
      setProposalError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : intl.formatMessage(i18n.previewFailed)
      );
    } finally {
      setSubmitting(false);
    }
  };

  const createPullRequest = async () => {
    if (!workingDirectory || !preview || submitting) return;
    setSubmitting(true);
    setProposalError(undefined);
    try {
      const created = await api.create({
        workingDir: workingDirectory,
        title: proposalTitle,
        body: proposalBody,
        baseBranch: undefined,
        draft: false,
        maintainerCanModify: false,
        preflightId: preview.preflightId,
      });
      if (!validCreatedUrl(created, preview)) throw new Error('invalid_created_url');
      setCreatedUrl(created.htmlUrl);
      setProposalOpen(false);
      setPreview(undefined);
      await refresh();
    } catch (cause) {
      if (errorCode(cause) === 'uncertain_effect') {
        setProposalOpen(false);
        setPreview(undefined);
        setStatus(undefined);
        setFailure(intl.formatMessage(i18n.uncertainEffect));
      } else {
        setProposalError(
          cause instanceof Error && cause.message.trim() && cause.message !== 'invalid_created_url'
            ? cause.message
            : intl.formatMessage(i18n.createFailed)
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openStateDialog = (target: 'open' | 'closed') => {
    setStateTarget(target);
    setStatePreview(undefined);
    setStateError(undefined);
    setStateDialogOpen(true);
  };

  const runStatePreflight = async () => {
    if (!workingDirectory || !pullRequest || !stateTarget || submitting) return;
    setSubmitting(true);
    setStateError(undefined);
    try {
      const result = await api.previewState({
        workingDir: workingDirectory,
        number: pullRequest.number,
        targetState: stateTarget,
      });
      if (!validStatePreview(result, pullRequest, stateTarget)) {
        throw new Error('invalid_state_preview_response');
      }
      setStatePreview(result);
    } catch (cause) {
      setStateError(
        cause instanceof Error &&
          cause.message.trim() &&
          cause.message !== 'invalid_state_preview_response'
          ? cause.message
          : intl.formatMessage(i18n.statePreviewFailed)
      );
    } finally {
      setSubmitting(false);
    }
  };

  const changePullRequestState = async () => {
    if (!workingDirectory || !stateTarget || !statePreview || submitting) return;
    setSubmitting(true);
    setStateError(undefined);
    try {
      const changed = await api.changeState({
        workingDir: workingDirectory,
        number: statePreview.number,
        targetState: stateTarget,
        preflightId: statePreview.preflightId,
      });
      if (
        changed.number !== statePreview.number ||
        changed.state !== stateTarget ||
        changed.url !== statePreview.url ||
        !validGitHubUrl(changed.url)
      ) {
        throw new Error('invalid_state_change_response');
      }
      setStateDialogOpen(false);
      setStateTarget(undefined);
      setStatePreview(undefined);
      await refresh();
    } catch (cause) {
      if (errorCode(cause) === 'uncertain_effect') {
        setStateDialogOpen(false);
        setStateTarget(undefined);
        setStatePreview(undefined);
        setStatus(undefined);
        setFailure(intl.formatMessage(i18n.uncertainEffect));
      } else {
        setStateError(
          cause instanceof Error &&
            cause.message.trim() &&
            cause.message !== 'invalid_state_change_response'
            ? cause.message
            : intl.formatMessage(i18n.stateChangeFailed)
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openContentDialog = () => {
    if (!pullRequest || pullRequest.state === 'merged') return;
    setContentTitle(pullRequest.title);
    setContentBody(pullRequest.body);
    setContentPreview(undefined);
    setContentError(undefined);
    setContentDialogOpen(true);
  };

  const editContent = (update: () => void) => {
    update();
    setContentPreview(undefined);
    setContentError(undefined);
  };

  const runContentPreflight = async () => {
    if (!workingDirectory || !pullRequest || !contentTitle.trim() || submitting) return;
    setSubmitting(true);
    setContentError(undefined);
    try {
      const result = await api.previewContent({
        workingDir: workingDirectory,
        number: pullRequest.number,
        title: contentTitle,
        body: contentBody,
      });
      if (!validContentPreview(result, pullRequest, contentTitle, contentBody)) {
        throw new Error('invalid_content_preview_response');
      }
      setContentPreview(result);
    } catch (cause) {
      setContentError(
        cause instanceof Error &&
          cause.message.trim() &&
          cause.message !== 'invalid_content_preview_response'
          ? cause.message
          : intl.formatMessage(i18n.contentPreviewFailed)
      );
    } finally {
      setSubmitting(false);
    }
  };

  const updatePullRequestContent = async () => {
    if (!workingDirectory || !contentPreview || submitting) return;
    setSubmitting(true);
    setContentError(undefined);
    try {
      const updated = await api.updateContent({
        workingDir: workingDirectory,
        number: contentPreview.number,
        title: contentTitle,
        body: contentBody,
        preflightId: contentPreview.preflightId,
      });
      if (
        updated.number !== contentPreview.number ||
        updated.title !== contentTitle ||
        updated.body !== contentBody ||
        updated.state !== contentPreview.state ||
        updated.url !== contentPreview.url ||
        !validGitHubUrl(updated.url)
      ) {
        throw new Error('invalid_content_update_response');
      }
      setContentDialogOpen(false);
      setContentPreview(undefined);
      await refresh();
    } catch (cause) {
      if (errorCode(cause) === 'uncertain_effect') {
        setContentDialogOpen(false);
        setContentPreview(undefined);
        setStatus(undefined);
        setFailure(intl.formatMessage(i18n.uncertainEffect));
      } else {
        setContentError(
          cause instanceof Error &&
            cause.message.trim() &&
            cause.message !== 'invalid_content_update_response'
            ? cause.message
            : intl.formatMessage(i18n.contentUpdateFailed)
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const checks = status?.requiredChecks ?? [];
  const pullRequest = status?.pullRequest;
  const repository = status?.repository;
  const cliRecovery =
    status?.cliStatus === 'unavailable'
      ? intl.formatMessage(i18n.installCli)
      : status?.cliStatus === 'not_authenticated'
        ? intl.formatMessage(i18n.signIn)
        : undefined;

  return (
    <section className="flex min-h-full flex-col gap-3" aria-labelledby="github-delivery-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="github-delivery-heading"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <GitPullRequest className="h-4 w-4" aria-hidden="true" />
            {intl.formatMessage(i18n.title)}
          </h3>
          <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.description)}</p>
        </div>
        <button
          type="button"
          aria-label={intl.formatMessage(i18n.refresh)}
          title={intl.formatMessage(i18n.refresh)}
          disabled={!workingDirectory || loading}
          onClick={() => void refresh()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border-primary text-text-primary hover:bg-background-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {loading ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {!workingDirectory && (
        <p className="rounded-md border border-dashed border-border-primary p-3 text-sm text-text-secondary">
          {intl.formatMessage(i18n.noProject)}
        </p>
      )}

      {loading && !status && (
        <p role="status" className="text-sm text-text-secondary">
          {intl.formatMessage(i18n.refreshing)}
        </p>
      )}

      {(failure || cliRecovery) && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
        >
          <p className="font-medium">
            {failure ??
              intl.formatMessage(
                status?.cliStatus === 'unavailable' ? i18n.unavailable : i18n.notAuthenticated
              )}
          </p>
          {cliRecovery && <p className="mt-1">{cliRecovery}</p>}
          {status?.cliStatus === 'unavailable' && <GitHubCliRecoveryActions state="unavailable" />}
          {status?.cliStatus === 'not_authenticated' && (
            <GitHubCliRecoveryActions state="not_authenticated" />
          )}
        </div>
      )}

      {repository && (
        <div className="grid gap-2 rounded-md border border-border-primary bg-background-secondary p-3 text-xs sm:grid-cols-2">
          <div>
            <p className="text-text-secondary">{intl.formatMessage(i18n.repository)}</p>
            <p className="mt-0.5 break-all font-medium text-text-primary">
              {repository.owner}/{repository.name}
            </p>
          </div>
          <div>
            <p className="flex items-center gap-1 text-text-secondary">
              <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
              {intl.formatMessage(i18n.branch)}
            </p>
            <p className="mt-0.5 break-all font-medium text-text-primary">
              {repository.headBranch}
            </p>
          </div>
          {status?.accountLogin && (
            <p className="text-text-secondary sm:col-span-2">
              {intl.formatMessage(i18n.account, { login: status.accountLogin })}
            </p>
          )}
        </div>
      )}

      {status?.cliStatus === 'ready' && repository && !pullRequest && (
        <div className="rounded-md border border-dashed border-border-primary p-3 text-sm text-text-secondary">
          <p>{intl.formatMessage(i18n.noPullRequest)}</p>
          {suggestedTitle.trim() && (
            <button
              type="button"
              onClick={() => {
                setProposalTitle(suggestedTitle.slice(0, 256));
                setProposalBody(suggestedBody.slice(0, 65_536));
                setPreview(undefined);
                setProposalError(undefined);
                setProposalOpen(true);
              }}
              className="mt-3 min-h-9 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {intl.formatMessage(i18n.prepare)}
            </button>
          )}
        </div>
      )}

      {createdUrl && validGitHubUrl(createdUrl) && (
        <button
          type="button"
          onClick={() => void window.electron.openExternal(createdUrl)}
          className="flex min-h-9 items-center justify-center gap-2 rounded-md border border-border-primary px-3 text-sm font-medium text-text-primary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          {intl.formatMessage(i18n.open)}
        </button>
      )}

      {pullRequest && (
        <div className="rounded-md border border-border-primary p-3 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-text-primary">
                {intl.formatMessage(i18n.pullRequest, { number: pullRequest.number })}
              </p>
              <p className="mt-1 text-text-primary">{pullRequest.title}</p>
              <p className="mt-1 text-text-secondary">
                {pullRequest.headBranch} → {pullRequest.baseBranch} · {pullRequest.state}
                {pullRequest.draft ? ` · ${intl.formatMessage(i18n.draft)}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {pullRequest.state !== 'merged' && (
                <button
                  type="button"
                  onClick={openContentDialog}
                  className="min-h-9 rounded-md border border-border-primary px-3 font-medium text-text-primary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {intl.formatMessage(i18n.editPullRequest)}
                </button>
              )}
              {pullRequest.state === 'open' && (
                <button
                  type="button"
                  onClick={() => openStateDialog('closed')}
                  className="min-h-9 rounded-md border border-amber-400 px-3 font-medium text-amber-700 hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  {intl.formatMessage(i18n.closePullRequest)}
                </button>
              )}
              {pullRequest.state === 'closed' && (
                <button
                  type="button"
                  onClick={() => openStateDialog('open')}
                  className="min-h-9 rounded-md border border-border-primary px-3 font-medium text-text-primary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {intl.formatMessage(i18n.reopenPullRequest)}
                </button>
              )}
              {validGitHubUrl(pullRequest.url) && (
                <button
                  type="button"
                  onClick={() => void window.electron.openExternal(pullRequest.url)}
                  className="flex min-h-9 items-center gap-2 rounded-md border border-border-primary px-3 font-medium text-text-primary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  {intl.formatMessage(i18n.open)}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {pullRequest && (
        <div>
          <h4 className="text-xs font-semibold text-text-primary">
            {intl.formatMessage(i18n.requiredChecks)}
          </h4>
          {checks.length === 0 ? (
            <p className="mt-2 text-xs text-text-secondary">
              {intl.formatMessage(i18n.noRequiredChecks)}
            </p>
          ) : (
            <ul className="mt-2 grid gap-2" aria-label={intl.formatMessage(i18n.requiredChecks)}>
              {checks.map((check) => (
                <li
                  key={`${check.name}:${check.url}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border-primary px-3 py-2 text-xs"
                >
                  <span className="min-w-0 truncate text-text-primary">{check.name}</span>
                  <span className="shrink-0 font-medium text-text-secondary">
                    {intl.formatMessage(i18n[check.bucket])}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {status?.cliStatus === 'ready' && workingDirectory && (
        <GitHubIssuesPanel workingDirectory={workingDirectory} />
      )}

      <ConfirmationModal
        isOpen={proposalOpen}
        title={intl.formatMessage(i18n.prepareTitle)}
        message={intl.formatMessage(i18n.prepareMessage)}
        confirmLabel={intl.formatMessage(preview ? i18n.create : i18n.preflight)}
        cancelLabel={intl.formatMessage(i18n.dialogCancel)}
        isSubmitting={submitting}
        onCancel={() => {
          if (!submitting) {
            setProposalOpen(false);
            setPreview(undefined);
            setProposalError(undefined);
          }
        }}
        onConfirm={() => void (preview ? createPullRequest() : runPreflight())}
        detail={
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs font-medium text-text-primary">
              {intl.formatMessage(i18n.titleLabel)}
              <input
                value={proposalTitle}
                maxLength={256}
                disabled={submitting}
                onChange={(event) => editProposal(() => setProposalTitle(event.target.value))}
                className="min-h-9 rounded-md border border-border-primary bg-background-primary px-2.5 text-sm font-normal outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-text-primary">
              {intl.formatMessage(i18n.bodyLabel)}
              <textarea
                value={proposalBody}
                maxLength={65_536}
                rows={5}
                disabled={submitting}
                onChange={(event) => editProposal(() => setProposalBody(event.target.value))}
                className="min-h-24 resize-y rounded-md border border-border-primary bg-background-primary px-2.5 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            {preview && (
              <div className="rounded-md border border-border-primary bg-background-secondary p-2 text-xs text-text-primary">
                <p>
                  {preview.headBranch} → {preview.baseBranch}
                </p>
                <p className="mt-1 text-text-secondary">
                  {intl.formatMessage(i18n.counts, {
                    commits: preview.commitCount,
                    files: preview.changedFileCount,
                  })}
                </p>
                <p className="mt-2 font-medium text-amber-700">
                  {intl.formatMessage(i18n.writeWarning)}
                </p>
              </div>
            )}
            {proposalError && (
              <p
                role="alert"
                className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
              >
                {proposalError}
              </p>
            )}
          </div>
        }
      />

      <ConfirmationModal
        isOpen={contentDialogOpen}
        title={intl.formatMessage(i18n.editPullRequest)}
        message={intl.formatMessage(i18n.contentMessage)}
        confirmLabel={intl.formatMessage(
          contentPreview ? i18n.updateOnGitHub : i18n.contentPreflight
        )}
        cancelLabel={intl.formatMessage(i18n.dialogCancel)}
        isSubmitting={submitting}
        onCancel={() => {
          if (!submitting) {
            setContentDialogOpen(false);
            setContentPreview(undefined);
            setContentError(undefined);
          }
        }}
        onConfirm={() => void (contentPreview ? updatePullRequestContent() : runContentPreflight())}
        detail={
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs font-medium text-text-primary">
              {intl.formatMessage(i18n.titleLabel)}
              <input
                value={contentTitle}
                maxLength={256}
                disabled={submitting}
                onChange={(event) => editContent(() => setContentTitle(event.target.value))}
                className="min-h-9 rounded-md border border-border-primary bg-background-primary px-2.5 text-sm font-normal outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-text-primary">
              {intl.formatMessage(i18n.bodyLabel)}
              <textarea
                value={contentBody}
                maxLength={65_536}
                rows={5}
                disabled={submitting}
                onChange={(event) => editContent(() => setContentBody(event.target.value))}
                className="min-h-24 resize-y rounded-md border border-border-primary bg-background-primary px-2.5 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            {contentPreview && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs font-medium text-amber-900">
                {intl.formatMessage(i18n.contentWarning, { number: contentPreview.number })}
              </p>
            )}
            {contentError && (
              <p
                role="alert"
                className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
              >
                {contentError}
              </p>
            )}
          </div>
        }
      />

      <ConfirmationModal
        isOpen={stateDialogOpen}
        title={intl.formatMessage(i18n.stateTitle)}
        message={intl.formatMessage(i18n.stateMessage)}
        confirmLabel={intl.formatMessage(
          statePreview
            ? stateTarget === 'closed'
              ? i18n.closeOnGitHub
              : i18n.reopenOnGitHub
            : i18n.statePreflight
        )}
        cancelLabel={intl.formatMessage(i18n.dialogCancel)}
        isSubmitting={submitting}
        onCancel={() => {
          if (!submitting) {
            setStateDialogOpen(false);
            setStateTarget(undefined);
            setStatePreview(undefined);
            setStateError(undefined);
          }
        }}
        onConfirm={() => void (statePreview ? changePullRequestState() : runStatePreflight())}
        detail={
          <div className="grid gap-3">
            {statePreview && stateTarget && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                <p className="font-medium">
                  {intl.formatMessage(i18n.stateWarning, {
                    action: intl.formatMessage(
                      stateTarget === 'closed' ? i18n.closeAction : i18n.reopenAction
                    ),
                    number: statePreview.number,
                  })}
                </p>
                <p className="mt-1 break-all">
                  {statePreview.headBranch} → {statePreview.baseBranch}
                </p>
              </div>
            )}
            {stateError && (
              <p
                role="alert"
                className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
              >
                {stateError}
              </p>
            )}
          </div>
        }
      />
    </section>
  );
}
