import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ChatState } from '../types/chatState';
import type { Message, UserInput } from '../types/message';
import { acpChatSessionController } from '../acp/chatSessionController';
import { useChatSession } from './useChatSession';

const state = vi.hoisted(() => ({
  recoveryListener: undefined as ((recovering: boolean) => void) | undefined,
  snapshot: {
    promptRequestId: null as string | null,
    activeRunId: 'run-1' as string | null,
    activePromptAttemptId: null as string | null,
    pendingCancelPromptAttemptId: null as string | null,
    chatState: 'thinking',
    messages: [] as Message[],
    notifications: [],
  },
}));
vi.mock('../acp/acpConnection', () => ({
  isAcpRecovering: () => false,
  subscribeToAcpRecovery: (listener: (recovering: boolean) => void) => {
    state.recoveryListener = listener;
    return () => {
      state.recoveryListener = undefined;
    };
  },
}));
vi.mock('../acp/prompt', () => ({ acpSteerSession: vi.fn() }));
vi.mock('../acp/chatSessionController', () => ({
  acpChatSessionController: { loadSession: vi.fn(), submitMessage: vi.fn() },
}));
vi.mock('../acp/chatSessionStore', () => ({
  acpChatSessionStore: {
    getSnapshot: () => ({ ...state.snapshot, session: { id: 'session-1' } }),
  },
  useAcpChatSessionSnapshot: () => ({ ...state.snapshot, session: { id: 'session-1' } }),
  acpChatSessionActions: {
    addPendingLocalSteerMessage: vi.fn(),
    setMessages: vi.fn(),
  },
}));

const input: UserInput = { msg: 'adjust the implementation', images: [] };
function setup() {
  return renderHook(() => useChatSession({ sessionId: 'session-1', onStreamFinish: vi.fn() }), {
    wrapper: IntlTestWrapper,
  });
}

function terminalMessage(
  status: 'completed' | 'interrupted',
  outcome: 'completed' | 'paused'
): Message {
  const completed = status === 'completed';
  return {
    id: `terminal-${status}`,
    role: 'assistant',
    created: 1,
    metadata: { userVisible: true, agentVisible: false },
    content: [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: status,
        data: {
          schema_version: 1,
          session_id: 'session-1',
          run_id: 'run-1',
          terminal_message_id: `terminal-${status}`,
          source_user_message_id: 'source-user-1',
          status,
          checkpoint_id: completed ? null : 'checkpoint-1',
          retry_strategy: completed ? 'not_available' : 'continue_checkpoint',
          visible_text_available: true,
          tool_action_count: 1,
          copy_artifact_ref: null,
          finished_at: '2026-09-11T00:00:00Z',
          report: {
            outcome,
            classification_counts: {
              confirmed_bug: 0,
              test_failure: 0,
              environment_problem: 0,
              codepro_incomplete: completed ? 0 : 1,
              unverified: 0,
            },
            changed_files: [],
            verification_summary: [],
            limitations: completed ? [] : ['execution_boundary'],
            recovery_action: completed ? 'none' : 'continue_checkpoint',
          },
        },
      },
    ],
  };
}

describe('useChatSession steering acceptance', () => {
  it('reloads the same session after reconnect without resubmitting its prompt', () => {
    const { unmount } = setup();
    vi.mocked(acpChatSessionController.loadSession).mockClear();
    vi.mocked(acpChatSessionController.submitMessage).mockClear();
    act(() => {
      state.recoveryListener?.(true);
    });
    expect(acpChatSessionController.loadSession).not.toHaveBeenCalled();
    act(() => {
      state.recoveryListener?.(false);
    });
    expect(acpChatSessionController.loadSession).toHaveBeenCalledWith(
      'session-1',
      expect.any(Object)
    );
    expect(acpChatSessionController.submitMessage).not.toHaveBeenCalled();
    unmount();
    expect(state.recoveryListener).toBeUndefined();
  });
  it('withholds partial history until loading finishes, but never buffers live output', () => {
    const history = terminalMessage('interrupted', 'paused');
    state.snapshot = {
      ...state.snapshot,
      chatState: ChatState.LoadingConversation,
      messages: [history],
    };
    const { result, rerender } = setup();
    expect(result.current.messages).toEqual([]);
    // The store keeps replay facts; only the display waits for the load boundary.
    expect(state.snapshot.messages).toEqual([history]);

    state.snapshot = { ...state.snapshot, chatState: ChatState.Idle };
    rerender();
    expect(result.current.messages).toEqual([history]);

    state.snapshot = { ...state.snapshot, chatState: ChatState.Streaming };
    rerender();
    expect(result.current.messages).toEqual([history]);
  });

  it('blocks a new prompt after terminal display until the previous request settles', async () => {
    state.snapshot = {
      ...state.snapshot,
      chatState: ChatState.Idle,
      activeRunId: null,
      promptRequestId: 'old-rpc',
    };
    const { result, rerender } = setup();
    const onRejectedBeforeAcceptance = vi.fn();
    await result.current.handleSubmit(input, { onAccepted: vi.fn(), onRejectedBeforeAcceptance });
    expect(result.current.queueProcessingBlocked).toBe(true);
    expect(onRejectedBeforeAcceptance).toHaveBeenCalledOnce();
    expect(acpChatSessionController.submitMessage).not.toHaveBeenCalled();
    state.snapshot = { ...state.snapshot, promptRequestId: null };
    rerender();
    expect(result.current.queueProcessingBlocked).toBe(false);
    await result.current.handleSubmit(input);
    expect(acpChatSessionController.submitMessage).toHaveBeenCalledOnce();
  });



  beforeEach(() => {
    vi.clearAllMocks();
    state.snapshot = {
      promptRequestId: null,
      activeRunId: 'run-1',
      activePromptAttemptId: null,
      pendingCancelPromptAttemptId: null,
      chatState: ChatState.Thinking,
      messages: [],
      notifications: [],
    };
  });


  it.each([
    ['interrupted', 'paused', true, false, false],
    ['completed', 'completed', true, false, true],
    ['completed', 'completed', true, true, true],
    ['completed', 'completed', false, false, false],
  ] as const)(
    'shows a completion notification only for terminal evidence: %s',
    async (status, outcome, enabled, focused, expectedNotification) => {
      const showNotification = vi.fn();
      Object.assign(window.electron, {
        getSetting: vi.fn().mockResolvedValue(enabled),
        isAnyWindowFocused: vi.fn().mockResolvedValue(focused),
        showNotification,
      });
      state.snapshot = {
        ...state.snapshot,
        activeRunId: null,
        activePromptAttemptId: null,
        chatState: ChatState.Idle,
        messages: [
          { role: 'assistant', created: 1, metadata: { userVisible: true, agentVisible: true },
            content: [{ type: 'text', text: '本轮实收 531 元' }] },
          { role: 'assistant', created: 2, metadata: { userVisible: false, agentVisible: true },
            content: [{ type: 'text', text: '内部记录' }] },
          terminalMessage(status, outcome),
        ],
      };
      vi.mocked(acpChatSessionController.submitMessage).mockImplementation(
        async (_sessionId, _message, options) => {
          options.onAccepted?.();
          await options.onFinish();
        }
      );

      const { result } = setup();
      await result.current.handleSubmit({ msg: 'continue from terminal', images: [] });

      expect(showNotification).toHaveBeenCalledTimes(expectedNotification ? 1 : 0);
      if (expectedNotification) expect(showNotification).toHaveBeenCalledWith(expect.objectContaining({
        title: 'CodeBuddy finished this execution turn.',
        body: '本轮实收 531 元',
        sessionId: 'session-1',
      }));
    }
  );

  it.each([ChatState.Thinking, ChatState.Streaming])(
    'submits exactly once through the real handler for stale runnable state: %s',
    async (chatState) => {
      state.snapshot = {
        ...state.snapshot,
        activeRunId: null,
        activePromptAttemptId: null,
        chatState,
      };
      vi.mocked(acpChatSessionController.submitMessage).mockImplementation(
        async (_sessionId, _message, options) => options.onAccepted?.()
      );

      const { result } = setup();
      await result.current.handleSubmit({ msg: 'resume restored task', images: [] });

      expect(acpChatSessionController.submitMessage).toHaveBeenCalledOnce();
    }
  );

});
