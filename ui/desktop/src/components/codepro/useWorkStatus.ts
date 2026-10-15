import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../i18n';
import type { PromptActivity } from '../../acp/chatSessionStore';
import { ChatState } from '../../types/chatState';

const labels = defineMessages({
  first: { id: 'workStatus.first', defaultMessage: 'Waiting for model response' },
  next: { id: 'workStatus.next', defaultMessage: 'Waiting for further output' },
  text: { id: 'workStatus.text', defaultMessage: 'Receiving the response' },
  thought: { id: 'workStatus.thought', defaultMessage: 'Receiving model activity' },
  question: { id: 'workStatus.question', defaultMessage: 'Waiting for your answer or approval' },
  cancel: { id: 'workStatus.cancel', defaultMessage: 'Stopping; waiting for confirmation' },
  check: { id: 'workStatus.check', defaultMessage: 'Checking execution results' },
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
  if (chatState === ChatState.WaitingForUserInput) return { source: 'question' as const };
  if (chatState !== ChatState.Streaming && chatState !== ChatState.Thinking)
    return { source: 'chat_state' as const };
  if (checking) return { source: 'check' as const };
  const silence = activity
    ? Math.max(0, Math.floor((now - (activity.receivedAt ?? activity.startedAt)) / 1000))
    : 0;
  const recent = activity?.receivedAt !== undefined && silence < 3;
  const source = input.thinking
    ? 'thought'
    : action
      ? 'tool'
      : recent && activity?.kind === 'text'
        ? 'text'
        : recent && activity?.kind === 'thought'
          ? 'thought'
          : stage && activity
            ? 'stage'
            : activity?.receivedAt !== undefined
              ? 'next'
              : 'first';
  return {
    source,
    title: source === 'stage' ? stage : source === 'tool' ? action : undefined,
    // This threshold changes only the display, never execution or timeout policy.
    quietSeconds: silence >= 15 ? silence : undefined,
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
        : intl.formatMessage(labels[source]);
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
