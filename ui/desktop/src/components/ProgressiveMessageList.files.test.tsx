import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message } from '../types/message';
import { readSubagentCatalog } from '../acp/subagentCatalog';
import { readSubagentConversation } from '../acp/subagentConversation';
import { SubagentCatalogProvider } from '../workspace-panel/WorkspaceSubagents';
import ProgressiveMessageList from './ProgressiveMessageList';

vi.mock('../acp/subagentCatalog', () => ({ readSubagentCatalog: vi.fn() }));
vi.mock('../acp/subagentConversation', async (original) => ({
  ...(await original<typeof import('../acp/subagentConversation')>()),
  readSubagentConversation: vi.fn(),
}));
vi.mock('../acp/chatSessionStore', async (original) => ({
  ...(await original<typeof import('../acp/chatSessionStore')>()),
  useAcpChatSessionSnapshot: () => ({
    session: { working_dir: 'D:/fixture', extension_data: { workspaceBinding: 'bound' } },
  }),
}));

const parent = 'main-file-card';
const metadata = { userVisible: true, agentVisible: true };
const inspect = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  inspect.mockImplementation(async ({ path }: { path: string }) => ({
    file: { path: `D:/fixture/${path}`, size: 12, openExternally: false },
  }));
  Object.assign(window.electron, { workspacePanel: inspect });
  vi.mocked(readSubagentCatalog).mockImplementation(async (id) => ({
    sessionId: id,
    ancestorSessionIds: [],
    children:
      id === parent
        ? [{ id: 'writer', label: 'File writer', mode: 'continuable', createdAt: 1000 }]
        : [],
  }));
  vi.mocked(readSubagentConversation).mockImplementation(async (_parent, child, afterSeq) => ({
    sessionId: parent,
    childSessionId: child,
    throughSeq: 2,
    hasMore: false,
    events:
      afterSeq === -1
        ? [
            {
              seq: 0,
              time: 1100,
              type: 'tool/call',
              data: {
                callId: 'write-file',
                name: 'write',
                arguments: JSON.stringify({
                  file_path: 'D:/fixture/child.mjs',
                  content: 'first\nsecond\n',
                }),
                parentUserMessageId: 'human',
              },
            },
            {
              seq: 1,
              time: 1200,
              type: 'tool/result',
              data: {
                message: {
                  id: 'receipt',
                  role: 'tool',
                  toolCallId: 'write-file',
                  content: [],
                  isError: false,
                },
                fileResult: { path: 'D:/fixture/child.mjs', operation: 'create', diffs: [] },
              },
            },
            {
              seq: 2,
              time: 1300,
              type: 'turn/end',
              data: { turn: 1, reason: { kind: 'completed' } },
            },
          ]
        : [],
  }));
});

function messages(thinking: boolean): Message[] {
  return [
    {
      id: 'human',
      role: 'user',
      created: 1,
      metadata,
      content: [{ type: 'text', text: 'Delegate one file' }],
    },
    {
      id: 'answer',
      role: 'assistant',
      created: 2,
      metadata,
      content: [
        ...(thinking
          ? [{ type: 'thinking' as const, thinking: 'Review the committed result.', signature: '' }]
          : []),
        { type: 'text', text: 'Created `child.mjs`; see `guide.md` for usage.' },
      ],
    },
    {
      id: 'terminal',
      role: 'assistant',
      created: 3,
      metadata: { userVisible: true, agentVisible: false },
      content: [
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          msg: 'Completed',
          data: {
            schema_version: 1,
            session_id: parent,
            run_id: 'run',
            terminal_message_id: 'terminal',
            source_user_message_id: 'human',
            status: 'completed',
            checkpoint_id: null,
            retry_strategy: 'not_available',
            visible_text_available: true,
            tool_action_count: 0,
            copy_artifact_ref: null,
            finished_at: new Date(3000).toISOString(),
          },
        },
      ],
    },
  ];
}

for (const thinking of [false, true])
  it(`shows child changes once in the main chat with thinking ${thinking ? 'shown' : 'absent'}, without listing mentioned files`, async () => {
    const tree = (sessionId: string, history = messages(thinking)) => (
      <SubagentCatalogProvider parentSessionId={sessionId}>
        <ProgressiveMessageList
          messages={history}
          chat={{ sessionId }}
          workspaceRoot="D:/fixture"
          sessionType="code_pro"
          isUserMessage={(message) => message.role === 'user'}
        />
      </SubagentCatalogProvider>
    );
    const view = render(tree(parent), { wrapper: IntlTestWrapper });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Modified 1 files this turn' })).toHaveLength(1)
    );
    expect(screen.queryByLabelText('Referenced workspace files')).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    expect(screen.getAllByText('+2')).toHaveLength(2);
    const opened = vi.fn();
    window.addEventListener('codebuddy:open-conversation-change', opened);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'D:/fixture/child.mjs' }));
      expect(opened.mock.calls[0][0].detail).toEqual({
        sessionId: parent,
        turnId: 'human',
        filePath: 'D:/fixture/child.mjs',
      });
    } finally {
      window.removeEventListener('codebuddy:open-conversation-change', opened);
    }
    view.rerender(tree(parent, globalThis.structuredClone(messages(thinking))));
    await act(async () => {});
    expect(screen.getAllByRole('button', { name: 'Modified 1 files this turn' })).toHaveLength(1);
    view.rerender(tree('other', messages(thinking).slice(0, 2)));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Modified 1 files this turn' })).toBeNull()
    );
  });

it('does not list mentioned files or present a rejected child write as a change', async () => {
  const original = vi.mocked(readSubagentConversation).getMockImplementation()!;
  vi.mocked(readSubagentConversation).mockImplementation(async (...args) => {
    const page = await original(...args);
    return {
      ...page,
      events: page.events.map((event) =>
        event.type === 'tool/result'
          ? {
              ...event,
              data: {
                message: {
                  id: 'rejected',
                  role: 'tool',
                  toolCallId: 'write-file',
                  content: [{ type: 'text', text: 'Permission denied' }],
                  isError: true,
                },
              },
            }
          : event
      ),
    };
  });
  render(
    <SubagentCatalogProvider parentSessionId={parent}>
      <ProgressiveMessageList
        messages={messages(false)}
        chat={{ sessionId: parent }}
        workspaceRoot="D:/fixture"
        sessionType="code_pro"
        isUserMessage={(message) => message.role === 'user'}
      />
    </SubagentCatalogProvider>,
    { wrapper: IntlTestWrapper }
  );
  await waitFor(() => expect(readSubagentConversation).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Modified 1 files this turn' })).toBeNull();
  expect(screen.queryByLabelText('Referenced workspace files')).toBeNull();
  expect(inspect).not.toHaveBeenCalled();
});

it('does not list later read-only references or repeat earlier change cards', async () => {
  const history: Message[] = [
    ...messages(true),
    {
      id: 'follow-up',
      role: 'user',
      created: 4,
      metadata,
      content: [{ type: 'text', text: 'Explain the earlier file' }],
    },
    {
      id: 'explanation',
      role: 'assistant',
      created: 5,
      metadata,
      content: [
        {
          type: 'text',
          text: 'Delegated a read-only review of `child.mjs`; see `guide.md`. No files were modified.',
        },
      ],
    },
  ];
  const tree = (sessionId: string, source = history) => (
    <SubagentCatalogProvider parentSessionId={sessionId}>
      <ProgressiveMessageList
        messages={source}
        chat={{ sessionId }}
        workspaceRoot="D:/fixture"
        sessionType="code_pro"
        isUserMessage={(message) => message.role === 'user'}
      />
    </SubagentCatalogProvider>
  );
  const view = render(tree(parent), { wrapper: IntlTestWrapper });
  await screen.findByRole('button', { name: 'Modified 1 files this turn' });
  expect(screen.getByText(/Delegated a read-only review/)).toBeVisible();
  expect(screen.queryByLabelText('Referenced workspace files')).toBeNull();
  expect(screen.getAllByText('+2')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /Referenced changes from turn/ })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Modified 1 files this turn' })).toHaveLength(1);
  expect(inspect).not.toHaveBeenCalled();
  view.rerender(tree(parent, globalThis.structuredClone(history)));
  await screen.findByRole('button', { name: 'Modified 1 files this turn' });
  view.rerender(tree('other', history.slice(3)));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Modified 1 files this turn' })).toBeNull()
  );
});

it('presents main history before child history without showing a temporary referenced-files list', async () => {
  const original = vi.mocked(readSubagentConversation).getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(readSubagentConversation).mockImplementation(async (...args) => {
    await pending;
    return original(...args);
  });
  const rendered = vi.fn();
  render(
    <SubagentCatalogProvider parentSessionId={parent}>
      <ProgressiveMessageList
        messages={messages(false)}
        chat={{ sessionId: parent }}
        workspaceRoot="D:/fixture"
        sessionType="code_pro"
        onHistoryRendered={rendered}
        isUserMessage={(message) => message.role === 'user'}
      />
    </SubagentCatalogProvider>,
    { wrapper: IntlTestWrapper }
  );
  await waitFor(() => expect(readSubagentConversation).toHaveBeenCalled());
  expect(screen.getByText(/Created/)).toBeVisible();
  expect(rendered).toHaveBeenCalledWith(parent);
  expect(screen.queryByLabelText('Referenced workspace files')).toBeNull();
  await act(async () => release());
  await screen.findByRole('button', { name: 'Modified 1 files this turn' });
  expect(screen.queryByLabelText('Referenced workspace files')).toBeNull();
  expect(inspect).not.toHaveBeenCalled();
});

it('keeps main text available without a file list when the child catalog cannot be loaded', async () => {
  vi.mocked(readSubagentCatalog).mockRejectedValue(new Error('Catalog unavailable'));
  render(
    <SubagentCatalogProvider parentSessionId={parent}>
      <ProgressiveMessageList
        messages={messages(false)}
        chat={{ sessionId: parent }}
        workspaceRoot="D:/fixture"
        sessionType="code_pro"
        isUserMessage={(message) => message.role === 'user'}
      />
    </SubagentCatalogProvider>,
    { wrapper: IntlTestWrapper }
  );
  await waitFor(() => expect(readSubagentCatalog).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.getByText(/Created/)).toBeVisible();
  expect(screen.queryByLabelText('Referenced workspace files')).toBeNull();
  expect(inspect).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Modified 1 files this turn' })).toBeNull();
});
