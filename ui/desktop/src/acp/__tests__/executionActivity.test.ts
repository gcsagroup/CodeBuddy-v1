import { afterEach, describe, expect, it } from 'vitest';
import {
  acpChatSessionActions as actions,
  acpChatSessionStore as store,
} from '../chatSessionStore';
import { ChatState } from '../../types/chatState';

const sessionId = 'execution-activity-fixture';
afterEach(() => actions.deleteSnapshot(sessionId));
function start() {
  actions.setMessages(sessionId, [
    {
      id: 'input',
      role: 'user',
      created: 1,
      content: [{ type: 'text', text: 'Ask the existing worker' }],
      metadata: { userVisible: true, agentVisible: true },
    },
  ]);
  actions.startPromptAttempt(sessionId, 'attempt', 'input');
  actions.setChatState(sessionId, ChatState.Streaming);
  actions.applyAcpSessionNotification({
    sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      _meta: { goose: { activeRunId: 'run' } },
    },
  });
}
function receive(overrides = {}, message = '', type: 'progress' | 'notice' = 'progress') {
  actions.applyAcpGooseSessionNotification({
    sessionId,
    update: {
      sessionUpdate: 'status_message',
      status: {
        type,
        message,
        data: {
          schema_version: 1,
          event: 'execution_activity',
          run_id: 'run',
          source_user_message_id: 'input',
          phase: 'children',
          child_count: 1,
          ...overrides,
        },
      },
    },
  });
}
describe('live execution activity is scoped presentation only', () => {
  it('accepts bounded advice observations and drops malformed optional fields without changing execution', () => {
    start();
    receive({ phase: 'model', child_count: 0, model_request_started_at: 1234,
      consecutive_tool_failures: 3, response_retries: 4 });
    expect(store.getSnapshot(sessionId)?.promptActivity?.execution).toMatchObject({
      modelRequestStartedAt: 1234, consecutiveToolFailures: 3, responseRetries: 4,
    });
    receive({ phase: 'model', child_count: 0, model_request_started_at: 'yesterday',
      consecutive_tool_failures: -1, response_retries: 10001 });
    expect(store.getSnapshot(sessionId)?.promptActivity?.execution).toEqual({ phase: 'model', childCount: 0 });
    expect(store.getSnapshot(sessionId)?.chatState).toBe(ChatState.Streaming);
    expect(store.getSnapshot(sessionId)?.messages).toHaveLength(1);
  });
  it('updates the wait target without adding chat messages or changing execution state', () => {
    start();
    const before = store.getSnapshot(sessionId)!;
    receive();
    const after = store.getSnapshot(sessionId)!;
    expect(after.promptActivity?.execution).toEqual({ phase: 'children', childCount: 1 });
    expect(after.messages).toEqual(before.messages);
    expect(after.chatState).toBe(before.chatState);
    expect(after.progressMessage).toBe(before.progressMessage);
  });
  it('rejects another input, another run and malformed activity', () => {
    start();
    receive({ source_user_message_id: 'older' });
    receive({ run_id: 'another-run' });
    receive({ child_count: -1 });
    expect(store.getSnapshot(sessionId)?.promptActivity?.execution).toBeUndefined();
  });
  it('cannot revive a finished attempt', () => {
    start();
    actions.finishPromptAttemptIfCurrent(sessionId, 'attempt');
    receive();
    expect(store.getSnapshot(sessionId)?.chatState).toBe(ChatState.Idle);
    expect(store.getSnapshot(sessionId)?.promptActivity).toBeUndefined();
  });
  it('accepts observed request phases and ignores an unknown optional phase', () => {
    start();
    receive({ phase: 'model', model_request_phase: 'waiting' });
    expect(store.getSnapshot(sessionId)?.promptActivity?.execution).toEqual({
      phase: 'model',
      childCount: 1,
      modelRequestPhase: 'waiting',
    });
    receive({ phase: 'model', model_request_phase: 'invented' });
    expect(store.getSnapshot(sessionId)?.promptActivity?.execution).toEqual({
      phase: 'model',
      childCount: 1,
    });
  });
  it('shows only observed retry text and preserves a terminal explanation without adding a chat message', () => {
    start();
    receive({ phase: 'model' }, '连接发生错误；正在重新连接（1/5）');
    expect(store.getSnapshot(sessionId)?.promptActivity?.execution?.detail).toBe(
      '连接发生错误；正在重新连接（1/5）'
    );
    expect(store.getSnapshot(sessionId)?.promptError).toBeUndefined();
    receive({ phase: 'model' }, '模型服务未通过身份验证（HTTP 401）', 'notice');
    expect(store.getSnapshot(sessionId)?.promptError).toBe('模型服务未通过身份验证（HTTP 401）');
    expect(store.getSnapshot(sessionId)?.messages).toHaveLength(1);
    actions.applyAcpGooseSessionNotification({
      sessionId,
      update: {
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: '',
          data: {
            schema_version: 1,
            session_id: sessionId,
            run_id: 'run',
            terminal_message_id: 'terminal',
            source_user_message_id: 'input',
            status: 'failed',
            checkpoint_id: null,
            retry_strategy: 'replay_user_request',
            visible_text_available: false,
            tool_action_count: 0,
            copy_artifact_ref: null,
            finished_at: new Date().toISOString(),
          },
        },
      },
    });
    expect(store.getSnapshot(sessionId)?.chatState).toBe(ChatState.Idle);
    expect(actions.finishPromptAttemptIfCurrent(sessionId, 'attempt', 'raw RPC error')).toBe(false);
    expect(store.getSnapshot(sessionId)?.promptError).toBe('模型服务未通过身份验证（HTTP 401）');
    actions.startPromptAttempt(sessionId, 'next-attempt', 'next-input');
    expect(store.getSnapshot(sessionId)?.promptError).toBeUndefined();
    receive({ phase: 'model' }, '迟到的旧错误', 'notice');
    expect(store.getSnapshot(sessionId)?.promptError).toBeUndefined();
  });
});
