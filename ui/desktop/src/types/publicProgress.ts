import type { PublicProgressEvent } from '@aaif/goose-sdk';

const roles = new Set<PublicProgressEvent['role']>(['planner', 'coder', 'tester', 'reviewer']);
const phases = new Set<PublicProgressEvent['phase']>([
  'planning',
  'coding',
  'testing',
  'reviewing',
  'tool_use',
  'waiting',
  'completing',
]);
const statuses = new Set<PublicProgressEvent['status']>([
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

export function parsePublicProgress(value: unknown): PublicProgressEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const progress = value as Partial<PublicProgressEvent>;
  if (
    progress.schemaVersion !== 1 ||
    typeof progress.sessionId !== 'string' ||
    typeof progress.runId !== 'string' ||
    typeof progress.attemptId !== 'string' ||
    !roles.has(progress.role as PublicProgressEvent['role']) ||
    !phases.has(progress.phase as PublicProgressEvent['phase']) ||
    !statuses.has(progress.status as PublicProgressEvent['status']) ||
    typeof progress.summary !== 'string' ||
    typeof progress.startedAt !== 'string' ||
    typeof progress.lastActivityAt !== 'string' ||
    typeof progress.heartbeatAt !== 'string' ||
    typeof progress.elapsedMs !== 'number' ||
    !Number.isSafeInteger(progress.elapsedMs) ||
    progress.elapsedMs < 0
  ) {
    return null;
  }
  return progress as PublicProgressEvent;
}
