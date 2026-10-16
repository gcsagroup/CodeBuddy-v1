import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceChanges } from './WorkspaceChanges';
import type { Message } from '../types/message';

const metadata = { agentVisible: true, userVisible: true };
const user = (id: string): Message => ({
  id,
  created: 10,
  role: 'user',
  metadata,
  content: [{ type: 'text', text: `Request ${id}` }],
});
const edit = (id: string, before: string | null, after: string): Message[] => [
  {
    id: `request:${id}`,
    created: 11,
    role: 'assistant',
    metadata,
    content: [
      {
        type: 'toolRequest',
        id,
        metadata: { extensionName: 'harness' },
        toolCall: {
          status: 'success',
          value: { name: 'write', arguments: { file_path: '/fixture/app.py' } },
        },
      },
    ],
  },
  {
    id: `result:${id}`,
    created: 12,
    role: 'user',
    metadata,
    content: [
      {
        type: 'toolResponse',
        id,
        toolResult: {
          status: 'success',
          value: {
            structuredContent: {
              path: '/fixture/app.py',
              operation: 'update',
              before,
              after,
            },
          },
        },
      },
    ],
  },
];

it('keeps cumulative records grouped by turn and opens the selected historical file', () => {
  const a = edit('a', 'old\n', 'first\n');
  const b = edit('b', 'first\n', 'second\n');
  const messages = [user('first'), a[0], user('second'), ...b, a[1]];
  render(<WorkspaceChanges sessionId="parent" workspaceRoot="/fixture" messages={messages} />, {
    wrapper: IntlTestWrapper,
  });
  expect(screen.getByText('1 files across 2 turns')).toBeVisible();
  expect(screen.getAllByText('Turn 1').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Turn 2').length).toBeGreaterThan(0);
  const open = vi.spyOn(window, 'dispatchEvent');
  fireEvent.click(screen.getAllByRole('button', { name: /app.py/ })[0]);
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'codebuddy:open-conversation-change',
      detail: { sessionId: 'parent', turnId: 'second', filePath: '/fixture/app.py' },
    })
  );
  open.mockRestore();
});

it('shows the earlier saved diff without reading or substituting the current file', () => {
  const read = vi.fn();
  window.electron.readWorkspaceFile = read;
  const messages = [
    user('first'),
    ...edit('a', 'old\n', 'first\n'),
    user('second'),
    ...edit('b', 'first\n', 'second\n'),
  ];
  render(
    <WorkspaceChanges
      sessionId="parent"
      messages={messages}
      selection={{ turnId: 'first', filePath: '/fixture/app.py' }}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByText('+first')).toBeVisible();
  expect(screen.queryByText('+second')).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it('reports a missing historical basis instead of showing a false zero-line diff', () => {
  const messages = [user('first'), ...edit('a', null, 'new\n')];
  render(
    <WorkspaceChanges
      sessionId="parent"
      messages={messages}
      selection={{ turnId: 'first', filePath: '/fixture/app.py' }}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(
    screen.getByText('A file modification was recorded, but its historical diff is unavailable.')
  ).toBeVisible();
  expect(screen.queryByText('+0')).toBeNull();
});

it('selects one exact operation among repeated edits to the same file in the same turn', () => {
  const messages = [
    user('first'),
    ...edit('a', 'old\n', 'first\n'),
    ...edit('b', 'first\n', 'second\n'),
  ];
  const view = render(
    <WorkspaceChanges
      sessionId="operation"
      messages={messages}
      selection={{ toolCallId: 'a', filePath: '/fixture/app.py' }}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByText('+first')).toBeVisible();
  expect(screen.queryByText('+second')).toBeNull();
  view.rerender(
    <IntlTestWrapper>
      <WorkspaceChanges
        sessionId="operation"
        messages={messages}
        selection={{ toolCallId: 'b', filePath: '/fixture/app.py' }}
      />
    </IntlTestWrapper>
  );
  expect(screen.getByText('+second')).toBeVisible();
  expect(screen.queryByText('-old')).toBeNull();
});

it('never replaces a missing operation diff with a neighbouring receipt or the current file', () => {
  const read = vi.fn();
  window.electron.readWorkspaceFile = read;
  const messages = [
    user('first'),
    ...edit('a', null, 'first\n'),
    ...edit('b', 'first\n', 'second\n'),
  ];
  const view = render(
    <WorkspaceChanges
      sessionId="operation-gap"
      messages={messages}
      selection={{ toolCallId: 'a', filePath: '/fixture/app.py' }}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByText('No historical diff was returned for this operation.')).toBeVisible();
  expect(screen.queryByText('+second')).toBeNull();
  view.rerender(
    <IntlTestWrapper>
      <WorkspaceChanges
        sessionId="operation-gap"
        messages={[]}
        selection={{ toolCallId: 'a', filePath: '/fixture/app.py' }}
      />
    </IntlTestWrapper>
  );
  expect(
    screen.getByText('This change is no longer present in the conversation records.')
  ).toBeVisible();
  expect(read).not.toHaveBeenCalled();
});
