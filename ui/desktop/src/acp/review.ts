import type {
  CodeProReviewResultResponse_unstable,
  CodeProReviewResult,
  CodeProReviewScope,
  CodeProReviewSnapshot,
  CodeProReviewSnapshotResponse_unstable,
} from '@aaif/goose-sdk';
import { getAcpControlClient } from './acpConnection';

export type ReviewScope = CodeProReviewScope;
export type ReviewSnapshot = CodeProReviewSnapshot;
export type ReviewResult = CodeProReviewResult;
export interface ReviewRecord {
  result: ReviewResult;
  snapshot?: ReviewSnapshot;
}

type AcpControlClient = Awaited<ReturnType<typeof getAcpControlClient>>;

async function callReviewMethod<T>(
  client: AcpControlClient,
  generatedMethod: unknown,
  protocolMethod: string,
  params: Record<string, unknown>
): Promise<T> {
  if (typeof generatedMethod === 'function') {
    return generatedMethod.call(client.goose, params) as Promise<T>;
  }

  return (await client.extMethod(protocolMethod, params)) as T;
}

export async function captureCodeProReviewSnapshot(
  sessionId: string,
  scope: ReviewScope,
  baseRef?: string
): Promise<ReviewSnapshot> {
  const client = await getAcpControlClient();
  const params = {
    schemaVersion: 1,
    sessionId,
    scope,
    ...(scope === 'branch' ? { baseRef: baseRef?.trim() || null } : {}),
  };
  const response = await callReviewMethod<CodeProReviewSnapshotResponse_unstable>(
    client,
    client.goose.codeproReviewSnapshot_unstable,
    '_goose/unstable/codepro/review/snapshot',
    params
  );
  return response.snapshot;
}

export async function startCodeProReview(
  sessionId: string,
  snapshotId: string,
  requestId: string
): Promise<ReviewResult> {
  const client = await getAcpControlClient();
  const params = {
    schemaVersion: 1,
    sessionId,
    snapshotId,
    requestId,
  };
  const response = await callReviewMethod<CodeProReviewResultResponse_unstable>(
    client,
    client.goose.codeproReviewStart_unstable,
    '_goose/unstable/codepro/review/start',
    params
  );
  return response.result;
}

export async function getCodeProReview(
  sessionId: string,
  reviewId: string,
  includeSnapshot = false
): Promise<ReviewRecord> {
  const client = await getAcpControlClient();
  const params = {
    schemaVersion: 1,
    sessionId,
    reviewId,
    includeSnapshot,
  };
  const response = await callReviewMethod<CodeProReviewResultResponse_unstable>(
    client,
    client.goose.codeproReviewGet_unstable,
    '_goose/unstable/codepro/review/get',
    params
  );
  return {
    result: response.result,
    ...(response.snapshot ? { snapshot: response.snapshot } : {}),
  };
}

export async function cancelCodeProReview(
  sessionId: string,
  reviewId: string
): Promise<ReviewResult> {
  const client = await getAcpControlClient();
  const params = {
    schemaVersion: 1,
    sessionId,
    reviewId,
  };
  const response = await callReviewMethod<CodeProReviewResultResponse_unstable>(
    client,
    client.goose.codeproReviewCancel_unstable,
    '_goose/unstable/codepro/review/cancel',
    params
  );
  return response.result;
}
