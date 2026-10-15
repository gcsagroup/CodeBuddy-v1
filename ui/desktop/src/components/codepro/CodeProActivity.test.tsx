import { fireEvent, render as testingRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import {
  CodeProActivity,
  CodeProActivityCard,
  CodeProActivityGroup,
  CodeProActivityTimeline,
  CodeProReadGroup,
  parseCodeProActivity,
} from './CodeProActivity';
import type { CodeProActivityViewModel } from './codeProActivityModel';

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

function viewModel(overrides: Partial<CodeProActivityViewModel> = {}): CodeProActivityViewModel {
  return {
    key: 'run-1:command-1',
    source: 'activity_event',
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
    parameters: ['超时：120 秒'],
    output: '1 test failed',
    diffSummary: '+2 -1',
    effectiveModel: null,
    failureKind: null,
    riskTier: null,
    previousRiskTier: null,
    flow: null,
    reviewRequired: null,
    riskReasons: [],
    testProgress: null,
    structured: true,
    ...overrides,
  };
}
describe('CodeProActivity', () => {
  it('keeps settled tools factual while the answer is still streaming', () => {
    const read = viewModel({
      key: 'run-1:read-1',
      eventId: 'read-1',
      eventType: 'file_read',
      state: 'completed',
      path: 'D:\\project\\README.md',
      target: 'D:\\project\\README.md',
    });
    const edit = viewModel({
      key: 'run-1:edit-1',
      eventId: 'edit-1',
      eventType: 'file_changed',
      state: 'completed',
      path: 'D:\\project\\app.ts',
      target: 'D:\\project\\app.ts',
      diffSummary: null,
    });
    const items = [
      { kind: 'activity' as const, key: read.key, activity: read },
      { kind: 'activity' as const, key: edit.key, activity: edit },
    ];
    const view = render(<CodeProActivityTimeline active items={items} />);

    expect(screen.getByRole('button', { name: 'Operations recorded · 2 actions' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(view.container.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Execution log' })).toHaveClass(
      'max-h-64',
      'overflow-y-auto'
    );
    expect(screen.queryByText(/Edit actions 1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Read actions 1/)).not.toBeInTheDocument();
    expect(screen.queryByText('Edit operations completed')).not.toBeInTheDocument();

    view.rerender(<CodeProActivityTimeline items={items} />);
    expect(screen.getByRole('button', { name: 'Operations recorded · 2 actions' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByRole('region', { name: 'Execution log' })).not.toBeInTheDocument();
    expect(screen.queryByText('Edit operations completed')).not.toBeInTheDocument();
    expect(screen.queryByText('Tool receipts, not a verified diff')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Operations recorded · 2 actions' }));
    expect(screen.getByRole('button', { name: 'Operations recorded · 2 actions' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getAllByRole('button', { name: /^Activity:/ })).toHaveLength(2);
  });

  it('does not present a failed edit as a completed change', () => {
    render(
      <CodeProActivityTimeline
        items={[
          {
            kind: 'activity',
            key: 'run-1:edit-failed',
            activity: viewModel({
              key: 'run-1:edit-failed',
              eventType: 'file_changed',
              state: 'failed',
              path: 'D:\\project\\app.ts',
            }),
          },
        ]}
      />
    );

    expect(screen.queryByText('1 failed action')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Execution log' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Activity:/ }));
    expect(screen.getByText('1 test failed')).toBeVisible();
    expect(screen.queryByText('Edit operations completed')).not.toBeInTheDocument();
  });

  it('does not treat a completed coding progress update as an edit receipt', () => {
    render(
      <CodeProActivityTimeline
        items={[
          {
            kind: 'activity',
            key: 'progress:run-1:attempt-1',
            activity: viewModel({
              key: 'progress:run-1:attempt-1',
              source: 'public_progress',
              eventType: 'file_changed',
              state: 'completed',
              path: 'D:\\project\\app.ts',
            }),
          },
        ]}
      />
    );

    expect(screen.queryByText('Edit operations completed')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit actions 1')).not.toBeInTheDocument();
  });

  it('exposes the structured task id as a safe activity navigation target', () => {
    const { container } = render(<CodeProActivityCard activity={viewModel()} />);

    expect(container.querySelector('[data-codepro-task-id="task-1"]')).toBeInTheDocument();
  });

  it('shows live action, elapsed time, current item, output state, and cancel in user language', () => {
    render(
      <CodeProActivityCard
        active
        activity={viewModel({
          state: 'running',
          title: '仍在编译',
          summary: '仍在编译 · goose',
          duration: '12.5 秒',
          testProgress: {
            schemaVersion: 1,
            sessionId: 'parent-session',
            runId: 'run-1',
            taskId: 'tester-1',
            attemptId: 'tester-1:1',
            phase: 'compiling',
            command: 'cargo test --manifest-path D:\\project\\Cargo.toml --jobs 1',
            cwd: 'D:\\project',
            elapsedMs: 12_500,
            currentCrate: 'goose',
            completed: 0,
            total: 1,
            pid: 42,
            heartbeatAt: '2026-08-26T08:00:12Z',
            retryAttempt: 0,
            repairAttempt: 0,
            canCancel: true,
          },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('仍在编译')).toBeVisible();
    expect(screen.getByText('12.5 秒')).toBeVisible();
    expect(screen.getByText('goose')).toBeVisible();
    expect(screen.getByText('0/1')).toBeVisible();
    expect(screen.getByText('Current crate')).toBeVisible();
    expect(screen.getByText('Progress')).toBeVisible();
    expect(screen.getByText('Process status')).toBeVisible();
    expect(screen.getByText('Process is active; waiting for new compiler output')).toBeVisible();
    expect(screen.queryByText('Stage')).not.toBeInTheDocument();
    expect(screen.queryByText('Process PID')).not.toBeInTheDocument();
    expect(screen.queryByText('Last heartbeat')).not.toBeInTheDocument();
    expect(screen.queryByText('Attempts')).not.toBeInTheDocument();
    expect(screen.queryByText('Retry 0 · repair 0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel test' })).toBeVisible();
  });

  it('keeps an expanded activity open while incremental output updates in place', () => {
    const first = viewModel({
      state: 'running',
      summary: '正在运行测试',
      output: '1/3 tests completed',
    });
    const view = render(<CodeProActivityCard active activity={first} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('1/3 tests completed')).toBeVisible();

    view.rerender(
      <CodeProActivityCard
        active
        activity={{ ...first, output: '2/3 tests completed', duration: '8.4 秒' }}
      />
    );

    expect(screen.queryByText('1/3 tests completed')).not.toBeInTheDocument();
    expect(screen.getByText('2/3 tests completed')).toBeVisible();
    expect(screen.getByText('8.4 秒')).toBeVisible();
  });

  it('localizes optional live test context labels through the shared message catalog', () => {
    render(
      <CodeProActivityCard
        active
        activity={viewModel({
          state: 'running',
          testProgress: {
            schemaVersion: 1,
            sessionId: 'parent-session',
            runId: 'run-1',
            taskId: 'tester-1',
            attemptId: 'tester-1:1',
            phase: 'running_tests',
            command: 'pnpm test',
            cwd: 'D:\\project',
            elapsedMs: 2_000,
            currentTest: 'keeps source files unchanged',
            heartbeatAt: '2026-08-26T08:00:12Z',
            lastOutputAt: '2026-08-26T08:00:11Z',
            requiredPath: 'D:\\project\\fixtures',
            requiredPermission: 'read',
            retryAttempt: 1,
            repairAttempt: 2,
            canCancel: false,
          },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Current test')).toBeVisible();
    expect(screen.getByText('keeps source files unchanged')).toBeVisible();
    expect(screen.getByText('Last output')).toBeVisible();
    expect(screen.getByText('Required path')).toBeVisible();
    expect(screen.getByText('Required permission')).toBeVisible();
    expect(screen.queryByText('Retry 1 · repair 2')).not.toBeInTheDocument();
  });

  it('reveals details on click', () => {
    render(
      <CodeProActivity
        notification={{
          notificationType: 'codeProActivity',
          msg: 'CodePro activity\npending task-1',
        }}
      />
    );
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('pending task-1')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('pending task-1')).toBeInTheDocument();
  });

  it('prefers a structured ActivityEvent over its legacy display text', () => {
    const { container } = render(
      <CodeProActivity
        active
        notification={{
          notificationType: 'codeProActivity',
          msg: 'CodePro · 旧标题\n状态：处理中',
          data: {
            schema_version: 1,
            event_id: 'tool-structured',
            event_type: 'test_completed',
            session_id: 'session-01',
            run_id: 'run-01',
            status: 'completed',
            started_at: '2026-07-30T12:00:00Z',
            finished_at: '2026-07-30T12:00:05Z',
            title: '结构化测试已完成',
            technical_details: '结果：4 passed',
            task_id: null,
            parent_task_id: null,
            agent_role: 'tester',
            effective_model: 'provider/model',
            path: null,
            command_summary: 'cargo test',
            exit_code: 0,
            diff_summary: null,
            include_in_model_context: false,
            retryable: true,
            retry_from_event_id: null,
          },
        }}
      />
    );

    expect(screen.getByText('Test cargo test · Completed')).toBeInTheDocument();
    expect(screen.queryByText('旧标题')).not.toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('shows structured tool, path, command, output, exit code, and diff details', () => {
    render(
      <CodeProActivity
        notification={{
          notificationType: 'codeProActivity',
          msg: 'CodePro activity',
          data: {
            schema_version: 1,
            event_id: 'command-1',
            event_type: 'command_completed',
            session_id: 'session-01',
            run_id: 'run-01',
            status: 'completed',
            started_at: '2026-07-30T12:00:00Z',
            finished_at: '2026-07-30T12:00:05Z',
            title: '命令执行完成',
            technical_details: '输出：3 tests passed',
            task_id: 'task-1',
            parent_task_id: null,
            agent_role: 'tester',
            effective_model: 'provider/model',
            path: 'D:\\CodeBuddy',
            command_summary: 'pnpm exec vitest run',
            exit_code: 0,
            diff_summary: '+12 -3',
            include_in_model_context: false,
            retryable: true,
            retry_from_event_id: null,
          },
        }}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Tool')).toBeVisible();
    expect(screen.getByText('Command execution')).toBeVisible();
    expect(screen.getByText('Path')).toBeVisible();
    expect(screen.getByText('D:\\CodeBuddy')).toBeVisible();
    expect(screen.getByText('Command')).toBeVisible();
    expect(screen.getByText('pnpm exec vitest run')).toBeVisible();
    expect(screen.getByText('Output')).toBeVisible();
    expect(screen.getByText('3 tests passed')).toBeVisible();
    expect(screen.getByText('Exit code')).toBeVisible();
    expect(screen.getByText('0')).toBeVisible();
    expect(screen.getByText('Changes')).toBeVisible();
    expect(screen.getByText('+12 -3')).toBeVisible();
    expect(screen.getByText('Effective model')).toBeVisible();
    expect(screen.getByText('provider/model')).toBeVisible();
  });

  it('only spins while the activity is active', () => {
    const { rerender, container } = render(
      <CodeProActivity
        active
        notification={{ notificationType: 'codeProActivity', msg: 'CodePro activity' }}
      />
    );
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();

    rerender(
      <CodeProActivity
        active={false}
        notification={{ notificationType: 'codeProActivity', msg: 'CodePro activity' }}
      />
    );
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('stops spinning as soon as a completed tool result arrives', () => {
    const { container } = render(
      <CodeProActivity
        active
        notification={{
          notificationType: 'codeProActivity',
          msg: [
            'CodePro · 命令执行完成',
            '功能：运行项目测试',
            '目录：E:\\awesome-llm-apps',
            '命令：python _smoke_test.py',
            '状态：成功',
            '结果：Total: 46, Pass: 46, Fail: 0',
          ].join('\n'),
        }}
      />
    );

    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(container.querySelector('.text-green-600')).toBeInTheDocument();
  });

  it('shows a failure icon for a completed failed action', () => {
    const { container } = render(
      <CodeProActivity
        active
        notification={{
          notificationType: 'codeProActivity',
          msg: 'CodePro · 命令执行完成\n状态：失败\n结果：退出码 1',
        }}
      />
    );

    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(container.querySelector('.text-red-600')).toBeInTheDocument();
  });

  it('shows the exact trusted failure reason in the summary and details', () => {
    render(
      <CodeProActivityCard
        activity={viewModel({
          eventType: 'file_read',
          target: 'D:\\outside\\secret.txt',
          path: 'D:\\outside\\secret.txt',
          failureKind: 'outside_workspace',
        })}
      />
    );

    expect(screen.getByText(/Waiting for workspace authorization/)).toBeVisible();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Failure reason')).toBeVisible();
    expect(screen.getAllByText('Waiting for workspace authorization').length).toBeGreaterThan(0);
  });

  it('keeps risk topology and agent orchestration out of user-facing activity details', () => {
    render(
      <CodeProActivityCard
        activity={viewModel({
          eventType: 'plan_created',
          riskTier: 'l3_high_risk_release',
          flow: 'high_risk',
          reviewRequired: true,
          riskReasons: ['remote_side_effect'],
        })}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('Execution level')).not.toBeInTheDocument();
    expect(screen.queryByText('L3 High risk/release')).not.toBeInTheDocument();
    expect(screen.queryByText('Flow')).not.toBeInTheDocument();
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
    expect(screen.queryByText('Risk reason')).not.toBeInTheDocument();
  });

  it('labels host strategy separately from planner work and does not invent a coder', () => {
    render(
      <CodeProActivity
        notification={{
          notificationType: 'codeProActivity',
          msg: 'CodePro strategy selected',
          data: {
            schema_version: 1,
            event_id: 'strategy-1',
            event_type: 'strategy_selected',
            session_id: 'session-01',
            run_id: 'run-01',
            status: 'completed',
            started_at: '2026-08-25T12:00:00Z',
            finished_at: '2026-08-25T12:00:00Z',
            title: '已确定执行策略',
            technical_details: '说明：先由 Planner 拆分测试范围，再由 Tester 独立执行。',
            task_id: null,
            parent_task_id: null,
            agent_role: null,
            effective_model: null,
            path: null,
            command_summary: null,
            exit_code: null,
            diff_summary: null,
            risk_tier: 'l2_feature',
            selected_roles: ['planner', 'tester'],
            review_required: false,
            include_in_model_context: false,
            retryable: false,
            retry_from_event_id: null,
          },
        }}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText(/Choose strategy 已确定执行策略/)).toBeVisible();
    expect(screen.getByText('Execution strategy')).toBeVisible();
    expect(screen.queryByText('Scope planning → Independent test')).not.toBeInTheDocument();
    expect(screen.queryByText('Task planning')).not.toBeInTheDocument();
    expect(screen.queryByText('Analyze → Code → Independent test')).not.toBeInTheDocument();
  });

  it('does not present an intent summary as a planning tool', () => {
    render(
      <CodeProActivityCard
        activity={viewModel({
          eventId: 'intent-classification-run-01',
          eventType: 'plan_created',
          title: '思考',
          target: '思考',
        })}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('Task planning')).not.toBeInTheDocument();
  });

  it('shows a running thinking decision expanded and updating in place', () => {
    const activity = viewModel({
      eventId: 'thinking-tool-1',
      eventType: 'intent_started',
      state: 'running',
      title: '思考',
      target: '思考',
      summary: '思考 · 进行中',
      output: '1. 正在识别测试目标。\n2. 正在判断是否需要 Tester Agent。',
    });
    const view = render(<CodeProActivityCard active activity={activity} />);

    expect(screen.getByRole('button', { name: 'Thinking · Updating' })).toHaveAttribute(
      'data-state',
      'open'
    );
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'LI' && !!element.textContent?.includes('正在识别测试目标')
      )
    ).toBeVisible();

    view.rerender(
      <CodeProActivityCard
        active
        activity={{
          ...activity,
          eventType: 'intent_completed',
          state: 'completed',
          summary: '思考 · 已完成',
          output: '1. 测试目标明确。\n2. 交给 Tester Agent。\n3. 运行最小必要命令。',
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
      'data-state',
      'closed'
    );
    expect(screen.queryByText(/正在识别测试目标/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tester Agent/)).not.toBeInTheDocument();
  });

  it('keeps a completed thinking decision readable without a tool detail card', () => {
    render(
      <CodeProActivityCard
        active
        activity={viewModel({
          eventId: 'thinking-tool-1',
          eventType: 'intent_completed',
          state: 'completed',
          title: '思考',
          target: '思考',
          summary: '思考 · 已完成',
          output: '由 Tester Agent 执行：运行最小必要命令验证当前判断。',
        })}
      />
    );

    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
      'data-state',
      'closed'
    );
    expect(screen.queryByText(/Tester Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
  });

  it('renders complete paths and commands as readable technical details', () => {
    const { container } = render(
      <CodeProActivity
        notification={{
          notificationType: 'codeProActivity',
          msg: [
            'CodePro · 正在运行测试',
            '功能：验证 Goose 核心功能',
            '目录：D:\\CodeBuddy',
            '命令：cd /d D:\\CodeBuddy && cargo test -p goose',
          ].join('\n'),
        }}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('D:\\CodeBuddy')).toBeInTheDocument();
    expect(screen.getByText('cd /d D:\\CodeBuddy && cargo test -p goose')).toBeInTheDocument();
    expect(container.querySelectorAll('code')).toHaveLength(2);
  });

  it('shows only this action details instead of repeating the whole task snapshot', () => {
    const activity = parseCodeProActivity(
      [
        'CodePro · 正在执行运行完整测试（Tester Agent）',
        '当前任务：task-2 · 运行完整测试',
        '说明：执行项目已有测试并保留真实输出',
        '验收目标：列出通过、失败和跳过数量',
        '--- CodePro 任务快照 ---',
        '✅ task-1: 分析现有报告',
        '⏳ task-2: 运行完整测试',
        '⏳ task-3: 运行质量检查',
      ].join('\n')
    );

    expect(activity).toEqual({
      headline: '正在执行运行完整测试',
      details: [
        '当前任务：运行完整测试',
        '说明：执行项目已有测试并保留真实输出',
        '验收目标：列出通过、失败和跳过数量',
      ],
    });

    render(
      <CodeProActivity
        notification={{
          notificationType: 'codeProActivity',
          msg: [
            'CodePro · 正在执行运行完整测试（Tester Agent）',
            '当前任务：task-2 · 运行完整测试',
            '说明：执行项目已有测试并保留真实输出',
            '--- CodePro 任务快照 ---',
            '⏳ task-2: 运行完整测试',
          ].join('\n'),
        }}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('执行项目已有测试并保留真实输出')).toBeInTheDocument();
    expect(screen.queryByText('⏳ task-2: 运行完整测试')).not.toBeInTheDocument();
  });

  it('hides internal activity ids from expandable user details', () => {
    render(
      <CodeProActivity
        notification={{
          notificationType: 'codeProActivity',
          msg: [
            'CodePro · 已读取文件',
            '活动ID：tool-42',
            '功能：读取项目文件',
            '路径：D:\\CodeBuddy\\README.md',
            '状态：成功',
          ].join('\n'),
        }}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('活动ID')).not.toBeInTheDocument();
    expect(screen.queryByText('tool-42')).not.toBeInTheDocument();
    expect(screen.getByText('D:\\CodeBuddy\\README.md')).toBeInTheDocument();
  });

  it('renders a compact non-expandable thought milestone without a static detail card', () => {
    render(
      <CodeProActivity
        notification={{
          notificationType: 'codeProActivity',
          msg: 'CodePro · 任务规划完成',
        }}
      />
    );

    expect(screen.getByText('任务规划完成')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('查看详情')).not.toBeInTheDocument();
  });

  it('groups several actions and shows the latest action before expansion', () => {
    render(
      <CodeProActivityGroup
        active
        notifications={[
          {
            notificationType: 'codeProActivity',
            msg: 'CodePro · 已查看项目结构\n活动ID：tool-1\n目录：D:\\project\n状态：成功',
          },
          {
            notificationType: 'codeProActivity',
            msg: 'CodePro · 正在读取文件\n活动ID：tool-2\n路径：D:\\project\\README.md',
          },
        ]}
      />
    );

    const button = screen.getByRole('button', { name: /Execution log/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('正在读取文件')).toBeInTheDocument();
    expect(screen.getByText('2 actions')).toBeInTheDocument();
    expect(screen.queryByText('D:\\project\\README.md')).not.toBeInTheDocument();

    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('D:\\project\\README.md')).toBeInTheDocument();
    expect(screen.getByText('D:\\project')).toBeInTheDocument();
  });

  it('renders a structured action as a compact verb target and text status summary', () => {
    render(<CodeProActivityCard activity={viewModel()} />);

    const button = screen.getByRole('button', { name: 'Activity: Run pnpm test · Failed' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Run pnpm test · Failed')).toBeVisible();
    expect(screen.queryByLabelText('Tool status: error')).not.toBeInTheDocument();
    expect(screen.queryByText('1 test failed')).not.toBeInTheDocument();
  });

  it('expands structured path parameters duration exit code output and diff evidence', () => {
    render(<CodeProActivityCard activity={viewModel()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Activity: Run pnpm test · Failed' }));

    expect(screen.getByText('D:\\project')).toBeVisible();
    expect(screen.getByText('pnpm test')).toBeVisible();
    expect(screen.getByText('超时：120 秒')).toBeVisible();
    expect(screen.getByText('2.25 秒')).toBeVisible();
    expect(screen.getByText('1')).toBeVisible();
    expect(screen.getByText('1 test failed')).toBeVisible();
    expect(screen.getByText('+2 -1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy Path' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy Command' })).toBeVisible();
  });

  it('uses a dedicated read group while preserving every file action', () => {
    const { container } = render(
      <CodeProReadGroup
        activities={[
          viewModel({
            key: 'run-1:read-1',
            eventId: 'read-1',
            eventType: 'file_read',
            state: 'completed',
            statusLabel: '已完成',
            verb: '读取',
            target: 'D:\\project\\README.md',
            summary: '读取 D:\\project\\README.md · 已完成',
            toolName: 'developer__read',
            path: 'D:\\project\\README.md',
            command: null,
            output: '42 lines',
          }),
          viewModel({
            key: 'run-1:read-2',
            eventId: 'read-2',
            eventType: 'file_read',
            state: 'completed',
            statusLabel: '已完成',
            verb: '读取',
            target: 'D:\\project\\src\\app.ts',
            summary: '读取 D:\\project\\src\\app.ts · 已完成',
            toolName: 'developer__read',
            path: 'D:\\project\\src\\app.ts',
            command: null,
            output: '80 lines',
          }),
        ]}
      />
    );

    const button = screen.getByRole('button', { name: 'Read 2 files · Completed' });
    expect(container.querySelector('[data-codepro-task-id="task-1"]')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('D:\\project\\README.md')).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(
      screen.getByRole('button', {
        name: 'Activity: Read D:\\project\\README.md · Completed',
      })
    ).toBeVisible();
    expect(
      screen.getByRole('button', {
        name: 'Activity: Read D:\\project\\src\\app.ts · Completed',
      })
    ).toBeVisible();
  });
});
