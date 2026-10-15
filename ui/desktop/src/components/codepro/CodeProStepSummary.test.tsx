import { fireEvent, render as testingRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { CodeProStepSummaryView, useRetainedCodeProTasks } from './CodeProStepSummary';

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

function RetainedTasksHarness({
  isRunning,
  progressMessage,
}: {
  isRunning: boolean;
  progressMessage?: string;
}) {
  const tasks = useRetainedCodeProTasks({
    isRunning,
    progressMessage,
    sessionId: 'session-1',
  });

  return <div>{tasks.map((task) => task.name).join('、')}</div>;
}

describe('CodeProStepSummaryView', () => {
  it('does not show a progress pill while no task is running', () => {
    render(
      <CodeProStepSummaryView
        fileCount={1}
        isRunning={false}
        tasks={[
          { id: 'task-1', name: '实现功能', status: 'passed' },
          { id: 'task-2', name: '运行测试', status: 'passed' },
        ]}
      />
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('removes the progress entry as soon as a run finishes', () => {
    const tasks = [{ id: 'task-1', name: '运行测试', status: 'running' as const }];
    const { rerender } = render(<CodeProStepSummaryView fileCount={0} isRunning tasks={tasks} />);

    fireEvent.click(screen.getByRole('button', { name: /0 \/ 1 steps/ }));
    expect(screen.getByRole('list', { name: 'CodePro execution steps' })).toBeVisible();

    rerender(
      <CodeProStepSummaryView
        fileCount={0}
        isRunning={false}
        tasks={[{ ...tasks[0], status: 'passed' }]}
      />
    );

    expect(screen.queryByRole('list', { name: 'CodePro execution steps' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows compact progress above the input and expands into individual steps', () => {
    render(
      <CodeProStepSummaryView
        fileCount={2}
        isRunning
        tasks={[
          { id: 'task-1', name: '分析测试范围', status: 'passed' },
          { id: 'task-2', name: '运行单元测试', status: 'running' },
          { id: 'task-3', name: '独立审查结果', status: 'queued' },
        ]}
      />
    );

    const trigger = screen.getByRole('button', { name: /1 \/ 3 steps/ });
    expect(trigger).toHaveTextContent('运行单元测试');
    expect(trigger).toHaveTextContent('2 files changed');

    fireEvent.click(trigger);
    expect(screen.getByRole('list', { name: 'CodePro execution steps' })).toBeVisible();
    expect(screen.getByText('分析测试范围')).toBeVisible();
    expect(screen.getByText('独立审查结果')).toBeVisible();
  });

  it('updates the current task name when the running task changes', () => {
    const { rerender } = render(
      <CodeProStepSummaryView
        fileCount={0}
        isRunning
        tasks={[
          { id: 'task-1', name: '分析测试范围', status: 'passed' },
          { id: 'task-2', name: '运行单元测试', status: 'running' },
          { id: 'task-3', name: '独立审查结果', status: 'queued' },
        ]}
      />
    );
    expect(screen.getByRole('button', { name: /1 \/ 3 steps/ })).toHaveTextContent('运行单元测试');

    rerender(
      <CodeProStepSummaryView
        fileCount={0}
        isRunning
        tasks={[
          { id: 'task-1', name: '分析测试范围', status: 'passed' },
          { id: 'task-2', name: '运行单元测试', status: 'passed' },
          { id: 'task-3', name: '独立审查结果', status: 'running' },
        ]}
      />
    );
    expect(screen.getByRole('button', { name: /2 \/ 3 steps/ })).toHaveTextContent('独立审查结果');
  });

  it('shows Stopped immediately when the run is interrupted with incomplete tasks', () => {
    render(
      <CodeProStepSummaryView
        fileCount={0}
        isRunning={false}
        tasks={[
          { id: 'task-1', name: '分析测试范围', status: 'passed' },
          { id: 'task-2', name: '运行单元测试', status: 'running' },
          { id: 'task-3', name: '独立审查结果', status: 'queued' },
        ]}
      />
    );

    const trigger = screen.getByRole('button', { name: /1 \/ 3 steps/ });
    expect(trigger).toHaveTextContent('Stopped');
  });

  it('hides the pill when the run completes without incomplete tasks', () => {
    render(
      <CodeProStepSummaryView
        fileCount={0}
        isRunning={false}
        tasks={[
          { id: 'task-1', name: '分析测试范围', status: 'passed' },
          { id: 'task-2', name: '运行单元测试', status: 'passed' },
        ]}
      />
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('useRetainedCodeProTasks', () => {
  it('keeps the current steps when a later status message no longer contains the task snapshot', () => {
    const { rerender } = render(
      <RetainedTasksHarness
        isRunning
        progressMessage={[
          'CodePro · 正在执行任务',
          '--- CodePro 任务快照 ---',
          '✅ task-1: 分析简历',
          '⏳ task-2: 更新网页',
        ].join('\n')}
      />
    );

    expect(screen.getByText('分析简历、更新网页')).toBeVisible();

    rerender(<RetainedTasksHarness isRunning progressMessage="CodePro · 分析完成，正在整理结果" />);

    expect(screen.getByText('分析简历、更新网页')).toBeVisible();
  });

  it('does not leak retained steps into a new run that is still planning', () => {
    const { rerender } = render(
      <RetainedTasksHarness
        isRunning
        progressMessage="--- CodePro 任务快照 ---\n⏳ task-old: 上一轮任务"
      />
    );

    rerender(<RetainedTasksHarness isRunning={false} progressMessage={undefined} />);
    rerender(<RetainedTasksHarness isRunning progressMessage="CodePro · 正在理解你的需求" />);

    expect(screen.queryByText('上一轮任务')).not.toBeInTheDocument();
  });
});
