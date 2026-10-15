import { act, fireEvent, render as testingRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { ChatState } from '../../types/chatState';
import {
  CodeProProgress,
  isCodeProProgressPath,
  shouldShowFloatingProgress,
} from './CodeProProgress';

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

describe('CodeProProgress', () => {
  const progressMessage = [
    'CodePro · 正在执行任务',
    '✅ task-1: 分析项目结构',
    '🔄 task-2: 修复登录逻辑',
    '❌ task-3: 运行边界测试',
  ].join('\n');

  it('renders a scannable execution timeline instead of the raw progress string', () => {
    render(<CodeProProgress chatState={ChatState.Thinking} message={progressMessage} />);

    expect(screen.getByRole('button', { name: 'Collapse work process' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Work process')).toBeInTheDocument();
    expect(screen.getByText('正在执行任务')).toBeInTheDocument();
    expect(screen.getByText('1 / 3 completed')).toBeInTheDocument();
    expect(screen.getByText('分析项目结构')).toBeInTheDocument();
    expect(screen.getByText('修复登录逻辑')).toBeInTheDocument();
    expect(screen.getByText('运行边界测试')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Not completed')).toBeInTheDocument();
    expect(screen.queryByText('task-1')).not.toBeInTheDocument();
    expect(screen.queryByText('task-2')).not.toBeInTheDocument();
    expect(screen.queryByText('task-3')).not.toBeInTheDocument();
    expect(screen.queryByText(progressMessage)).not.toBeInTheDocument();
  });

  it('collapses task details into a compact live summary', () => {
    render(<CodeProProgress chatState={ChatState.Streaming} message={progressMessage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse work process' }));

    expect(screen.getByRole('button', { name: 'Expand work process' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('分析项目结构')).not.toBeInTheDocument();
    expect(screen.getByText('1 / 3 completed')).toBeInTheDocument();
  });

  it('collapses automatically while user action is required so approval controls stay reachable', () => {
    render(<CodeProProgress chatState={ChatState.WaitingForUserInput} message={progressMessage} />);

    expect(screen.getByRole('button', { name: 'Expand work process' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('分析项目结构')).not.toBeInTheDocument();
  });

  it('keeps the latest task snapshot visible while a tool call clears the message', () => {
    const { rerender } = render(
      <CodeProProgress chatState={ChatState.Thinking} message={progressMessage} />
    );

    rerender(<CodeProProgress chatState={ChatState.Streaming} message={undefined} />);

    expect(screen.getByText('分析项目结构')).toBeInTheDocument();
    expect(screen.getByText('正在执行任务')).toBeInTheDocument();
    expect(screen.getByText('1 / 3 completed')).toBeInTheDocument();
  });

  it('falls back to a calm status when planning has not produced tasks yet', () => {
    render(<CodeProProgress chatState={ChatState.Thinking} message="CodePro · 正在规划任务" />);

    expect(screen.getByText('正在规划任务')).toBeInTheDocument();
    expect(screen.getByText('Understanding the project and splitting tasks…')).toBeInTheDocument();
  });

  it('shows the public work summary carried by progress updates instead of looking frozen', () => {
    const planningMessage = [
      'CodePro · 正在分析项目和用户目标',
      '当前阶段：准备协作任务',
      '说明：正在读取项目结构并确定测试入口。',
      '下一步：生成任务清单并开始执行。',
    ].join('\n');

    render(<CodeProProgress chatState={ChatState.Thinking} message={planningMessage} />);

    expect(screen.getByText('当前阶段：准备协作任务')).toBeVisible();
    expect(screen.getByText('说明：正在读取项目结构并确定测试入口。')).toBeVisible();
    expect(screen.getByText('下一步：生成任务清单并开始执行。')).toBeVisible();
  });

  it('keeps internal routing codes out of the public work summary', () => {
    const planningMessage = [
      'CodePro · 正在分析项目和用户目标',
      '当前阶段：准备协作任务',
      '说明：正在确认执行范围。',
      'shadow → shadow',
      'not_required · durable host controls execution',
      'event #42',
    ].join('\n');

    render(<CodeProProgress chatState={ChatState.Thinking} message={planningMessage} />);

    expect(screen.getByText('当前阶段：准备协作任务')).toBeVisible();
    expect(screen.getByText('说明：正在确认执行范围。')).toBeVisible();
    expect(screen.queryByText(/shadow/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not_required/)).not.toBeInTheDocument();
    expect(screen.queryByText(/event #42/)).not.toBeInTheDocument();
  });

  it('keeps a changing elapsed timer visible so long analysis does not look frozen', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T05:00:00Z'));

    render(<CodeProProgress chatState={ChatState.Thinking} message="CodePro · 正在分析项目" />);

    expect(screen.getByText('Elapsed 0:00')).toBeVisible();
    act(() => vi.advanceTimersByTime(65_000));
    expect(screen.getByText('Elapsed 1:05')).toBeVisible();
  });

  it('is enabled only inside the CodePro workspace', () => {
    expect(isCodeProProgressPath('/codepro/pair')).toBe(true);
    expect(isCodeProProgressPath('/codepro')).toBe(true);
    expect(isCodeProProgressPath('/pair')).toBe(false);
  });

  it('shows the floating thinking status in active chats', () => {
    expect(shouldShowFloatingProgress('/codepro/pair')).toBe(true);
    expect(shouldShowFloatingProgress('/codepro')).toBe(false);
    expect(shouldShowFloatingProgress('/pair')).toBe(true);
    expect(shouldShowFloatingProgress('/settings')).toBe(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
