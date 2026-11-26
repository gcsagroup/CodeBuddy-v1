import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IpcRendererEvent } from 'electron';
import { useLayoutEffect } from 'react';
import { IntlTestWrapper } from '../i18n/test-utils';
import BaseChat from './BaseChat';
import type { Message } from '../types/message';
import type { PromptActivity } from '../acp/chatSessionStore';

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

const fixture = vi.hoisted(() => ({
  title: 'Saved history',
  recipe: undefined as { title: string } | undefined,
  global: false,
  readonly: true,
  loading: false,
  cancelling: false,
  busy: false,
  activeToolCallIds: [] as string[],
  state: 'idle',
  activity: undefined as PromptActivity | undefined,
  submit: vi.fn(),
  stop: vi.fn(),
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
      name: fixture.title,
      recipe: fixture.recipe,
      global_conversation: fixture.global,
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
    stopStreaming: fixture.stop,
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
    externalModelOpenRequest,
    inputRef,
  }: {
    onPendingMessageChange?: (sessionId: string, message: Message | undefined) => void;
    queueProcessingBlocked?: boolean;
    externalModelOpenRequest?: number;
    inputRef?: React.RefObject<HTMLTextAreaElement>;
  }) => {
    fixture.pending = onPendingMessageChange;
    return <textarea ref={inputRef} aria-label="Compose message" disabled={queueProcessingBlocked} data-model-open={externalModelOpenRequest ?? 0} />;
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
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: vi.fn() });
  fixture.title = 'Saved history';
  fixture.recipe = undefined;
  fixture.global = false;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  fixture.activeToolCallIds = [];
  fixture.readonly = true;
  fixture.loading = false;
  fixture.cancelling = false;
  fixture.busy = false;
  fixture.state = 'idle';
  fixture.activity = undefined;
  fixture.submit.mockReset();
  fixture.stop.mockReset();
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

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

it('keeps a long conversation heading intact instead of cutting it at 28 characters', () => {
  fixture.title = '修复七项体验问题并验收 Windows 和 Mac 安装包，保留全部历史与证据';
  show();
  expect(screen.getByRole('heading', { name: fixture.title })).toHaveTextContent(fixture.title);
});

it('introduces the empty main conversation without submitting a message', () => {
  fixture.global = true;
  fixture.readonly = false;
  fixture.history = [];
  show({ startAgent: false });
  expect(screen.getByRole('article')).toHaveTextContent('CodeBuddy');
  expect(screen.getByRole('heading', { name: 'Hi, I’m CodeBuddy, your project assistant.' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /Project progress/i })).not.toBeInTheDocument();
  expect(screen.getByText(/adjust permissions for a single chat/)).toBeVisible();
  expect(screen.getByText(/Can you check my project’s progress/)).toBeVisible();
  expect(screen.queryByRole('heading', { name: "I'm CodeBuddy. Let's work together." })).not.toBeInTheDocument();
  expect(fixture.submit).not.toHaveBeenCalled();
});

it.each([
  { global: false, loading: false, history: [] },
  { global: true, loading: true, history: [] },
  { global: true, loading: false, history: undefined },
])('hides the main introduction for other chats, replay and existing history %#', overrides => {
  Object.assign(fixture, overrides, { readonly: false });
  show({ startAgent: false });
  expect(screen.queryByRole('heading', { name: 'Hi, I’m CodeBuddy, your project assistant.' })).not.toBeInTheDocument();
});

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

it('run advice waits for cancellation before opening model selection and never resubmits', () => {
  fixture.readonly = false;
  fixture.state = 'thinking';
  fixture.activity = { promptAttemptId: 'a', sourceUserMessageId: 'u', startedAt: Date.now(),
    execution: { phase: 'model', childCount: 0, consecutiveToolFailures: 3 } };
  const tree = (id = 'imported') => <MemoryRouter><BaseChat sessionId={id} isActiveSession suppressEmptyState setChat={vi.fn()} /></MemoryRouter>;
  const view = render(tree(), { wrapper: IntlTestWrapper });
  expect(screen.queryByTestId('loading-indicator')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Stop and choose a model' }));
  expect(fixture.stop).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toHaveAttribute('data-model-open', '0');
  fixture.cancelling = true;
  view.rerender(tree());
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toHaveAttribute('data-model-open', '0');
  fixture.cancelling = false;
  fixture.state = 'idle';
  fixture.activity = undefined;
  view.rerender(tree());
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toHaveAttribute('data-model-open', '1');
  expect(fixture.submit).not.toHaveBeenCalled();
});

it('settling a turn does not steal focus from the model picker', () => {
  vi.useFakeTimers();
  fixture.readonly = false;
  show();
  const picker = document.createElement('div');
  picker.dataset.modelPickerList = '';
  const search = document.createElement('input');
  picker.append(search);
  document.body.append(picker);
  try {
    search.focus();
    act(() => vi.advanceTimersByTime(150));
    expect(search).toHaveFocus();
  } finally { picker.remove(); }
});

it('a pending advice action cannot open the model picker in another chat', () => {
  fixture.readonly = false;
  fixture.state = 'thinking';
  fixture.activity = { promptAttemptId: 'a', sourceUserMessageId: 'u', startedAt: Date.now(),
    execution: { phase: 'model', childCount: 0, responseRetries: 3 } };
  const tree = (id: string) => <MemoryRouter><BaseChat sessionId={id} isActiveSession suppressEmptyState setChat={vi.fn()} /></MemoryRouter>;
  const view = render(tree('imported'), { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Stop and choose a model' }));
  fixture.state = 'idle';
  fixture.activity = undefined;
  view.rerender(tree('another'));
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toHaveAttribute('data-model-open', '0');
  expect(fixture.submit).not.toHaveBeenCalled();
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

it('keeps input preparation in the footer without appending a transient history row', async () => {
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
  await waitFor(() => expect(screen.queryByTestId('conversation-loading')).toBeNull());
  expect(screen.getAllByText('Generating file contents')).toHaveLength(1);
  expect(screen.getByTestId('loading-indicator')).toHaveTextContent('Generating file contents');
  expect(view.container.querySelector('.codepro-chat-history [role="status"]')).toBeNull();
  expect(screen.queryByText('14 KB')).toBeNull();
  expect(screen.getByTestId('history-order')).not.toHaveTextContent('tool-preview');
  fixture.state = 'idle';
  view.rerender(
    <MemoryRouter>
      <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
    </MemoryRouter>
  );
  expect(screen.queryByText('14 KB')).toBeNull();
  expect(screen.queryByText('Generating file contents')).toBeNull();
});

it('keeps queued input outside execution history until admission without leaking into another chat', () => {
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
  expect(fixture.pending).toBeUndefined();
  expect(screen.getByTestId('history-order')).toHaveTextContent(/^working$/);
  expect(fixture.history).toEqual([output]);
  fixture.history = [output, { ...output, id: 'child-ended' }];
  const showSession = (sessionId: string) => (
    <MemoryRouter>
      <BaseChat sessionId={sessionId} isActiveSession suppressEmptyState setChat={vi.fn()} />
    </MemoryRouter>
  );
  view.rerender(showSession('imported'));
  expect(screen.getByTestId('history-order')).toHaveTextContent(/^working,child-ended$/);
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
    expect(screen.getAllByTestId('conversation-loading')).toHaveLength(1);
    expect(screen.getByTestId('conversation-loading').closest('[aria-hidden="true"]')).toBeNull();
    expect(
      screen.getByTestId('conversation-loading').querySelector('[role="status"]')
    ).toHaveTextContent('Loading conversation…');
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

it('positions loaded history at the latest message before revealing it', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  fixture.autoRender = false;
  const { container } = show();
  const viewport = container.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]')!;
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 9000 });
  const covered: boolean[] = [];
  viewport.scrollTo = vi.fn(() => {
    covered.push(!!screen.queryByTestId('conversation-loading'));
    viewport.scrollTop = 8500;
  });
  act(() => fixture.historyRendered?.());
  act(() => vi.advanceTimersToNextFrame());
  expect(viewport.scrollTop).toBe(8500);
  expect(covered[0]).toBe(true);
  expect(screen.getByTestId('conversation-loading')).toBeVisible();
  act(() => vi.advanceTimersToNextFrame());
  expect(screen.queryByTestId('conversation-loading')).toBeNull();
  expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 9000, behavior: 'auto' });
});

it('opens a cached conversation at the tail without overriding subsequent manual reading', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  const view = show();
  act(() => vi.advanceTimersToNextFrame());
  act(() => vi.advanceTimersToNextFrame());
  const viewport = view.container.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]')!;
  const tree = (active: boolean) => <MemoryRouter><BaseChat sessionId="imported" isActiveSession={active} suppressEmptyState setChat={vi.fn()} /></MemoryRouter>;
  view.rerender(tree(false));
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 12000 });
  viewport.scrollTo = vi.fn(() => { viewport.scrollTop = 11500; });
  viewport.scrollTop = 0;
  view.rerender(tree(true));
  expect(screen.getByTestId('conversation-loading')).toBeVisible();
  act(() => vi.advanceTimersToNextFrame());
  act(() => vi.advanceTimersToNextFrame());
  expect(screen.queryByTestId('conversation-loading')).toBeNull();
  expect(viewport.scrollTop).toBe(11500);
  expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 12000, behavior: 'auto' });
  vi.mocked(viewport.scrollTo).mockClear();
  fireEvent.wheel(viewport, { deltaY: -200 });
  viewport.scrollTop = 7000;
  fixture.history = [{ id: 'new', role: 'assistant', created: 2, content: [{ type: 'text', text: 'New output' }], metadata: { userVisible: true, agentVisible: true } }];
  view.rerender(tree(true));
  act(() => vi.advanceTimersToNextFrame());
  expect(viewport.scrollTop).toBe(7000);
  expect(viewport.scrollTo).not.toHaveBeenCalled();
});

it('retains normal conversation controls outside imported history', () => {
  fixture.readonly = false;
  show();
  expect(screen.getByRole('textbox', { name: 'Compose message' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit or retry' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Resume task' })).toBeVisible();
});

it('offers a way back only when the latest output is below the viewport', async () => {
  const { container } = show();
  await waitFor(() => expect(screen.queryByTestId('conversation-loading')).toBeNull());
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
  'keeps the history window light until a query is entered via %s',
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
    expect(screen.getByText('Recent history')).toBeVisible();
    const searchInput = screen.getByPlaceholderText('Search conversation...');
    expect(searchInput).toHaveFocus();
    expect(
      screen.getByRole('heading', { name: 'Saved history' }).closest('header')
    ).toContainElement(searchInput);
    fireEvent.change(searchInput, { target: { value: 'no-fixture-match' } });
    expect(await screen.findByText('Search all history')).toBeVisible();
    fireEvent.keyDown(searchInput, {
      key: 'Escape',
    });
    await waitFor(() => {
      expect(screen.getByText('Recent history')).toBeVisible();
      expect(screen.queryByPlaceholderText('Search conversation...')).not.toBeInTheDocument();
    });
  }
);

it('reserves the measured recipe header height for thought titles and clears it when removed', () => {
  fixture.recipe = { title: 'Recipe inset fixture' };
  const recipeAcceptance = window.electron.hasAcceptedRecipeBefore;
  window.electron.hasAcceptedRecipeBefore = vi.fn().mockResolvedValue(true);
  let headerHeight = 92;
  let notifyHeaderResize: (() => void) | undefined;
  const getBounds = HTMLElement.prototype.getBoundingClientRect;
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('sticky')
      ? new DOMRect(0, 0, 400, headerHeight)
      : getBounds.call(this);
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: globalThis.ResizeObserverCallback) {}
    observe(element: globalThis.Element) {
      if (element.classList.contains('sticky'))
        notifyHeaderResize = () => this.callback([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  });
  try {
    const view = show();
    const scroll = view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!;
    expect(scroll.style.getPropertyValue('--conversation-sticky-header-height')).toBe('92px');
    act(() => { headerHeight = 128; notifyHeaderResize?.(); });
    expect(scroll.style.getPropertyValue('--conversation-sticky-header-height')).toBe('128px');
    fixture.recipe = undefined;
    view.rerender(
      <MemoryRouter>
        <BaseChat sessionId="imported" isActiveSession suppressEmptyState setChat={vi.fn()} />
      </MemoryRouter>
    );
    expect(scroll.style.getPropertyValue('--conversation-sticky-header-height')).toBe('0px');
  } finally {
    bounds.mockRestore();
    window.electron.hasAcceptedRecipeBefore = recipeAcceptance;
  }
});
