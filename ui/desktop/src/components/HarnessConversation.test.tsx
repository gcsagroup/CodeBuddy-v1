import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type {
  Message,
  ToolRequestMessageContent,
  ToolResponseMessageContent,
} from '../types/message';
import ProgressiveMessageList from './ProgressiveMessageList';
import { CodeProConversationFiles } from './codepro/CodeProConversationFiles';
import { fileChangeReceipt } from './codepro/CodeProFileChange';
import { toolPlanContent } from './codepro/CodeProToolContent';
import { applyGooseSessionNotification } from '../acp/adapter/gooseSessionNotifications';
import type { AdapterState } from '../acp/adapter/shared';
import { SearchView } from './conversation/SearchView';
import { ScrollFollowingContext } from './ui/scroll-follow-context';
import { OPEN_CONVERSATION_CHANGE } from '../workspace-panel/conversationChangePanel';

beforeEach(() => window.sessionStorage.clear());
const base = {
  created: 1,
  metadata: { userVisible: true, agentVisible: true },
};
const user = (id = 'user'): Message => ({
  ...base,
  id,
  role: 'user',
  content: [{ type: 'text', text: id }],
});
const prose = (text: string): Message => ({
  ...base,
  id: text,
  role: 'assistant',
  content: [{ type: 'text', text }],
});
function write(id: string, path = '/fixture/app.py'): ToolRequestMessageContent {
  return {
    type: 'toolRequest',
    id,
    metadata: { extensionName: 'harness' },
    toolCall: {
      status: 'success',
      value: {
        name: 'write',
        arguments: { file_path: path, content: 'new\n' },
      },
    },
  };
}
function receipt(
  id: string,
  raw: Record<string, unknown> = {
    path: '/fixture/app.py',
    operation: 'update',
    before: 'old\n',
    after: 'new\n',
  }
): ToolResponseMessageContent {
  return {
    type: 'toolResponse',
    id,
    toolResult: {
      status: 'success',
      value: {
        isError: false,
        content: [{ type: 'text', text: 'Wrote file' }],
        structuredContent: raw,
      },
    },
  };
}
const requestMessage = (request: ToolRequestMessageContent): Message => ({
  ...base,
  id: request.id,
  role: 'assistant',
  content: [request],
});
const responseMessage = (response: ToolResponseMessageContent): Message => ({
  ...base,
  id: `result:${response.id}`,
  role: 'user',
  content: [response],
});
function terminal(source = 'user', status = 'completed'): Message {
  return {
    ...base,
    id: `terminal:${source}`,
    role: 'assistant',
    content: [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: 'Turn finished',
        data: {
          schema_version: 1,
          session_id: 'session',
          run_id: `run:${source}`,
          terminal_message_id: `terminal:${source}`,
          source_user_message_id: source,
          status,
          checkpoint_id: null,
          retry_strategy: 'not_available',
          visible_text_available: true,
          tool_action_count: 1,
          copy_artifact_ref: null,
          finished_at: '2026-10-15T11:06:00Z',
        },
      },
    ],
  };
}
function activity(id: string, status: 'running' | 'completed', callId = 'call-write'): Message {
  return {
    ...base,
    id,
    role: 'assistant',
    content: [
      {
        type: 'systemNotification',
        notificationType: 'codeProActivity',
        msg: 'write',
        data: {
          schema_version: 1,
          event_id: id,
          tool_call_id: callId,
          event_type: status === 'running' ? 'tool_started' : 'file_changed',
          session_id: 'session',
          run_id: 'run:user',
          task_id: null,
          parent_task_id: null,
          agent_role: null,
          effective_model: null,
          status,
          started_at: '2026-10-15T11:06:00Z',
          finished_at: status === 'completed' ? '2026-10-15T11:06:01Z' : null,
          title: 'write',
          technical_details: null,
          path: '/fixture/app.py',
          command_summary: null,
          exit_code: null,
          diff_summary: null,
          include_in_model_context: false,
          retryable: false,
          retry_from_event_id: null,
        },
      },
    ],
  };
}
const show = (messages: Message[], streaming = false) => (
  <ProgressiveMessageList
    messages={messages}
    chat={{ sessionId: 'session' }}
    isUserMessage={(message) => message.role === 'user'}
    isStreamingMessage={streaming}
    workspaceRoot="/fixture"
  />
);

function SearchableHistory({
  messages,
  streaming = false,
  following = true,
}: {
  messages: Message[];
  streaming?: boolean;
  following?: boolean;
}) {
  const [searchActive, setSearchActive] = useState(false);
  return (
    <ScrollFollowingContext.Provider value={following}>
      <SearchView onVisibilityChange={setSearchActive}>
        <ProgressiveMessageList
          messages={messages}
          chat={{ sessionId: 'session' }}
          isUserMessage={(item) => item.role === 'user'}
          isStreamingMessage={streaming}
          searchActive={searchActive}
          maxVisibleMessages={15}
          batchSize={15}
        />
      </SearchView>
    </ScrollFollowingContext.Provider>
  );
}

describe('Harness conversation presentation', () => {
  it('loads older turns on demand in the actual default chat and preserves expanded history while streaming', async () => {
    const trace = Array.from({ length: 120 }, (_, index) => [
      user(`user-${index}`),
      {
        ...prose(`Stage ${index}`),
        content: [
          {
            type: 'thinking' as const,
            thinking: `Inspect stage ${index}`,
            signature: '',
          },
          { type: 'text' as const, text: `Stage ${index}` },
          {
            ...write(`write-${index}`),
            toolCall: {
              status: 'success' as const,
              value: {
                name: 'read',
                arguments: { file_path: '/fixture/app.py' },
              },
            },
          },
        ],
      },
      responseMessage(receipt(`write-${index}`)),
      prose(`Result ${index}`),
      terminal(`user-${index}`),
    ]).flat();
    const chat = (messages: Message[], streaming = false, following = true) => (
      <SearchableHistory messages={messages} streaming={streaming} following={following} />
    );
    const view = render(chat(trace), { wrapper: IntlTestWrapper });
    expect(screen.getByText('Result 119')).toBeVisible();
    expect(screen.queryByText('Result 116')).not.toBeInTheDocument();
    expect(view.container.querySelectorAll('.codepro-turn-history')).toHaveLength(3);
    const history = view.container.querySelector('.codepro-turn-history button')!;
    fireEvent.click(history);
    expect(screen.getByText('Stage 117')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Load earlier messages/ }));
    expect(screen.getByText('Result 114')).toBeVisible();
    expect(screen.queryByText('Result 113')).not.toBeInTheDocument();
    view.rerender(chat([...trace, user('latest'), prose('Live feedback')], true));
    expect(
      await screen.findByText(
        (_, element) => element?.tagName === 'P' && element.textContent === 'Live feedback',
        {},
        { timeout: 3000 }
      )
    ).toBeVisible();
    expect(history).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Stage 117')).toBeVisible();
    fireEvent.keyDown(window, {
      key: 'f',
      ctrlKey: window.electron.platform !== 'darwin',
      metaKey: window.electron.platform === 'darwin',
    });
    expect(screen.getByText('Result 0')).toBeVisible();
    view.rerender(chat([...trace, user('latest'), prose('Live feedback')], true, false));
    fireEvent.keyDown(screen.getByPlaceholderText('Search conversation...'), {
      key: 'Escape',
    });
    await waitFor(() => expect(screen.queryByText('Result 0')).not.toBeInTheDocument());
    expect(screen.getByText('Result 114')).toBeVisible();
    expect(history).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Stage 117')).toBeVisible();
  });
  it('retains child-agent-only activity and merges its lifecycle using the actual call ID', () => {
    const state: AdapterState = {
      messages: [user(), requestMessage(write('root-call')), responseMessage(receipt('root-call'))],
      localSteerTextByMessageId: new Map(),
    };
    for (const message of [
      activity('child-start', 'running', 'worker:child-call'),
      activity('child-end', 'completed', 'worker:child-call'),
      activity('late-start', 'running', 'worker:child-call'),
    ]) {
      const content = message.content[0];
      if (content.type === 'systemNotification')
        applyGooseSessionNotification(state, {
          sessionId: 'session',
          update: {
            sessionUpdate: 'status_message',
            status: {
              type: 'progress',
              message: content.msg,
              data: content.data,
            },
          },
        });
    }
    const view = render(show(state.messages), { wrapper: IntlTestWrapper });
    expect(view.container.querySelectorAll('[data-tool-call-id="root-call"]')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Activity: Change .*Completed/ })).toHaveLength(
      1
    );
    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
  });

  it('keeps abnormal terminal report failures visible while removing ordinary completed boilerplate', () => {
    const ending = terminal();
    const content = ending.content[0];
    if (content.type === 'systemNotification')
      content.data = {
        ...(content.data as object),
        report: { outcome: 'invalid-report' },
      };
    render(show([user(), prose('The explanation is here.'), ending]), {
      wrapper: IntlTestWrapper,
    });
    expect(screen.getByText('The explanation is here.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Needs your input');
  });
  it('uses one native receipt instead of independent started/completed activity UUIDs, without folding a single operation', async () => {
    const trace = [
      user(),
      activity('random-start-event', 'running'),
      requestMessage(write('call-write')),
      responseMessage(receipt('call-write')),
      activity('random-end-event', 'completed'),
      prose('Now checking the next part.'),
    ];
    const view = render(show(trace, true), { wrapper: IntlTestWrapper });
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === 'P' && element.textContent === 'Now checking the next part.',
        {},
        { timeout: 3000 }
      )
    ).toBeVisible();
    expect(view.container.querySelectorAll('[data-tool-call-id="call-write"]')).toHaveLength(1);
    expect(view.container.querySelector('[data-tool-call-id="call-write"]')).toHaveAttribute(
      'data-tool-phase',
      'success'
    );
    expect(screen.queryByText(/Operations recorded/)).not.toBeInTheDocument();
    expect(view.container.querySelector('.codepro-group-heading')).toBeNull();
    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
  });

  it('keeps a series visible until public commentary separates it, then folds more than one operation', async () => {
    const trace = [
      user(),
      requestMessage(write('a')),
      responseMessage(receipt('a')),
      requestMessage(write('b', '/fixture/b.py')),
      responseMessage(
        receipt('b', {
          path: '/fixture/b.py',
          operation: 'create',
          before: null,
          after: 'new\n',
        })
      ),
    ];
    const view = render(show(trace, true), { wrapper: IntlTestWrapper });
    expect(screen.queryByRole('button', { name: 'Wrote 2 files' })).not.toBeInTheDocument();
    expect(view.container.querySelectorAll('[data-tool-call-id]')).toHaveLength(2);
    view.rerender(show([...trace, prose('Both files are saved; checking them now.')], true));
    expect(
      await screen.findByRole('button', { name: 'Wrote 2 files' }, { timeout: 3000 })
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent === 'Both files are saved; checking them now.',
        {},
        { timeout: 3000 }
      )
    ).toBeVisible();
  });

  it.each(['completed', 'interrupted'])(
    'folds process at a %s receipt and puts edited files after the summary',
    (status) => {
      const trace = [
        user(),
        prose('Preparing the files.'),
        requestMessage(write('a')),
        responseMessage(receipt('a')),
        prose('Saved the file; here is the result.'),
        terminal('user', status),
      ];
      const view = render(show(trace), { wrapper: IntlTestWrapper });
      expect(screen.queryByText('Preparing the files.')).not.toBeInTheDocument();
      const summary = screen.getByText('Saved the file; here is the result.');
      const card = screen.getByRole('button', {
        name: 'Modified 1 files this turn',
      });
      expect(summary).toBeVisible();
      expect(summary.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(view.container.querySelector('.codepro-turn-history button')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
      expect(screen.queryByText('Dynamic verification not run')).not.toBeInTheDocument();
      expect(screen.queryByText('Edit operations completed')).not.toBeInTheDocument();
      const open = vi.spyOn(window, 'dispatchEvent');
      fireEvent.click(screen.getByRole('button', { name: '/fixture/app.py' }));
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          type: OPEN_CONVERSATION_CHANGE,
          detail: { sessionId: 'session', turnId: 'user', filePath: '/fixture/app.py' },
        })
      );
      expect(screen.queryByText('-old')).not.toBeInTheDocument();
      expect(screen.queryByText('+new')).not.toBeInTheDocument();
      open.mockRestore();
    }
  );

  it('binds replayed terminal receipts to their source turns even when they arrive after later inputs', () => {
    const trace = [
      user(),
      prose('First stage.'),
      requestMessage(write('a')),
      responseMessage(receipt('a')),
      prose('First result.'),
      user('second'),
      prose('Second stage.'),
      requestMessage(write('b')),
      responseMessage(receipt('b')),
      prose('Second result.'),
      terminal(),
      terminal('second'),
    ];
    const view = render(show(trace), { wrapper: IntlTestWrapper });
    expect(view.container.querySelectorAll('.codepro-turn-history')).toHaveLength(2);
    expect(screen.queryByText('First stage.')).not.toBeInTheDocument();
    expect(screen.queryByText('Second stage.')).not.toBeInTheDocument();
    expect(screen.getByText('First result.')).toBeVisible();
    expect(screen.getByText('Second result.')).toBeVisible();
  });

  it('shows three edited files initially and can reveal the rest without including failed writes', () => {
    const trace = Array.from({ length: 5 }, (_, index) => [
      requestMessage(write(`call-${index}`, `/fixture/${index}.py`)),
      responseMessage(
        receipt(`call-${index}`, {
          path: `/fixture/${index}.py`,
          operation: 'create',
          before: null,
          after: 'new\n',
        })
      ),
    ]).flat();
    trace.push(
      requestMessage(write('failed', '/fixture/failed.py')),
      responseMessage({
        type: 'toolResponse',
        id: 'failed',
        toolResult: { status: 'error', error: 'denied' },
      })
    );
    render(
      <CodeProConversationFiles sessionId="session" messages={trace} workspaceRoot="/fixture" />,
      {
        wrapper: IntlTestWrapper,
      }
    );
    expect(screen.getByRole('button', { name: 'Modified 5 files this turn' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '/fixture/3.py' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more files' }));
    expect(screen.getByRole('button', { name: '/fixture/4.py' })).toBeVisible();
    expect(screen.queryByText('failed.py')).not.toBeInTheDocument();
  });

  it('opens the original turn from full history without reading files or rendering inline diffs', () => {
    const local = [user('first'), requestMessage(write('a'))];
    const trace = [
      ...local,
      user('second'),
      requestMessage(write('b', '/fixture/second.py')),
      responseMessage(receipt('b', { path: '/fixture/second.py', before: 'x\n', after: 'y\n' })),
      responseMessage(receipt('a')),
    ];
    const open = vi.spyOn(window, 'dispatchEvent');
    const read = vi.fn();
    window.electron.readWorkspaceFile = read;
    render(
      <CodeProConversationFiles
        sessionId="session"
        messages={local}
        sourceMessages={trace}
        workspaceRoot="/fixture"
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByRole('button', { name: '/fixture/app.py' }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        type: OPEN_CONVERSATION_CHANGE,
        detail: { sessionId: 'session', turnId: 'first', filePath: '/fixture/app.py' },
      })
    );
    expect(screen.queryByText('/fixture/second.py')).not.toBeInTheDocument();
    expect(screen.queryByText('-old')).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View changes' }));
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: OPEN_CONVERSATION_CHANGE,
        detail: { sessionId: 'session', turnId: 'first' },
      })
    );
    open.mockRestore();
  });

  it('keeps paths readable without a session and does not pretend that current files are historical diffs', () => {
    const read = vi.fn();
    window.electron.readWorkspaceFile = read;
    render(
      <CodeProConversationFiles
        messages={[user(), requestMessage(write('a')), responseMessage(receipt('a'))]}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByText('/fixture/app.py')).toBeVisible();
    expect(screen.queryByRole('button', { name: '/fixture/app.py' })).not.toBeInTheDocument();
    expect(screen.queryByText('-old')).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('native file diff evidence', () => {
  it('renders native todo states instead of an empty legacy content field', () => {
    expect(
      toolPlanContent({
        todos: [
          { content: 'Create files', status: 'completed' },
          { content: 'Verify changes', status: 'in_progress' },
        ],
      })
    ).toBe('- [x] Create files\n- [-] Verify changes');
  });
  it('uses full before/after receipts for actual hunk positions and red/green counts', () => {
    const change = fileChangeReceipt(
      receipt('a', {
        path: '/fixture/app.py',
        before: 'keep\nold\ntail\n',
        after: 'keep\nnew\nmore\ntail\n',
      }),
      write('a')
    );
    expect(change).toMatchObject({ added: 2, removed: 1 });
    expect(change?.diff).toContain('@@ -1,3 +1,4 @@');
    expect(change?.diff).toContain('-old\n+new\n+more');
  });
  it('does not invent an empty original file when an update lacks its diff basis', () => {
    expect(
      fileChangeReceipt(
        receipt('a', {
          path: '/fixture/app.py',
          operation: 'update',
          before: null,
          after: 'new\n',
        }),
        write('a')
      )
    ).toBeUndefined();
    expect(
      fileChangeReceipt(
        receipt('a', {
          path: '/fixture/app.py',
          operation: 'create',
          before: null,
          after: 'new\n',
        }),
        write('a')
      )
    ).toMatchObject({ added: 1, removed: 0 });
    expect(
      fileChangeReceipt(receipt('a'), {
        ...write('a'),
        metadata: { extensionName: 'external' },
      })
    ).toBeUndefined();
  });
});
