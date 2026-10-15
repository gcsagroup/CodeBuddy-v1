import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpControlClient } from './acpConnection';
import {
  cancelCodeProReview,
  captureCodeProReviewSnapshot,
  getCodeProReview,
  startCodeProReview,
} from './review';

vi.mock('./acpConnection', () => ({ getAcpControlClient: vi.fn() }));

describe('CodePro review ACP bridge', () => {
  const extMethod = vi.fn();
  const goose = {
    codeproReviewSnapshot_unstable: vi.fn(),
    codeproReviewStart_unstable: vi.fn(),
    codeproReviewGet_unstable: vi.fn(),
    codeproReviewCancel_unstable: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAcpControlClient).mockResolvedValue({
      goose,
      extMethod,
    } as unknown as Awaited<ReturnType<typeof getAcpControlClient>>);
  });

  it('captures only the server-owned session and requested review scope', async () => {
    goose.codeproReviewSnapshot_unstable.mockResolvedValue({ snapshot: { snapshotId: 's-1' } });

    await captureCodeProReviewSnapshot('session-1', 'branch', 'origin/main');

    expect(goose.codeproReviewSnapshot_unstable).toHaveBeenCalledWith({
      schemaVersion: 1,
      sessionId: 'session-1',
      scope: 'branch',
      baseRef: 'origin/main',
    });
  });

  it('uses the control transport for start, get, and cancel', async () => {
    const response = { result: { reviewId: 'r-1' }, snapshot: { snapshotId: 's-1' } };
    goose.codeproReviewStart_unstable.mockResolvedValue(response);
    goose.codeproReviewGet_unstable.mockResolvedValue(response);
    goose.codeproReviewCancel_unstable.mockResolvedValue(response);

    await startCodeProReview('session-1', 's-1', 'request-1');
    await getCodeProReview('session-1', 'r-1');
    expect(await getCodeProReview('session-1', 'r-1', true)).toEqual(response);
    await cancelCodeProReview('session-1', 'r-1');

    expect(goose.codeproReviewStart_unstable).toHaveBeenCalledWith({
      schemaVersion: 1,
      sessionId: 'session-1',
      snapshotId: 's-1',
      requestId: 'request-1',
    });
    expect(goose.codeproReviewGet_unstable).toHaveBeenNthCalledWith(1, {
      schemaVersion: 1,
      sessionId: 'session-1',
      reviewId: 'r-1',
      includeSnapshot: false,
    });
    expect(goose.codeproReviewGet_unstable).toHaveBeenNthCalledWith(2, {
      schemaVersion: 1,
      sessionId: 'session-1',
      reviewId: 'r-1',
      includeSnapshot: true,
    });
    expect(goose.codeproReviewCancel_unstable).toHaveBeenCalledWith({
      schemaVersion: 1,
      sessionId: 'session-1',
      reviewId: 'r-1',
    });
  });

  it('normalizes a missing persisted snapshot to an absent optional field', async () => {
    goose.codeproReviewGet_unstable.mockResolvedValue({
      result: { reviewId: 'r-1' },
      snapshot: null,
    });

    await expect(getCodeProReview('session-1', 'r-1', true)).resolves.toEqual({
      result: { reviewId: 'r-1' },
    });
  });

  it('falls back to the generic ACP extension method when the generated SDK is stale', async () => {
    const staleGoose = {};
    const snapshotResponse = { snapshot: { snapshotId: 's-1' } };
    const resultResponse = { result: { reviewId: 'r-1' } };
    extMethod
      .mockResolvedValueOnce(snapshotResponse)
      .mockResolvedValueOnce(resultResponse)
      .mockResolvedValueOnce(resultResponse)
      .mockResolvedValueOnce(resultResponse);
    vi.mocked(getAcpControlClient).mockResolvedValue({
      goose: staleGoose,
      extMethod,
    } as unknown as Awaited<ReturnType<typeof getAcpControlClient>>);

    await expect(captureCodeProReviewSnapshot('session-1', 'working_tree')).resolves.toEqual(
      snapshotResponse.snapshot
    );
    await expect(startCodeProReview('session-1', 's-1', 'request-1')).resolves.toEqual(
      resultResponse.result
    );
    await expect(getCodeProReview('session-1', 'r-1')).resolves.toEqual(resultResponse);
    await expect(cancelCodeProReview('session-1', 'r-1')).resolves.toEqual(resultResponse.result);

    expect(extMethod.mock.calls).toEqual([
      [
        '_goose/unstable/codepro/review/snapshot',
        { schemaVersion: 1, sessionId: 'session-1', scope: 'working_tree' },
      ],
      [
        '_goose/unstable/codepro/review/start',
        {
          schemaVersion: 1,
          sessionId: 'session-1',
          snapshotId: 's-1',
          requestId: 'request-1',
        },
      ],
      [
        '_goose/unstable/codepro/review/get',
        {
          schemaVersion: 1,
          sessionId: 'session-1',
          reviewId: 'r-1',
          includeSnapshot: false,
        },
      ],
      [
        '_goose/unstable/codepro/review/cancel',
        { schemaVersion: 1, sessionId: 'session-1', reviewId: 'r-1' },
      ],
    ]);
  });
});
