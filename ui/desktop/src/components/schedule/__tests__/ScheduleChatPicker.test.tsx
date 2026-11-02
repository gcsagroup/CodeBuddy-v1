import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { acpListSessions, type SessionListItem } from '../../../acp/sessions';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { ScheduleChatPicker } from '../ScheduleChatPicker';

vi.mock('../../../acp/sessions', () => ({ acpListSessions: vi.fn() }));
const chat = (id: string): SessionListItem => ({
  id,
  name: id,
  workingDir: '/fixture',
  createdAt: '',
  updatedAt: '',
  messageCount: 1,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

it('loads only on demand and searches/paginates the existing chat catalog', async () => {
  const user = userEvent.setup();
  const chosen = vi.fn();
  vi.mocked(acpListSessions)
    .mockResolvedValueOnce({
      sessions: [chat('Recent'), { ...chat('Archived'), archivedAt: '2026-10-01' }],
      nextCursor: 'page2',
    })
    .mockResolvedValueOnce({ sessions: [chat('Older')], nextCursor: null })
    .mockResolvedValueOnce({ sessions: [chat('Matched')], nextCursor: null });
  render(<ScheduleChatPicker onChange={chosen} workspaceMode="codepro" />, {
    wrapper: IntlTestWrapper,
  });
  expect(acpListSessions).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Follow-up chat' }));
  await screen.findByRole('button', { name: 'Recent' });
  expect(screen.queryByRole('button', { name: 'Archived' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('button', { name: 'Older' });
  expect(acpListSessions).toHaveBeenNthCalledWith(2, 'page2', { keyword: '' }, 'codepro');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), {
    target: { value: 'match' },
  });
  await screen.findByRole('button', { name: 'Matched' });
  expect(screen.queryByRole('button', { name: 'Recent' })).not.toBeInTheDocument();
  expect(acpListSessions).toHaveBeenLastCalledWith(null, { keyword: 'match' }, 'codepro');
  await user.click(screen.getByRole('button', { name: 'Matched' }));
  expect(chosen).toHaveBeenCalledWith({ id: 'Matched', name: 'Matched' });
});

it('shows a catalog error and retries when reopened without choosing a fallback chat', async () => {
  const user = userEvent.setup();
  const chosen = vi.fn();
  vi.mocked(acpListSessions)
    .mockRejectedValueOnce(new Error('fixture unavailable'))
    .mockResolvedValueOnce({ sessions: [chat('Recovered')], nextCursor: null });
  render(<ScheduleChatPicker onChange={chosen} workspaceMode="codepro" />, {
    wrapper: IntlTestWrapper,
  });
  await user.click(screen.getByRole('button', { name: 'Follow-up chat' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not read chats');
  expect(chosen).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Follow-up chat' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Recovered' })).toBeInTheDocument()
  );
});
