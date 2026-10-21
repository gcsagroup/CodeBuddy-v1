import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { readSubagentCatalog, type SubagentCatalogPage } from '../acp/subagentCatalog';
import {
  WorkspaceSubagents,
  SubagentCatalogProvider,
  useConversationChangeMessages,
  usePreloadedSubagentConversation,
} from './WorkspaceSubagents';
import { readSubagentConversation } from '../acp/subagentConversation';
import { AppEvents } from '../constants/events';
import type { Message } from '../types/message';
import { collectConversationChanges } from '../components/codepro/conversationChanges';
import { CodeProConversationFiles } from '../components/codepro/CodeProConversationFiles';

vi.mock('../acp/subagentCatalog', () => ({ readSubagentCatalog: vi.fn() }));
vi.mock('../acp/subagentConversation', async (original) => ({
  ...(await original<typeof import('../acp/subagentConversation')>()),
  readSubagentConversation: vi.fn(),
}));
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
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(readSubagentConversation).mockResolvedValue({
    sessionId: parent,
    childSessionId: 'review',
    events: [],
    throughSeq: -1,
    hasMore: false,
  });
});
afterEach(() => vi.useRealTimers());

it('switches readonly cache ownership without remounting the main chat subtree', async () => {
  vi.mocked(readSubagentCatalog).mockResolvedValue({ ...root, children: [] });
  const tree = (id: string, cacheKey = id) => (
    <SubagentCatalogProvider parentSessionId={id} cacheKey={cacheKey}>
      <input aria-label="Unsent draft" defaultValue="" />
    </SubagentCatalogProvider>
  );
  const view = render(tree(parent), { wrapper: IntlTestWrapper });
  fireEvent.change(screen.getByLabelText('Unsent draft'), {
    target: { value: 'Keep my draft and connection' },
  });
  view.rerender(tree('other'));
  expect(screen.getByLabelText('Unsent draft')).toHaveValue('Keep my draft and connection');
  view.rerender(tree('other', 'changed-workspace'));
  expect(screen.getByLabelText('Unsent draft')).toHaveValue('Keep my draft and connection');
  await settle();
});

it('shares preloaded child edit evidence with the main card without leaking into another chat', async () => {
  vi.mocked(readSubagentCatalog).mockResolvedValue(root);
  vi.mocked(readSubagentConversation).mockResolvedValue({
    sessionId: parent,
    childSessionId: 'review',
    throughSeq: 2,
    hasMore: false,
    events: [
      {
        seq: 0,
        time: 1100,
        type: 'tool/call',
        data: {
          callId: 'edit',
          name: 'write',
          arguments: '{"file_path":"/fixture/child.py"}',
          parentUserMessageId: 'human',
        },
      },
      {
        seq: 1,
        time: 1200,
        type: 'tool/result',
        data: {
          message: { id: 'receipt', role: 'tool', toolCallId: 'edit', content: [], isError: false },
          fileResult: {
            path: '/fixture/child.py',
            operation: 'create',
            diffs: [{ oldText: '', newText: 'child\n' }],
          },
        },
      },
      { seq: 2, time: 1300, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  });
  const messages: Message[] = [
    {
      id: 'human',
      role: 'user',
      created: 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [{ type: 'text', text: 'Make a file' }],
    },
  ];
  function MainCard({ sessionId }: { sessionId: string }) {
    const source = useConversationChangeMessages(sessionId, messages);
    return (
      <CodeProConversationFiles
        messages={messages}
        sourceChanges={collectConversationChanges(source)}
        sessionId={sessionId}
      />
    );
  }
  const view = render(
    <SubagentCatalogProvider parentSessionId={parent}>
      <MainCard sessionId={parent} />
      <MainCard sessionId="other" />
    </SubagentCatalogProvider>,
    { wrapper: IntlTestWrapper }
  );
  await settle();
  expect(screen.getAllByRole('button', { name: 'Modified 1 files this turn' })).toHaveLength(1);
  const listener = vi.fn();
  window.addEventListener('codebuddy:open-conversation-change', listener);
  try {
    fireEvent.click(screen.getByRole('button', { name: '/fixture/child.py' }));
    expect(listener.mock.calls[0][0].detail).toEqual({
      sessionId: parent,
      turnId: 'human',
      filePath: '/fixture/child.py',
    });
  } finally {
    window.removeEventListener('codebuddy:open-conversation-change', listener);
  }
  view.rerender(
    <SubagentCatalogProvider parentSessionId="other">
      <MainCard sessionId="other" />
    </SubagentCatalogProvider>
  );
  expect(screen.queryByRole('button', { name: '/fixture/child.py' })).toBeNull();
});

it('backfills a temporarily unavailable parent attribution without duplicating readable child messages', async () => {
  vi.mocked(readSubagentCatalog).mockResolvedValue({ ...root, children: [root.children[0]] });
  const events = [
    {
      seq: 0,
      time: 1100,
      type: 'tool/call',
      data: { callId: 'edit', name: 'write', arguments: '{"file_path":"/fixture/child.py"}' },
    },
    {
      seq: 1,
      time: 1200,
      type: 'tool/result',
      data: {
        message: { id: 'receipt', role: 'tool', toolCallId: 'edit', content: [], isError: false },
        fileResult: {
          path: '/fixture/child.py',
          operation: 'create',
          diffs: [{ oldText: '', newText: 'child\n' }],
        },
      },
    },
    { seq: 2, time: 1300, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const page = {
    sessionId: parent,
    childSessionId: 'review',
    throughSeq: 2,
    hasMore: false,
    events,
  };
  vi.mocked(readSubagentConversation).mockResolvedValue({ ...page, attributionUnavailable: true });
  const messages: Message[] = [
    {
      id: 'human',
      role: 'user',
      created: 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [{ type: 'text', text: 'Make a file' }],
    },
  ];
  function Evidence() {
    const source = useConversationChangeMessages(parent, messages);
    const history = usePreloadedSubagentConversation(parent, 'review')?.snapshot?.messages ?? [];
    return (
      <>
        <output aria-label="File count">
          {collectConversationChanges(source).flatMap((turn) => turn.files).length}
        </output>
        <output aria-label="Readable messages">{history.length}</output>
      </>
    );
  }
  render(
    <SubagentCatalogProvider parentSessionId={parent} active={false}>
      <Evidence />
    </SubagentCatalogProvider>,
    { wrapper: IntlTestWrapper }
  );
  await settle();
  const count = screen.getByLabelText('Readable messages').textContent;
  expect(Number(count)).toBeGreaterThan(0);
  expect(screen.getByLabelText('File count')).toHaveTextContent('0');
  vi.mocked(readSubagentConversation).mockResolvedValue({
    ...page,
    events: [
      { ...events[0], data: { ...events[0].data, parentUserMessageId: 'human' } },
      ...events.slice(1),
    ],
  });
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(readSubagentConversation).toHaveBeenLastCalledWith(parent, 'review', -1, []);
  expect(screen.getByLabelText('File count')).toHaveTextContent('1');
  expect(screen.getByLabelText('Readable messages')).toHaveTextContent(count!);
});

it('opens exact readonly children without tree arrows or creation dates and stops polling closed views', async () => {
  vi.mocked(readSubagentCatalog).mockResolvedValue(root);
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
  expect(screen.queryByRole('button', { name: /Children of/ })).toBeNull();
  expect(view.container.querySelector('time')).toBeNull();
  expect(readSubagentConversation).toHaveBeenCalledExactlyOnceWith(parent, 'review', -1, []);
  view.unmount();
  const count = vi.mocked(readSubagentCatalog).mock.calls.length;
  const conversations = vi.mocked(readSubagentConversation).mock.calls.length;
  await act(async () => {
    vi.advanceTimersByTime(10000);
  });
  expect(readSubagentCatalog).toHaveBeenCalledTimes(count);
  expect(readSubagentConversation).toHaveBeenCalledTimes(conversations);
  window.removeEventListener('codebuddy:open-subagent-conversation', listener);
});

it('shows native running and stopped facts, updates reuse, and clears stale status on read failure', async () => {
  vi.setSystemTime(new Date('2026-10-21T07:02:00Z'));
  vi.mocked(readSubagentCatalog).mockResolvedValue(root);
  const page = { sessionId: parent, childSessionId: 'review', throughSeq: 1, hasMore: false };
  vi.mocked(readSubagentConversation).mockResolvedValueOnce({
    ...page,
    events: [{ seq: 1, type: 'turn/start', data: { turn: 1 } }],
  });
  const view = render(<WorkspaceSubagents parentSessionId={parent} />, {
    wrapper: IntlTestWrapper,
  });
  await settle();
  expect(screen.getByRole('status', { name: 'Turn record still open' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Running · 1' })).toHaveTextContent('Review files');
  const end = Date.now() - 60_000;
  vi.mocked(readSubagentConversation).mockResolvedValue({
    ...page,
    throughSeq: 2,
    events: [
      { seq: 2, type: 'turn/end', time: end, data: { turn: 1, reason: { kind: 'aborted' } } },
    ],
  });
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.queryByRole('status', { name: 'Turn record still open' })).toBeNull();
  expect(screen.getByText('1 minute ago')).toHaveAttribute('datetime', new Date(end).toISOString());
  expect(screen.getByRole('region', { name: 'Ended · 1' })).toHaveTextContent('Review files');
  vi.mocked(readSubagentConversation).mockResolvedValue({
    ...page,
    throughSeq: 3,
    events: [{ seq: 3, type: 'turn/start', data: { turn: 2 } }],
  });
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(screen.getByRole('status', { name: 'Turn record still open' })).toBeVisible();
  vi.mocked(readSubagentConversation).mockRejectedValue(new Error('unavailable'));
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.queryByRole('status', { name: 'Turn record still open' })).toBeNull();
  expect(view.container.querySelector('time')).toBeNull();
});

it('does not flash an old running state while history still has another page', async () => {
  vi.mocked(readSubagentCatalog).mockResolvedValue({ ...root, children: [root.children[0]] });
  vi.mocked(readSubagentConversation).mockResolvedValueOnce({
    sessionId: parent,
    childSessionId: 'review',
    throughSeq: 1,
    hasMore: true,
    events: [{ seq: 1, type: 'turn/start', data: { turn: 1 } }],
  });
  render(<WorkspaceSubagents parentSessionId={parent} />, { wrapper: IntlTestWrapper });
  await settle();
  expect(screen.getByText('Loading subagents…')).toBeVisible();
  expect(screen.queryByRole('region', { name: /Status unknown/ })).toBeNull();
  expect(screen.queryByText('No subagents running')).toBeNull();
  expect(screen.queryByRole('status', { name: 'Turn record still open' })).toBeNull();
  vi.mocked(readSubagentConversation).mockResolvedValue({
    sessionId: parent,
    childSessionId: 'review',
    throughSeq: 2,
    hasMore: false,
    events: [
      {
        seq: 2,
        type: 'turn/end',
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ],
  });
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.queryByText('Loading subagents…')).toBeNull();
  expect(screen.getByRole('region', { name: 'Ended · 1' })).toHaveTextContent('Review files');
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

it('preloads behind the main page, reuses settled facts on opening, and avoids idle history requests', async () => {
  const local = { ...root, children: [root.children[0]] };
  let resolveCatalog!: (page: SubagentCatalogPage) => void;
  vi.mocked(readSubagentCatalog)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      })
    )
    .mockResolvedValue(local);
  vi.mocked(readSubagentConversation).mockResolvedValue({
    sessionId: parent,
    childSessionId: 'review',
    throughSeq: 2,
    hasMore: false,
    events: [
      {
        seq: 2,
        type: 'turn/end',
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ],
  });
  const tree = (enabled: boolean, open: boolean) => (
    <SubagentCatalogProvider parentSessionId={parent} enabled={enabled} active={open}>
      <p>Main conversation</p>
      {open && <WorkspaceSubagents parentSessionId={parent} />}
    </SubagentCatalogProvider>
  );
  const view = render(tree(false, false), { wrapper: IntlTestWrapper });
  await settle();
  expect(readSubagentCatalog).not.toHaveBeenCalled();
  view.rerender(tree(true, false));
  await settle();
  expect(screen.getByText('Main conversation')).toBeVisible();
  expect(readSubagentConversation).not.toHaveBeenCalled();
  await act(async () => {
    resolveCatalog(local);
  });
  await settle();
  expect(readSubagentConversation).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(readSubagentConversation).toHaveBeenCalledTimes(1);
  view.rerender(tree(true, true));
  expect(screen.getByRole('region', { name: 'Ended · 1' })).toHaveTextContent('Review files');
  expect(screen.queryByText('Loading subagents…')).toBeNull();
  await settle();
  expect(readSubagentConversation).toHaveBeenCalledTimes(2);
  expect(readSubagentConversation).toHaveBeenLastCalledWith(parent, 'review', 2, []);
});

it('invalidates preloaded addresses when the native conversation changes', async () => {
  vi.mocked(readSubagentCatalog).mockResolvedValue({ ...root, children: [root.children[0]] });
  const view = render(<WorkspaceSubagents parentSessionId={parent} />, {
    wrapper: IntlTestWrapper,
  });
  await settle();
  expect(screen.getByRole('button', { name: 'Review files' })).toBeVisible();
  let resolveFresh!: (page: SubagentCatalogPage) => void;
  vi.mocked(readSubagentCatalog).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFresh = resolve;
    })
  );
  act(() => {
    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_CONVERSATION_CHANGED, { detail: { sessionId: parent } })
    );
  });
  expect(screen.queryByRole('button', { name: 'Review files' })).toBeNull();
  expect(screen.getByText('Loading subagents…')).toBeVisible();
  await act(async () => {
    resolveFresh({ ...root, children: [] });
  });
  expect(screen.getByText('No subagents in this directory.')).toBeVisible();
  view.unmount();
});
