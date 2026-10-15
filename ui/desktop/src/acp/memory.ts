import type {
  CodeProMemoryListResponse_unstable,
  CodeProMemoryRecord,
  CodeProMemoryStatus as GeneratedCodeProMemoryStatus,
  CodeProMemoryTargetStatus,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';
import { AcpTransportError } from './createWebSocketStream';
import { acpErrorCode } from './errors';

export const CODEPRO_MEMORY_SCHEMA_VERSION = 1;

export type { CodeProMemoryRecord };
export type CodeProMemoryList = CodeProMemoryListResponse_unstable;
export type CodeProMemoryStatus = GeneratedCodeProMemoryStatus;
export type ReviewableCodeProMemoryRecord = Omit<CodeProMemoryRecord, 'reviewFingerprint'> & {
  reviewFingerprint: string;
};

export type CodeProMemoryStatusResult =
  | {
      outcome: 'committed';
      record: ReviewableCodeProMemoryRecord;
      changed: boolean;
    }
  | {
      outcome: 'reconciled_after_readback';
      record: ReviewableCodeProMemoryRecord;
      changed: null;
    }
  | {
      outcome: 'needs_review';
      record: ReviewableCodeProMemoryRecord | null;
      changed: null;
    };

export type CodeProMemoryPageOptions = {
  pageSize?: number;
  cursor?: string;
};

const PROJECT_IDENTITY_PATTERN = /^[0-9a-f]{32}$/i;
const MEMORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;

class UnknownMemoryCommitResponseError extends Error {}

function validatePageOptions(options: CodeProMemoryPageOptions): void {
  if (
    options.pageSize !== undefined &&
    (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50)
  ) {
    throw new Error('Memory pageSize must be an integer between 1 and 50');
  }
  if (
    options.cursor !== undefined &&
    (options.cursor.trim().length === 0 || options.cursor.length > 36)
  ) {
    throw new Error('Memory cursor must contain between 1 and 36 characters');
  }
  if (options.cursor !== undefined && !MEMORY_ID_PATTERN.test(options.cursor)) {
    throw new Error('Memory cursor must be a UUID');
  }
}

function validateListResponse(response: CodeProMemoryList): CodeProMemoryList {
  if (!PROJECT_IDENTITY_PATTERN.test(response.projectIdentity)) {
    throw new Error('Memory response projectIdentity must be a 32-character hexadecimal id');
  }
  if (response.records.some((record) => !MEMORY_ID_PATTERN.test(record.id))) {
    throw new Error('Memory response record id must be a UUID');
  }
  if (response.records.length > response.totalRecords) {
    throw new Error('Memory response contains more records than totalRecords');
  }
  if (response.softLimitBytes > response.hardLimitBytes) {
    throw new Error('Memory response softLimitBytes must not exceed hardLimitBytes');
  }
  if (response.nextCursor && response.records.length === 0) {
    throw new Error('Memory response must not advance pagination from an empty page');
  }
  if (
    response.nextCursor &&
    response.records[response.records.length - 1]?.id !== response.nextCursor
  ) {
    throw new Error('Memory response nextCursor must match the final record id');
  }
  return response;
}

function validateReviewRecord(record: CodeProMemoryRecord): ReviewableCodeProMemoryRecord {
  if (!MEMORY_ID_PATTERN.test(record.id)) {
    throw new Error('Memory review record id must be a UUID');
  }
  if (!['candidate', 'active', 'disabled'].includes(record.status)) {
    throw new Error('Memory review record status is invalid');
  }
  if (
    typeof record.reviewFingerprint !== 'string' ||
    !REVIEW_FINGERPRINT_PATTERN.test(record.reviewFingerprint)
  ) {
    throw new Error('Memory review fingerprint must be a 64-character hexadecimal digest');
  }
  if (typeof record.updatedAt !== 'string' || record.updatedAt.length === 0) {
    throw new Error('Memory review updatedAt must not be empty');
  }
  return record as ReviewableCodeProMemoryRecord;
}

function isUnknownCommitError(error: unknown): boolean {
  if (acpErrorCode(error) === 'memory_review_unknown_commit') return true;
  if (error instanceof UnknownMemoryCommitResponseError) return true;
  return error instanceof AcpTransportError && error.dispatchState === 'unknown';
}

function sameReviewSnapshot(
  record: ReviewableCodeProMemoryRecord,
  snapshot: Pick<ReviewableCodeProMemoryRecord, 'id' | 'status' | 'updatedAt' | 'reviewFingerprint'>
): boolean {
  return (
    record.id === snapshot.id &&
    record.status === snapshot.status &&
    record.updatedAt === snapshot.updatedAt &&
    record.reviewFingerprint === snapshot.reviewFingerprint
  );
}

async function getUserPreferenceForReview(
  goose: Awaited<ReturnType<typeof getAcpClient>>['goose'],
  workingDir: string,
  id: string
): Promise<ReviewableCodeProMemoryRecord | null> {
  const response = await goose.codeproMemoryGet_unstable({
    schemaVersion: CODEPRO_MEMORY_SCHEMA_VERSION,
    workingDir,
    id,
  });
  if (!response.record) return null;
  const record = validateReviewRecord(response.record);
  if (record.id !== id) {
    throw new Error('Memory readback id does not match the requested record');
  }
  return record;
}

async function safeUserPreferenceReadback(
  goose: Awaited<ReturnType<typeof getAcpClient>>['goose'],
  workingDir: string,
  id: string
): Promise<{ ok: true; record: ReviewableCodeProMemoryRecord | null } | { ok: false }> {
  try {
    return { ok: true, record: await getUserPreferenceForReview(goose, workingDir, id) };
  } catch {
    return { ok: false };
  }
}

export async function listCodeProMemory(
  workingDir: string,
  includeExpired = false,
  options: CodeProMemoryPageOptions = {}
): Promise<CodeProMemoryList> {
  validatePageOptions(options);
  const client = await getAcpClient();
  return validateListResponse(
    await client.goose.codeproMemoryList_unstable({
      schemaVersion: CODEPRO_MEMORY_SCHEMA_VERSION,
      workingDir,
      includeExpired,
      ...options,
    })
  );
}

export async function updateCodeProMemory(input: {
  workingDir: string;
  id: string;
  content: string;
  reason: string;
  ttlDays?: number;
}): Promise<CodeProMemoryRecord> {
  const client = await getAcpClient();
  const response = await client.goose.codeproMemoryUpdate_unstable({
    schemaVersion: CODEPRO_MEMORY_SCHEMA_VERSION,
    ...input,
  });
  return response.record;
}

export async function deleteCodeProMemory(workingDir: string, id: string): Promise<boolean> {
  const client = await getAcpClient();
  const response = await client.goose.codeproMemoryDelete_unstable({
    schemaVersion: CODEPRO_MEMORY_SCHEMA_VERSION,
    workingDir,
    id,
  });
  return response.removed;
}

export async function exportCodeProMemory(
  workingDir: string,
  includeExpired = false
): Promise<{ fileName: string; json: string }> {
  const client = await getAcpClient();
  return client.goose.codeproMemoryExport_unstable({
    schemaVersion: CODEPRO_MEMORY_SCHEMA_VERSION,
    workingDir,
    includeExpired,
  });
}

export async function setCodeProMemoryStatus(input: {
  workingDir: string;
  record: ReviewableCodeProMemoryRecord;
  targetStatus: CodeProMemoryTargetStatus;
}): Promise<CodeProMemoryStatusResult> {
  const snapshot = validateReviewRecord(input.record);
  let goose = (await getAcpClient()).goose;
  const actionId = globalThis.crypto.randomUUID();
  const request = {
    schemaVersion: CODEPRO_MEMORY_SCHEMA_VERSION,
    workingDir: input.workingDir,
    id: snapshot.id,
    targetStatus: input.targetStatus,
    expectedStatus: snapshot.status,
    expectedUpdatedAt: snapshot.updatedAt,
    reviewFingerprint: snapshot.reviewFingerprint,
    actionId,
  };

  const commit = async (): Promise<CodeProMemoryStatusResult> => {
    const response = await goose.codeproMemoryStatus_unstable(request);
    let record: ReviewableCodeProMemoryRecord;
    try {
      record = validateReviewRecord(response.record);
    } catch (error) {
      throw new UnknownMemoryCommitResponseError(String(error));
    }
    if (
      response.actionId !== actionId ||
      typeof response.changed !== 'boolean' ||
      record.id !== snapshot.id ||
      record.status !== input.targetStatus ||
      record.reviewFingerprint !== snapshot.reviewFingerprint ||
      response.changed !== (snapshot.status !== input.targetStatus) ||
      (response.changed
        ? record.updatedAt === snapshot.updatedAt
        : record.updatedAt !== snapshot.updatedAt)
    ) {
      throw new UnknownMemoryCommitResponseError(
        'Memory status response does not match the requested transition'
      );
    }
    return {
      outcome: 'committed',
      record,
      changed: response.changed,
    };
  };

  try {
    return await commit();
  } catch (error) {
    if (!isUnknownCommitError(error)) throw error;
  }

  goose = (await getAcpClient()).goose;
  let readbackResult = await safeUserPreferenceReadback(goose, input.workingDir, snapshot.id);
  if (!readbackResult.ok) {
    return { outcome: 'needs_review', record: null, changed: null };
  }
  let readback = readbackResult.record;
  if (
    readback &&
    readback.status === input.targetStatus &&
    readback.reviewFingerprint === snapshot.reviewFingerprint
  ) {
    return { outcome: 'reconciled_after_readback', record: readback, changed: null };
  }
  if (!readback || !sameReviewSnapshot(readback, snapshot)) {
    return { outcome: 'needs_review', record: readback, changed: null };
  }

  try {
    return await commit();
  } catch (error) {
    if (!isUnknownCommitError(error)) throw error;
  }

  goose = (await getAcpClient()).goose;
  readbackResult = await safeUserPreferenceReadback(goose, input.workingDir, snapshot.id);
  if (!readbackResult.ok) {
    return { outcome: 'needs_review', record: null, changed: null };
  }
  readback = readbackResult.record;
  if (
    readback &&
    readback.status === input.targetStatus &&
    readback.reviewFingerprint === snapshot.reviewFingerprint
  ) {
    return { outcome: 'reconciled_after_readback', record: readback, changed: null };
  }
  return { outcome: 'needs_review', record: readback, changed: null };
}
