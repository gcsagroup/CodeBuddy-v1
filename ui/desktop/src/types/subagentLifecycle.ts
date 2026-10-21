// A display receipt from the host's native lifecycle hooks, never a task verdict.
export interface SubagentLifecycle {
  type: 'subagent_lifecycle';
  schema_version: 1;
  event_id: string;
  session_id: string;
  child_session_id: string;
  activation_id: string;
  phase: 'start' | 'end';
  label: string;
  created_at: number;
}

export function parseSubagentLifecycle(value: unknown): SubagentLifecycle | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Partial<SubagentLifecycle>;
  if (
    data.type !== 'subagent_lifecycle' ||
    data.schema_version !== 1 ||
    !['start', 'end'].includes(data.phase ?? '') ||
    typeof data.created_at !== 'number' ||
    !Number.isFinite(data.created_at) ||
    data.created_at < 0 ||
    !['event_id', 'session_id', 'child_session_id', 'activation_id', 'label'].every((key) => {
      const field = (data as Record<string, unknown>)[key];
      return typeof field === 'string' && field.trim().length > 0 && field.length <= 2048;
    })
  )
    return;
  return data as SubagentLifecycle;
}
