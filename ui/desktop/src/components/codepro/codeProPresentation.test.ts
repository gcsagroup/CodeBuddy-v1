import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { CodeProActivityViewModel } from './codeProActivityModel';
import {
  formatCodeProActivityState,
  formatCodeProActivitySummary,
  formatCodeProActivityVerb,
  formatCodeProFailureKind,
  formatCodeProTaskStatus,
  formatCodeProTerminalVerdict,
} from './codeProPresentation';

const enIntl = createIntl({ locale: 'en', messages: {} });
const zhIntl = createIntl({
  locale: 'zh-CN',
  messages: {
    'codeProPresentation.activityState.failed': '失败',
    'codeProPresentation.activityState.completed': '已完成',
    'codeProPresentation.activitySummary': '{verb} {target} · {status}',
    'codeProPresentation.intentSummary': '{title} · {status}',
    'codeProPresentation.activityVerb.command': '运行',
    'codeProPresentation.activityVerb.strategy': '选择策略',
    'codeProPresentation.taskStatus.running': '运行中',
    'codeProPresentation.taskStatus.notDynamicallyTested': '未运行动态验证',
    'codeProPresentation.summaryStatus.paused': '需要你确认',
    'codeProPresentation.verification.passed': '测试通过',
    'codeProPresentation.verification.failed': '测试失败',
    'codeProPresentation.failure.policyDenied': '需要调整操作',
    'codeProPresentation.failure.userDenied': '用户未授权',
    'codeProPresentation.failure.outsideWorkspace': '等待用户授权范围',
    'codeProPresentation.failure.forbidden': '操作被禁止',
    'codeProPresentation.failure.cancelled': '任务已取消',
    'codeProPresentation.failure.environmentFailure': '环境不可用',
  },
});

const activity: CodeProActivityViewModel = {
  source: 'activity_event',
  key: 'run-1:command-1',
  runId: 'run-1',
  eventId: 'command-1',
  taskId: 'task-1',
  eventType: 'command_completed',
  state: 'failed',
  statusLabel: '失败',
  verb: '运行',
  target: 'pnpm test',
  summary: '运行 pnpm test · 失败',
  title: '命令执行完成',
  toolName: 'developer__shell',
  path: 'D:\\project',
  command: 'pnpm test',
  duration: '2.25 秒',
  exitCode: 1,
  parameters: [],
  output: '1 test failed',
  diffSummary: null,
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

describe('CodePro locale presentation', () => {
  it('formats task status in the current language', () => {
    expect(formatCodeProTaskStatus(enIntl, 'running')).toBe('Running');
    expect(formatCodeProTaskStatus(zhIntl, 'running')).toBe('运行中');
  });

  it('formats activity summaries without changing technical targets', () => {
    expect(formatCodeProActivitySummary(enIntl, activity)).toBe('Run pnpm test · Failed');
    expect(formatCodeProActivitySummary(zhIntl, activity)).toBe('运行 pnpm test · 失败');
    expect(formatCodeProActivitySummary(enIntl, activity)).toContain('pnpm test');
  });

  it('formats host strategy events separately from planner events', () => {
    expect(formatCodeProActivityVerb(enIntl, 'strategy_selected')).toBe('Choose strategy');
    expect(formatCodeProActivityVerb(zhIntl, 'strategy_selected')).toBe('选择策略');
    expect(formatCodeProActivityVerb(enIntl, 'plan_created')).toBe('Plan');
  });

  it('does not label the intent summary as planning', () => {
    expect(
      formatCodeProActivitySummary(zhIntl, {
        ...activity,
        eventId: 'intent-classification-run-1',
        eventType: 'intent_completed',
        state: 'completed',
        title: '思考摘要',
      })
    ).toBe('思考摘要 · 已完成');
  });

  it('keeps tool-decision events labeled as thinking after protocol conversion', () => {
    expect(
      formatCodeProActivitySummary(zhIntl, {
        ...activity,
        eventId: 'thinking-tool-request-1',
        eventType: 'plan_created',
        state: 'completed',
        title: '思考',
      })
    ).toBe('思考 · 已完成');
  });

  it('uses the trusted failure kind instead of a generic failed label', () => {
    expect(
      formatCodeProActivitySummary(enIntl, {
        ...activity,
        failureKind: 'outside_workspace',
      })
    ).toBe('Run pnpm test · Waiting for workspace authorization');
    expect(formatCodeProFailureKind(enIntl, 'policy_denied')).toBe('Action needs adjustment');
  });

  it('formats unknown states explicitly instead of relying on color', () => {
    expect(formatCodeProActivityState(enIntl, 'unknown')).toBe('Unknown status');
  });

  it('presents terminal verdicts as plain language instead of internal status codes', () => {
    expect(formatCodeProTerminalVerdict(zhIntl, 'PASS')).toBe('测试通过');
    expect(formatCodeProTerminalVerdict(zhIntl, 'FAIL')).toBe('测试失败');
    expect(formatCodeProTerminalVerdict(zhIntl, 'NOT_RUN')).toBe('未运行动态验证');
    expect(formatCodeProTerminalVerdict(zhIntl, 'BLOCKED')).toBe('需要你确认');
    expect(formatCodeProTerminalVerdict(enIntl, 'WAITING_FOR_USER')).toBe('Needs your input');
  });

  it.each([
    ['policy_denied', '需要调整操作'],
    ['user_denied', '用户未授权'],
    ['outside_workspace', '等待用户授权范围'],
    ['forbidden', '操作被禁止'],
    ['cancelled', '任务已取消'],
    ['environment_failure', '环境不可用'],
  ] as const)('formats host failure %s without text inference', (kind, expected) => {
    expect(formatCodeProFailureKind(zhIntl, kind)).toBe(expected);
  });
});
