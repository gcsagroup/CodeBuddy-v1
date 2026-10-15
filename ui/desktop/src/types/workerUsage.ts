export interface WorkerUsage {
  workerSessionId: string;
  runId: string;
  taskId: string;
  role: string;
  contextLimit: number;
  inputTokens?: number;
  outputTokens?: number;
  isCompaction: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function parseWorkerUsage(value: unknown): WorkerUsage | undefined {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    value.event !== 'worker_usage' ||
    typeof value.worker_session_id !== 'string' ||
    !record(value.origin) ||
    !record(value.usage)
  ) {
    return undefined;
  }
  const { origin, usage } = value;
  const limit = count(value.context_limit);
  if (
    typeof origin.run_id !== 'string' ||
    typeof origin.task_id !== 'string' ||
    typeof origin.role !== 'string' ||
    !limit
  )
    return undefined;
  return {
    workerSessionId: value.worker_session_id,
    runId: origin.run_id,
    taskId: origin.task_id,
    role: origin.role,
    contextLimit: limit,
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    isCompaction: usage.isCompaction === true,
  };
}
