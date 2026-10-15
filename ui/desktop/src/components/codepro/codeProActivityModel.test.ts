import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../../types/activityEvent';
import type { SystemNotificationContent } from '../../types/message';
import { buildCodeProActivityRenderItems } from './codeProActivityModel';

function activity(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schema_version: 1,
    event_id: 'event-1',
    event_type: 'file_read',
    session_id: 'session-1',
    run_id: 'run-1',
    task_id: 'task-1',
    parent_task_id: null,
    agent_role: 'coder',
    effective_model: 'provider/model',
    status: 'running',
    started_at: '2026-08-02T08:00:00.000Z',
    finished_at: null,
    title: '正在读取文件',
    technical_details: null,
    path: 'D:\\project\\README.md',
    command_summary: null,
    exit_code: null,
    diff_summary: null,
    include_in_model_context: false,
    retryable: false,
    retry_from_event_id: null,
    ...overrides,
  };
}

function notification(event: ActivityEvent): SystemNotificationContent {
  return {
    notificationType: 'codeProActivity',
    msg: `CodePro · ${event.title}`,
    data: event,
  };
}

function activities(notifications: SystemNotificationContent[]) {
  return buildCodeProActivityRenderItems(notifications).flatMap((item) =>
    item.kind === 'activity' ? [item.activity] : item.activities
  );
}

describe('buildCodeProActivityRenderItems', () => {
  it('renders public progress from structured fields without exposing internal orchestration labels', () => {
    const [progress] = activities([
      {
        notificationType: 'codeProActivity',
        msg: '失败 failed 停止 stopped',
        data: {
          schemaVersion: 1,
          sessionId: 'session-1',
          runId: 'run-1',
          taskId: 'coder-1',
          attemptId: 'coder-1:1',
          role: 'coder',
          phase: 'coding',
          status: 'running',
          summary: '正在修复测试',
          currentFile: 'src/main.rs',
          currentCommand: 'cargo test --jobs 1',
          incrementalOutput: 'updated validation branch',
          startedAt: '2026-08-29T01:00:00Z',
          lastActivityAt: '2026-08-29T01:00:03Z',
          heartbeatAt: '2026-08-29T01:00:03Z',
          elapsedMs: 3_000,
          nextStep: 'Tester reruns the same command',
        },
      },
    ]);

    expect(progress.state).toBe('running');
    expect(progress.source).toBe('public_progress');
    expect(progress.summary).toBe('正在修复测试');
    expect(progress.path).toBe('src/main.rs');
    expect(progress.command).toBe('cargo test --jobs 1');
    expect(progress.output).toBe('updated validation branch');
    expect(progress.parameters).toContain('下一步：验证步骤 reruns the same command');
    expect(progress.parameters).not.toContain('角色：coder');
    expect(progress.parameters).not.toContain('阶段：coding');
    expect(progress.parameters).not.toContain('心跳：2026-08-29T01:00:03Z');
  });

  it('uses structured test outcomes so corrected paths and repairable failures are not red', () => {
    const base = {
      schemaVersion: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      taskId: 'tester-1',
      attemptId: 'tester-1:1',
      command: 'cargo test --jobs 1',
      cwd: 'D:\\project',
      elapsedMs: 1_000,
      heartbeatAt: '2026-08-26T08:00:01Z',
      retryAttempt: 0,
      repairAttempt: 0,
      canCancel: true,
    } as const;
    const recovered = activities([
      {
        notificationType: 'codeProActivity',
        msg: 'ignored legacy text that says failed',
        data: {
          ...base,
          phase: 'resolving_dependencies',
          outcome: 'path_corrected',
        },
      },
    ])[0];
    const repairing = activities([
      {
        notificationType: 'codeProActivity',
        msg: 'ignored',
        data: { ...base, phase: 'repairing', outcome: 'verification_failed' },
      },
    ])[0];
    const repairPending = activities([
      {
        notificationType: 'codeProActivity',
        msg: 'ignored',
        data: { ...base, phase: 'completed', outcome: 'verification_failed', canCancel: false },
      },
    ])[0];

    expect(recovered.state).toBe('running');
    expect(recovered.summary).toContain('正在解析依赖');
    expect(repairing.state).toBe('running');
    expect(repairing.summary).toContain('正在交给 Coder 修复');
    expect(repairPending.state).toBe('running');
  });

  it('renders permission waits from the structured outcome and exact path', () => {
    const [waiting] = activities([
      {
        notificationType: 'codeProActivity',
        msg: 'ignored',
        data: {
          schemaVersion: 1,
          sessionId: 'session-1',
          runId: 'run-1',
          taskId: 'tester-1',
          attemptId: 'tester-1:1',
          phase: 'waiting_for_user',
          outcome: 'permission_required',
          command: '',
          cwd: 'D:\\project',
          elapsedMs: 500,
          heartbeatAt: '2026-08-26T08:00:01Z',
          retryAttempt: 0,
          repairAttempt: 0,
          canCancel: false,
          requiredPath: 'D:\\outside\\Cargo.toml',
          requiredPermission: 'read',
        },
      },
    ]);

    expect(waiting.state).toBe('pending');
    expect(waiting.summary).toContain('需要你的允许');
    expect(waiting.testProgress?.requiredPath).toBe('D:\\outside\\Cargo.toml');
  });

  it('renders a missing test prerequisite as waiting instead of failed', () => {
    const [waiting] = activities([
      {
        notificationType: 'codeProActivity',
        msg: 'ignored',
        data: {
          schemaVersion: 1,
          sessionId: 'session-1',
          runId: 'run-1',
          taskId: 'tester-1',
          attemptId: 'tester-1:1',
          phase: 'waiting_for_user',
          outcome: 'prerequisite_unavailable',
          command: 'python test_api.py',
          cwd: 'D:\\project',
          elapsedMs: 500,
          heartbeatAt: '2026-08-26T08:00:01Z',
          retryAttempt: 0,
          repairAttempt: 0,
          canCancel: false,
          reason:
            '测试依赖的本地服务尚未运行。请提供或确认该服务的启动命令。已保存当前检查点；处理后会自动重跑同一测试命令。',
        },
      },
    ]);

    expect(waiting.state).toBe('pending');
    expect(waiting.summary).toContain('等待前置服务');
    expect(waiting.diffSummary).toContain('启动命令');
    expect(waiting.diffSummary).toContain('重跑同一测试命令');
  });

  it('does not render a completed not_found discovery as test success', () => {
    const [missing] = activities([
      {
        notificationType: 'codeProActivity',
        msg: 'ignored',
        data: {
          schemaVersion: 1,
          sessionId: 'session-1',
          runId: 'run-1',
          taskId: 'tester-1',
          attemptId: 'tester-1:1',
          phase: 'completed',
          outcome: 'not_found',
          command: '',
          cwd: 'D:\\empty-project',
          elapsedMs: 500,
          heartbeatAt: '2026-08-26T08:00:01Z',
          retryAttempt: 0,
          repairAttempt: 0,
          canCancel: false,
          reason: '未发现受支持的项目测试入口',
        },
      },
    ]);

    expect(missing.state).toBe('pending');
    expect(missing.statusLabel).not.toBe('已完成');
    expect(missing.summary).toContain('未发现可执行测试入口，等待确认');
    expect(missing.command).toBeNull();
    expect(missing.diffSummary).toBe('未发现受支持的项目测试入口');
  });

  it('merges started and completed lifecycle events into one terminal activity', () => {
    const items = buildCodeProActivityRenderItems([
      notification(activity()),
      notification(
        activity({
          event_type: 'file_read',
          status: 'completed',
          title: '已读取文件',
          finished_at: '2026-08-02T08:00:02.250Z',
          technical_details: '结果：读取 42 行',
        })
      ),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'activity',
      activity: {
        eventId: 'event-1',
        taskId: 'task-1',
        state: 'completed',
        statusLabel: '已完成',
        duration: '2.25 秒',
        output: '读取 42 行',
      },
    });
  });

  it('does not let a late running event downgrade an existing terminal event', () => {
    const result = activities([
      notification(
        activity({
          status: 'completed',
          title: '已读取文件',
          finished_at: '2026-08-02T08:00:01.000Z',
        })
      ),
      notification(activity({ title: '迟到的运行通知' })),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('completed');
  });

  it('keeps the same event id from different runs separate', () => {
    const result = activities([
      notification(activity({ run_id: 'run-1' })),
      notification(activity({ run_id: 'run-2' })),
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.runId)).toEqual(['run-1', 'run-2']);
  });

  it('renders commands, changes, and tests as independent activities', () => {
    const items = buildCodeProActivityRenderItems([
      notification(
        activity({
          event_id: 'command-1',
          event_type: 'command_completed',
          status: 'completed',
          path: 'D:\\project',
          command_summary: 'pnpm test',
        })
      ),
      notification(
        activity({
          event_id: 'change-1',
          event_type: 'file_changed',
          status: 'completed',
          path: 'D:\\project\\src\\app.ts',
        })
      ),
      notification(
        activity({
          event_id: 'test-1',
          event_type: 'test_completed',
          status: 'failed',
          path: 'D:\\project',
          command_summary: 'cargo test -p goose',
          exit_code: 1,
        })
      ),
    ]);

    expect(items.map((item) => item.kind)).toEqual(['activity', 'activity', 'activity']);
    expect(
      items.map((item) => (item.kind === 'activity' ? item.activity.eventId : 'group'))
    ).toEqual(['command-1', 'change-1', 'test-1']);
  });

  it('groups only adjacent structured file reads from the same run', () => {
    const items = buildCodeProActivityRenderItems([
      notification(activity({ event_id: 'read-1', status: 'completed' })),
      notification(
        activity({
          event_id: 'read-2',
          status: 'completed',
          path: 'D:\\project\\src\\app.ts',
        })
      ),
      notification(
        activity({
          event_id: 'command-1',
          event_type: 'command_completed',
          status: 'completed',
          command_summary: 'pnpm test',
        })
      ),
      notification(
        activity({
          event_id: 'read-3',
          status: 'completed',
          path: 'D:\\project\\src\\after.ts',
        })
      ),
      notification(
        activity({
          event_id: 'read-4',
          run_id: 'run-2',
          status: 'completed',
          path: 'D:\\project\\src\\other-run.ts',
        })
      ),
    ]);

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: 'read-group' });
    expect(items[0].kind === 'read-group' && items[0].activities).toHaveLength(2);
    expect(items.slice(1).map((item) => item.kind)).toEqual(['activity', 'activity', 'activity']);
  });

  it('does not merge file reads from different tasks into one navigation target', () => {
    const items = buildCodeProActivityRenderItems([
      notification(activity({ event_id: 'read-task-1', status: 'completed', task_id: 'task-1' })),
      notification(activity({ event_id: 'read-task-2', status: 'completed', task_id: 'task-2' })),
    ]);

    expect(items.map((item) => item.kind)).toEqual(['activity', 'activity']);
  });

  it('keeps a concrete path or command in failed summaries', () => {
    const [fileFailure, commandFailure] = activities([
      notification(
        activity({
          event_id: 'file-failure',
          event_type: 'file_changed',
          status: 'failed',
          path: 'D:\\project\\src\\broken.ts',
        })
      ),
      notification(
        activity({
          event_id: 'command-failure',
          event_type: 'command_completed',
          status: 'failed',
          path: null,
          command_summary: 'pnpm test --filter broken',
        })
      ),
    ]);

    expect(fileFailure.summary).toContain('D:\\project\\src\\broken.ts');
    expect(fileFailure.summary).toContain('失败');
    expect(commandFailure.summary).toContain('pnpm test --filter broken');
    expect(commandFailure.summary).toContain('失败');
  });

  it('carries a trusted host failure kind into the activity view model', () => {
    const [result] = activities([
      notification(
        activity({
          status: 'failed',
          failure_kind: 'outside_workspace',
        })
      ),
    ]);

    expect(result.failureKind).toBe('outside_workspace');
  });

  it.each([
    {
      tier: 'l1_reversible_change' as const,
      roles: [] as ActivityEvent['selected_roles'],
      flow: 'simple_change' as const,
    },
    {
      tier: 'l2_feature' as const,
      roles: ['planner', 'tester'] as ActivityEvent['selected_roles'],
      flow: 'project_test' as const,
    },
    {
      tier: 'l2_feature' as const,
      roles: ['planner', 'coder', 'tester'] as ActivityEvent['selected_roles'],
      flow: 'feature' as const,
    },
    {
      tier: 'l3_high_risk_release' as const,
      roles: ['planner', 'coder', 'tester', 'reviewer'] as ActivityEvent['selected_roles'],
      flow: 'high_risk' as const,
    },
  ])('renders the $tier topology explicitly', ({ tier, roles, flow }) => {
    const [result] = activities([
      notification(
        activity({
          event_type: 'plan_created',
          risk_tier: tier,
          selected_roles: roles,
          review_required: tier === 'l3_high_risk_release',
        })
      ),
    ]);

    expect(result.riskTier).toBe(tier);
    expect(result.flow).toBe(flow);
    expect(result.reviewRequired).toBe(tier === 'l3_high_risk_release');
  });

  it('renders host strategy selection separately from real planner events', () => {
    const [strategy, plan] = activities([
      notification(
        activity({
          event_id: 'strategy-1',
          event_type: 'strategy_selected',
          title: '已确定执行策略',
          command_summary: null,
          risk_tier: 'l2_feature',
          selected_roles: ['planner', 'tester'],
        })
      ),
      notification(
        activity({
          event_id: 'plan-1',
          event_type: 'plan_created',
          title: '任务规划完成',
        })
      ),
    ]);

    expect(strategy.verb).toBe('选择策略');
    expect(strategy.toolName).toBe('codepro_execution_strategy');
    expect(strategy.flow).toBe('project_test');
    expect(plan.verb).toBe('规划');
  });

  it('shows a future risk tier as requiring inspection instead of success', () => {
    const [result] = activities([
      notification(
        activity({
          event_type: 'plan_updated',
          risk_tier: 'unknown',
          review_required: true,
        })
      ),
    ]);

    expect(result.riskTier).toBe('unknown');
    expect(result.flow).toBe('needs_inspection');
  });

  it('omits invalid durations and bounds output by both lines and characters', () => {
    const longOutput = Array.from({ length: 70 }, (_, index) => `${index}:${'x'.repeat(100)}`).join(
      '\n'
    );
    const [result] = activities([
      notification(
        activity({
          event_type: 'command_completed',
          status: 'completed',
          started_at: 'not-a-date',
          finished_at: '2026-08-02T08:00:01.000Z',
          technical_details: `输出：${longOutput}`,
        })
      ),
    ]);

    expect(result.duration).toBeNull();
    expect(result.output?.length).toBeLessThanOrEqual(4_020);
    expect(result.output?.split('\n').length).toBeLessThanOrEqual(51);
    expect(result.output).toContain('内容已截断');
  });

  it('shows unknown structured states without treating them as success', () => {
    const [result] = activities([
      notification(activity({ status: 'unknown', event_type: 'unknown' })),
    ]);

    expect(result.state).toBe('unknown');
    expect(result.statusLabel).toBe('状态未知');
    expect(result.summary).toContain('状态未知');
  });

  it('does not group unknown file reads under a completed summary', () => {
    const items = buildCodeProActivityRenderItems([
      notification(activity({ event_id: 'unknown-read-1', status: 'unknown' })),
      notification(activity({ event_id: 'unknown-read-2', status: 'unknown' })),
    ]);

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.kind === 'activity')).toBe(true);
  });

  it('keeps legacy messages as independent compatibility activities', () => {
    const legacy: SystemNotificationContent = {
      notificationType: 'codeProActivity',
      msg: 'CodePro · 已读取文件\n路径：D:\\legacy\\README.md\n状态：成功',
    };

    const items = buildCodeProActivityRenderItems([legacy, legacy]);

    expect(items.map((item) => item.kind)).toEqual(['activity', 'activity']);
    expect(activities([legacy])[0]).toMatchObject({ structured: false });
  });
});
