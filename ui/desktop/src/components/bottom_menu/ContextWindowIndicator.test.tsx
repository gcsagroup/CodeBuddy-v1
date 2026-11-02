import { render, screen } from '@testing-library/react';
import { vi, it, expect } from 'vitest';
import { ContextWindowIndicator } from './ContextWindowIndicator';
vi.mock('../../i18n', () => ({ useIntl: () => ({ locale: 'en' }) }));
vi.mock('./BottomMenuAlertPopover', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
it('distinguishes live estimates and unconfirmed capacity, then updates after compaction', () => {
  const { rerender } = render(
    <ContextWindowIndicator
      totalTokens={7927}
      tokenLimit={32768}
      usageSource="streaming_estimate"
      capacitySource="fallback"
      alerts={[]}
    />
  );
  expect(screen.getByText('8k / 33k')).toHaveAttribute(
    'title',
    expect.stringContaining('between steps')
  );
  rerender(
    <ContextWindowIndicator
      totalTokens={3200}
      tokenLimit={65536}
      usageSource="local_estimate"
      capacitySource="service"
      alerts={[]}
    />
  );
  expect(screen.getByText('3k / 66k')).toHaveAttribute(
    'title',
    expect.stringContaining('reported by service')
  );
});

it('shows pending capacity without a fabricated 128k limit', () => {
  render(<ContextWindowIndicator totalTokens={0} tokenLimit={0} alerts={[]} />);
  expect(screen.getByText('0 / Unknown')).toHaveAttribute(
    'title',
    expect.stringContaining('pending')
  );
});

it('keeps the counter stable while capacity provenance changes and explains fallback in its tooltip', () => {
  const { rerender } = render(
    <ContextWindowIndicator
      totalTokens={43000}
      tokenLimit={262144}
      capacitySource="fallback"
      alerts={[]}
    />
  );
  expect(screen.getByText('43k / 262k')).toHaveAttribute(
    'title',
    expect.stringContaining('unconfirmed')
  );
  rerender(<ContextWindowIndicator totalTokens={43000} tokenLimit={262144} alerts={[]} />);
  expect(screen.getByText('43k / 262k')).toBeVisible();
  expect(screen.queryByText(/\?/)).toBeNull();
});
