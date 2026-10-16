import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ChatState } from '../types/chatState';
import type { MessageSubmissionLifecycle } from '../hooks/useChatSessionTypes';
import type { UserInput } from '../types/message';
import ChatInput from './ChatInput';
import { QueuedMessageStorage } from '../utils/queuedMessageStorage';

vi.mock('./ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({ getCurrentModelAndProvider: async () => ({}) }),
}));
vi.mock('./alerts', () => ({
  AlertType: { Error: 'error', Warning: 'warning', Info: 'info' },
  useAlerts: () => ({ alerts: [], addAlert: vi.fn(), clearAlerts: vi.fn() }),
}));
vi.mock('../hooks/useAudioRecorder', () => ({ useAudioRecorder: () => ({ isEnabled: false }) }));
vi.mock('./bottom_menu/DirSwitcher', () => ({ DirSwitcher: () => null }));
vi.mock('./settings/models/bottom_bar/ModelsBottomBar', () => ({ default: () => null }));
vi.mock('./bottom_menu/BottomMenuExtensionSelection', () => ({
  BottomMenuExtensionSelection: () => null,
}));
vi.mock('./bottom_menu/CostTracker', () => ({ CostTracker: () => null }));
vi.mock('./bottom_menu/ContextWindowIndicator', () => ({ ContextWindowIndicator: () => null }));
vi.mock('./MentionPopover', () => ({ default: () => null }));
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

function setup(
  handleSubmit: (input: UserInput, lifecycle?: MessageSubmissionLifecycle) => Promise<void> | void,
  onSteerQueuedMessage?: (input: UserInput) => Promise<boolean>,
  canSubmitQueuedMessageWhileLoading = false,
  pauseQueueOnStop = false
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
  };
  const view = render(<ChatInput {...props} chatState={ChatState.Thinking} />, {
    wrapper: IntlTestWrapper,
  });
  let currentState = ChatState.Thinking;
  let queueProcessingBlocked = false;
  let currentSessionId = props.sessionId;
  const rerender = () =>
    view.rerender(
      <ChatInput
        {...props}
        sessionId={currentSessionId}
        chatState={currentState}
        queueProcessingBlocked={queueProcessingBlocked}
      />
    );
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
  };
}

async function queue(text: string) {
  const input = screen.getByTestId('chat-input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByText(text);
}

const sendNow = () => screen.getByTitle('Stop current processing and send this message now');

describe('ChatInput queue delivery', () => {
  it('keeps pending input paused after Stop and sends it once on explicit resume', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const view = setup(submit, undefined, false, true);
    await queue('preserve pending request');
    await userEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    expect(view.onStop).toHaveBeenCalledOnce();
    view.changeState(ChatState.Idle);
    await screen.findByText('Queue Paused');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText('preserve pending request')).toBeVisible();
    await userEvent.click(sendNow());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0].msg).toBe('preserve pending request');
    expect(screen.queryByText('preserve pending request')).toBeNull();
  });

  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
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
    setup(vi.fn());
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeVisible();
  });

  it('restores unsent messages paused after the conversation is remounted', async () => {
    const submit = vi.fn();
    const first = setup(submit, undefined, false, true);
    await queue('survive renderer reload');
    first.unmount();
    const restored = setup(submit, undefined, false, true);
    restored.changeState(ChatState.Idle);
    await screen.findByText('survive renderer reload');
    expect(screen.getByText('Queue Paused')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
  });

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
      await screen.findByText('Queue Paused');
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
    await screen.findByText('Queue Paused');
    expect(submit).toHaveBeenCalledOnce();
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
    expect(screen.getByText('Queue Paused')).toBeVisible();
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

  it('waits for stop completion and acceptance before removing Send Now input', async () => {
    const pending = deferred<void>();
    let lifecycle!: MessageSubmissionLifecycle;
    const submit = vi.fn((_input: UserInput, callbacks?: MessageSubmissionLifecycle) => {
      lifecycle = callbacks!;
      return pending.promise;
    });
    const view = setup(submit);
    await queue('queued priority request');
    await userEvent.click(sendNow());
    expect(view.onStop).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    view.changeState(ChatState.Idle);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(screen.getByText('queued priority request')).toBeVisible();
    act(() => lifecycle.onAccepted());
    await act(async () => pending.resolve());
    expect(screen.queryByText('queued priority request')).toBeNull();
  });

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

  it('cancels instead of steering and waits for RPC release before sending a fresh turn once', async () => {
    const submit = vi.fn(async (_input: UserInput, lifecycle?: MessageSubmissionLifecycle) =>
      lifecycle?.onAccepted()
    );
    const steer = vi.fn(async () => true);
    const view = setup(submit, steer);
    await queue('new turn after cancellation');
    view.changeBlocked(true);
    await userEvent.click(sendNow());
    expect(view.onStop).toHaveBeenCalledOnce();
    expect(steer).not.toHaveBeenCalled();
    view.changeState(ChatState.Idle);
    expect(submit).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Waiting for cancellation confirmation. Your queued message has not been sent.'
      )
    ).toBeVisible();
    expect(new QueuedMessageStorage(localStorage, 'queue-test').read()[0].delivery).not.toBe(
      'submitting'
    );
    view.changeBlocked(false);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(screen.queryByText('new turn after cancellation')).toBeNull();
    view.changeState(ChatState.Idle);
    expect(submit).toHaveBeenCalledOnce();
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

  it('can cancel a current request that itself came from the queue without losing the next input', async () => {
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
    expect(view.onStop).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    await userEvent.click(sendNow());
    expect(view.onStop).toHaveBeenCalledOnce();
    view.changeState(ChatState.Idle);
    view.changeBlocked(false);
    expect(submit).toHaveBeenCalledOnce();
    submit.mockImplementation(async (_input, callbacks) => callbacks?.onAccepted());
    await act(async () => pending.resolve());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0].msg).toBe('second priority run');
  });

  it('keeps an unacknowledged cancelled input paused while sending only the explicit replacement', async () => {
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
    await userEvent.click(
      screen.getAllByTitle('Stop current processing and send this message now')[1]
    );
    expect(view.onStop).toHaveBeenCalledOnce();
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
    expect(screen.getByText('unacknowledged original')).toBeVisible();
    expect(screen.getByText('Queue Paused')).toBeVisible();
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
    expect(screen.queryByText('Queue Paused')).toBeNull();
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
    expect(screen.queryByText('Queue Paused')).toBeNull();

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
    expect(submit.mock.calls[0][0]).toEqual({ msg: 'inspect this image', images });
    initial.unmount();
    const restored = setup(submit);
    restored.changeState(ChatState.Idle);
    expect(screen.getByText('Queue Paused')).toBeVisible();
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
});
