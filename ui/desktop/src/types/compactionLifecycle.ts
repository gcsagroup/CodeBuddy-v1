export type CompactionStatus = 'started' | 'completed' | 'failed' | 'cancelled';
export type CompactionTrigger = 'manual' | 'auto' | 'recovery';

export interface CompactionLifecycle {
  schemaVersion: 1;
  event: 'compaction_lifecycle';
  operationId: string;
  status: CompactionStatus;
  trigger: CompactionTrigger;
  startedAt: string;
  runId?: string;
  taskId?: string;
  workerSessionId?: string;
  budget?: {
    source: 'provider_actual' | 'local_estimate' | 'unavailable';
    contextLimit?: number;
    projectedInputTokens?: number;
    outputReserveTokens?: number;
    projectedTotalTokens?: number;
  };
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseCompactionLifecycle(value: unknown): CompactionLifecycle | undefined {
  if (!isRecord(value) || value.event !== 'compaction_lifecycle' || value.schema_version !== 1) {
    return undefined;
  }
  if (
    !['started', 'completed', 'failed', 'cancelled'].includes(String(value.status)) ||
    !['manual', 'auto', 'recovery'].includes(String(value.trigger)) ||
    typeof value.started_at !== 'string' ||
    typeof value.operation_id !== 'string' ||
    !value.operation_id ||
    !Number.isFinite(Date.parse(value.started_at))
  ) {
    return undefined;
  }

  const rawBudget = isRecord(value.budget) ? value.budget : undefined;
  return {
    schemaVersion: 1,
    event: 'compaction_lifecycle',
    operationId: value.operation_id,
    status: value.status as CompactionStatus,
    trigger: value.trigger as CompactionTrigger,
    startedAt: value.started_at,
    runId:
      isRecord(value.origin) && typeof value.origin.run_id === 'string'
        ? value.origin.run_id
        : undefined,
    taskId:
      isRecord(value.origin) && typeof value.origin.task_id === 'string'
        ? value.origin.task_id
        : undefined,
    workerSessionId:
      typeof value.worker_session_id === 'string' ? value.worker_session_id : undefined,
    ...(rawBudget
      ? {
          budget: {
            source:
              rawBudget.source === 'provider_actual' ||
              rawBudget.source === 'local_estimate' ||
              rawBudget.source === 'unavailable'
                ? rawBudget.source
                : 'unavailable',
            ...(typeof rawBudget.context_limit === 'number'
              ? { contextLimit: rawBudget.context_limit }
              : {}),
            ...(typeof rawBudget.projected_input_tokens === 'number'
              ? { projectedInputTokens: rawBudget.projected_input_tokens }
              : {}),
            ...(typeof rawBudget.output_reserve_tokens === 'number'
              ? { outputReserveTokens: rawBudget.output_reserve_tokens }
              : {}),
            ...(typeof rawBudget.projected_total_tokens === 'number'
              ? { projectedTotalTokens: rawBudget.projected_total_tokens }
              : {}),
          },
        }
      : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}
