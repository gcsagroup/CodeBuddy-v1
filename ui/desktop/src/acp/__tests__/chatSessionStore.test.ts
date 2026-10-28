import type {
  CreateElicitationRequest,
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types/message';
import { ChatState } from '../../types/chatState';
import { conversationUsage } from '../../components/conversationUsage';
import {
  requestAcpPermission,
  restoreAcpPermissionRequestsForSession,
  cancelAcpPermissionRequestsForSession,
} from '../permissionRequests';
import type { Session } from '../../types/session';
import {
  acpElicitationUserInputRequestId,
  acpChatSessionActions,
  acpPermissionUserInputRequestId,
  acpChatSessionStore,
  useAcpChatSessionSnapshot,
} from '../chatSessionStore';

function message(id: string, text: string): Message {
  return {
    id,
    role: 'user',
    created: 123,
    content: [{ type: 'text', text }],
    metadata: { userVisible: true, agentVisible: true },
  };
}

it('keeps late usage idle and replaces receipt-only messages at the history replay boundary', () => {
  const id = 'usage-replay-boundary';
  const receipt = {
    sessionId: id,
    update: {
      sessionUpdate: 'message_usage' as const,
      messageId: 'internal',
      usage: { inputTokens: 10, outputTokens: 2 },
    },
  };
  try {
    acpChatSessionActions.startPromptAttempt(id, 'attempt', 'user');
    acpChatSessionActions.finishPromptAttemptIfCurrent(id, 'attempt');
    const late = acpChatSessionActions.applyAcpGooseSessionNotification(receipt);
    expect(late.chatState).toBe(ChatState.Idle);
    expect(late.activeToolCallIds).toEqual([]);
    expect(conversationUsage(late.messages)).toEqual({ inputTokens: 10, outputTokens: 2 });

    acpChatSessionActions.startSessionLoad(id);
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { goose: { transcriptReplayStarted: true } },
      },
    });
    const replayed = acpChatSessionActions.applyAcpGooseSessionNotification({
      ...receipt,
      update: {
        ...receipt.update,
        messageId: 'restored',
        usage: { inputTokens: 20, outputTokens: 3 },
      },
    });
    expect(replayed.messages.map((item) => item.id)).toEqual(['restored']);
    expect(conversationUsage(replayed.messages)).toEqual({ inputTokens: 20, outputTokens: 3 });
    expect(late.messages[0].metadata.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  } finally {
    acpChatSessionActions.deleteSnapshot(id);
  }
});

it('accepts only current-turn file preparation metadata without adding a request or persisting it in history', () => {
  const id = 'tool-input-display';
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    acpChatSessionActions.startPromptAttempt(id, 'a', 'u');
    const update = (source: string, tool_input: unknown) =>
      acpChatSessionActions.applyAcpGooseSessionNotification({
        sessionId: id,
        update: {
          sessionUpdate: 'status_message',
          status: {
            type: 'progress',
            message: '',
            data: {
              schema_version: 1,
              event: 'execution_activity',
              source_user_message_id: source,
              run_id: 'run',
              phase: 'model',
              child_count: 0,
              tool_input,
            },
          },
        },
      } as never);
    update('other-turn', { id: 'w', name: 'write', kilobytes: 4 });
    expect(
      acpChatSessionStore.getSnapshot(id)?.promptActivity?.execution?.toolInput
    ).toBeUndefined();
    update('u', { id: 'w', name: 'write', kilobytes: 4, rawArguments: 'PRIVATE' });
    const snapshot = acpChatSessionStore.getSnapshot(id)!;
    expect(snapshot.promptActivity?.execution?.toolInput).toEqual({
      id: 'w',
      name: 'write',
      kilobytes: 4,
    });
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.activeToolCallIds).toEqual([]);
    expect(snapshot.promptActivity?.receivedAt).toBe(100_000);
    now.mockReturnValue(125_000);
    update('u', { id: 'w', name: 'write', kilobytes: 4 });
    expect(acpChatSessionStore.getSnapshot(id)?.promptActivity?.receivedAt).toBe(125_000);
    update('u', { id: null, name: 'write' });
    expect(
      acpChatSessionStore.getSnapshot(id)?.promptActivity?.execution?.toolInput
    ).toBeUndefined();
    acpChatSessionActions.finishPromptAttemptIfCurrent(id, 'a');
    update('u', { id: 'late', name: 'write', kilobytes: 5 });
    expect(acpChatSessionStore.getSnapshot(id)?.promptActivity).toBeUndefined();
  } finally {
    now.mockRestore();
    acpChatSessionActions.deleteSnapshot(id);
  }
});

it('publishes appended text without mutating earlier snapshots or replacing unchanged history', () => {
  const id = 'stream-snapshot-isolation';
  try {
    acpChatSessionActions.setMessages(id, [message('user', 'question')]);
    const delta = (text: string) =>
      acpChatSessionActions.applyAcpSessionNotification({
        sessionId: id,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'answer',
          content: { type: 'text', text },
        },
      });
    const first = delta('first');
    const second = delta(' second');
    expect(first.messages[1].content).toEqual([{ type: 'text', text: 'first' }]);
    expect(second.messages[1].content).toEqual([{ type: 'text', text: 'first second' }]);
    expect(second.messages[0]).toBe(first.messages[0]);
    expect(second.messages[1]).not.toBe(first.messages[1]);
    acpChatSessionActions.setMessages(id, [message('replacement', 'restored')]);
    const restored = delta('new');
    expect(restored.messages[0].id).toBe('replacement');
    expect(restored.messages[1].content).toEqual([{ type: 'text', text: 'new' }]);
  } finally {
    acpChatSessionActions.deleteSnapshot(id);
  }
});

function runningActivityMessage(sessionId: string): Message {
  return {
    id: 'activity-1',
    role: 'assistant',
    created: 123,
    content: [
      {
        type: 'systemNotification',
        notificationType: 'codeProActivity',
        msg: 'CodePro · 正在运行测试\n活动ID：event-1',
        data: {
          schema_version: 1,
          event_id: 'event-1',
          event_type: 'test_started',
          session_id: sessionId,
          run_id: 'run-1',
          task_id: 'task-1',
          parent_task_id: null,
          agent_role: 'tester',
          effective_model: 'ollama_cloud/deepseek-v4-flash',
          status: 'running',
          started_at: '2026-07-30T10:00:00Z',
          finished_at: null,
          title: '正在运行测试',
          technical_details: null,
          path: null,
          command_summary: 'cargo test',
          exit_code: null,
          diff_summary: null,
          include_in_model_context: true,
          retryable: false,
          retry_from_event_id: null,
        },
      },
    ],
    metadata: { userVisible: true, agentVisible: false },
  };
}

function session(id: string, conversation: Message[] = []): Session {
  return {
    id,
    name: `Session ${id}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    working_dir: '/tmp',
    message_count: conversation.length,
    extension_data: {},
    source: 'test',
    conversation,
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    accumulated_usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
  } as Session;
}

function permissionRequest(sessionId: string, toolCallId = 'tool-1'): RequestPermissionRequest {
  return {
    sessionId,
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    toolCall: {
      toolCallId,
      title: 'Edit file',
      rawInput: { path: 'README.md' },
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'Allow editing README.md?' },
        },
      ],
      _meta: {
        goose: {
          toolCall: {
            toolName: 'edit_file',
          },
        },
      },
    },
  };
}

function elicitationRequest(sessionId: string): {
  id: string;
  sessionId: string;
  expiresAt: number;
  request: CreateElicitationRequest & {
    mode: 'form';
    sessionId: string;
  };
} {
  return {
    id: 'acp_elicitation_1',
    sessionId,
    expiresAt: Date.now() + 300_000,
    request: {
      mode: 'form',
      sessionId,
      message: 'Choose a project',
      requestedSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
          },
        },
      },
    },
  };
}

function toolProgressNotification(sessionId: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'in_progress',
      _meta: {
        toolNotification: {
          type: 'progress',
          params: {
            progressToken: 'scan-repo',
            progress: 3,
          },
        },
      },
    },
  };
}

function agentMessageChunkNotification(
  sessionId: string,
  messageId: string,
  text: string
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: {
        type: 'text',
        text,
      },
    },
  };
}

function userSteerChunkNotification(
  sessionId: string,
  messageId: string,
  text: string
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      messageId,
      content: {
        type: 'text',
        text,
      },
      _meta: {
        goose: {
          messageId,
          steer: true,
        },
      },
    } as SessionNotification['update'],
  };
}

function activeRunNotification(sessionId: string, activeRunId: string | null): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      _meta: {
        goose: {
          activeRunId,
        },
      },
    } as SessionNotification['update'],
  };
}

function runningActivityNotification(sessionId: string, runId = 'run-1', eventId = 'event-1') {
  return {
    sessionId,
    update: {
      sessionUpdate: 'status_message',
      status: {
        type: 'progress',
        message: 'CodePro · 正在运行测试\n活动ID：event-1',
        data: {
          schema_version: 1,
          event_id: eventId,
          event_type: 'test_started',
          session_id: sessionId,
          run_id: runId,
          task_id: 'task-1',
          parent_task_id: null,
          agent_role: 'tester',
          effective_model: 'ollama_cloud/deepseek-v4-flash',
          status: 'running',
          started_at: '2026-07-30T10:00:00Z',
          finished_at: null,
          title: '正在运行测试',
          technical_details: null,
          path: null,
          command_summary: 'cargo test',
          exit_code: null,
          diff_summary: null,
          include_in_model_context: true,
          retryable: false,
          retry_from_event_id: null,
        },
      },
    },
  } as never;
}

function turnTerminalNotification(
  sessionId: string,
  runId: string,
  terminalMessageId: string,
  status: 'cancelled' | 'interrupted' = 'cancelled'
) {
  return {
    sessionId,
    update: {
      sessionUpdate: 'status_message',
      status: {
        type: 'progress',
        message: 'CodePro turn stopped',
        data: {
          schema_version: 1,
          session_id: sessionId,
          run_id: runId,
          terminal_message_id: terminalMessageId,
          source_user_message_id: 'user-1',
          status,
          checkpoint_id: null,
          retry_strategy: 'replay_user_request',
          visible_text_available: false,
          tool_action_count: 1,
          copy_artifact_ref: null,
          finished_at: '2026-08-01T08:00:01Z',
        },
      },
    },
  } as never;
}

function completedSkippedTurnTerminalNotification(sessionId: string, runId: string) {
  return {
    sessionId,
    update: {
      sessionUpdate: 'status_message',
      status: {
        type: 'progress',
        message: 'CodePro terminal report',
        data: {
          schema_version: 1,
          session_id: sessionId,
          run_id: runId,
          terminal_message_id: 'terminal-skipped',
          source_user_message_id: 'user-1',
          status: 'completed',
          checkpoint_id: null,
          retry_strategy: 'not_available',
          visible_text_available: true,
          tool_action_count: 1,
          copy_artifact_ref: null,
          finished_at: '2026-08-27T08:00:01Z',
          report: {
            outcome: 'skipped',
            classification_counts: {
              confirmed_bug: 0,
              test_failure: 0,
              environment_problem: 0,
              codepro_incomplete: 0,
              unverified: 0,
            },
            changed_files: [],
            verification_summary: [
              {
                task_id: 'task-1',
                verdict: 'skipped',
                command: null,
                exit_code: null,
                evidence_ref: 'verify-1',
              },
            ],
            limitations: [],
            recovery_action: 'none',
          },
        },
      },
    },
  } as never;
}

describe('acpChatSessionStore', () => {
  it('restores one live background approval after loading its history', async () => {
    const id = sessionId('background-permission-replay');
    const response = requestAcpPermission(permissionRequest(id));
    try {
      acpChatSessionActions.startSessionLoad(id);
      acpChatSessionActions.applyAcpSessionNotification(activeRunNotification(id, 'scheduled-run'));
      acpChatSessionActions.finishSessionLoad(id, session(id));
      restoreAcpPermissionRequestsForSession(id);
      restoreAcpPermissionRequestsForSession(id);
      const snapshot = acpChatSessionStore.getSnapshot(id)!;
      expect(snapshot.chatState).toBe(ChatState.WaitingForUserInput);
      expect(
        snapshot.messages
          .flatMap((message) => message.content)
          .filter((content) => content.type === 'actionRequired' && content.data.id === 'tool-1')
      ).toHaveLength(1);
    } finally {
      cancelAcpPermissionRequestsForSession(id);
      await response;
    }
  });
  it('applies mode updates after cancellation only to the addressed session', () => {
    const first = sessionId('mode-first');
    const second = sessionId('mode-second');
    acpChatSessionActions.finishSessionLoad(first, {
      ...session(first),
      goose_mode: 'danger-full-access',
    });
    acpChatSessionActions.finishSessionLoad(second, {
      ...session(second),
      goose_mode: 'read-only',
    });
    acpChatSessionActions.startPromptAttempt(first, 'mode-attempt', 'user-1');
    acpChatSessionActions.startPromptCancellation(first, 'mode-attempt');
    acpChatSessionActions.clearPromptCancellation(first, 'mode-attempt');
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: first,
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'workspace-write' },
    });
    expect(acpChatSessionStore.getSnapshot(first)?.session?.goose_mode).toBe('workspace-write');
    expect(acpChatSessionStore.getSnapshot(second)?.session?.goose_mode).toBe('read-only');
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: first,
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'future-mode' },
    });
    expect(acpChatSessionStore.getSnapshot(first)?.session?.goose_mode).toBeUndefined();
    expect(acpChatSessionStore.getSnapshot(second)?.session?.goose_mode).toBe('read-only');
  });

  const sessionIds = new Set<string>();
  const sessionId = (id: string): string => {
    sessionIds.add(id);
    return id;
  };

  afterEach(() => {
    for (const id of sessionIds) {
      acpChatSessionActions.deleteSnapshot(id);
    }
    sessionIds.clear();
  });

  it('keeps request occupancy after a live terminal and history reload until that RPC settles', () => {
    const id = sessionId('terminal-before-prompt-settle');
    expect(acpChatSessionActions.startPromptRequest(id, 'request-1')).toBe(true);
    acpChatSessionActions.startPromptAttempt(id, 'request-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(activeRunNotification(id, 'run-1'));
    const ended = acpChatSessionActions.applyAcpGooseSessionNotification(
      completedSkippedTurnTerminalNotification(id, 'run-1')
    );
    expect(ended.chatState).toBe(ChatState.Idle);
    expect(ended.activePromptAttemptId).toBeNull();
    expect(ended.thinkingActivity).toBeUndefined();
    expect(ended.promptRequestId).toBe('request-1');
    expect(acpChatSessionActions.startPromptRequest(id, 'request-2')).toBe(false);
    acpChatSessionActions.startSessionLoad(id);
    acpChatSessionActions.finishSessionLoad(id, session(id));
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBe('request-1');
    acpChatSessionActions.finishPromptRequest(id, 'stale-request');
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBe('request-1');
    acpChatSessionActions.finishPromptRequest(id, 'request-1');
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBeNull();
    expect(acpChatSessionActions.startPromptRequest(id, 'request-2')).toBe(true);
    acpChatSessionActions.finishPromptRequest(id, 'request-1');
    expect(acpChatSessionStore.getSnapshot(id)?.promptRequestId).toBe('request-2');
    acpChatSessionActions.finishPromptRequest(id, 'request-2');
  });

  it.each(['cancelled', 'interrupted'] as const)(
    'ends a disconnected prompt after replaying its bound %s terminal',
    (status) => {
      const id = sessionId('disconnected-terminal-' + status);
      acpChatSessionActions.startPromptAttempt(id, 'disconnected-attempt', 'user-1');
      acpChatSessionActions.applyAcpSessionNotification(activeRunNotification(id, 'run-1'));
      acpChatSessionActions.startSessionLoad(id);
      acpChatSessionActions.applyAcpGooseSessionNotification(
        turnTerminalNotification(id, 'run-1', 'native-terminal', status)
      );
      const restored = acpChatSessionActions.finishSessionLoad(id, session(id));
      expect(restored).toMatchObject({
        chatState: ChatState.Idle,
        activePromptAttemptId: null,
        activeRunId: null,
        promptRequestId: null,
      });
    }
  );

  it('does not create request occupancy when replaying history', () => {
    const id = sessionId('history-has-no-request');
    acpChatSessionActions.startSessionLoad(id);
    acpChatSessionActions.applyAcpGooseSessionNotification(
      completedSkippedTurnTerminalNotification(id, 'run-1')
    );
    const ended = acpChatSessionActions.finishSessionLoad(id, session(id));
    expect(ended.chatState).toBe(ChatState.Idle);
    expect(ended.promptRequestId).toBeNull();
  });

  it('finishes session load with session metadata', () => {
    const currentSessionId = sessionId('session-1');
    const initialMessage = message('message-1', 'Hello');

    acpChatSessionActions.setMessages(currentSessionId, [initialMessage]);

    const snapshot = acpChatSessionActions.finishSessionLoad(
      currentSessionId,
      session(currentSessionId)
    );

    expect(snapshot.session?.id).toBe(currentSessionId);
    expect(snapshot.messages).toEqual([initialMessage]);
    expect(snapshot.chatState).toBe(ChatState.Idle);
    expect(snapshot.sessionLoadError).toBeUndefined();
  });

  it('stores workspace re-confirmation separately from generic session load errors', () => {
    const currentSessionId = sessionId('codepro-resume-session');
    const request = {
      sessionId: currentSessionId,
      workingDir: 'D:\\Projects\\Ledger',
    };

    const blocked = acpChatSessionActions.requireWorkspaceReconfirmation(currentSessionId, request);

    expect(blocked.workspaceReconfirmation).toEqual(request);
    expect(blocked.sessionLoadError).toBeUndefined();
    expect(blocked.chatState).toBe(ChatState.Idle);

    const loading = acpChatSessionActions.startSessionLoad(currentSessionId);
    expect(loading.workspaceReconfirmation).toBeUndefined();
  });

  it('keeps multiple session snapshots isolated', () => {
    const firstSessionId = sessionId('session-1');
    const secondSessionId = sessionId('session-2');

    acpChatSessionActions.setMessages(firstSessionId, [message('message-1', 'One')]);
    acpChatSessionActions.setMessages(secondSessionId, [message('message-2', 'Two')]);

    expect(acpChatSessionStore.getSnapshot(firstSessionId)?.messages[0].id).toBe('message-1');
    expect(acpChatSessionStore.getSnapshot(secondSessionId)?.messages[0].id).toBe('message-2');
  });

  it('deletes session snapshots', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.setMessages(currentSessionId, [message('message-1', 'One')]);

    acpChatSessionActions.deleteSnapshot(currentSessionId);

    expect(acpChatSessionStore.getSnapshot(currentSessionId)).toBeUndefined();
  });

  it('scopes live tool presentation to new calls in the current session attempt', () => {
    const first = sessionId('tool-presentation');
    const other = sessionId('tool-presentation-other');
    const call = (id: string): SessionNotification => ({
      sessionId: first,
      update: { sessionUpdate: 'tool_call', toolCallId: id, title: 'Read file', status: 'pending' },
    });
    acpChatSessionActions.applyAcpSessionNotification(call('historical'));
    acpChatSessionActions.startPromptAttempt(first, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(call('historical'));
    acpChatSessionActions.applyAcpSessionNotification(call('parallel-a'));
    acpChatSessionActions.applyAcpSessionNotification(call('parallel-b'));
    expect(acpChatSessionStore.getSnapshot(first)?.activeToolCallIds).toEqual([
      'parallel-a',
      'parallel-b',
    ]);
    acpChatSessionActions.applyPermissionRequest(permissionRequest(first, 'parallel-a'));
    expect(acpChatSessionStore.getSnapshot(first)?.activeToolCallIds).toEqual([
      'parallel-a',
      'parallel-b',
    ]);
    acpChatSessionActions.startPromptAttempt(other, 'other-attempt', 'other-user');
    expect(acpChatSessionStore.getSnapshot(other)?.activeToolCallIds).toEqual([]);
    acpChatSessionActions.finishPromptAttemptIfCurrent(first, 'attempt-1');
    expect(acpChatSessionStore.getSnapshot(first)?.activeToolCallIds).toEqual([]);
    acpChatSessionActions.startPromptAttempt(first, 'attempt-2', 'user-2');
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: first,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'parallel-a', status: 'completed' },
    });
    acpChatSessionActions.applyAcpSessionNotification(call('parallel-b'));
    expect(acpChatSessionStore.getSnapshot(first)?.activeToolCallIds).toEqual([]);
    acpChatSessionActions.applyAcpSessionNotification(call('new-call'));
    expect(acpChatSessionStore.getSnapshot(first)?.activeToolCallIds).toEqual(['new-call']);
  });

  it('exposes only the current prompt source message id for terminal correlation', () => {
    const currentSessionId = sessionId('source-correlation');

    expect(acpChatSessionStore.getActivePromptSourceUserMessageId(currentSessionId)).toBeNull();
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'source-user-1');
    expect(acpChatSessionStore.getActivePromptSourceUserMessageId(currentSessionId)).toBe(
      'source-user-1'
    );

    acpChatSessionActions.finishPromptAttemptIfCurrent(currentSessionId, 'attempt-1');
    expect(acpChatSessionStore.getActivePromptSourceUserMessageId(currentSessionId)).toBeNull();
  });

  it('ignores stale prompt attempts and leaves the current attempt active', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-a', 'user-a');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-b', 'user-b');

    expect(
      acpChatSessionActions.finishPromptAttemptIfCurrent(
        currentSessionId,
        'attempt-a',
        'late error'
      )
    ).toBe(false);

    expect(acpChatSessionStore.getSnapshot(currentSessionId)).toMatchObject({
      activePromptAttemptId: 'attempt-b',
      chatState: ChatState.Streaming,
      sessionLoadError: undefined,
    });

    expect(acpChatSessionActions.finishPromptAttemptIfCurrent(currentSessionId, 'attempt-b')).toBe(
      true
    );
    expect(acpChatSessionStore.getSnapshot(currentSessionId)).toMatchObject({
      activePromptAttemptId: null,
      chatState: ChatState.Idle,
    });
  });

  it('stores prompt failures separately from fatal session load errors', () => {
    const currentSessionId = sessionId('session-1');
    const loadedSession = session(currentSessionId);
    acpChatSessionActions.setSessionMetadata(currentSessionId, loadedSession);
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');

    expect(
      acpChatSessionActions.finishPromptAttemptIfCurrent(
        currentSessionId,
        'attempt-1',
        'Submit error: workspace rejected'
      )
    ).toBe(true);

    expect(acpChatSessionStore.getSnapshot(currentSessionId)).toMatchObject({
      session: loadedSession,
      activePromptAttemptId: null,
      chatState: ChatState.Idle,
      promptError: 'Submit error: workspace rejected',
      sessionLoadError: undefined,
    });

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-2', 'user-2');
    expect(acpChatSessionStore.getSnapshot(currentSessionId)?.promptError).toBeUndefined();
  });

  it('dismisses a prompt error without clearing session state', () => {
    const currentSessionId = sessionId('session-1');
    const loadedSession = session(currentSessionId);
    acpChatSessionActions.setSessionMetadata(currentSessionId, loadedSession);
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.finishPromptAttemptIfCurrent(
      currentSessionId,
      'attempt-1',
      'Submit error: retry available'
    );

    const snapshot = acpChatSessionActions.clearPromptError(currentSessionId);

    expect(snapshot.session).toEqual(loadedSession);
    expect(snapshot.promptError).toBeUndefined();
    expect(snapshot.sessionLoadError).toBeUndefined();
  });

  it('keeps loaded sessions streaming when a prompt attempt is active', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');

    const snapshot = acpChatSessionActions.finishSessionLoad(
      currentSessionId,
      session(currentSessionId)
    );

    expect(snapshot.activePromptAttemptId).toBe('attempt-1');
    expect(snapshot.chatState).toBe(ChatState.Streaming);
  });

  it('tracks prompt cancellation separately from visible prompt activity', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    const cancellationSnapshot = acpChatSessionActions.startPromptCancellation(
      currentSessionId,
      'attempt-1'
    );

    expect(cancellationSnapshot).toMatchObject({
      activePromptAttemptId: null,
      pendingCancelPromptAttemptId: 'attempt-1',
      chatState: ChatState.Idle,
    });

    const staleClearSnapshot = acpChatSessionActions.clearPromptCancellation(
      currentSessionId,
      'attempt-2'
    );
    expect(staleClearSnapshot).toBeUndefined();
    expect(acpChatSessionStore.getSnapshot(currentSessionId)?.pendingCancelPromptAttemptId).toBe(
      'attempt-1'
    );

    const clearedSnapshot = acpChatSessionActions.clearPromptCancellation(
      currentSessionId,
      'attempt-1'
    );

    expect(clearedSnapshot?.pendingCancelPromptAttemptId).toBeNull();
  });

  it('terminalizes running CodePro activities when prompt cancellation starts', () => {
    const currentSessionId = sessionId('session-1');
    acpChatSessionActions.setMessages(currentSessionId, [runningActivityMessage(currentSessionId)]);
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');

    const beforeCancellation = acpChatSessionStore.getSnapshot(currentSessionId);
    const cancellationSnapshot = acpChatSessionActions.startPromptCancellation(
      currentSessionId,
      'attempt-1'
    );
    const activity = cancellationSnapshot?.messages[0].content[0];

    expect(beforeCancellation?.messages[0].content[0]).toMatchObject({
      data: { status: 'running' },
    });

    expect(activity).toMatchObject({
      type: 'systemNotification',
      notificationType: 'codeProActivity',
      data: {
        event_id: 'event-1',
        status: 'stopped',
      },
    });
    expect(
      activity?.type === 'systemNotification' &&
        typeof activity.data === 'object' &&
        activity.data !== null &&
        'finished_at' in activity.data
        ? activity.data.finished_at
        : null
    ).toEqual(expect.any(String));
  });

  it('marks dangling CodePro activities interrupted after a crashed session is restored', () => {
    const currentSessionId = sessionId('crash-recovery-session');

    acpChatSessionActions.startSessionLoad(currentSessionId);
    acpChatSessionActions.setMessages(currentSessionId, [runningActivityMessage(currentSessionId)]);
    const restored = acpChatSessionActions.finishSessionLoad(
      currentSessionId,
      session(currentSessionId)
    );

    expect(restored.chatState).toBe(ChatState.Idle);
    expect(restored.messages[0].content[0]).toMatchObject({
      type: 'systemNotification',
      notificationType: 'codeProActivity',
      data: {
        event_id: 'event-1',
        status: 'interrupted',
        finished_at: expect.any(String),
      },
    });
  });

  it('updates context usage during a running task and finishes idle compaction without reopening a sealed task', () => {
    const id = sessionId('live-context-maintenance');
    acpChatSessionActions.setMessages(id, [message('user-1', 'Preserve my draft')]);
    acpChatSessionActions.startPromptAttempt(id, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(activeRunNotification(id, 'run-1'));
    for (const used of [21_000, 45_000]) {
      acpChatSessionActions.applyAcpGooseSessionNotification({
        sessionId: id,
        update: {
          sessionUpdate: 'usage_update',
          used,
          contextLimit: 128_000,
          accumulatedInputTokens: used,
          accumulatedOutputTokens: 0,
        },
      });
      expect(acpChatSessionStore.getSnapshot(id)?.tokenState.totalTokens).toBe(used);
      expect(acpChatSessionStore.getSnapshot(id)?.activeRunId).toBe('run-1');
    }
    acpChatSessionActions.startPromptCancellation(id, 'attempt-1');
    acpChatSessionActions.clearPromptCancellation(id, 'attempt-1');
    acpChatSessionActions.applyAcpSessionNotification(activeRunNotification(id, null));
    for (const status of ['started', 'completed'] as const) {
      acpChatSessionActions.applyAcpGooseSessionNotification({
        sessionId: id,
        update: {
          sessionUpdate: 'status_message',
          status: {
            type: 'progress',
            message: 'Context maintenance',
            data: {
              schema_version: 1,
              event: 'compaction_lifecycle',
              operation_id: 'idle-compact',
              status,
              trigger: 'auto',
              started_at: '2026-09-30T03:00:00Z',
            },
          },
        },
      });
      expect(acpChatSessionStore.getSnapshot(id)?.chatState).toBe(
        status === 'started' ? ChatState.Compacting : ChatState.Idle
      );
    }
    acpChatSessionActions.applyAcpGooseSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'usage_update',
        used: 800,
        contextLimit: 128_000,
        accumulatedInputTokens: 70_000,
        accumulatedOutputTokens: 2_000,
      },
    });
    acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(id, 'stale', 'must stay sealed')
    );
    expect(acpChatSessionStore.getSnapshot(id)?.messages.some((m) => m.id === 'stale')).toBe(false);
    expect(acpChatSessionStore.getSnapshot(id)?.tokenState.totalTokens).toBe(800);
    acpChatSessionActions.applyAcpGooseSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: '',
          data: {
            schema_version: 1,
            event: 'context_meter',
            used: 800,
            contextLimit: 128_000,
            source: 'local_estimate',
            contextSource: 'configured',
          },
        },
      },
    });
    expect(acpChatSessionStore.getSnapshot(id)?.tokenState.contextUsageSource).toBe(
      'local_estimate'
    );
    expect(acpChatSessionStore.getSnapshot(id)?.tokenState.contextCapacitySource).toBe(
      'configured'
    );
    expect(acpChatSessionStore.getSnapshot(id)?.chatState).toBe(ChatState.Idle);
  });

  it('keeps a cancelled turn sealed after late provider and tool events arrive', () => {
    const currentSessionId = sessionId('sealed-session');
    acpChatSessionActions.setMessages(currentSessionId, [message('user-1', 'Run the tests')]);
    acpChatSessionActions.applyAcpGooseSessionNotification(
      runningActivityNotification(currentSessionId)
    );
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.clearPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, null)
    );

    const sealedSnapshot = acpChatSessionStore.getSnapshot(currentSessionId);
    const sealedMessageCount = sealedSnapshot?.messages.length;

    acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(currentSessionId, 'late-assistant', 'late response')
    );
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    const snapshot = acpChatSessionActions.applyAcpGooseSessionNotification(
      runningActivityNotification(currentSessionId)
    );
    const activity = snapshot.messages
      .find((candidate) => candidate.id === `acp_codepro_activity_${currentSessionId}_event-1`)
      ?.content.find(
        (content) =>
          content.type === 'systemNotification' && content.notificationType === 'codeProActivity'
      );

    expect(snapshot.messages).toHaveLength(sealedMessageCount ?? 0);
    expect(snapshot.messages.some((candidate) => candidate.id === 'late-assistant')).toBe(false);
    expect(snapshot.activeRunId).toBeNull();
    expect(snapshot.chatState).toBe(ChatState.Idle);
    expect(activity).toMatchObject({
      type: 'systemNotification',
      data: { run_id: 'run-1', status: 'stopped' },
    });
  });

  it('accepts the authoritative terminal record while a cancelled turn is sealed', () => {
    const currentSessionId = sessionId('authoritative-terminal-session');
    const toolMessage: Message = {
      id: 'assistant-tool-1',
      role: 'assistant',
      created: 124,
      content: [
        {
          type: 'toolRequest',
          id: 'tool-1',
          toolCall: { name: 'developer__shell', arguments: { command: 'pnpm test' } },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };
    acpChatSessionActions.setMessages(currentSessionId, [
      message('user-1', 'Run the tests'),
      toolMessage,
    ]);
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.clearPromptCancellation(currentSessionId, 'attempt-1');

    const snapshot = acpChatSessionActions.applyAcpGooseSessionNotification(
      turnTerminalNotification(currentSessionId, 'run-1', 'persisted-terminal')
    );
    const terminalMessages = snapshot.messages.filter((candidate) =>
      candidate.content.some(
        (content) =>
          content.type === 'systemNotification' && content.notificationType === 'turnTerminal'
      )
    );

    expect(terminalMessages).toHaveLength(1);
    expect(terminalMessages[0]).toMatchObject({
      id: 'persisted-terminal',
      content: [
        {
          type: 'systemNotification',
          data: { run_id: 'run-1', status: 'cancelled' },
        },
      ],
    });
    expect(snapshot.chatState).toBe(ChatState.Idle);
  });

  it('stops showing a running prompt as soon as a completed skipped terminal arrives', () => {
    const currentSessionId = sessionId('completed-skipped-terminal-session');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );

    const snapshot = acpChatSessionActions.applyAcpGooseSessionNotification(
      completedSkippedTurnTerminalNotification(currentSessionId, 'run-1')
    );

    expect(snapshot.activeRunId).toBeNull();
    expect(snapshot.chatState).toBe(ChatState.Idle);
    expect(snapshot.progressMessage).toBeUndefined();
  });

  it.each(['answer-1', 'user-1', null])(
    'restores replay order with active source %s when a live completed terminal arrives before history',
    (sourceId) => {
      const currentSessionId = sessionId('live-terminal-before-history');
      const completed = completedSkippedTurnTerminalNotification(currentSessionId, 'run-1');
      if (sourceId !== null) {
        acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', sourceId);
      }
      acpChatSessionActions.startSessionLoad(currentSessionId);
      acpChatSessionActions.applyAcpGooseSessionNotification(completed);

      const replayUser = (id: string, text: string) =>
        acpChatSessionActions.applyAcpSessionNotification({
          sessionId: currentSessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text },
            _meta: { goose: { messageId: id, created: 123 } },
          },
        });
      replayUser('user-1', 'Test add after confirming the command');
      acpChatSessionActions.applyAcpGooseSessionNotification(
        turnTerminalNotification(currentSessionId, 'run-1', 'previous-terminal')
      );
      replayUser('answer-1', 'focused-test: node tests.js');
      acpChatSessionActions.applyAcpSessionNotification({
        sessionId: currentSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'The test passed once.' },
          _meta: { goose: { messageId: 'terminal-skipped', created: 124 } },
        },
      });
      acpChatSessionActions.applyAcpGooseSessionNotification(completed);
      const restored = acpChatSessionActions.finishSessionLoad(
        currentSessionId,
        session(currentSessionId)
      );

      expect(restored.messages.map((item) => item.id)).toEqual([
        'user-1',
        'previous-terminal',
        'answer-1',
        'terminal-skipped',
      ]);
      expect(restored.messages[restored.messages.length - 1]?.content).toContainEqual({
        type: 'text',
        text: 'The test passed once.',
      });

      acpChatSessionActions.addPendingLocalSteerMessage(
        currentSessionId,
        message('next-user', 'A different task')
      );
      const repeated = acpChatSessionActions.applyAcpGooseSessionNotification(completed);
      expect(repeated.messages.map((item) => item.id)).toEqual([
        'user-1',
        'previous-terminal',
        'answer-1',
        'terminal-skipped',
        'next-user',
      ]);
      if (sourceId !== 'answer-1') {
        const late = acpChatSessionActions.applyAcpSessionNotification(
          agentMessageChunkNotification(currentSessionId, 'late-message', 'stale output')
        );
        expect(late.messages.map((item) => item.id)).not.toContain('late-message');
      }
    }
  );

  it('replaces deltas received before the authoritative replay boundary without duplicating or reordering them', () => {
    const id = sessionId('schedule-replay-race');
    acpChatSessionActions.startSessionLoad(id);
    acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(id, 'answer', 'Hello')
    );
    const boundary: SessionNotification = {
      sessionId: id,
      update: { sessionUpdate: 'session_info_update', _meta: { goose: { transcriptReplayStarted: true } } },
    };
    acpChatSessionActions.applyAcpSessionNotification(boundary);
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Run report' }, messageId: 'user' },
    });
    acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(id, 'answer', 'Hello')
    );
    acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(id, 'answer', ' world')
    );
    const restored = acpChatSessionActions.finishSessionLoad(id, session(id));
    expect(restored.messages.map((item) => item.id)).toEqual(['user', 'answer']);
    expect(restored.messages[1].content).toContainEqual({ type: 'text', text: 'Hello world' });
    // Late markers outside an explicit history load never erase live messages.
    expect(acpChatSessionActions.applyAcpSessionNotification(boundary).messages).toEqual(restored.messages);
  });

  it('does not reposition a live terminal after a failed history load', () => {
    const currentSessionId = sessionId('failed-load-terminal-order');
    const completed = completedSkippedTurnTerminalNotification(currentSessionId, 'run-1');
    acpChatSessionActions.startSessionLoad(currentSessionId);
    acpChatSessionActions.applyAcpGooseSessionNotification(completed);
    acpChatSessionActions.failSessionLoad(currentSessionId, 'Disconnected');
    acpChatSessionActions.addPendingLocalSteerMessage(
      currentSessionId,
      message('next-user', 'A different task')
    );
    const repeated = acpChatSessionActions.applyAcpGooseSessionNotification(completed);
    expect(repeated.messages.map((item) => item.id)).toEqual(['terminal-skipped', 'next-user']);
  });

  it('keeps a replayed terminal idle after a disconnected prompt is restored', () => {
    const currentSessionId = sessionId('replayed-terminal-session');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );

    acpChatSessionActions.startSessionLoad(currentSessionId);
    const terminalSnapshot = acpChatSessionActions.applyAcpGooseSessionNotification(
      completedSkippedTurnTerminalNotification(currentSessionId, 'run-1')
    );
    const restoredSnapshot = acpChatSessionActions.finishSessionLoad(
      currentSessionId,
      session(currentSessionId)
    );

    expect(terminalSnapshot).toMatchObject({
      activePromptAttemptId: null,
      activeRunId: null,
      pendingCancelPromptAttemptId: null,
      chatState: ChatState.LoadingConversation,
    });
    expect(restoredSnapshot).toMatchObject({
      activePromptAttemptId: null,
      activeRunId: null,
      chatState: ChatState.Idle,
    });
  });

  it('unseals notifications when prompt cancellation is restored', () => {
    const currentSessionId = sessionId('restored-cancellation-session');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.restorePromptCancellation(currentSessionId, 'attempt-1');

    const snapshot = acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(currentSessionId, 'assistant-after-restore', 'still running')
    );

    expect(snapshot.messages.some((candidate) => candidate.id === 'assistant-after-restore')).toBe(
      true
    );
    expect(snapshot.chatState).toBe(ChatState.Streaming);
  });

  it('keeps answer deltas flowing after the presentation boundary and seals only on the real terminal', () => {
    const id = sessionId('answer-phase-stream');
    acpChatSessionActions.startPromptAttempt(id, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(activeRunNotification(id, 'run-1'));
    acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(id, 'answer', 'FIRST.')
    );
    const phase = acpChatSessionActions.applyAcpGooseSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: '',
          data: {
            type: 'codepro_response_phase',
            schema_version: 1,
            event_type: 'response_phase',
            event_id: 'phase-1',
            session_id: id,
            run_id: 'run-1',
            source_user_message_id: 'user-1',
            phase: 'answer',
            created_at: 200,
          },
        },
      },
    });
    expect(phase.chatState).toBe(ChatState.Streaming);
    expect(phase.activePromptAttemptId).toBe('attempt-1');
    const streamed = acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(id, 'answer', 'LAST.')
    );
    expect(streamed.messages.find((message) => message.id === 'answer')?.content).toContainEqual({
      type: 'text',
      text: 'FIRST.LAST.',
    });
    const finished = acpChatSessionActions.applyAcpGooseSessionNotification(
      completedSkippedTurnTerminalNotification(id, 'run-1')
    );
    expect(finished.activeRunId).toBeNull();
    const late = acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(id, 'late', 'MUST NOT APPEND')
    );
    expect(late.messages.some((message) => message.id === 'late')).toBe(false);
  });

  it('does not restore a prompt after its authoritative terminal record arrives', () => {
    const currentSessionId = sessionId('terminal-before-restore-session');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.applyAcpGooseSessionNotification(
      turnTerminalNotification(currentSessionId, 'run-1', 'persisted-terminal')
    );

    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: currentSessionId,
      update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } },
    } as SessionNotification);
    const restoredSnapshot = acpChatSessionActions.restorePromptCancellation(
      currentSessionId,
      'attempt-1'
    );
    const snapshot = acpChatSessionActions.applyAcpGooseSessionNotification(
      runningActivityNotification(currentSessionId, 'run-1', 'late-event')
    );

    expect(restoredSnapshot).toBeUndefined();
    expect(acpChatSessionStore.getSnapshot(currentSessionId)).toMatchObject({
      activePromptAttemptId: null,
      activeRunId: null,
      pendingCancelPromptAttemptId: null,
      chatState: ChatState.Idle,
    });
    expect(
      snapshot.messages.some(
        (candidate) => candidate.id === `acp_codepro_activity_${currentSessionId}_late-event`
      )
    ).toBe(false);
  });

  it('keeps an old run sealed after a new prompt starts', () => {
    const currentSessionId = sessionId('new-prompt-session');
    acpChatSessionActions.applyAcpGooseSessionNotification(
      runningActivityNotification(currentSessionId)
    );
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.clearPromptCancellation(currentSessionId, 'attempt-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-2', 'user-2');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-2')
    );
    acpChatSessionActions.applyAcpGooseSessionNotification(
      runningActivityNotification(currentSessionId, 'run-1', 'event-1')
    );
    const snapshot = acpChatSessionActions.applyAcpGooseSessionNotification(
      runningActivityNotification(currentSessionId, 'run-2', 'event-2')
    );

    const activities = snapshot.messages
      .flatMap((candidate) => candidate.content)
      .filter(
        (content) =>
          content.type === 'systemNotification' && content.notificationType === 'codeProActivity'
      );
    expect(snapshot.activeRunId).toBe('run-2');
    expect(snapshot.chatState).toBe(ChatState.Streaming);
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ run_id: 'run-1', status: 'stopped' }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({ run_id: 'run-2', status: 'running' }),
        }),
      ])
    );
  });

  it('accepts host direct-tool approval after a sealed turn without reopening late model activity', () => {
    const id = sessionId('direct-git-after-turn');
    acpChatSessionActions.startPromptAttempt(id, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(activeRunNotification(id, 'run-1'));
    acpChatSessionActions.applyAcpGooseSessionNotification(
      completedSkippedTurnTerminalNotification(id, 'run-1')
    );
    acpChatSessionActions.finishPromptAttemptIfCurrent(id, 'attempt-1');
    const meta = { goose: { directToolCall: true } };
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'direct-git',
        title: 'git_stage',
        status: 'in_progress',
        _meta: meta,
      },
    });
    const pending = acpChatSessionActions.applyPermissionRequest({
      ...permissionRequest(id, 'direct-git'),
      _meta: meta,
    });
    expect(pending.chatState).toBe(ChatState.WaitingForUserInput);
    expect(pending.activePromptAttemptId).toBeNull();
    expect(pending.activeRunId).toBeNull();
    expect(pending.messages.flatMap((m) => m.content)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'actionRequired',
          data: expect.objectContaining({ id: 'direct-git' }),
        }),
      ])
    );
    acpChatSessionActions.resolveUserInputRequest(
      id,
      acpPermissionUserInputRequestId('direct-git')
    );
    const finished = acpChatSessionActions.applyAcpSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'direct-git',
        status: 'completed',
        _meta: meta,
      },
    });
    expect(finished.chatState).toBe(ChatState.Idle);
    expect(finished.activeToolCallIds).toEqual([]);
    const late = acpChatSessionActions.applyPermissionRequest(
      permissionRequest(id, 'late-model-call')
    );
    expect(late.chatState).toBe(ChatState.Idle);
    expect(JSON.stringify(late.messages)).not.toContain('late-model-call');
  });

  it('keeps the current prompt interactive when an old run terminal arrives late', () => {
    const currentSessionId = sessionId('late-old-terminal-session');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.clearPromptCancellation(currentSessionId, 'attempt-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-2', 'user-2');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-2')
    );
    acpChatSessionActions.applyAcpGooseSessionNotification(
      completedSkippedTurnTerminalNotification(currentSessionId, 'run-1')
    );
    const snapshot = acpChatSessionActions.applyPermissionRequest(
      permissionRequest(currentSessionId, 'computer-focus')
    );

    expect(snapshot).toMatchObject({
      activePromptAttemptId: 'attempt-2',
      activeRunId: 'run-2',
      chatState: ChatState.WaitingForUserInput,
    });
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'actionRequired',
              data: expect.objectContaining({ id: 'computer-focus' }),
            }),
          ]),
        }),
      ])
    );
  });

  it('keeps a resumed prompt interactive when an earlier terminal for the same run arrives late', () => {
    const currentSessionId = sessionId('late-same-run-terminal-session');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.clearPromptCancellation(currentSessionId, 'attempt-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-2', 'user-2');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    acpChatSessionActions.applyAcpGooseSessionNotification(
      completedSkippedTurnTerminalNotification(currentSessionId, 'run-1')
    );
    const snapshot = acpChatSessionActions.applyPermissionRequest(
      permissionRequest(currentSessionId, 'computer-focus')
    );

    expect(snapshot).toMatchObject({
      activePromptAttemptId: 'attempt-2',
      activeRunId: 'run-1',
      chatState: ChatState.WaitingForUserInput,
    });
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'actionRequired',
              data: expect.objectContaining({ id: 'computer-focus' }),
            }),
          ]),
        }),
      ])
    );
  });

  it('third repair batch accepts new activity when a sealed run is explicitly resumed', () => {
    const currentSessionId = sessionId('resumed-same-run-activity-session');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    acpChatSessionActions.clearPromptCancellation(currentSessionId, 'attempt-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-2', 'user-2');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );
    const snapshot = acpChatSessionActions.applyAcpGooseSessionNotification(
      runningActivityNotification(currentSessionId, 'run-1', 'resumed-event')
    );

    expect(snapshot.activeRunId).toBe('run-1');
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `acp_codepro_activity_${currentSessionId}_resumed-event`,
        }),
      ])
    );
  });

  it('creates one structured terminal anchor for a cancelled tool turn without final text', () => {
    const currentSessionId = sessionId('session-1');
    const userRequest = message('user-1', 'Read the project');
    const firstToolMessage: Message = {
      id: 'assistant-tool-1',
      role: 'assistant',
      created: 124,
      content: [
        {
          type: 'toolRequest',
          id: 'tool-1',
          toolCall: { name: 'developer__text_editor', arguments: { path: 'README.md' } },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };
    const secondToolMessage: Message = {
      id: 'assistant-tool-2',
      role: 'assistant',
      created: 125,
      content: [
        {
          type: 'toolRequest',
          id: 'tool-2',
          toolCall: { name: 'developer__shell', arguments: { command: 'pnpm test' } },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };
    const toolResponseMessage: Message = {
      id: 'tool-response-2',
      role: 'user',
      created: 126,
      content: [
        {
          type: 'toolResponse',
          id: 'tool-2',
          toolResult: { status: 'success', value: { content: 'done' } },
        },
      ],
      metadata: { userVisible: false, agentVisible: true },
    };

    acpChatSessionActions.setMessages(currentSessionId, [
      userRequest,
      firstToolMessage,
      secondToolMessage,
      toolResponseMessage,
    ]);
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');

    const cancellationSnapshot = acpChatSessionActions.startPromptCancellation(
      currentSessionId,
      'attempt-1'
    );
    const terminalMessages = cancellationSnapshot?.messages.filter((candidate) =>
      candidate.content.some(
        (content) =>
          content.type === 'systemNotification' && content.notificationType === 'turnTerminal'
      )
    );

    expect(terminalMessages).toHaveLength(1);
    expect(terminalMessages?.[0]).toMatchObject({
      role: 'assistant',
      metadata: { userVisible: true, agentVisible: false },
      content: [
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          data: {
            schema_version: 1,
            session_id: currentSessionId,
            run_id: 'attempt-1',
            source_user_message_id: 'user-1',
            status: 'cancelled',
            retry_strategy: 'replay_user_request',
            visible_text_available: false,
            tool_action_count: 2,
          },
        },
      ],
    });
  });

  it('restores pending user input tracking when prompt cancellation is restored', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyPermissionRequest(permissionRequest(currentSessionId, 'tool-1'));
    acpChatSessionActions.applyElicitationRequest(elicitationRequest(currentSessionId));
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');

    const restoredSnapshot = acpChatSessionActions.restorePromptCancellation(
      currentSessionId,
      'attempt-1'
    );

    expect(restoredSnapshot?.chatState).toBe(ChatState.WaitingForUserInput);

    const afterPermission = acpChatSessionActions.resolveUserInputRequest(
      currentSessionId,
      acpPermissionUserInputRequestId('tool-1')
    );

    expect(afterPermission?.chatState).toBe(ChatState.WaitingForUserInput);

    const afterElicitation = acpChatSessionActions.resolveUserInputRequest(
      currentSessionId,
      acpElicitationUserInputRequestId('acp_elicitation_1')
    );

    expect(afterElicitation?.chatState).toBe(ChatState.Streaming);
  });

  it('removes the terminal anchor when a prompt cancellation is rolled back', () => {
    const currentSessionId = sessionId('session-1');
    const toolMessage: Message = {
      id: 'assistant-tool-1',
      role: 'assistant',
      created: 124,
      content: [
        {
          type: 'toolRequest',
          id: 'tool-1',
          toolCall: { name: 'developer__text_editor', arguments: { path: 'README.md' } },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };
    acpChatSessionActions.setMessages(currentSessionId, [
      message('user-1', 'Read the project'),
      toolMessage,
    ]);
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');

    const restoredSnapshot = acpChatSessionActions.restorePromptCancellation(
      currentSessionId,
      'attempt-1'
    );
    const terminalMessages = restoredSnapshot?.messages.filter((candidate) =>
      candidate.content.some(
        (content) =>
          content.type === 'systemNotification' && content.notificationType === 'turnTerminal'
      )
    );

    expect(restoredSnapshot?.chatState).toBe(ChatState.Streaming);
    expect(terminalMessages).toEqual([]);
  });

  it('waits for prompt cancellation to clear', async () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');

    let didResolve = false;
    const waitPromise = acpChatSessionActions
      .waitForPromptCancellation(currentSessionId, 'attempt-1')
      .then(() => {
        didResolve = true;
      });

    await Promise.resolve();
    expect(didResolve).toBe(false);

    acpChatSessionActions.clearPromptCancellation(currentSessionId, 'attempt-1');

    await waitPromise;
    expect(didResolve).toBe(true);
  });

  it('removes pending local steer messages when cancellation starts', () => {
    const currentSessionId = sessionId('session-1');
    const localSteerMessage = {
      ...message('steer-1', 'hello'),
      metadata: { userVisible: true, agentVisible: true, steer: true },
    };

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.addPendingLocalSteerMessage(currentSessionId, localSteerMessage);

    expect(acpChatSessionStore.getSnapshot(currentSessionId)?.messages).toHaveLength(1);

    const cancellationSnapshot = acpChatSessionActions.startPromptCancellation(
      currentSessionId,
      'attempt-1'
    );

    expect(cancellationSnapshot?.messages).toEqual([]);
  });

  it('keeps confirmed local steer messages when cancellation starts', () => {
    const currentSessionId = sessionId('session-1');
    const localSteerMessage = {
      ...message('steer-1', 'hello'),
      metadata: { userVisible: true, agentVisible: true, steer: true },
    };

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.addPendingLocalSteerMessage(currentSessionId, localSteerMessage);
    acpChatSessionActions.applyAcpSessionNotification(
      userSteerChunkNotification(currentSessionId, 'steer-1', 'hello')
    );

    const cancellationSnapshot = acpChatSessionActions.startPromptCancellation(
      currentSessionId,
      'attempt-1'
    );

    expect(cancellationSnapshot?.messages).toHaveLength(1);
    expect(cancellationSnapshot?.messages[0].id).toBe('steer-1');
  });

  it('preserves steer text accumulation when another local steer is added', () => {
    const currentSessionId = sessionId('session-1');
    const firstSteerMessage = {
      ...message('steer-1', 'hello'),
      metadata: { userVisible: true, agentVisible: true, steer: true },
    };
    const secondSteerMessage = {
      ...message('steer-2', 'second'),
      metadata: { userVisible: true, agentVisible: true, steer: true },
    };

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.addPendingLocalSteerMessage(currentSessionId, firstSteerMessage);
    acpChatSessionActions.applyAcpSessionNotification(
      userSteerChunkNotification(currentSessionId, 'steer-1', 'hel')
    );

    acpChatSessionActions.addPendingLocalSteerMessage(currentSessionId, secondSteerMessage);
    const snapshot = acpChatSessionActions.applyAcpSessionNotification(
      userSteerChunkNotification(currentSessionId, 'steer-1', 'lo')
    );

    const firstMessage = snapshot.messages.find((item) => item.id === 'steer-1');
    expect(firstMessage?.content[0]).toMatchObject({ type: 'text', text: 'hello' });
  });

  it('stores active run ids from session info notifications', () => {
    const currentSessionId = sessionId('session-1');

    const snapshot = acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );

    expect(snapshot.activeRunId).toBe('run-1');
    expect(acpChatSessionStore.getSnapshot(currentSessionId)?.activeRunId).toBe('run-1');

    const clearedSnapshot = acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, null)
    );

    expect(clearedSnapshot.activeRunId).toBeNull();
  });

  it('keeps the active run visible during cancellation until the backend clears it', () => {
    const currentSessionId = sessionId('session-cancelling-run');
    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );

    const cancelling = acpChatSessionActions.startPromptCancellation(currentSessionId, 'attempt-1');
    expect(cancelling).toMatchObject({
      activePromptAttemptId: null,
      activeRunId: 'run-1',
      pendingCancelPromptAttemptId: 'attempt-1',
      chatState: ChatState.Idle,
    });

    const cleared = acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, null)
    );
    expect(cleared.activeRunId).toBeNull();
  });

  it('clears active run ids when the prompt attempt finishes', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );

    expect(acpChatSessionActions.finishPromptAttemptIfCurrent(currentSessionId, 'attempt-1')).toBe(
      true
    );
    expect(acpChatSessionStore.getSnapshot(currentSessionId)?.activeRunId).toBeNull();
  });

  it('clears active run ids before replaying a session load', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.applyAcpSessionNotification(
      activeRunNotification(currentSessionId, 'run-1')
    );

    const snapshot = acpChatSessionActions.startSessionLoad(currentSessionId);

    expect(snapshot.activeRunId).toBeNull();
  });

  it('stores ACP tool notifications and clears them for a new prompt attempt', () => {
    const currentSessionId = sessionId('session-1');

    const snapshot = acpChatSessionActions.applyAcpSessionNotification(
      toolProgressNotification(currentSessionId)
    );

    expect(snapshot.notifications).toHaveLength(1);
    expect(snapshot.notifications[0]).toMatchObject({
      type: 'Notification',
      request_id: 'tool-1',
      message: {
        method: 'notifications/progress',
        params: {
          progressToken: 'scan-repo',
          progress: 3,
        },
      },
    });

    const nextSnapshot = acpChatSessionActions.startPromptAttempt(
      currentSessionId,
      'attempt-1',
      'user-1'
    );

    expect(nextSnapshot.notifications).toEqual([]);
  });

  it('resets replayed messages before starting an unloaded session load', () => {
    const currentSessionId = sessionId('session-1');
    const replayedChunk = agentMessageChunkNotification(currentSessionId, 'message-1', 'Hello');

    acpChatSessionActions.startSessionLoad(currentSessionId);
    acpChatSessionActions.applyAcpSessionNotification(replayedChunk);

    const loadingSnapshot = acpChatSessionActions.startSessionLoad(currentSessionId);
    expect(loadingSnapshot.messages).toEqual([]);

    const replayedSnapshot = acpChatSessionActions.applyAcpSessionNotification(replayedChunk);

    expect(replayedSnapshot.messages).toHaveLength(1);
    expect(replayedSnapshot.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('keeps replay loading until the load response even when historical activity changes state', () => {
    const id = sessionId('replay-presentation-boundary');
    acpChatSessionActions.startSessionLoad(id);
    acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(id, 'history', 'Retained history')
    );
    for (const status of ['started', 'completed'] as const) {
      const snapshot = acpChatSessionActions.applyAcpGooseSessionNotification({
        sessionId: id,
        update: {
          sessionUpdate: 'status_message',
          status: {
            type: 'progress',
            message: 'Historical context maintenance',
            data: {
              schema_version: 1,
              event: 'compaction_lifecycle',
              operation_id: 'old-compaction',
              status,
              trigger: 'auto',
              started_at: '2026-09-30T03:00:00Z',
            },
          },
        },
      });
      expect(snapshot.chatState).toBe(ChatState.LoadingConversation);
      expect(snapshot.messages.some((item) => item.id === 'history')).toBe(true);
    }
    const loaded = acpChatSessionActions.finishSessionLoad(id, session(id));
    expect(loaded.chatState).toBe(ChatState.Idle);
    expect(loaded.messages.some((item) => item.id === 'history')).toBe(true);
  });

  it('keeps a live compaction visible when history loading finishes', () => {
    const id = sessionId('live-compaction-reload');
    acpChatSessionActions.startSessionLoad(id);
    acpChatSessionActions.applyAcpSessionNotification(activeRunNotification(id, 'live-run'));
    acpChatSessionActions.applyAcpGooseSessionNotification({
      sessionId: id,
      update: {
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: 'Compacting',
          data: {
            schema_version: 1,
            event: 'compaction_lifecycle',
            operation_id: 'live-compact',
            status: 'started',
            trigger: 'manual',
            started_at: '2026-10-15T00:00:00Z',
          },
        },
      },
    });
    expect(acpChatSessionActions.finishSessionLoad(id, session(id)).chatState).toBe(
      ChatState.Compacting
    );
  });

  it('applies permission requests as waiting action-required messages', () => {
    const currentSessionId = sessionId('session-1');

    const snapshot = acpChatSessionActions.applyPermissionRequest(
      permissionRequest(currentSessionId, 'tool-1')
    );

    expect(snapshot.chatState).toBe(ChatState.WaitingForUserInput);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].role).toBe('assistant');
    expect(snapshot.messages[0].content[0]).toMatchObject({
      type: 'actionRequired',
      data: {
        actionType: 'toolConfirmation',
        id: 'tool-1',
      },
    });
  });

  it('resumes streaming only after the final pending user input request resolves', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.startPromptAttempt(currentSessionId, 'attempt-1', 'user-1');
    acpChatSessionActions.applyPermissionRequest(permissionRequest(currentSessionId, 'tool-1'));
    acpChatSessionActions.applyElicitationRequest(elicitationRequest(currentSessionId));

    const afterElicitation = acpChatSessionActions.resolveUserInputRequest(
      currentSessionId,
      acpElicitationUserInputRequestId('acp_elicitation_1')
    );

    expect(afterElicitation?.chatState).toBe(ChatState.WaitingForUserInput);

    const afterPermission = acpChatSessionActions.resolveUserInputRequest(
      currentSessionId,
      acpPermissionUserInputRequestId('tool-1')
    );

    expect(afterPermission?.chatState).toBe(ChatState.Streaming);
  });

  it('does not resume streaming after user input resolves without an active prompt', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.applyPermissionRequest(permissionRequest(currentSessionId, 'tool-1'));

    const snapshot = acpChatSessionActions.resolveUserInputRequest(
      currentSessionId,
      acpPermissionUserInputRequestId('tool-1')
    );

    expect(snapshot?.chatState).toBe(ChatState.WaitingForUserInput);
  });

  it('retains live CodePro task progress while tool and message updates stream', () => {
    const currentSessionId = sessionId('codepro-progress');

    acpChatSessionActions.applyAcpGooseSessionNotification({
      sessionId: currentSessionId,
      update: {
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: 'CodePro · 正在执行任务\n⏳ task-1: 运行测试',
        },
      },
    } as never);

    const snapshot = acpChatSessionActions.applyAcpSessionNotification(
      agentMessageChunkNotification(currentSessionId, 'assistant-1', '正在检查测试输出')
    );

    expect(snapshot.progressMessage).toContain('task-1');
  });

  it('applies elicitation requests as waiting action-required messages', () => {
    const currentSessionId = sessionId('session-1');

    const snapshot = acpChatSessionActions.applyElicitationRequest(
      elicitationRequest(currentSessionId)
    );

    expect(snapshot.chatState).toBe(ChatState.WaitingForUserInput);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].role).toBe('assistant');
    expect(snapshot.messages[0].content[0]).toMatchObject({
      type: 'actionRequired',
      data: {
        actionType: 'elicitation',
        id: 'acp_elicitation_1',
        message: 'Choose a project',
      },
    });
  });

  it('stores submitted elicitation status', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.applyElicitationRequest(elicitationRequest(currentSessionId));

    const snapshot = acpChatSessionActions.setElicitationStatus(
      currentSessionId,
      'acp_elicitation_1',
      'submitted'
    );

    expect(snapshot?.messages[0].content[0]).toMatchObject({
      type: 'actionRequired',
      data: {
        actionType: 'elicitation',
        id: 'acp_elicitation_1',
        isSubmitted: true,
        isCancelled: false,
      },
    });
  });

  it('stores cancelled elicitation status', () => {
    const currentSessionId = sessionId('session-1');

    acpChatSessionActions.applyElicitationRequest(elicitationRequest(currentSessionId));

    const snapshot = acpChatSessionActions.setElicitationStatus(
      currentSessionId,
      'acp_elicitation_1',
      'cancelled'
    );

    expect(snapshot?.messages[0].content[0]).toMatchObject({
      type: 'actionRequired',
      data: {
        actionType: 'elicitation',
        id: 'acp_elicitation_1',
        isSubmitted: false,
        isCancelled: true,
      },
    });
  });
});

describe('useAcpChatSessionSnapshot', () => {
  const sessionId = 'hook-session-1';

  it.each(['complete', 'fail'])(
    'applies every history chunk while rendering only load boundaries: %s',
    (outcome) => {
      const { result } = renderHook(() => useAcpChatSessionSnapshot(sessionId));
      act(() => {
        acpChatSessionActions.startSessionLoad(sessionId);
      });
      const loadingSnapshot = result.current;
      for (const text of ['first ', 'second']) {
        act(() => {
          acpChatSessionActions.applyAcpSessionNotification({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'history-answer',
              content: { type: 'text', text },
            },
          });
        });
      }
      expect(result.current).toBe(loadingSnapshot);
      expect(result.current?.chatState).toBe(ChatState.LoadingConversation);
      expect(acpChatSessionStore.getSnapshot(sessionId)?.messages[0].content).toEqual([
        { type: 'text', text: 'first second' },
      ]);
      act(() => {
        if (outcome === 'complete')
          acpChatSessionActions.finishSessionLoad(sessionId, { id: sessionId } as Session);
        else acpChatSessionActions.failSessionLoad(sessionId, 'connection interrupted');
      });
      expect(result.current?.messages[0].content).toEqual([{ type: 'text', text: 'first second' }]);
      expect(result.current?.chatState).toBe(ChatState.Idle);
      if (outcome === 'fail')
        expect(result.current?.sessionLoadError).toBe('connection interrupted');
      act(() => {
        acpChatSessionActions.applyAcpSessionNotification({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'history-answer',
            content: { type: 'text', text: ' live' },
          },
        });
      });
      expect(result.current?.messages[0].content).toEqual([
        { type: 'text', text: 'first second live' },
      ]);
    }
  );

  afterEach(() => {
    acpChatSessionActions.deleteSnapshot(sessionId);
  });

  it('tracks only live thought arrivals and clears them on tool activity, stop and replay', () => {
    const thought: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Inspecting' },
        _meta: { goose: { messageId: 'thought-1' } },
      },
    };
    acpChatSessionActions.applyAcpSessionNotification(thought);
    expect(acpChatSessionStore.getSnapshot(sessionId)?.thinkingActivity).toBeUndefined();
    acpChatSessionActions.startPromptAttempt(sessionId, 'attempt', 'user');
    acpChatSessionActions.applyAcpSessionNotification(thought);
    expect(acpChatSessionStore.getSnapshot(sessionId)?.thinkingActivity?.messageId).toBe(
      'thought-1'
    );
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'write-1',
        title: 'write',
        status: 'pending',
        rawInput: { __inputPreview: true, path: 'app.js', content: 'first' },
      },
    });
    const first = acpChatSessionStore.getSnapshot(sessionId)!;
    expect(first.thinkingActivity).toBeUndefined();
    expect(first.activeToolCallIds).toEqual(['write-1']);
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'write-1',
        title: 'write',
        status: 'pending',
        rawInput: { __inputPreview: true, path: 'app.js', content: 'first\nsecond' },
      },
    });
    const preview = acpChatSessionStore.getSnapshot(sessionId)!;
    const previewCall = preview.messages
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'toolRequest');
    expect(previewCall).toHaveLength(1);
    expect(previewCall[0]).toMatchObject({
      toolCall: { value: { arguments: { content: 'first\nsecond' } } },
    });
    expect(
      first.messages.flatMap((m) => m.content).find((c) => c.type === 'toolRequest')
    ).toMatchObject({ toolCall: { value: { arguments: { content: 'first' } } } });
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'write-1',
        title: 'write',
        status: 'in_progress',
        rawInput: { path: 'app.js', content: 'first\nsecond' },
      },
    });
    const real = acpChatSessionStore
      .getSnapshot(sessionId)!
      .messages.flatMap((m) => m.content)
      .find((c) => c.type === 'toolRequest');
    expect(real).not.toMatchObject({
      toolCall: { value: { arguments: { __inputPreview: true } } },
    });
    acpChatSessionActions.applyAcpSessionNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'write-1',
        status: 'completed',
        content: [],
      },
    });
    expect(acpChatSessionStore.getSnapshot(sessionId)?.activeToolCallIds).toEqual([]);
    acpChatSessionActions.applyAcpSessionNotification(thought);
    acpChatSessionActions.finishPromptAttemptIfCurrent(sessionId, 'attempt');
    expect(acpChatSessionStore.getSnapshot(sessionId)?.thinkingActivity).toBeUndefined();
    acpChatSessionActions.startSessionLoad(sessionId);
    acpChatSessionActions.applyAcpSessionNotification(thought);
    expect(acpChatSessionStore.getSnapshot(sessionId)?.thinkingActivity).toBeUndefined();
  });

  it('subscribes to session store snapshots', () => {
    const { result } = renderHook(() => useAcpChatSessionSnapshot(sessionId));

    expect(result.current).toBeUndefined();

    const nextMessage = message('message-1', 'Hello from hook');
    act(() => {
      acpChatSessionActions.setMessages(sessionId, [nextMessage]);
    });

    expect(result.current?.messages).toEqual([nextMessage]);
  });
});
