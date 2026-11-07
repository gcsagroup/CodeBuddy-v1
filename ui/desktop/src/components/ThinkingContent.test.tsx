import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThinkingContent from './ThinkingContent';
import { ScrollLayoutAnchorContext } from './ui/scroll-follow-context';

vi.mock('../i18n', () => ({
  defineMessages: <T,>(messages: T) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

describe('ThinkingContent', () => {
  beforeEach(() => {
    localStorage.clear();
    window.sessionStorage.clear();
  });

  it('keeps a sticky thought heading in its process viewport when manually folded', () => {
    const release = vi.fn();
    const hold = vi.fn(() => release);
    const view = render(
      <ScrollLayoutAnchorContext.Provider value={hold}>
        <div className="codepro-process-details">
          <ThinkingContent content="A long thought." isExpanded />
        </div>
      </ScrollLayoutAnchorContext.Provider>
    );
    const viewport = view.container.firstElementChild as HTMLElement;
    const toggle = screen.getByRole('button', { name: 'Thinking' });
    viewport.scrollTop = 300;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 50 } as DOMRect);
    vi.spyOn(toggle, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: toggle.getAttribute('aria-expanded') === 'true' ? 50 : 50 + 260 - viewport.scrollTop,
        }) as DOMRect
    );
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(viewport.scrollTop).toBe(260);
    expect(toggle.getBoundingClientRect().top).toBe(50);
    expect(hold).toHaveBeenCalledWith(toggle);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(viewport.scrollTop).toBe(260);
  });

  it('shows a plain single-line preview only while folded and keeps the original Markdown body', () => {
    const content = '\n\n**Inspect the files**\n\nThen verify the saved result.';
    const view = render(<ThinkingContent content={content} isExpanded={false} />);
    const toggle = screen.getByRole('button', { name: 'Thinking' });
    expect(toggle).toHaveTextContent('Inspect the files');
    expect(toggle).not.toHaveTextContent('**');
    expect(toggle).not.toHaveTextContent('·');
    expect(view.container.querySelector('.codepro-thinking-details')).toBeNull();
    fireEvent.click(toggle);
    expect(view.container.querySelector('.codepro-thinking-preview')).toBeNull();
    expect(view.container.querySelector('.codepro-thinking-details strong')).toHaveTextContent(
      'Inspect the files'
    );
    expect(screen.getByText('Then verify the saved result.')).toBeVisible();
  });

  it('previews the first partial line, advances at paragraph first-line boundaries and settles on the opening line', () => {
    const view = render(
      <ThinkingContent content="**Starting the review**" isExpanded={false} isStreaming />
    );
    const toggle = screen.getByRole('button', { name: 'Thinking (updating)' });
    expect(toggle).toHaveTextContent('Starting the review');
    const first = '**Inspecting files**\r\nRead the files.\r\n\r\nChecking the results';
    view.rerender(<ThinkingContent content={first} isExpanded={false} isStreaming />);
    expect(toggle).toHaveTextContent('Inspecting files');
    expect(toggle).not.toHaveTextContent('Checking the results');
    const next = `${first}\r\nCompare the output.`;
    view.rerender(<ThinkingContent content={next} isExpanded={false} isStreaming />);
    expect(toggle).toHaveTextContent('Checking the results');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    view.rerender(<ThinkingContent content={next} isExpanded={false} />);
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveTextContent('Inspecting files');
  });

  it('keeps long live thoughts complete and formatted without per-word animation nodes', () => {
    const content = Array.from(
      { length: 90 },
      (_, index) => `检查第 ${index + 1} 项：**保留格式**，继续核查已经收到的结果。`
    ).join('\n\n');
    const view = render(<ThinkingContent content={content} isExpanded isStreaming />);
    const viewport = view.container.querySelector('.codepro-thinking-details')!;
    expect(viewport.className).not.toMatch(/max-h-|overflow-y-auto|overflow-y-scroll/);
    const first = viewport.querySelector('p');
    expect(viewport.querySelectorAll('p')).toHaveLength(90);
    expect(viewport.querySelectorAll('strong')).toHaveLength(90);
    expect(viewport.querySelectorAll('.codepro-incoming-word')).toHaveLength(0);

    view.rerender(
      <ThinkingContent content={`${content}\n\n新片段已经到达。`} isExpanded isStreaming />
    );
    expect(viewport.querySelector('p')).toBe(first);
    expect(viewport).toHaveTextContent('检查第 1 项：保留格式');
    expect(viewport).toHaveTextContent('检查第 90 项：保留格式');
    expect(viewport).toHaveTextContent('新片段已经到达。');
    expect(viewport.querySelectorAll('.codepro-incoming-word')).toHaveLength(0);
  });

  it('does not scroll the thought body when its content updates', () => {
    const view = render(<ThinkingContent content="First" isExpanded isStreaming />);
    const viewport = screen
      .getByText('First')
      .closest('.codepro-operation-details') as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { value: 200 },
    });
    view.rerender(<ThinkingContent content="Second" isExpanded isStreaming />);
    expect(viewport.scrollTop).toBe(0);
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    view.rerender(<ThinkingContent content="Third" isExpanded isStreaming />);
    expect(viewport.scrollTop).toBe(100);
    expect(screen.queryByRole('button', { name: 'Back to latest' })).not.toBeInTheDocument();
    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    view.rerender(<ThinkingContent content="Fourth" isExpanded isStreaming />);
    expect(viewport.scrollTop).toBe(700);
  });

  it('folds a quiet live thought without waiting for a complete tool call, but protects a reader', () => {
    vi.useFakeTimers();
    try {
      const view = render(<ThinkingContent content="Preparing a file." isExpanded isStreaming />);
      act(() => vi.advanceTimersByTime(2500));
      expect(screen.getByRole('button', { name: 'Thinking (updating)' })).toHaveAttribute(
        'data-state',
        'closed'
      );
      view.rerender(<ThinkingContent content="More thought arrived." isExpanded isStreaming />);
      expect(screen.getByRole('button', { name: 'Thinking (updating)' })).toHaveAttribute(
        'data-state',
        'open'
      );
      const viewport = view.container.querySelector('.codepro-thinking-details') as HTMLDivElement;
      fireEvent.pointerDown(viewport);
      act(() => vi.advanceTimersByTime(2500));
      expect(screen.getByRole('button', { name: 'Thinking (updating)' })).toHaveAttribute(
        'data-state',
        'open'
      );
      view.rerender(<ThinkingContent content="More thought arrived." isExpanded={false} />);
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
        'data-state',
        'open'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels the safe model-provided summary as thinking', () => {
    render(<ThinkingContent content="I will inspect the requested file first." isExpanded />);

    expect(screen.getByText('Thinking')).toBeVisible();
    expect(screen.queryByText('Reasoning summary')).not.toBeInTheDocument();
    expect(screen.getByText('I will inspect the requested file first.')).toBeVisible();
  });

  it('shows live state and replaces the visible decision as thinking progresses', async () => {
    const view = render(
      <ThinkingContent
        content={'1. Identifying the goal.\n2. Choosing the smallest action.'}
        isExpanded
        isStreaming
      />
    );

    expect(screen.getByRole('button', { name: 'Thinking (updating)' })).toHaveAttribute(
      'data-state',
      'open'
    );
    expect(view.container.querySelector('.codepro-thinking-details')).toHaveTextContent(
      'Identifying the goal'
    );

    view.rerender(
      <ThinkingContent
        content={'1. Goal identified.\n2. No tool is needed.\n3. Reply directly.'}
        isExpanded={false}
      />
    );

    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
      'data-state',
      'closed'
    );
    expect(screen.queryByText(/Identifying the goal/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reply directly/)).not.toBeInTheDocument();
  });

  it('keeps the user fold preference during updates and after remounting', () => {
    const view = render(
      <ThinkingContent
        content="Inspecting the project structure."
        isExpanded
        isStreaming
        storageKey="turn-1"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Thinking (updating)' }));
    expect(screen.getByRole('button', { name: 'Thinking (updating)' })).toHaveAttribute(
      'data-state',
      'closed'
    );

    view.rerender(
      <ThinkingContent
        content="Reading package.json next."
        isExpanded
        isStreaming
        storageKey="turn-1"
      />
    );
    expect(screen.getByRole('button', { name: 'Thinking (updating)' })).toHaveAttribute(
      'data-state',
      'closed'
    );

    view.unmount();
    render(
      <ThinkingContent
        content="Reading package.json next."
        isExpanded
        isStreaming
        storageKey="turn-1"
      />
    );
    expect(screen.getByRole('button', { name: 'Thinking (updating)' })).toHaveAttribute(
      'data-state',
      'closed'
    );
  });
});
