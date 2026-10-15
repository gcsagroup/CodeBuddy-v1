import type { Message, ToolResponse } from './message';

export type PlanBinding = { session_id: string; run_id: string; requirement_revision: number };
export type BoundPlan = { binding: PlanBinding; content: string; request_id: string };
export type PlanContext = {
  type: 'codepro_plan_context';
  schema_version: 1;
  event_id: string;
  session_id: string;
  selected: PlanBinding | null;
  plan: BoundPlan | null;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function binding(value: unknown): PlanBinding | undefined {
  const data = object(value);
  return data &&
    typeof data.session_id === 'string' &&
    typeof data.run_id === 'string' &&
    Number.isSafeInteger(data.requirement_revision) &&
    Number(data.requirement_revision) >= 0
    ? (data as PlanBinding)
    : undefined;
}
export function samePlanBinding(a: PlanBinding | null | undefined, b: PlanBinding | null | undefined) {
  return (
    !!a &&
    !!b &&
    a.session_id === b.session_id &&
    a.run_id === b.run_id &&
    a.requirement_revision === b.requirement_revision
  );
}
function plan(value: unknown): BoundPlan | undefined {
  const data = object(value);
  return data &&
    binding(data.binding) &&
    typeof data.content === 'string' &&
    typeof data.request_id === 'string'
    ? (data as BoundPlan)
    : undefined;
}
export function parsePlanContext(value: unknown): PlanContext | undefined {
  const data = object(value);
  if (
    !data ||
    data.type !== 'codepro_plan_context' ||
    data.schema_version !== 1 ||
    typeof data.event_id !== 'string' ||
    typeof data.session_id !== 'string' ||
    !(data.selected === null || binding(data.selected)) ||
    !(data.plan === null || plan(data.plan))
  ) return undefined;
  const context = data as PlanContext;
  if (context.selected && context.selected.session_id !== context.session_id) return undefined;
  if (context.plan && !samePlanBinding(context.selected, context.plan.binding)) return undefined;
  return context;
}
export function isPlanContextMessage(message: Message): boolean {
  return (
    message.content.length > 0 &&
    message.content.every(
      (content) => content.type === 'systemNotification' && !!parsePlanContext(content.data)
    )
  );
}
export function planFromResponse(response: ToolResponse): BoundPlan | undefined {
  const result = object(response.toolResult.value) ?? response.toolResult;
  if (response.toolResult.status === 'error' || result.isError === true) return undefined;
  const structured = object(result.structuredContent);
  const candidate = plan(structured?.codepro_plan);
  return candidate?.request_id === response.id ? candidate : undefined;
}
