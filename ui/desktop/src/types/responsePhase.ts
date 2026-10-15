import type { Message } from './message';

// Presentation provenance, not a completion receipt or a second run state.
export interface ResponsePhase {
  type: 'codepro_response_phase';
  schema_version: 1;
  event_type: 'response_phase';
  event_id: string;
  session_id: string;
  run_id: string;
  source_user_message_id: string;
  phase: 'answer';
  created_at: number;
}

export function parseResponsePhase(value: unknown): ResponsePhase | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Partial<ResponsePhase>;
  if (
    data.type !== 'codepro_response_phase' ||
    data.schema_version !== 1 ||
    data.event_type !== 'response_phase' ||
    data.phase !== 'answer' ||
    typeof data.created_at !== 'number' ||
    !Number.isFinite(data.created_at) ||
    data.created_at < 0 ||
    !['event_id', 'session_id', 'run_id', 'source_user_message_id'].every(
      (key) =>
        typeof (data as Record<string, unknown>)[key] === 'string' &&
        (data as Record<string, string>)[key].trim().length > 0
    )
  )
    return undefined;
  return data as ResponsePhase;
}

export function getResponsePhase(message: Message): ResponsePhase | undefined {
  for (const content of message.content) {
    if (content.type === 'systemNotification' && content.notificationType === 'progressMessage') {
      const phase = parseResponsePhase(content.data);
      if (phase) return phase;
    }
  }
  return undefined;
}
