import { act, render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import { ChatState } from '../types/chatState';
import LoadingGoose, {
  getLoadingIndicatorPresentation,
  isCheckingExecutionResults,
} from './LoadingGoose';

function renderLoadingIndicator(chatState: ChatState, assistantName?: 'Code' | 'CodePro') {
  return render(
    <IntlProvider
      locale="zh-CN"
      messages={{
        'loadingGoose.thinking': 'CodeBuddy 正在处理中…',
        'loadingGoose.streaming': 'CodeBuddy 正在处理中…',
        'loadingGoose.compacting': 'CodeBuddy 正在压缩对话…',
      }}
    >
      <LoadingGoose chatState={chatState} assistantName={assistantName} />
    </IntlProvider>
  );
}

describe('LoadingGoose', () => {
  it('shows elapsed compaction and a long-wait explanation without a fabricated percentage', () => {
    vi.useFakeTimers();
    try {
      const view = render(<IntlProvider locale="en"><LoadingGoose chatState={ChatState.Compacting}
        compactionLifecycle={{schemaVersion:1,event:'compaction_lifecycle',operationId:'test',status:'started',trigger:'manual',startedAt:new Date().toISOString()}} /></IntlProvider>);
      expect(screen.getByText('Generating a continuation summary. Original messages remain in this conversation.')).toBeVisible();
      act(() => vi.advanceTimersByTime(31000));
      expect(screen.getByText(/Still waiting for the model/)).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent('31s');
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      view.unmount();
    } finally {vi.useRealTimers();}
  });
  it('updates visual elapsed time without repeating it in the live announcement', () => {
    vi.useFakeTimers();
    try {
      const view = render(
        <IntlProvider
          locale="zh-CN"
          messages={{
            'loadingGoose.thinking': '正在处理中',
            'loadingGoose.elapsed': '{message} · 已用 {seconds} 秒',
          }}
        >
          <LoadingGoose chatState={ChatState.Thinking} message="正在读取文件" showElapsed />
        </IntlProvider>
      );
      act(() => vi.advanceTimersByTime(3000));
      const status = screen.getByRole('status');
      expect(status.querySelector('span[aria-hidden="true"]')).toHaveTextContent('已用 3 秒');
      expect(status.querySelector('.sr-only')).toHaveTextContent('正在读取文件');
      expect(status.querySelector('.sr-only')).not.toHaveTextContent('秒');
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the latest CodePro progress headline visible while details render as activities', () => {
    expect(
      getLoadingIndicatorPresentation(
        '/codepro/pair',
        'CodePro · 正在执行任务\n⏳ task-1: 分析项目'
      )
    ).toEqual({
      assistantName: 'CodePro',
      message: 'CodePro · 正在执行任务',
    });
  });

  it('keeps detailed progress messages in the ordinary Code workspace', () => {
    expect(getLoadingIndicatorPresentation('/pair', '正在读取文件')).toEqual({
      assistantName: 'Code',
      message: '正在读取文件',
    });
  });

  it('announces CodePro processing with the active workspace identity', () => {
    renderLoadingIndicator(ChatState.Streaming, 'CodePro');

    expect(screen.getByRole('status')).toHaveTextContent('CodePro 正在处理中…');
  });

  it('uses the Code identity outside CodePro', () => {
    renderLoadingIndicator(ChatState.Streaming);

    expect(screen.getByRole('status')).toHaveTextContent('Code 正在处理中…');
  });

  it('announces compaction with the CodePro identity', () => {
    renderLoadingIndicator(ChatState.Compacting, 'CodePro');

    expect(screen.getByRole('status')).toHaveTextContent('CodePro 正在压缩对话…');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('host completion progress', () => {
  it.each(['Checking execution results…', '正在核验执行结果…', '正在核驗執行結果…'])(
    'recognizes the host notice %s',
    (message) => {
      expect(isCheckingExecutionResults(message)).toBe(true);
    }
  );
  it.each([undefined, '', '模型说：正在核验执行结果…', '已完成'])(
    'does not infer completion from other text %s',
    (message) => {
      expect(isCheckingExecutionResults(message)).toBe(false);
    }
  );
});
