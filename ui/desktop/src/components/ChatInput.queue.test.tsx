import { deliverMainConversationMessage } from '../pets/mainConversation';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ChatState } from '../types/chatState';
import type { MessageSubmissionLifecycle } from '../hooks/useChatSessionTypes';
import type { Message, UserInput } from '../types/message';
import ChatInput from './ChatInput';
import { MessageQueue } from './MessageQueue';
import { updateDesktopOwnership } from '../desktopOwnership';
import { QueuedMessageStorage } from '../utils/queuedMessageStorage';
import { getSessionGoal, pauseSessionGoal } from '../acp/goals';
import { OPEN_GOAL_EDITOR } from '../workspace-panel/goalPanel';
import { getSessionExtensions, addSessionExtension } from '../acp/session-extensions';
import type { ToolboxItem } from '../types/toolbox';
import * as conversion from '../utils/conversionUtils';
import { ATTACH_WORKSPACE_IMAGE } from '../workspace-panel/workspaceFilePanel';
import { conversationMention } from './conversationMention';

const selection = vi.hoisted(() => ({ item: null as ToolboxItem | null }));
vi.mock('../acp/session-extensions', () => ({
  getSessionExtensions: vi.fn(),
  addSessionExtension: vi.fn(),
}));

vi.mock('../acp/goals', () => ({
  getSessionGoal: vi.fn(),
  pauseSessionGoal: vi.fn(),
  setSessionPlanMode: vi.fn(),
  changeSessionGoal: vi.fn(),
}));

vi.mock('./ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({ getCurrentModelAndProvider: async () => ({}) }),
}));
vi.mock('./alerts', () => ({
  AlertType: { Error: 'error', Warning: 'warning', Info: 'info' },
  useAlerts: () => ({ alerts: [], addAlert: vi.fn(), clearAlerts: vi.fn() }),
}));
vi.mock('../hooks/useAudioRecorder', () => ({ useAudioRecorder: () => ({ isEnabled: false }) }));
vi.mock('./bottom_menu/DirSwitcher', () => ({ DirSwitcher: () => null }));
vi.mock('./custom-agents/AgentSelector', () => ({ AgentSelector: () => null }));
vi.mock('./settings/models/bottom_bar/ModelsBottomBar', () => ({
  default: () => <button>Model selector</button>,
}));
vi.mock('./bottom_menu/BottomMenuExtensionSelection', () => ({
  BottomMenuExtensionSelection: () => null,
}));
vi.mock('./bottom_menu/CostTracker', () => ({ CostTracker: () => null }));
vi.mock('./bottom_menu/ContextWindowIndicator', () => ({ ContextWindowIndicator: () => null }));
vi.mock('./MentionPopover', () => ({
  default: ({
    isOpen,
    onSelect,
  }: {
    isOpen: boolean;
    onSelect: (text: string, item: unknown) => void;
  }) =>
    isOpen && selection.item ? (
      <button onClick={() => onSelect('/selected', { toolboxItem: selection.item })}>
        Select toolbox item
      </button>
    ) : null,
}));
vi.mock('./ui/Diagnostics', () => ({ DiagnosticsModal: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function expandQueueIfPresent() {
  const expand = screen.queryByRole('button', { name: 'Expand queue' });
  if (expand) fireEvent.click(expand);
}

function setup(
  handleSubmit: (input: UserInput, lifecycle?: MessageSubmissionLifecycle) => Promise<void> | void,
  onSteerQueuedMessage?: (input: UserInput) => Promise<boolean>,
  canSubmitQueuedMessageWhileLoading = false,
  pauseQueueOnStop = false,
  pendingProps: {
    automaticSteeringAllowed?: boolean;
    initialValue?: string;
    messages?: Message[];
    onPendingMessageChange?: (sessionId: string, message: Message | undefined) => void;
    onSubmissionAccepted?: () => void;
  } = {}
) {
  const onStop = vi.fn();
  const props = {
    sessionId: 'queue-test',
    handleSubmit,
    onStop,
    onSteerQueuedMessage,
    canSubmitQueuedMessageWhileLoading,
    pauseQueueOnStop,
    setView: vi.fn(),
    ...pendingProps,
  };
  const view = render(<ChatInput {...props} chatState={ChatState.Thinking} />, {
    wrapper: IntlTestWrapper,
  });
  expandQueueIfPresent();
  let currentState = ChatState.Thinking;
  let queueProcessingBlocked = false;
  let currentSessionId = props.sessionId;
  let currentMessages = pendingProps.messages ?? [];
  const rerender = () => {
    view.rerender(
      <ChatInput
        {...props}
        sessionId={currentSessionId}
        chatState={currentState}
        queueProcessingBlocked={queueProcessingBlocked}
        messages={currentMessages}
      />
    );
    expandQueueIfPresent();
  };
  return {
    ...view,
    onStop,
    changeBlocked: (blocked: boolean) => {
      queueProcessingBlocked = blocked;
      rerender();
    },
    changeState: (state: ChatState) => {
      currentState = state;
      rerender();
    },
    changeSession: (sessionId: string) => {
      currentSessionId = sessionId;
      rerender();
    },
    changeMessages: (messages: Message[]) => {
      currentMessages = messages;
      rerender();
    },
  };
}

async function queue(text: string) {
  const input = screen.getByTestId('chat-input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expandQueueIfPresent();
  const saved = screen.queryByRole('button', { name: 'Expand saved drafts' });
  if (saved) fireEvent.click(saved);
  await screen.findByText(text.replace(/\s+/g, ' ').trim());
}

const sendNow = () => {
  const saved = screen.queryByRole('button', { name: 'Expand saved drafts' });
  if (saved) fireEvent.click(saved);
  return screen.getByRole('button', { name: /^Send (?:all )?now$|^Send saved drafts$/ });
};

describe('large pasted drafts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.mocked(getSessionExtensions).mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('uses the send button for continuation only when the stopped composer is empty', () => {
    const onContinue = vi.fn();
    const props = { sessionId: 'stopped', handleSubmit: vi.fn(), onStop: vi.fn(), setView: vi.fn(), chatState: ChatState.Idle, onContinue };
    render(<ChatInput {...props} />, { wrapper: IntlTestWrapper });
    const button = screen.getByRole('button', { name: 'Continue task' });
    expect(screen.queryByRole('button', { name: /^Send$/ })).toBeNull();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'new request' } });
    expect(screen.getByRole('button', { name: /^Send$/ })).toBe(button);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(props.handleSubmit).not.toHaveBeenCalled();
  });
  it('appends a toolbox skill draft once without submitting or replacing existing text', () => {
    const handleSubmit = vi.fn();
    const props = { sessionId: 'skill-draft', handleSubmit, onStop: vi.fn(), setView: vi.fn(), chatState: ChatState.Idle };
    const view = render(<ChatInput {...props} />, { wrapper: IntlTestWrapper });
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'existing draft' } });
    view.rerender(<ChatInput {...props} draftDelivery={{ id: 'route-1', text: 'Use sync-skill:' }} />);
    expect(screen.getByTestId('chat-input')).toHaveValue('existing draft\nUse sync-skill:');
    view.rerender(<ChatInput {...props} draftDelivery={{ id: 'route-1', text: 'Use sync-skill:' }} />);
    expect(screen.getByTestId('chat-input')).toHaveValue('existing draft\nUse sync-skill:');
    expect(handleSubmit).not.toHaveBeenCalled();
    expect(localStorage.getItem('queued-messages-skill-draft')).toBeNull();
  });
  it('adds every selected file as a separate attachment without replacing typed text', async () => {
    const submit = vi.fn((_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => lifecycle?.onAccepted());
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    const picker = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker.multiple).toBe(true);
    const originalPathForFile = window.electron.getPathForFile;
    window.electron.getPathForFile = file => `C:/picker-fixture/${file.name}`;
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'keep this draft' } });
    fireEvent.change(picker, { target: { files: [new File(['first'], 'first.txt'), new File(['second'], 'second.pdf')] } });
    await screen.findByText('first.txt');
    await screen.findByText('second.pdf');
    expect(screen.getByTestId('chat-input')).toHaveValue('keep this draft');
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ msg: 'keep this draft C:/picker-fixture/first.txt C:/picker-fixture/second.pdf' }), expect.anything()));
    window.electron.getPathForFile = originalPathForFile;
  });
  it('rejects an overflowing picker batch without silently retaining a subset or submitting the draft', async () => {
    const submit = vi.fn();
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'keep this draft' } });
    const picker = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: Array.from({ length: 9 }, (_, i) => new File(['image'], `${i}.png`, { type: 'image/png' })) } });
    expect(await screen.findByText(/already has 0 images; you are adding 9, but the limit is 8/)).toBeVisible();
    expect(screen.getByText(/This batch was not added or sent/)).toBeVisible();
    expect(input).toHaveValue('keep this draft');
    expect(screen.queryByRole('button', { name: 'Remove file' })).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
  it('keeps selected insertion and later edits exact without putting the payload in the textarea', async () => {
    const submit = vi.fn((_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => lifecycle?.onAccepted());
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    const payload = '中文🙂 {"line":"value"}\r\n'.repeat(18000);
    fireEvent.change(input, { target: { value: 'before REPLACE after' } });
    input.setSelectionRange(7, 14);
    const paste = (text: string) => fireEvent.paste(input, { clipboardData: { files: [], getData: (type: string) => type === 'text/plain' ? text : '<b>do not parse large HTML</b>' } });
    paste(payload);
    expect(input.value).toBe('');
    expect(screen.getByRole('button', { name: 'Remove pasted text' })).toBeVisible();
    fireEvent.change(input, { target: { value: '\nfollow up' } });
    input.setSelectionRange(1, 7);
    const second = 'second'.repeat(1200);
    paste(second);
    fireEvent.change(input, { target: { value: '\nlast question' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0].msg).toBe('before ' + payload + ' after\n' + second + ' up\nlast question');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove pasted text' })).toBeNull());
    expect(input.value).toBe('');
  });

  it('retains the complete collapsed draft after rejection and allows removing only its text block', async () => {
    const submit = vi.fn((_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => lifecycle?.onRejectedBeforeAcceptance());
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    const payload = '[Pasted Content 1000 chars]\n'.repeat(200);
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => payload } });
    fireEvent.change(input, { target: { value: 'keep this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0].msg).toBe(payload + 'keep this');
    expect(input.value).toBe('keep this');
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted text' }));
    expect(input.value).toBe('keep this');
    expect(screen.queryByRole('button', { name: 'Remove pasted text' })).toBeNull();
  });
});

describe('workspace images added to the composer', () => {
  it('sends sampled video images with their inspection scope through the composer', async () => {
    const submit = vi.fn();
    render(<ChatInput sessionId="video-evidence" chatState={ChatState.Idle}
      handleSubmit={submit} onStop={vi.fn()} setView={vi.fn()} droppedFiles={[{
        id: 'video', name: 'sample.mp4', path: '/sample.mp4', type: 'video/mp4',
        isImage: false, isVideo: true,
        frameDataUrls: ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='],
        videoSample: { durationSeconds: 10, timestampsSeconds: [0.25, 9.75] },
      }]} />, { wrapper: IntlTestWrapper });
    expect(screen.getByText('2 sampled frames · audio not analyzed')).toBeVisible();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Describe the clip' } });
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const sent = submit.mock.calls[0][0];
    expect(sent.msg).toContain('[Video inspection scope]');
    expect(sent.msg).toContain('0:09.750');
    expect(sent.msg).toContain('"audioAnalyzed":false');
    expect(sent.images.map((image: { data: string }) => image.data)).toEqual(['YQ==', 'Yg==']);
  });

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      }
    );
    vi.mocked(getSessionExtensions).mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('waits for the loaded main composer before acknowledging a pet draft', async () => {
    const submit = vi.fn(), received = vi.fn();
    const delivery = deliverMainConversationMessage('cold-main', { msg: 'cold draft', images: [], composerAction: 'add' }).then(received);
    const props = { sessionId: 'cold-main', handleSubmit: submit, setView: vi.fn(), initialValue: '' };
    const view = render(<ChatInput {...props} sessionLoaded={false} chatState={ChatState.LoadingConversation} />, { wrapper: IntlTestWrapper });
    await act(async () => {});
    expect(received).not.toHaveBeenCalled();
    view.rerender(<ChatInput {...props} sessionLoaded chatState={ChatState.Idle} />);
    await act(async () => { await delivery; });
    expect(screen.getByTestId('chat-input')).toHaveValue('cold draft');
    expect(received).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('accepts an early pet picker draft after initialization without queueing or sending', async () => {
    const submit = vi.fn();
    const delivery = deliverMainConversationMessage('queue-test', { msg: 'pet draft', images: [], composerAction: 'add' });
    const view = setup(submit, undefined, false, false, { initialValue: 'existing draft' });
    await act(async () => { await delivery; });
    expect(screen.getByTestId('chat-input')).toHaveValue('existing draft\npet draft');
    await act(async () => { await deliverMainConversationMessage('queue-test', { msg: '', images: [], composerAction: 'plan' }); });

    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([]);
  });

  it('persists pet main conversation messages while busy and drains them in order once idle', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => lifecycle?.onAccepted());
    const view = setup(submit);
    await act(async () => {
      await Promise.all(Array.from({ length: 3 }, () => deliverMainConversationMessage('queue-test', { msg: 'pet first', images: [], messageId: 'pet-delivery-first' })));
      await deliverMainConversationMessage('queue-test', { msg: 'pet second', images: [] });
    });
    expect(submit).not.toHaveBeenCalled();
    const saved = new QueuedMessageStorage(localStorage, 'queue-test').read();
    expect(saved.map(message => message.content)).toEqual(['pet first', 'pet second']);
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls.map(([input]) => input.msg)).toEqual(['pet first', 'pet second']);
    expect(submit.mock.calls[0][0].messageId).toBe('pet-delivery-first');
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([]);
  });

  it('keeps the image as a draft until Send and never transfers it into another session', async () => {
    const normalize = vi
      .spyOn(conversion, 'compressImageDataUrl')
      .mockResolvedValue('data:image/png;base64,aGVsbG8=');
    const submit = vi.fn();
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    try {
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(ATTACH_WORKSPACE_IMAGE, {
            detail: {
              sessionId: 'foreign',
              name: 'sun.png',
              dataUrl: 'data:image/png;base64,aGVsbG8=',
            },
          })
        );
      });
      expect(normalize).not.toHaveBeenCalled();
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(ATTACH_WORKSPACE_IMAGE, {
            detail: {
              sessionId: 'queue-test',
              name: 'sun.png',
              dataUrl: 'data:image/png;base64,aGVsbG8=',
            },
          })
        );
      });
      expect(screen.getByRole('button', { name: 'Remove image' })).toBeVisible();
      expect(submit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('img').closest('button')!);
      expect(screen.getByRole('dialog')).toBeVisible();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Remove image' })).toBeVisible();
      expect(submit).not.toHaveBeenCalled();
      view.changeSession('new-session');
      expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
      expect(submit).not.toHaveBeenCalled();
    } finally {
      normalize.mockRestore();
    }
  });
  it('enforces the existing image limit even when menu actions arrive before a render', async () => {
    const normalize = vi
      .spyOn(conversion, 'compressImageDataUrl')
      .mockResolvedValue('data:image/png;base64,aGVsbG8=');
    const submit = vi.fn();
    setup(submit);
    try {
      await act(async () => {
        for (let i = 0; i < 11; i++)
          window.dispatchEvent(
            new CustomEvent(ATTACH_WORKSPACE_IMAGE, {
              detail: {
                sessionId: 'queue-test',
                name: 'sun.png',
                dataUrl: 'data:image/png;base64,aGVsbG8=',
              },
            })
          );
      });
      expect(screen.getAllByRole('button', { name: 'Remove image' })).toHaveLength(8);
      expect(screen.getByText(/already has 8 images; you are adding 1, but the limit is 8/)).toBeVisible();
      vi.useFakeTimers();
      try {
        // Repeated attempts restart the short notice without leaving a sticky banner.
        act(() => window.dispatchEvent(new CustomEvent(ATTACH_WORKSPACE_IMAGE, { detail: { sessionId: 'queue-test', name: 'extra.png', dataUrl: 'data:image/png;base64,aGVsbG8=' } })));
        act(() => vi.advanceTimersByTime(12000));
        expect(screen.queryByText(/already has 8 images; you are adding 1, but the limit is 8/)).toBeNull();
      } finally { vi.useRealTimers(); }
      expect(submit).not.toHaveBeenCalled();
    } finally {
      normalize.mockRestore();
    }
  });
});

describe('compact queue presentation', () => {
  const item = { id: 'first', content: 'First queued request', timestamp: 1, images: [] };
  it('keeps a large queued message compact and preserves its complete text when edited', () => {
    const text = '中文🙂\n'.repeat(24000);
    const editMessage = vi.fn();
    const view = render(<MessageQueue queuedMessages={[{ ...item, content: text }]} onRemoveMessage={vi.fn()} onClearQueue={vi.fn()} onEditMessage={editMessage} />, { wrapper: IntlTestWrapper });
    expect(view.container.textContent!.length).toBeLessThan(1000);
    fireEvent.click(screen.getByRole('button', { name: /中文🙂/ }));
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(editor.value).toBe('');
    fireEvent.change(editor, { target: { value: '\nextra instruction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(editMessage).toHaveBeenCalledWith(item.id, text + '\nextra instruction');
  });
  it('shows one waiting message directly without an expand control', () => {
    render(
      <MessageQueue queuedMessages={[item]} onRemoveMessage={vi.fn()} onClearQueue={vi.fn()} />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByText(item.content)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Expand queue' })).toBeNull();
    expect(screen.queryByText('Queue Paused')).toBeNull();
  });
  it('leaves editing when its message is removed and keeps the remaining row accessible', async () => {
    const editing = { current: null as string | null };
    const remove = vi.fn();
    const props = {
      onRemoveMessage: remove,
      onClearQueue: vi.fn(),
      onSendNow: vi.fn(),
      onEditMessage: vi.fn(),
      editingMessageIdRef: editing,
    };
    const second = { ...item, id: 'second', content: 'Remaining message' };
    const view = render(<MessageQueue {...props} queuedMessages={[item, second]} />, {
      wrapper: IntlTestWrapper,
    });
    await userEvent.click(screen.getByText(item.content));
    expect(sendNow()).toBeDisabled();
    expect(editing.current).toBe(item.id);
    await userEvent.click(screen.getAllByTitle('Remove this message from queue')[0]);
    expect(remove).toHaveBeenCalledWith(item.id);
    view.rerender(<MessageQueue {...props} queuedMessages={[second]} />);
    await waitFor(() => expect(editing.current).toBeNull());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand queue' })).toBeNull();
    expect(screen.getByText(second.content)).toBeVisible();
    expect(sendNow()).toBeEnabled();
  });
  it('shows queued rows by default and lets the user collapse and reopen them', async () => {
    const send = vi.fn();
    render(
      <MessageQueue
        queuedMessages={[item, { ...item, id: 'second', content: 'Second queued request' }]}
        onRemoveMessage={vi.fn()}
        onClearQueue={vi.fn()}
        onSendNow={send}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.queryByText('Message Queue')).toBeNull();
    expect(screen.getByText('Second queued request')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse queue' }));
    expect(screen.queryByText('Second queued request')).toBeNull();
    expect(screen.getByText('2 messages queued')).toBeVisible();
    const action = screen.getByRole('button', { name: 'Send all now' });
    expect(action).toHaveAttribute('title', 'Send all waiting messages together now');
    await userEvent.click(action);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith();
    expect(screen.queryByText('Message Queue')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Expand queue' }));
    expect(screen.getByText('2 messages queued')).toBeVisible();
    expect(screen.getByText('Second queued request')).toBeVisible();
    expect(screen.queryByText('Queue Paused')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Send all now' })).toHaveLength(1);
  });

  it('keeps cancellation feedback inline without flashing a paused banner or delivery warning', () => {
    const view = render(
      <MessageQueue
        queuedMessages={[item]}
        onRemoveMessage={vi.fn()}
        onClearQueue={vi.fn()}
        onSendNow={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );
    view.rerender(
      <MessageQueue
        queuedMessages={[item]}
        onRemoveMessage={vi.fn()}
        onClearQueue={vi.fn()}
        onSendNow={vi.fn()}
        isPaused
        waitingMessageId="first"
        blockedReason="Waiting for cancellation"
      />
    );
    expect(screen.queryByText('Messages kept. Send now when you are ready.')).toBeNull();
    expect(screen.queryByText('Paused')).toBeNull();
    expect(
      screen.queryByText('Sending result unknown. Check the conversation before retrying.')
    ).toBeNull();
    expect(screen.getByLabelText('Waiting for cancellation')).toBeVisible();
    expect(screen.getByText('First queued request')).toBeVisible();
  });

  it('keeps an uncertain delivery and its confirmation controls directly visible', async () => {
    const confirmNotSent = vi.fn();
    render(
      <MessageQueue
        queuedMessages={[{ ...item, delivery: 'submitting' }]}
        onRemoveMessage={vi.fn()}
        onClearQueue={vi.fn()}
        onSendNow={vi.fn()}
        onConfirmNotSent={confirmNotSent}
        isPaused
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(
      screen.getByText('Sending result unknown. Check the conversation before retrying.')
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: 'Confirmed sent: remove' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmed not sent: queue again' }));
    expect(confirmNotSent).toHaveBeenCalledOnce();
    expect(confirmNotSent).toHaveBeenCalledWith('first');
  });
});

describe('ChatInput queue delivery', () => {
  it('keeps referenced conversations as chips across rejection and submits their canonical URI on retry', async () => {
    const reference = conversationMention('native-source', 'Previous task').trim();
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onRejectedBeforeAcceptance()
    );
    const view = setup(submit, undefined, false, false, { initialValue: `Continue work\n${reference}` });
    view.changeState(ChatState.Idle);
    const input = screen.getByTestId('chat-input');
    expect(input).toHaveValue('Continue work');
    expect(screen.getByRole('button', { name: 'Remove reference: Previous task' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe(`Continue work\n${reference}`);
    expect(input).toHaveValue('Continue work');
    expect(screen.getByRole('button', { name: 'Remove reference: Previous task' })).toBeVisible();
    submit.mockImplementation(async (_input, lifecycle) => lifecycle?.onAccepted());
    fireEvent.change(input, { target: { value: 'Continue with the new requirement' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0].msg).toBe(`Continue with the new requirement\n${reference}`);
    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remove reference: Previous task' })).toBeNull();
  });

  it('preserves a reference-only message through queue persistence and reload', async () => {
    const reference = conversationMention('native-source', 'Previous task').trim();
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => lifecycle?.onAccepted());
    const view = setup(submit, undefined, false, false, { initialValue: reference });
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter' });
    await waitFor(() => expect(new QueuedMessageStorage(localStorage, 'queue-test').read()[0]?.content).toBe(reference));
    expect(screen.queryByRole('button', { name: 'Remove reference: Previous task' })).toBeNull();
    view.unmount();
    const restored = setup(submit);
    restored.changeState(ChatState.Idle);
    await userEvent.click(sendNow());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe(reference);
  });

  it('persists the original desktop generation and keeps it on automatic delivery after Escape', async () => {
    updateDesktopOwnership({ paused: false, revision: null, generation: 'before', owner: null, queue: [] });
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => lifecycle?.onAccepted());
    const initial = setup(submit);
    await queue('Observe then complete independent work');
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()[0].desktopGeneration).toBe('before');
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()[0].queuedWhileBusy).toBe(true);
    updateDesktopOwnership({ paused: true, revision: 'escape', generation: 'escape', pauseReason: 'escape', owner: null, queue: [] });
    initial.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0]).toMatchObject({ msg: 'Observe then complete independent work', desktopGeneration: 'before', queuedWhileBusy: true });
    updateDesktopOwnership({ paused: false, revision: null, generation: '', owner: null, queue: [] });
  });
  it.each([true, false])('delivers a supplement to a running tool through native steering; accepted=%s', async accepted => {
    updateDesktopOwnership({ paused: false, revision: null, generation: '', owner: null, queue: [] });
    const submit = vi.fn();
    const steer = vi.fn(async (_input: UserInput) => accepted);
    const running: Message = {
      id: 'running-assistant', role: 'assistant', created: 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [{ type: 'toolRequest', id: 'running-tool', toolCall: { name: 'pwsh', arguments: {} }, metadata: { status: 'in_progress' } }],
    };
    const view = setup(submit, steer, false, false, { messages: [running], automaticSteeringAllowed: true });
    view.changeBlocked(true); // A real prompt is active; only ordinary delivery is blocked.
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Add a file after this tool' } });
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter' });
    await waitFor(() => expect(steer).toHaveBeenCalledOnce());
    expect(steer.mock.calls[0][0]).toMatchObject({ msg: 'Add a file after this tool', queuedWhileBusy: true });
    await waitFor(() => expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toHaveLength(accepted ? 0 : 1));
    view.changeState(ChatState.Idle);
    await act(async () => {});
    expect(submit).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledOnce();
  });
  it('does not mistake a discovery tool response for new human input when the next pending tool shares its assistant message', async () => {
    updateDesktopOwnership({ paused: false, revision: null, generation: '', owner: null, queue: [] });
    const steer = vi.fn(async () => true), submit = vi.fn();
    const original: Message = { id: 'original', role: 'user', created: 1, metadata: { userVisible: true, agentVisible: true }, content: [{ type: 'text', text: 'Run the command' }] };
    const tools: Message = { id: 'tool-batch', role: 'assistant', created: 2, metadata: { userVisible: true, agentVisible: true }, content: [
      { type: 'toolRequest', id: 'discover', toolCall: { name: 'search_mcp_tools', arguments: {} }, metadata: { status: 'completed' } },
      { type: 'toolRequest', id: 'execute', toolCall: { name: 'pwsh', arguments: {} }, metadata: { status: 'in_progress' } },
    ] };
    const discovery: Message = { id: 'tool-reply', role: 'user', created: 3, metadata: { userVisible: true, agentVisible: true }, content: [
      { type: 'toolResponse', id: 'discover', toolResult: { status: 'success' } },
    ] };
    const view = setup(submit, steer, false, false, { messages: [original, tools, discovery], automaticSteeringAllowed: true });
    view.changeBlocked(true);
    await queue('After that command, add one file');
    await waitFor(() => expect(steer).toHaveBeenCalledOnce());
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(['historical', 'returned', 'paused', 'stale', 'cancelled'] as const)('does not automatically steer through a %s tool boundary', async boundary => {
    updateDesktopOwnership({ paused: boundary === 'paused', revision: null, generation: 'current', owner: null, queue: [] });
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => lifecycle?.onAccepted());
    const steer = vi.fn(async () => true);
    const tool: Message = { id: 'tool-message', role: 'assistant', created: 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [{ type: 'toolRequest', id: 'old-tool', toolCall: { name: 'pwsh', arguments: {} }, metadata: { status: 'in_progress' } }] };
    const currentUser: Message = { id: 'current-user', role: 'user', created: 2,
      metadata: { userVisible: true, agentVisible: true }, content: [{ type: 'text', text: 'Current work' }] };
    const messages = boundary === 'historical' ? [tool, currentUser] : [currentUser, tool];
    if (boundary === 'returned') tool.content.push({ type: 'toolResponse', id: 'old-tool', toolResult: { status: 'success' } });
    if (boundary === 'stale') {
      const storage = new QueuedMessageStorage(localStorage, 'queue-test'); storage.read();
      storage.write([{ id: 'stale', content: 'Kept input', images: [], timestamp: 1, queuedWhileBusy: true, desktopGeneration: 'old' }]);
    }
    const view = setup(submit, steer, false, false, { messages, automaticSteeringAllowed: boundary !== 'cancelled' });
    view.changeBlocked(true);
    if (boundary !== 'stale') await queue('Kept input');
    const saved = screen.queryByRole('button', { name: 'Expand saved drafts' });
    if (saved) fireEvent.click(saved);
    await screen.findByText('Kept input');
    await act(async () => {});
    expect(steer).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    view.unmount();
    updateDesktopOwnership({ paused: false, revision: null, generation: '', owner: null, queue: [] });
  });
  it('snapshots all waiting messages for Send now, waits for an idle turn when steering is unavailable, then resumes later ordinary input', async () => {
    const pending = deferred<void>();
    let lifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, callbacks?: MessageSubmissionLifecycle) => {
      lifecycle = callbacks!;
      return pending.promise;
    });
    const view = setup(submit);
    await queue('first supplement');
    await queue('second supplement');
    view.changeBlocked(true);
    await userEvent.click(sendNow());
    expect(view.onStop).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([
      expect.objectContaining({ content: 'first supplement\n\nsecond supplement' }),
    ]);
    await queue('arrived after the click');
    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
    view.changeBlocked(false);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe('first supplement\n\nsecond supplement');
    act(() => lifecycle.onAccepted());
    view.changeState(ChatState.Streaming);
    await act(async () => pending.resolve());
    expect(submit).toHaveBeenCalledOnce();
    submit.mockImplementation(async (_input, callbacks) => callbacks?.onAccepted());
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0].msg).toBe('arrived after the click');
  });

  it('preserves merged text and image order after rejection and reload without automatically retrying', async () => {
    const first = { data: 'Zmlyc3Q=', mimeType: 'image/png' };
    const second = { data: 'c2Vjb25k', mimeType: 'image/png' };
    new QueuedMessageStorage(localStorage, 'queue-test').read();
    const storage = new QueuedMessageStorage(localStorage, 'queue-test');
    storage.read();
    storage.write([
      { id: 'a', content: 'image A', timestamp: 1, images: [first] },
      { id: 'b', content: 'image B', timestamp: 2, images: [second] },
    ]);
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onRejectedBeforeAcceptance()
    );
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
    await userEvent.click(sendNow());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0]).toMatchObject({
      msg: 'image A\n\nimage B',
      images: [first, second],
    });
    await screen.findByRole('button', { name: 'Expand saved drafts' });
    view.unmount();
    const restored = setup(submit);
    restored.changeState(ChatState.Idle);
    expect(submit).toHaveBeenCalledOnce();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([
      expect.objectContaining({
        content: 'image A\n\nimage B',
        images: [first, second],
        delivery: 'pending',
      }),
    ]);
  });

  it('never includes an unknown delivery in an explicit batch or automatically replays it afterwards', async () => {
    const storage = new QueuedMessageStorage(localStorage, 'queue-test');
    storage.read();
    storage.write([
      {
        id: 'unknown',
        content: 'possibly already sent',
        timestamp: 1,
        images: [],
        delivery: 'submitting',
      },
      { id: 'a', content: 'waiting A', timestamp: 2, images: [] },
      { id: 'b', content: 'waiting B', timestamp: 3, images: [] },
    ]);
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const view = setup(submit);
    await userEvent.click(sendNow());
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe('waiting A\n\nwaiting B');
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([
      expect.objectContaining({
        id: 'unknown',
        content: 'possibly already sent',
        delivery: 'submitting',
      }),
    ]);
    expect(
      screen.getByText('Sending result unknown. Check the conversation before retrying.')
    ).toBeVisible();
  });

  it('an explicit Stop revokes the pending Send now without losing its text', async () => {
    const submit = vi.fn();
    const view = setup(submit, undefined, false, true);
    await queue('supplement A');
    await queue('supplement B');
    view.changeBlocked(true);
    await userEvent.click(sendNow());
    expect(screen.queryByRole('button', { name: '按住说话' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    view.changeState(ChatState.Idle);
    view.changeBlocked(false);
    expect(submit).not.toHaveBeenCalled();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([
      expect.objectContaining({ content: 'supplement A\n\nsupplement B' }),
    ]);
  });

  it.each(['accepted', 'rejected', 'uncertain', 'switched'] as const)(
    'resumes reading only for an accepted explicit send in the same view: %s',
    async (outcome) => {
      const pending = deferred<void>();
      let receipt!: MessageSubmissionLifecycle;
      const submit = vi.fn((_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
        receipt = lifecycle!;
        return pending.promise;
      });
      const follow = vi.fn();
      const view = setup(submit, undefined, false, false, { onSubmissionAccepted: follow });
      view.changeState(ChatState.Idle);
      const input = screen.getByTestId('chat-input');
      fireEvent.change(input, { target: { value: 'explicit new message' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(submit).toHaveBeenCalledOnce());
      expect(follow).not.toHaveBeenCalled();
      if (outcome === 'switched') view.changeSession('another-session');
      act(() => {
        if (outcome === 'rejected') receipt.onRejectedBeforeAcceptance();
        else if (outcome === 'uncertain') receipt.onDeliveryUncertain?.();
        else {
          receipt.onAccepted();
          receipt.onAccepted();
        }
      });
      expect(follow).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
      await act(async () => pending.resolve());
    }
  );

  it('keeps reading position when an automatically queued message is accepted', async () => {
    const follow = vi.fn();
    const submit = vi.fn((_input: UserInput, receipt?: MessageSubmissionLifecycle) =>
      receipt?.onAccepted()
    );
    const view = setup(submit, undefined, false, false, { onSubmissionAccepted: follow });
    await queue('automatic delivery must not scroll');
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(follow).not.toHaveBeenCalled();
  });

  it('clears the received draft before the turn finishes and leaves later input intact', async () => {
    const pending = deferred<void>();
    let lifecycle!: MessageSubmissionLifecycle;
    const view = setup((_input, callbacks) => {
      lifecycle = callbacks!;
      return pending.promise;
    });
    view.changeState(ChatState.Idle);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'received message' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    expect(input).toHaveValue('received message');
    await waitFor(() => expect(lifecycle).toBeDefined());
    act(() => lifecycle.onAccepted());
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'next draft' } });
    await act(async () => pending.resolve());
    expect(input).toHaveValue('next draft');
  });

  it('keeps the draft when a submission is rejected before any receipt', async () => {
    const view = setup(async (_input, callbacks) => callbacks?.onRejectedBeforeAcceptance());
    view.changeState(ChatState.Idle);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'unsent message' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(input).toHaveValue('unsent message'));
  });

  it('does not offer the submitted draft again while acceptance is pending, but keeps a newer interjection usable', async () => {
    const pending = deferred<void>();
    let lifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, callbacks?: MessageSubmissionLifecycle) => {
      lifecycle = callbacks!;
      return pending.promise;
    });
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'submit once' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    view.changeState(ChatState.Thinking);
    expect(input).toHaveValue('submit once');
    expect(screen.getByRole('button', { name: /^Stop$/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Send$/ })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([]);
    expect(submit).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: 'new interjection' } });
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Stop$/ })).toBeNull();
    act(() => lifecycle.onAccepted());
    expect(input).toHaveValue('new interjection');
    await act(async () => pending.resolve());
  });

  it('opens goal editing in the side panel without replacing the message draft', async () => {
    const goal = {
      id: 'saved',
      revision: 4,
      phase: 'paused' as const,
      activation: 'disarmed' as const,
      objective: 'Original goal',
      roundsStarted: 1,
      maxGoalRounds: 256,
    };
    vi.mocked(getSessionGoal).mockResolvedValue(goal);
    const opened = vi.fn();
    window.addEventListener(OPEN_GOAL_EDITOR, opened);
    const view = setup(vi.fn());
    view.changeState(ChatState.Idle);
    const textarea = screen.getByTestId('chat-input');
    fireEvent.change(textarea, { target: { value: 'Keep my message' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit goal' }));
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'queue-test' });
    expect(textarea).toHaveValue('Keep my message');
    expect(screen.queryByRole('button', { name: 'Cancel command input' })).not.toBeInTheDocument();
    window.removeEventListener(OPEN_GOAL_EDITOR, opened);
  });
  it('preserves an unrelated draft when pausing from the compact goal bar', async () => {
    const goal = {
      id: 'saved',
      revision: 4,
      phase: 'active' as const,
      activation: 'armed' as const,
      objective: 'Ship',
      roundsStarted: 1,
      maxGoalRounds: 256,
    };
    vi.mocked(getSessionGoal).mockResolvedValue(goal);
    vi.mocked(pauseSessionGoal).mockResolvedValue({
      ...goal,
      phase: 'paused',
      activation: 'disarmed',
    });
    setup(vi.fn());
    const textarea = screen.getByTestId('chat-input');
    fireEvent.change(textarea, { target: { value: 'Keep this draft' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Pause goal' }));
    await screen.findByText('Goal paused. Use /goal resume to continue.');
    expect(textarea).toHaveValue('Keep this draft');
  });
  it('can pause a resumed goal before its model prompt settles and never queues the command', async () => {
    const goal = {
      id: 'saved',
      revision: 4,
      phase: 'paused' as const,
      activation: 'disarmed' as const,
      objective: 'Ship',
      roundsStarted: 1,
      maxGoalRounds: 20,
    };
    vi.mocked(getSessionGoal).mockResolvedValue(goal);
    vi.mocked(pauseSessionGoal).mockResolvedValue(goal);
    const pending = deferred<void>();
    const submit = vi.fn((_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
      lifecycle?.onAccepted();
      return pending.promise;
    });
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    const textarea = screen.getByTestId('chat-input');
    fireEvent.change(textarea, { target: { value: '/goal resume' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(textarea).toHaveValue('');
    view.changeState(ChatState.Thinking);
    fireEvent.change(textarea, { target: { value: '/goal pause' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(pauseSessionGoal).toHaveBeenCalledWith('queue-test', goal));
    expect(screen.queryByText('Message Queue')).toBeNull();
    await act(async () => pending.resolve());
  });

  it('preserves a failed control command and ignores Enter while composing Chinese text', async () => {
    vi.mocked(getSessionGoal).mockRejectedValue(new Error('offline'));
    const submit = vi.fn();
    setup(submit);
    const textarea = screen.getByTestId('chat-input');
    fireEvent.change(textarea, { target: { value: '/goal pause' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await screen.findByText(/The command did not complete/);
    expect(textarea).toHaveValue('/goal pause');
  });
  it('keeps pending input paused after Stop and sends it once on explicit resume', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const view = setup(submit, undefined, false, true);
    await queue('preserve pending request');
    await userEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    expect(view.onStop).toHaveBeenCalledOnce();
    view.changeState(ChatState.Idle);
    await screen.findByRole('button', { name: 'Expand saved drafts' });
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand saved drafts' }));
    expect(screen.getByText('preserve pending request')).toBeVisible();
    await userEvent.click(sendNow());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe('preserve pending request');
    expect(screen.queryByText('preserve pending request')).toBeNull();
  });

  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    updateDesktopOwnership({ paused: false, revision: null, generation: '', owner: null, queue: [] });
    selection.item = null;
    vi.mocked(getSessionExtensions).mockReset().mockResolvedValue([]);
    vi.mocked(addSessionExtension).mockReset().mockResolvedValue(undefined);
    vi.mocked(getSessionGoal).mockResolvedValue(null);
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      }
    );
  });

  it.each(['skill', 'external', 'builtin'] as const)(
    'uses a slash %s in the composer without navigating or sending',
    async (kind) => {
      selection.item = {
        id: kind + ':test',
        kind,
        source: kind === 'skill' ? 'source' : 'extension',
        name: 'test-tool',
        description: '',
        status: 'ready',
        actions: ['inspect'],
        ...(kind === 'skill'
          ? {}
          : {
              extensionSource: {
                type: 'builtin',
                name: 'test-tool',
                description: '',
                enabled: false,
              } as const,
            }),
      };
      const setView = vi.fn();
      const submit = vi.fn();
      render(
        <ChatInput
          sessionId="slash-test"
          handleSubmit={submit}
          setView={setView}
          chatState={ChatState.Idle}
        />,
        { wrapper: IntlTestWrapper }
      );
      const input = screen.getByRole('textbox');
      await userEvent.type(input, '/');
      await userEvent.click(await screen.findByText('Select toolbox item'));
      await waitFor(() =>
        expect(input).toHaveValue(
          kind === 'skill' ? 'Use the test-tool skill to: ' : 'Use test-tool to: '
        )
      );
      expect(setView).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(addSessionExtension).toHaveBeenCalledTimes(kind === 'skill' ? 0 : 1);
    }
  );

  it('preserves the slash draft when the selected MCP fails to connect', async () => {
    selection.item = {
      id: 'external:test',
      kind: 'external',
      source: 'extension',
      name: 'test-tool',
      description: '',
      status: 'configured',
      actions: ['configure'],
      extensionSource: { type: 'builtin', name: 'test-tool', description: '', enabled: true },
    };
    vi.mocked(addSessionExtension).mockRejectedValue(new Error('connection failed'));
    const setView = vi.fn();
    render(
      <ChatInput
        sessionId="slash-failure"
        handleSubmit={vi.fn()}
        setView={setView}
        chatState={ChatState.Idle}
      />,
      { wrapper: IntlTestWrapper }
    );
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '/');
    await userEvent.click(await screen.findByText('Select toolbox item'));
    await screen.findByText(
      'The tool could not be loaded. Your draft is preserved; check its configuration and try again.'
    );
    expect(input).toHaveValue('/');
    expect(setView).not.toHaveBeenCalled();
  });

  it('keeps file attachment reachable when the workspace panel narrows the composer', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: (entries: { contentRect: { width: number } }[]) => void) {}
        observe() {
          this.callback([{ contentRect: { width: 360 } }]);
        }
        disconnect() {}
        unobserve() {}
      }
    );
    render(
      <ChatInput
        sessionId="narrow-composer"
        handleSubmit={vi.fn()}
        onStop={vi.fn()}
        setView={vi.fn()}
        chatState={ChatState.Thinking}
        modelToolbarSlot={<button>Approval mode</button>}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'unsent draft' } });
    expect(screen.getByRole('button', { name: '添加附件或功能' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approval mode' })).toBeVisible();
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Stop$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Model selector' })).toBeVisible();
  });

  it('restores unsent messages paused after the conversation is remounted', async () => {
    const submit = vi.fn();
    const first = setup(submit, undefined, false, true);
    await queue('survive renderer reload');
    first.unmount();
    const restored = setup(submit, undefined, false, true);
    restored.changeState(ChatState.Idle);
    await screen.findByRole('button', { name: 'Expand saved drafts' });
    expect(screen.getByText('1 saved draft')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()[0].content).toBe(
      'survive renderer reload'
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['stop', 'reload'] as const)(
    'holds multiple queued inputs as collapsed drafts after %s, edits safely and sends only explicitly',
    async (operation) => {
      const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
        lifecycle?.onAccepted()
      );
      const steer = vi.fn(async () => true);
      let view = setup(submit, steer, false, true);
      await queue('草稿甲：17×23');
      await queue('草稿乙：保留换行\n第二行');
      const original = new QueuedMessageStorage(localStorage, 'queue-test').read();
      if (operation === 'stop') {
        await userEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
        view.changeBlocked(true);
      } else {
        view.unmount();
        view = setup(submit, steer, false, true);
      }
      expect(screen.getByTestId('saved-message-drafts')).toBeVisible();
      expect(screen.queryByTestId('message-queue')).toBeNull();
      expect(screen.getByText('2 saved drafts')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Send all now' })).toBeNull();
      expect(screen.queryByText('草稿甲：17×23')).toBeNull();
      expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual(original);
      fireEvent.click(screen.getByRole('button', { name: 'Expand saved drafts' }));
      expect(screen.getByRole('button', { name: 'Send saved drafts' })).toBeDisabled();
      view.changeState(ChatState.Idle);
      view.changeBlocked(false);
      expect(submit).not.toHaveBeenCalled();
      expect(steer).not.toHaveBeenCalled();
      await userEvent.click(screen.getByText('草稿甲：17×23'));
      const editor = screen
        .getAllByRole('textbox')
        .find((node) => node !== screen.getByTestId('chat-input'))!;
      fireEvent.change(editor, { target: { value: '草稿甲：已编辑，17×23' } });
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(submit).not.toHaveBeenCalled();
      const edited = new QueuedMessageStorage(localStorage, 'queue-test').read();
      expect(edited).toEqual([{ ...original[0], content: '草稿甲：已编辑，17×23' }, original[1]]);
      await userEvent.click(screen.getByRole('button', { name: 'Send saved drafts' }));
      await waitFor(() => expect(submit).toHaveBeenCalledOnce());
      expect(submit.mock.calls[0][0].msg).toBe('草稿甲：已编辑，17×23\n\n草稿乙：保留换行\n第二行');
      expect(steer).not.toHaveBeenCalled();
      expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([]);
    }
  );

  it('restores an uncertain submission blocked until the user checks it', async () => {
    const pending = deferred<void>();
    const submit = vi.fn(() => pending.promise);
    const first = setup(submit);
    await queue('check delivery');
    first.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    first.unmount();
    const restored = setup(submit);
    restored.changeState(ChatState.Idle);
    await screen.findByText('check delivery');
    expect(sendNow()).toBeDisabled();
    expect(submit).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmed sent: remove' }));
    expect(screen.queryByText('check delivery')).toBeNull();
    expect(submit).toHaveBeenCalledOnce();
    await act(async () => pending.resolve());
  });

  it('does not restore a message after its acceptance receipt', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const first = setup(submit);
    await queue('accepted once');
    first.changeState(ChatState.Idle);
    await waitFor(() => expect(screen.queryByText('accepted once')).toBeNull());
    first.unmount();
    const restored = setup(submit);
    restored.changeState(ChatState.Idle);
    expect(screen.queryByText('accepted once')).toBeNull();
    expect(submit).toHaveBeenCalledOnce();
  });

  it('removes an accepted queued send from its original session after switching conversations', async () => {
    const pending = deferred<void>();
    let lifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, callbacks?: MessageSubmissionLifecycle) => {
      lifecycle = callbacks!;
      return pending.promise;
    });
    const view = setup(submit);
    await queue('accepted in the original conversation');
    fireEvent.click(sendNow());
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    view.changeSession('another-session');
    act(() => lifecycle.onAccepted());
    await act(async () => pending.resolve());
    view.changeSession('queue-test');
    expect(screen.queryByText('accepted in the original conversation')).toBeNull();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([]);
  });

  it('keeps an unsaved queue in memory and blocks dispatch on storage failure', async () => {
    const submit = vi.fn();
    const view = setup(submit);
    const fail = vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      await queue('do not lose this request');
      expect(screen.getByRole('alert')).toHaveTextContent('could not be saved or restored');
      view.changeState(ChatState.Idle);
      expect(submit).not.toHaveBeenCalled();
      expect(screen.getByText('do not lose this request')).toBeVisible();
    } finally {
      fail.mockRestore();
    }
  });

  it('restores image bytes and submits them only after explicit send', async () => {
    const images = [{ data: 'aW1hZ2U=', mimeType: 'image/png' }];
    const storage = new QueuedMessageStorage(localStorage, 'queue-test');
    storage.read();
    storage.write([
      { id: 'image-queue', content: 'inspect restored image', timestamp: 123, images },
    ]);
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const view = setup(submit);
    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
    await userEvent.click(sendNow());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].images).toEqual(images);
  });

  it('shows damaged snapshot failures without replacing the stored data', async () => {
    const key = 'codepro-queue:v1:queue-test';
    localStorage.setItem(key, '{damaged');
    const submit = vi.fn();
    const view = setup(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be saved or restored');
    await queue('still in this window');
    view.changeState(ChatState.Idle);
    expect(localStorage.getItem(key)).toBe('{damaged');
    expect(screen.getByText('still in this window')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
  });

  it('detects another window changing the queue before dispatch', async () => {
    const submit = vi.fn();
    const view = setup(submit);
    await queue('local pending request');
    const key = 'codepro-queue:v1:queue-test';
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        sessionId: 'queue-test',
        revision: 'other-window',
        messages: [],
      })
    );
    act(() => window.dispatchEvent(new StorageEvent('storage', { key })));
    view.changeState(ChatState.Idle);
    expect(screen.getByRole('alert')).toHaveTextContent('changed in another window');
    fireEvent.click(screen.getByRole('button', { name: 'Expand saved drafts' }));
    expect(screen.getByText('local pending request')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toContain('other-window');
  });

  it('retains an in-flight message until acceptance and does not send it twice', async () => {
    const pending = deferred<void>();
    let lifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, callbacks?: MessageSubmissionLifecycle) => {
      lifecycle = callbacks!;
      return pending.promise;
    });
    const view = setup(submit);
    await queue('queued request');
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(screen.getByText('queued request')).toBeVisible();
    expect(sendNow()).toBeDisabled();
    fireEvent.click(sendNow());
    const draft = screen.getByTestId('chat-input');
    fireEvent.change(draft, { target: { value: 'new draft while queue submits' } });
    fireEvent.keyDown(draft, { key: 'Enter' });
    expect(submit).toHaveBeenCalledOnce();
    expect(draft).toHaveValue('new draft while queue submits');
    act(() => lifecycle.onAccepted());
    expect(screen.queryByText('queued request')).toBeNull();
    await act(async () => pending.resolve());
  });

  it.each(['reject callback', 'throw', 'no acceptance'] as const)(
    'retains queued input without automatically retrying: %s',
    async (failure) => {
      const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
        if (failure === 'reject callback') lifecycle?.onRejectedBeforeAcceptance();
        if (failure === 'throw') throw new Error('provider unavailable');
      });
      const view = setup(submit);
      await queue('retry me');
      view.changeState(ChatState.Idle);
      if (failure === 'reject callback') {
        await screen.findByRole('button', { name: 'Expand saved drafts' });
        fireEvent.click(screen.getByRole('button', { name: 'Expand saved drafts' }));
      } else {
        await screen.findByText('Sending result unknown. Check the conversation before retrying.');
      }
      expect(screen.getByText('retry me')).toBeVisible();
      expect(submit).toHaveBeenCalledOnce();
      submit.mockImplementation(async (_input, lifecycle) => lifecycle?.onAccepted());
      if (failure === 'reject callback') {
        expect(sendNow()).not.toBeDisabled();
        expect(
          screen.queryByText('Sending result unknown. Check the conversation before retrying.')
        ).toBeNull();
      } else {
        expect(sendNow()).toBeDisabled();
        await userEvent.click(
          screen.getByRole('button', { name: 'Confirmed not sent: queue again' })
        );
      }
      await userEvent.click(sendNow());
      await waitFor(() => expect(screen.queryByText('retry me')).toBeNull());
      expect(submit).toHaveBeenCalledTimes(2);
    }
  );

  it('does not retry a rejected head message merely because another queued message was edited', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onRejectedBeforeAcceptance()
    );
    const view = setup(submit);
    await queue('rejected head');
    await queue('editable second');
    view.changeState(ChatState.Idle);
    await screen.findByRole('button', { name: 'Expand saved drafts' });
    expect(submit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Expand saved drafts' }));
    await userEvent.click(screen.getByText('editable second'));
    const editor = screen
      .getAllByRole('textbox')
      .find((element) => element !== screen.getByTestId('chat-input'))!;
    fireEvent.change(editor, { target: { value: 'edited second' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Collapse saved drafts' })).toBeVisible();
    expect(screen.getByText('rejected head')).toBeVisible();
    expect(screen.getByText('edited second')).toBeVisible();
  });

  it('sends the edited text after saving, never the old text when the task finishes', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const view = setup(submit);
    await queue('original queue text');
    await userEvent.click(screen.getByText('original queue text'));
    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
    const editor = screen
      .getAllByRole('textbox')
      .find((element) => element !== screen.getByTestId('chat-input'))!;
    fireEvent.change(editor, { target: { value: 'edited queue text' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe('edited queue text');
  });

  it('waits for an idle turn and acceptance without a steer handler before removing Send Now input', async () => {
    const pending = deferred<void>();
    let lifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, callbacks?: MessageSubmissionLifecycle) => {
      lifecycle = callbacks!;
      return pending.promise;
    });
    const view = setup(submit);
    await queue('queued priority request');
    await userEvent.click(sendNow());
    expect(view.onStop).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(screen.getByText('queued priority request')).toBeVisible();
    act(() => lifecycle.onAccepted());
    await act(async () => pending.resolve());
    expect(screen.queryByText('queued priority request')).toBeNull();
  });

  it('publishes a pending follow-up before release and submits that same identity only once', async () => {
    const observed = vi.fn();
    const pending = deferred<void>();
    let accepted!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
      accepted = lifecycle!;
      return pending.promise;
    });
    const anchor: Message = {
      id: 'last-output',
      role: 'assistant',
      created: 1,
      content: [{ type: 'text', text: 'Working' }],
      metadata: { userVisible: true, agentVisible: true },
    };
    const view = setup(submit, undefined, false, false, {
      messages: [anchor],
      onPendingMessageChange: observed,
    });
    await queue('Please stop and reconsider');
    view.changeBlocked(true);
    await userEvent.click(sendNow());
    const staged = observed.mock.calls.slice(-1)[0][1] as Message;
    expect(staged.metadata).toMatchObject({
      agentVisible: false,
      pendingDelivery: 'pending',
      presentation: { afterMessageId: anchor.id },
    });
    expect(view.onStop).not.toHaveBeenCalled();
    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
    view.changeBlocked(false);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0]).toMatchObject({
      messageId: staged.id,
      presentation: staged.metadata.presentation,
    });
    act(() => accepted.onAccepted());
    await act(async () => pending.resolve());
    expect(observed).toHaveBeenLastCalledWith('queue-test', undefined);
  });

  it('keeps an unaccepted pending follow-up across reload, isolates chats and reconciles a lost acknowledgement', async () => {
    const observed = vi.fn();
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onRejectedBeforeAcceptance()
    );
    const anchor: Message = {
      id: 'last-output',
      role: 'assistant',
      created: 1,
      content: [{ type: 'text', text: 'Working' }],
      metadata: { userVisible: true, agentVisible: true },
    };
    const props = { messages: [anchor], onPendingMessageChange: observed };
    const view = setup(submit, undefined, false, false, props);
    await queue('Keep this until admitted');
    await userEvent.click(sendNow());
    const staged = observed.mock.calls.slice(-1)[0][1] as Message;
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await waitFor(() => expect(observed).toHaveBeenLastCalledWith('queue-test', undefined));
    view.unmount();
    const restored = setup(submit, undefined, false, false, props);
    expect(observed).toHaveBeenLastCalledWith('queue-test', undefined);
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()[0].id).toBe(staged.id);
    restored.changeState(ChatState.Idle);
    expect(submit).toHaveBeenCalledOnce();
    restored.changeSession('another-chat');
    expect(observed).toHaveBeenLastCalledWith('another-chat', undefined);
    expect(
      observed.mock.calls.some(([owner, message]) => owner === 'another-chat' && message)
    ).toBe(false);
    restored.changeSession('queue-test');
    restored.changeMessages([
      anchor,
      { ...staged, metadata: { userVisible: true, agentVisible: true } },
    ]);
    await waitFor(() => expect(observed).toHaveBeenLastCalledWith('queue-test', undefined));
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([]);
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'keeps FIFO at ordinary completion after an earlier Stop: %s',
    async (priorStop) => {
      const observed = vi.fn();
      const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
        lifecycle?.onAccepted()
      );
      const view = setup(submit, undefined, false, true, {
        messages: [
          {
            id: 'answer',
            role: 'assistant',
            created: 1,
            metadata: { userVisible: true, agentVisible: true },
            content: [{ type: 'text', text: 'Done' }],
          },
        ],
        onPendingMessageChange: observed,
      });
      if (priorStop) {
        await userEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
        view.changeBlocked(true);
        view.changeState(ChatState.Idle);
        view.changeBlocked(false);
        view.changeState(ChatState.Thinking);
      }
      await queue('earlier queued request');
      view.changeBlocked(true);
      view.changeState(ChatState.Idle);
      await queue('later request at completion');
      expect(observed).toHaveBeenLastCalledWith('queue-test', undefined);
      expect(submit).not.toHaveBeenCalled();
      view.changeBlocked(false);
      await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
      expect(submit.mock.calls.map(([input]) => input.msg)).toEqual([
        'earlier queued request',
        'later request at completion',
      ]);
      expect(view.onStop).toHaveBeenCalledTimes(priorStop ? 1 : 0);
    }
  );

  it('drains accepted ordinary messages in order without losing the next item', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const view = setup(submit);
    await queue('first request');
    await queue('second request');
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls.map(([input]) => input.msg)).toEqual([
      'first request',
      'second request',
    ]);
    expect(screen.queryByText('Message Queue')).toBeNull();
  });

  it('[retest-20261016] defers Send Now while transport is settling without dispatching twice', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const view = setup(submit);
    await queue('replacement after stop');
    view.changeBlocked(true);
    view.changeState(ChatState.Idle);
    await userEvent.click(sendNow());
    await userEvent.click(sendNow());
    expect(view.onStop).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    view.changeBlocked(false);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe('replacement after stop');
  });

  it('steers only the selected message and drains the rest in order while collapsed', async () => {
    const steer = vi.fn(async (_input: UserInput) => true);
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => lifecycle?.onAccepted());
    const view = setup(submit, steer);
    for (const text of ['first', 'middle', 'last']) await queue(text);
    const row = screen.getByText('middle').closest('[data-queue-row]')! as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Steer' }));
    expect(steer.mock.calls.map(([input]) => input.msg)).toEqual(['middle']);
    expect(screen.queryByText('middle')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse queue' }));
    expect(screen.queryByText('last')).toBeNull();
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit.mock.calls.map(([input]) => input.msg)).toEqual(['first', 'last']));
  });

  it('steers the running turn without cancelling or waiting for its prompt RPC to finish', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const acceptance = deferred<boolean>();
    const steer = vi.fn((_input: UserInput) => acceptance.promise);
    const view = setup(submit, steer);
    await queue('supplement the current task');
    view.changeBlocked(true);
    await userEvent.click(sendNow());
    expect(view.onStop).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledOnce();
    expect(steer.mock.calls[0]?.[0]).toMatchObject({ msg: 'supplement the current task' });
    await userEvent.click(sendNow());
    expect(steer).toHaveBeenCalledOnce();
    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()[0].delivery).toBe(
      'submitting'
    );
    await act(async () => acceptance.resolve(true));
    view.changeBlocked(false);
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([]);
    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['refused', 'uncertain'] as const)(
    'keeps a %s steer without falling back to Stop or a fresh turn',
    async (outcome) => {
      const submit = vi.fn();
      const steer = vi.fn(async () => {
        if (outcome === 'uncertain') throw new Error('receipt lost');
        return false;
      });
      const view = setup(submit, steer);
      await queue('keep my reminder');
      await userEvent.click(sendNow());
      expect(steer).toHaveBeenCalledOnce();
      expect(view.onStop).not.toHaveBeenCalled();
      view.changeState(ChatState.Idle);
      expect(submit).not.toHaveBeenCalled();
      expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([
        expect.objectContaining({
          content: 'keep my reminder',
          delivery: outcome === 'uncertain' ? 'submitting' : 'pending',
        }),
      ]);
    }
  );

  it('steers a still-running accepted queued turn and keeps later ordinary input waiting', async () => {
    const running = deferred<void>();
    const submit = vi.fn((_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
      lifecycle?.onAccepted();
      return running.promise;
    });
    const steer = vi.fn(async () => true);
    const view = setup(submit, steer);
    await queue('initial queued task');
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    view.changeState(ChatState.Streaming);
    view.changeBlocked(true);
    await queue('supplement one');
    await queue('supplement two');
    await userEvent.click(sendNow());
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'supplement one\n\nsupplement two' })
    );
    expect(view.onStop).not.toHaveBeenCalled();
    await queue('next task');
    expect(submit).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenCalledOnce();
    await act(async () => running.resolve());
    view.changeState(ChatState.Idle);
    view.changeBlocked(false);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0].msg).toBe('next task');
  });

  it('keeps ordinary and stop-like text queued without cancelling until the whole request settles', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const view = setup(submit);
    await queue('stop');
    expect(view.onStop).not.toHaveBeenCalled();
    view.changeBlocked(true);
    view.changeState(ChatState.Idle);
    await queue('another request during teardown');
    expect(submit).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Waiting for the previous request to finish. Your queued message has not been sent.'
      )
    ).toBeVisible();
    view.changeBlocked(false);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls.map(([input]) => input.msg)).toEqual([
      'stop',
      'another request during teardown',
    ]);
  });

  it('waits for a queued request to finish without a steer handler without losing the next input', async () => {
    const pending = deferred<void>();
    let lifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, callbacks?: MessageSubmissionLifecycle) => {
      lifecycle = callbacks!;
      return pending.promise;
    });
    const view = setup(submit);
    await queue('first queued run');
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    act(() => lifecycle.onAccepted());
    view.changeState(ChatState.Streaming);
    view.changeBlocked(true);
    await queue('second priority run');
    await userEvent.click(sendNow());
    expect(view.onStop).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
    await userEvent.click(sendNow());
    expect(view.onStop).not.toHaveBeenCalled();
    view.changeState(ChatState.Idle);
    view.changeBlocked(false);
    expect(submit).toHaveBeenCalledOnce();
    submit.mockImplementation(async (_input, callbacks) => callbacks?.onAccepted());
    await act(async () => pending.resolve());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0].msg).toBe('second priority run');
  });

  it('keeps an unacknowledged input paused while sending only the explicit replacement', async () => {
    const pending = deferred<void>();
    let firstLifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
      firstLifecycle = lifecycle!;
      return pending.promise;
    });
    const view = setup(submit);
    await queue('unacknowledged original');
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    view.changeState(ChatState.Streaming);
    view.changeBlocked(true);
    await queue('explicit replacement');
    await userEvent.click(sendNow());
    expect(view.onStop).not.toHaveBeenCalled();
    view.changeState(ChatState.Idle);
    act(() => firstLifecycle.onRejectedBeforeAcceptance());
    submit.mockImplementation(async (_input, lifecycle) => lifecycle?.onAccepted());
    await act(async () => pending.resolve());
    expect(submit).toHaveBeenCalledOnce();
    view.changeBlocked(false);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls.map(([input]) => input.msg)).toEqual([
      'unacknowledged original',
      'explicit replacement',
    ]);
    expect(screen.getByText('1 saved draft')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Expand saved drafts' }));
    expect(screen.getByText('unacknowledged original')).toBeVisible();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([
      expect.objectContaining({ content: 'unacknowledged original', delivery: 'pending' }),
    ]);
  });

  it('retains an uncertain send paused and never automatically replays it after transport returns', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onDeliveryUncertain?.()
    );
    const view = setup(submit);
    await queue('uncertain transport');
    view.changeState(ChatState.Idle);
    await screen.findByText('Sending result unknown. Check the conversation before retrying.');
    view.changeBlocked(true);
    view.changeBlocked(false);
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.getByText('uncertain transport')).toBeVisible();
    expect(sendNow()).toBeDisabled();
  });

  it('submits once when restored UI is stale but no prompt or run is active', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const steer = vi.fn(async () => false);
    const view = setup(submit, steer, true);

    await queue('resume restored queue');
    await userEvent.click(sendNow());

    await waitFor(() => expect(screen.queryByText('resume restored queue')).toBeNull());
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0].msg).toBe('resume restored queue');
    expect(steer).not.toHaveBeenCalled();
    expect(view.onStop).not.toHaveBeenCalled();

    view.changeState(ChatState.Idle);
    expect(screen.queryByText('Messages kept. Send now when you are ready.')).toBeNull();
    expect(submit).toHaveBeenCalledOnce();
  });

  it('does not carry an in-memory queue into another session', async () => {
    const submit = vi.fn();
    const view = setup(submit);

    await queue('belongs only to session A');
    view.changeSession('queue-test-b');

    await waitFor(() => expect(screen.queryByText('belongs only to session A')).toBeNull());
    expect(submit).not.toHaveBeenCalled();
  });

  it('ignores late completion from the previous session without pausing the new queue', async () => {
    const firstSubmission = deferred<void>();
    let firstLifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
      if (input.msg === 'session A in flight') {
        firstLifecycle = lifecycle!;
        return firstSubmission.promise;
      }
      lifecycle?.onAccepted();
      return Promise.resolve();
    });
    const view = setup(submit, undefined, true);

    await queue('session A in flight');
    await userEvent.click(sendNow());
    expect(submit).toHaveBeenCalledOnce();

    view.changeSession('queue-test-b');
    await waitFor(() => expect(screen.queryByText('session A in flight')).toBeNull());
    await queue('session B queued');

    act(() => firstLifecycle.onAccepted());
    await act(async () => firstSubmission.resolve());
    expect(screen.getByText('session B queued')).toBeVisible();
    expect(screen.queryByText('Messages kept. Send now when you are ready.')).toBeNull();

    await userEvent.click(sendNow());
    await waitFor(() => expect(screen.queryByText('session B queued')).toBeNull());
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('preserves rejected queued image bytes across reload until an explicit retry', async () => {
    const images = [{ data: 'aW1hZ2U=', mimeType: 'image/png' }];
    const storage = new QueuedMessageStorage(localStorage, 'queue-test');
    storage.read();
    storage.write([
      { id: 'rejected-image', content: 'inspect this image', timestamp: 456, images },
    ]);
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
      lifecycle?.onRejectedBeforeAcceptance();
    });
    const initial = setup(submit);
    initial.changeState(ChatState.Idle);
    await userEvent.click(sendNow());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0]).toEqual({ msg: 'inspect this image', images, messageId: 'rejected-image', desktopGeneration: '' });
    initial.unmount();
    const restored = setup(submit);
    restored.changeState(ChatState.Idle);
    expect(screen.getByRole('button', { name: 'Expand saved drafts' })).toBeVisible();
    expect(submit).toHaveBeenCalledOnce();
    submit.mockImplementation(async (_input, lifecycle) => lifecycle?.onAccepted());
    expect(
      screen.queryByText('Sending result unknown. Check the conversation before retrying.')
    ).toBeNull();
    await userEvent.click(sendNow());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0]).toEqual(submit.mock.calls[0][0]);
  });

  it('does not requeue an accepted image when the provider subsequently rejects it', async () => {
    const images = [{ data: 'aW1hZ2U=', mimeType: 'image/png' }];
    const storage = new QueuedMessageStorage(localStorage, 'queue-test');
    storage.read();
    storage.write([
      { id: 'accepted-image', content: 'image rejected by provider', timestamp: 789, images },
    ]);
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
      lifecycle?.onAccepted();
      throw new Error('provider rejected image input');
    });
    const initial = setup(submit);
    initial.changeState(ChatState.Idle);
    await userEvent.click(sendNow());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].images).toEqual(images);
    expect(screen.queryByText('image rejected by provider')).toBeNull();
    initial.unmount();
    const restored = setup(submit);
    restored.changeState(ChatState.Idle);
    expect(screen.queryByText('image rejected by provider')).toBeNull();
    expect(submit).toHaveBeenCalledOnce();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()).toEqual([]);
  });

  it('presents input after Stop as a new pending chat message and sends once cancellation settles', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const pending = vi.fn();
    const anchor: Message = {
      id: 'old-answer',
      role: 'assistant',
      created: 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [{ type: 'text', text: 'Old work' }],
    };
    const view = setup(submit, undefined, false, true, {
      messages: [anchor],
      onPendingMessageChange: pending,
    });
    await userEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    expect(view.onStop).toHaveBeenCalledOnce();
    view.changeBlocked(true);
    view.changeState(ChatState.Idle);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'Inspect only the saved files' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(pending).toHaveBeenLastCalledWith(
        'queue-test',
        expect.objectContaining({
          metadata: expect.objectContaining({
            pendingDelivery: 'pending',
            presentation: { afterMessageId: 'old-answer' },
          }),
        })
      )
    );
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    view.changeBlocked(false);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe('Inspect only the saved files');
  });
});
