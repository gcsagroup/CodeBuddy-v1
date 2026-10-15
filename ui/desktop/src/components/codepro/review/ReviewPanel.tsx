import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelCodeProReview,
  captureCodeProReviewSnapshot,
  getCodeProReview,
  startCodeProReview,
  type ReviewResult,
  type ReviewScope,
  type ReviewSnapshot,
} from '../../../acp/review';
import { defineMessages, useIntl } from '../../../i18n';
import { cn } from '../../../utils';

const i18n = defineMessages({
  title: { id: 'codeProReview.title', defaultMessage: 'Code review' },
  workingTree: { id: 'codeProReview.workingTree', defaultMessage: 'Working tree' },
  staged: { id: 'codeProReview.staged', defaultMessage: 'Staged' },
  branch: { id: 'codeProReview.branch', defaultMessage: 'Branch' },
  baseRef: { id: 'codeProReview.baseRef', defaultMessage: 'Base branch or ref' },
  preview: { id: 'codeProReview.preview', defaultMessage: 'Preview review' },
  start: { id: 'codeProReview.start', defaultMessage: 'Start review' },
  cancel: { id: 'codeProReview.cancel', defaultMessage: 'Cancel review' },
  model: { id: 'codeProReview.model', defaultMessage: 'Model: {model}' },
  partial: {
    id: 'codeProReview.partial',
    defaultMessage: 'Partial coverage: {count} excluded {count, plural, one {file} other {files}}.',
  },
  running: { id: 'codeProReview.running', defaultMessage: 'Review is running…' },
  cancelled: { id: 'codeProReview.cancelled', defaultMessage: 'Review cancelled.' },
  interrupted: { id: 'codeProReview.interrupted', defaultMessage: 'Review was interrupted.' },
  noChanges: { id: 'codeProReview.noChanges', defaultMessage: 'No changes to review.' },
  noContent: {
    id: 'codeProReview.noContent',
    defaultMessage: 'No reviewable content in this scope.',
  },
  noFindings: {
    id: 'codeProReview.noFindings',
    defaultMessage: 'Review completed with no findings.',
  },
  stale: { id: 'codeProReview.stale', defaultMessage: 'This review is stale.' },
  unknown: {
    id: 'codeProReview.unknown',
    defaultMessage: 'Review freshness could not be verified.',
  },
  oldSide: { id: 'codeProReview.oldSide', defaultMessage: 'old' },
  newSide: { id: 'codeProReview.newSide', defaultMessage: 'new' },
  previewEmpty: {
    id: 'codeProReview.previewEmpty',
    defaultMessage: 'Capture a preview before starting the review.',
  },
});

export interface ReviewPanelApi {
  snapshot: typeof captureCodeProReviewSnapshot;
  start: typeof startCodeProReview;
  get: typeof getCodeProReview;
  cancel: typeof cancelCodeProReview;
}

const defaultApi: ReviewPanelApi = {
  snapshot: captureCodeProReviewSnapshot,
  start: startCodeProReview,
  get: getCodeProReview,
  cancel: cancelCodeProReview,
};

interface ReviewPanelProps {
  sessionId: string;
  visible: boolean;
  api?: ReviewPanelApi;
  pollIntervalMs?: number;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function storageKey(sessionId: string, scope: ReviewScope): string {
  return `codepro.review.${sessionId}.${scope}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ReviewPanel({
  sessionId,
  visible,
  api = defaultApi,
  pollIntervalMs = 1000,
}: ReviewPanelProps) {
  const intl = useIntl();
  const [scope, setScope] = useState<ReviewScope>('working_tree');
  const [baseRef, setBaseRef] = useState('main');
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>();
  const [result, setResult] = useState<ReviewResult>();
  const [selectedFindingId, setSelectedFindingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const reset = useCallback(() => {
    generation.current += 1;
    setSnapshot(undefined);
    setResult(undefined);
    setSelectedFindingId(undefined);
    setError(undefined);
    setBusy(false);
  }, []);

  useEffect(() => reset(), [sessionId, scope, reset]);

  useEffect(() => {
    if (!visible || !sessionId || typeof localStorage === 'undefined') return;
    const reviewId = localStorage.getItem(storageKey(sessionId, scope));
    if (!reviewId) return;
    const currentGeneration = generation.current;
    void api
      .get(sessionId, reviewId, true)
      .then(({ result: stored, snapshot: storedSnapshot }) => {
        if (currentGeneration === generation.current) {
          setResult(stored);
          setSnapshot(storedSnapshot);
        }
      })
      .catch(() => {
        if (currentGeneration === generation.current) {
          localStorage.removeItem(storageKey(sessionId, scope));
        }
      });
  }, [api, scope, sessionId, visible]);

  useEffect(() => {
    if (!visible || result?.status !== 'running') return;
    const reviewId = result.reviewId;
    const currentGeneration = generation.current;
    let requestInFlight = false;
    const timer = window.setInterval(() => {
      if (requestInFlight) return;
      requestInFlight = true;
      void api
        .get(sessionId, reviewId)
        .then(({ result: next }) => {
          if (currentGeneration === generation.current) setResult(next);
        })
        .catch((pollError) => {
          if (currentGeneration === generation.current) setError(errorMessage(pollError));
        })
        .finally(() => {
          requestInFlight = false;
        });
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [api, pollIntervalMs, result?.reviewId, result?.status, sessionId, visible]);

  const preview = async () => {
    const currentGeneration = ++generation.current;
    setBusy(true);
    setError(undefined);
    setSnapshot(undefined);
    setResult(undefined);
    try {
      const next = await api.snapshot(sessionId, scope, scope === 'branch' ? baseRef : undefined);
      if (currentGeneration === generation.current) setSnapshot(next);
    } catch (previewError) {
      if (currentGeneration === generation.current) setError(errorMessage(previewError));
    } finally {
      if (currentGeneration === generation.current) setBusy(false);
    }
  };

  const start = async () => {
    if (!snapshot) return;
    const currentGeneration = ++generation.current;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const next = await api.start(sessionId, snapshot.snapshotId, requestId());
      if (currentGeneration !== generation.current) return;
      setResult(next);
      localStorage.setItem(storageKey(sessionId, scope), next.reviewId);
    } catch (startError) {
      if (currentGeneration === generation.current) setError(errorMessage(startError));
    } finally {
      if (currentGeneration === generation.current) setBusy(false);
    }
  };

  const cancel = async () => {
    if (!result || result.status !== 'running') return;
    const currentGeneration = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.cancel(sessionId, result.reviewId);
      if (currentGeneration === generation.current) setResult(next);
    } catch (cancelError) {
      if (currentGeneration === generation.current) setError(errorMessage(cancelError));
    } finally {
      if (currentGeneration === generation.current) setBusy(false);
    }
  };

  const findings = useMemo(
    () =>
      [...(result?.findings ?? [])].sort(
        (left, right) =>
          left.priority - right.priority ||
          left.path.localeCompare(right.path) ||
          left.startLine - right.startLine
      ),
    [result?.findings]
  );
  const selectedFinding =
    findings.find((finding) => finding.id === selectedFindingId) ?? findings[0];
  const selectedFile = snapshot?.files.find((file) =>
    selectedFinding?.side === 'old'
      ? (file.originalPath ?? file.path) === selectedFinding.path
      : file.path === selectedFinding?.path
  );
  const selectedText =
    selectedFinding?.side === 'old' ? selectedFile?.oldText : selectedFile?.newText;
  const coverage = snapshot?.coverage ?? result?.coverage;
  const excludedCount = snapshot?.excludedFiles.length ?? result?.excludedFiles.length ?? 0;

  const scopes: Array<{ value: ReviewScope; label: string }> = [
    { value: 'working_tree', label: intl.formatMessage(i18n.workingTree) },
    { value: 'staged', label: intl.formatMessage(i18n.staged) },
    { value: 'branch', label: intl.formatMessage(i18n.branch) },
  ];

  return (
    <section className="space-y-3" aria-label={intl.formatMessage(i18n.title)}>
      <div className="flex gap-1" role="group" aria-label={intl.formatMessage(i18n.title)}>
        {scopes.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={scope === item.value}
            onClick={() => setScope(item.value)}
            className={cn(
              'rounded border border-border-primary px-2 py-1 text-xs',
              scope === item.value && 'bg-background-secondary font-semibold'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {scope === 'branch' && (
        <label className="block text-xs text-text-secondary">
          {intl.formatMessage(i18n.baseRef)}
          <input
            value={baseRef}
            onChange={(event) => setBaseRef(event.target.value)}
            className="mt-1 w-full rounded border border-border-primary bg-background-primary px-2 py-1 text-text-primary"
          />
        </label>
      )}

      <button
        type="button"
        disabled={busy || (scope === 'branch' && !baseRef.trim())}
        onClick={() => void preview()}
        className="w-full rounded border border-border-primary px-2 py-1.5 text-xs font-medium disabled:opacity-50"
      >
        {intl.formatMessage(i18n.preview)}
      </button>

      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {snapshot && (
        <div className="space-y-2 rounded border border-border-primary p-2 text-xs">
          <p>
            {intl.formatMessage(i18n.model, {
              model: `${snapshot.model.provider} / ${snapshot.model.model}`,
            })}
          </p>
          <button
            type="button"
            disabled={busy || result?.status === 'running'}
            onClick={() => void start()}
            className="w-full rounded bg-text-primary px-2 py-1.5 font-medium text-background-primary disabled:opacity-50"
          >
            {intl.formatMessage(i18n.start)}
          </button>
        </div>
      )}

      {!snapshot && !result && !busy && (
        <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.previewEmpty)}</p>
      )}

      {coverage === 'partial' && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {intl.formatMessage(i18n.partial, { count: excludedCount })}
        </p>
      )}
      {result?.freshness === 'stale' && (
        <p className="text-xs text-amber-700">{intl.formatMessage(i18n.stale)}</p>
      )}
      {result?.freshness === 'unknown' && (
        <p className="text-xs text-amber-700">{intl.formatMessage(i18n.unknown)}</p>
      )}
      {result?.status === 'running' && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <p role="status">{intl.formatMessage(i18n.running)}</p>
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            {intl.formatMessage(i18n.cancel)}
          </button>
        </div>
      )}
      {result?.status === 'failed' && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {result.error?.message ?? result.error?.code ?? 'Review failed'}
        </p>
      )}
      {result?.status === 'cancelled' && (
        <p className="text-xs">{intl.formatMessage(i18n.cancelled)}</p>
      )}
      {result?.status === 'interrupted' && (
        <p className="text-xs">{intl.formatMessage(i18n.interrupted)}</p>
      )}
      {result?.status === 'no_changes' && (
        <p className="text-xs">{intl.formatMessage(i18n.noChanges)}</p>
      )}
      {result?.status === 'no_reviewable_content' && (
        <p className="text-xs">{intl.formatMessage(i18n.noContent)}</p>
      )}
      {result?.status === 'completed' &&
        result.coverage === 'complete' &&
        result.freshness === 'current' &&
        findings.length === 0 && <p className="text-xs">{intl.formatMessage(i18n.noFindings)}</p>}

      {findings.length > 0 && (
        <div className="space-y-2">
          <ul className="space-y-1">
            {findings.map((finding) => (
              <li key={finding.id}>
                <button
                  type="button"
                  onClick={() => setSelectedFindingId(finding.id)}
                  className="w-full rounded border border-border-primary p-2 text-left text-xs"
                >
                  <span className="font-semibold">
                    P{finding.priority} · {finding.title}
                  </span>
                  <span className="mt-1 block text-text-secondary">
                    {finding.path}:{finding.startLine} (
                    {intl.formatMessage(finding.side === 'old' ? i18n.oldSide : i18n.newSide)})
                  </span>
                  <span className="mt-1 block">{finding.body}</span>
                </button>
              </li>
            ))}
          </ul>
          {selectedFinding && selectedText !== undefined && (
            <pre className="max-h-64 overflow-auto whitespace-pre rounded bg-background-secondary p-2 text-[11px]">
              {selectedText
                .split('\n')
                .map((line, index) => `${index + 1}\t${line}`)
                .join('\n')}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
