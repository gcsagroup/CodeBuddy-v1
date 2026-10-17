import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../i18n';
import type { PromptActivity } from '../../acp/chatSessionStore';
import { ChatState } from '../../types/chatState';

const labels = defineMessages({
  first: { id: 'workStatus.first', defaultMessage: 'Waiting for model response' },
  children: {
    id: 'workStatus.children',
    defaultMessage:
      'Waiting for {count, plural, one {# subagent} other {# subagents}} to return results',
  },
  childResult: {
    id: 'workStatus.childResult',
    defaultMessage: 'Waiting for the main agent to process subagent results',
  },
  toolResult: {
    id: 'workStatus.toolResult',
    defaultMessage: 'Waiting for the main agent to process tool results',
  },
  text: { id: 'workStatus.text', defaultMessage: 'Receiving the response' },
  thought: { id: 'workStatus.thought', defaultMessage: 'Receiving model activity' },
  question: { id: 'workStatus.question', defaultMessage: 'Waiting for your answer or approval' },
  cancel: { id: 'workStatus.cancel', defaultMessage: 'Stopping; waiting for confirmation' },
  check: { id: 'workStatus.check', defaultMessage: 'Checking execution results' },
  approval: { id: 'workStatus.approval', defaultMessage: 'Waiting for your approval: {action}' },
  elapsed: { id: 'workStatus.elapsed', defaultMessage: '{seconds}s' },
});

interface WorkStatusInput {
  chatState: ChatState;
  activity?: PromptActivity;
  stage?: string;
  action?: string;
  actionId?: string;
  toolPending?: boolean;
  checking: boolean;
  cancelling?: boolean;
  thinking?: boolean;
}

// A projection of existing facts, not another task/phase state machine.
export function selectWorkStatus(input: WorkStatusInput, now: number) {
  const { chatState, activity, stage, action, checking, cancelling } = input;
  if (cancelling) return { source: 'cancel' as const };
  if (chatState === ChatState.WaitingForUserInput)
    return action ? { source: 'approval' as const, action } : { source: 'question' as const };
  if (chatState !== ChatState.Streaming && chatState !== ChatState.Thinking)
    return { source: 'chat_state' as const };
  if (checking) return { source: 'check' as const };
  const silence = activity
    ? Math.max(0, Math.floor((now - (activity.receivedAt ?? activity.startedAt)) / 1000))
    : 0;
  const recent = activity?.receivedAt !== undefined && silence < 3;
  const execution = activity?.execution;
  const source = action
    ? 'tool'
    : recent && activity?.kind === 'text'
      ? 'text'
      : recent && (input.thinking || activity?.kind === 'thought')
        ? 'thought'
        : execution?.phase === 'children' && execution.childCount > 0
          ? 'children'
          : execution?.phase === 'child_result'
            ? 'childResult'
            : execution?.phase === 'tool_result'
              ? 'toolResult'
              : stage && activity
                ? 'stage'
                : 'first';
  return {
    source,
    title: source === 'stage' ? stage : source === 'tool' ? action : undefined,
    childCount: execution?.childCount ?? 0,
    toolPending: Boolean(input.toolPending),
  } as const;
}

export function useWorkStatus(input: WorkStatusInput) {
  const intl = useIntl();
  const [now, setNow] = useState(Date.now);
  const active = input.chatState === ChatState.Streaming || input.chatState === ChatState.Thinking;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const selection = selectWorkStatus(input, Math.max(now, Date.now()));
  const { source } = selection;
  const statusKey = JSON.stringify([
    input.activity?.promptAttemptId,
    source,
    source === 'tool'
      ? [input.actionId ?? input.action, Boolean(input.toolPending)]
      : source === 'stage'
        ? input.stage
        : source === 'chat_state'
          ? input.chatState
          : source === 'children'
            ? selection.childCount
            : null,
  ]);
  const [clock, setClock] = useState(() => ({ key: statusKey, startedAt: Date.now() }));
  let startedAt = clock.startedAt;
  if (clock.key !== statusKey) {
    // Synchronize only on a semantic display boundary, never each received
    // chunk or timer tick. This avoids one frame with the previous state's age.
    startedAt = Date.now();
    setClock({ key: statusKey, startedAt });
  }
  const elapsedSeconds = active
    ? Math.max(0, Math.floor((Math.max(now, Date.now()) - startedAt) / 1000))
    : undefined;
  const title =
    'title' in selection && selection.title
      ? selection.title
      : source === 'chat_state' || source === 'stage' || source === 'tool'
        ? undefined
        : intl.formatMessage(labels[source], {
            count: 'childCount' in selection ? selection.childCount : 0,
            action: 'action' in selection ? selection.action : '',
          });
  const elapsed =
    elapsedSeconds !== undefined && elapsedSeconds >= 1
      ? intl.formatMessage(labels.elapsed, {
          seconds: elapsedSeconds,
        })
      : undefined;
  return {
    ...selection,
    elapsedSeconds,
    announcement: title,
    message: elapsed ? `${title} ${elapsed}` : title,
  };
}
