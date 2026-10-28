import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IpcRendererEvent } from 'electron';
import { useLayoutEffect } from 'react';
import { IntlTestWrapper } from '../i18n/test-utils';
import BaseChat from './BaseChat';
import type { Message } from '../types/message';
import type { PromptActivity } from '../acp/chatSessionStore';

const fixture = vi.hoisted(() => ({
  readonly: true,
  loading: false,
  cancelling: false,
  busy: false,
  activeToolCallIds: [] as string[],
  state: 'idle',
  activity: undefined as PromptActivity | undefined,
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
    chatState: fixture.loading ? 'loadingConversation' : fixture.busy ? 'thinking' : fixture.state,
    cancelling: fixture.cancelling,
    promptActivity: fixture.activity,
    activeToolCallIds: fixture.activeToolCallIds,
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
  fixture.activeToolCallIds = [];
  fixture.readonly = true;
  fixture.loading = false;
  fixture.cancelling = false;
  fixture.busy = false;
  fixture.state = 'idle';
  fixture.activity = undefined;
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

afterEach(() => vi.useRealTimers());

it('moves the actual footer from A through model output to B and resets its action clock', () => {
  vi.useFakeTimers();
  fixture.readonly = false;
  fixture.state = 'streaming';
  fixture.history = ['A', 'B'].map((name) => ({
    id: name,
    role: 'assistant',
    created: 1,
    metadata: { userVisible: true, agentVisible: true },
    content: [
      {
        type: 'toolRequest',
        id: name,
        toolCall: {
          status: 'success',
          value: {
            name: 'generate_image',
            arguments: { operation: 'generate', display_name: '海报 ' + name },
          },
        },
      },
    ],
  }));
  fixture.activeToolCallIds = ['A'];
  const view = show();
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByTestId('loading-indicator')).toHaveTextContent('海报 A');
  expect(screen.getByTestId('loading-indicator')).toHaveTextContent('30s');
  fixture.activeToolCallIds = [];
  view.rerender(
    <MemoryRouter>
      <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
    </MemoryRouter>
  );
  expect(screen.getByTestId('loading-indicator')).not.toHaveTextContent('海报 A');
  fixture.activeToolCallIds = ['B'];
  view.rerender(
    <MemoryRouter>
      <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
    </MemoryRouter>
  );
  expect(screen.getByTestId('loading-indicator')).toHaveTextContent('海报 B');
  expect(screen.getByTestId('loading-indicator')).not.toHaveTextContent('30s');
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

it('renders a file draft outside durable history and clears it when the turn is stopped', () => {
  fixture.readonly = false;
  fixture.state = 'streaming';
  fixture.activity = {
    promptAttemptId: 'a',
    sourceUserMessageId: 'u',
    startedAt: Date.now(),
    execution: {
      phase: 'model',
      childCount: 0,
      toolInput: { id: 'w', name: 'write', kilobytes: 14 },
    },
  };
  const view = show();
  expect(screen.getAllByText('Generating file contents').length).toBeGreaterThan(0);
  expect(screen.queryByText('14 KB')).toBeNull();
  expect(screen.getByTestId('history-order')).not.toHaveTextContent('tool-preview');
  fixture.state = 'idle';
  view.rerender(
    <MemoryRouter>
      <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
    </MemoryRouter>
  );
  expect(screen.queryByText('14 KB')).toBeNull();
});

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

it('keeps the same loading shell through workspace revalidation and history rendering', async () => {
  fixture.readonly = false;
  fixture.loading = true;
  fixture.autoRender = false;
  let finishInspection!: (value: never[]) => void;
  const inspect = vi.fn(
    () =>
      new Promise<never[]>((resolve) => {
        finishInspection = resolve;
      })
  );
  Object.assign(window.electron, { inspectCodeProWorkspace: inspect });
  const view = show({ startAgent: false });
  const header = screen.getByRole('heading', { name: 'Saved history' });
  const composer = screen.getByRole('textbox', { name: 'Compose message' });
  const tree = () => (
    <MemoryRouter>
      <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
    </MemoryRouter>
  );
  fixture.loading = false;
  fixture.workspace = { sessionId: 'imported', workingDir: 'D:/fixture' };
  view.rerender(tree());
  await waitFor(() => expect(inspect).toHaveBeenCalledOnce());
  expect(screen.getByRole('heading', { name: 'Saved history' })).toBe(header);
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toBe(composer);
  expect(composer).toBeDisabled();
  expect(screen.getByTestId('conversation-loading')).toBeVisible();
  expect(fixture.reconfirm).not.toHaveBeenCalled();
  // Native workspace renewal completes before replay's DOM is ready.
  fixture.workspace = undefined;
  await act(async () => finishInspection([]));
  view.rerender(tree());
  expect(screen.getByTestId('conversation-loading')).toBeVisible();
  act(() => fixture.historyRendered?.());
  await waitFor(() => expect(screen.queryByTestId('conversation-loading')).toBeNull());
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toBe(composer);
  expect(composer).not.toBeDisabled();
  expect(fixture.submit).not.toHaveBeenCalled();
});

it('keeps workspace revalidation errors and retry controls visible without enabling input', async () => {
  fixture.readonly = false;
  fixture.workspace = { sessionId: 'imported', workingDir: 'D:/fixture' };
  const inspect = vi.fn().mockRejectedValue(new Error('Local inspection unavailable'));
  Object.assign(window.electron, { inspectCodeProWorkspace: inspect });
  show({ startAgent: false });
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toBeDisabled();
  expect(screen.getByTestId('conversation-loading')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
  expect(fixture.reconfirm).not.toHaveBeenCalled();
  expect(fixture.submit).not.toHaveBeenCalled();
});

it('keeps loading feedback through delayed rendering instead of releasing it after two arbitrary frames', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  try {
    fixture.loading = true;
    fixture.autoRender = false;
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
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.getByTestId('conversation-loading')).toBeVisible();
    act(() => fixture.historyRendered?.());
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.getByTestId('conversation-loading')).toBeVisible();
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.queryByTestId('conversation-loading')).toBeNull();
    expect(view.container.querySelector('.chat-history-enter')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('ignores a previous chat rendering callback when switching to an uncached chat', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  try {
    fixture.readonly = false;
    fixture.autoRender = false;
    const view = show();
    const oldRendered = fixture.historyRendered;
    fixture.loading = true;
    const tree = () => (
      <MemoryRouter>
        <BaseChat sessionId="another-chat" isActiveSession suppressEmptyState setChat={vi.fn()} />
      </MemoryRouter>
    );
    view.rerender(tree());
    act(() => oldRendered?.());
    act(() => vi.advanceTimersToNextFrame());
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.getByTestId('conversation-loading')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Compose message' })).toBeVisible();
    fixture.loading = false;
    view.rerender(tree());
    act(() => vi.advanceTimersToNextFrame());
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.getByTestId('conversation-loading')).toBeVisible();
    act(() => fixture.historyRendered?.());
    act(() => vi.advanceTimersToNextFrame());
    act(() => vi.advanceTimersToNextFrame());
    expect(screen.queryByTestId('conversation-loading')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('does not flash history loading when sending the first message in an already loaded empty chat', () => {
  fixture.readonly = false;
  fixture.history = [];
  fixture.autoRender = false;
  const view = show();
  expect(screen.queryByTestId('conversation-loading')).toBeNull();
  fixture.history = [
    {
      id: 'first-input',
      role: 'user',
      created: 1,
      content: [{ type: 'text', text: 'Hello' }],
      metadata: { userVisible: true, agentVisible: true },
    },
  ];
  view.rerender(
    <MemoryRouter>
      <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
    </MemoryRouter>
  );
  expect(screen.queryByTestId('conversation-loading')).toBeNull();
  expect(screen.getByTestId('history-order')).toHaveTextContent('first-input');
});

it('retains normal conversation controls outside imported history', () => {
  fixture.readonly = false;
  show();
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit or retry' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Resume task' })).toBeVisible();
});

it('offers a way back only when the latest output is below the viewport', () => {
  const { container } = show();
  const viewport = container.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]')!;
  const end = viewport.querySelector('div[style="height: 1px;"]')!;
  const bounds = vi.spyOn(end, 'getBoundingClientRect');
  const rect = end.getBoundingClientRect();
  viewport.scrollTo = vi.fn(() => bounds.mockReturnValue({ ...rect, bottom: 0 }));
  expect(screen.queryByRole('button', { name: 'Back to latest' })).toBeNull();
  fireEvent.wheel(viewport, { deltaY: -100 });
  expect(screen.queryByRole('button', { name: 'Back to latest' })).toBeNull();
  bounds.mockReturnValue({ ...rect, bottom: 100 });
  fireEvent.scroll(viewport);
  fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }));
  expect(viewport.scrollTo).toHaveBeenCalledWith({ top: viewport.scrollHeight, behavior: 'auto' });
  expect(screen.queryByRole('button', { name: 'Back to latest' })).toBeNull();
});

it('shows running dots at the bottom, preserves the return control, and clears dots when waiting or idle', async () => {
  fixture.readonly = false;
  fixture.state = 'thinking';
  const view = show();
  await waitFor(() => expect(screen.getByTestId('chat-running-indicator')).toBeVisible());
  const viewport = view.container.querySelector<HTMLDivElement>(
    '[data-radix-scroll-area-viewport]'
  )!;
  const end = viewport.querySelector('div[style="height: 1px;"]')!;
  const rect = end.getBoundingClientRect();
  const bounds = vi.spyOn(end, 'getBoundingClientRect').mockReturnValue({ ...rect, bottom: 100 });
  viewport.scrollTo = vi.fn(() => bounds.mockReturnValue({ ...rect, bottom: 0 }));
  fireEvent.scroll(viewport);
  expect(screen.queryByTestId('chat-running-indicator')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }));
  expect(screen.getByTestId('chat-running-indicator')).toBeVisible();
  for (const state of ['waitingForUserInput', 'idle']) {
    fixture.state = state;
    view.rerender(
      <MemoryRouter>
        <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByTestId('chat-running-indicator')).toBeNull();
  }
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
