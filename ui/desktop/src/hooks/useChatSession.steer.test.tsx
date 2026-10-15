import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ChatState } from '../types/chatState';
import type { Message, UserInput } from '../types/message';
import { acpSteerSession } from '../acp/prompt';
import { acpChatSessionActions } from '../acp/chatSessionStore';
import { acpChatSessionController } from '../acp/chatSessionController';
import { useChatSession } from './useChatSession';

const state = vi.hoisted(() => ({
  snapshot: {
    activeRunId: 'run-1' as string | null,
    activePromptAttemptId: null as string | null,
    pendingCancelPromptAttemptId: null as string | null,
    chatState: 'thinking',
    messages: [] as Message[],
    notifications: [],
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

  it('pauses pending queued messages when the user stops the current turn', () => {
    const { result } = setup();
    expect(result.current.pauseQueueOnStop).toBe(true);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.snapshot = {
      activeRunId: 'run-1',
      activePromptAttemptId: null,
      pendingCancelPromptAttemptId: null,
      chatState: ChatState.Thinking,
      messages: [],
      notifications: [],
    };
  });

  it.each([null, 'run-2'])(
    'honors successful acceptance after the original run changes to %s',
    async (nextRunId) => {
      vi.mocked(acpSteerSession).mockImplementation(async () => {
        state.snapshot = { ...state.snapshot, activeRunId: nextRunId };
        return { runId: 'run-1', messageId: 'accepted-steer' };
      });
      const { result } = setup();
      await expect(result.current.onSteerQueuedMessage!(input)).resolves.toBe(true);
      expect(acpSteerSession).toHaveBeenCalledOnce();
      expect(acpChatSessionActions.addPendingLocalSteerMessage).not.toHaveBeenCalled();
    }
  );

  it('retains the original exception so the queue pauses instead of falling back to resend', async () => {
    const failure = new Error('Connection ended before the acceptance receipt');
    vi.mocked(acpSteerSession).mockRejectedValue(failure);
    const { result } = setup();
    await expect(result.current.onSteerQueuedMessage!(input)).rejects.toBe(failure);
    expect(acpSteerSession).toHaveBeenCalledOnce();
    expect(acpChatSessionActions.addPendingLocalSteerMessage).not.toHaveBeenCalled();
  });

  it('adds a pending local message only when the accepted run is still current', async () => {
    vi.mocked(acpSteerSession).mockResolvedValue({ runId: 'run-1', messageId: 'accepted-steer' });
    const { result } = setup();
    await expect(result.current.onSteerQueuedMessage!(input)).resolves.toBe(true);
    expect(acpChatSessionActions.addPendingLocalSteerMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'accepted-steer',
        metadata: expect.objectContaining({ steer: true }),
      })
    );
  });

  it.each(['no run', 'cancelling', 'slash command', 'image only'] as const)(
    'returns false only before sending: %s',
    async (reason) => {
      if (reason === 'no run') state.snapshot.activeRunId = null;
      if (reason === 'cancelling') state.snapshot.pendingCancelPromptAttemptId = 'cancel-1';
      const request =
        reason === 'slash command'
          ? { msg: '/clear', images: [] }
          : reason === 'image only'
            ? { msg: '', images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }] }
            : input;
      const { result } = setup();
      await expect(result.current.onSteerQueuedMessage!(request)).resolves.toBe(false);
      expect(acpSteerSession).not.toHaveBeenCalled();
    }
  );

  it.each([ChatState.Thinking, ChatState.Streaming])(
    'allows queue recovery only for stale runnable state: %s',
    (chatState) => {
      state.snapshot = {
        ...state.snapshot,
        activeRunId: null,
        activePromptAttemptId: null,
        chatState,
      };

      const { result } = setup();
      expect(result.current.canSubmitQueuedMessageWhileLoading).toBe(true);
    }
  );

  it.each([
    ['interrupted', 'paused', false],
    ['completed', 'completed', true],
  ] as const)(
    'shows a completion notification only for terminal evidence: %s',
    async (status, outcome, expectedNotification) => {
      const showNotification = vi.fn();
      Object.assign(window.electron, {
        getSetting: vi.fn().mockResolvedValue(true),
        isAnyWindowFocused: vi.fn().mockResolvedValue(false),
        showNotification,
      });
      state.snapshot = {
        ...state.snapshot,
        activeRunId: null,
        activePromptAttemptId: null,
        chatState: ChatState.Idle,
        messages: [terminalMessage(status, outcome)],
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

  it.each([
    ChatState.WaitingForUserInput,
    ChatState.Compacting,
    ChatState.LoadingConversation,
    ChatState.RestartingAgent,
  ])('does not bypass queue safety for non-runnable state: %s', (chatState) => {
    state.snapshot = {
      ...state.snapshot,
      activeRunId: null,
      activePromptAttemptId: null,
      chatState,
    };

    const { result } = setup();
    expect(result.current.canSubmitQueuedMessageWhileLoading).toBe(false);
  });
});
