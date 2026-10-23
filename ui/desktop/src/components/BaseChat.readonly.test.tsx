import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { IpcRendererEvent } from 'electron';
import { IntlTestWrapper } from '../i18n/test-utils';
import BaseChat from './BaseChat';

const fixture = vi.hoisted(() => ({
  readonly: true,
  loading: false,
  cancelling: false,
  busy: false,
  state: 'idle',
  submit: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../hooks/useChatSession', () => ({
  useChatSession: () => ({
    session: {
      id: 'imported',
      name: 'Saved history',
      session_type: 'code_pro',
      extension_data: { readonlyHistory: fixture.readonly },
    },
    messages: fixture.loading
      ? []
      : [
          {
            id: 'saved',
            role: 'assistant',
            content: [{ type: 'text', text: 'Saved answer' }],
            metadata: { userVisible: true, agentVisible: true },
          },
        ],
    chatState: fixture.loading ? 'loadingConversation' : fixture.busy ? 'thinking' : fixture.state,
    cancelling: fixture.cancelling,
    tokenState: {},
    notifications: new Map(),
    handleSubmit: fixture.submit,
    onMessageUpdate: fixture.update,
  }),
}));
vi.mock('../acp/acpConnection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../acp/acpConnection')>()),
  isAcpRecovering: () => false,
  subscribeToAcpRecovery: () => () => {},
}));
vi.mock('./ChatInput', () => ({ default: () => <textarea aria-label="Compose message" /> }));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('./codepro/CodeProPlanDock', () => ({ CodeProPlanDock: () => null }));
vi.mock('./ProgressiveMessageList', () => ({
  default: ({
    onMessageUpdate,
    resubmitMessage,
    searchActive,
  }: {
    onMessageUpdate?: unknown;
    resubmitMessage?: unknown;
    searchActive?: boolean;
  }) => (
    <div>
      Saved answer{onMessageUpdate ? <button>Edit or retry</button> : null}
      {resubmitMessage ? <button>Resume task</button> : null}
      <span>{searchActive ? 'Search all history' : 'Recent history'}</span>
    </div>
  ),
}));

beforeEach(() => {
  fixture.readonly = true;
  fixture.loading = false;
  fixture.cancelling = false;
  fixture.busy = false;
  fixture.state = 'idle';
  fixture.submit.mockReset();
  fixture.update.mockReset();
  vi.mocked(window.electron.on).mockClear();
  Object.assign(window.electron, { logInfo: vi.fn() });
});

function show() {
  return render(
    <MemoryRouter initialEntries={['/codepro?resumeSessionId=imported&shouldStartAgent=true']}>
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
