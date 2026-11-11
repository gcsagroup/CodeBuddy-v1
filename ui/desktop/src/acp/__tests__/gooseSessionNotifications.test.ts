import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import { describe, expect, it } from 'vitest';
import type { Message, MessageUsage } from '../../types/message';
import { getTurnTerminalRecord } from '../../types/turnTerminal';
import { applyGooseSessionNotification } from '../adapter/gooseSessionNotifications';
import type { AcpChatStateChange, AdapterState } from '../adapter/shared';

const SESSION_ID = 'session-1';

it('accepts official performance metadata and rejects malformed optional stats without dropping context', () => {
  const update = { sessionUpdate: 'status_message' as const,
    status: { type: 'progress' as const, message: '', data: {
      schema_version: 1, event: 'context_meter', used: 300, contextLimit: 10000,
      sessionStats: { decodeTokens: 440, decodeMs: 2000 },
    } } };
  expect(applyGooseSessionNotification(makeState(), gooseUpdate(update))).toEqual([
    expect.objectContaining({ type: 'tokenState', tokenState: expect.objectContaining({
      totalTokens: 300, sessionStats: { decodeTokens: 440, decodeMs: 2000 },
    }) }),
  ]);
  update.status.data.sessionStats.decodeMs = -1;
  expect(applyGooseSessionNotification(makeState(), gooseUpdate(update))).toEqual([
    expect.objectContaining({ type: 'tokenState', tokenState: expect.not.objectContaining({ sessionStats: expect.anything() }) }),
  ]);
});

function gooseUpdate(
  update: GooseSessionNotification_unstable['update']
): GooseSessionNotification_unstable {
  return {
    sessionId: SESSION_ID,
    update,
  };
}

function message(id: string, role: Message['role']): Message {
  return {
    id,
    role,
    created: 1700000000,
    content: [{ type: 'text', text: `${role} ${id}` }],
    metadata: { userVisible: true, agentVisible: true },
  };
}

function makeState(): AdapterState {
  return {
    messages: [message('u1', 'user'), message('a1', 'assistant'), message('a2', 'assistant')],
    localSteerTextByMessageId: new Map(),
  };
}

const FULL_USAGE = {
  inputTokens: 1200,
  outputTokens: 340,
  totalTokens: 1540,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
  cost: 0.0123,
  costSource: 'estimated',
  elapsedMs: 4200,
  timeToFirstTokenMs: 840,
  isCompaction: false,
} satisfies MessageUsage;

function messageUsageNotification(
  messageId: string | undefined,
  usage: MessageUsage = FULL_USAGE
): GooseSessionNotification_unstable {
  return gooseUpdate({
    sessionUpdate: 'message_usage',
    ...(messageId !== undefined ? { messageId } : {}),
    usage,
  });
}

function expectOnlyMessagesChange(chatStateChanges: AcpChatStateChange[]): Message[] {
  expect(chatStateChanges).toHaveLength(1);

  const [chatStateChange] = chatStateChanges;
  expect(chatStateChange.type).toBe('messages');

  if (chatStateChange.type !== 'messages') {
    throw new Error('expected messages state change');
  }

  return chatStateChange.messages;
}

describe('applyGooseSessionNotification', () => {
  it('projects in-flight context source without adding a chat message or using cumulative billing', () => {
    const state = makeState();
    const changes = applyGooseSessionNotification(
      state,
      gooseUpdate({
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: '',
          data: {
            schema_version: 1,
            event: 'context_meter',
            used: 8400,
            contextLimit: 65536,
            source: 'streaming_estimate',
            contextSource: 'service',
          },
        },
      })
    );
    expect(changes).toEqual([
      {
        type: 'tokenState',
        tokenState: {
          totalTokens: 8400,
          contextLimit: 65536,
          contextUsageSource: 'streaming_estimate',
          contextCapacitySource: 'service',
        },
      },
    ]);
    expect(state.messages).toHaveLength(3);
  });
  it('upserts public progress by run and attempt without inferring state from localized text', () => {
    const state = makeState();
    const progress = {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      runId: 'run-1',
      taskId: 'coder-1',
      attemptId: 'coder-1:1',
      role: 'coder' as const,
      phase: 'coding' as const,
      status: 'running' as const,
      summary: '正在修复首次失败的测试 / failed test repair',
      currentFile: 'src/main.rs',
      currentCommand: 'cargo test --jobs 1',
      incrementalOutput: 'changed validation branch',
      startedAt: '2026-08-29T01:00:00Z',
      lastActivityAt: '2026-08-29T01:00:03Z',
      heartbeatAt: '2026-08-29T01:00:03Z',
      elapsedMs: 3_000,
    };

    applyGooseSessionNotification(
      state,
      gooseUpdate({ sessionUpdate: 'public_progress', progress })
    );
    applyGooseSessionNotification(
      state,
      gooseUpdate({
        sessionUpdate: 'public_progress',
        progress: { ...progress, status: 'completed', elapsedMs: 4_000 },
      })
    );

    const rows = state.messages.filter((item) => item.id?.startsWith('acp_codepro_progress_'));
    expect(rows).toHaveLength(1);
    expect(rows[0].content[0]).toMatchObject({
      type: 'systemNotification',
      notificationType: 'codeProActivity',
      msg: progress.summary,
      data: { status: 'completed', elapsedMs: 4_000 },
    });
  });

  it('upserts typed test progress by run and attempt without parsing display text', () => {
    const state = makeState();
    const progress = {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      runId: 'run-1',
      taskId: 'tester-1',
      attemptId: 'tester-1:1',
      phase: 'waiting_for_cargo_lock' as const,
      outcome: 'locked' as const,
      command: 'cargo test --jobs 1',
      cwd: 'D:\\project',
      elapsedMs: 4_000,
      heartbeatAt: '2026-08-26T08:00:04Z',
      retryAttempt: 0,
      repairAttempt: 0,
      canCancel: true,
    };

    applyGooseSessionNotification(
      state,
      gooseUpdate({ sessionUpdate: 'test_execution_progress', progress })
    );
    applyGooseSessionNotification(
      state,
      gooseUpdate({
        sessionUpdate: 'test_execution_progress',
        progress: { ...progress, phase: 'compiling', elapsedMs: 8_000 },
      })
    );

    const rows = state.messages.filter((item) => item.id?.startsWith('acp_codepro_test_'));
    expect(rows).toHaveLength(1);
    expect(rows[0].content[0]).toMatchObject({
      type: 'systemNotification',
      notificationType: 'codeProActivity',
      data: { phase: 'compiling', elapsedMs: 8_000 },
    });
  });

  describe('message_usage', () => {
    it('attaches usage to the message matching messageId', () => {
      const state = makeState();

      const changes = applyGooseSessionNotification(state, messageUsageNotification('a1'));

      const messages = expectOnlyMessagesChange(changes);
      expect(messages).toHaveLength(3);

      const [, first, second] = messages;
      expect(first.id).toBe('a1');
      expect(first.metadata.usage).toEqual(FULL_USAGE);
      expect(second.metadata.usage).toBeUndefined();

      expect(state.messages[1].metadata.usage).toEqual(FULL_USAGE);
    });

    it('retains the legacy fallback only when messageId is absent', () => {
      const state = makeState();

      const changes = applyGooseSessionNotification(state, messageUsageNotification(undefined));

      const messages = expectOnlyMessagesChange(changes);
      const [user, first, last] = messages;
      expect(user.metadata.usage).toBeUndefined();
      expect(first.metadata.usage).toBeUndefined();
      expect(last.id).toBe('a2');
      expect(last.metadata.usage).toEqual(FULL_USAGE);
    });

    it('keeps an early identified receipt hidden without overwriting another message', () => {
      const state = makeState();
      state.messages[2].metadata.usage = { inputTokens: 9, outputTokens: 2 };

      const changes = applyGooseSessionNotification(state, messageUsageNotification('future'));

      const messages = expectOnlyMessagesChange(changes);
      expect(messages).toHaveLength(4);
      expect(messages[2].metadata.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
      expect(messages[3]).toMatchObject({
        id: 'future',
        role: 'assistant',
        content: [],
        metadata: { userVisible: false, agentVisible: false, usage: FULL_USAGE },
      });
    });

    it('skips client-made approval rows when falling back', () => {
      const state = makeState();
      state.messages.push({
        id: 'acp_permission_t1',
        role: 'assistant',
        created: 1700000001,
        content: [
          {
            type: 'actionRequired',
            data: { actionType: 'toolConfirmation', id: 't1', toolName: 'shell', arguments: {} },
          },
        ],
        metadata: { userVisible: true, agentVisible: true },
      });

      const changes = applyGooseSessionNotification(state, messageUsageNotification(undefined));

      const messages = expectOnlyMessagesChange(changes);
      expect(messages[3].metadata.usage).toBeUndefined();
      expect(messages[2].id).toBe('a2');
      expect(messages[2].metadata.usage).toEqual(FULL_USAGE);
    });

    it('preserves a receipt before any assistant content exists', () => {
      const state: AdapterState = {
        messages: [message('u1', 'user')],
        localSteerTextByMessageId: new Map(),
      };

      const changes = applyGooseSessionNotification(state, messageUsageNotification('missing'));

      expect(expectOnlyMessagesChange(changes)[1]).toMatchObject({
        id: 'missing',
        content: [],
        metadata: { userVisible: false, agentVisible: false, usage: FULL_USAGE },
      });
      expect(state.messages[0].metadata.usage).toBeUndefined();
    });
  });

  describe('usage_update', () => {
    it('still maps usage updates into token state', () => {
      const changes = applyGooseSessionNotification(
        makeState(),
        gooseUpdate({
          sessionUpdate: 'usage_update',
          used: 42,
          contextLimit: 200,
          accumulatedInputTokens: 10,
          accumulatedOutputTokens: 15,
          accumulatedCost: 0.12,
        })
      );

      expect(changes).toEqual([
        {
          type: 'tokenState',
          tokenState: {
            totalTokens: 42,
            contextLimit: 200,
            accumulatedInputTokens: 10,
            accumulatedOutputTokens: 15,
            accumulatedTotalTokens: 25,
            accumulatedCost: 0.12,
          },
        },
      ]);
    });
  });

  describe('turn terminal status', () => {
    it('merges a persisted checkpoint terminal into its assistant report', () => {
      const state: AdapterState = {
        messages: [
          message('source-user-1', 'user'),
          {
            ...message('terminal-message-1', 'assistant'),
            content: [{ type: 'text', text: 'Current progress was saved.' }],
          },
        ],
        localSteerTextByMessageId: new Map(),
      };
      const terminal = {
        schema_version: 1,
        session_id: SESSION_ID,
        run_id: 'run-1',
        terminal_message_id: 'terminal-message-1',
        source_user_message_id: 'source-user-1',
        status: 'interrupted',
        checkpoint_id: 'checkpoint-1',
        retry_strategy: 'continue_checkpoint',
        visible_text_available: true,
        tool_action_count: 2,
        copy_artifact_ref: null,
        finished_at: '2026-07-31T08:00:00Z',
      } as const;

      const changes = applyGooseSessionNotification(
        state,
        gooseUpdate({
          sessionUpdate: 'status_message',
          status: {
            type: 'progress',
            message: 'CodePro checkpoint available',
            data: terminal,
          },
        })
      );

      const messages = expectOnlyMessagesChange(changes);
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        id: 'terminal-message-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Current progress was saved.' },
          {
            type: 'systemNotification',
            notificationType: 'turnTerminal',
            msg: 'CodePro checkpoint available',
            data: terminal,
          },
        ],
        metadata: { userVisible: true, agentVisible: true },
      });
    });

    it('restores failed validation evidence and its direct predecessor from status messages', () => {
      const state: AdapterState = {
        messages: [
          message('retry-user-1', 'user'),
          {
            ...message('failed-terminal-2', 'assistant'),
            content: [{ type: 'text', text: '单文件修改终态：FAIL' }],
          },
        ],
        localSteerTextByMessageId: new Map(),
      };
      const terminal = {
        schema_version: 1,
        session_id: SESSION_ID,
        run_id: 'retry-run-1',
        terminal_message_id: 'failed-terminal-2',
        source_user_message_id: 'retry-user-1',
        status: 'failed',
        checkpoint_id: null,
        retry_strategy: 'retry_failed_validation',
        visible_text_available: true,
        tool_action_count: 1,
        copy_artifact_ref: null,
        finished_at: '2026-08-01T12:01:00Z',
        retry_of_terminal_message_id: 'failed-terminal-1',
        validation_retry: {
          target_path: 'D:\\project\\app.rs',
          command: 'cargo check',
          exit_code: 1,
        },
      } as const;

      const changes = applyGooseSessionNotification(
        state,
        gooseUpdate({
          sessionUpdate: 'status_message',
          status: {
            type: 'progress',
            message: 'CodePro validation retry failed',
            data: terminal,
          },
        })
      );

      const messages = expectOnlyMessagesChange(changes);
      const restored = getTurnTerminalRecord(messages[1]);
      expect(restored).toMatchObject({
        retry_strategy: 'retry_failed_validation',
        retry_of_terminal_message_id: 'failed-terminal-1',
        validation_retry: {
          target_path: 'D:\\project\\app.rs',
          command: 'cargo check',
          exit_code: 1,
        },
      });
    });

    it('replaces the optimistic cancellation terminal with the persisted record', () => {
      const optimistic = {
        schema_version: 1,
        session_id: SESSION_ID,
        run_id: 'run-1',
        terminal_message_id: 'local-terminal',
        source_user_message_id: 'source-user-1',
        status: 'cancelled',
        checkpoint_id: null,
        retry_strategy: 'replay_user_request',
        visible_text_available: false,
        tool_action_count: 1,
        copy_artifact_ref: null,
        finished_at: '2026-08-01T08:00:00Z',
      } as const;
      const state: AdapterState = {
        messages: [
          message('source-user-1', 'user'),
          {
            id: 'local-terminal',
            role: 'assistant',
            created: 1785571200,
            content: [
              {
                type: 'systemNotification',
                notificationType: 'turnTerminal',
                msg: 'Turn stopped',
                data: optimistic,
              },
            ],
            metadata: { userVisible: true, agentVisible: false },
          },
        ],
        localSteerTextByMessageId: new Map(),
      };
      const persisted = {
        ...optimistic,
        terminal_message_id: 'persisted-terminal',
        finished_at: '2026-08-01T08:00:01Z',
      } as const;

      const changes = applyGooseSessionNotification(
        state,
        gooseUpdate({
          sessionUpdate: 'status_message',
          status: {
            type: 'progress',
            message: 'CodePro turn stopped',
            data: persisted,
          },
        })
      );

      const messages = expectOnlyMessagesChange(changes);
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        id: 'persisted-terminal',
        content: [
          {
            type: 'systemNotification',
            notificationType: 'turnTerminal',
            msg: 'CodePro turn stopped',
            data: persisted,
          },
        ],
      });
    });
  });
});
