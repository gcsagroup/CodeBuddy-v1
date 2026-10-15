import { parseToolAuditReceipt } from '../acp/adapter/toolAudit';
import type { ToolResponseMessageContent } from '../types/message';

export type ComputerToolOutcome = 'worked' | 'unknown' | 'failed' | 'rejected';
const actions = new Set(['focus', 'click', 'drag', 'scroll', 'type', 'key']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function computerToolOutcome(
  name: string,
  requestId: string,
  response: ToolResponseMessageContent | undefined
): ComputerToolOutcome | undefined {
  const action = /^(?:computer__|computer::)?computer_(\w+)$/.exec(name)?.[1];
  if (!action || !actions.has(action) || !response) return undefined;
  const audit = parseToolAuditReceipt(response.metadata?.toolAudit);
  // Only host-owned computer receipts have business semantics here.
  if (!audit || audit.extensionSource !== 'platform') return undefined;
  if (audit.toolName !== `computer::computer_${action}`) return 'unknown';
  if (audit.outcome !== 'success') return undefined;
  if (response.id !== requestId) return 'unknown';
  const result = response.toolResult;
  if (!result || result.status !== 'success') return undefined;
  if (!record(result.value)) return 'unknown';
  const content = result.value.content;
  if (!Array.isArray(content)) return 'unknown';
  const texts = content.filter((item) => record(item) && item.type === 'text');
  if (texts.length !== 1 || typeof texts[0].text !== 'string') return 'unknown';
  let body: unknown;
  try {
    body = JSON.parse(texts[0].text);
  } catch {
    return 'unknown';
  }
  if (
    !record(body) ||
    !record(body.trace) ||
    body.trace.step_id !== requestId ||
    body.trace.attempt_id !== requestId
  )
    return 'unknown';
  switch (body.outcome) {
    case 'worked':
      return record(body.performed) &&
        body.performed.action === action &&
        record(body.verification) &&
        body.verification.matched === true &&
        (body.verification.matched_before_action === false ||
          body.verification.attributable_target_transition === true) &&
        result.value.isError !== true
        ? 'worked'
        : 'unknown';
    case 'didnt':
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'rejected';
    default:
      return 'unknown';
  }
}
