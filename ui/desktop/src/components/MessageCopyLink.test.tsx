import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import MessageCopyLink from './MessageCopyLink';

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
});
