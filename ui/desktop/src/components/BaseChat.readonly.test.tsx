import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { IpcRendererEvent } from 'electron';
import { useLayoutEffect } from 'react';
import { IntlTestWrapper } from '../i18n/test-utils';
import BaseChat from './BaseChat';
import type { Message } from '../types/message';

const fixture = vi.hoisted(() => ({
  readonly: true,
  loading: false,
  cancelling: false,
  busy: false,
  submit: vi.fn(),
  update: vi.fn(),
  history: undefined as Message[] | undefined,
  pending: undefined as ((sessionId: string, message: Message | undefined) => void) | undefined,
  autoRender: true,
  historyRendered: undefined as (() => void) | undefined,
  workspace: undefined as { sessionId: string; workingDir: string } | undefined,
  reconfirm: vi.fn(),
}));
vi.mock('../hooks/useChatSession', () => ({
  useChatSession: ({ sessionId }: { sessionId: string }) => ({
    session: {
      id: sessionId,
      name: 'Saved history',
      session_type: 'code_pro',
      extension_data: { readonlyHistory: fixture.readonly },
    },
    messages: fixture.loading
      ? []
      : (fixture.history ?? [
          {
            id: 'saved',
            role: 'assistant',
            content: [{ type: 'text', text: 'Saved answer' }],
            metadata: { userVisible: true, agentVisible: true },
          },
        ]),
    chatState: fixture.loading ? 'loadingConversation' : fixture.busy ? 'thinking' : 'idle',
    cancelling: fixture.cancelling,
    tokenState: {},
    notifications: new Map(),
    handleSubmit: fixture.submit,
    onMessageUpdate: fixture.update,
    workspaceReconfirmation: fixture.workspace,
    reconfirmCodeProWorkspace: fixture.reconfirm,
  }),
}));
vi.mock('../acp/acpConnection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../acp/acpConnection')>()),
  isAcpRecovering: () => false,
  subscribeToAcpRecovery: () => () => {},
}));
vi.mock('./ChatInput', () => ({
  default: ({
    onPendingMessageChange,
    queueProcessingBlocked,
  }: {
    onPendingMessageChange?: (sessionId: string, message: Message | undefined) => void;
    queueProcessingBlocked?: boolean;
  }) => {
    fixture.pending = onPendingMessageChange;
    return <textarea aria-label="Compose message" disabled={queueProcessingBlocked} />;
  },
}));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('./codepro/CodeProPlanDock', () => ({ CodeProPlanDock: () => null }));
vi.mock('./ProgressiveMessageList', () => ({
  default: function MockMessageList({
    onMessageUpdate,
    resubmitMessage,
    searchActive,
    messages,
    chat,
    onHistoryRendered,
  }: {
    onMessageUpdate?: unknown;
    resubmitMessage?: unknown;
    searchActive?: boolean;
    messages?: Message[];
    chat: { sessionId: string };
    onHistoryRendered?: (sessionId: string) => void;
  }) {
    fixture.historyRendered = () => onHistoryRendered?.(chat.sessionId);
    useLayoutEffect(() => {
      if (fixture.autoRender) onHistoryRendered?.(chat.sessionId);
    }, [chat.sessionId, onHistoryRendered]);
    return (
      <div>
        Saved answer{onMessageUpdate ? <button>Edit or retry</button> : null}
        {resubmitMessage ? <button>Resume task</button> : null}
        <span>{searchActive ? 'Search all history' : 'Recent history'}</span>
        <output data-testid="history-order">
          {messages?.map((message) => message.id).join(',')}
        </output>
      </div>
    );
  },
}));

beforeEach(() => {
  fixture.readonly = true;
  fixture.loading = false;
  fixture.cancelling = false;
  fixture.busy = false;
  fixture.submit.mockReset();
  fixture.update.mockReset();
  fixture.history = undefined;
  fixture.pending = undefined;
  fixture.autoRender = true;
  fixture.historyRendered = undefined;
  fixture.workspace = undefined;
  fixture.reconfirm.mockReset();
  vi.mocked(window.electron.on).mockClear();
  Object.assign(window.electron, { logInfo: vi.fn() });
});

function show({ startAgent = true } = {}) {
  return render(
    <MemoryRouter
      initialEntries={[
        `/codepro?resumeSessionId=imported${startAgent ? '&shouldStartAgent=true' : ''}`,
      ]}
    >
      <BaseChat
        sessionId="imported"
        isActiveSession
        suppressEmptyState
        setChat={vi.fn()}
        initialMessage={{ msg: 'old continuation', images: [] }}
      />
    </MemoryRouter>,
    { wrapper: IntlTestWrapper }
  );
}

it('projects pending input before stop receipts without changing execution history or leaking into another chat', () => {
  fixture.readonly = false;
  const output: Message = {
    id: 'working',
    role: 'assistant',
    created: 1,
    content: [{ type: 'text', text: 'Working' }],
    metadata: { userVisible: true, agentVisible: true },
  };
  fixture.history = [output];
  const view = show();
  const pending: Message = {
    id: 'queued-stop',
    role: 'user',
    created: 2,
    content: [{ type: 'text', text: 'Stop' }],
    metadata: {
      userVisible: true,
      agentVisible: false,
      pendingDelivery: 'pending',
      presentation: { afterMessageId: 'working' },
    },
  };
  act(() => fixture.pending?.('imported', pending));
  expect(screen.getByTestId('history-order')).toHaveTextContent('working,queued-stop');
  expect(fixture.history).toEqual([output]);
  fixture.history = [output, { ...output, id: 'child-ended' }];
  const showSession = (sessionId: string) => (
    <MemoryRouter>
      <BaseChat sessionId={sessionId} isActiveSession suppressEmptyState setChat={vi.fn()} />
    </MemoryRouter>
  );
  view.rerender(showSession('imported'));
  expect(screen.getByTestId('history-order')).toHaveTextContent('working,queued-stop,child-ended');
  fixture.history = [
    output,
    { ...pending, metadata: { userVisible: true, agentVisible: true } },
    { ...output, id: 'child-ended' },
  ];
  view.rerender(showSession('imported'));
  expect(screen.getByTestId('history-order').textContent?.match(/queued-stop/g)).toHaveLength(1);
  fixture.history = [output];
  view.rerender(showSession('another-chat'));
  act(() => fixture.pending?.('imported', pending));
  expect(screen.getByTestId('history-order')).toHaveTextContent(/^working$/);
});

it.each([false, true])(
  'keeps the stop confirmation internal without flashing its loading banner (busy=%s)',
  async (busy) => {
    fixture.readonly = false;
    fixture.cancelling = true;
    fixture.busy = busy;
    show();
    await waitFor(() => expect(screen.queryByTestId('conversation-loading')).toBeNull());
    expect(screen.queryByText(/Stopping; waiting for confirmation/)).toBeNull();
    expect(screen.queryByTestId('loading-indicator')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Compose message' })).toBeVisible();
  }
);

it('shows archived content without composing, editing, retrying or auto-submitting old continuation', async () => {
  show();
  expect(screen.getByText('Saved answer')).toBeVisible();
  expect(
    screen.getByText('Imported history is read-only. Start a new task to continue working.')
  ).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit or retry' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resume task' })).toBeNull();
  await waitFor(() => expect(fixture.submit).not.toHaveBeenCalled());
});

it('keeps loading feedback until restored history has had a paint opportunity', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  try {
    fixture.loading = true;
    const view = show();
    expect(screen.getByTestId('conversation-loading')).toBeVisible();
    expect(screen.getByTestId('conversation-loading').closest('.absolute')).toBeNull();
    expect(
      screen.getByTestId('conversation-loading').querySelector('[role="status"]')
    ).toHaveTextContent('loading conversation...');
    fixture.loading = false;
    view.rerender(
      <MemoryRouter>
        <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByTestId('conversation-loading')).toBeVisible();
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.getByTestId('conversation-loading')).toBeVisible();
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.queryByTestId('conversation-loading')).toBeNull();
    expect(view.container.querySelector('.chat-history-enter')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('retains normal conversation controls outside imported history', () => {
  fixture.readonly = false;
  show();
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit or retry' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Resume task' })).toBeVisible();
});

it('offers a way back to the latest output after the reader pauses following', () => {
  const { container } = show();
  const viewport = container.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]')!;
  viewport.scrollTo = vi.fn();
  expect(screen.queryByRole('button', { name: 'Back to latest' })).toBeNull();
  fireEvent.wheel(viewport, { deltaY: -100 });
  fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }));
  expect(viewport.scrollTo).toHaveBeenCalledWith({ top: viewport.scrollHeight, behavior: 'auto' });
  expect(screen.queryByRole('button', { name: 'Back to latest' })).toBeNull();
});

it.each(['keyboard', 'menu'] as const)(
  'uses the actual search visibility for the history window when opened by %s',
  async (entry) => {
    show();
    expect(screen.getByText('Recent history')).toBeVisible();
    if (entry === 'keyboard') {
      fireEvent.keyDown(window, {
        key: 'f',
        ctrlKey: window.electron.platform !== 'darwin',
        metaKey: window.electron.platform === 'darwin',
      });
    } else {
      const find = vi
        .mocked(window.electron.on)
        .mock.calls.find(([event]) => event === 'find-command');
      expect(find).toBeDefined();
      act(() => find?.[1]({} as IpcRendererEvent));
    }
    expect(screen.getByText('Search all history')).toBeVisible();
    fireEvent.keyDown(screen.getByPlaceholderText('Search conversation...'), {
      key: 'Escape',
    });
    await waitFor(() => expect(screen.getByText('Recent history')).toBeVisible());
    expect(screen.queryByPlaceholderText('Search conversation...')).not.toBeInTheDocument();
  }
);
