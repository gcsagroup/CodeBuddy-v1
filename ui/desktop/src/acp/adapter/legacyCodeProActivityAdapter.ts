import {
  ACTIVITY_EVENT_SCHEMA_VERSION,
  isTerminalActivityEventStatus,
  type ActivityEvent,
  type ActivityEventAgentRole,
  type ActivityEventStatus,
  type ActivityEventType,
} from '../../types/activityEvent';
import type { CodeProFailureKind } from '../../codepro/failureSemantics';

interface LegacyCodeProActivityOptions {
  sessionId: string;
  receivedAt: string;
  previous?: ActivityEvent | null;
}

type LegacyCodeProActivityEvent = ActivityEvent & {
  failure_kind?: CodeProFailureKind;
  failure_source?: 'legacy_text';
};

function field(lines: string[], label: string): string | null {
  const prefix = `${label}：`;
  return (
    lines
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() || null
  );
}

function eventStatus(message: string): ActivityEventStatus {
  const normalized = message.toLowerCase();
  if (normalized.includes('已取消') || normalized.includes('cancelled')) {
    return 'cancelled';
  }
  if (normalized.includes('已停止') || normalized.includes('stopped')) {
    return 'stopped';
  }
  if (
    normalized.includes('状态：失败') ||
    normalized.includes('status: failed') ||
    normalized.includes('执行失败') ||
    normalized.includes('检查失败')
  ) {
    return 'failed';
  }
  if (
    normalized.includes('状态：成功') ||
    normalized.includes('status: success') ||
    normalized.includes('执行完成') ||
    normalized.includes('已读取') ||
    normalized.includes('已查看') ||
    normalized.includes('已完成')
  ) {
    return 'completed';
  }
  return 'running';
}

function eventType(title: string, status: ActivityEventStatus): ActivityEventType {
  const completed = status === 'completed' || status === 'failed';
  if (title.includes('读取文件')) return 'file_read';
  if (title.includes('修改文件') || title.includes('写入文件')) return 'file_changed';
  if (title.includes('命令')) return completed ? 'command_completed' : 'command_started';
  if (title.includes('测试')) return completed ? 'test_completed' : 'test_started';
  if (title.includes('审查')) return completed ? 'review_completed' : 'review_started';
  if (title.includes('审批')) return completed ? 'approval_resolved' : 'approval_requested';
  if (title.includes('工具') || title.includes('项目结构')) {
    return completed ? 'tool_completed' : 'tool_started';
  }
  return 'unknown';
}

function agentRole(message: string): ActivityEventAgentRole | null {
  const normalized = message.toLowerCase();
  for (const role of ['planner', 'coder', 'tester', 'reviewer'] as const) {
    if (normalized.includes(`${role} agent`)) {
      return role;
    }
  }
  return null;
}

export function adaptLegacyCodeProActivity(
  message: string,
  options: LegacyCodeProActivityOptions
): LegacyCodeProActivityEvent | null {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  if (!first.startsWith('CodePro')) {
    return null;
  }

  const eventId = field(lines, '活动ID');
  if (!eventId) {
    return null;
  }

  const title = first.replace(/^CodePro\s*[·\-:]?\s*/, '').trim() || '正在处理任务';
  const status = eventStatus(message);
  const finishedAt = isTerminalActivityEventStatus(status) ? options.receivedAt : null;
  const exitCodeText = field(lines, '退出码');
  const technicalDetails = lines.filter((line) => !line.startsWith('活动ID：')).slice(1);

  return {
    schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: eventId,
    event_type: eventType(title, status),
    session_id: options.sessionId,
    run_id: options.previous?.run_id ?? `legacy:${options.sessionId}`,
    task_id: field(lines, '任务ID'),
    parent_task_id: field(lines, '父任务ID'),
    agent_role: agentRole(message),
    effective_model: field(lines, '模型'),
    status,
    started_at: options.previous?.started_at ?? options.receivedAt,
    finished_at: finishedAt,
    title,
    technical_details: technicalDetails.length > 0 ? technicalDetails.join('\n') : null,
    path: field(lines, '路径') ?? field(lines, '目录'),
    command_summary: field(lines, '命令'),
    exit_code: exitCodeText && /^-?\d+$/.test(exitCodeText) ? Number(exitCodeText) : null,
    diff_summary: field(lines, 'Diff摘要'),
    include_in_model_context: false,
    retryable: true,
    retry_from_event_id: null,
    ...(status === 'cancelled'
      ? { failure_kind: 'cancelled' as const, failure_source: 'legacy_text' as const }
      : {}),
  };
}
