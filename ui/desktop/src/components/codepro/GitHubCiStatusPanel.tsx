import {
  Activity,
  AlertTriangle,
  Ban,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import type { GitHubCiRun } from '@aaif/goose-sdk';
import type { GitHubCiStatusResponse } from '../../acp/githubCi';
import { defineMessages, useIntl } from '../../i18n';
import { GitHubCiRerunDialog } from './GitHubCiRerunDialog';
import { GitHubCiCancelDialog } from './GitHubCiCancelDialog';
import { GitHubCiArtifactsPanel } from './GitHubCiArtifactsPanel';
import {
  GitHubWorkflowDispatchPanel,
  type GitHubWorkflowDispatchPanelApi,
} from './GitHubWorkflowDispatchPanel';
import { eligibleForCancel } from './githubCiCancel';
import { eligibleForRerun } from './githubCiRerun';
import {
  defaultGitHubCiStatusPanelApi,
  useGitHubCiStatus,
  type GitHubCiStatusPanelApi,
} from './useGitHubCiStatus';

export type { GitHubCiStatusPanelApi } from './useGitHubCiStatus';

const i18n = defineMessages({
  title: { id: 'githubCi.title', defaultMessage: 'Continuous integration' },
  description: {
    id: 'githubCi.description',
    defaultMessage:
      'Status for the exact pushed commit. CodePro does not poll; GitHub writes require confirmation.',
  },
  noProject: {
    id: 'githubCi.noProject',
    defaultMessage: 'Open a CodePro project to view CI status.',
  },
  refresh: { id: 'githubCi.refresh', defaultMessage: 'Refresh CI status' },
  loading: { id: 'githubCi.loading', defaultMessage: 'Loading CI status…' },
  failed: { id: 'githubCi.failed', defaultMessage: 'CodePro could not load CI status.' },
  dirty: {
    id: 'githubCi.dirty',
    defaultMessage: 'Local changes are not included in this CI result.',
  },
  truncated: {
    id: 'githubCi.truncated',
    defaultMessage: 'Showing {shown} of {total} workflow runs.',
  },
  noRuns: { id: 'githubCi.noRuns', defaultMessage: 'No workflow runs found for this commit.' },
  aggregateNoRuns: { id: 'githubCi.aggregate.noRuns', defaultMessage: 'No CI runs' },
  aggregateRunning: { id: 'codeProPresentation.taskStatus.running', defaultMessage: 'Running' },
  aggregateSuccess: { id: 'codeProPresentation.taskStatus.passed', defaultMessage: 'Passed' },
  aggregateFailure: { id: 'codeProPresentation.taskStatus.failed', defaultMessage: 'Failed' },
  aggregateCancelled: {
    id: 'codeProPresentation.activityState.cancelled',
    defaultMessage: 'Cancelled',
  },
  aggregateNeutral: { id: 'githubCi.aggregate.neutral', defaultMessage: 'CI completed neutrally' },
  aggregateUnknown: {
    id: 'codeProPresentation.activityState.unknown',
    defaultMessage: 'Unknown status',
  },
  runMeta: {
    id: 'githubCi.runMeta',
    defaultMessage: '{state} · {event} · attempt {attempt}',
  },
  openRun: { id: 'githubCi.openRun', defaultMessage: 'Open {name} run #{number}' },
  rerunAction: { id: 'githubCi.rerun.action', defaultMessage: 'Rerun failed jobs' },
  rerunActionLabel: {
    id: 'githubCi.rerun.actionLabel',
    defaultMessage: 'Rerun failed jobs for {name} run #{number}',
  },
  rerunPreviewing: { id: 'githubCi.rerun.previewing', defaultMessage: 'Checking…' },
  rerunAccepted: {
    id: 'githubCi.rerun.accepted',
    defaultMessage: 'Rerun request accepted.',
  },
  cancelAction: { id: 'githubCi.cancel.action', defaultMessage: 'Cancel run' },
  cancelActionLabel: {
    id: 'githubCi.cancel.actionLabel',
    defaultMessage: 'Cancel {name} run #{number}',
  },
  cancelPreviewing: { id: 'githubCi.cancel.previewing', defaultMessage: 'Checking…' },
  cancelAccepted: {
    id: 'githubCi.cancel.accepted',
    defaultMessage: 'Cancellation request accepted.',
  },
  statusQueued: { id: 'codeProPresentation.taskStatus.queued', defaultMessage: 'Queued' },
  statusRunning: { id: 'codeProPresentation.taskStatus.running', defaultMessage: 'Running' },
  statusWaiting: { id: 'githubCi.status.waiting', defaultMessage: 'Waiting' },
  statusPending: { id: 'codeProPresentation.activityState.pending', defaultMessage: 'Pending' },
  statusSuccess: { id: 'codeProPresentation.taskStatus.passed', defaultMessage: 'Passed' },
  statusFailure: { id: 'codeProPresentation.taskStatus.failed', defaultMessage: 'Failed' },
  statusCancelled: {
    id: 'codeProPresentation.activityState.cancelled',
    defaultMessage: 'Cancelled',
  },
  statusNeutral: { id: 'githubCi.status.neutral', defaultMessage: 'Neutral' },
  statusSkipped: { id: 'codeProPresentation.taskStatus.skipped', defaultMessage: 'Skipped' },
  statusTimedOut: { id: 'githubCi.status.timedOut', defaultMessage: 'Timed out' },
  statusActionRequired: { id: 'githubCi.status.actionRequired', defaultMessage: 'Action required' },
  statusUnknown: {
    id: 'codeProPresentation.activityState.unknown',
    defaultMessage: 'Unknown status',
  },
});

interface GitHubCiStatusPanelProps {
  workingDirectory?: string;
  api?: GitHubCiStatusPanelApi;
  workflowDispatchApi?: GitHubWorkflowDispatchPanelApi;
}

function validRunUrl(status: GitHubCiStatusResponse, run: GitHubCiRun): boolean {
  try {
    const url = new URL(run.htmlUrl);
    return (
      run.id > 0 &&
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === `/${status.repositoryOwner}/${status.repositoryName}/actions/runs/${run.id}`
    );
  } catch {
    return false;
  }
}

export function GitHubCiStatusPanel({
  workingDirectory,
  api = defaultGitHubCiStatusPanelApi,
  workflowDispatchApi,
}: GitHubCiStatusPanelProps) {
  const intl = useIntl();
  const {
    status,
    error,
    isLoading,
    rerunPreview,
    previewingRunId,
    isRerunning,
    rerunError,
    rerunAccepted,
    cancelPreview,
    previewingCancelRunId,
    isCancelling,
    cancelError,
    cancelAccepted,
    interactionBusy,
    loadStatus,
    previewRerun,
    rerunFailedJobs,
    cancelRerun,
    previewCancel,
    cancelRun,
    closeCancel,
  } = useGitHubCiStatus(workingDirectory, api);

  const aggregateLabel = (value: GitHubCiStatusResponse['aggregateStatus']) => {
    switch (value) {
      case 'no_runs':
        return intl.formatMessage(i18n.aggregateNoRuns);
      case 'in_progress':
        return intl.formatMessage(i18n.aggregateRunning);
      case 'success':
        return intl.formatMessage(i18n.aggregateSuccess);
      case 'failure':
        return intl.formatMessage(i18n.aggregateFailure);
      case 'cancelled':
        return intl.formatMessage(i18n.aggregateCancelled);
      case 'neutral':
        return intl.formatMessage(i18n.aggregateNeutral);
      default:
        return intl.formatMessage(i18n.aggregateUnknown);
    }
  };

  const runLabel = (run: GitHubCiRun) => {
    switch (run.conclusion ?? run.status) {
      case 'queued':
      case 'requested':
        return intl.formatMessage(i18n.statusQueued);
      case 'in_progress':
        return intl.formatMessage(i18n.statusRunning);
      case 'waiting':
        return intl.formatMessage(i18n.statusWaiting);
      case 'pending':
        return intl.formatMessage(i18n.statusPending);
      case 'success':
        return intl.formatMessage(i18n.statusSuccess);
      case 'failure':
      case 'startup_failure':
      case 'stale':
        return intl.formatMessage(i18n.statusFailure);
      case 'cancelled':
        return intl.formatMessage(i18n.statusCancelled);
      case 'neutral':
        return intl.formatMessage(i18n.statusNeutral);
      case 'skipped':
        return intl.formatMessage(i18n.statusSkipped);
      case 'timed_out':
        return intl.formatMessage(i18n.statusTimedOut);
      case 'action_required':
        return intl.formatMessage(i18n.statusActionRequired);
      default:
        return intl.formatMessage(i18n.statusUnknown);
    }
  };

  return (
    <section className="flex min-h-full flex-col gap-3" aria-labelledby="github-ci-heading">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="github-ci-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4" aria-hidden="true" />
            {intl.formatMessage(i18n.title)}
          </h3>
          <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.description)}</p>
        </div>
        {workingDirectory && (
          <button
            type="button"
            disabled={interactionBusy || Boolean(rerunPreview) || Boolean(cancelPreview)}
            onClick={() => void loadStatus()}
            aria-label={intl.formatMessage(i18n.refresh)}
            title={intl.formatMessage(i18n.refresh)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border-primary text-text-secondary hover:bg-background-secondary hover:text-text-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <RefreshCw
              className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span className="sr-only">{intl.formatMessage(i18n.refresh)}</span>
          </button>
        )}
      </div>

      {workingDirectory && (workflowDispatchApi || api === defaultGitHubCiStatusPanelApi) && (
        <GitHubWorkflowDispatchPanel
          workingDirectory={workingDirectory}
          api={workflowDispatchApi}
          onAccepted={loadStatus}
        />
      )}

      {!workingDirectory && (
        <p className="rounded-md border border-dashed border-border-primary p-3 text-sm text-text-secondary">
          {intl.formatMessage(i18n.noProject)}
        </p>
      )}
      {isLoading && !status && (
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage(i18n.loading)}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
        >
          {intl.formatMessage(i18n.failed)}
        </p>
      )}
      {rerunError && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
        >
          {rerunError}
        </p>
      )}
      {rerunAccepted && (
        <p
          role="status"
          className="rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-800"
        >
          {intl.formatMessage(i18n.rerunAccepted)}
        </p>
      )}
      {cancelError && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
        >
          {cancelError}
        </p>
      )}
      {cancelAccepted && (
        <p
          role="status"
          className="rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-800"
        >
          {intl.formatMessage(i18n.cancelAccepted)}
        </p>
      )}

      {status && (
        <>
          <div className="rounded-md border border-border-primary bg-background-secondary p-3 text-xs">
            <p className="font-semibold text-text-primary">
              {aggregateLabel(status.aggregateStatus)}
            </p>
            <p className="mt-1 truncate text-text-primary">
              {status.repositoryOwner}/{status.repositoryName}
            </p>
            <p className="mt-1 flex items-center gap-1 text-text-secondary">
              <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="truncate">
                {status.branch} · {status.headSha.slice(0, 7)}
              </span>
            </p>
          </div>
          {status.workingTreeDirty && (
            <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {intl.formatMessage(i18n.dirty)}
            </p>
          )}
          {status.truncated && (
            <p className="text-xs text-text-secondary">
              {intl.formatMessage(i18n.truncated, {
                shown: status.runs.length,
                total: status.totalCount,
              })}
            </p>
          )}
          {status.runs.length === 0 ? (
            <p className="rounded-md border border-dashed border-border-primary p-3 text-sm text-text-secondary">
              {intl.formatMessage(i18n.noRuns)}
            </p>
          ) : (
            <ul className="grid gap-2">
              {status.runs.map((run) => {
                const canOpen = validRunUrl(status, run);
                const canRerun = eligibleForRerun(run);
                const canCancel = eligibleForCancel(run);
                return (
                  <li key={run.id} className="rounded-md border border-border-primary p-3 text-xs">
                    <p className="break-words font-medium text-text-primary">{run.name}</p>
                    <p className="mt-1 text-text-secondary">
                      {intl.formatMessage(i18n.runMeta, {
                        state: runLabel(run),
                        event: run.event,
                        attempt: run.attempt,
                      })}
                    </p>
                    {canOpen && (
                      <button
                        type="button"
                        onClick={() => void window.electron.openExternal(run.htmlUrl)}
                        aria-label={intl.formatMessage(i18n.openRun, {
                          name: run.name,
                          number: run.runNumber,
                        })}
                        className="mt-2 flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-border-primary px-2 text-text-primary hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />#{run.runNumber}
                      </button>
                    )}
                    {api.artifacts && workingDirectory && (
                      <GitHubCiArtifactsPanel
                        workingDirectory={workingDirectory}
                        status={status}
                        run={run}
                        load={api.artifacts}
                      />
                    )}
                    {canRerun && (
                      <button
                        type="button"
                        disabled={
                          interactionBusy || Boolean(rerunPreview) || Boolean(cancelPreview)
                        }
                        onClick={() => void previewRerun(run)}
                        aria-label={intl.formatMessage(i18n.rerunActionLabel, {
                          name: run.name,
                          number: run.runNumber,
                        })}
                        className="mt-2 flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-border-primary px-2 font-medium text-text-primary hover:bg-background-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        {previewingRunId === run.id ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {previewingRunId === run.id
                          ? intl.formatMessage(i18n.rerunPreviewing)
                          : intl.formatMessage(i18n.rerunAction)}
                      </button>
                    )}
                    {canCancel && (
                      <button
                        type="button"
                        disabled={
                          interactionBusy || Boolean(rerunPreview) || Boolean(cancelPreview)
                        }
                        onClick={() => void previewCancel(run)}
                        aria-label={intl.formatMessage(i18n.cancelActionLabel, {
                          name: run.name,
                          number: run.runNumber,
                        })}
                        className="mt-2 flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-red-300 px-2 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                      >
                        {previewingCancelRunId === run.id ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {previewingCancelRunId === run.id
                          ? intl.formatMessage(i18n.cancelPreviewing)
                          : intl.formatMessage(i18n.cancelAction)}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <GitHubCiRerunDialog
        preview={rerunPreview}
        busy={isRerunning}
        onCancel={cancelRerun}
        onConfirm={() => void rerunFailedJobs()}
      />
      <GitHubCiCancelDialog
        preview={cancelPreview}
        busy={isCancelling}
        onCancel={closeCancel}
        onConfirm={() => void cancelRun()}
      />
    </section>
  );
}
