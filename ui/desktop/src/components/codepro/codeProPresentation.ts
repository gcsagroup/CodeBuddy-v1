import type { IntlShape, MessageDescriptor } from 'react-intl';
import { defineMessages } from '../../i18n';
import type { ActivityEventType } from '../../types/activityEvent';
import type { CodeProFailureKind } from '../../codepro/failureSemantics';
import type { CodeProActivityState, CodeProActivityViewModel } from './codeProActivityModel';
import type { CodeProTaskSummary, TaskCardData, TaskCardStatus } from './codeProTaskPanelModel';

const messages = defineMessages({
  taskQueued: { id: 'codeProPresentation.taskStatus.queued', defaultMessage: 'Queued' },
  taskRunning: { id: 'codeProPresentation.taskStatus.running', defaultMessage: 'Running' },
  taskPassed: { id: 'codeProPresentation.taskStatus.passed', defaultMessage: 'Passed' },
  taskFailed: {
    id: 'codeProPresentation.taskStatus.notCompleted',
    defaultMessage: 'Not completed',
  },
  taskSkipped: {
    id: 'codeProPresentation.taskStatus.notDynamicallyTested',
    defaultMessage: 'Not dynamically tested',
  },
  taskPaused: {
    id: 'codeProPresentation.taskStatus.paused',
    defaultMessage: 'Needs your input',
  },
  taskCancelled: { id: 'codeProPresentation.taskStatus.cancelled', defaultMessage: 'Stopped' },
  summaryIdle: {
    id: 'codeProPresentation.summaryStatus.idle',
    defaultMessage: 'Waiting for tasks',
  },
  summaryQueued: {
    id: 'codeProPresentation.summaryStatus.queued',
    defaultMessage: 'Waiting to run',
  },
  summaryRunning: { id: 'codeProPresentation.summaryStatus.running', defaultMessage: 'Running' },
  summaryCompleted: {
    id: 'codeProPresentation.summaryStatus.completed',
    defaultMessage: 'Completed',
  },
  summaryFailed: {
    id: 'codeProPresentation.summaryStatus.failed',
    defaultMessage: 'Needs attention',
  },
  summaryPaused: {
    id: 'codeProPresentation.summaryStatus.paused',
    defaultMessage: 'Needs your input',
  },
  summaryCancelled: {
    id: 'codeProPresentation.summaryStatus.cancelled',
    defaultMessage: 'Stopped',
  },
  verificationPassed: {
    id: 'codeProPresentation.verification.passed',
    defaultMessage: 'Tests passed',
  },
  verificationFailed: {
    id: 'codeProPresentation.verification.failed',
    defaultMessage: 'Tests failed',
  },
  verificationNoTests: {
    id: 'codeProPresentation.verification.noTests',
    defaultMessage: 'No tests found',
  },
  verificationEnvironment: {
    id: 'codeProPresentation.verification.environment',
    defaultMessage: 'Environment unavailable',
  },
  verificationCommand: {
    id: 'codeProPresentation.verification.command',
    defaultMessage: 'Command failed',
  },
  activityPending: { id: 'codeProPresentation.activityState.pending', defaultMessage: 'Pending' },
  activityRunning: { id: 'codeProPresentation.activityState.running', defaultMessage: 'Running' },
  activityCompleted: {
    id: 'codeProPresentation.activityState.completed',
    defaultMessage: 'Completed',
  },
  activityFailed: { id: 'codeProPresentation.activityState.failed', defaultMessage: 'Failed' },
  activityCancelled: {
    id: 'codeProPresentation.activityState.cancelled',
    defaultMessage: 'Cancelled',
  },
  activityStopped: { id: 'codeProPresentation.activityState.stopped', defaultMessage: 'Stopped' },
  activityInterrupted: {
    id: 'codeProPresentation.activityState.interrupted',
    defaultMessage: 'Interrupted',
  },
  activitySkipped: { id: 'codeProPresentation.activityState.skipped', defaultMessage: 'Skipped' },
  activityUnknown: {
    id: 'codeProPresentation.activityState.unknown',
    defaultMessage: 'Unknown status',
  },
  failurePolicyDenied: {
    id: 'codeProPresentation.failure.policyDenied',
    defaultMessage: 'Action needs adjustment',
  },
  failureUserDenied: {
    id: 'codeProPresentation.failure.userDenied',
    defaultMessage: 'Not authorized by user',
  },
  failureOutsideWorkspace: {
    id: 'codeProPresentation.failure.outsideWorkspace',
    defaultMessage: 'Waiting for workspace authorization',
  },
  failureForbidden: {
    id: 'codeProPresentation.failure.forbidden',
    defaultMessage: 'Operation forbidden',
  },
  failureCancelled: {
    id: 'codeProPresentation.failure.cancelled',
    defaultMessage: 'Task cancelled',
  },
  failureEnvironment: {
    id: 'codeProPresentation.failure.environmentFailure',
    defaultMessage: 'Environment unavailable',
  },
  verbRead: { id: 'codeProPresentation.activityVerb.read', defaultMessage: 'Read' },
  verbChange: { id: 'codeProPresentation.activityVerb.change', defaultMessage: 'Change' },
  verbCommand: { id: 'codeProPresentation.activityVerb.command', defaultMessage: 'Run' },
  verbTest: { id: 'codeProPresentation.activityVerb.test', defaultMessage: 'Test' },
  verbReview: { id: 'codeProPresentation.activityVerb.review', defaultMessage: 'Review' },
  verbStrategy: {
    id: 'codeProPresentation.activityVerb.strategy',
    defaultMessage: 'Choose strategy',
  },
  verbPlan: { id: 'codeProPresentation.activityVerb.plan', defaultMessage: 'Plan' },
  verbExecute: { id: 'codeProPresentation.activityVerb.execute', defaultMessage: 'Execute' },
  verbProcess: { id: 'codeProPresentation.activityVerb.process', defaultMessage: 'Process' },
  activitySummary: {
    id: 'codeProPresentation.activitySummary',
    defaultMessage: '{verb} {target} · {status}',
  },
  intentSummary: {
    id: 'codeProPresentation.intentSummary',
    defaultMessage: '{title} · {status}',
  },
});

const taskStatusMessages: Record<TaskCardStatus, MessageDescriptor> = {
  queued: messages.taskQueued,
  running: messages.taskRunning,
  passed: messages.taskPassed,
  failed: messages.taskFailed,
  skipped: messages.taskSkipped,
  paused: messages.taskPaused,
  cancelled: messages.taskCancelled,
};

const summaryStatusMessages: Record<CodeProTaskSummary['status'], MessageDescriptor> = {
  idle: messages.summaryIdle,
  queued: messages.summaryQueued,
  running: messages.summaryRunning,
  completed: messages.summaryCompleted,
  failed: messages.summaryFailed,
  paused: messages.summaryPaused,
  cancelled: messages.summaryCancelled,
};

const activityStateMessages: Record<CodeProActivityState, MessageDescriptor> = {
  pending: messages.activityPending,
  running: messages.activityRunning,
  completed: messages.activityCompleted,
  failed: messages.activityFailed,
  cancelled: messages.activityCancelled,
  stopped: messages.activityStopped,
  interrupted: messages.activityInterrupted,
  skipped: messages.activitySkipped,
  unknown: messages.activityUnknown,
};

const failureMessages: Record<CodeProFailureKind, MessageDescriptor> = {
  policy_denied: messages.failurePolicyDenied,
  user_denied: messages.failureUserDenied,
  outside_workspace: messages.failureOutsideWorkspace,
  forbidden: messages.failureForbidden,
  cancelled: messages.failureCancelled,
  environment_failure: messages.failureEnvironment,
};

export function formatCodeProTaskStatus(intl: IntlShape, status: TaskCardStatus): string {
  return intl.formatMessage(taskStatusMessages[status]);
}

export function formatCodeProSummaryStatus(
  intl: IntlShape,
  status: CodeProTaskSummary['status']
): string {
  return intl.formatMessage(summaryStatusMessages[status]);
}

export function formatCodeProVerificationOutcome(
  intl: IntlShape,
  outcome: TaskCardData['verificationOutcome'],
  status: TaskCardStatus
): string {
  if (outcome === 'passed') return intl.formatMessage(messages.verificationPassed);
  if (outcome === 'failed') return intl.formatMessage(messages.verificationFailed);
  if (outcome === 'no_tests') return intl.formatMessage(messages.verificationNoTests);
  if (outcome === 'environment_unavailable') {
    return intl.formatMessage(messages.verificationEnvironment);
  }
  if (outcome === 'command_failed') return intl.formatMessage(messages.verificationCommand);
  return formatCodeProTaskStatus(intl, status);
}

export type CodeProTerminalVerdict = 'PASS' | 'NOT_RUN' | 'FAIL' | 'BLOCKED' | 'WAITING_FOR_USER';

export function formatCodeProTerminalVerdict(
  intl: IntlShape,
  verdict: CodeProTerminalVerdict
): string {
  switch (verdict) {
    case 'PASS':
      return formatCodeProVerificationOutcome(intl, 'passed', 'passed');
    case 'FAIL':
      return formatCodeProVerificationOutcome(intl, 'failed', 'failed');
    case 'NOT_RUN':
      return formatCodeProTaskStatus(intl, 'skipped');
    case 'BLOCKED':
    case 'WAITING_FOR_USER':
      return formatCodeProSummaryStatus(intl, 'paused');
  }
}

export function formatCodeProActivityState(intl: IntlShape, state: CodeProActivityState): string {
  return intl.formatMessage(activityStateMessages[state]);
}

export function formatCodeProFailureKind(intl: IntlShape, failureKind: CodeProFailureKind): string {
  return intl.formatMessage(failureMessages[failureKind]);
}

export function formatCodeProActivityVerb(intl: IntlShape, eventType: ActivityEventType): string {
  switch (eventType) {
    case 'file_read':
      return intl.formatMessage(messages.verbRead);
    case 'file_changed':
      return intl.formatMessage(messages.verbChange);
    case 'command_started':
    case 'command_completed':
      return intl.formatMessage(messages.verbCommand);
    case 'test_started':
    case 'test_completed':
      return intl.formatMessage(messages.verbTest);
    case 'review_started':
    case 'review_completed':
      return intl.formatMessage(messages.verbReview);
    case 'strategy_selected':
    case 'strategy_updated':
      return intl.formatMessage(messages.verbStrategy);
    case 'plan_created':
    case 'plan_updated':
      return intl.formatMessage(messages.verbPlan);
    case 'task_queued':
    case 'task_started':
    case 'task_completed':
    case 'task_failed':
    case 'task_skipped':
    case 'tool_started':
    case 'tool_completed':
      return intl.formatMessage(messages.verbExecute);
    default:
      return intl.formatMessage(messages.verbProcess);
  }
}

export function formatCodeProActivitySummary(
  intl: IntlShape,
  activity: CodeProActivityViewModel
): string {
  if (
    activity.eventType === 'intent_started' ||
    activity.eventType === 'intent_completed' ||
    activity.eventId?.startsWith('intent-classification-') ||
    activity.eventId?.startsWith('thinking-')
  ) {
    return intl.formatMessage(messages.intentSummary, {
      title: activity.title,
      status: formatCodeProActivityState(intl, activity.state),
    });
  }
  return intl.formatMessage(messages.activitySummary, {
    verb: formatCodeProActivityVerb(intl, activity.eventType),
    target: activity.target,
    status: activity.failureKind
      ? formatCodeProFailureKind(intl, activity.failureKind)
      : formatCodeProActivityState(intl, activity.state),
  });
}
