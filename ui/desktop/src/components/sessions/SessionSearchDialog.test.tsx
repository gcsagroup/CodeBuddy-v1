import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { acpListSessions } from '../../acp/sessions';
import { SessionSearchDialog } from './SessionSearchDialog';
vi.mock('../../acp/sessions', () => ({ acpListSessions: vi.fn() }));
it('searches server-side and opens a result with the keyboard', async () => {
  vi.mocked(acpListSessions).mockResolvedValue({ sessions: [{ id: 'one', name: 'Hello', workingDir: '', updatedAt: '2026-11-24', createdAt: '2026-11-24', messageCount: 1 }], nextCursor: null });
  const select = vi.fn(); const close = vi.fn();
  render(<SessionSearchDialog open onOpenChange={close} onSelect={select} />, { wrapper: IntlTestWrapper });
  expect(await screen.findByRole('option')).toHaveTextContent('Hello');
  const input = screen.getByRole('combobox');
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: 'message content' } });
  await waitFor(() => expect(acpListSessions).toHaveBeenLastCalledWith(undefined, { keyword: 'message content' }, 'unified'));
  await screen.findByRole('option');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(select).toHaveBeenCalledWith('one'); expect(close).toHaveBeenCalledWith(false);
});
it('shows an actionable error and retries', async () => {
  vi.mocked(acpListSessions).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ sessions: [], nextCursor: null });
  render(<SessionSearchDialog open onOpenChange={vi.fn()} onSelect={vi.fn()} />, { wrapper: IntlTestWrapper });
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(await screen.findByText(/No matching conversations/)).toBeVisible();
});
