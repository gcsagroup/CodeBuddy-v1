import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { CompletionReminderCard } from './CompletionReminderCard';

it('preserves the draft after a failed delivery and accepts one retry', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('Queue unavailable')).mockResolvedValue(undefined);
  render(<CompletionReminderCard title="Ledger" body="96" open={vi.fn()} send={send} />, { wrapper: IntlTestWrapper });
  const input = screen.getByRole('textbox');
  const button = screen.getByRole('button', { name: 'Send' });
  expect(button).toBeDisabled();
  fireEvent.change(input, { target: { value: '  deduct 7  ' } });
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Queue unavailable');
  expect(input).toHaveValue('  deduct 7  ');
  fireEvent.click(button);
  fireEvent.click(button);
  expect(send.mock.calls).toEqual([['deduct 7'], ['deduct 7']]);
});

it('expires after three idle seconds and keeps an unfinished reply', () => {
  vi.useFakeTimers();
  try {
    const expire = vi.fn();
    render(<CompletionReminderCard title="Report" body="Done" open={vi.fn()} send={vi.fn()} onExpire={expire} />,
      { wrapper: IntlTestWrapper });
    const input = screen.getByRole('textbox');
    vi.advanceTimersByTime(2999);
    expect(expire).not.toHaveBeenCalled();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'follow up' } });
    fireEvent.blur(input);
    vi.advanceTimersByTime(5000);
    expect(expire).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    vi.advanceTimersByTime(3000);
    expect(expire).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
