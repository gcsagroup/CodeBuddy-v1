import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, beforeEach, afterEach } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { AlertType } from '../alerts';
import { ContextWindowIndicator } from './ContextWindowIndicator';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => vi.unstubAllGlobals());

it('shows usage on hover and updates provenance after compaction', async () => {
  const { rerender } = render(
    <ContextWindowIndicator
      totalTokens={7927}
      tokenLimit={32768}
      usageSource="streaming_estimate"
      capacitySource="fallback"
      alerts={[]}
    />,
    { wrapper: IntlTestWrapper }
  );
  await userEvent.hover(
    screen.getByRole('button', { name: 'Context usage: 7,927 / 32,768 (24%)' })
  );
  expect(await screen.findByRole('dialog')).toHaveTextContent('7.9k / 32.8k');
  expect(screen.getByRole('dialog').querySelectorAll('p')).toHaveLength(2);
  expect(screen.getByRole('button')).toHaveAttribute(
    'aria-description',
    expect.stringContaining('between steps')
  );
  expect(screen.getByRole('button')).toHaveAttribute(
    'aria-description',
    expect.stringContaining('unconfirmed')
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
  expect(screen.getByRole('button', { name: 'Context usage: 3,200 / 65,536 (5%)' })).toBeVisible();
  expect(screen.getByRole('button')).toHaveAttribute(
    'aria-description',
    expect.stringContaining('reported by service')
  );
});

it('keeps zero visible without inventing unknown capacity or usage', async () => {
  const { rerender } = render(
    <ContextWindowIndicator totalTokens={0} tokenLimit={0} alerts={[]} />,
    { wrapper: IntlTestWrapper }
  );
  await userEvent.hover(screen.getByRole('button', { name: 'Context usage: 0 / Unknown' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('0k / Unknown');
  expect(screen.getByRole('button')).toHaveAttribute(
    'aria-description',
    expect.stringContaining('Capacity pending')
  );
  rerender(<ContextWindowIndicator tokenLimit={262144} alerts={[]} />);
  expect(screen.getByRole('button', { name: 'Context usage: Unknown / 262,144' })).toBeVisible();
  rerender(<ContextWindowIndicator totalTokens={0} tokenLimit={262144} alerts={[]} />);
  expect(screen.getByRole('button', { name: 'Context usage: 0 / 262,144 (0%)' })).toBeVisible();
});

it('preserves over-capacity counts and keyboard access to the existing compact action', async () => {
  const compact = vi.fn();
  render(
    <ContextWindowIndicator
      totalTokens={150000}
      tokenLimit={100000}
      alerts={[
        {
          type: AlertType.Warning,
          message: 'Context',
          showCompactButton: true,
          progress: { current: 150000, total: 100000 },
          onCompact: compact,
        },
      ]}
    />,
    { wrapper: IntlTestWrapper }
  );
  await userEvent.tab();
  expect(
    screen.getByRole('button', { name: 'Context usage: 150,000 / 100,000 (150%)' })
  ).toHaveFocus();
  expect(await screen.findByRole('dialog')).toHaveTextContent('150k / 100k');
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByRole('dialog')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Compact now' }));
  expect(compact).toHaveBeenCalledOnce();
});
