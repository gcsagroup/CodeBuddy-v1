import type {
  ActivityEvent,
  ActivityEventStatus,
  ActivityEventType,
  CodeProRiskReason,
  CodeProRiskTier,
} from '../../types/activityEvent';
import { isTerminalActivityEventStatus, parseActivityEvent } from '../../types/activityEvent';
import type { SystemNotificationContent } from '../../types/message';
import type { CodeProFailureKind } from '../../codepro/failureSemantics';
import type { PublicProgressEvent, TestExecutionProgress } from '@aaif/goose-sdk';
import { parseTestExecutionProgress } from '../../types/testExecutionProgress';
import { parsePublicProgress } from '../../types/publicProgress';

export type CodeProActivityState = ActivityEventStatus;
export type CodeProExecutionFlow =
  | 'analysis'
  | 'simple_change'
  | 'independent_test'
  | 'project_test'
  | 'reviewed_test'
  | 'feature'
  | 'high_risk'
  | 'needs_inspection';

export interface CodeProActivityViewModel {
  key: string;
  source: 'activity_event' | 'public_progress' | 'test_progress' | 'legacy';
  runId: string | null;
  eventId: string | null;
  taskId: string | null;
  eventType: ActivityEventType;
  state: CodeProActivityState;
  statusLabel: string;
  verb: string;
  target: string;
  summary: string;
  title: string;
  toolName: string;
  path: string | null;
  command: string | null;
  duration: string | null;
  exitCode: number | null;
  parameters: string[];
  output: string | null;
  diffSummary: string | null;
  effectiveModel: string | null;
  failureKind: CodeProFailureKind | null;
  riskTier: CodeProRiskTier | null;
  previousRiskTier: CodeProRiskTier | null;
  flow: CodeProExecutionFlow | null;
  reviewRequired: boolean | null;
  riskReasons: CodeProRiskReason[];
  testProgress: TestExecutionProgress | null;
  structured: boolean;
}

export type CodeProActivityRenderItem =
  | { kind: 'activity'; key: string; activity: CodeProActivityViewModel }
  | { kind: 'read-group'; key: string; activities: CodeProActivityViewModel[] };

const OUTPUT_MAX_LINES = 50;
const OUTPUT_MAX_CHARACTERS = 4_000;
const taskSnapshotMarker = '--- CodePro 任务快照 ---';

function statusLabel(status: ActivityEventStatus): string {
  switch (status) {
    case 'pending':
      return '等待中';
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'stopped':
      return '已停止';
    case 'interrupted':
      return '已中断';
    case 'skipped':
      return '未执行这一步';
    case 'unknown':
      return '状态未知';
  }
}

function eventVerb(eventType: ActivityEventType): string {
  switch (eventType) {
    case 'file_read':
      return '读取';
    case 'file_changed':
      return '修改';
    case 'command_started':
    case 'command_completed':
      return '运行';
    case 'test_started':
    case 'test_completed':
      return '测试';
    case 'review_started':
    case 'review_completed':
      return '审查';
    case 'strategy_selected':
      return '选择策略';
    case 'strategy_updated':
      return '调整策略';
    case 'plan_created':
    case 'plan_updated':
      return '规划';
    case 'tool_started':
    case 'tool_completed':
      return '执行';
    default:
      return '处理';
  }
}

function eventToolName(event: ActivityEvent): string {
  if (event.command_summary?.startsWith('tool:')) {
    return event.command_summary.slice('tool:'.length) || 'tool';
  }
  switch (event.event_type) {
    case 'file_read':
      return 'developer__read';
    case 'file_changed':
      return 'developer__text_editor';
    case 'command_started':
    case 'command_completed':
    case 'test_started':
    case 'test_completed':
      return 'developer__shell';
    case 'review_started':
    case 'review_completed':
      return 'review';
    case 'strategy_selected':
    case 'strategy_updated':
      return 'codepro_execution_strategy';
    default:
      return 'tool';
  }
}

function eventTarget(event: ActivityEvent): string {
  if (
    event.command_summary &&
    !event.command_summary.startsWith('tool:') &&
    (event.event_type.startsWith('command_') || event.event_type.startsWith('test_'))
  ) {
    return event.command_summary;
  }
  return event.path ?? event.command_summary?.replace(/^tool:/, '') ?? event.title;
}

function formatDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
  const milliseconds = finished - started;
  if (milliseconds < 1_000) return `${milliseconds} 毫秒`;
  const seconds = milliseconds / 1_000;
  return `${Number(seconds.toFixed(2))} 秒`;
}

function boundOutput(value: string): string {
  const originalLines = value.split(/\r?\n/);
  let bounded = originalLines.slice(0, OUTPUT_MAX_LINES).join('\n');
  let truncated = originalLines.length > OUTPUT_MAX_LINES;
  const characters = Array.from(bounded);
  if (characters.length > OUTPUT_MAX_CHARACTERS) {
    bounded = characters.slice(0, OUTPUT_MAX_CHARACTERS).join('');
    truncated = true;
  }
  return truncated ? `${bounded}\n… 内容已截断` : bounded;
}

function technicalDetails(event: ActivityEvent): { parameters: string[]; output: string | null } {
  if (!event.technical_details?.trim()) return { parameters: [], output: null };
  const parameters: string[] = [];
  const output: string[] = [];
  for (const rawLine of event.technical_details.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parameterMatch = line.match(/^(?:参数|范围|深度)[:：]\s*(.*)$/);
    if (parameterMatch) {
      parameters.push(formatCodeProUserFacingText(parameterMatch[1] || line));
      continue;
    }
    output.push(formatCodeProUserFacingText(line.replace(/^(?:结果|输出)[:：]\s*/, '')));
  }
  return {
    parameters,
    output: output.length > 0 ? boundOutput(output.join('\n')) : null,
  };
}

function mergeActivityEvent(previous: ActivityEvent, incoming: ActivityEvent): ActivityEvent {
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
    command_summary: incoming.command_summary ?? previous.command_summary,
    technical_details: incoming.technical_details ?? previous.technical_details,
    exit_code: incoming.exit_code ?? previous.exit_code,
    diff_summary: incoming.diff_summary ?? previous.diff_summary,
    failure_kind: incoming.failure_kind ?? previous.failure_kind ?? null,
    risk_tier: incoming.risk_tier ?? previous.risk_tier ?? null,
    previous_risk_tier: incoming.previous_risk_tier ?? previous.previous_risk_tier ?? null,
    risk_reasons:
      incoming.risk_reasons && incoming.risk_reasons.length > 0
        ? incoming.risk_reasons
        : (previous.risk_reasons ?? []),
    selected_roles:
      incoming.selected_roles && incoming.selected_roles.length > 0
        ? incoming.selected_roles
        : (previous.selected_roles ?? []),
    review_required: incoming.review_required ?? previous.review_required ?? null,
  };
}

function executionFlow(event: ActivityEvent): CodeProExecutionFlow | null {
  if (!event.risk_tier) return null;
  if (event.risk_tier === 'unknown' || event.selected_roles?.includes('unknown')) {
    return 'needs_inspection';
  }
  const roles = event.selected_roles ?? [];
  const hasPlanner = roles.includes('planner');
  const hasCoder = roles.includes('coder');
  const hasTester = roles.includes('tester');
  const hasReviewer = roles.includes('reviewer');
  if (hasCoder && hasReviewer) return 'high_risk';
  if (hasCoder) return 'feature';
  if (hasTester && hasReviewer) return 'reviewed_test';
  if (hasTester && hasPlanner) return 'project_test';
  if (hasTester) return 'independent_test';
  if (event.risk_tier === 'l1_reversible_change') return 'simple_change';
  return 'analysis';
}

function structuredViewModel(event: ActivityEvent): CodeProActivityViewModel {
  const verb = eventVerb(event.event_type);
  const target = eventTarget(event);
  const label = statusLabel(event.status);
  const details = technicalDetails(event);
  return {
    key: `${event.run_id}:${event.event_id}`,
    source: 'activity_event',
    runId: event.run_id,
    eventId: event.event_id,
    taskId: event.task_id,
    eventType: event.event_type,
    state: event.status,
    statusLabel: label,
    verb,
    target,
    summary: `${verb} ${target} · ${label}`,
    title: event.title,
    toolName: eventToolName(event),
    path: event.path,
    command:
      event.command_summary && !event.command_summary.startsWith('tool:')
        ? event.command_summary
        : null,
    duration: formatDuration(event.started_at, event.finished_at),
    exitCode: event.exit_code,
    parameters: details.parameters,
    output: details.output,
    diffSummary: event.diff_summary,
    effectiveModel: event.effective_model,
    failureKind: event.failure_kind ?? null,
    riskTier: event.risk_tier ?? null,
    previousRiskTier: event.previous_risk_tier ?? null,
    flow: executionFlow(event),
    reviewRequired: event.risk_tier === 'unknown' ? null : (event.review_required ?? null),
    riskReasons: event.risk_reasons ?? [],
    testProgress: null,
    structured: true,
  };
}

function testPhaseLabel(progress: TestExecutionProgress): string {
  if (progress.outcome === 'not_found') {
    return '未发现可执行测试入口，等待确认';
  }
  if (progress.outcome === 'prerequisite_unavailable') {
    return '测试前置服务不可用，等待前置服务或启动方式';
  }
  const { phase } = progress;
  return {
    capturing_baseline: '正在建立增量证据基线',
    discovering_workspace: '正在发现工作区',
    resolving_dependencies: '正在解析依赖',
    waiting_for_cargo_lock: '正在等待 Cargo 锁',
    compiling: '仍在编译',
    running_tests: '正在运行测试',
    capturing_results: '正在收集结果',
    repairing: '测试未通过，正在交给 Coder 修复',
    retesting: '正在复测',
    waiting_for_user: '需要你的允许',
    completed: '测试执行完成',
  }[phase];
}

function testProgressState(progress: TestExecutionProgress): ActivityEventStatus {
  switch (progress.outcome) {
    case 'cancelled':
      return 'cancelled';
    case 'infrastructure_failed':
      return 'failed';
    case 'succeeded':
      return 'completed';
    case 'permission_required':
    case 'outside_workspace':
    case 'not_found':
    case 'prerequisite_unavailable':
      return 'pending';
    case 'verification_failed':
      return 'running';
    case 'path_corrected':
    case 'locked':
    case 'busy':
    case null:
    case undefined:
      return progress.phase === 'completed' ? 'completed' : 'running';
  }
}

function testProgressViewModel(progress: TestExecutionProgress): CodeProActivityViewModel {
  const state = testProgressState(progress);
  const label = statusLabel(state);
  const phase = testPhaseLabel(progress);
  const target = progress.currentTest ?? progress.currentCrate ?? progress.command ?? progress.cwd;
  const output = progress.lastOutput ? boundOutput(progress.lastOutput) : null;
  return {
    key: `test:${progress.runId}:${progress.attemptId}`,
    source: 'test_progress',
    runId: progress.runId,
    eventId: progress.attemptId,
    taskId: progress.taskId,
    eventType: 'test_started',
    state,
    statusLabel: label,
    verb: '测试',
    target,
    summary: `${phase}${target ? ` · ${target}` : ''}`,
    title: phase,
    toolName: 'developer__shell',
    path: progress.cwd,
    command: progress.command || null,
    duration: `${Number((progress.elapsedMs / 1_000).toFixed(1))} 秒`,
    exitCode: null,
    parameters: [],
    output,
    diffSummary: progress.reason ?? null,
    effectiveModel: null,
    failureKind: null,
    riskTier: null,
    previousRiskTier: null,
    flow: null,
    reviewRequired: null,
    riskReasons: [],
    testProgress: progress,
    structured: true,
  };
}

function publicProgressState(progress: PublicProgressEvent): ActivityEventStatus {
  switch (progress.status) {
    case 'pending':
    case 'waiting':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function publicProgressEventType(progress: PublicProgressEvent): ActivityEventType {
  switch (progress.phase) {
    case 'coding':
      return progress.status === 'completed' ? 'file_changed' : 'task_started';
    case 'testing':
      return progress.status === 'completed' ? 'test_completed' : 'test_started';
    case 'reviewing':
      return progress.status === 'completed' ? 'review_completed' : 'review_started';
    case 'tool_use':
      return progress.status === 'completed' ? 'tool_completed' : 'tool_started';
    case 'planning':
      return progress.status === 'completed' ? 'plan_created' : 'plan_updated';
    case 'waiting':
      return 'approval_requested';
    case 'completing':
      return progress.status === 'completed' ? 'run_completed' : 'task_started';
  }
}

function publicProgressViewModel(progress: PublicProgressEvent): CodeProActivityViewModel {
  const state = publicProgressState(progress);
  const parameters: string[] = [];
  if (progress.nextStep)
    parameters.push(`下一步：${formatCodeProUserFacingText(progress.nextStep)}`);
  if (progress.waitReason) parameters.push(`等待原因：${progress.waitReason}`);
  if (progress.completed !== undefined || progress.total !== undefined) {
    parameters.push(`进度：${progress.completed ?? 0}/${progress.total ?? '?'}`);
  }
  const target =
    progress.currentFile ?? progress.currentCommand ?? progress.currentTool ?? progress.summary;
  return {
    key: `progress:${progress.runId}:${progress.attemptId}`,
    source: 'public_progress',
    runId: progress.runId,
    eventId: progress.attemptId,
    taskId: progress.taskId ?? null,
    eventType: publicProgressEventType(progress),
    state,
    statusLabel: statusLabel(state),
    verb: progress.summary,
    target,
    summary: formatCodeProUserFacingText(progress.summary),
    title: formatCodeProUserFacingText(progress.summary),
    toolName: progress.currentTool ?? progress.role,
    path: progress.currentFile ?? null,
    command: progress.currentCommand ?? null,
    duration: `${Number((progress.elapsedMs / 1_000).toFixed(1))} 秒`,
    exitCode: null,
    parameters,
    output: progress.incrementalOutput ? boundOutput(progress.incrementalOutput) : null,
    diffSummary: progress.waitReason ? formatCodeProUserFacingText(progress.waitReason) : null,
    effectiveModel: null,
    failureKind: null,
    riskTier: null,
    previousRiskTier: null,
    flow: null,
    reviewRequired: null,
    riskReasons: [],
    testProgress: null,
    structured: true,
  };
}

export function formatCodeProUserFacingText(value: string): string {
  return value
    .replace(/\bPlanner(?: Agent)?\b/gi, '规划步骤')
    .replace(/\bCoder(?: Agent)?\b/gi, '代码修改步骤')
    .replace(/\bTester(?: Agent)?\b/gi, '验证步骤')
    .replace(/\bReviewer(?: Agent)?\b/gi, '最终检查步骤');
}

function legacyStatus(message: string): ActivityEventStatus {
  const normalized = message.toLowerCase();
  if (normalized.includes('状态：失败') || normalized.includes('status: failed')) return 'failed';
  if (normalized.includes('已取消') || normalized.includes('cancelled')) return 'cancelled';
  if (normalized.includes('已停止') || normalized.includes('stopped')) return 'stopped';
  if (
    normalized.includes('状态：成功') ||
    normalized.includes('status: success') ||
    normalized.includes('已读取') ||
    normalized.includes('执行完成')
  ) {
    return 'completed';
  }
  return 'running';
}

function legacyField(lines: string[], labels: string[]): string | null {
  for (const label of labels) {
    const prefix = `${label}：`;
    const value = lines
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim();
    if (value) return value;
  }
  return null;
}

function legacyViewModel(
  notification: SystemNotificationContent,
  index: number
): CodeProActivityViewModel {
  const [activityText] = notification.msg.split(taskSnapshotMarker, 1);
  const lines = activityText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const title = (lines[0] ?? 'CodePro').replace(/^CodePro\s*[·\-:]?\s*/, '').trim();
  const state = legacyStatus(notification.msg);
  const path = legacyField(lines, ['路径', '目录', '文件']);
  const command = legacyField(lines, ['命令']);
  const target = path ?? command ?? (title || '正在处理任务');
  const label = statusLabel(state);
  const details = lines
    .slice(1)
    .filter(
      (line) => !line.startsWith('活动ID：') && !/^(?:状态|路径|目录|文件|命令)[:：]/.test(line)
    );
  return {
    key: `legacy:${index}`,
    source: 'legacy',
    runId: null,
    eventId: null,
    taskId: null,
    eventType: 'unknown',
    state,
    statusLabel: label,
    verb: title || '处理',
    target,
    summary: `${title || '处理'} ${target === title ? '' : target} · ${label}`
      .replace(/\s+/g, ' ')
      .trim(),
    title: title || '正在处理任务',
    toolName: 'tool',
    path,
    command,
    duration: null,
    exitCode: null,
    parameters: details,
    output: null,
    diffSummary: null,
    effectiveModel: legacyField(lines, ['模型']),
    failureKind: null,
    riskTier: null,
    previousRiskTier: null,
    flow: null,
    reviewRequired: null,
    riskReasons: [],
    testProgress: null,
    structured: false,
  };
}

function canGroupRead(activity: CodeProActivityViewModel): boolean {
  return (
    activity.structured &&
    activity.eventType === 'file_read' &&
    activity.runId !== null &&
    (activity.state === 'completed' || activity.state === 'failed')
  );
}

export function buildCodeProActivityRenderItems(
  notifications: SystemNotificationContent[]
): CodeProActivityRenderItem[] {
  const ordered: Array<ActivityEvent | CodeProActivityViewModel> = [];
  const structuredIndexes = new Map<string, number>();

  notifications.forEach((notification, index) => {
    const publicProgress = parsePublicProgress(notification.data);
    if (publicProgress) {
      const key = `progress\0${publicProgress.runId}\0${publicProgress.attemptId}`;
      const activity = publicProgressViewModel(publicProgress);
      const existingIndex = structuredIndexes.get(key);
      if (existingIndex === undefined) {
        structuredIndexes.set(key, ordered.length);
        ordered.push(activity);
      } else {
        ordered[existingIndex] = activity;
      }
      return;
    }
    const testProgress = parseTestExecutionProgress(notification.data);
    if (testProgress) {
      const key = `test\0${testProgress.runId}\0${testProgress.attemptId}`;
      const activity = testProgressViewModel(testProgress);
      const existingIndex = structuredIndexes.get(key);
      if (existingIndex === undefined) {
        structuredIndexes.set(key, ordered.length);
        ordered.push(activity);
      } else {
        ordered[existingIndex] = activity;
      }
      return;
    }
    const event = parseActivityEvent(notification.data);
    if (!event) {
      ordered.push(legacyViewModel(notification, index));
      return;
    }
    const key = `${event.run_id}\0${event.event_id}`;
    const existingIndex = structuredIndexes.get(key);
    if (existingIndex === undefined) {
      structuredIndexes.set(key, ordered.length);
      ordered.push(event);
      return;
    }
    const previous = ordered[existingIndex];
    if ('schema_version' in previous) {
      ordered[existingIndex] = mergeActivityEvent(previous, event);
    }
  });

  const activities = ordered.map((entry) =>
    'schema_version' in entry ? structuredViewModel(entry) : entry
  );
  const result: CodeProActivityRenderItem[] = [];
  for (let index = 0; index < activities.length; ) {
    const current = activities[index];
    if (!canGroupRead(current)) {
      result.push({ kind: 'activity', key: current.key, activity: current });
      index += 1;
      continue;
    }
    const reads = [current];
    let nextIndex = index + 1;
    while (
      nextIndex < activities.length &&
      canGroupRead(activities[nextIndex]) &&
      activities[nextIndex].runId === current.runId &&
      activities[nextIndex].taskId === current.taskId
    ) {
      reads.push(activities[nextIndex]);
      nextIndex += 1;
    }
    if (reads.length >= 2) {
      result.push({
        kind: 'read-group',
        key: `read-group:${current.runId}:${current.eventId}`,
        activities: reads,
      });
    } else {
      result.push({ kind: 'activity', key: current.key, activity: current });
    }
    index = nextIndex;
  }
  return result;
}
