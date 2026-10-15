import {
  generateMessageId,
  getTextAndImageContent,
  getToolRequests,
  type Message,
  type SystemNotificationContent,
} from './message';
import {
  codeProFailureContract,
  isCodeProFailureKind,
  type CodeProFailureKind,
  type CodeProFailureUserAction,
} from '../codepro/failureSemantics';
import {
  normalizeCodeProRiskReason,
  normalizeCodeProRiskTier,
  type CodeProRiskReason,
  type CodeProRiskTier,
} from './activityEvent';

export type TurnTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type RetryStrategy =
  | 'continue_checkpoint'
  | 'replay_user_request'
  | 'retry_failed_validation'
  | 'not_available';

export type MessageEditType =
  | 'fork'
  | 'edit'
  | 'continue'
  | 'replay'
  | 'retry_validation'
  | 'retry';

export interface ValidationRetryEvidence {
  target_path: string;
  command: string;
  exit_code: number | null;
}

export type CodeProTerminalOutcome =
  | 'completed'
  | 'skipped'
  | 'partial'
  | 'paused'
  | 'waiting_for_user'
  | 'cancelled'
  | 'planning_failed'
  | 'scheduling_failed'
  | 'review_failed'
  | 'failed';

export type ReportRecoveryAction =
  | 'none'
  | 'retry_planning'
  | 'continue_checkpoint'
  | 'ask_user'
  | 'retry_validation'
  | 'retry_review'
  | 'select_project_directory'
  | 'manual_review';

export type VerificationVerdict = 'passed' | 'skipped' | 'failed' | 'unverified' | 'unavailable';

export interface TurnTerminalVerificationSummary {
  task_id: string;
  verdict: VerificationVerdict;
  command: string | null;
  exit_code: number | null;
  evidence_ref: string;
}

export interface TurnTerminalReport {
  outcome: CodeProTerminalOutcome;
  classification_counts: {
    confirmed_bug: number;
    test_failure: number;
    environment_problem: number;
    codepro_incomplete: number;
    unverified: number;
  };
  changed_files: string[];
  verification_summary: TurnTerminalVerificationSummary[];
  limitations: string[];
  recovery_action: ReportRecoveryAction;
  risk_tier?: CodeProRiskTier | null;
  risk_reasons?: CodeProRiskReason[];
  review_required?: boolean;
}

interface TurnTerminalRecordBase {
  schema_version: 1;
  session_id: string;
  run_id: string;
  terminal_message_id: string;
  source_user_message_id: string;
  status: TurnTerminalStatus;
  visible_text_available: boolean;
  tool_action_count: number;
  copy_artifact_ref: string | null;
  finished_at: string;
  retry_of_terminal_message_id?: string | null;
  failure_kind?: CodeProFailureKind;
  retryable?: boolean;
  user_action?: CodeProFailureUserAction;
  report?: TurnTerminalReport;
  report_parse_failed?: true;
}

export type TurnTerminalRecord = TurnTerminalRecordBase &
  (
    | {
        checkpoint_id: string;
        retry_strategy: 'continue_checkpoint';
        validation_retry?: never;
      }
    | {
        checkpoint_id: null;
        retry_strategy: 'replay_user_request';
        validation_retry?: never;
      }
    | {
        status: 'failed';
        checkpoint_id: null;
        retry_strategy: 'retry_failed_validation';
        validation_retry: ValidationRetryEvidence;
      }
    | {
        checkpoint_id: string | null;
        retry_strategy: 'not_available';
        validation_retry?: never;
      }
  );

export function getTurnTerminalRecord(message: Message): TurnTerminalRecord | undefined {
  for (const content of message.content) {
    if (content.type !== 'systemNotification' || content.notificationType !== 'turnTerminal') {
      continue;
    }

    const record = parseTurnTerminalRecord(content.data);
    if (record) {
      return record;
    }
  }

  return undefined;
}

export function createCancelledToolTurnTerminalMessage(
  sessionId: string,
  runId: string,
  messages: Message[],
  finishedAt = new Date().toISOString()
): Message | undefined {
  const sourceUserMessageIndex = findLastUserMessageIndex(messages);
  const sourceUserMessage = messages[sourceUserMessageIndex];
  if (sourceUserMessageIndex < 0 || !sourceUserMessage?.id) {
    return undefined;
  }

  const currentTurnMessages = messages.slice(sourceUserMessageIndex + 1);
  const toolActionCount = currentTurnMessages.reduce(
    (count, message) => count + getToolRequests(message).length,
    0
  );
  if (toolActionCount === 0 || currentTurnMessages.some(getTurnTerminalRecord)) {
    return undefined;
  }

  const terminalMessageId = generateMessageId();
  const failure = codeProFailureContract('cancelled');
  const record: TurnTerminalRecord = {
    schema_version: 1,
    session_id: sessionId,
    run_id: runId,
    terminal_message_id: terminalMessageId,
    source_user_message_id: sourceUserMessage.id,
    status: 'cancelled',
    checkpoint_id: null,
    retry_strategy: 'replay_user_request',
    visible_text_available: false,
    tool_action_count: toolActionCount,
    copy_artifact_ref: null,
    finished_at: finishedAt,
    failure_kind: 'cancelled',
    retryable: failure.retryable,
    user_action: failure.userAction,
  };

  const terminalContent: SystemNotificationContent & { type: 'systemNotification' } = {
    type: 'systemNotification',
    notificationType: 'turnTerminal',
    msg: 'Turn stopped',
    data: record,
  };

  return {
    id: terminalMessageId,
    role: 'assistant',
    created: Math.floor(new Date(finishedAt).getTime() / 1000),
    content: [terminalContent],
    metadata: { userVisible: true, agentVisible: false },
  };
}

function findLastUserMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === 'user' &&
      message.metadata.userVisible &&
      getTextAndImageContent(message).textContent.trim().length > 0
    ) {
      return index;
    }
  }

  return -1;
}

export function isTurnTerminalRecord(value: unknown): value is TurnTerminalRecord {
  const parsed = parseTurnTerminalRecord(value);
  if (!parsed) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return raw.report === undefined || isTurnTerminalReport(raw.report);
}

export function parseTurnTerminalRecord(value: unknown): TurnTerminalRecord | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const baseValid =
    record.schema_version === 1 &&
    typeof record.session_id === 'string' &&
    typeof record.run_id === 'string' &&
    typeof record.terminal_message_id === 'string' &&
    typeof record.source_user_message_id === 'string' &&
    isTurnTerminalStatus(record.status) &&
    isRetryStrategy(record.retry_strategy) &&
    typeof record.visible_text_available === 'boolean' &&
    typeof record.tool_action_count === 'number' &&
    (record.copy_artifact_ref === null || typeof record.copy_artifact_ref === 'string') &&
    typeof record.finished_at === 'string' &&
    (record.retry_of_terminal_message_id === undefined ||
      record.retry_of_terminal_message_id === null ||
      typeof record.retry_of_terminal_message_id === 'string');
  if (!baseValid) {
    return undefined;
  }
  if (!isValidFailureContract(record)) {
    return undefined;
  }

  let retryValid: boolean;
  if (record.retry_strategy === 'retry_failed_validation') {
    retryValid =
      record.status === 'failed' &&
      record.checkpoint_id === null &&
      isValidationRetryEvidence(record.validation_retry);
  } else if (record.retry_strategy === 'continue_checkpoint') {
    retryValid = typeof record.checkpoint_id === 'string' && record.checkpoint_id.trim().length > 0;
  } else {
    retryValid = record.checkpoint_id === null || typeof record.checkpoint_id === 'string';
  }
  if (!retryValid) {
    return undefined;
  }

  const parsed = { ...record } as unknown as TurnTerminalRecord;
  delete parsed.report_parse_failed;
  if (record.report !== undefined) {
    if (isTurnTerminalReport(record.report)) {
      const report = record.report as TurnTerminalReport;
      if (
        !isTerminalStatusCompatibleWithReport(record.status as TurnTerminalStatus, report.outcome)
      ) {
        return undefined;
      }
      parsed.report = {
        ...report,
        risk_tier: normalizeCodeProRiskTier(report.risk_tier),
        risk_reasons: (report.risk_reasons ?? []).map(normalizeCodeProRiskReason),
        review_required: report.review_required ?? false,
      };
    } else {
      delete parsed.report;
      parsed.report_parse_failed = true;
    }
  }
  return parsed;
}

function isValidFailureContract(record: Record<string, unknown>): boolean {
  const fields = [record.failure_kind, record.retryable, record.user_action];
  if (fields.every((field) => field === undefined)) return true;
  if (
    !isCodeProFailureKind(record.failure_kind) ||
    typeof record.retryable !== 'boolean' ||
    typeof record.user_action !== 'string'
  ) {
    return false;
  }
  const contract = codeProFailureContract(record.failure_kind);
  if (record.retryable !== contract.retryable || record.user_action !== contract.userAction) {
    return false;
  }
  return record.failure_kind === 'cancelled'
    ? record.status === 'cancelled'
    : record.status === 'failed';
}

function isTerminalStatusCompatibleWithReport(
  status: TurnTerminalStatus,
  outcome: CodeProTerminalOutcome
): boolean {
  switch (outcome) {
    case 'completed':
    case 'skipped':
      return status === 'completed';
    case 'partial':
    case 'paused':
    case 'waiting_for_user':
      return status === 'interrupted';
    case 'cancelled':
      return status === 'cancelled';
    case 'planning_failed':
    case 'scheduling_failed':
    case 'review_failed':
    case 'failed':
      return status === 'failed';
  }
}

function isTurnTerminalStatus(value: unknown): value is TurnTerminalStatus {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(value));
}

function isRetryStrategy(value: unknown): value is RetryStrategy {
  return [
    'continue_checkpoint',
    'replay_user_request',
    'retry_failed_validation',
    'not_available',
  ].includes(String(value));
}

function isValidationRetryEvidence(value: unknown): value is ValidationRetryEvidence {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const evidence = value as Record<string, unknown>;
  return (
    typeof evidence.target_path === 'string' &&
    evidence.target_path.trim().length > 0 &&
    typeof evidence.command === 'string' &&
    evidence.command.trim().length > 0 &&
    (evidence.exit_code === null ||
      (typeof evidence.exit_code === 'number' && Number.isInteger(evidence.exit_code)))
  );
}

function isTurnTerminalReport(value: unknown): value is TurnTerminalReport {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const report = value as Record<string, unknown>;
  return (
    isOneOf(report.outcome, [
      'completed',
      'skipped',
      'partial',
      'paused',
      'waiting_for_user',
      'cancelled',
      'planning_failed',
      'scheduling_failed',
      'review_failed',
      'failed',
    ]) &&
    isClassificationCounts(report.classification_counts) &&
    isStringArray(report.changed_files) &&
    Array.isArray(report.verification_summary) &&
    report.verification_summary.every(isTurnTerminalVerificationSummary) &&
    isStringArray(report.limitations) &&
    (report.risk_tier === undefined ||
      report.risk_tier === null ||
      typeof report.risk_tier === 'string') &&
    (report.risk_reasons === undefined || isStringArray(report.risk_reasons)) &&
    (report.review_required === undefined || typeof report.review_required === 'boolean') &&
    isOneOf(report.recovery_action, [
      'none',
      'retry_planning',
      'continue_checkpoint',
      'ask_user',
      'retry_validation',
      'retry_review',
      'select_project_directory',
      'manual_review',
    ])
  );
}

function isClassificationCounts(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const counts = value as Record<string, unknown>;
  return [
    'confirmed_bug',
    'test_failure',
    'environment_problem',
    'codepro_incomplete',
    'unverified',
  ].every(
    (key) => typeof counts[key] === 'number' && Number.isInteger(counts[key]) && counts[key] >= 0
  );
}

function isTurnTerminalVerificationSummary(
  value: unknown
): value is TurnTerminalVerificationSummary {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.task_id === 'string' &&
    isOneOf(summary.verdict, ['passed', 'skipped', 'failed', 'unverified', 'unavailable']) &&
    (summary.command === null || typeof summary.command === 'string') &&
    (summary.exit_code === null ||
      (typeof summary.exit_code === 'number' && Number.isInteger(summary.exit_code))) &&
    typeof summary.evidence_ref === 'string'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}
