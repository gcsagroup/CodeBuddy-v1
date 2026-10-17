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
function receive(overrides = {}) {
  actions.applyAcpGooseSessionNotification({
    sessionId,
    update: {
      sessionUpdate: 'status_message',
      status: {
        type: 'progress',
        message: '',
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
});
