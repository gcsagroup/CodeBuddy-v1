import { describe, expect, it } from 'vitest';
import {
  clampCodeProTaskPanelWidth,
  hasCodeProTaskPanelContent,
  parseCodeProRunReport,
  parseCodeProTasks,
  pausedTaskGuidance,
  retainCodeProTasks,
  selectCurrentTurnCodeProRunReport,
  selectCodeProTasks,
  taskOutcomeLabel,
} from './CodeProTaskPanel';

describe('pausedTaskGuidance', () => {
  it('shows an explicit user question instead of claiming an automatic retry', () => {
    expect(
      pausedTaskGuidance([
        { role: 'user', content: [{ type: 'text', text: '分析项目' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'systemNotification',
              notificationType: 'turnTerminal',
              data: {
                schema_version: 1,
                session_id: 'session-1',
                run_id: 'run-1',
                terminal_message_id: 'terminal-1',
                source_user_message_id: 'user-1',
                status: 'interrupted',
                checkpoint_id: 'checkpoint-1',
                retry_strategy: 'continue_checkpoint',
                visible_text_available: true,
                tool_action_count: 0,
                copy_artifact_ref: null,
                finished_at: '2026-08-27T00:00:00Z',
                report: {
                  outcome: 'waiting_for_user',
                  classification_counts: {
                    confirmed_bug: 0,
                    test_failure: 0,
                    environment_problem: 1,
                    codepro_incomplete: 1,
                    unverified: 0,
                  },
                  changed_files: [],
                  verification_summary: [],
                  limitations: [],
                  recovery_action: 'ask_user',
                },
              },
            },
          ],
        },
      ])
    ).toBe('ask_user');
  });
});

const legacyReport = (title: string, taskId: string) =>
  `📋 任务执行报告：${title}\n\n✅ ${taskId}: ${title}\n📂 修改已直接写入当前项目：D:\\CodeBuddy`;

describe('hasCodeProTaskPanelContent', () => {
  it('keeps ordinary conversation free of an empty task panel', () => {
    expect(hasCodeProTaskPanelContent(undefined)).toBe(false);
    expect(
      hasCodeProTaskPanelContent({
        progressMessage: undefined,
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            created: 1,
            content: [{ type: 'text', text: '你好！我是 CodePro。' }],
          },
        ],
      })
    ).toBe(false);
    expect(
      hasCodeProTaskPanelContent({
        progressMessage: undefined,
        messages: [
          {
            id: 'old-report',
            role: 'assistant',
            created: 1,
            content: [
              {
                type: 'text',
                text: '📋 任务执行报告：旧任务\n\n✅ task-1: 完成\n📂 修改已直接写入当前项目：D:\\CodeBuddy',
              },
            ],
          },
          {
            id: 'greeting',
            role: 'user',
            created: 2,
            content: [{ type: 'text', text: '你好' }],
          },
          {
            id: 'greeting-response',
            role: 'assistant',
            created: 3,
            content: [{ type: 'text', text: '你好！' }],
          },
        ],
      })
    ).toBe(false);
  });

  it('shows the panel only after real task progress or a task report exists', () => {
    expect(
      hasCodeProTaskPanelContent({
        progressMessage: 'CodePro · 正在执行任务\n\n--- CodePro 任务快照 ---\n⏳ task-1: 检查项目',
        messages: [],
      })
    ).toBe(true);
    expect(
      hasCodeProTaskPanelContent({
        progressMessage: undefined,
        messages: [
          {
            id: 'assistant-2',
            role: 'assistant',
            created: 2,
            content: [
              {
                type: 'text',
                text: '📋 任务执行报告：目标\n\n✅ task-1: 完成\n📂 修改已直接写入当前项目：D:\\CodeBuddy',
              },
            ],
          },
        ],
      })
    ).toBe(true);
  });
});

describe('selectCurrentTurnCodeProRunReport', () => {
  it('does not restore an earlier run report after a new ordinary user turn', () => {
    expect(
      selectCurrentTurnCodeProRunReport([
        {
          role: 'assistant',
          content: [{ type: 'text', text: legacyReport('旧任务', 'task-old') }],
        },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
      ])
    ).toBeUndefined();
  });

  it('returns only the latest valid report from the current user turn', () => {
    const report = selectCurrentTurnCodeProRunReport([
      { role: 'user', content: [{ type: 'text', text: '检查项目' }] },
      { role: 'assistant', content: [{ type: 'text', text: '正在准备。' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: legacyReport('第一次报告', 'task-first') }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: legacyReport('最终报告', 'task-final') }],
      },
    ]);

    expect(report?.tasks).toEqual([{ id: 'task-final', name: '最终报告', status: 'passed' }]);
  });

  it('uses the authoritative skipped terminal report when final text is unavailable', () => {
    const report = selectCurrentTurnCodeProRunReport([
      { role: 'user', content: [{ type: 'text', text: '分析项目' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'systemNotification',
            notificationType: 'turnTerminal',
            msg: 'CodePro terminal report',
            data: {
              schema_version: 1,
              session_id: 'session-1',
              run_id: 'run-1',
              terminal_message_id: 'terminal-1',
              source_user_message_id: 'user-1',
              status: 'completed',
              checkpoint_id: null,
              retry_strategy: 'not_available',
              visible_text_available: true,
              tool_action_count: 1,
              copy_artifact_ref: null,
              finished_at: '2026-08-27T08:00:01Z',
              report: {
                outcome: 'skipped',
                classification_counts: {
                  confirmed_bug: 0,
                  test_failure: 0,
                  environment_problem: 0,
                  codepro_incomplete: 0,
                  unverified: 0,
                },
                changed_files: [],
                verification_summary: [
                  {
                    task_id: 'host-fallback-verify',
                    verdict: 'skipped',
                    command: null,
                    exit_code: null,
                    evidence_ref: 'verify-1',
                  },
                ],
                limitations: [],
                recovery_action: 'none',
              },
            },
          },
        ],
      },
    ]);

    expect(report?.tasks).toEqual([
      expect.objectContaining({
        id: 'host-fallback-verify',
        status: 'skipped',
        testEvidence: expect.stringContaining('结果：动态验证没有运行'),
      }),
    ]);
    expect(report?.tasks[0]?.testEvidence).not.toContain('NOT_RUN');
  });
});

describe('clampCodeProTaskPanelWidth', () => {
  it('allows the panel to grow left while preserving readable chat space', () => {
    expect(clampCodeProTaskPanelWidth(380, 1440, 'inline')).toBe(380);
    expect(clampCodeProTaskPanelWidth(900, 1440, 'inline')).toBe(480);
    expect(clampCodeProTaskPanelWidth(600, 1024, 'overlay')).toBe(380);
    expect(clampCodeProTaskPanelWidth(600, 320, 'drawer')).toBe(304);
  });

  it('does not shrink the panel below its readable minimum', () => {
    expect(clampCodeProTaskPanelWidth(180, 1440, 'inline')).toBe(320);
  });
});

describe('parseCodeProTasks', () => {
  it('keeps queued, running, passed, failed, and skipped as distinct live states', () => {
    expect(
      parseCodeProTasks(
        '⏳ task-q: 等待执行 🔄 task-r: 正在执行 ✅ task-p: 已完成 ❌ task-f: 执行失败 ⏭️ task-s: 依赖失败'
      )
    ).toEqual([
      { id: 'task-q', name: '等待执行', status: 'queued' },
      { id: 'task-r', name: '正在执行', status: 'running' },
      { id: 'task-p', name: '已完成', status: 'passed' },
      { id: 'task-f', name: '执行失败', status: 'failed' },
      { id: 'task-s', name: '依赖失败', status: 'skipped' },
    ]);
  });

  it('turns the final execution report into task card data', () => {
    const tasks = parseCodeProTasks(
      '📋 任务执行报告：目标\n\n✅ task-1: 修改代码\n❌ task-2: 执行测试\n'
    );

    expect(tasks).toEqual([
      { id: 'task-1', name: '修改代码', status: 'passed' },
      { id: 'task-2', name: '执行测试', status: 'failed' },
    ]);
  });

  it('shows cancelled tasks separately from failures', () => {
    expect(parseCodeProTasks('🛑 task-3: 等待中的任务')).toEqual([
      { id: 'task-3', name: '等待中的任务', status: 'cancelled' },
    ]);
  });

  it('keeps task cards visible when ACP flattens progress newlines', () => {
    expect(
      parseCodeProTasks(
        'CodePro · 任务已进入执行队列 ⏳ task-1: 后端登录接口实现 ⏳ task-2: 登录界面 UI 组件开发 ✅ task-3: 认证状态管理实现'
      )
    ).toEqual([
      { id: 'task-1', name: '后端登录接口实现', status: 'queued' },
      { id: 'task-2', name: '登录界面 UI 组件开发', status: 'queued' },
      { id: 'task-3', name: '认证状态管理实现', status: 'passed' },
    ]);
  });

  it('shows an action-limited task as paused instead of failed', () => {
    expect(parseCodeProTasks('⏸️ task-1: 运行测试')).toEqual([
      { id: 'task-1', name: '运行测试', status: 'paused' },
    ]);
  });

  it('attaches the current Agent role, purpose, and acceptance target to the live task', () => {
    expect(
      parseCodeProTasks(
        [
          'CodePro · 正在执行运行完整测试（Tester Agent）',
          '进度：1 / 4 个任务已完成',
          '当前任务：task-2 · 运行完整测试',
          '说明：运行项目已有测试并统计结果',
          '验收目标：明确列出通过、失败和跳过数量',
          '--- CodePro 任务快照 ---',
          '✅ task-1: 分析项目',
          '⏳ task-2: 运行完整测试',
          '⏳ task-3: 运行质量检查',
          '⏳ task-4: 生成报告',
        ].join('\n')
      )
    ).toContainEqual({
      id: 'task-2',
      name: '运行完整测试',
      status: 'queued',
      role: 'Tester',
      description: '运行项目已有测试并统计结果',
      acceptanceCriteria: '明确列出通过、失败和跳过数量',
    });
  });

  it('retains the last task snapshot while a tool call clears the progress message', () => {
    const previous = [{ id: 'task-1', name: '安装依赖', status: 'queued' as const }];

    expect(retainCodeProTasks(previous, '')).toBe(previous);
    expect(retainCodeProTasks(previous, 'Agent 正在调用工具')).toBe(previous);
  });

  it('uses the current live task snapshot instead of a previous run report', () => {
    const previousReport = [
      { id: 'task-1', name: '旧任务一', status: 'failed' as const },
      { id: 'task-2', name: '旧任务二', status: 'failed' as const },
      { id: 'task-3', name: '旧任务三', status: 'failed' as const },
    ];
    const liveTasks = [
      { id: 'task-1', name: '分析现有报告', status: 'passed' as const },
      { id: 'task-2', name: '运行完整测试', status: 'queued' as const },
      { id: 'task-3', name: '运行质量检查', status: 'queued' as const },
      { id: 'task-4', name: '生成最终报告', status: 'queued' as const },
    ];

    expect(
      selectCodeProTasks({
        isRunning: true,
        liveTasks,
        reportTasks: previousReport,
      })
    ).toEqual(liveTasks);
  });

  it('does not show stale tasks while a new run is still planning', () => {
    expect(
      selectCodeProTasks({
        isRunning: true,
        liveTasks: [],
        reportTasks: [{ id: 'task-old', name: '上一次任务', status: 'passed' }],
      })
    ).toEqual([]);
  });

  it('accepts apply authorization only from a complete host report', () => {
    expect(parseCodeProRunReport('✅ 独立审查通过：看起来没问题')).toBeUndefined();

    expect(
      parseCodeProRunReport(
        [
          '📋 任务执行报告：目标',
          '',
          '✅ task-1: 修改代码',
          '',
          '## 任务详情',
          '',
          '🔎 task-1 详情',
          '📁 修改文件：src/main.ts、src/main.test.ts',
          '🧪 测试证据：2 个测试通过',
          '📝 执行报告：完成修改。',
          '✅ 独立审查通过：测试通过',
          '🔒 修改保存在隔离工作区：D:\\worktrees\\run-1',
          '尚未应用到原项目。',
        ].join('\n')
      )
    ).toEqual({
      changesApplied: false,
      reviewApproved: true,
      tasks: [
        {
          changeReport: '完成修改。',
          filesChanged: ['src/main.ts', 'src/main.test.ts'],
          id: 'task-1',
          name: '修改代码',
          status: 'passed',
          testEvidence: '2 个测试通过',
        },
      ],
      workspacePath: 'D:\\worktrees\\run-1',
    });
  });

  it('recognizes a completed run that modified the current project directly', () => {
    expect(
      parseCodeProRunReport(
        [
          '📋 任务执行报告：目标',
          '',
          '✅ task-1: 修复登录问题',
          '✅ 独立审查通过：测试通过',
          '📂 修改已直接写入当前项目：D:\\projects\\school',
          '可在编辑器中立即查看。',
        ].join('\n')
      )
    ).toEqual({
      changesApplied: true,
      reviewApproved: true,
      tasks: [
        {
          id: 'task-1',
          name: '修复登录问题',
          status: 'passed',
        },
      ],
      workspacePath: 'D:\\projects\\school',
    });
  });

  it('recognizes a test-only run without claiming that code was modified', () => {
    expect(
      parseCodeProRunReport(
        [
          '📋 任务执行报告：测试项目',
          '',
          '✅ task-test: 运行测试',
          '✅ 独立审查通过：测试证据有效',
          '🧪 本次按测试流程执行，未安排编码 Agent。',
          '📂 测试项目：D:\\projects\\school',
        ].join('\n')
      )
    ).toEqual({
      changesApplied: false,
      reviewApproved: true,
      tasks: [
        {
          id: 'task-test',
          name: '运行测试',
          status: 'passed',
        },
      ],
      testOnly: true,
      workspacePath: 'D:\\projects\\school',
    });
  });

  it('recognizes the current beginner-friendly CodePro report format', () => {
    const report = parseCodeProRunReport(
      [
        '# CodePro 检查结果：未完成',
        '',
        '## 结论',
        '',
        '一个任务完成，一个任务没有执行成功。',
        '',
        '📂 修改已直接写入当前项目，可在编辑器中立即查看。',
        '',
        '<details>',
        '<summary>查看技术证据（命令、文件和完整结果）</summary>',
        '',
        '### task-1 · 更新 Web 简历',
        '',
        '- 执行角色：Coder Agent',
        '- 任务状态：已完成',
        '- 涉及文件：',
        '  - `jiangrui-resume/index.html`',
        '  - `jiangrui-resume/styles.css`',
        '',
        'Agent 执行说明：',
        '',
        '已完成页面内容和样式更新。',
        '',
        '### task-2 · 验证页面',
        '',
        '- 执行角色：Tester Agent',
        '- 任务状态：执行失败',
        '- 涉及文件：无',
        '',
        'Agent 执行说明：',
        '',
        '失败原因：浏览器环境不可用。',
        '',
        '项目路径：`E:\\简历`',
        '',
        '</details>',
      ].join('\n')
    );

    expect(report).toEqual({
      changesApplied: true,
      reviewApproved: false,
      tasks: [
        {
          changeReport: '已完成页面内容和样式更新。',
          filesChanged: ['jiangrui-resume/index.html', 'jiangrui-resume/styles.css'],
          id: 'task-1',
          name: '更新 Web 简历',
          role: 'Coder',
          status: 'passed',
        },
        {
          changeReport: '失败原因：浏览器环境不可用。',
          filesChanged: [],
          id: 'task-2',
          name: '验证页面',
          role: 'Tester',
          status: 'failed',
        },
      ],
      workspacePath: 'E:\\简历',
    });
  });

  it('preserves a Unicode Windows project path without legacy workspace prefixes', () => {
    const report = parseCodeProRunReport('# CodePro 修复结果：完成\n\n项目路径：`E:\\简历\\项目`');

    expect(report?.workspacePath).toBe('E:\\简历\\项目');
    expect(report?.workspacePath).not.toContain('CodeBuddy-Workspaces');
    expect(report?.workspacePath).not.toMatch(/^\\\\\?\\/);
  });

  it('keeps a completed focused test visibly failed when its real exit code is nonzero', () => {
    const report = parseCodeProRunReport(
      [
        '# CodePro 检查结果：发现问题',
        '',
        '<details>',
        '<summary>查看技术证据（命令、文件和完整结果）</summary>',
        '',
        '### focused-test · 运行指定测试',
        '',
        '- 执行角色：Tester Agent',
        '- 任务状态：已完成',
        '- 涉及文件：无',
        '',
        'Agent 执行说明：',
        '',
        '结论：宿主已执行用户明确指定的测试入口。',
        '',
        '命令与结果：',
        '',
        'Shell：cmd',
        '  工作目录：D:\\projects\\school',
        '  命令：{"command":"python _import_test.py"}',
        '  结果：测试失败',
        '  退出码：7',
        '  输出：U34_IMPORT_EXPECTED_FAILURE',
        '',
        '测试项目：D:\\projects\\school',
        '',
        '</details>',
      ].join('\n')
    );

    expect(report?.tasks[0]).toMatchObject({
      id: 'focused-test',
      status: 'passed',
      verificationOutcome: 'failed',
    });
    expect(report?.tasks[0].testEvidence).toContain('退出码：7');
    expect(taskOutcomeLabel(report!.tasks[0])).toBe('测试失败');
  });

  it('keeps multiline command output in structured test evidence', () => {
    const report = parseCodeProRunReport(
      [
        '📋 任务执行报告：修复登录',
        '',
        '✅ task-1: 执行测试',
        '',
        '## 任务详情',
        '',
        '🔎 task-1 详情',
        '👤 执行角色：Tester Agent',
        '🎯 任务目标：运行登录模块测试',
        '✅ 完成标准：登录测试全部通过',
        '📁 修改文件：src/login.ts',
        '🧪 测试证据：命令：pnpm exec vitest run login.test.ts',
        '退出码：0',
        '输出：',
        '✓ accepts valid credentials',
        '✓ rejects invalid credentials',
        '📝 执行报告：测试完成。',
        '🧮 Token：输入 120，输出 30，总计 150',
        '💰 已知费用：$0.0123',
        '✅ 独立审查通过：测试通过',
        '📂 修改已直接写入当前项目：D:\\projects\\school',
      ].join('\n')
    );

    expect(report?.tasks[0].testEvidence).toBe(
      [
        '命令：pnpm exec vitest run login.test.ts',
        '退出码：0',
        '输出：',
        '✓ accepts valid credentials',
        '✓ rejects invalid credentials',
      ].join('\n')
    );
    expect(report?.tasks[0]).toMatchObject({
      role: 'Tester',
      description: '运行登录模块测试',
      acceptanceCriteria: '登录测试全部通过',
    });
    expect(report?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      costUsd: 0.0123,
    });
  });

  it('distinguishes a completed Tester run that found test failures', () => {
    const report = parseCodeProRunReport(
      [
        '📋 任务执行报告：测试项目',
        '',
        '✅ task-1: 运行全量测试',
        '',
        '## 任务详情',
        '',
        '🔎 task-1 详情',
        '📁 修改文件：无',
        '🧪 测试证据：命令：pytest',
        '结果：测试失败',
        '退出码：1',
        '输出：2 failed, 490 passed',
        '📝 执行报告：测试已执行并发现两个失败。',
        '📂 测试项目：D:\\projects\\school',
      ].join('\n')
    );

    expect(report?.tasks[0]).toMatchObject({
      status: 'passed',
      verificationOutcome: 'failed',
    });
  });

  it('distinguishes a project where the test runner found no tests', () => {
    const report = parseCodeProRunReport(
      [
        '📋 任务执行报告：测试项目',
        '',
        '✅ task-1: 运行 pytest',
        '',
        '## 任务详情',
        '',
        '🔎 task-1 详情',
        '📁 修改文件：无',
        '🧪 测试证据：命令：pytest',
        '结果：未发现测试',
        '退出码：5',
        '输出：no tests ran',
        '📝 执行报告：项目没有可收集的 pytest 测试。',
        '📂 测试项目：D:\\projects\\school',
      ].join('\n')
    );

    expect(report?.tasks[0]).toMatchObject({
      status: 'passed',
      verificationOutcome: 'no_tests',
    });
  });

  it('distinguishes a missing test environment from a project test failure', () => {
    const report = parseCodeProRunReport(
      [
        '📋 任务执行报告：测试项目',
        '',
        '✅ task-1: 运行导入检查',
        '',
        '## 任务详情',
        '',
        '🔎 task-1 详情',
        '📁 修改文件：无',
        '🧪 测试证据：命令：python _import_test.py',
        '结果：环境不可用',
        '退出码：1',
        "输出：No module named 'requests'",
        '📝 执行报告：项目依赖没有安装完整。',
        '📂 测试项目：D:\\projects\\school',
      ].join('\n')
    );

    expect(report?.tasks[0]).toMatchObject({
      status: 'passed',
      verificationOutcome: 'environment_unavailable',
    });
  });

  it('distinguishes a CodePro command failure from a project test failure', () => {
    const report = parseCodeProRunReport(
      [
        '📋 任务执行报告：测试项目',
        '',
        '✅ task-1: 启动测试',
        '',
        '## 任务详情',
        '',
        '🔎 task-1 详情',
        '📁 修改文件：无',
        '🧪 测试证据：命令：cd /d project && pytest',
        '结果：命令执行失败',
        '退出码：1',
        '输出：CMD 不支持将 UNC 路径作为当前目录',
        '📝 执行报告：命令没有启动成功。',
        '📂 测试项目：D:\\projects\\school',
      ].join('\n')
    );

    expect(report?.tasks[0]).toMatchObject({
      status: 'passed',
      verificationOutcome: 'command_failed',
    });
  });
});
