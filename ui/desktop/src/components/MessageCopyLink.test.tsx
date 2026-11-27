import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import MessageCopyLink from './MessageCopyLink';
import { speechPlayback } from '../utils/speechPlayback';

describe('MessageCopyLink', () => {
  it('shows retry beside copy and invokes the retry callback', () => {
    const onRetry = vi.fn();
    render(
      <IntlProvider locale="en">
        <MessageCopyLink text="answer" contentRef={{ current: null }} onRetry={onRetry} />
      </IntlProvider>
    );

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveAttribute('title', 'Copy');
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute('title', 'Retry');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('invokes retry once from each native keyboard activation', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <IntlProvider locale="en">
        <MessageCopyLink text="answer" contentRef={{ current: null }} onRetry={onRetry} />
      </IntlProvider>
    );

    screen.getByRole('button', { name: 'Retry' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('keeps terminal turn actions visible without requiring hover', () => {
    render(
      <IntlProvider locale="en">
        <MessageCopyLink
          text="stopped summary"
          contentRef={{ current: null }}
          onRetry={vi.fn()}
          alwaysVisible
        />
      </IntlProvider>
    );

    const actions = screen.getByRole('button', { name: 'Copy' }).parentElement;
    expect(actions).toHaveClass('opacity-100');
    expect(actions).not.toHaveClass('opacity-0');
  });
  it('puts explicit playback before copy and makes no automatic synthesis request', () => {
    const start = vi.spyOn(speechPlayback, 'start').mockResolvedValue();
    render(<IntlProvider locale="en"><MessageCopyLink text="final answer" speakable /></IntlProvider>);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Read aloud', 'Copy']);
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    expect(start).toHaveBeenCalledWith(expect.any(String), 'final answer');
    start.mockRestore();
  });
  it('does not add playback to user message actions by default', () => {
    render(<IntlProvider locale="en"><MessageCopyLink text="user message" /></IntlProvider>);
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull();
  });
  it('reads reply text without Markdown syntax or footer DOM content', () => {
    const start = vi.spyOn(speechPlayback, 'start').mockResolvedValue();
    const div = document.createElement('div'); div.textContent = '2026/11/27 复制 重试';
    render(<IntlProvider locale="en"><MessageCopyLink text="**Hello** [world](https://example.test)" contentRef={{ current: div }} speakable /></IntlProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    expect(start).toHaveBeenCalledWith(expect.any(String), 'Hello world'); start.mockRestore();
  });

});
