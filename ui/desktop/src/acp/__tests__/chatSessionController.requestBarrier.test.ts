import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { acpChatSessionController } from '../chatSessionController';
import { acpChatSessionActions, acpChatSessionStore } from '../chatSessionStore';
import { acpCancelPrompt, acpPromptSession } from '../prompt';
import { isAcpRecovering } from '../acpConnection';
import { ChatState } from '../../types/chatState';
import { createUserMessage } from '../../types/message';

vi.mock('../../utils/extensionErrorUtils', () => ({ showExtensionLoadResults: vi.fn() }));
vi.mock('../prompt', () => ({ acpPromptSession: vi.fn(), acpCancelPrompt: vi.fn() }));
vi.mock('../acpConnection', () => ({ isAcpRecovering: vi.fn(() => false) }));
vi.mock('../permissionRequests', () => ({
  cancelAcpPermissionRequestsForSession: vi.fn(),
  restoreAcpPermissionRequestsForSession: vi.fn(),
}));
vi.mock('../elicitationRequests', () => ({ cancelAcpElicitationRequestsForSession: vi.fn() }));

const id = 'isolated-request-barrier';
function pendingPrompt(acknowledged = true) {
  let resolve!: (value: { stopReason: 'end_turn' | 'cancelled' | 'max_tokens' }) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{ stopReason: 'end_turn' | 'cancelled' | 'max_tokens' }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  vi.mocked(acpPromptSession).mockReturnValueOnce(promise);
  const user = createUserMessage('isolated queued request');
  const onAccepted = vi.fn();
  const onRejectedBeforeAcceptance = vi.fn();
  const submission = acpChatSessionController.submitMessage(id, user, {
    getCurrentSnapshot: () => acpChatSessionStore.getSnapshot(id),
    onFinish: vi.fn(),
    onAccepted,
    onRejectedBeforeAcceptance,
  });
  if (acknowledged)
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: 'run-1' } } },
    } as SessionNotification);
  return { resolve, reject, submission, user, onAccepted, onRejectedBeforeAcceptance };
}

describe('session prompt request barrier with the real chat store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAcpRecovering).mockReturnValue(false);
    vi.mocked(acpCancelPrompt).mockResolvedValue(undefined);
  });
  afterEach(() => acpChatSessionActions.deleteSnapshot(id));

  it('does not accept an admission-time cancellation without a native acknowledgement and allows the next explicit request', async () => {
    const first = pendingPrompt(false);
    acpChatSessionController.stop(id);
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } },
    } as SessionNotification);
    first.resolve({ stopReason: 'cancelled' });
    await first.submission;
    expect(first.onAccepted).not.toHaveBeenCalled();
    expect(first.onRejectedBeforeAcceptance).toHaveBeenCalledOnce();
    expect(acpChatSessionStore.getSnapshot(id)).toMatchObject({
      messages: [],
      activePromptAttemptId: null,
      activeRunId: null,
      promptRequestId: null,
      pendingCancelPromptAttemptId: null,
      chatState: ChatState.Idle,
    });
    vi.mocked(acpPromptSession).mockResolvedValueOnce({ stopReason: 'end_turn' });
    const onAccepted = vi.fn();
    await acpChatSessionController.submitMessage(
      id,
      createUserMessage('explicit replacement request'),
      {
        getCurrentSnapshot: () => acpChatSessionStore.getSnapshot(id),
        onAccepted,
        onFinish: vi.fn(),
      }
    );
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(acpPromptSession).toHaveBeenCalledTimes(2);
  });

  it.each(['end_turn', 'max_tokens'] as const)('ends display on terminal but retains the original RPC result %s', async (stopReason) => {
    const first = pendingPrompt();
    expect(first.onAccepted).toHaveBeenCalledOnce();
    acpChatSessionActions.applyAcpGooseSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: '',
          data: {
            schema_version: 1,
            session_id: id,
            run_id: 'run-1',
            terminal_message_id: 'terminal-1',
            source_user_message_id: first.user.id,
            status: 'completed',
            checkpoint_id: null,
            retry_strategy: 'not_available',
            visible_text_available: true,
            tool_action_count: 0,
            copy_artifact_ref: null,
            finished_at: '2026-10-16T04:00:00Z',
          },
        },
      },
    });
    expect(acpChatSessionStore.getSnapshot(id)).toMatchObject({
      chatState: ChatState.Idle,
      activePromptAttemptId: null,
      activeRunId: null,
    });
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBeTruthy();
    const onRejectedBeforeAcceptance = vi.fn();
    await acpChatSessionController.submitMessage(id, createUserMessage('next request'), {
      getCurrentSnapshot: () => acpChatSessionStore.getSnapshot(id),
      onFinish: vi.fn(),
      onRejectedBeforeAcceptance,
    });
    expect(acpPromptSession).toHaveBeenCalledOnce();
    expect(onRejectedBeforeAcceptance).toHaveBeenCalledOnce();
    first.resolve({ stopReason });
    await first.submission;
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBeNull();
    if (stopReason === 'max_tokens')
      expect(acpChatSessionStore.getSnapshot(id)?.promptError).toContain('输出长度限制');
    vi.mocked(acpPromptSession).mockResolvedValueOnce({ stopReason: 'end_turn' });
    await acpChatSessionController.submitMessage(id, createUserMessage('explicit next request'), {
      getCurrentSnapshot: () => acpChatSessionStore.getSnapshot(id),
      onFinish: vi.fn(),
    });
    expect(acpPromptSession).toHaveBeenCalledTimes(2);
  });

  it('does not release occupancy on cancel acknowledgement before the old prompt settles', async () => {
    const first = pendingPrompt();
    acpChatSessionController.stop(id);
    await Promise.resolve();
    expect(acpCancelPrompt).toHaveBeenCalledWith(id);
    expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBeTruthy();
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBeTruthy();
    first.resolve({ stopReason: 'cancelled' });
    await first.submission;
    expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBeNull();
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBeNull();
    expect(acpPromptSession).toHaveBeenCalledOnce();
  });

  it('releases only transport occupancy on reconnect without replaying the accepted request', async () => {
    const first = pendingPrompt();
    vi.mocked(isAcpRecovering).mockReturnValue(true);
    first.reject(new Error('ACP connection closed'));
    await first.submission;
    const snapshot = acpChatSessionStore.getSnapshot(id);
    expect(snapshot?.promptRequestId).toBeNull();
    expect(snapshot?.activePromptAttemptId).toBeTruthy();
    expect(snapshot?.activeRunId).toBe('run-1');
    expect(acpPromptSession).toHaveBeenCalledOnce();
    expect(first.onAccepted).toHaveBeenCalledOnce();
  });

  it('keeps an unconfirmed cancellation blocked after transport failure until native terminal arrives', async () => {
    const first = pendingPrompt();
    acpChatSessionController.stop(id);
    first.reject(new Error('transport failed before confirmation'));
    await first.submission;
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBeNull();
    expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBeTruthy();
    acpChatSessionActions.applyAcpGooseSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: '',
          data: {
            schema_version: 1,
            session_id: id,
            run_id: 'run-1',
            terminal_message_id: 'cancelled-native',
            source_user_message_id: first.user.id,
            status: 'cancelled',
            checkpoint_id: null,
            retry_strategy: 'replay_user_request',
            visible_text_available: false,
            tool_action_count: 0,
            copy_artifact_ref: null,
            finished_at: '2026-10-16T04:00:00Z',
          },
        },
      },
    });
    expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBeTruthy();
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } },
    } as SessionNotification);
    expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBeNull();
    expect(acpPromptSession).toHaveBeenCalledOnce();
  });

  it.each(['terminal-first', 'release-first'] as const)(
    'cancels a loaded active run and waits for both native facts: %s',
    async (order) => {
      acpChatSessionActions.applyAcpSessionNotification({
        sessionId: id,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { goose: { activeRunId: 'loaded-run' } },
        },
      } as SessionNotification);
      expect(acpChatSessionStore.getSnapshot(id)?.activePromptAttemptId).toBeNull();
      acpChatSessionController.stop(id);
      await Promise.resolve();
      expect(acpCancelPrompt).toHaveBeenCalledWith(id);
      expect(acpPromptSession).not.toHaveBeenCalled();
      expect(acpChatSessionStore.getSnapshot(id)).toMatchObject({
        promptRequestId: null,
        pendingCancelPromptAttemptId: 'loaded-run',
        chatState: ChatState.Idle,
      });
      const terminal = (
        runId: string,
        status: 'cancelled' | 'completed' | 'failed' = 'cancelled'
      ) =>
        acpChatSessionActions.applyAcpGooseSessionNotification({
          sessionId: id,
          update: {
            sessionUpdate: 'status_message',
            status: {
              type: 'progress',
              message: '',
              data: {
                schema_version: 1,
                session_id: id,
                run_id: runId,
                terminal_message_id: 'terminal-' + runId,
                source_user_message_id: 'native-source-user',
                status,
                checkpoint_id: null,
                retry_strategy: status === 'completed' ? 'not_available' : 'replay_user_request',
                visible_text_available: false,
                tool_action_count: 0,
                copy_artifact_ref: null,
                finished_at: '2026-10-16T04:00:00Z',
              },
            },
          },
        });
      for (const status of ['cancelled', 'completed', 'failed'] as const) {
        terminal('unrelated-old-run-' + status, status);
        expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBe(
          'loaded-run'
        );
        expect(acpChatSessionStore.getSnapshot(id)?.activeRunId).toBe('loaded-run');
      }
      const release = () =>
        acpChatSessionActions.applyAcpSessionNotification({
          sessionId: id,
          update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } },
        } as SessionNotification);
      if (order === 'release-first') {
        release();
        expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBe(
          'loaded-run'
        );
      }
      terminal('loaded-run');
      if (order === 'terminal-first') {
        expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBe(
          'loaded-run'
        );
        release();
      }
      expect(acpChatSessionStore.getSnapshot(id)).toMatchObject({
        promptRequestId: null,
        activeRunId: null,
        pendingCancelPromptAttemptId: null,
        chatState: ChatState.Idle,
      });
      expect(acpPromptSession).not.toHaveBeenCalled();
    }
  );
  it('ignores conflicting run notices while cancellation is sealed and still accepts its matching release', () => {
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { goose: { activeRunId: 'old-run' } },
      },
    } as SessionNotification);
    acpChatSessionController.stop(id);
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { goose: { activeRunId: 'replacement-run' } },
      },
    } as SessionNotification);
    expect(acpChatSessionStore.getSnapshot(id)?.activeRunId).toBe('old-run');
    expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBe('old-run');
    acpChatSessionActions.applyAcpGooseSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: '',
          data: {
            schema_version: 1,
            session_id: id,
            run_id: 'old-run',
            terminal_message_id: 'old-terminal',
            source_user_message_id: 'old-user',
            status: 'cancelled',
            checkpoint_id: null,
            retry_strategy: 'replay_user_request',
            visible_text_available: false,
            tool_action_count: 0,
            copy_artifact_ref: null,
            finished_at: '2026-10-16T04:00:00Z',
          },
        },
      },
    });
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } },
    } as SessionNotification);
    expect(acpChatSessionStore.getSnapshot(id)?.pendingCancelPromptAttemptId).toBeNull();
    expect(acpPromptSession).not.toHaveBeenCalled();
  });
});
