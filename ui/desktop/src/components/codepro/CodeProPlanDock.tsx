import { useMemo } from 'react';
import MarkdownContent from '../MarkdownContent';
import { getToolRequests, getToolResponses, type Message } from '../../types/message';
import {
  parsePlanContext,
  planFromResponse,
  samePlanBinding,
  type BoundPlan,
  type PlanBinding,
} from '../../types/codeproPlan';
import { CodeProPlan, presentedToolCall } from './CodeProToolContent';

// Only host-bound receipts are current. Legacy/unbound lists stay in history.
export function CodeProPlanDock({
  messages,
  running,
  sessionId,
  activeRunId,
}: {
  messages: Message[];
  running: boolean;
  sessionId: string;
  activeRunId?: string | null;
}) {
  const current = useMemo(() => {
    const planCalls = new Set(
      messages
        .flatMap(getToolRequests)
        .filter((request) => {
          const name = presentedToolCall(request)?.name;
          return name === 'todo__todo_write' || name === 'todo_write';
        })
        .map((request) => request.id)
    );
    let selected: PlanBinding | null = null;
    let current: BoundPlan | undefined;
    const history: BoundPlan[] = [];
    for (const message of messages) {
      for (const content of message.content) {
        const context =
          content.type === 'systemNotification' ? parsePlanContext(content.data) : undefined;
        if (context && context.session_id === sessionId) {
          selected = context.selected;
          current = context.plan ?? undefined;
          if (context.plan) history.push(context.plan);
        }
      }
      for (const response of getToolResponses(message)) {
        if (!planCalls.has(response.id)) continue;
        const candidate = planFromResponse(response);
        if (candidate?.binding.session_id === sessionId) history.push(candidate);
        if (candidate && samePlanBinding(candidate.binding, selected)) current = candidate;
      }
    }
    // An older revision is readable history, never an automatically renewed plan.
    const selection = selected;
    const previous = selection
      ? [...history]
          .reverse()
          .find(
            (plan) =>
              plan.binding.run_id === selection.run_id &&
              plan.binding.requirement_revision < selection.requirement_revision
          )
      : undefined;
    return current
      ? { plan: current, historical: false }
      : previous
        ? { plan: previous, historical: true }
        : undefined;
  }, [messages, sessionId]);
  if (!current) return null;
  return (
    <div className="mx-4 mb-2" data-testid="plan-dock">
      <CodeProPlan
        key={`${sessionId}:${current.plan.binding.run_id}`}
        compact
        historical={current.historical}
        requestId={current.plan.request_id}
        content={current.plan.content}
        active={!current.historical && running && activeRunId === current.plan.binding.run_id}
      >
        <MarkdownContent content={current.plan.content} />
      </CodeProPlan>
    </div>
  );
}
