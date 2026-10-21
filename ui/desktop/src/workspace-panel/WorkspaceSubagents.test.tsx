import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { readSubagentCatalog, type SubagentCatalogPage } from '../acp/subagentCatalog';
import { WorkspaceSubagents } from './WorkspaceSubagents';

vi.mock('../acp/subagentCatalog', () => ({ readSubagentCatalog: vi.fn() }));
const parent = 'parent-product';
const root: SubagentCatalogPage = {
  sessionId: parent,
  ancestorSessionIds: [],
  children: [
    { id: 'review', createdAt: 1000, mode: 'continuable', label: 'Review files' },
    { id: 'external', createdAt: 1001, mode: 'external', label: 'External review' },
    { id: 'missing', createdAt: 1002, mode: 'unknown', label: 'Unavailable review' },
  ],
};
const nested: SubagentCatalogPage = {
  sessionId: parent,
  ancestorSessionIds: ['review'],
  children: [{ id: 'child', createdAt: 1003, mode: 'one-shot', label: 'Check tests' }],
};
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

it('loads native directories lazily, opens exact readonly paths, and stops polling collapsed or closed views', async () => {
  vi.mocked(readSubagentCatalog).mockImplementation(async (_, path) =>
    path?.length ? nested : root
  );
  const listener = vi.fn();
  window.addEventListener('codebuddy:open-subagent-conversation', listener);
  const view = render(<WorkspaceSubagents parentSessionId={parent} />, {
    wrapper: IntlTestWrapper,
  });
  await settle();
  expect(readSubagentCatalog).toHaveBeenCalledTimes(1);
  expect(readSubagentCatalog).toHaveBeenLastCalledWith(parent, []);
  expect(screen.queryByRole('button', { name: 'External review' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Unavailable review' })).toBeNull();
  expect(screen.queryByText('Working')).toBeNull();
  expect(screen.queryByText('Completed')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Review files' }).querySelector('[data-subagent-avatar]')
  ).toHaveAttribute('data-subagent-avatar', 'review');
  expect(view.container.querySelectorAll('[data-subagent-avatar]')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Review files' }));
  expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
    parentSessionId: parent,
    childSessionId: 'review',
    ancestorSessionIds: [],
    title: 'Review files',
  });
  const toggle = screen.getByRole('button', { name: 'Children of Review files' });
  fireEvent.click(toggle);
  await settle();
  expect(readSubagentCatalog).toHaveBeenLastCalledWith(parent, ['review']);
  fireEvent.click(screen.getByRole('button', { name: 'Check tests' }));
  expect((listener.mock.calls[1][0] as CustomEvent).detail).toMatchObject({
    parentSessionId: parent,
    childSessionId: 'child',
    ancestorSessionIds: ['review'],
  });
  fireEvent.click(toggle);
  const before = vi
    .mocked(readSubagentCatalog)
    .mock.calls.filter(([, path]) => path?.length).length;
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(vi.mocked(readSubagentCatalog).mock.calls.filter(([, path]) => path?.length)).toHaveLength(
    before
  );
  view.unmount();
  const count = vi.mocked(readSubagentCatalog).mock.calls.length;
  await act(async () => {
    vi.advanceTimersByTime(10000);
  });
  expect(readSubagentCatalog).toHaveBeenCalledTimes(count);
  window.removeEventListener('codebuddy:open-subagent-conversation', listener);
});

it('preserves visible entries during a read failure and automatically recovers without user refresh', async () => {
  vi.mocked(readSubagentCatalog)
    .mockResolvedValueOnce(root)
    .mockRejectedValue(new Error('Catalog unreadable'));
  render(<WorkspaceSubagents parentSessionId={parent} />, { wrapper: IntlTestWrapper });
  await settle();
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Catalog unreadable');
  expect(screen.getByRole('button', { name: 'Review files' })).toBeVisible();
  expect(screen.queryByText('No subagents in this directory.')).toBeNull();
  expect(readSubagentCatalog).toHaveBeenCalledTimes(2);
  vi.mocked(readSubagentCatalog).mockResolvedValue({ ...root, children: [] });
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(readSubagentCatalog).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('No subagents in this directory.')).toBeVisible();
});

it('discards a stale directory response after switching parent conversations', async () => {
  let resolveOld!: (page: SubagentCatalogPage) => void;
  vi.mocked(readSubagentCatalog)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    )
    .mockResolvedValue({ sessionId: 'new-parent', ancestorSessionIds: [], children: [] });
  const view = render(<WorkspaceSubagents parentSessionId={parent} />, {
    wrapper: IntlTestWrapper,
  });
  view.rerender(<WorkspaceSubagents parentSessionId="new-parent" />);
  await settle();
  await act(async () => {
    resolveOld(root);
  });
  expect(screen.queryByRole('button', { name: 'Review files' })).toBeNull();
  expect(screen.getByText('No subagents in this directory.')).toBeVisible();
});
