import { describe, expect, it, vi } from 'vitest';
import type { ActivityEvent } from '../../types/activityEvent';
import {
  collectCodeProTaskFiles,
  focusCodeProTaskActivity,
  parseCodeProRunReport,
  summarizeCodeProTasks,
  summarizeTaskDetail,
  type TaskCardData,
} from './codeProTaskPanelModel';

describe('parseCodeProRunReport report contract', () => {
  it.each(['分析报告', '测试报告', '修复报告'])(
    'recognizes the current CodePro %s title without requiring a project path',
    (title) => {
      const report = parseCodeProRunReport(`# CodePro ${title}\n\n## 结论\n\n完成。`);

      expect(report).toBeDefined();
      expect(report?.workspacePath).toBeUndefined();
    }
  );

  it.each(['检查结果：完成', '修复结果：完成'])('recognizes the CodePro %s title', (title) => {
    const report = parseCodeProRunReport(`# CodePro ${title}\n\n项目路径：\`D:\\project\``);

    expect(report?.workspacePath).toBe('D:\\project');
  });
});

function activity(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schema_version: 1,
    event_id: 'read-1',
    event_type: 'file_read',
    session_id: 'session-1',
    run_id: 'run-1',
    task_id: 'task-1',
    parent_task_id: null,
    agent_role: 'coder',
    effective_model: 'provider/model',
    status: 'completed',
    started_at: '2026-08-02T08:00:00.000Z',
    finished_at: '2026-08-02T08:00:01.000Z',
    title: '已读取文件',
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

function activityMessage(event: ActivityEvent) {
  return {
    role: 'assistant',
    content: [
      {
        type: 'systemNotification',
        notificationType: 'codeProActivity',
        msg: `CodePro · ${event.title}`,
        data: event,
      },
    ],
  };
}

describe('summarizeCodeProTasks', () => {
  it('summarizes mixed terminal tasks without counting skipped work as passed', () => {
    const tasks: TaskCardData[] = [
      { id: 'task-1', name: '修改代码', role: 'Coder', status: 'passed' },
      { id: 'task-2', name: '运行测试', role: 'Tester', status: 'failed' },
      { id: 'task-3', name: '独立审查', role: 'Reviewer', status: 'skipped' },
    ];

    expect(summarizeCodeProTasks(tasks)).toEqual({
      completedCount: 1,
      currentTask: undefined,
      status: 'failed',
      statusLabel: '存在失败',
      totalCount: 3,
    });
  });

  it('reports the running task and role as the current work', () => {
    const tasks: TaskCardData[] = [
      { id: 'task-1', name: '读取项目', status: 'passed' },
      { id: 'task-2', name: '修改代码', role: 'Coder', status: 'running' },
      { id: 'task-3', name: '运行测试', status: 'queued' },
    ];

    expect(summarizeCodeProTasks(tasks)).toEqual({
      completedCount: 1,
      currentTask: tasks[1],
      status: 'running',
      statusLabel: '运行中',
      totalCount: 3,
    });
  });
});

describe('summarizeTaskDetail', () => {
  it('returns a single bounded line instead of exposing a full report', () => {
    const summary = summarizeTaskDetail({
      id: 'task-1',
      name: '测试',
      status: 'failed',
      testEvidence: `第一行结果\n${'很长的输出'.repeat(80)}`,
    });

    expect(summary).toBe('第一行结果');
    expect(summary).not.toContain('\n');
  });
});

describe('collectCodeProTaskFiles', () => {
  it('collects current-turn reads and changes without duplicating lifecycle events', () => {
    const files = collectCodeProTaskFiles([
      activityMessage(activity({ event_id: 'old-read', path: 'D:\\old.txt' })),
      { role: 'user', content: [{ type: 'text', text: '检查当前项目' }] },
      activityMessage(activity({ status: 'running', finished_at: null })),
      activityMessage(activity({ path: null })),
      activityMessage(
        activity({
          event_id: 'change-1',
          event_type: 'file_changed',
          path: 'D:\\project\\src\\app.ts',
        })
      ),
    ]);

    expect(files).toEqual([
      { eventId: 'read-1', kind: 'read', path: 'D:\\project\\README.md', taskId: 'task-1' },
      {
        eventId: 'change-1',
        kind: 'changed',
        path: 'D:\\project\\src\\app.ts',
        taskId: 'task-1',
      },
    ]);
  });
});

describe('focusCodeProTaskActivity', () => {
  it('matches task ids as data instead of interpolating them into a selector', () => {
    const root = document.createElement('div');
    const activity = document.createElement('section');
    const button = document.createElement('button');
    const taskId = 'task-"] [data-codepro-task-id="other';
    activity.dataset.codeproTaskId = taskId;
    activity.append(button);
    root.append(activity);
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    activity.scrollIntoView = scrollIntoView;
    button.focus = focus;

    expect(focusCodeProTaskActivity(taskId, root)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(focus).toHaveBeenCalled();
  });

  it('returns false when the task has no structured activity', () => {
    expect(focusCodeProTaskActivity('missing', document.createElement('div'))).toBe(false);
  });

  it('limits navigation to the active session when task ids repeat', () => {
    const root = document.createElement('div');
    const oldSession = document.createElement('section');
    const currentSession = document.createElement('section');
    oldSession.dataset.sessionId = 'session-old';
    currentSession.dataset.sessionId = 'session-current';
    const oldActivity = document.createElement('div');
    const currentActivity = document.createElement('div');
    oldActivity.dataset.codeproTaskId = 'task-1';
    currentActivity.dataset.codeproTaskId = 'task-1';
    oldActivity.scrollIntoView = vi.fn();
    currentActivity.scrollIntoView = vi.fn();
    oldSession.append(oldActivity);
    currentSession.append(currentActivity);
    root.append(oldSession, currentSession);

    expect(focusCodeProTaskActivity('task-1', root, 'session-current')).toBe(true);
    expect(oldActivity.scrollIntoView).not.toHaveBeenCalled();
    expect(currentActivity.scrollIntoView).toHaveBeenCalled();
  });
});
