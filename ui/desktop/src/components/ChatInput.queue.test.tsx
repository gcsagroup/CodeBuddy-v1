import { inputQueueRequest } from '../acp/inputQueue';
import { deliverMainConversationMessage } from '../pets/mainConversation';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('../acp/inputQueue', () => ({ inputQueueRequest: vi.fn(async () => ({ version: 1, revision: 0, paused: false, activeRunId: null, items: [], selection: null })) }));

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
    expect(screen.getByTitle('Remove this message from queue')).toBeDisabled();
    expect(remove).not.toHaveBeenCalled();
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
});

describe('server owned queue controls', () => {
  it('keeps the queue editor open when the server refuses the edit', async () => {
    const edit = vi.fn(async () => false);
    render(<MessageQueue queuedMessages={[{id:'a',content:'original',images:[],timestamp:1}]} onRemoveMessage={vi.fn()} onClearQueue={vi.fn()} onEditMessage={edit} />, {wrapper:IntlTestWrapper});
    fireEvent.click(screen.getByRole('button',{name:'original'}));
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'revised'}});
    fireEvent.click(screen.getByRole('button',{name:'Save'}));
    await waitFor(()=>expect(edit).toHaveBeenCalledWith('a','revised'));
    expect(screen.getByRole('textbox')).toHaveValue('revised');
  });
  it('blocks edit delete clear and duplicate switching while a selected batch is in flight', () => {
    render(<MessageQueue queuedMessages={[{id:'a',content:'original',images:[],timestamp:1}]} sendingMessageIds={new Set(['a'])} onRemoveMessage={vi.fn()} onClearQueue={vi.fn()} onSendNow={vi.fn()} onSteerMessage={vi.fn()} onEditMessage={vi.fn()} />, {wrapper:IntlTestWrapper});
    expect(screen.getByRole('button',{name:'Clear All'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Remove this message from queue'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Switch now'})).toBeDisabled();
  });
});


it('accepts a new draft while the consumed queue snapshot is still catching up', async () => {
  localStorage.clear();
  const snapshot = {version:1 as const,revision:1,paused:false,activeRunId:null,selection:null,items:[{id:'old',content:'previous',images:[],timestamp:1,desktopGeneration:'',state:'dispatching' as const}]};
  vi.mocked(inputQueueRequest).mockResolvedValue(snapshot);
  const submit=vi.fn();const view=setup(submit);
  await screen.findByText('previous');view.changeState(ChatState.Idle);
  const input=screen.getByTestId('chat-input');fireEvent.change(input,{target:{value:'next instruction'}});fireEvent.keyDown(input,{key:'Enter'});
  await waitFor(()=>expect(inputQueueRequest).toHaveBeenCalledWith('queue-test',expect.objectContaining({action:'enqueue',items:[expect.objectContaining({content:'next instruction'})]})));
  await waitFor(()=>expect(input).toHaveValue(''));expect(submit).not.toHaveBeenCalled();
});

it('clears staged queued input immediately and never clears newer text on delayed acknowledgement', async()=>{
 localStorage.clear();
 vi.mocked(inputQueueRequest).mockClear();
 const snap={version:1 as const,revision:0,paused:false,activeRunId:'old',selection:null,items:[]};
 let release!:(value:typeof snap)=>void;
 vi.mocked(inputQueueRequest).mockImplementation(async(_id,c)=>c.action==='get'?snap:new Promise(resolve=>{release=resolve;}));
 const view=setup(vi.fn());view.changeState(ChatState.Streaming);
 const input=screen.getByTestId('chat-input');
 await waitFor(()=>expect(inputQueueRequest).toHaveBeenCalled());
 await act(async()=>{});
 fireEvent.change(input,{target:{value:'first queued'}});fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(release).toBeDefined());
 expect(input).toHaveValue('');
 fireEvent.change(input,{target:{value:'next draft'}});
 fireEvent.keyDown(input,{key:'Enter'});
 expect(vi.mocked(inputQueueRequest).mock.calls.filter(([,c])=>c.action==='enqueue')).toHaveLength(1);
 expect(input).toHaveValue('next draft');
 await act(async()=>{release({...snap,revision:1});});
 expect(input).toHaveValue('next draft');
});

it('keeps the list expanded across async edit admission and focuses only the queue editor',async()=>{
 const items=Array.from({length:6},(_,i)=>({id:`layout-${i}`,content:`layout text ${i}`,images:[],timestamp:i}));
 let resolve!:(ok:boolean)=>void;
 const begin=vi.fn(()=>new Promise<boolean>(r=>{resolve=r;}));
 const props={queuedMessages:items,onRemoveMessage:vi.fn(),onClearQueue:vi.fn(),onEditMessage:vi.fn(async()=>true),onBeginEdit:begin};
 const view=render(<MessageQueue {...props}/>,{wrapper:IntlTestWrapper});
 fireEvent.click(screen.getByRole('button',{name:'layout text 5'}));
 view.rerender(<MessageQueue {...props} isPaused/>);
 expect(screen.getByText('layout text 0')).toBeVisible();
 await act(async()=>{resolve(true);});
 const editor=screen.getByRole('textbox',{name:'Edit message'});
 expect(editor).toHaveFocus();expect(editor).toHaveValue('layout text 5');
 expect(editor.closest('[data-queue-row]')?.querySelector('[aria-label="Remove this message from queue"]')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 expect(screen.getByRole('button',{name:'layout text 5'})).toHaveFocus();
 expect(props.onEditMessage).not.toHaveBeenCalled();
});
