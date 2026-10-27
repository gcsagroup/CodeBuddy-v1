import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IntlShape, MessageDescriptor } from 'react-intl';
import { TechnicalValue } from '../TechnicalValue';
import { Check, ChevronRight, ListTree, LoaderCircle, OctagonX } from 'lucide-react';
import type { SystemNotificationContent } from '../../types/message';
import ThinkingContent from '../ThinkingContent';
import { parseActivityEvent, type ActivityEvent } from '../../types/activityEvent';
import { cn } from '../../utils';
import { ToolCallExpandable } from '../ToolCallExpandable';
import type { ToolCallStatus } from '../ToolCallStatusIndicator';
import { ToolActivityIcon } from '../ToolActivityIcon';
import { defineMessages, useIntl } from '../../i18n';
import {
  buildCodeProActivityRenderItems,
  formatCodeProUserFacingText,
  type CodeProActivityRenderItem,
  type CodeProActivityViewModel,
} from './codeProActivityModel';
import {
  formatCodeProActivityState,
  formatCodeProActivitySummary,
  formatCodeProFailureKind,
} from './codeProPresentation';
import { acpCancelPrompt } from '../../acp/prompt';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

const i18n = defineMessages({
  agentTool: { id: 'codeProActivity.agentTool', defaultMessage: 'Agent tool' },
  commandExecution: { id: 'codeProActivity.commandExecution', defaultMessage: 'Command execution' },
  fileRead: { id: 'codeProActivity.fileRead', defaultMessage: 'File read' },
  fileChange: { id: 'codeProActivity.fileChange', defaultMessage: 'File change' },
  readActions: { id: 'codeProActivity.readActions', defaultMessage: 'Read actions' },
  editActions: { id: 'codeProActivity.editActions', defaultMessage: 'Edit actions' },
  testRun: { id: 'codeProActivity.testRun', defaultMessage: 'Test run' },
  independentReview: {
    id: 'codeProActivity.independentReview',
    defaultMessage: 'Independent review',
  },
  executionStrategy: {
    id: 'codeProActivity.executionStrategy',
    defaultMessage: 'Execution strategy',
  },
  taskPlanning: { id: 'codeProActivity.taskPlanning', defaultMessage: 'Task planning' },
  tool: { id: 'codeProActivity.tool', defaultMessage: 'Tool' },
  path: { id: 'codeProActivity.path', defaultMessage: 'Path' },
  directory: { id: 'codeProActivity.directory', defaultMessage: 'Directory' },
  command: { id: 'codeProActivity.command', defaultMessage: 'Command' },
  parameters: { id: 'codeProActivity.parameters', defaultMessage: 'Parameters' },
  duration: { id: 'codeProActivity.duration', defaultMessage: 'Duration' },
  exitCode: { id: 'codeProActivity.exitCode', defaultMessage: 'Exit code' },
  output: { id: 'codeProActivity.output', defaultMessage: 'Output' },
  changes: { id: 'codeProActivity.changes', defaultMessage: 'Changes' },
  effectiveModel: { id: 'codeProActivity.effectiveModel', defaultMessage: 'Effective model' },
  failureReason: { id: 'toolAudit.failure', defaultMessage: 'Failure reason' },
  details: { id: 'codeProActivity.details', defaultMessage: 'Details' },
  description: { id: 'codeProActivity.description', defaultMessage: 'Description' },
  acceptance: { id: 'codeProActivity.acceptance', defaultMessage: 'Acceptance target' },
  purpose: { id: 'codeProActivity.purpose', defaultMessage: 'Purpose' },
  status: { id: 'codeProActivity.status', defaultMessage: 'Status' },
  file: { id: 'codeProActivity.file', defaultMessage: 'File' },
  currentTask: { id: 'codeProActivity.currentTask', defaultMessage: 'Current task' },
  activityAccessible: {
    id: 'codeProActivity.activityAccessible',
    defaultMessage: 'Activity: {summary}',
  },
  readGroup: {
    id: 'codeProActivity.readGroup',
    defaultMessage: 'Read {count, plural, one {# file} other {# files}} {status}',
  },
  partialFailure: { id: 'codeProActivity.partialFailure', defaultMessage: 'Partially failed' },
  executionLog: { id: 'codeProActivity.executionLog', defaultMessage: 'Execution log' },
  executionLogAccessible: {
    id: 'codeProActivity.executionLogAccessible',
    defaultMessage: 'Execution log: {headline}',
  },
  actionCount: {
    id: 'codeProActivity.actionCount',
    defaultMessage: '{count, plural, one {# action} other {# actions}}',
  },
  activityRunning: {
    id: 'codeProActivity.activityRunning',
    defaultMessage: 'Working {count, plural, one {# action} other {# actions}}',
  },
  activityFinished: {
    id: 'codeProActivity.activityFinished',
    defaultMessage: 'Operations recorded {count, plural, one {# action} other {# actions}}',
  },
  activityFailures: {
    id: 'codeProActivity.activityFailures',
    defaultMessage: '{count, plural, one {# failed action} other {# failed actions}}',
  },
  activityNeedsAttention: {
    id: 'codeProActivity.activityNeedsAttention',
    defaultMessage:
      '{count, plural, one {# action needs attention} other {# actions need attention}}',
  },
  editOperations: {
    id: 'codeProActivity.editOperations',
    defaultMessage: 'Edit operations completed',
  },
  editEvidence: {
    id: 'codeProActivity.editEvidence',
    defaultMessage: 'Tool receipts, not a verified diff',
  },
  viewEditReceipt: {
    id: 'codeProActivity.viewEditReceipt',
    defaultMessage: 'View operation receipt for {file}',
  },
  processingTask: { id: 'codeProActivity.processingTask', defaultMessage: 'Processing task' },
  executionLevel: { id: 'codeProActivity.executionLevel', defaultMessage: 'Execution level' },
  flow: { id: 'codeProActivity.flow', defaultMessage: 'Flow' },
  review: { id: 'codeProActivity.review', defaultMessage: 'Review' },
  riskReason: { id: 'codeProActivity.riskReason', defaultMessage: 'Risk reason' },
  riskL0: { id: 'codeProActivity.risk.l0', defaultMessage: 'L0 Read-only' },
  riskL1: { id: 'codeProActivity.risk.l1', defaultMessage: 'L1 Reversible change' },
  riskL2: { id: 'codeProActivity.risk.l2', defaultMessage: 'L2 Feature' },
  riskL3: { id: 'codeProActivity.risk.l3', defaultMessage: 'L3 High risk/release' },
  needsInspection: { id: 'codeProActivity.needsInspection', defaultMessage: 'Needs inspection' },
  flowAnalysis: { id: 'codeProActivity.flow.analysis', defaultMessage: 'Analyze' },
  flowSimple: {
    id: 'codeProActivity.flow.simpleChange',
    defaultMessage: 'Analyze → Change → Automatic verification',
  },
  flowTest: { id: 'codeProActivity.flow.independentTest', defaultMessage: 'Independent test' },
  flowProjectTest: {
    id: 'codeProActivity.flow.projectTest',
    defaultMessage: 'Scope planning → Independent test',
  },
  flowReviewedTest: {
    id: 'codeProActivity.flow.reviewedTest',
    defaultMessage: 'Scope planning → Independent test → Independent review',
  },
  flowFeature: {
    id: 'codeProActivity.flow.feature',
    defaultMessage: 'Analyze → Code → Independent test',
  },
  flowHighRisk: {
    id: 'codeProActivity.flow.highRisk',
    defaultMessage: 'Analyze → Code → Independent test → Independent review',
  },
  reviewRequired: {
    id: 'codeProActivity.review.required',
    defaultMessage: 'Independent review required',
  },
  reviewNotRequired: {
    id: 'codeProActivity.review.notRequired',
    defaultMessage: 'Not required at this level',
  },
  reasonReadOnly: { id: 'codeProActivity.reason.readOnly', defaultMessage: 'Read-only operation' },
  reasonFocusedTest: {
    id: 'codeProActivity.reason.focusedTest',
    defaultMessage: 'Focused local validation',
  },
  reasonSingleFile: {
    id: 'codeProActivity.reason.singleFile',
    defaultMessage: 'Single workspace file',
  },
  reasonMultiFile: {
    id: 'codeProActivity.reason.multiFile',
    defaultMessage: 'Multiple files or unknown write scope',
  },
  reasonPermission: {
    id: 'codeProActivity.reason.permission',
    defaultMessage: 'Permission boundary',
  },
  reasonCredential: {
    id: 'codeProActivity.reason.credential',
    defaultMessage: 'Credential material',
  },
  reasonDestructive: {
    id: 'codeProActivity.reason.destructive',
    defaultMessage: 'Destructive change',
  },
  reasonOutside: {
    id: 'codeProActivity.reason.outsideWorkspace',
    defaultMessage: 'Outside workspace',
  },
  reasonRemote: {
    id: 'codeProActivity.reason.remoteSideEffect',
    defaultMessage: 'Remote side effect',
  },
  reasonRelease: {
    id: 'codeProActivity.reason.release',
    defaultMessage: 'Install, update, or release',
  },
  reasonStrictReview: {
    id: 'codeProActivity.reason.strictReview',
    defaultMessage: 'User requested stricter review',
  },
  testProgressStage: {
    id: 'codeProActivity.testProgress.stage',
    defaultMessage: 'Stage',
  },
  testProgressCurrentCrate: {
    id: 'codeProActivity.testProgress.currentCrate',
    defaultMessage: 'Current crate',
  },
  testProgressCurrentTest: {
    id: 'codeProActivity.testProgress.currentTest',
    defaultMessage: 'Current test',
  },
  testProgressProgress: {
    id: 'codeProActivity.testProgress.progress',
    defaultMessage: 'Progress',
  },
  testProgressPid: {
    id: 'codeProActivity.testProgress.pid',
    defaultMessage: 'Process PID',
  },
  testProgressHeartbeat: {
    id: 'codeProActivity.testProgress.heartbeat',
    defaultMessage: 'Last heartbeat',
  },
  testProgressLastOutput: {
    id: 'codeProActivity.testProgress.lastOutput',
    defaultMessage: 'Last output',
  },
  testProgressProcessStatus: {
    id: 'codeProActivity.testProgress.processStatus',
    defaultMessage: 'Process status',
  },
  testProgressAwaitingCompilerOutput: {
    id: 'codeProActivity.testProgress.awaitingCompilerOutput',
    defaultMessage: 'Process is active; waiting for new compiler output',
  },
  testProgressRequiredPath: {
    id: 'codeProActivity.testProgress.requiredPath',
    defaultMessage: 'Required path',
  },
  testProgressRequiredPermission: {
    id: 'codeProActivity.testProgress.requiredPermission',
    defaultMessage: 'Required permission',
  },
  testProgressAttempts: {
    id: 'codeProActivity.testProgress.attempts',
    defaultMessage: 'Attempts',
  },
  testProgressAttemptCounts: {
    id: 'codeProActivity.testProgress.attemptCounts',
    defaultMessage: 'Retry {retry}, repair {repair}',
  },
  testProgressCancelling: {
    id: 'codeProActivity.testProgress.cancelling',
    defaultMessage: 'Cancelling…',
  },
  testProgressCancel: {
    id: 'codeProActivity.testProgress.cancel',
    defaultMessage: 'Cancel test',
  },
});

interface CodeProActivityProps {
  notification: SystemNotificationContent;
  active?: boolean;
}

const taskSnapshotMarker = '--- CodePro 任务快照 ---';

export function parseCodeProActivity(
  message: string,
  fallbackHeadline = 'CodePro'
): {
  headline: string;
  details: string[];
} {
  const [activityText] = message.split(taskSnapshotMarker, 1);
  const [first = 'CodePro', ...rest] = activityText.split(/\r?\n/);
  return {
    headline:
      userFacingActivityText(first.replace(/^CodePro\s*[·\-:]?\s*/, '').trim()) || fallbackHeadline,
    details: rest
      .map((line) => userFacingActivityText(line.trim()))
      .filter(
        (line) => line && !line.startsWith('活动ID：') && !/^(✅|❌|🛑|⏭️|⏳)\s+\S+:\s+/.test(line)
      ),
  };
}

function userFacingActivityText(value: string): string {
  const withoutRoleSuffix = value.replace(
    /[（(]\s*(?:Planner|Coder|Tester|Reviewer)\s+Agent\s*[)）]/gi,
    ''
  );
  return formatCodeProUserFacingText(withoutRoleSuffix)
    .replace(/^(当前任务|Current task)[:：]\s*task-[^\s·:：]+\s*[·:：-]?\s*/i, '$1：')
    .trim();
}

function isCancelledActivity(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('cancelled') ||
    normalized.includes('canceled') ||
    normalized.includes('\u5df2\u53d6\u6d88') ||
    normalized.includes('\u5df2\u505c\u6b62')
  );
}

function activityPresentation(
  notification: SystemNotificationContent,
  intl: IntlShape
): {
  headline: string;
  details: string[];
} {
  const activityEvent = parseActivityEvent(notification.data);
  if (activityEvent) {
    return {
      headline: activityEvent.title,
      details: structuredActivityDetails(activityEvent, intl),
    };
  }
  return parseCodeProActivity(notification.msg, intl.formatMessage(i18n.processingTask));
}

function activityToolName(event: ActivityEvent, intl: IntlShape): string {
  if (event.command_summary?.startsWith('tool:')) {
    return event.command_summary.slice('tool:'.length) || intl.formatMessage(i18n.agentTool);
  }
  switch (event.event_type) {
    case 'command_started':
    case 'command_completed':
      return intl.formatMessage(i18n.commandExecution);
    case 'file_read':
      return intl.formatMessage(i18n.fileRead);
    case 'file_changed':
      return intl.formatMessage(i18n.fileChange);
    case 'test_started':
    case 'test_completed':
      return intl.formatMessage(i18n.testRun);
    case 'review_started':
    case 'review_completed':
      return intl.formatMessage(i18n.independentReview);
    case 'strategy_selected':
    case 'strategy_updated':
      return intl.formatMessage(i18n.executionStrategy);
    case 'plan_created':
    case 'plan_updated':
      return intl.formatMessage(i18n.taskPlanning);
    case 'tool_started':
    case 'tool_completed':
      return intl.formatMessage(i18n.agentTool);
    default:
      return 'CodePro';
  }
}

function isIntentActivity(event: Pick<ActivityEvent, 'event_id' | 'event_type'>): boolean {
  return (
    event.event_type === 'intent_started' ||
    event.event_type === 'intent_completed' ||
    event.event_id.startsWith('intent-classification-')
  );
}

function structuredActivityDetails(event: ActivityEvent, intl: IntlShape): string[] {
  const details = isIntentActivity(event)
    ? []
    : [`${intl.formatMessage(i18n.tool)}：${activityToolName(event, intl)}`];
  if (event.path) details.push(`${intl.formatMessage(i18n.path)}：${event.path}`);
  if (event.command_summary && !event.command_summary.startsWith('tool:')) {
    details.push(`${intl.formatMessage(i18n.command)}：${event.command_summary}`);
  }
  if (event.technical_details) {
    details.push(...event.technical_details.split(/\r?\n/).filter(Boolean));
  }
  if (event.exit_code !== null) {
    details.push(`${intl.formatMessage(i18n.exitCode)}：${event.exit_code}`);
  }
  if (event.diff_summary)
    details.push(`${intl.formatMessage(i18n.changes)}：${event.diff_summary}`);
  return details;
}

function activityOutcome(
  notification: SystemNotificationContent
): 'running' | 'success' | 'failure' | 'cancelled' {
  const activityEvent = parseActivityEvent(notification.data);
  if (activityEvent) {
    switch (activityEvent.status) {
      case 'pending':
      case 'running':
        return 'running';
      case 'failed':
        return 'failure';
      case 'cancelled':
      case 'stopped':
      case 'interrupted':
      case 'unknown':
        return 'cancelled';
      default:
        return 'success';
    }
  }

  if (isCancelledActivity(notification.msg)) {
    return 'cancelled';
  }
  const normalized = notification.msg.toLowerCase();
  if (
    normalized.includes('状态：失败') ||
    normalized.includes('status: failed') ||
    normalized.includes('执行失败') ||
    normalized.includes('检查失败')
  ) {
    return 'failure';
  }
  if (
    normalized.includes('状态：成功') ||
    normalized.includes('status: success') ||
    normalized.includes('命令执行完成') ||
    normalized.includes('已读取文件') ||
    normalized.includes('已查看项目结构') ||
    normalized.includes('已完成分析动作') ||
    normalized.includes('任务规划完成')
  ) {
    return 'success';
  }
  return 'running';
}

function activityDetail(
  line: string,
  intl: IntlShape
): { label: string; value: string; technical: boolean } {
  const separator = line.indexOf('：');
  const rawLabel = separator >= 0 ? line.slice(0, separator) : '详情';
  const knownLabels: Record<string, { message: MessageDescriptor; technical?: boolean }> = {
    工具: { message: i18n.tool },
    Tool: { message: i18n.tool },
    路径: { message: i18n.path, technical: true },
    Path: { message: i18n.path, technical: true },
    目录: { message: i18n.directory, technical: true },
    Directory: { message: i18n.directory, technical: true },
    命令: { message: i18n.command, technical: true },
    Command: { message: i18n.command, technical: true },
    参数: { message: i18n.parameters, technical: true },
    Parameters: { message: i18n.parameters, technical: true },
    文件: { message: i18n.file, technical: true },
    File: { message: i18n.file, technical: true },
    输出: { message: i18n.output, technical: true },
    Output: { message: i18n.output, technical: true },
    变更: { message: i18n.changes, technical: true },
    Changes: { message: i18n.changes, technical: true },
    说明: { message: i18n.description },
    功能: { message: i18n.purpose },
    验收目标: { message: i18n.acceptance },
    当前任务: { message: i18n.currentTask },
    状态: { message: i18n.status },
    详情: { message: i18n.details },
  };
  const known = knownLabels[rawLabel];
  return {
    label: known ? intl.formatMessage(known.message) : rawLabel,
    value: separator >= 0 ? line.slice(separator + 1) : line,
    technical: known?.technical ?? false,
  };
}

function ActivityStatusIcon({
  notification,
  active,
}: {
  notification: SystemNotificationContent;
  active: boolean;
}) {
  const outcome = activityOutcome(notification);
  const running = active && outcome === 'running';

  return running ? (
    <LoaderCircle className="h-4 w-4 animate-spin text-blue-500" />
  ) : outcome === 'failure' ? (
    <OctagonX className="h-4 w-4 text-red-600" />
  ) : outcome === 'cancelled' ? (
    <OctagonX className="h-4 w-4 text-amber-600" />
  ) : (
    <Check className="h-4 w-4 text-green-600" />
  );
}

export function CodeProActivity({ notification, active = false }: CodeProActivityProps) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const structuredItem = buildCodeProActivityRenderItems([notification])[0];
  if (structuredItem?.kind === 'activity' && structuredItem.activity.structured) {
    return <CodeProActivityCard activity={structuredItem.activity} active={active} />;
  }

  const { headline, details } = activityPresentation(notification, intl);
  const statusIcon = <ActivityStatusIcon notification={notification} active={active} />;

  if (details.length === 0) {
    return (
      <section
        className="my-1.5 flex w-full items-center gap-2 py-1 text-sm text-text-secondary"
        aria-label={`CodePro ${headline}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
          {statusIcon}
        </span>
        <span className="italic">{headline}</span>
      </section>
    );
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <section
        className="my-2 w-full overflow-hidden rounded-md border border-border-primary bg-background-primary"
        aria-label={`CodePro ${headline}`}
      >
        <CollapsibleTrigger
          type="button"
          className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
          aria-expanded={expanded}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
            {statusIcon}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
            {headline}
          </span>
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-text-secondary transition-transform group-hover:text-text-primary',
              expanded && 'rotate-90'
            )}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="codepro-disclosure-content">
          <div className="border-t border-border-primary bg-background-secondary px-3 py-2.5">
            <dl className="space-y-2">
              {details.map((line, index) => {
                const detail = activityDetail(line, intl);
                if (detail.technical) {
                  return (
                    <div key={`${index}-${line}`}>
                      <TechnicalValue value={detail.value} label={detail.label} />
                    </div>
                  );
                }
                return (
                  <div
                    key={`${index}-${line}`}
                    className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2"
                  >
                    <dt className="text-xs font-medium text-text-secondary">{detail.label}</dt>
                    <dd className="min-w-0 break-words text-xs leading-5 text-text-primary">
                      {detail.value}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function codeProToolStatus(activity: CodeProActivityViewModel, active: boolean): ToolCallStatus {
  if (activity.state === 'failed') return 'error';
  if (activity.state === 'unknown' || activity.state === 'interrupted') return 'warning';
  if (activity.state === 'completed') return 'success';
  if ((activity.state === 'running' || activity.state === 'pending') && active) return 'loading';
  return 'pending';
}

function activityToolLabel(activity: CodeProActivityViewModel, intl: IntlShape): string {
  switch (activity.eventType) {
    case 'file_read':
      return intl.formatMessage(i18n.fileRead);
    case 'file_changed':
      return intl.formatMessage(i18n.fileChange);
    case 'command_started':
    case 'command_completed':
      return intl.formatMessage(i18n.commandExecution);
    case 'test_started':
    case 'test_completed':
      return intl.formatMessage(i18n.testRun);
    case 'review_started':
    case 'review_completed':
      return intl.formatMessage(i18n.independentReview);
    case 'strategy_selected':
    case 'strategy_updated':
      return intl.formatMessage(i18n.executionStrategy);
    case 'plan_created':
    case 'plan_updated':
      return intl.formatMessage(i18n.taskPlanning);
    default:
      return activity.toolName;
  }
}

function StructuredActivityDetails({ activity }: { activity: CodeProActivityViewModel }) {
  const intl = useIntl();
  const [cancelling, setCancelling] = useState(false);
  const progress = activity.testProgress;
  const intentActivity =
    activity.eventType === 'intent_started' ||
    activity.eventType === 'intent_completed' ||
    activity.eventId?.startsWith('intent-classification-');
  const details: Array<{ label: string; value: string; technical?: boolean }> = intentActivity
    ? []
    : [{ label: intl.formatMessage(i18n.tool), value: activityToolLabel(activity, intl) }];
  if (activity.path) {
    details.push({ label: intl.formatMessage(i18n.path), value: activity.path, technical: true });
  }
  if (activity.command) {
    details.push({
      label: intl.formatMessage(i18n.command),
      value: activity.command,
      technical: true,
    });
  }
  for (const parameter of activity.parameters) {
    details.push({ label: intl.formatMessage(i18n.parameters), value: parameter, technical: true });
  }
  if (activity.duration) {
    details.push({ label: intl.formatMessage(i18n.duration), value: activity.duration });
  }
  if (activity.exitCode !== null) {
    details.push({
      label: intl.formatMessage(i18n.exitCode),
      value: String(activity.exitCode),
      technical: true,
    });
  }
  if (activity.output) {
    details.push({
      label: intl.formatMessage(intentActivity ? i18n.description : i18n.output),
      value: activity.output,
      technical: !intentActivity,
    });
  }
  if (activity.diffSummary) {
    details.push({
      label: intl.formatMessage(i18n.changes),
      value: activity.diffSummary,
      technical: true,
    });
  }
  if (activity.effectiveModel) {
    details.push({
      label: intl.formatMessage(i18n.effectiveModel),
      value: activity.effectiveModel,
      technical: true,
    });
  }
  if (activity.failureKind) {
    details.push({
      label: intl.formatMessage(i18n.failureReason),
      value: formatCodeProFailureKind(intl, activity.failureKind),
    });
  }
  if (progress) {
    details.unshift({ label: intl.formatMessage(i18n.currentTask), value: activity.title });
    if (progress.currentCrate) {
      details.push({
        label: intl.formatMessage(i18n.testProgressCurrentCrate),
        value: progress.currentCrate,
        technical: true,
      });
    }
    if (progress.currentTest) {
      details.push({
        label: intl.formatMessage(i18n.testProgressCurrentTest),
        value: progress.currentTest,
        technical: true,
      });
    }
    if (progress.total !== undefined) {
      details.push({
        label: intl.formatMessage(i18n.testProgressProgress),
        value: `${progress.completed ?? 0}/${progress.total}`,
      });
    }
    if (progress.lastOutputAt) {
      details.push({
        label: intl.formatMessage(i18n.testProgressLastOutput),
        value: progress.lastOutputAt,
        technical: true,
      });
    } else if (progress.phase === 'compiling') {
      details.push({
        label: intl.formatMessage(i18n.testProgressProcessStatus),
        value: intl.formatMessage(i18n.testProgressAwaitingCompilerOutput),
      });
    }
    if (progress.requiredPath) {
      details.push({
        label: intl.formatMessage(i18n.testProgressRequiredPath),
        value: progress.requiredPath,
        technical: true,
      });
    }
    if (progress.requiredPermission) {
      details.push({
        label: intl.formatMessage(i18n.testProgressRequiredPermission),
        value: progress.requiredPermission,
      });
    }
  }

  return (
    <div className="border-t border-border-primary bg-background-secondary px-3 py-2.5">
      <dl className="space-y-2">
        {details.map((detail, index) =>
          detail.technical ? (
            <div key={`${detail.label}-${index}`}>
              <TechnicalValue value={detail.value} label={detail.label} />
            </div>
          ) : (
            <div
              key={`${detail.label}-${index}`}
              className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2"
            >
              <dt className="text-xs font-medium text-text-secondary">{detail.label}</dt>
              <dd className="min-w-0 break-words text-xs leading-5 text-text-primary">
                {detail.value}
              </dd>
            </div>
          )
        )}
      </dl>
      {progress?.canCancel && (
        <button
          type="button"
          className="mt-3 rounded border border-border-primary px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-background-primary disabled:opacity-50"
          disabled={cancelling}
          onClick={async (event) => {
            event.stopPropagation();
            setCancelling(true);
            try {
              await acpCancelPrompt(progress.sessionId);
            } finally {
              setCancelling(false);
            }
          }}
        >
          {intl.formatMessage(cancelling ? i18n.testProgressCancelling : i18n.testProgressCancel)}
        </button>
      )}
    </div>
  );
}

export function CodeProActivityCard({
  activity,
  active = false,
  compact = false,
}: {
  activity: CodeProActivityViewModel;
  active?: boolean;
  compact?: boolean;
}) {
  const intl = useIntl();
  const status = codeProToolStatus(activity, active);
  const summary = formatCodeProActivitySummary(intl, activity);
  const thinkingActivity =
    activity.eventType === 'intent_started' ||
    activity.eventType === 'intent_completed' ||
    activity.eventId?.startsWith('intent-classification-') ||
    activity.eventId?.startsWith('thinking-');
  if (thinkingActivity) {
    const content =
      activity.output ??
      (activity.parameters.length > 0 ? activity.parameters.join('\n') : activity.title);
    return (
      <div data-codepro-task-id={activity.taskId ?? undefined} className="my-1.5">
        <ThinkingContent
          content={content}
          isExpanded={
            activity.state === 'running' ||
            activity.state === 'failed' ||
            activity.state === 'interrupted'
          }
          isStreaming={active && activity.state === 'running'}
          storageKey={activity.eventId ? `activity-${activity.eventId}` : undefined}
        />
      </div>
    );
  }
  return (
    <div data-codepro-task-id={activity.taskId ?? undefined}>
      <ToolCallExpandable
        compact={compact}
        className={
          compact
            ? 'w-full'
            : 'my-1.5 w-full overflow-hidden rounded-md border border-border-primary bg-background-primary'
        }
        accessibleName={intl.formatMessage(i18n.activityAccessible, { summary })}
        label={
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1" title={activity.target}>
            <span aria-hidden="true">
              <ToolActivityIcon name={activity.toolName} status={status} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-text-primary">{summary}</span>
          </span>
        }
      >
        <StructuredActivityDetails activity={activity} />
      </ToolCallExpandable>
    </div>
  );
}

export function CodeProActivityTimeline({
  items,
  active = false,
}: {
  items: CodeProActivityRenderItem[];
  active?: boolean;
}) {
  const intl = useIntl();
  const activities = items.flatMap((item) =>
    item.kind === 'read-group' ? item.activities : [item.activity]
  );
  const needsAttention = activities.filter((activity) =>
    ['failed', 'cancelled', 'stopped', 'interrupted', 'unknown'].includes(activity.state)
  );
  const unfinished = activities.some(
    (activity) => activity.state === 'running' || activity.state === 'pending'
  );
  const [manualExpanded, setExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? (active || needsAttention.length > 0);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    // Read-only work uses this activity projection, not the generic tool scroller.
    // Follow new receipts only while the reader is still at its live tail.
    if (active && expanded && detailKey === null && following.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [items, active, expanded, detailKey]);

  useEffect(() => {
    if (needsAttention.length > 0) setExpanded(true);
  }, [needsAttention.length]);

  if (activities.length === 0) return null;

  if (activities.length === 1) {
    return <CodeProActivityCard activity={activities[0]} active={active} compact />;
  }
  const running = active && unfinished;
  const headline = intl.formatMessage(running ? i18n.activityRunning : i18n.activityFinished, {
    count: activities.length,
  });

  return (
    <div className="my-1 w-full">
      <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
        <section>
          <CollapsibleTrigger
            type="button"
            className="group flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1 text-left text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
            aria-expanded={expanded}
            aria-label={headline}
          >
            <span className="flex w-[18px] shrink-0 items-center" aria-hidden="true">
              {running ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ListTree className="h-4 w-4" />
              )}
            </span>
            <span className="min-w-0 truncate">{headline}</span>
            <ChevronRight
              className={cn('h-4 w-4 shrink-0 transition-transform', expanded && 'rotate-90')}
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="codepro-disclosure-content">
            <div
              role="region"
              aria-label={intl.formatMessage(i18n.executionLog)}
              tabIndex={0}
              ref={viewport}
              onScroll={(event) => {
                const element = event.currentTarget;
                following.current =
                  element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
              }}
              className="mt-1 max-h-64 space-y-0.5 overflow-y-auto overscroll-contain pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
            >
              {activities.map((activity, index) => {
                const summary = formatCodeProActivitySummary(intl, activity);
                const detailsOpen = detailKey === activity.key;
                return (
                  <Collapsible
                    key={activity.key}
                    open={detailsOpen}
                    onOpenChange={(open) => {
                      if (open) following.current = false;
                      setDetailKey(open ? activity.key : null);
                    }}
                    data-codepro-task-id={activity.taskId ?? undefined}
                  >
                    <CollapsibleTrigger
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1 text-left text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
                      aria-expanded={detailsOpen}
                      aria-label={intl.formatMessage(i18n.activityAccessible, { summary })}
                      title={activity.target}
                    >
                      <span className="flex w-[18px] shrink-0 items-center" aria-hidden="true">
                        <ToolActivityIcon
                          name={activity.toolName}
                          status={codeProToolStatus(
                            activity,
                            active && index === activities.length - 1
                          )}
                        />
                      </span>
                      <span className="min-w-0 truncate">{summary}</span>
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 transition-transform',
                          detailsOpen && 'rotate-90'
                        )}
                        aria-hidden="true"
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="codepro-disclosure-content">
                      <StructuredActivityDetails activity={activity} />
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>
    </div>
  );
}

export function CodeProReadGroup({
  activities,
  active = false,
}: {
  activities: CodeProActivityViewModel[];
  active?: boolean;
}) {
  const intl = useIntl();
  if (activities.length === 0) return null;
  const failed = activities.some((activity) => activity.state === 'failed');
  const running = activities.some(
    (activity) => activity.state === 'running' || activity.state === 'pending'
  );
  const label = failed
    ? intl.formatMessage(i18n.partialFailure)
    : formatCodeProActivityState(intl, running ? 'running' : 'completed');
  const summary = intl.formatMessage(i18n.readGroup, { count: activities.length, status: label });
  const status: ToolCallStatus = failed
    ? 'error'
    : running && active
      ? 'loading'
      : running
        ? 'pending'
        : 'success';

  return (
    <div data-codepro-task-id={activities[0].taskId ?? undefined}>
      <ToolCallExpandable
        className="my-1.5 w-full overflow-hidden rounded-md border border-border-primary bg-background-primary"
        accessibleName={summary}
        label={
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
            <span aria-hidden="true">
              <ToolActivityIcon name="developer__read" status={status} />
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-text-primary">{summary}</span>
          </span>
        }
      >
        <div className="border-t border-border-primary bg-background-secondary px-2 py-1.5">
          {activities.map((activity, index) => (
            <CodeProActivityCard
              key={activity.key}
              activity={activity}
              active={active && index === activities.length - 1}
            />
          ))}
        </div>
      </ToolCallExpandable>
    </div>
  );
}

interface CodeProActivityGroupProps {
  notifications: SystemNotificationContent[];
  active?: boolean;
}

export function CodeProActivityGroup({ notifications, active = false }: CodeProActivityGroupProps) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const latest = notifications[notifications.length - 1];

  if (!latest) {
    return null;
  }

  const { headline } = activityPresentation(latest, intl);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <section
        className="my-2 w-full overflow-hidden rounded-md border border-border-primary bg-background-primary"
        aria-label={`CodePro ${intl.formatMessage(i18n.executionLog)}`}
      >
        <CollapsibleTrigger
          type="button"
          className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
          aria-expanded={expanded}
          aria-label={intl.formatMessage(i18n.executionLogAccessible, { headline })}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
            {active ? (
              <LoaderCircle className="h-4 w-4 animate-spin text-blue-500" />
            ) : (
              <ListTree className="h-4 w-4 text-text-secondary" />
            )}
          </span>
          <span className="shrink-0 text-sm font-medium text-text-primary">
            {intl.formatMessage(i18n.executionLog)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">{headline}</span>
          <span className="shrink-0 text-xs text-text-secondary">
            {intl.formatMessage(i18n.actionCount, { count: notifications.length })}
          </span>
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-text-secondary transition-transform group-hover:text-text-primary',
              expanded && 'rotate-90'
            )}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="codepro-disclosure-content">
          <div className="divide-y divide-border-primary border-t border-border-primary bg-background-secondary">
            {notifications.map((notification, index) => {
              const activity = activityPresentation(notification, intl);
              return (
                <article key={`${index}-${notification.msg}`} className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-4 w-4 shrink-0 items-center justify-center"
                      aria-hidden="true"
                    >
                      <ActivityStatusIcon
                        notification={notification}
                        active={active && index === notifications.length - 1}
                      />
                    </span>
                    <h4 className="text-sm font-medium text-text-primary">{activity.headline}</h4>
                  </div>
                  {activity.details.length > 0 && (
                    <dl className="mt-2 space-y-1.5 pl-6">
                      {activity.details.map((line, detailIndex) => {
                        const detail = activityDetail(line, intl);
                        return (
                          <div
                            key={`${detailIndex}-${line}`}
                            className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2"
                          >
                            <dt className="text-xs font-medium text-text-secondary">
                              {detail.label}
                            </dt>
                            <dd className="min-w-0 break-words text-xs leading-5 text-text-primary">
                              {detail.technical ? (
                                <code
                                  className="block overflow-x-auto whitespace-pre-wrap break-all rounded bg-background-primary px-1.5 py-0.5 font-mono text-[0.75rem]"
                                  title={detail.value}
                                >
                                  {detail.value}
                                </code>
                              ) : (
                                detail.value
                              )}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </article>
              );
            })}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
