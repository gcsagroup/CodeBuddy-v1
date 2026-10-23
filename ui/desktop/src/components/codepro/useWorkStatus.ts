import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../i18n';
import type { PromptActivity } from '../../acp/chatSessionStore';
import { ChatState } from '../../types/chatState';
import { formatToolInputPreview } from '../ToolInputPreview';

const labels = defineMessages({
  first: { id: 'workStatus.first', defaultMessage: 'Working on your request' },
  preparing: { id: 'workStatus.preparing', defaultMessage: 'Getting ready' },
  connecting: { id: 'workStatus.connecting', defaultMessage: 'Connecting' },
  responseWait: {
    id: 'workStatus.responseWait',
    defaultMessage: 'Working on your request',
  },
  responseRead: {
    id: 'workStatus.responseRead',
    defaultMessage: 'Preparing a response',
  },
  children: {
    id: 'workStatus.children',
    defaultMessage:
      '{count, plural, one {# assistant is working} other {# assistants are working}}',
  },
  childResult: {
    id: 'workStatus.childResult',
    defaultMessage: 'Bringing the results together',
  },
  toolResult: {
    id: 'workStatus.toolResult',
    defaultMessage: 'Reviewing the tool results',
  },
  text: { id: 'workStatus.text', defaultMessage: 'Writing a response' },
  thought: { id: 'workStatus.thought', defaultMessage: 'Thinking' },
  question: { id: 'workStatus.question', defaultMessage: 'Your input is needed' },
  cancel: { id: 'workStatus.cancel', defaultMessage: 'Stopping the current operation' },
  check: { id: 'workStatus.check', defaultMessage: 'Checking execution results' },
  approval: { id: 'workStatus.approval', defaultMessage: 'Please approve: {action}' },
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
  if (execution?.toolInput && !action)
    return { source: 'toolInput' as const, preview: execution.toolInput };
  if (execution?.detail && !action) return { source: 'stage' as const, title: execution.detail };
  const transportSource =
    execution?.phase === 'model' && execution.modelRequestPhase
      ? (
          {
            preparing: 'preparing',
            connecting: 'connecting',
            waiting: 'responseWait',
            receiving: 'responseRead',
          } as const
        )[execution.modelRequestPhase]
      : undefined;
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
              : (transportSource ?? (stage && activity ? 'stage' : 'first'));
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
      : source === 'toolInput'
        ? selection.preview.id
        : source === 'stage'
          ? selection.title
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
    source === 'toolInput'
      ? formatToolInputPreview(intl, selection.preview)
      : 'title' in selection && selection.title
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
