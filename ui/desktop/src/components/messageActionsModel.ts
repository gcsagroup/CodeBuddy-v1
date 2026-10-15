import {
  isTerminalActivityEventStatus,
  parseActivityEvent,
  type ActivityEvent,
} from '../types/activityEvent';
import type { Message } from '../types/message';
import type { RetryStrategy, TurnTerminalRecord, TurnTerminalStatus } from '../types/turnTerminal';

export type AssistantRetryMode = 'continue' | 'replay' | 'retry_validation' | 'resubmit' | 'none';

export interface AssistantMessageActionPolicy {
  showActionGroup: boolean;
  copySource: 'text' | 'terminal' | null;
  retryMode: AssistantRetryMode;
  showTextActionGroup: boolean;
}

export interface TerminalExecutionSummary {
  status: TurnTerminalStatus;
  completedActions: string[];
  stopPosition: string | null;
  paths: string[];
  results: string[];
  retryStrategy: RetryStrategy;
}

interface AssistantMessageActionInput {
  displayText: string;
  isStreaming: boolean;
  superseded?: boolean;
  terminal?: AssistantActionTerminal;
}

type AssistantActionTerminal = Pick<TurnTerminalRecord, 'checkpoint_id' | 'retry_strategy'> & {
  report?: Pick<NonNullable<TurnTerminalRecord['report']>, 'recovery_action'>;
};

export function resolveAssistantRetryMode(terminal?: AssistantActionTerminal): AssistantRetryMode {
  if (terminal?.report?.recovery_action === 'ask_user') {
    return 'none';
  }
  if (terminal?.retry_strategy === 'continue_checkpoint' && terminal.checkpoint_id) {
    return 'continue';
  }
  if (terminal?.retry_strategy === 'retry_failed_validation') {
    return 'retry_validation';
  }
  if (terminal?.retry_strategy === 'not_available') {
    return 'none';
  }
  if (terminal?.retry_strategy === 'replay_user_request') {
    return 'replay';
  }
  return 'resubmit';
}

export function getAssistantMessageActionPolicy({
  displayText,
  isStreaming,
  superseded = false,
  terminal,
}: AssistantMessageActionInput): AssistantMessageActionPolicy {
  if (isStreaming || superseded) {
    return {
      showActionGroup: false,
      copySource: null,
      retryMode: 'none',
      showTextActionGroup: false,
    };
  }

  const hasText = displayText.trim().length > 0;
  const hasTerminal = terminal !== undefined;
  const showActionGroup = hasText || hasTerminal;

  return {
    showActionGroup,
    copySource: hasTerminal ? 'terminal' : hasText ? 'text' : null,
    retryMode: showActionGroup ? resolveAssistantRetryMode(terminal) : 'none',
    showTextActionGroup: showActionGroup && !hasTerminal,
  };
}

const MAX_ACTIONS = 3;
const MAX_PATHS = 5;
const MAX_PATH_LENGTH = 180;

function safePath(path: string | null): string | null {
  if (!path) return null;
  const normalized = [...path]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('')
    .trim();
  return normalized ? normalized.slice(0, MAX_PATH_LENGTH) : null;
}

function mergeEvent(previous: ActivityEvent, incoming: ActivityEvent): ActivityEvent {
  if (
    isTerminalActivityEventStatus(previous.status) &&
    !isTerminalActivityEventStatus(incoming.status)
  ) {
    return previous;
  }
  return {
    ...previous,
    ...incoming,
    started_at: previous.started_at || incoming.started_at,
    finished_at: incoming.finished_at ?? previous.finished_at,
    path: incoming.path ?? previous.path,
    exit_code: incoming.exit_code ?? previous.exit_code,
    diff_summary: incoming.diff_summary ?? previous.diff_summary,
  };
}

function completedAction(event: ActivityEvent): string | null {
  const path = safePath(event.path);
  switch (event.event_type) {
    case 'file_read':
      return path ? `Read ${path}` : 'Read a file';
    case 'file_changed':
      return path ? `Changed ${path}` : 'Changed a file';
    case 'test_completed':
      return event.exit_code === null ? 'Tested' : `Tested (exit code ${event.exit_code})`;
    case 'command_completed':
      return event.exit_code === null
        ? 'Command finished'
        : `Command finished (exit code ${event.exit_code})`;
    case 'tool_completed':
      return 'Tool action completed';
    case 'task_completed':
      return 'Task completed';
    case 'review_completed':
      return 'Review completed';
    case 'plan_created':
      return 'Plan created';
    case 'plan_updated':
      return 'Plan updated';
    case 'intent_completed':
      return 'Intent analysis completed';
    default:
      return null;
  }
}

function stoppedAction(event: ActivityEvent): string | null {
  const path = safePath(event.path);
  switch (event.event_type) {
    case 'file_read':
      return path ? `Reading ${path}` : 'Reading a file';
    case 'file_changed':
      return path ? `Changing ${path}` : 'Changing a file';
    case 'test_started':
    case 'test_completed':
      return 'Testing';
    case 'command_started':
    case 'command_completed':
      return 'Running a command';
    case 'review_started':
    case 'review_completed':
      return 'Reviewing changes';
    case 'task_started':
    case 'task_failed':
      return 'Working on a task';
    case 'tool_started':
    case 'tool_completed':
      return 'Running a tool action';
    default:
      return event.status === 'failed' ||
        event.status === 'cancelled' ||
        event.status === 'interrupted'
        ? 'Processing the request'
        : null;
  }
}

function currentRunEvents(terminal: TurnTerminalRecord, messages: Message[]): ActivityEvent[] {
  const sourceIndex = messages.findIndex(
    (message) => message.id === terminal.source_user_message_id && message.role === 'user'
  );
  const terminalIndex = messages.findIndex(
    (message) => message.id === terminal.terminal_message_id
  );
  const start = sourceIndex >= 0 ? sourceIndex + 1 : 0;
  const end = terminalIndex >= start ? terminalIndex + 1 : messages.length;
  const ordered: ActivityEvent[] = [];
  const eventIndexes = new Map<string, number>();

  for (const message of messages.slice(start, end)) {
    for (const content of message.content) {
      if (content.type !== 'systemNotification') continue;
      const activity = parseActivityEvent(content.data);
      if (!activity || activity.run_id !== terminal.run_id) continue;
      const existingIndex = eventIndexes.get(activity.event_id);
      if (existingIndex === undefined) {
        eventIndexes.set(activity.event_id, ordered.length);
        ordered.push(activity);
      } else {
        ordered[existingIndex] = mergeEvent(ordered[existingIndex], activity);
      }
    }
  }
  return ordered;
}

export function buildTerminalExecutionSummary(
  terminal: TurnTerminalRecord,
  messages: Message[]
): TerminalExecutionSummary {
  const events = currentRunEvents(terminal, messages);
  const completedActions = events
    .filter((event) => event.status === 'completed')
    .map(completedAction)
    .filter((action): action is string => action !== null)
    .slice(0, MAX_ACTIONS);
  const stopPosition = [...events]
    .reverse()
    .find(
      (event) =>
        event.status === 'running' ||
        event.status === 'failed' ||
        event.status === 'cancelled' ||
        event.status === 'interrupted' ||
        event.status === 'stopped'
    );
  const paths = [
    ...new Set(
      events.map((event) => safePath(event.path)).filter((path): path is string => !!path)
    ),
  ].slice(0, MAX_PATHS);
  const changedPathCount = new Set(
    events
      .filter((event) => event.event_type === 'file_changed' && event.status === 'completed')
      .map((event) => safePath(event.path))
      .filter((path): path is string => !!path)
  ).size;
  const results = [`${terminal.tool_action_count} tool actions preserved`];
  if (changedPathCount > 0) {
    results.push(`${changedPathCount} ${changedPathCount === 1 ? 'file' : 'files'} changed`);
  }

  return {
    status: terminal.status,
    completedActions,
    stopPosition: stopPosition ? stoppedAction(stopPosition) : null,
    paths,
    results,
    retryStrategy: terminal.retry_strategy,
  };
}

export function formatTerminalExecutionSummary(summary: TerminalExecutionSummary): string {
  const status = {
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
  }[summary.status];
  const retry = {
    continue_checkpoint: 'Continue from the saved checkpoint',
    replay_user_request: 'Replay the original request as a linked run',
    retry_failed_validation: 'Retry only the failed validation',
    not_available: 'Retry is not available',
  }[summary.retryStrategy];
  const lines = [`Status: ${status}`];
  if (summary.completedActions.length > 0) {
    lines.push(`Completed work: ${summary.completedActions.join('; ')}`);
  }
  if (summary.stopPosition) {
    lines.push(`Stopped at: ${summary.stopPosition}`);
  }
  if (summary.paths.length > 0) {
    lines.push(`Paths: ${summary.paths.join('; ')}`);
  }
  lines.push(`Existing results: ${summary.results.join('; ')}`);
  lines.push(`Retry: ${retry}`);
  return lines.join('\n').slice(0, 2000);
}

export function resolveAssistantCopyText(
  displayText: string,
  terminal: TurnTerminalRecord,
  messages: Message[]
): string {
  return displayText.trim().length > 0
    ? displayText
    : formatTerminalExecutionSummary(buildTerminalExecutionSummary(terminal, messages));
}
