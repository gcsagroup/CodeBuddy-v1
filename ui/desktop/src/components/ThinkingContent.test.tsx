import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThinkingContent from './ThinkingContent';

vi.mock('../i18n', () => ({
  defineMessages: <T,>(messages: T) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

describe('ThinkingContent', () => {
  beforeEach(() => localStorage.clear());

  it('follows updates at the bottom but keeps the reading position when scrolled up', () => {
    const view = render(<ThinkingContent content="First" isExpanded isStreaming />);
    const viewport = screen
      .getByText('First')
      .closest('.codepro-operation-details') as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { value: 200 },
    });
    view.rerender(<ThinkingContent content="Second" isExpanded isStreaming />);
    expect(viewport.scrollTop).toBe(900);
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    view.rerender(<ThinkingContent content="Third" isExpanded isStreaming />);
    expect(viewport.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }));
    expect(viewport.scrollTop).toBe(900);
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

    expect(screen.getByRole('button', { name: 'Thinking · Updating' })).toHaveAttribute(
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

    fireEvent.click(screen.getByRole('button', { name: 'Thinking · Updating' }));
    expect(screen.getByRole('button', { name: 'Thinking · Updating' })).toHaveAttribute(
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
    expect(screen.getByRole('button', { name: 'Thinking · Updating' })).toHaveAttribute(
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
    expect(screen.getByRole('button', { name: 'Thinking · Updating' })).toHaveAttribute(
      'data-state',
      'closed'
    );
  });
});
