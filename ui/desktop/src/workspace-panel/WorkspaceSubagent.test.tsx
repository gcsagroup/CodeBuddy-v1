import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceSubagent } from './WorkspaceSubagent';
import { collectConversationChanges } from '../components/codepro/conversationChanges';
import { FileChangeDiff } from '../components/codepro/CodeProFileChange';
import { SubagentCatalogProvider } from './WorkspaceSubagents';
import { readSubagentCatalog } from '../acp/subagentCatalog';
import {
  createSubagentConversationProjection,
  readSubagentConversation,
  type SubagentConversationPage,
} from '../acp/subagentConversation';

vi.mock('../acp/subagentConversation', async (original) => ({
  ...(await original<typeof import('../acp/subagentConversation')>()),
  readSubagentConversation: vi.fn(),
}));
vi.mock('../acp/subagentCatalog', () => ({ readSubagentCatalog: vi.fn() }));
vi.mock('../components/ProgressiveMessageList', () => ({
  default: ({ messages, ...props }: { messages: { content: { text?: string }[] }[] }) => {
    expect(props).not.toHaveProperty('append');
    expect(props).not.toHaveProperty('resubmitMessage');
    expect(props).not.toHaveProperty('resumeAfterWorkspace');
    return (
      <div>
        {messages
          .flatMap((m) => m.content)
          .map((c, i) => (
            <span key={i}>{c.text}</span>
          ))}
      </div>
    );
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});
const page = (
  events: SubagentConversationPage['events'],
  throughSeq: number
): SubagentConversationPage => ({
  sessionId: 'parent',
  childSessionId: 'child',
  events,
  throughSeq,
  hasMore: false,
});
const first = page(
  [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 1,
      type: 'user/message',
      data: { id: 'task', role: 'user', content: [{ type: 'text', text: 'Review quantities' }] },
    },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        message: {
          id: 'progress',
          role: 'assistant',
          content: [{ type: 'text', text: 'Checking edge cases' }],
        },
      },
    },
  ],
  2
);

it('reuses preloaded native messages immediately without starting a second reader or flashing an empty conversation', async () => {
  vi.mocked(readSubagentCatalog).mockResolvedValue({
    sessionId: 'parent',
    ancestorSessionIds: [],
    children: [{ id: 'child', createdAt: 1, mode: 'continuable', label: 'Review' }],
  });
  vi.mocked(readSubagentConversation).mockResolvedValue(first);
  const tree = (open: boolean) => (
    <SubagentCatalogProvider parentSessionId="parent" active={open}>
      {open && <WorkspaceSubagent parentSessionId="parent" childSessionId="child" title="Review" />}
    </SubagentCatalogProvider>
  );
  const view = render(tree(false), { wrapper: IntlTestWrapper });
  await act(async () => {
    await Promise.resolve();
  });
  expect(readSubagentConversation).toHaveBeenCalledTimes(1);
  view.rerender(tree(true));
  expect(screen.getByText('Checking edge cases')).toBeVisible();
  expect(screen.queryByText('No conversation records yet.')).toBeNull();
  expect(screen.queryByText('Loading subagents…')).toBeNull();
  await act(async () => {
    await Promise.resolve();
  });
  expect(readSubagentConversation).toHaveBeenCalledTimes(2);
  expect(readSubagentConversation).toHaveBeenLastCalledWith('parent', 'child', 2, []);
});

it('shows loading instead of an empty-result claim while the first native read is pending', async () => {
  vi.mocked(readSubagentConversation).mockReturnValue(new Promise(() => {}));
  render(<WorkspaceSubagent parentSessionId="parent" childSessionId="child" title="Review" />, {
    wrapper: IntlTestWrapper,
  });
  expect(screen.getByText('Loading subagents…')).toBeVisible();
  expect(screen.queryByText('No conversation records yet.')).toBeNull();
});

it('discards a late preloaded transcript after switching to another main conversation', async () => {
  let resolveOld!: (value: SubagentConversationPage) => void;
  vi.mocked(readSubagentCatalog).mockImplementation(async (id) => ({
    sessionId: id,
    ancestorSessionIds: [],
    children: [{ id: 'child', createdAt: 1, mode: 'continuable', label: 'Review' }],
  }));
  vi.mocked(readSubagentConversation)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    )
    .mockResolvedValue({
      ...page(
        [
          {
            seq: 2,
            type: 'assistant/message',
            data: {
              message: {
                id: 'other-answer',
                role: 'assistant',
                content: [{ type: 'text', text: 'Another conversation only' }],
              },
            },
          },
        ],
        2
      ),
      sessionId: 'other',
    });
  const tree = (id: string) => (
    <SubagentCatalogProvider parentSessionId={id}>
      <WorkspaceSubagent parentSessionId={id} childSessionId="child" title="Review" />
    </SubagentCatalogProvider>
  );
  const view = render(tree('parent'), { wrapper: IntlTestWrapper });
  await act(async () => {
    await Promise.resolve();
  });
  view.rerender(tree('other'));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText('Another conversation only')).toBeVisible();
  await act(async () => {
    resolveOld(first);
  });
  expect(screen.queryByText('Checking edge cases')).toBeNull();
  expect(screen.getByText('Another conversation only')).toBeVisible();
});

it('binds a nested conversation read to its validated catalog ancestry', async () => {
  vi.mocked(readSubagentConversation).mockResolvedValue(first);
  render(
    <WorkspaceSubagent
      parentSessionId="parent"
      childSessionId="child"
      title="Nested review"
      ancestorSessionIds={['ancestor']}
    />,
    { wrapper: IntlTestWrapper }
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(readSubagentConversation).toHaveBeenCalledExactlyOnceWith('parent', 'child', -1, [
    'ancestor',
  ]);
  expect(screen.getByText('Checking edge cases')).toBeVisible();
  expect(
    screen.getByText('Nested review').parentElement?.querySelector('[data-subagent-avatar]')
  ).toHaveAttribute('data-subagent-avatar', 'child');
});

it('reads only the selected child with an incremental cursor and stops viewing on close', async () => {
  vi.mocked(readSubagentConversation)
    .mockResolvedValueOnce(first)
    .mockResolvedValue(
      page(
        [
          {
            seq: 3,
            type: 'assistant/message',
            data: {
              message: {
                id: 'answer',
                role: 'assistant',
                content: [{ type: 'text', text: 'Review complete' }],
              },
            },
          },
          { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ],
        4
      )
    );
  const view = render(
    <WorkspaceSubagent parentSessionId="parent" childSessionId="child" title="Quantity review" />,
    { wrapper: IntlTestWrapper }
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText('Checking edge cases')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Turn record still open');
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(readSubagentConversation).toHaveBeenLastCalledWith('parent', 'child', 2);
  expect(screen.getByText('Review complete')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Turn ended');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  view.unmount();
  await act(async () => {
    vi.advanceTimersByTime(6000);
  });
  expect(readSubagentConversation).toHaveBeenCalledTimes(2);
});

it('marks stale open-turn records as unknown after a read failure instead of claiming live execution', async () => {
  vi.mocked(readSubagentConversation)
    .mockResolvedValueOnce(first)
    .mockRejectedValue(new Error('Parent conversation changed during inspection'));
  render(<WorkspaceSubagent parentSessionId="parent" childSessionId="child" title="Review" />, {
    wrapper: IntlTestWrapper,
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole('status')).toHaveTextContent('Turn record still open');
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.getByRole('status')).toHaveTextContent('Status not yet available');
  expect(screen.getByRole('alert')).toHaveTextContent('Previously loaded conversation records');
  expect(screen.getByText('Checking edge cases')).toBeVisible();
});

it('keeps ownership failures visible and repeats only the read request, including manual refresh', async () => {
  vi.mocked(readSubagentConversation).mockRejectedValue(
    new Error('Subagent does not belong to this conversation')
  );
  render(<WorkspaceSubagent parentSessionId="parent" childSessionId="foreign" title="Foreign" />, {
    wrapper: IntlTestWrapper,
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole('alert')).toHaveTextContent('does not belong');
  await act(async () => {
    vi.advanceTimersByTime(6000);
  });
  expect(readSubagentConversation).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(readSubagentConversation).toHaveBeenCalledTimes(3);
});

it('recovers a transient read failure at the last committed cursor without duplicating messages', async () => {
  vi.mocked(readSubagentConversation)
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new Error('Session is changing'))
    .mockResolvedValue(
      page([{ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }], 3)
    );
  render(<WorkspaceSubagent parentSessionId="parent" childSessionId="child" title="Review" />, {
    wrapper: IntlTestWrapper,
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Session is changing');
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(readSubagentConversation).toHaveBeenLastCalledWith('parent', 'child', 2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Turn ended');
  expect(screen.getAllByText('Checking edge cases')).toHaveLength(1);
});

it('continues observing a completed child that receives a new turn later', async () => {
  vi.mocked(readSubagentConversation)
    .mockResolvedValueOnce(
      page([{ seq: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }], 0)
    )
    .mockResolvedValue(
      page(
        [
          { seq: 1, type: 'turn/start', data: { turn: 2 } },
          {
            seq: 2,
            type: 'assistant/message',
            data: {
              message: {
                id: 'later',
                role: 'assistant',
                content: [{ type: 'text', text: 'New turn in the same child' }],
              },
            },
          },
        ],
        2
      )
    );
  const view = render(
    <WorkspaceSubagent parentSessionId="parent" childSessionId="child" title="Review" />,
    { wrapper: IntlTestWrapper }
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole('status')).toHaveTextContent('Turn ended');
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(screen.getByText('New turn in the same child')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Turn record still open');
  view.unmount();
});

it('projects native tool receipts once without inventing an answer or execution', () => {
  const projection = createSubagentConversationProjection('child');
  const events = [
    ...first.events,
    {
      seq: 3,
      type: 'tool/call',
      data: { callId: 'read-1', name: 'read', arguments: '{"file_path":"quantities.mjs"}' },
    },
    {
      seq: 4,
      type: 'tool/result',
      data: {
        message: {
          id: 'receipt',
          role: 'tool',
          toolCallId: 'read-1',
          isError: true,
          content: [{ type: 'text', text: 'Read failed' }],
        },
      },
    },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
    {
      seq: 6,
      type: 'user/message',
      data: {
        id: 'followup',
        role: 'user',
        content: [{ type: 'text', text: 'Also inspect discounts' }],
      },
    },
  ];
  const messages = projection.append(events);
  expect(messages.some((message) => message.id === 'task')).toBe(false);
  expect(messages.flatMap((message) => message.content)).toContainEqual({
    type: 'text',
    text: 'Also inspect discounts',
  });
  expect(projection.status).toBe('interrupted');
  expect(messages.flatMap((m) => m.content).filter((c) => c.type === 'toolRequest')).toHaveLength(
    1
  );
  expect(messages.flatMap((m) => m.content).find((c) => c.type === 'toolResponse')).toMatchObject({
    toolResult: { status: 'error', error: 'Read failed' },
  });
  expect(projection.append(events)).toEqual(messages);
});

it('passes durable file evidence to the same change renderer used by the main chat', () => {
  const projection = createSubagentConversationProjection('child');
  const messages = projection.append([
    {
      seq: 0,
      type: 'tool/call',
      data: {
        callId: 'write',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'tests.py', content: 'one\ntwo\n' }),
      },
    },
    {
      seq: 1,
      type: 'tool/result',
      data: {
        message: {
          id: 'write-result',
          role: 'tool',
          toolCallId: 'write',
          content: [{ type: 'text', text: 'Saved' }],
        },
        fileResult: { path: 'tests.py', operation: 'create', diffs: [] },
      },
    },
    {
      seq: 2,
      type: 'tool/call',
      data: { callId: 'edit', name: 'edit', arguments: '{"file_path":"tests.py"}' },
    },
    {
      seq: 3,
      type: 'tool/result',
      data: {
        message: {
          id: 'edit-result',
          role: 'tool',
          toolCallId: 'edit',
          content: [{ type: 'text', text: 'Updated' }],
        },
        fileResult: { path: 'tests.py', diffs: [{ oldText: 'two\n', newText: 'three\n' }] },
      },
    },
  ]);
  const [turn] = collectConversationChanges(messages);
  expect(turn.files[0]).toMatchObject({
    path: 'tests.py',
    added: 3,
    removed: 1,
    hasUnavailableDiff: false,
  });
  expect(turn.files[0].changes[1].diff).toBe('@@\n-two\n+three');
  expect(projection.append([])).toEqual(messages);
  const view = render(<FileChangeDiff change={turn.files[0].changes[1]} />);
  expect(screen.getByText('-two').closest('[data-diff-kind]')).toHaveAttribute(
    'data-diff-kind',
    'removed'
  );
  expect(screen.getByText('+three').closest('[data-diff-kind]')).toHaveAttribute(
    'data-diff-kind',
    'added'
  );
  expect(
    [...view.container.querySelectorAll('[aria-hidden="true"]')].every(
      (node) => node.textContent?.trim() === ''
    )
  ).toBe(true);
});
