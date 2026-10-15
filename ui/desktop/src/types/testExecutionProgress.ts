import type { TestExecutionProgress } from '@aaif/goose-sdk';

const phases = new Set<TestExecutionProgress['phase']>([
  'capturing_baseline',
  'discovering_workspace',
  'resolving_dependencies',
  'waiting_for_cargo_lock',
  'compiling',
  'running_tests',
  'capturing_results',
  'repairing',
  'retesting',
  'waiting_for_user',
  'completed',
]);

const outcomes = new Set<NonNullable<TestExecutionProgress['outcome']>>([
  'succeeded',
  'not_found',
  'path_corrected',
  'permission_required',
  'outside_workspace',
  'locked',
  'busy',
  'prerequisite_unavailable',
  'verification_failed',
  'infrastructure_failed',
  'cancelled',
]);

export function parseTestExecutionProgress(value: unknown): TestExecutionProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const progress = value as Partial<TestExecutionProgress>;
  if (
    progress.schemaVersion !== 1 ||
    typeof progress.sessionId !== 'string' ||
    typeof progress.runId !== 'string' ||
    typeof progress.taskId !== 'string' ||
    typeof progress.attemptId !== 'string' ||
    !phases.has(progress.phase as TestExecutionProgress['phase']) ||
    typeof progress.command !== 'string' ||
    typeof progress.cwd !== 'string' ||
    typeof progress.elapsedMs !== 'number' ||
    !Number.isSafeInteger(progress.elapsedMs) ||
    progress.elapsedMs < 0 ||
    typeof progress.heartbeatAt !== 'string' ||
    typeof progress.retryAttempt !== 'number' ||
    typeof progress.repairAttempt !== 'number' ||
    typeof progress.canCancel !== 'boolean'
  ) {
    return null;
  }
  if (progress.outcome != null && !outcomes.has(progress.outcome)) return null;
  return progress as TestExecutionProgress;
}
