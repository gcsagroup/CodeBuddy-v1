import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../../../acp/review';
import { ReviewPanel, type ReviewPanelApi } from './ReviewPanel';

const snapshot = {
  schemaVersion: 1,
  snapshotId: 'snapshot-1',
  sessionId: 'session-1',
  scope: 'working_tree' as const,
  headOid: 'abc',
  model: { provider: 'openai', model: 'gpt-review' },
  files: [
    {
      path: 'src/deleted.ts',
      status: 'deleted',
      oldText: 'one\ntwo\nthree',
      newText: '',
      oldHash: 'old',
      newHash: 'new',
      diff: '@@ -1,3 +0,0 @@',
      hunks: [{ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 }],
    },
  ],
  coverage: 'partial' as const,
  excludedFiles: [{ path: 'secret.env', reason: 'sensitive_path' as const }],
  fingerprint: 'fingerprint-1',
  capturedAt: '2026-09-06T00:00:00Z',
};

const running = {
  schemaVersion: 1,
  reviewId: 'review-1',
  snapshotId: snapshot.snapshotId,
  revision: 1,
  status: 'running' as const,
  freshness: 'current' as const,
  coverage: 'partial' as const,
  findings: [],
  excludedFiles: snapshot.excludedFiles,
  testEvidenceRefs: [],
  createdAt: '2026-09-06T00:00:00Z',
  updatedAt: '2026-09-06T00:00:00Z',
};

function api(overrides: Partial<ReviewPanelApi> = {}): ReviewPanelApi {
  return {
    snapshot: vi.fn().mockResolvedValue(snapshot),
    start: vi.fn().mockResolvedValue(running),
    get: vi.fn().mockResolvedValue({ result: running }),
    cancel: vi.fn().mockResolvedValue({ ...running, revision: 2, status: 'cancelled' }),
    ...overrides,
  };
}

function renderPanel(
  reviewApi: ReviewPanelApi,
  props: { sessionId?: string; visible?: boolean } = {}
) {
  return render(
    <IntlProvider locale="en">
      <ReviewPanel
        sessionId={props.sessionId ?? 'session-1'}
        visible={props.visible ?? true}
        api={reviewApi}
        pollIntervalMs={10}
      />
    </IntlProvider>
  );
}

describe('ReviewPanel', () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('offers all scopes and shows partial coverage, current model, and old-side locations', async () => {
    const reviewApi = api({
      start: vi.fn().mockResolvedValue({
        ...running,
        revision: 2,
        status: 'completed',
        findings: [
          {
            id: 'f-1',
            priority: 1,
            title: 'Deleted validation',
            body: 'The deleted guard was still required.',
            path: 'src/deleted.ts',
            side: 'old',
            startLine: 2,
            endLine: 2,
          },
        ],
      }),
    });
    renderPanel(reviewApi);

    expect(screen.getByRole('button', { name: 'Working tree' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Staged' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Branch' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview review' }));

    expect(await screen.findByText('Model: openai / gpt-review')).toBeInTheDocument();
    expect(screen.getByText(/Partial coverage/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    expect(await screen.findByText(/Deleted validation/)).toBeInTheDocument();
    expect(screen.getByText('src/deleted.ts:2 (old)')).toBeInTheDocument();
  });

  it('distinguishes failed, no-changes, and completed empty results', async () => {
    const reviewApi = api({
      start: vi
        .fn()
        .mockResolvedValueOnce({
          ...running,
          status: 'failed',
          error: { code: 'provider_error', message: 'provider unavailable' },
        })
        .mockResolvedValueOnce({ ...running, reviewId: 'review-2', status: 'no_changes' })
        .mockResolvedValueOnce({
          ...running,
          reviewId: 'review-3',
          status: 'completed',
          coverage: 'complete',
        }),
    });
    renderPanel(reviewApi);
    fireEvent.click(screen.getByRole('button', { name: 'Preview review' }));
    await screen.findByRole('button', { name: 'Start review' });

    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('provider unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    expect(await screen.findByText('No changes to review.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    expect(await screen.findByText('Review completed with no findings.')).toBeInTheDocument();
  });

  it('polls only while visible and running, and unmount does not cancel', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValue({ result: running });
    const cancel = vi.fn();
    const reviewApi = api({ get, cancel });
    const view = renderPanel(reviewApi);
    fireEvent.click(screen.getByRole('button', { name: 'Preview review' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(25));
    expect(get).toHaveBeenCalled();

    const calls = get.mock.calls.length;
    view.rerender(
      <IntlProvider locale="en">
        <ReviewPanel sessionId="session-1" visible={false} api={reviewApi} pollIntervalMs={10} />
      </IntlProvider>
    );
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(get).toHaveBeenCalledTimes(calls);
    view.unmount();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('ignores stale preview and late post-cancel responses', async () => {
    let resolveOld!: (value: typeof snapshot) => void;
    let resolveGet!: (value: { result: ReviewResult }) => void;
    const oldPreview = new Promise<typeof snapshot>((resolve) => (resolveOld = resolve));
    const lateGet = new Promise<{ result: ReviewResult }>((resolve) => (resolveGet = resolve));
    const snapshotApi = vi
      .fn()
      .mockReturnValueOnce(oldPreview)
      .mockResolvedValueOnce({ ...snapshot, sessionId: 'session-2', snapshotId: 'snapshot-2' });
    const reviewApi = api({ snapshot: snapshotApi, get: vi.fn().mockReturnValue(lateGet) });
    const view = renderPanel(reviewApi);
    fireEvent.click(screen.getByRole('button', { name: 'Preview review' }));
    view.rerender(
      <IntlProvider locale="en">
        <ReviewPanel sessionId="session-2" visible api={reviewApi} pollIntervalMs={10} />
      </IntlProvider>
    );
    resolveOld(snapshot);
    await act(async () => Promise.resolve());
    expect(screen.queryByText('snapshot-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Preview review' }));
    await screen.findByRole('button', { name: 'Start review' });
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    await screen.findByRole('button', { name: 'Cancel review' });
    await waitFor(() => expect(reviewApi.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel review' }));
    expect(await screen.findByText('Review cancelled.')).toBeInTheDocument();
    resolveGet({ result: { ...running, revision: 3, status: 'completed' } });
    await act(async () => Promise.resolve());
    expect(screen.getByText('Review cancelled.')).toBeInTheDocument();
  });

  it('shows stale and unknown freshness, including a result restored after reload', async () => {
    const reviewApi = api({
      start: vi.fn().mockResolvedValue({ ...running, status: 'completed', freshness: 'stale' }),
    });
    renderPanel(reviewApi);
    fireEvent.click(screen.getByRole('button', { name: 'Preview review' }));
    await screen.findByRole('button', { name: 'Start review' });
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    expect(await screen.findByText('This review is stale.')).toBeInTheDocument();
    expect(screen.queryByText('Review completed with no findings.')).not.toBeInTheDocument();

    localStorage.setItem('codepro.review.session-2.working_tree', 'review-restored');
    const restoredApi = api({
      get: vi.fn().mockResolvedValue({
        result: {
          ...running,
          reviewId: 'review-restored',
          status: 'completed',
          freshness: 'unknown',
          findings: [
            {
              id: 'restored-source',
              priority: 1,
              title: 'Restored source defect',
              body: 'The historical line remains available.',
              path: 'src/deleted.ts',
              side: 'old',
              startLine: 2,
              endLine: 2,
            },
          ],
        },
        snapshot,
      }),
    });
    renderPanel(restoredApi, { sessionId: 'session-2' });
    expect(await screen.findByText('Review freshness could not be verified.')).toBeInTheDocument();
    expect(screen.queryByText('Review completed with no findings.')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'PRE' && element.textContent?.includes('2\ttwo') === true
      )
    ).toBeInTheDocument();
  });

  it('shows old-side source text for a renamed file using its original path', async () => {
    const renamedSnapshot = {
      ...snapshot,
      coverage: 'complete' as const,
      excludedFiles: [],
      files: [
        {
          ...snapshot.files[0],
          path: 'src/renamed.ts',
          originalPath: 'src/original.ts',
          status: 'renamed',
          oldText: 'original first\noriginal second',
          newText: 'renamed first\nrenamed second',
        },
      ],
    };
    const reviewApi = api({
      snapshot: vi.fn().mockResolvedValue(renamedSnapshot),
      start: vi.fn().mockResolvedValue({
        ...running,
        status: 'completed',
        coverage: 'complete',
        findings: [
          {
            id: 'renamed-old',
            priority: 1,
            title: 'Original-side defect',
            body: 'The old-side line is relevant.',
            path: 'src/original.ts',
            side: 'old',
            startLine: 2,
            endLine: 2,
          },
        ],
      }),
    });
    renderPanel(reviewApi);
    fireEvent.click(screen.getByRole('button', { name: 'Preview review' }));
    await screen.findByRole('button', { name: 'Start review' });
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));

    expect(await screen.findByText('src/original.ts:2 (old)')).toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'PRE' && element.textContent?.includes('2\toriginal second') === true
      )
    ).toBeInTheDocument();
  });
});
