import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { v7 as uuidv7 } from 'uuid';
import {
  acpChangeGitHubIssueState,
  acpCreateGitHubIssue,
  acpListGitHubIssues,
  acpPreviewGitHubIssueContent,
  acpPreviewGitHubIssueCreate,
  acpPreviewGitHubIssueState,
  acpUpdateGitHubIssueContent,
  type GitHubIssue,
  type GitHubIssueContentPreviewResponse,
  type GitHubIssueCreatePreviewResponse,
  type GitHubIssueStatePreviewResponse,
} from '../../acp/githubIssues';
import { defineMessages, useIntl } from '../../i18n';
import { ConfirmationModal } from '../ui/ConfirmationModal';

const i18n = defineMessages({
  title: { id: 'githubIssues.title', defaultMessage: 'Issues' },
  refresh: { id: 'githubIssues.refresh', defaultMessage: 'Refresh Issues' },
  create: { id: 'githubIssues.create', defaultMessage: 'Create Issue' },
  empty: { id: 'githubIssues.empty', defaultMessage: 'No Issues were reported.' },
  issue: { id: 'githubIssues.issue', defaultMessage: 'Issue #{number}' },
  edit: { id: 'githubIssues.edit', defaultMessage: 'Edit Issue #{number}' },
  close: { id: 'githubIssues.close', defaultMessage: 'Close Issue #{number}' },
  reopen: { id: 'githubIssues.reopen', defaultMessage: 'Reopen Issue #{number}' },
  open: { id: 'githubIssues.open', defaultMessage: 'Open Issue #{number} on GitHub' },
  titleLabel: { id: 'githubIssues.titleLabel', defaultMessage: 'Issue title' },
  bodyLabel: { id: 'githubIssues.bodyLabel', defaultMessage: 'Issue description' },
  cancel: { id: 'githubIssues.cancel', defaultMessage: 'Cancel' },
  createTitle: { id: 'githubIssues.createTitle', defaultMessage: 'Create GitHub Issue' },
  editTitle: { id: 'githubIssues.editTitle', defaultMessage: 'Edit GitHub Issue' },
  stateTitle: { id: 'githubIssues.stateTitle', defaultMessage: 'Confirm Issue state change' },
  createMessage: {
    id: 'githubIssues.createMessage',
    defaultMessage:
      'Enter the Issue content, run a fresh preflight, then confirm the GitHub write.',
  },
  editMessage: {
    id: 'githubIssues.editMessage',
    defaultMessage: 'Edit the Issue content, run a fresh preflight, then confirm the GitHub write.',
  },
  stateMessage: {
    id: 'githubIssues.stateMessage',
    defaultMessage: 'Run a fresh preflight, then confirm the GitHub state change.',
  },
  createPreflight: {
    id: 'githubIssues.createPreflight',
    defaultMessage: 'Run create preflight',
  },
  updatePreflight: {
    id: 'githubIssues.updatePreflight',
    defaultMessage: 'Run update preflight',
  },
  statePreflight: {
    id: 'githubIssues.statePreflight',
    defaultMessage: 'Run state preflight',
  },
  createConfirm: { id: 'githubIssues.createConfirm', defaultMessage: 'Create on GitHub' },
  updateConfirm: { id: 'githubIssues.updateConfirm', defaultMessage: 'Update on GitHub' },
  closeConfirm: { id: 'githubIssues.closeConfirm', defaultMessage: 'Close on GitHub' },
  reopenConfirm: { id: 'githubIssues.reopenConfirm', defaultMessage: 'Reopen on GitHub' },
  warning: {
    id: 'githubIssues.warning',
    defaultMessage: 'The next confirmation writes Issue #{number} on GitHub.',
  },
  createWarning: {
    id: 'githubIssues.createWarning',
    defaultMessage: 'The next confirmation creates this Issue on GitHub.',
  },
  failed: { id: 'githubIssues.failed', defaultMessage: 'GitHub Issues could not be refreshed.' },
  previewFailed: {
    id: 'githubIssues.previewFailed',
    defaultMessage: 'Issue preflight failed.',
  },
  writeFailed: {
    id: 'githubIssues.writeFailed',
    defaultMessage: 'GitHub did not update the Issue.',
  },
  uncertain: {
    id: 'githubIssues.uncertain',
    defaultMessage: 'The remote result is uncertain. Inspect Issues on GitHub before retrying.',
  },
});

type DialogMode = 'create' | 'content' | 'state';
type IssueTargetState = 'open' | 'closed';

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const data = 'data' in error ? error.data : undefined;
  if (!data || typeof data !== 'object' || !('code' in data)) return undefined;
  return typeof data.code === 'string' ? data.code : undefined;
}

function validPreflight(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function repositoryIdentity(
  value: string
): { owner: string; name: string; pathname: string } | undefined {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      segments.length === 2 &&
      segments.every(
        (segment) => /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..'
      )
    ) {
      return { owner: segments[0], name: segments[1], pathname: `/${segments.join('/')}` };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function validIssue(issue: GitHubIssue, repositoryUrl: string): boolean {
  const repository = repositoryIdentity(repositoryUrl);
  if (
    !repository ||
    issue.number <= 0 ||
    !issue.title.trim() ||
    issue.title.length > 256 ||
    issue.body.length > 65_536 ||
    (issue.state !== 'open' && issue.state !== 'closed')
  ) {
    return false;
  }
  try {
    const url = new URL(issue.url);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.toLowerCase() === `${repository.pathname}/issues/${issue.number}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

function sameIssue(left: GitHubIssue, right: GitHubIssue): boolean {
  return (
    left.number === right.number &&
    left.title === right.title &&
    left.body === right.body &&
    left.state === right.state &&
    left.url === right.url
  );
}

export function GitHubIssuesPanel({ workingDirectory }: { workingDirectory: string }) {
  const intl = useIntl();
  const requestId = useRef(0);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [mode, setMode] = useState<DialogMode>();
  const [selected, setSelected] = useState<GitHubIssue>();
  const [targetState, setTargetState] = useState<IssueTargetState>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [createOperationId, setCreateOperationId] = useState('');
  const [createPreview, setCreatePreview] = useState<GitHubIssueCreatePreviewResponse>();
  const [contentPreview, setContentPreview] = useState<GitHubIssueContentPreviewResponse>();
  const [statePreview, setStatePreview] = useState<GitHubIssueStatePreviewResponse>();
  const [dialogError, setDialogError] = useState<string>();

  const refresh = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    setError(undefined);
    try {
      const response = await acpListGitHubIssues({ workingDir: workingDirectory });
      if (current !== requestId.current) return;
      if (
        !repositoryIdentity(response.repositoryUrl) ||
        response.issues.length > 20 ||
        new Set(response.issues.map((issue) => issue.number)).size !== response.issues.length ||
        response.issues.some((issue) => !validIssue(issue, response.repositoryUrl))
      ) {
        throw new Error('invalid issue response');
      }
      setRepositoryUrl(response.repositoryUrl);
      setIssues(response.issues);
    } catch {
      if (current === requestId.current) {
        setIssues([]);
        setError(intl.formatMessage(i18n.failed));
      }
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [intl, workingDirectory]);

  useEffect(() => {
    setUncertain(false);
    setMode(undefined);
    void refresh();
    return () => {
      requestId.current += 1;
    };
  }, [refresh]);

  const clearPreviews = () => {
    setCreatePreview(undefined);
    setContentPreview(undefined);
    setStatePreview(undefined);
    setDialogError(undefined);
  };

  const closeDialog = () => {
    if (submitting) return;
    setMode(undefined);
    setSelected(undefined);
    setTargetState(undefined);
    clearPreviews();
  };

  const openCreate = () => {
    setCreateOperationId(uuidv7());
    setTitle('');
    setBody('');
    setSelected(undefined);
    setTargetState(undefined);
    clearPreviews();
    setMode('create');
  };

  const openContent = (issue: GitHubIssue) => {
    setTitle(issue.title);
    setBody(issue.body);
    setSelected(issue);
    setTargetState(undefined);
    clearPreviews();
    setMode('content');
  };

  const openState = (issue: GitHubIssue, state: IssueTargetState) => {
    setSelected(issue);
    setTitle(issue.title);
    setBody(issue.body);
    setTargetState(state);
    clearPreviews();
    setMode('state');
  };

  const edit = (setValue: () => void) => {
    setValue();
    clearPreviews();
  };

  const preview = async () => {
    setSubmitting(true);
    setDialogError(undefined);
    try {
      if (mode === 'create') {
        const response = await acpPreviewGitHubIssueCreate({
          workingDir: workingDirectory,
          operationId: createOperationId,
          title,
          body,
        });
        if (
          !validPreflight(response.preflightId) ||
          response.operationId !== createOperationId ||
          response.repositoryUrl !== repositoryUrl ||
          response.repositoryOwner !== repositoryIdentity(repositoryUrl)?.owner ||
          response.repositoryName !== repositoryIdentity(repositoryUrl)?.name ||
          response.title !== title ||
          response.body !== body
        ) {
          throw new Error('invalid create preview');
        }
        setCreatePreview(response);
      } else if (mode === 'content' && selected) {
        const response = await acpPreviewGitHubIssueContent({
          workingDir: workingDirectory,
          number: selected.number,
          title,
          body,
        });
        if (
          !validPreflight(response.preflightId) ||
          !sameIssue(response.currentIssue, selected) ||
          response.targetTitle !== title ||
          response.targetBody !== body
        ) {
          throw new Error('invalid content preview');
        }
        setContentPreview(response);
      } else if (mode === 'state' && selected && targetState) {
        const response = await acpPreviewGitHubIssueState({
          workingDir: workingDirectory,
          number: selected.number,
          targetState,
        });
        if (
          !validPreflight(response.preflightId) ||
          !sameIssue(response.issue, selected) ||
          response.targetState !== targetState
        ) {
          throw new Error('invalid state preview');
        }
        setStatePreview(response);
      }
    } catch {
      clearPreviews();
      setDialogError(intl.formatMessage(i18n.previewFailed));
    } finally {
      setSubmitting(false);
    }
  };

  const write = async () => {
    setSubmitting(true);
    setDialogError(undefined);
    try {
      if (mode === 'create' && createPreview) {
        const response = await acpCreateGitHubIssue({
          workingDir: workingDirectory,
          operationId: createPreview.operationId,
          title,
          body,
          preflightId: createPreview.preflightId,
        });
        if (
          response.issue.title !== title ||
          response.issue.body !== body ||
          response.issue.state !== 'open' ||
          !validIssue(response.issue, repositoryUrl)
        ) {
          throw new Error('invalid create response');
        }
      } else if (mode === 'content' && selected && contentPreview) {
        const response = await acpUpdateGitHubIssueContent({
          workingDir: workingDirectory,
          number: selected.number,
          title,
          body,
          preflightId: contentPreview.preflightId,
        });
        if (
          !validIssue(response.issue, repositoryUrl) ||
          response.issue.number !== selected.number ||
          response.issue.title !== title ||
          response.issue.body !== body ||
          response.issue.state !== selected.state ||
          response.issue.url !== selected.url
        ) {
          throw new Error('invalid content response');
        }
      } else if (mode === 'state' && selected && targetState && statePreview) {
        const response = await acpChangeGitHubIssueState({
          workingDir: workingDirectory,
          number: selected.number,
          targetState,
          preflightId: statePreview.preflightId,
        });
        if (
          !validIssue(response.issue, repositoryUrl) ||
          !sameIssue(response.issue, { ...selected, state: targetState })
        ) {
          throw new Error('invalid state response');
        }
      } else {
        throw new Error('missing issue preview');
      }
      setMode(undefined);
      setSelected(undefined);
      clearPreviews();
      await refresh();
    } catch (caught) {
      if (errorCode(caught) === 'uncertain_effect') {
        setUncertain(true);
        setMode(undefined);
        setError(intl.formatMessage(i18n.uncertain));
      } else {
        setDialogError(intl.formatMessage(i18n.writeFailed));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const hasPreview = Boolean(createPreview || contentPreview || statePreview);
  const confirmLabel =
    mode === 'create'
      ? createPreview
        ? i18n.createConfirm
        : i18n.createPreflight
      : mode === 'content'
        ? contentPreview
          ? i18n.updateConfirm
          : i18n.updatePreflight
        : statePreview
          ? targetState === 'closed'
            ? i18n.closeConfirm
            : i18n.reopenConfirm
          : i18n.statePreflight;

  return (
    <section className="grid gap-3 border-t border-border-primary pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">
          {intl.formatMessage(i18n.title)}
        </h3>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label={intl.formatMessage(i18n.refresh)}
            disabled={loading || submitting}
            onClick={() => void refresh()}
            className="flex min-h-9 items-center gap-2 rounded-md border border-border-primary px-3 text-xs font-medium text-text-primary disabled:opacity-50"
          >
            {loading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            {intl.formatMessage(i18n.refresh)}
          </button>
          <button
            type="button"
            disabled={uncertain || loading || submitting}
            onClick={openCreate}
            className="min-h-9 rounded-md bg-blue-600 px-3 text-xs font-medium text-white disabled:opacity-50"
          >
            {intl.formatMessage(i18n.create)}
          </button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
        >
          {error}
        </p>
      )}

      {issues.length === 0 && !loading ? (
        <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.empty)}</p>
      ) : (
        <ul className="grid gap-2">
          {issues.map((issue) => (
            <li key={issue.number} className="rounded-md border border-border-primary p-3 text-xs">
              <p className="font-semibold text-text-primary">
                {intl.formatMessage(i18n.issue, { number: issue.number })}
              </p>
              <p className="mt-1 text-text-primary">{issue.title}</p>
              <p className="mt-1 text-text-secondary">{issue.state}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={uncertain}
                  aria-label={intl.formatMessage(i18n.edit, { number: issue.number })}
                  onClick={() => openContent(issue)}
                  className="min-h-9 rounded-md border border-border-primary px-3 font-medium disabled:opacity-50"
                >
                  {intl.formatMessage(i18n.edit, { number: issue.number })}
                </button>
                <button
                  type="button"
                  disabled={uncertain}
                  aria-label={intl.formatMessage(
                    issue.state === 'open' ? i18n.close : i18n.reopen,
                    { number: issue.number }
                  )}
                  onClick={() => openState(issue, issue.state === 'open' ? 'closed' : 'open')}
                  className="min-h-9 rounded-md border border-border-primary px-3 font-medium disabled:opacity-50"
                >
                  {intl.formatMessage(issue.state === 'open' ? i18n.close : i18n.reopen, {
                    number: issue.number,
                  })}
                </button>
                {validIssue(issue, repositoryUrl) && (
                  <button
                    type="button"
                    aria-label={intl.formatMessage(i18n.open, { number: issue.number })}
                    onClick={() => void window.electron.openExternal(issue.url)}
                    className="flex min-h-9 items-center gap-2 rounded-md border border-border-primary px-3 font-medium"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    {intl.formatMessage(i18n.open, { number: issue.number })}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmationModal
        isOpen={Boolean(mode)}
        title={intl.formatMessage(
          mode === 'create'
            ? i18n.createTitle
            : mode === 'content'
              ? i18n.editTitle
              : i18n.stateTitle
        )}
        message={intl.formatMessage(
          mode === 'create'
            ? i18n.createMessage
            : mode === 'content'
              ? i18n.editMessage
              : i18n.stateMessage
        )}
        confirmLabel={intl.formatMessage(confirmLabel)}
        cancelLabel={intl.formatMessage(i18n.cancel)}
        isSubmitting={submitting}
        onCancel={closeDialog}
        onConfirm={() => void (hasPreview ? write() : preview())}
        detail={
          <div className="grid gap-3">
            {mode !== 'state' && (
              <>
                <label className="grid gap-1 text-xs font-medium text-text-primary">
                  {intl.formatMessage(i18n.titleLabel)}
                  <input
                    value={title}
                    maxLength={256}
                    disabled={submitting}
                    onChange={(event) => edit(() => setTitle(event.target.value))}
                    className="min-h-9 rounded-md border border-border-primary bg-background-primary px-2.5 text-sm font-normal"
                  />
                </label>
                <label className="grid gap-1 text-xs font-medium text-text-primary">
                  {intl.formatMessage(i18n.bodyLabel)}
                  <textarea
                    value={body}
                    maxLength={65_536}
                    rows={5}
                    disabled={submitting}
                    onChange={(event) => edit(() => setBody(event.target.value))}
                    className="min-h-24 resize-y rounded-md border border-border-primary bg-background-primary px-2.5 py-2 text-sm font-normal"
                  />
                </label>
              </>
            )}
            {hasPreview && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs font-medium text-amber-900">
                {intl.formatMessage(mode === 'create' ? i18n.createWarning : i18n.warning, {
                  number: selected?.number ?? 0,
                })}
              </p>
            )}
            {dialogError && (
              <p
                role="alert"
                className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
              >
                {dialogError}
              </p>
            )}
          </div>
        }
      />
    </section>
  );
}
