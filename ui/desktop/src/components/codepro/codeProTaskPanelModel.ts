import { parseActivityEvent, type ActivityEvent } from '../../types/activityEvent';
import { parseTurnTerminalRecord } from '../../types/turnTerminal';

export type TaskCardStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'paused'
  | 'cancelled';

export interface TaskCardData {
  acceptanceCriteria?: string;
  changeReport?: string;
  description?: string;
  filesChanged?: string[];
  id: string;
  name: string;
  role?: string;
  status: TaskCardStatus;
  testEvidence?: string;
  verificationOutcome?:
    | 'passed'
    | 'failed'
    | 'no_tests'
    | 'environment_unavailable'
    | 'command_failed';
}

export interface CodeProRunReport {
  changesApplied: boolean;
  reviewApproved: boolean;
  tasks: TaskCardData[];
  testOnly?: boolean;
  usage?: {
    costUsd?: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  workspacePath?: string;
}

export interface CodeProTaskSummary {
  completedCount: number;
  currentTask: TaskCardData | undefined;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
  statusLabel: string;
  totalCount: number;
}

export interface CodeProTaskPanelMessage {
  id?: string | null;
  role: string;
  created?: number;
  content: Array<{
    type: string;
    text?: string;
    notificationType?: string;
    msg?: string;
    data?: unknown;
  }>;
}

export interface CodeProTaskFileEvidence {
  eventId: string;
  kind: 'read' | 'changed';
  path: string;
  taskId: string | null;
}

export interface CodeProTaskPanelSnapshot {
  progressMessage?: string;
  messages: CodeProTaskPanelMessage[];
}

export type PausedTaskGuidance = 'pending' | 'continue_checkpoint' | 'ask_user' | 'manual_review';

export interface TurnTerminalRetryAction {
  sessionId: string;
  strategy: 'replay_user_request' | 'continue_checkpoint';
  terminalMessageId: string;
}

export function currentTurnTerminalRetryAction(
  messages: CodeProTaskPanelMessage[]
): TurnTerminalRetryAction | undefined {
  let currentTurnStart = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') currentTurnStart = index + 1;
  });
  for (let index = messages.length - 1; index >= currentTurnStart; index -= 1) {
    for (const content of messages[index].content) {
      if (content.type !== 'systemNotification' || content.notificationType !== 'turnTerminal') {
        continue;
      }
      const terminal = parseTurnTerminalRecord(content.data);
      if (!terminal || terminal.report?.recovery_action === 'ask_user') return undefined;
      if (
        terminal.retry_strategy !== 'replay_user_request' &&
        terminal.retry_strategy !== 'continue_checkpoint'
      ) {
        return undefined;
      }
      return {
        sessionId: terminal.session_id,
        strategy: terminal.retry_strategy,
        terminalMessageId: terminal.terminal_message_id,
      };
    }
  }
  return undefined;
}

export function pausedTaskGuidance(messages: CodeProTaskPanelMessage[]): PausedTaskGuidance {
  let currentTurnStart = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') currentTurnStart = index + 1;
  });
  for (let index = messages.length - 1; index >= currentTurnStart; index -= 1) {
    const message = messages[index];
    for (const content of message.content) {
      if (content.type !== 'systemNotification' || content.notificationType !== 'turnTerminal') {
        continue;
      }
      const terminal = parseTurnTerminalRecord(content.data);
      if (!terminal) continue;
      if (terminal.report?.recovery_action === 'ask_user') return 'ask_user';
      return terminal.retry_strategy === 'continue_checkpoint' && terminal.checkpoint_id
        ? 'continue_checkpoint'
        : 'manual_review';
    }
  }
  return 'pending';
}

const taskLine =
  /(?:^|\s)(✅|❌|⏸️|🛑|⏭️|⏳|🔄)\s+([^\s:]+):\s+(.+?)(?=\r?\n|\s+(?:✅|❌|⏸️|🛑|⏭️|⏳|🔄)\s+[^\s:]+:\s|$)/gs;

export function parseCodeProTasks(text: string): TaskCardData[] {
  const tasks = Array.from(
    text.matchAll(taskLine),
    (match): TaskCardData => ({
      id: match[2].trim(),
      name: match[3].trim(),
      status:
        match[1] === '✅'
          ? 'passed'
          : match[1] === '❌'
            ? 'failed'
            : match[1] === '⏸️'
              ? 'paused'
              : match[1] === '🛑'
                ? 'cancelled'
                : match[1] === '⏭️'
                  ? 'skipped'
                  : match[1] === '🔄'
                    ? 'running'
                    : 'queued',
    })
  );
  const currentTaskId = text.match(/(?:^|\s)当前任务：([^\s·]+)\s*·/m)?.[1]?.trim();
  if (!currentTaskId) return tasks;

  const role = text.match(/[（(]([A-Za-z]+)\s+Agent[）)]/)?.[1];
  const description = text.match(/^说明：(.+)$/m)?.[1]?.trim();
  const acceptanceCriteria = text.match(/^验收目标：(.+)$/m)?.[1]?.trim();
  return tasks.map((task) =>
    task.id === currentTaskId
      ? {
          ...task,
          ...(role ? { role } : {}),
          ...(description ? { description } : {}),
          ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
        }
      : task
  );
}

export function retainCodeProTasks(
  previousTasks: TaskCardData[],
  progressMessage: string
): TaskCardData[] {
  const currentTasks = parseCodeProTasks(progressMessage);
  return currentTasks.length > 0 ? currentTasks : previousTasks;
}

export function selectCodeProTasks({
  isRunning,
  liveTasks,
  reportTasks,
}: {
  isRunning: boolean;
  liveTasks: TaskCardData[];
  reportTasks?: TaskCardData[];
}): TaskCardData[] {
  if (isRunning) return liveTasks;
  if (!reportTasks) return liveTasks;
  return reportTasks.map((reportTask) => {
    const liveTask = liveTasks.find((task) => task.id === reportTask.id);
    return liveTask
      ? {
          ...liveTask,
          ...reportTask,
          name: liveTask.name || reportTask.name,
          role: reportTask.role ?? liveTask.role,
        }
      : reportTask;
  });
}

function parseModernCodeProTaskStatus(value: string): TaskCardStatus {
  if (value.includes('已完成')) return 'passed';
  if (value.includes('已跳过')) return 'skipped';
  if (value.includes('运行中') || value.includes('正在执行')) return 'running';
  if (value.includes('暂停') || value.includes('等待继续')) return 'paused';
  if (value.includes('取消') || value.includes('停止')) return 'cancelled';
  if (value.includes('失败') || value.includes('未完成')) return 'failed';
  return 'queued';
}

function taskStatusLabel(status: TaskCardStatus): string {
  const labels: Record<TaskCardStatus, string> = {
    queued: '已排队',
    running: '运行中',
    passed: '已通过',
    failed: '未完成',
    skipped: '未运行动态验证',
    paused: '需要你确认',
    cancelled: '已停止',
  };
  return labels[status];
}

export function taskOutcomeLabel(
  task: Pick<TaskCardData, 'status' | 'verificationOutcome'>
): string {
  if (task.verificationOutcome === 'failed') return '测试失败';
  if (task.verificationOutcome === 'no_tests') return '未发现测试';
  if (task.verificationOutcome === 'environment_unavailable') return '环境不可用';
  if (task.verificationOutcome === 'command_failed') return '执行失败';
  return taskStatusLabel(task.status);
}

function verificationOutcomeFromEvidence(
  testEvidence?: string
): TaskCardData['verificationOutcome'] {
  if (testEvidence?.includes('结果：环境不可用')) return 'environment_unavailable';
  if (testEvidence?.includes('结果：命令执行失败')) return 'command_failed';
  if (testEvidence?.includes('结果：未发现测试')) return 'no_tests';
  if (testEvidence?.match(/结果：(测试失败|检查失败)/)) return 'failed';
  if (testEvidence?.includes('结果：通过')) return 'passed';
  return undefined;
}

function parseModernCodeProTasks(text: string): TaskCardData[] {
  return Array.from(
    text.matchAll(
      /^###\s+([^\s·]+)\s+·\s+(.+?)\r?\n([\s\S]*?)(?=^###\s+[^\s·]+\s+·|^<\/details>|$(?![\s\S]))/gm
    ),
    (match): TaskCardData => {
      const detail = match[3].trim();
      const statusText = detail.match(/^- 任务状态：(.+)$/m)?.[1]?.trim() ?? '';
      const role = detail.match(/^- 执行角色：(.+?) Agent$/m)?.[1]?.trim();
      const files: string[] = [];
      const lines = detail.split(/\r?\n/);
      let collectingFiles = false;

      for (const line of lines) {
        const filesHeader = line.match(/^- 涉及文件：\s*(.*)$/);
        if (filesHeader) {
          const inlineFile = filesHeader[1].trim();
          if (inlineFile && inlineFile !== '无') {
            files.push(inlineFile.replace(/^`|`$/g, ''));
          }
          collectingFiles = !inlineFile;
          continue;
        }
        if (!collectingFiles) continue;

        const fileItem = line.match(/^\s+-\s+`(.+?)`\s*$/);
        if (fileItem) {
          files.push(fileItem[1]);
          continue;
        }
        if (line.trim()) collectingFiles = false;
      }

      const changeReport = detail
        .match(/^Agent 执行说明：\s*\r?\n([\s\S]*?)(?=^项目路径：|^测试项目：|$(?![\s\S]))/m)?.[1]
        ?.trim();
      const testEvidence = detail
        .match(/^命令与结果：\s*\r?\n([\s\S]*?)(?=^项目路径：|^测试项目：|$(?![\s\S]))/m)?.[1]
        ?.trim();
      const verificationOutcome = verificationOutcomeFromEvidence(testEvidence);

      return {
        id: match[1].trim(),
        name: match[2].trim(),
        status: parseModernCodeProTaskStatus(statusText),
        ...(role ? { role } : {}),
        filesChanged: files,
        ...(changeReport ? { changeReport } : {}),
        ...(testEvidence ? { testEvidence } : {}),
        ...(verificationOutcome ? { verificationOutcome } : {}),
      };
    }
  );
}

export function parseCodeProRunReport(text: string): CodeProRunReport | undefined {
  const legacyReport = text.includes('📋 任务执行报告：');
  const modernReport =
    /^(?:# CodePro (?:检查|执行|修复)结果[：:].*|# CodePro (?:分析|测试|修复)报告)\s*$/m.test(text);
  if (!legacyReport && !modernReport) return undefined;

  const isolatedWorkspacePath = text.match(/^🔒 修改保存在隔离工作区：(.+)$/m)?.[1]?.trim();
  const directProjectPath = text.match(/^📂 修改已直接写入当前项目：(.+)$/m)?.[1]?.trim();
  const testProjectPath = text.match(/^📂 测试项目：(.+)$/m)?.[1]?.trim();
  const modernProjectPath = text.match(/^项目路径：`?(.+?)`?\s*$/m)?.[1]?.trim();
  const modernTestProjectPath = text.match(/^测试项目：`?(.+?)`?\s*$/m)?.[1]?.trim();
  const workspacePath =
    directProjectPath ??
    testProjectPath ??
    isolatedWorkspacePath ??
    modernProjectPath ??
    modernTestProjectPath;
  const parsedTasks = parseCodeProTasks(text);
  const tasks =
    parsedTasks.length > 0
      ? parsedTasks.map((task) => {
          const escapedId = task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const detail = text.match(
            new RegExp(
              `^🔎 ${escapedId} 详情\\r?\\n([\\s\\S]*?)(?=^🔎 |^[✅❌] 独立审查|^⏭️ 存在失败|^[🔒📂] |$(?![\\s\\S]))`,
              'm'
            )
          )?.[1];
          if (!detail) return task;

          const filesText = detail.match(/^📁 修改文件：(.+)$/m)?.[1]?.trim();
          const testEvidence = detail
            .match(/^🧪 测试证据：([\s\S]*?)(?=^📝 执行报告：|$(?![\s\S]))/m)?.[1]
            ?.trim();
          const verificationOutcome = verificationOutcomeFromEvidence(testEvidence);
          const role = detail.match(/^👤 执行角色：(.+?) Agent$/m)?.[1]?.trim();
          const description = detail.match(/^🎯 任务目标：(.+)$/m)?.[1]?.trim();
          const acceptanceCriteria = detail.match(/^✅ 完成标准：(.+)$/m)?.[1]?.trim();
          return {
            ...task,
            ...(role ? { role } : {}),
            ...(description ? { description } : {}),
            ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
            changeReport: detail
              .match(/^📝 执行报告：([\s\S]*?)(?=^🧮 |^💰 |$(?![\s\S]))/m)?.[1]
              ?.trim(),
            filesChanged: filesText && filesText !== '无' ? filesText.split('、') : [],
            testEvidence,
            ...(verificationOutcome ? { verificationOutcome } : {}),
          };
        })
      : parseModernCodeProTasks(text);

  const usageMatch = text.match(/^🧮 Token：输入 (\d+)，输出 (\d+)，总计 (\d+)$/m);
  const costMatch = text.match(/^💰 已知费用：\$(\d+(?:\.\d+)?)$/m);
  return {
    changesApplied: directProjectPath !== undefined || text.includes('📂 修改已直接写入当前项目'),
    reviewApproved: text.includes('✅ 独立审查通过：'),
    tasks,
    ...(testProjectPath ? { testOnly: true } : {}),
    ...(usageMatch
      ? {
          usage: {
            inputTokens: Number(usageMatch[1]),
            outputTokens: Number(usageMatch[2]),
            totalTokens: Number(usageMatch[3]),
            ...(costMatch ? { costUsd: Number(costMatch[1]) } : {}),
          },
        }
      : {}),
    ...(workspacePath ? { workspacePath } : {}),
  };
}

function messageText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function terminalVerificationEvidence(
  verdict: 'passed' | 'skipped' | 'failed' | 'unverified' | 'unavailable',
  command: string | null,
  exitCode: number | null
): string {
  const result =
    verdict === 'passed'
      ? '结果：通过'
      : verdict === 'failed'
        ? '结果：测试失败'
        : verdict === 'unavailable'
          ? '结果：所需环境暂不可用'
          : verdict === 'unverified'
            ? '结果：尚未完成验证'
            : '结果：动态验证没有运行';
  return [result, `命令：${command ?? '（未执行）'}`, `退出码：${exitCode ?? '未运行'}`].join('\n');
}

function runReportFromTerminal(data: unknown): CodeProRunReport | undefined {
  const terminal = parseTurnTerminalRecord(data);
  const report = terminal?.report;
  if (!report) return undefined;

  const tasks = report.verification_summary.map((verification, index) => ({
    id: verification.task_id,
    name: verification.task_id,
    status:
      verification.verdict === 'passed'
        ? ('passed' as const)
        : verification.verdict === 'failed'
          ? ('failed' as const)
          : ('skipped' as const),
    testEvidence: terminalVerificationEvidence(
      verification.verdict,
      verification.command,
      verification.exit_code
    ),
    ...(verification.verdict === 'passed'
      ? { verificationOutcome: 'passed' as const }
      : verification.verdict === 'failed'
        ? { verificationOutcome: 'failed' as const }
        : verification.verdict === 'unavailable'
          ? { verificationOutcome: 'environment_unavailable' as const }
          : {}),
    ...(index === 0 && report.changed_files.length > 0
      ? { filesChanged: report.changed_files }
      : {}),
  }));

  return {
    changesApplied: report.changed_files.length > 0,
    reviewApproved: false,
    tasks,
  };
}

function mergeTerminalRunReport(
  naturalReport: CodeProRunReport | undefined,
  terminalReport: CodeProRunReport
): CodeProRunReport {
  if (!naturalReport) return terminalReport;
  const terminalTasks = new Map(terminalReport.tasks.map((task) => [task.id, task]));
  const mergedTasks = naturalReport.tasks.map((task) => {
    const terminalTask = terminalTasks.get(task.id);
    if (!terminalTask) return task;
    terminalTasks.delete(task.id);
    return { ...task, ...terminalTask, name: task.name, role: task.role ?? terminalTask.role };
  });
  mergedTasks.push(...terminalTasks.values());
  return {
    ...naturalReport,
    changesApplied: naturalReport.changesApplied || terminalReport.changesApplied,
    tasks: mergedTasks,
  };
}

export function selectCurrentTurnCodeProRunReport(
  messages: CodeProTaskPanelMessage[]
): CodeProRunReport | undefined {
  let currentTurnStart = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') currentTurnStart = index + 1;
  });

  let latestReport: CodeProRunReport | undefined;
  let latestTerminalReport: CodeProRunReport | undefined;
  for (const message of messages.slice(currentTurnStart)) {
    if (message.role !== 'assistant') continue;
    const report = parseCodeProRunReport(messageText(message.content));
    if (report) latestReport = report;
    for (const content of message.content) {
      if (content.type !== 'systemNotification' || content.notificationType !== 'turnTerminal') {
        continue;
      }
      const terminalReport = runReportFromTerminal(content.data);
      if (terminalReport) latestTerminalReport = terminalReport;
    }
  }
  return latestTerminalReport
    ? mergeTerminalRunReport(latestReport, latestTerminalReport)
    : latestReport;
}

export function collectCodeProTaskFiles(
  messages: CodeProTaskPanelMessage[]
): CodeProTaskFileEvidence[] {
  let currentTurnStart = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') currentTurnStart = index + 1;
  });

  const lifecycleEvents = new Map<string, ActivityEvent>();
  for (const message of messages.slice(currentTurnStart)) {
    for (const content of message.content) {
      if (content.type !== 'systemNotification' || content.notificationType !== 'codeProActivity') {
        continue;
      }
      const event = parseActivityEvent(content.data);
      if (!event) continue;
      const key = `${event.run_id}\0${event.event_id}`;
      const previous = lifecycleEvents.get(key);
      lifecycleEvents.set(
        key,
        previous
          ? {
              ...previous,
              ...event,
              path: event.path ?? previous.path,
              task_id: event.task_id ?? previous.task_id,
            }
          : event
      );
    }
  }

  const files = new Map<string, CodeProTaskFileEvidence>();
  for (const event of lifecycleEvents.values()) {
    if (!event.path || (event.event_type !== 'file_read' && event.event_type !== 'file_changed')) {
      continue;
    }
    const kind = event.event_type === 'file_read' ? 'read' : 'changed';
    const key = `${kind}\0${event.path}`;
    if (!files.has(key)) {
      files.set(key, {
        eventId: event.event_id,
        kind,
        path: event.path,
        taskId: event.task_id,
      });
    }
  }
  return Array.from(files.values());
}

export function focusCodeProTaskActivity(
  taskId: string,
  root: { querySelectorAll(selector: string): ArrayLike<HTMLElement> } = document,
  sessionId?: string
): boolean {
  const sessionRoot = sessionId
    ? Array.from(root.querySelectorAll('[data-session-id]')).find(
        (element) => element.dataset.sessionId === sessionId
      )
    : root;
  if (!sessionRoot) return false;

  const activities = Array.from(
    sessionRoot.querySelectorAll('[data-codepro-task-id]')
  ) as HTMLElement[];
  const activity = activities.find((element) => element.dataset.codeproTaskId === taskId);
  if (!activity) return false;

  activity.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  activity.querySelector<HTMLElement>('button')?.focus();
  return true;
}

export function hasCodeProTaskPanelContent(
  snapshot: CodeProTaskPanelSnapshot | undefined
): boolean {
  if (!snapshot) return false;
  if (parseCodeProTasks(snapshot.progressMessage ?? '').length > 0) return true;
  return selectCurrentTurnCodeProRunReport(snapshot.messages) !== undefined;
}

export function summarizeCodeProTasks(tasks: TaskCardData[]): CodeProTaskSummary {
  const currentTask =
    tasks.find((task) => task.status === 'running') ??
    tasks.find((task) => task.status === 'queued');
  const completedCount = tasks.filter((task) => task.status === 'passed').length;
  let status: CodeProTaskSummary['status'] = 'completed';
  let statusLabel = '已完成';

  if (tasks.length === 0) {
    status = 'idle';
    statusLabel = '等待任务';
  } else if (tasks.some((task) => task.status === 'running')) {
    status = 'running';
    statusLabel = '运行中';
  } else if (tasks.some((task) => task.status === 'failed')) {
    status = 'failed';
    statusLabel = '存在失败';
  } else if (tasks.some((task) => task.status === 'paused')) {
    status = 'paused';
    statusLabel = '需要你确认';
  } else if (tasks.some((task) => task.status === 'cancelled')) {
    status = 'cancelled';
    statusLabel = '已停止';
  } else if (tasks.some((task) => task.status === 'queued')) {
    status = 'queued';
    statusLabel = '等待执行';
  }

  return { completedCount, currentTask, status, statusLabel, totalCount: tasks.length };
}

export function summarizeTaskDetail(task: TaskCardData): string {
  const source = task.testEvidence ?? task.changeReport;
  const firstLine = source
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return taskOutcomeLabel(task);
  return Array.from(firstLine).slice(0, 160).join('');
}
