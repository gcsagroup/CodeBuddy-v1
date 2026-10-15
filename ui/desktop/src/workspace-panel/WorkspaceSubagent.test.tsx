import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceSubagent } from './WorkspaceSubagent';
import {
  createSubagentConversationProjection,
  readSubagentConversation,
  type SubagentConversationPage,
} from '../acp/subagentConversation';

vi.mock('../acp/subagentConversation', async (original) => ({
  ...(await original<typeof import('../acp/subagentConversation')>()),
  readSubagentConversation: vi.fn(),
}));
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
  expect(screen.getByRole('status')).toHaveTextContent('Working');
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(readSubagentConversation).toHaveBeenLastCalledWith('parent', 'child', 2);
  expect(screen.getByText('Review complete')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Completed');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  view.unmount();
  await act(async () => {
    vi.advanceTimersByTime(6000);
  });
  expect(readSubagentConversation).toHaveBeenCalledTimes(2);
});

it('rejects a failed read without automatic task or transport retries', async () => {
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
  expect(readSubagentConversation).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conversation' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(readSubagentConversation).toHaveBeenCalledTimes(2);
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
  expect(screen.getByRole('status')).toHaveTextContent('Completed');
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(screen.getByText('New turn in the same child')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Working');
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
  ];
  const messages = projection.append(events);
  expect(projection.status).toBe('interrupted');
  expect(messages.flatMap((m) => m.content).filter((c) => c.type === 'toolRequest')).toHaveLength(
    1
  );
  expect(messages.flatMap((m) => m.content).find((c) => c.type === 'toolResponse')).toMatchObject({
    toolResult: { status: 'error', error: 'Read failed' },
  });
  expect(projection.append(events)).toEqual(messages);
});
