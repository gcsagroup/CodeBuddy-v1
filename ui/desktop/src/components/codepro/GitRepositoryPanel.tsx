import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  GitCommitHorizontal,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Upload,
} from 'lucide-react';
import {
  abortGitConflict,
  commitStagedGitChanges,
  continueGitConflict,
  createGitBranch,
  loadGitHubRuntimeStatus,
  loadGitRuntimeStatus,
  loadGitRepository,
  previewGitPush,
  previewGitConflictAbort,
  previewGitRestore,
  pullGitBranch,
  pushGitBranch,
  restoreGitPaths,
  stageGitPaths,
  switchGitBranch,
  unstageGitPaths,
  GIT_CONFLICT_OPERATIONS,
  type GitPushPreview,
  type GitHubRuntimeStatus,
  type GitRepository,
  type GitRuntimeStatus,
  type GitConflictAbortPreview,
  type GitRestorePreview,
} from '../../acp/git';
import { defineMessages, useIntl } from '../../i18n';
import { cn } from '../../utils';
import { GitHubCliRecoveryActions } from './GitHubCliRecoveryActions';
import { ReviewPanel } from './review/ReviewPanel';

const i18n = defineMessages({
  title: { id: 'codeProGit.title', defaultMessage: 'Repository' },
  refresh: { id: 'codeProGit.refresh', defaultMessage: 'Refresh repository' },
  noProject: { id: 'codeProGit.noProject', defaultMessage: 'Select a project to inspect Git.' },
  loading: { id: 'codeProGit.loading', defaultMessage: 'Loading repository…' },
  gitRequired: {
    id: 'codeProGit.gitRequired',
    defaultMessage: 'Git is required for repository operations.',
  },
  gitMissingDetail: {
    id: 'codeProGit.gitMissingDetail',
    defaultMessage: 'CodeBuddy could not locate Git in its command environment. If Git is already installed, check its PATH or installation location and refresh. Otherwise, you can download it.',
  },
  downloadGit: { id: 'codeProGit.downloadGit', defaultMessage: 'Download Git' },
  confirmGitDownload: {
    id: 'codeProGit.confirmGitDownload',
    defaultMessage: 'Open the official Git download page in your browser?',
  },
  openDownloadPage: {
    id: 'codeProGit.openDownloadPage',
    defaultMessage: 'Open download page',
  },
  downloadOpened: {
    id: 'codeProGit.downloadOpened',
    defaultMessage: 'After installing Git, refresh the repository to check again.',
  },
  githubConnected: {
    id: 'codeProGit.githubConnected',
    defaultMessage: 'GitHub CLI is connected.',
  },
  githubUnauthenticated: {
    id: 'codeProGit.githubUnauthenticated',
    defaultMessage: 'GitHub CLI is not signed in.',
  },
  githubLoginHelp: {
    id: 'codeProGit.githubLoginHelp',
    defaultMessage: 'Run this command in a terminal to connect GitHub:',
  },
  githubCliMissing: {
    id: 'codeProGit.githubCliMissing',
    defaultMessage:
      'GitHub CLI is not installed. Git push and pull can still use Git; PR and Issue operations need GitHub CLI.',
  },
  githubCliInstallHelp: {
    id: 'codeProGit.githubCliInstallHelp',
    defaultMessage: 'Install GitHub CLI from:',
  },
  changes: { id: 'codeProGit.changes', defaultMessage: 'Changes' },
  staged: { id: 'codeProGit.staged', defaultMessage: 'Staged' },
  diff: { id: 'codeProGit.diff', defaultMessage: 'Working diff' },
  stagedDiff: { id: 'codeProGit.stagedDiff', defaultMessage: 'Staged diff' },
  clean: { id: 'codeProGit.clean', defaultMessage: 'Working tree is clean.' },
  sync: { id: 'codeProGit.sync', defaultMessage: '{ahead} outgoing · {behind} incoming' },
  stageSelected: { id: 'codeProGit.stageSelected', defaultMessage: 'Stage selected ({count})' },
  previewRestore: {
    id: 'codeProGit.previewRestore',
    defaultMessage: 'Preview restore ({count})',
  },
  confirmRestore: {
    id: 'codeProGit.confirmRestore',
    defaultMessage: 'Restore {count, plural, one {# selected path} other {# selected paths}}?',
  },
  restoreWarning: {
    id: 'codeProGit.restoreWarning',
    defaultMessage: 'This permanently discards the previewed working-tree changes.',
  },
  confirmRestoreAction: {
    id: 'codeProGit.confirmRestoreAction',
    defaultMessage: 'Confirm restore',
  },
  restoreBlocked: {
    id: 'codeProGit.restoreBlocked',
    defaultMessage: 'Restore is blocked: {reason}',
  },
  restoreDiffTruncated: {
    id: 'codeProGit.restoreDiffTruncated',
    defaultMessage: 'Displayed diff is truncated; the preflight hash covers the full diff.',
  },
  unstagePath: { id: 'codeProGit.unstagePath', defaultMessage: 'Unstage {path}' },
  localBranch: { id: 'codeProGit.localBranch', defaultMessage: 'Local branch' },
  switchBranch: { id: 'codeProGit.switchBranch', defaultMessage: 'Switch branch' },
  newBranchName: { id: 'codeProGit.newBranchName', defaultMessage: 'New branch name' },
  createBranch: { id: 'codeProGit.createBranch', defaultMessage: 'Create branch' },
  selectPath: { id: 'codeProGit.selectPath', defaultMessage: 'Select {path}' },
  commitMessage: { id: 'codeProGit.commitMessage', defaultMessage: 'Commit message' },
  commitScope: {
    id: 'codeProGit.commitScope',
    defaultMessage: 'Commit {count, plural, one {# staged file} other {# staged files}}',
  },
  pull: { id: 'codeProGit.pull', defaultMessage: 'Pull' },
  push: { id: 'codeProGit.push', defaultMessage: 'Push' },
  confirmPull: {
    id: 'codeProGit.confirmPull',
    defaultMessage: 'Pull {branch} with fast-forward only?',
  },
  confirmPush: {
    id: 'codeProGit.confirmPush',
    defaultMessage:
      'Push {count} {count, plural, one {commit} other {commits}} to {remote}/{branch}?',
  },
  confirm: { id: 'codeProGit.confirm', defaultMessage: 'Confirm push' },
  confirmPullAction: { id: 'codeProGit.confirmPullAction', defaultMessage: 'Confirm pull' },
  cancel: { id: 'codeProGit.cancel', defaultMessage: 'Cancel' },
  blocked: { id: 'codeProGit.blocked', defaultMessage: 'Push is blocked: {reason}' },
  detachedHead: {
    id: 'codeProGit.detachedHead',
    defaultMessage: 'Create or switch to a branch before committing, pulling, or pushing.',
  },
  completed: { id: 'codeProGit.completed', defaultMessage: 'Git operation completed.' },
  review: { id: 'codeProGit.review', defaultMessage: 'Review changes' },
  closeReview: { id: 'codeProGit.closeReview', defaultMessage: 'Close review' },
  conflictState: {
    id: 'codeProGit.conflictState',
    defaultMessage:
      '{operation} in progress · {count, plural, one {# unresolved conflict} other {# unresolved conflicts}}',
  },
  conflictUnsupported: {
    id: 'codeProGit.conflictUnsupported',
    defaultMessage:
      'This operation is visible, but safe continue and abort actions are unavailable.',
  },
  continueOperation: {
    id: 'codeProGit.continueOperation',
    defaultMessage: 'Continue {operation}',
  },
  previewAbort: { id: 'codeProGit.previewAbort', defaultMessage: 'Preview abort' },
  confirmAbort: {
    id: 'codeProGit.confirmAbort',
    defaultMessage: 'Abort {operation} and restore its pre-operation state?',
  },
  abortWarning: {
    id: 'codeProGit.abortWarning',
    defaultMessage:
      'This can discard conflict resolutions and other changes made during the operation.',
  },
  confirmAbortAction: { id: 'codeProGit.confirmAbortAction', defaultMessage: 'Confirm abort' },
  abortBlocked: {
    id: 'codeProGit.abortBlocked',
    defaultMessage: 'Abort is blocked: {reason}',
  },
  conflictWorkingDiff: {
    id: 'codeProGit.conflictWorkingDiff',
    defaultMessage: 'Working-tree conflict diff',
  },
  conflictStagedDiff: {
    id: 'codeProGit.conflictStagedDiff',
    defaultMessage: 'Staged conflict diff',
  },
  operationMerge: { id: 'codeProGit.operationMerge', defaultMessage: 'merge' },
  operationRebase: { id: 'codeProGit.operationRebase', defaultMessage: 'rebase' },
  operationCherryPick: { id: 'codeProGit.operationCherryPick', defaultMessage: 'cherry-pick' },
  operationRevert: { id: 'codeProGit.operationRevert', defaultMessage: 'revert' },
});

export interface GitRepositoryPanelApi {
  runtimeStatus: typeof loadGitRuntimeStatus;
  githubStatus: typeof loadGitHubRuntimeStatus;
  load: typeof loadGitRepository;
  stage: typeof stageGitPaths;
  unstage: typeof unstageGitPaths;
  restorePreview: typeof previewGitRestore;
  restore: typeof restoreGitPaths;
  continueConflict: typeof continueGitConflict;
  conflictAbortPreview: typeof previewGitConflictAbort;
  abortConflict: typeof abortGitConflict;
  createBranch: typeof createGitBranch;
  switchBranch: typeof switchGitBranch;
  commit: typeof commitStagedGitChanges;
  pull: typeof pullGitBranch;
  pushPreview: typeof previewGitPush;
  push: typeof pushGitBranch;
}

const defaultApi: GitRepositoryPanelApi = {
  runtimeStatus: loadGitRuntimeStatus,
  githubStatus: loadGitHubRuntimeStatus,
  load: loadGitRepository,
  stage: stageGitPaths,
  unstage: unstageGitPaths,
  restorePreview: previewGitRestore,
  restore: restoreGitPaths,
  continueConflict: continueGitConflict,
  conflictAbortPreview: previewGitConflictAbort,
  abortConflict: abortGitConflict,
  createBranch: createGitBranch,
  switchBranch: switchGitBranch,
  commit: commitStagedGitChanges,
  pull: pullGitBranch,
  pushPreview: previewGitPush,
  push: pushGitBranch,
};

interface GitRepositoryPanelProps {
  sessionId: string;
  workingDirectory?: string;
  api?: GitRepositoryPanelApi;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GitRepositoryPanel({
  sessionId,
  workingDirectory,
  api = defaultApi,
}: GitRepositoryPanelProps) {
  const intl = useIntl();
  const [repository, setRepository] = useState<GitRepository>();
  const [runtime, setRuntime] = useState<GitRuntimeStatus>();
  const [githubRuntime, setGitHubRuntime] = useState<GitHubRuntimeStatus>();
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pushPreview, setPushPreview] = useState<GitPushPreview>();
  const [restorePreview, setRestorePreview] = useState<GitRestorePreview>();
  const [conflictAbortPreview, setConflictAbortPreview] = useState<GitConflictAbortPreview>();
  const [confirmingPull, setConfirmingPull] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmingGitDownload, setConfirmingGitDownload] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId || !workingDirectory) return;
    setBusy(true);
    setError(undefined);
    try {
      const nextRuntime = await api.runtimeStatus(sessionId);
      setRuntime(nextRuntime);
      if (!nextRuntime.available) {
        setRepository(undefined);
        setGitHubRuntime(undefined);
        return;
      }
      const [nextRepository, nextGitHubRuntime] = await Promise.all([
        api.load(sessionId),
        api.githubStatus(sessionId).catch(() => undefined),
      ]);
      setRepository(nextRepository);
      setGitHubRuntime(nextGitHubRuntime);
      setSelectedPaths([]);
      setRestorePreview(undefined);
      setConflictAbortPreview(undefined);
    } catch (loadError) {
      setRepository(undefined);
      setError(errorMessage(loadError));
    } finally {
      setBusy(false);
    }
  }, [api, sessionId, workingDirectory]);

  useEffect(() => {
    setRepository(undefined);
    setRuntime(undefined);
    setGitHubRuntime(undefined);
    setSelectedPaths([]);
    setCommitMessage('');
    setNewBranchName('');
    setSelectedBranch('');
    setPushPreview(undefined);
    setRestorePreview(undefined);
    setConflictAbortPreview(undefined);
    setConfirmingPull(false);
    setNotice(undefined);
    setConfirmingGitDownload(false);
    void refresh();
  }, [refresh]);

  const stagedCount = useMemo(
    () =>
      repository?.status.entries.filter(
        (entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?'
      ).length ?? 0,
    [repository]
  );
  const conflictOperation = repository?.conflicts.operation ?? 'none';
  const conflictOperationActive = conflictOperation !== 'none';
  const actionableConflictOperation = GIT_CONFLICT_OPERATIONS.find(
    (operation) => operation === conflictOperation
  );
  const conflictOperationName = (() => {
    switch (conflictOperation) {
      case 'merge':
        return intl.formatMessage(i18n.operationMerge);
      case 'rebase':
        return intl.formatMessage(i18n.operationRebase);
      case 'cherry_pick':
        return intl.formatMessage(i18n.operationCherryPick);
      case 'revert':
        return intl.formatMessage(i18n.operationRevert);
      default:
        return conflictOperation.replace(/_/g, '-');
    }
  })();
  const conflictOperationLabel =
    conflictOperationName.charAt(0).toUpperCase() + conflictOperationName.slice(1);
  const upstreamTarget = useMemo(() => {
    const upstream = repository?.status.upstream;
    if (!upstream) return undefined;
    const separator = upstream.indexOf('/');
    if (separator <= 0 || separator === upstream.length - 1) return undefined;
    return {
      remote: upstream.slice(0, separator),
      branch: upstream.slice(separator + 1),
      upstream,
    };
  }, [repository]);

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await operation();
      setNotice(intl.formatMessage(i18n.completed));
      setCommitMessage('');
      setNewBranchName('');
      setSelectedBranch('');
      setPushPreview(undefined);
      setRestorePreview(undefined);
      setConflictAbortPreview(undefined);
      setConfirmingPull(false);
      await refresh();
    } catch (operationError) {
      setError(errorMessage(operationError));
      setBusy(false);
    }
  };

  if (!workingDirectory || !sessionId) {
    return <p className="text-sm text-text-secondary">{intl.formatMessage(i18n.noProject)}</p>;
  }

  return (
    <section className="space-y-3" aria-label={intl.formatMessage(i18n.title)}>
      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">
            {intl.formatMessage(i18n.title)}
          </h3>
          {repository && (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <span className="truncate font-medium text-text-primary">
                {repository.status.branch || 'HEAD'}
              </span>
              <span>
                {intl.formatMessage(i18n.sync, {
                  ahead: repository.status.ahead,
                  behind: repository.status.behind,
                })}
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label={intl.formatMessage(i18n.refresh)}
          className="rounded-md border border-border-primary p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden="true" />
        </button>
      </header>

      {busy && !runtime && (
        <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.loading)}</p>
      )}
      {runtime && !runtime.available && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100">
          <p className="font-medium">{intl.formatMessage(i18n.gitRequired)}</p>
          <p>{intl.formatMessage(i18n.gitMissingDetail)}</p>
          {confirmingGitDownload ? (
            <div className="space-y-2">
              <p>{intl.formatMessage(i18n.confirmGitDownload)}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setError(undefined);
                    void window.electron
                      .openExternal(runtime.installUrl)
                      .then(() => setNotice(intl.formatMessage(i18n.downloadOpened)))
                      .catch((openError) => setError(errorMessage(openError)));
                    setConfirmingGitDownload(false);
                  }}
                  className="rounded border border-amber-600/50 px-2 py-1 font-medium"
                >
                  {intl.formatMessage(i18n.openDownloadPage)}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingGitDownload(false)}
                  className="rounded border border-border-primary px-2 py-1"
                >
                  {intl.formatMessage(i18n.cancel)}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingGitDownload(true)}
              className="rounded border border-amber-600/50 px-2 py-1 font-medium"
            >
              {intl.formatMessage(i18n.downloadGit)}
            </button>
          )}
        </div>
      )}
      {runtime?.available && githubRuntime && (
        <div className="space-y-1 rounded-md border border-border-primary p-2 text-xs text-text-secondary">
          {githubRuntime.authenticated ? (
            <p className="font-medium text-green-700 dark:text-green-300">
              {intl.formatMessage(i18n.githubConnected)}
            </p>
          ) : githubRuntime.available ? (
            <>
              <p className="font-medium text-amber-700 dark:text-amber-300">
                {intl.formatMessage(i18n.githubUnauthenticated)}
              </p>
              <GitHubCliRecoveryActions state="not_authenticated" />
            </>
          ) : (
            <>
              <p>{intl.formatMessage(i18n.githubCliMissing)}</p>
              <p>
                {intl.formatMessage(i18n.githubCliInstallHelp)}{' '}
                <code className="text-text-primary">{githubRuntime.installUrl}</code>
              </p>
              <GitHubCliRecoveryActions state="unavailable" />
            </>
          )}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{error}</span>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-green-700 dark:text-green-300">
          {notice}
        </p>
      )}
      {repository?.status.detached && (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{intl.formatMessage(i18n.detachedHead)}</span>
        </div>
      )}

      {repository && conflictOperationActive && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <p className="font-medium text-amber-800 dark:text-amber-200">
            {intl.formatMessage(i18n.conflictState, {
              operation: conflictOperationLabel,
              count: repository.conflicts.totalConflicts,
            })}
          </p>
          {repository.conflicts.conflicts.length > 0 && (
            <ul className="space-y-1 font-mono text-text-secondary">
              {repository.conflicts.conflicts.map((conflict) => (
                <li key={conflict.path}>
                  {conflict.path} · {conflict.code}
                </li>
              ))}
            </ul>
          )}
          {!actionableConflictOperation && (
            <p className="text-text-secondary">{intl.formatMessage(i18n.conflictUnsupported)}</p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy || !actionableConflictOperation || repository.conflicts.hasConflicts}
              onClick={() =>
                actionableConflictOperation &&
                void execute(() => api.continueConflict(sessionId, actionableConflictOperation))
              }
              className="rounded border border-border-primary px-2 py-1 disabled:opacity-50"
            >
              {intl.formatMessage(i18n.continueOperation, {
                operation: conflictOperationName,
              })}
            </button>
            <button
              type="button"
              disabled={busy || !actionableConflictOperation}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                setNotice(undefined);
                void api
                  .conflictAbortPreview(sessionId)
                  .then((preview) => setConflictAbortPreview(preview))
                  .catch((previewError) => setError(errorMessage(previewError)))
                  .finally(() => setBusy(false));
              }}
              className="rounded border border-red-500/40 px-2 py-1 text-red-700 disabled:opacity-50 dark:text-red-300"
            >
              {intl.formatMessage(i18n.previewAbort)}
            </button>
          </div>
        </div>
      )}

      {repository && (
        <div className="space-y-2 rounded-md border border-border-primary p-2">
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="codepro-git-local-branch">
              {intl.formatMessage(i18n.localBranch)}
            </label>
            <select
              id="codepro-git-local-branch"
              aria-label={intl.formatMessage(i18n.localBranch)}
              value={selectedBranch}
              onChange={(event) => setSelectedBranch(event.target.value)}
              disabled={busy || conflictOperationActive}
              className="min-w-0 flex-1 rounded border border-border-primary bg-background-primary px-2 py-1 text-xs text-text-primary"
            >
              <option value="">{repository.status.branch || 'HEAD'}</option>
              {repository.branches.branches
                .filter((branch) => !branch.remote && !branch.current)
                .map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={busy || conflictOperationActive || !selectedBranch}
              onClick={() => void execute(() => api.switchBranch(sessionId, selectedBranch))}
              className="rounded border border-border-primary px-2 py-1 text-xs disabled:opacity-50"
            >
              {intl.formatMessage(i18n.switchBranch)}
            </button>
          </div>
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="codepro-git-new-branch">
              {intl.formatMessage(i18n.newBranchName)}
            </label>
            <input
              id="codepro-git-new-branch"
              aria-label={intl.formatMessage(i18n.newBranchName)}
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.target.value)}
              placeholder={intl.formatMessage(i18n.newBranchName)}
              disabled={busy || conflictOperationActive}
              className="min-w-0 flex-1 rounded border border-border-primary bg-background-primary px-2 py-1 text-xs text-text-primary"
            />
            <button
              type="button"
              disabled={busy || conflictOperationActive || !newBranchName.trim()}
              onClick={() => void execute(() => api.createBranch(sessionId, newBranchName.trim()))}
              className="rounded border border-border-primary px-2 py-1 text-xs disabled:opacity-50"
            >
              {intl.formatMessage(i18n.createBranch)}
            </button>
          </div>
        </div>
      )}

      {repository && (
        <button
          type="button"
          aria-expanded={reviewOpen}
          onClick={() => setReviewOpen((current) => !current)}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-border-primary px-2 py-1.5 text-xs font-medium"
        >
          <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
          {intl.formatMessage(reviewOpen ? i18n.closeReview : i18n.review)}
        </button>
      )}

      {reviewOpen && <ReviewPanel sessionId={sessionId} visible={reviewOpen} />}

      {repository && (
        <>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmingPull(true)}
              disabled={
                busy || conflictOperationActive || repository.status.detached || !upstreamTarget
              }
              className="rounded-md border border-border-primary px-2 py-1 text-xs disabled:opacity-50"
            >
              {intl.formatMessage(i18n.pull)}
            </button>
            <button
              type="button"
              onClick={() => {
                setBusy(true);
                setError(undefined);
                if (!upstreamTarget) return;
                void api
                  .pushPreview(sessionId, {
                    remote: upstreamTarget.remote,
                    branch: upstreamTarget.branch,
                  })
                  .then((preview) => setPushPreview(preview))
                  .catch((previewError) => setError(errorMessage(previewError)))
                  .finally(() => setBusy(false));
              }}
              disabled={
                busy || conflictOperationActive || repository.status.detached || !upstreamTarget
              }
              className="flex items-center gap-1 rounded-md border border-border-primary px-2 py-1 text-xs disabled:opacity-50"
            >
              <Upload className="h-3 w-3" aria-hidden="true" />
              {intl.formatMessage(i18n.push)}
            </button>
          </div>

          <div>
            <h4 className="mb-1 text-xs font-semibold text-text-primary">
              {intl.formatMessage(i18n.changes)}
            </h4>
            {repository.status.entries.length === 0 ? (
              <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.clean)}</p>
            ) : (
              <ul className="space-y-1">
                {repository.status.entries.map((entry) => {
                  const selectable = entry.worktreeStatus !== ' ';
                  return (
                    <li
                      key={`${entry.path}:${entry.indexStatus}:${entry.worktreeStatus}`}
                      className="flex min-w-0 items-center gap-2 rounded border border-border-primary px-2 py-1 text-xs"
                    >
                      {selectable ? (
                        <input
                          type="checkbox"
                          aria-label={intl.formatMessage(i18n.selectPath, { path: entry.path })}
                          checked={selectedPaths.includes(entry.path)}
                          disabled={busy}
                          onChange={(event) =>
                            setSelectedPaths((current) =>
                              event.target.checked
                                ? [...current, entry.path]
                                : current.filter((path) => path !== entry.path)
                            )
                          }
                        />
                      ) : (
                        <GitCommitHorizontal
                          className="h-3.5 w-3.5 text-green-600"
                          aria-label={intl.formatMessage(i18n.staged)}
                        />
                      )}
                      <span className="truncate text-text-primary">{entry.path}</span>
                      {entry.indexStatus !== ' ' && entry.indexStatus !== '?' && (
                        <button
                          type="button"
                          aria-label={intl.formatMessage(i18n.unstagePath, { path: entry.path })}
                          disabled={busy}
                          onClick={() => void execute(() => api.unstage(sessionId, [entry.path]))}
                          className="rounded border border-border-primary px-1.5 py-0.5 text-[10px] disabled:opacity-50"
                        >
                          −
                        </button>
                      )}
                      <span className="ml-auto font-mono text-text-secondary">
                        {entry.indexStatus}
                        {entry.worktreeStatus}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy || selectedPaths.length === 0}
              onClick={() => void execute(() => api.stage(sessionId, selectedPaths))}
              className="rounded-md border border-border-primary px-2 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {intl.formatMessage(i18n.stageSelected, { count: selectedPaths.length })}
            </button>
            <button
              type="button"
              disabled={busy || conflictOperationActive || selectedPaths.length === 0}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                setNotice(undefined);
                setPushPreview(undefined);
                setConfirmingPull(false);
                void api
                  .restorePreview(sessionId, selectedPaths)
                  .then((preview) => setRestorePreview(preview))
                  .catch((previewError) => setError(errorMessage(previewError)))
                  .finally(() => setBusy(false));
              }}
              className="flex items-center justify-center gap-1 rounded-md border border-red-500/40 px-2 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50 dark:text-red-300"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {intl.formatMessage(i18n.previewRestore, { count: selectedPaths.length })}
            </button>
          </div>

          <div className="space-y-1.5 rounded-md border border-border-primary p-2">
            <label
              htmlFor="codepro-git-commit-message"
              className="text-xs font-medium text-text-primary"
            >
              {intl.formatMessage(i18n.commitMessage)}
            </label>
            <textarea
              id="codepro-git-commit-message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              rows={2}
              maxLength={4096}
              disabled={repository.status.detached || conflictOperationActive}
              className="w-full resize-y rounded border border-border-primary bg-background-primary p-2 text-xs text-text-primary"
            />
            <button
              type="button"
              disabled={
                busy ||
                conflictOperationActive ||
                repository.status.detached ||
                stagedCount === 0 ||
                commitMessage.trim().length === 0
              }
              onClick={() => void execute(() => api.commit(sessionId, commitMessage.trim()))}
              className="w-full rounded-md bg-text-primary px-2 py-1.5 text-xs font-medium text-background-primary disabled:opacity-50"
            >
              {intl.formatMessage(i18n.commitScope, { count: stagedCount })}
            </button>
          </div>

          <details>
            <summary className="cursor-pointer text-xs font-semibold text-text-primary">
              {intl.formatMessage(i18n.diff)}
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background-secondary p-2 text-[11px] text-text-secondary">
              {repository.diff.text || intl.formatMessage(i18n.clean)}
            </pre>
          </details>
          <details>
            <summary className="cursor-pointer text-xs font-semibold text-text-primary">
              {intl.formatMessage(i18n.stagedDiff)}
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background-secondary p-2 text-[11px] text-text-secondary">
              {repository.stagedDiff.text || intl.formatMessage(i18n.clean)}
            </pre>
          </details>
        </>
      )}

      {confirmingPull && repository && (
        <div
          role="dialog"
          aria-modal="true"
          className="space-y-2 rounded-md border border-border-primary bg-background-secondary p-3 text-xs"
        >
          <p>
            {intl.formatMessage(i18n.confirmPull, {
              branch: upstreamTarget?.upstream ?? repository.status.branch,
            })}
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmingPull(false)}>
              {intl.formatMessage(i18n.cancel)}
            </button>
            <button
              type="button"
              disabled={!upstreamTarget}
              onClick={() =>
                upstreamTarget &&
                void execute(() =>
                  api.pull(sessionId, {
                    remote: upstreamTarget.remote,
                    branch: upstreamTarget.branch,
                  })
                )
              }
              className="rounded bg-text-primary px-2 py-1 text-background-primary"
            >
              {intl.formatMessage(i18n.confirmPullAction)}
            </button>
          </div>
        </div>
      )}

      {restorePreview && (
        <div
          role="dialog"
          aria-modal="true"
          className="space-y-2 rounded-md border border-red-500/40 bg-background-secondary p-3 text-xs"
        >
          {restorePreview.blockedReasons.length > 0 ? (
            <p role="alert">
              {intl.formatMessage(i18n.restoreBlocked, {
                reason: restorePreview.blockedReasons.join('; '),
              })}
            </p>
          ) : (
            <>
              <p className="font-medium text-red-700 dark:text-red-300">
                {intl.formatMessage(i18n.confirmRestore, {
                  count: restorePreview.changedPaths.length,
                })}
              </p>
              <p className="text-text-secondary">{intl.formatMessage(i18n.restoreWarning)}</p>
            </>
          )}
          <ul className="max-h-24 overflow-auto font-mono text-text-secondary">
            {restorePreview.changedPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background-primary p-2 text-[11px] text-text-secondary">
            {restorePreview.diff}
          </pre>
          {restorePreview.diffTruncated && (
            <p className="text-text-secondary">{intl.formatMessage(i18n.restoreDiffTruncated)}</p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRestorePreview(undefined)}>
              {intl.formatMessage(i18n.cancel)}
            </button>
            <button
              type="button"
              disabled={restorePreview.blockedReasons.length > 0 || busy}
              onClick={() => void execute(() => api.restore(sessionId, restorePreview))}
              className="rounded bg-red-700 px-2 py-1 text-white disabled:opacity-50"
            >
              {intl.formatMessage(i18n.confirmRestoreAction)}
            </button>
          </div>
        </div>
      )}

      {conflictAbortPreview && (
        <div
          role="dialog"
          aria-modal="true"
          className="space-y-2 rounded-md border border-red-500/40 bg-background-secondary p-3 text-xs"
        >
          {conflictAbortPreview.blockedReasons.length > 0 ? (
            <p role="alert">
              {intl.formatMessage(i18n.abortBlocked, {
                reason: conflictAbortPreview.blockedReasons.join('; '),
              })}
            </p>
          ) : (
            <>
              <p className="font-medium text-red-700 dark:text-red-300">
                {intl.formatMessage(i18n.confirmAbort, {
                  operation: conflictOperationName,
                })}
              </p>
              <p className="text-text-secondary">{intl.formatMessage(i18n.abortWarning)}</p>
            </>
          )}
          <ul className="max-h-24 overflow-auto font-mono text-text-secondary">
            {conflictAbortPreview.changedPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <details open={Boolean(conflictAbortPreview.workingDiff)}>
            <summary>{intl.formatMessage(i18n.conflictWorkingDiff)}</summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background-primary p-2 text-[11px] text-text-secondary">
              {conflictAbortPreview.workingDiff}
            </pre>
          </details>
          <details open={Boolean(conflictAbortPreview.stagedDiff)}>
            <summary>{intl.formatMessage(i18n.conflictStagedDiff)}</summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background-primary p-2 text-[11px] text-text-secondary">
              {conflictAbortPreview.stagedDiff}
            </pre>
          </details>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConflictAbortPreview(undefined)}>
              {intl.formatMessage(i18n.cancel)}
            </button>
            <button
              type="button"
              disabled={conflictAbortPreview.blockedReasons.length > 0 || busy}
              onClick={() => void execute(() => api.abortConflict(sessionId, conflictAbortPreview))}
              className="rounded bg-red-700 px-2 py-1 text-white disabled:opacity-50"
            >
              {intl.formatMessage(i18n.confirmAbortAction)}
            </button>
          </div>
        </div>
      )}

      {pushPreview && (
        <div
          role="dialog"
          aria-modal="true"
          className="space-y-2 rounded-md border border-border-primary bg-background-secondary p-3 text-xs"
        >
          {pushPreview.blockedReasons.length > 0 ? (
            <p role="alert">
              {intl.formatMessage(i18n.blocked, { reason: pushPreview.blockedReasons.join('; ') })}
            </p>
          ) : (
            <p>
              {intl.formatMessage(i18n.confirmPush, {
                count: pushPreview.outgoingCommitCount,
                remote: pushPreview.remote,
                branch: pushPreview.branch,
              })}
            </p>
          )}
          <p className="break-all text-text-secondary">{pushPreview.remoteDestination}</p>
          <ul className="max-h-28 overflow-auto text-text-secondary">
            {pushPreview.outgoingCommits.map((commit) => (
              <li key={commit.id}>
                {commit.id.slice(0, 8)} · {commit.subject}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPushPreview(undefined)}>
              {intl.formatMessage(i18n.cancel)}
            </button>
            <button
              type="button"
              disabled={pushPreview.blockedReasons.length > 0 || busy}
              onClick={() =>
                void execute(() =>
                  api.push(sessionId, {
                    remote: pushPreview.remote,
                    branch: pushPreview.branch,
                    preflightId: pushPreview.preflightId,
                  })
                )
              }
              className="rounded bg-text-primary px-2 py-1 text-background-primary disabled:opacity-50"
            >
              {intl.formatMessage(i18n.confirm)}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
