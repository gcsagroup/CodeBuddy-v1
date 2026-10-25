import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { Message, NotificationEvent } from '../../types/message';
import {
  createAcpSessionNotificationAdapter,
  type AcpChatStateChange,
} from '../sessionNotificationAdapter';

const SESSION_ID = 'session-1';

it('retains immutable history across append, anchored insertion and a later thought delta', () => {
  const adapter = createAcpSessionNotificationAdapter();
  const publish = (update: SessionNotification['update']) => {
    const change = adapter.apply(acpUpdate(update)).find((c) => c.type === 'messages');
    if (!change || change.type !== 'messages') throw new Error('Expected messages');
    return change.messages;
  };
  const first = publish({
    sessionUpdate: 'user_message_chunk',
    messageId: 'u',
    content: { type: 'text', text: 'question' },
  });
  const second = publish({
    sessionUpdate: 'agent_message_chunk',
    messageId: 'a',
    content: { type: 'text', text: 'answer' },
  });
  expect(second[0]).toBe(first[0]);
  expect(first).toHaveLength(1);
  const inserted = publish({
    sessionUpdate: 'user_message_chunk',
    messageId: 'steer',
    content: { type: 'text', text: 'follow-up' },
    _meta: { goose: { presentation: { afterMessageId: 'u' } } },
  });
  expect(inserted.map((m) => m.id)).toEqual(['u', 'steer', 'a']);
  expect(inserted[0]).toBe(second[0]);
  expect(inserted[2]).toBe(second[1]);
  const thought = publish({
    sessionUpdate: 'agent_thought_chunk',
    messageId: 't',
    content: { type: 'text', text: 'first' },
  });
  const continued = publish({
    sessionUpdate: 'agent_thought_chunk',
    messageId: 't',
    content: { type: 'text', text: ' second' },
  });
  expect(thought[3].content).toEqual([{ type: 'thinking', thinking: 'first', signature: '' }]);
  expect(continued[3].content).toEqual([
    { type: 'thinking', thinking: 'first second', signature: '' },
  ]);
  expect(continued[0]).toBe(inserted[0]);
  expect(continued[2]).toBe(inserted[2]);
});

function acpUpdate(update: SessionNotification['update']): SessionNotification {
  return {
    sessionId: SESSION_ID,
    update,
  };
}

function gooseUpdate(
  update: GooseSessionNotification_unstable['update']
): GooseSessionNotification_unstable {
  return {
    sessionId: SESSION_ID,
    update,
  };
}

function agentText(text: string): SessionNotification {
  return acpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  });
}

function userText(text: string): SessionNotification {
  return acpUpdate({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text },
  });
}

function agentThought(text: string): SessionNotification {
  return acpUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text },
  });
}

function agentImage(data: string, mimeType: string): SessionNotification {
  return acpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', data, mimeType },
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

function expectMessagesAndLocalSteerConfirmation(
  chatStateChanges: AcpChatStateChange[],
  messageId: string
): Message[] {
  expect(chatStateChanges).toHaveLength(2);

  const [messagesChange, confirmationChange] = chatStateChanges;
  expect(messagesChange.type).toBe('messages');
  expect(confirmationChange).toEqual({ type: 'localSteerConfirmed', messageId });

  if (messagesChange.type !== 'messages') {
    throw new Error('expected messages state change');
  }

  return messagesChange.messages;
}

function expectOnlyNotificationChange(chatStateChanges: AcpChatStateChange[]): NotificationEvent {
  expect(chatStateChanges).toHaveLength(1);

  const [chatStateChange] = chatStateChanges;
  expect(chatStateChange.type).toBe('notification');

  if (chatStateChange.type !== 'notification') {
    throw new Error('expected notification state change');
  }

  return chatStateChange.notification;
}

function firstContent(message: Message): Message['content'][number] {
  const content = message.content[0];
  expect(content).toBeDefined();
  return content;
}

describe('createAcpSessionNotificationAdapter', () => {
  it('keeps host response identities separate even with identical text and timestamps', () => {
    const adapter = createAcpSessionNotificationAdapter();
    const chunk = (messageId: string, text: string, created: number): SessionNotification => {
      const notification = agentText(text);
      notification.update._meta = { goose: { messageId, created } };
      return notification;
    };
    adapter.apply(chunk('host-first', 'same ', 123));
    adapter.apply(chunk('host-second', 'same ', 123));
    // Late chunks still belong to the original response, not the latest card.
    adapter.apply(chunk('host-first', 'answer', 124));
    adapter.apply(chunk('host-second', 'answer', 124));
    expect(
      adapter.getMessages().map((message) => ({ id: message.id, content: message.content }))
    ).toEqual([
      { id: 'host-first', content: [{ type: 'text', text: 'same answer' }] },
      { id: 'host-second', content: [{ type: 'text', text: 'same answer' }] },
    ]);
  });

  it('records content-free stream timing without letting logger failure block messages', () => {
    const previous = window.electron;
    const logInfo = vi.fn();
    window.electron = { ...previous, logInfo };
    try {
      const adapter = createAcpSessionNotificationAdapter();
      const notification = agentText('PRIVATE-TEXT-SENTINEL');
      notification.update._meta = {
        goose: { messageId: 'stream-message-fixture' },
        streamTiming: {
          requestId: '2e52c54b-1a06-432f-a5a2-23849338f1c6',
          parsedSequence: 1,
          sentAtMs: 100,
        },
      };
      expectOnlyMessagesChange(adapter.apply(notification));
      const records = logInfo.mock.calls.map(([line]) => JSON.parse(line));
      expect(records.map((record) => record.stage)).toEqual(['ui_received', 'ui_adapter_applied']);
      expect(records[1].change_count).toBe(1);
      expect(records[1].message_id).toBe('stream-message-fixture');
      expect(JSON.stringify(records)).not.toContain('PRIVATE-TEXT-SENTINEL');

      logInfo.mockImplementation(() => {
        throw new Error('logger unavailable');
      });
      expectOnlyMessagesChange(adapter.apply(notification));
      expect(JSON.stringify(adapter.getMessages())).toContain('PRIVATE-TEXT-SENTINEL');
    } finally {
      window.electron = previous;
    }
  });

  describe('apply', () => {
    describe('message chunks', () => {
      it('maps and merges text chunks by role', () => {
        const adapter = createAcpSessionNotificationAdapter();

        adapter.apply(agentText('Hello '));

        const secondChunkStateChanges = adapter.apply(agentText('world'));
        let messages = expectOnlyMessagesChange(secondChunkStateChanges);

        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('assistant');
        expect(firstContent(messages[0])).toMatchObject({ type: 'text', text: 'Hello world' });

        const userTextStateChanges = adapter.apply(userText('Question'));
        messages = expectOnlyMessagesChange(userTextStateChanges);

        expect(messages).toHaveLength(2);
        expect(messages[1].role).toBe('user');
        expect(firstContent(messages[1])).toMatchObject({ type: 'text', text: 'Question' });
      });

      it('does not append an identical replay of a locally rendered user message', () => {
        const adapter = createAcpSessionNotificationAdapter([
          {
            id: 'request-1',
            role: 'user',
            created: 123,
            content: [{ type: 'text', text: 'Question' }],
            metadata: { userVisible: true, agentVisible: true },
          },
        ]);

        const messages = expectOnlyMessagesChange(
          adapter.apply(
            acpUpdate({
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'Question' },
              _meta: { goose: { messageId: 'request-1' } },
            } as SessionNotification['update'])
          )
        );

        expect(messages).toHaveLength(1);
        expect(firstContent(messages[0])).toMatchObject({ type: 'text', text: 'Question' });
      });

      it('appends repeated adjacent text deltas', () => {
        const adapter = createAcpSessionNotificationAdapter();

        adapter.apply(agentText('Hel'));
        const messages = expectOnlyMessagesChange(adapter.apply(agentText('l')));

        expect(messages).toHaveLength(1);
        expect(firstContent(messages[0])).toMatchObject({ type: 'text', text: 'Hell' });
      });

      it('reconciles locally rendered steer text with server chunks', () => {
        const adapter = createAcpSessionNotificationAdapter([
          {
            id: 'steer-1',
            role: 'user',
            created: 123,
            content: [
              { type: 'text', text: 'hello' },
              { type: 'image', data: 'base64-image', mimeType: 'image/png' },
            ],
            metadata: { userVisible: true, agentVisible: true, steer: true },
          },
        ]);

        let messages = expectMessagesAndLocalSteerConfirmation(
          adapter.apply(
            acpUpdate({
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'hel' },
              _meta: {
                goose: {
                  messageId: 'steer-1',
                  steer: true,
                },
              },
            } as SessionNotification['update'])
          ),
          'steer-1'
        );

        expect(firstContent(messages[0])).toMatchObject({ type: 'text', text: 'hel' });
        expect(messages[0].content[1]).toMatchObject({
          type: 'image',
          data: 'base64-image',
          mimeType: 'image/png',
        });
        expect(messages[0].metadata.steer).toBe(true);

        messages = expectMessagesAndLocalSteerConfirmation(
          adapter.apply(
            acpUpdate({
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'lo' },
              _meta: {
                goose: {
                  messageId: 'steer-1',
                  steer: true,
                },
              },
            } as SessionNotification['update'])
          ),
          'steer-1'
        );

        expect(firstContent(messages[0])).toMatchObject({ type: 'text', text: 'hello' });

        messages = expectMessagesAndLocalSteerConfirmation(
          adapter.apply(
            acpUpdate({
              sessionUpdate: 'user_message_chunk',
              content: { type: 'image', data: 'base64-image', mimeType: 'image/png' },
              _meta: {
                goose: {
                  messageId: 'steer-1',
                  steer: true,
                },
              },
            } as SessionNotification['update'])
          ),
          'steer-1'
        );

        expect(messages[0].content).toEqual([
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'base64-image', mimeType: 'image/png' },
        ]);
      });

      it('appends repeated local steer text deltas without collapsing them', () => {
        const adapter = createAcpSessionNotificationAdapter([
          {
            id: 'steer-1',
            role: 'user',
            created: 123,
            content: [{ type: 'text', text: 'haha' }],
            metadata: { userVisible: true, agentVisible: true, steer: true },
          },
        ]);

        let messages = expectMessagesAndLocalSteerConfirmation(
          adapter.apply(
            acpUpdate({
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'ha' },
              _meta: {
                goose: {
                  messageId: 'steer-1',
                  steer: true,
                },
              },
            } as SessionNotification['update'])
          ),
          'steer-1'
        );

        expect(firstContent(messages[0])).toMatchObject({ type: 'text', text: 'ha' });

        messages = expectMessagesAndLocalSteerConfirmation(
          adapter.apply(
            acpUpdate({
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'ha' },
              _meta: {
                goose: {
                  messageId: 'steer-1',
                  steer: true,
                },
              },
            } as SessionNotification['update'])
          ),
          'steer-1'
        );

        expect(firstContent(messages[0])).toMatchObject({ type: 'text', text: 'haha' });
      });

      it('maps image and thinking chunks to existing message content shapes', () => {
        const imageAdapter = createAcpSessionNotificationAdapter();

        const imageStateChanges = imageAdapter.apply(agentImage('base64-image', 'image/png'));
        const imageMessages = expectOnlyMessagesChange(imageStateChanges);

        expect(firstContent(imageMessages[0])).toMatchObject({
          type: 'image',
          data: 'base64-image',
          mimeType: 'image/png',
        });

        const thoughtAdapter = createAcpSessionNotificationAdapter();
        thoughtAdapter.apply(agentThought('Thinking '));

        const thoughtStateChanges = thoughtAdapter.apply(agentThought('more'));
        const thoughtMessages = expectOnlyMessagesChange(thoughtStateChanges);

        expect(thoughtMessages).toHaveLength(1);
        expect(firstContent(thoughtMessages[0])).toMatchObject({
          type: 'thinking',
          thinking: 'Thinking more',
          signature: '',
        });
      });
    });

    describe('tools', () => {
      it('maps tool calls and successful responses, including MCP app metadata', () => {
        const adapter = createAcpSessionNotificationAdapter();

        const toolCallStateChanges = adapter.apply(
          acpUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Read file',
            kind: 'read',
            status: 'in_progress',
            rawInput: { path: 'README.md' },
            locations: [{ path: 'README.md', line: 1 }],
            _meta: {
              goose: {
                toolCall: {
                  extensionName: 'developer',
                  toolName: 'read_file',
                },
              },
            },
          })
        );
        let messages = expectOnlyMessagesChange(toolCallStateChanges);

        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('assistant');
        expect(firstContent(messages[0])).toMatchObject({
          type: 'toolRequest',
          id: 'tool-1',
          toolCall: {
            status: 'success',
            value: {
              name: 'read_file',
              arguments: { path: 'README.md' },
            },
          },
          metadata: {
            title: 'Read file',
            status: 'in_progress',
            extensionName: 'developer',
            kind: 'read',
            locations: [{ path: 'README.md', line: 1 }],
          },
        });

        const toolResponseStateChanges = adapter.apply(
          acpUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            rawOutput: 'raw result',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'rendered result' },
              },
            ],
            _meta: {
              goose: {
                mcpApp: {
                  resourceUri: 'ui://app/resource',
                  extensionName: 'developer',
                  toolName: 'read_file',
                },
                toolAudit: {
                  schemaVersion: 1,
                  auditId: '0198f083-3f9f-7e4a-bd71-b8ec3cab37be',
                  actor: 'codepro_coder',
                  effectiveModel: 'openai/gpt-5.6-codex',
                  extensionSource: 'platform',
                  toolName: 'developer::read_file',
                  permissionClass: 'read_only',
                  authorization: 'policy_allowed',
                  outcome: 'success',
                  taskScoped: true,
                  startedAt: '2026-08-04T09:20:30.100Z',
                  completedAt: '2026-08-04T09:20:30.142Z',
                  durationMs: 42,
                },
              },
            },
          })
        );
        messages = expectOnlyMessagesChange(toolResponseStateChanges);

        expect(messages).toHaveLength(2);
        expect(messages[1].role).toBe('user');
        expect(firstContent(messages[1])).toMatchObject({
          type: 'toolResponse',
          id: 'tool-1',
          toolResult: {
            status: 'success',
            value: {
              content: [{ type: 'text', text: 'rendered result' }],
              isError: false,
              _meta: {
                ui: { resourceUri: 'ui://app/resource' },
                extensionName: 'developer',
                toolName: 'read_file',
              },
            },
          },
          metadata: {
            status: 'completed',
            rawOutput: 'raw result',
            toolAudit: expect.objectContaining({
              auditId: '0198f083-3f9f-7e4a-bd71-b8ec3cab37be',
              outcome: 'success',
              durationMs: 42,
            }),
          },
        });
      });

      it('merges a later tool title and input into the same live tool row', () => {
        const adapter = createAcpSessionNotificationAdapter();
        adapter.apply(
          acpUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-growing',
            title: 'Run command',
            kind: 'execute',
            status: 'in_progress',
            rawInput: {},
            _meta: { goose: { toolCall: { toolName: 'developer__shell' } } },
          })
        );
        const changes = adapter.apply(
          acpUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-growing',
            title: 'Check the project test result',
            status: 'in_progress',
            rawInput: { command: 'npm.cmd test' },
          })
        );
        const messages = expectOnlyMessagesChange(changes);
        expect(messages).toHaveLength(1);
        expect(firstContent(messages[0])).toMatchObject({
          type: 'toolRequest',
          id: 'tool-growing',
          toolCall: { value: { name: 'developer__shell', arguments: { command: 'npm.cmd test' } } },
          metadata: { title: 'Check the project test result' },
        });
      });

      it('maps failed tool responses to error results', () => {
        const adapter = createAcpSessionNotificationAdapter();

        const failedToolStateChanges = adapter.apply(
          acpUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'failed',
            title: 'Read file',
            rawOutput: 'permission denied',
          })
        );
        const messages = expectOnlyMessagesChange(failedToolStateChanges);

        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('user');
        expect(firstContent(messages[0])).toMatchObject({
          type: 'toolResponse',
          id: 'tool-1',
          toolResult: {
            status: 'error',
            error: 'permission denied',
          },
          metadata: {
            title: 'Read file',
            status: 'failed',
            rawOutput: 'permission denied',
          },
        });
      });

      it('uses failed tool response text content when raw output is absent', () => {
        const adapter = createAcpSessionNotificationAdapter();

        const failedToolStateChanges = adapter.apply(
          acpUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'failed',
            title: 'Read file',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'file not found' },
              },
            ],
          })
        );
        const messages = expectOnlyMessagesChange(failedToolStateChanges);

        expect(firstContent(messages[0])).toMatchObject({
          type: 'toolResponse',
          id: 'tool-1',
          toolResult: {
            status: 'error',
            error: 'file not found',
          },
        });
      });

      it('preserves valid audit receipts on failed tool responses and ignores expanded payloads', () => {
        const adapter = createAcpSessionNotificationAdapter();
        const baseAudit = {
          schemaVersion: 1,
          auditId: '0198f083-3f9f-7e4a-bd71-b8ec3cab37be',
          actor: 'primary',
          effectiveModel: 'openai/gpt-5.6-codex',
          extensionSource: 'external_stdio',
          toolName: 'developer::shell',
          permissionClass: 'workspace_write',
          authorization: 'user_denied',
          outcome: 'user_denied',
          taskScoped: false,
          startedAt: '2026-08-04T09:20:30.100Z',
          completedAt: '2026-08-04T09:20:30.100Z',
          durationMs: 0,
        };

        let messages = expectOnlyMessagesChange(
          adapter.apply(
            acpUpdate({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-audited-failure',
              status: 'failed',
              rawOutput: 'permission denied',
              _meta: { goose: { toolAudit: baseAudit } },
            })
          )
        );
        expect(firstContent(messages[0])).toMatchObject({
          metadata: { toolAudit: baseAudit },
        });

        messages = expectOnlyMessagesChange(
          adapter.apply(
            acpUpdate({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-expanded-audit',
              status: 'failed',
              _meta: {
                goose: { toolAudit: { ...baseAudit, rawArguments: { command: 'secret' } } },
              },
            })
          )
        );
        expect(firstContent(messages[1])).not.toHaveProperty('metadata.toolAudit');
      });

      it('maps in-progress tool message notifications', () => {
        const adapter = createAcpSessionNotificationAdapter();

        const notificationStateChanges = adapter.apply(
          acpUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'in_progress',
            _meta: {
              toolNotification: {
                type: 'message',
                params: {
                  level: 'info',
                  logger: 'subagent:session-1',
                  data: {
                    text: 'Running search...',
                  },
                },
              },
            },
          })
        );
        const notification = expectOnlyNotificationChange(notificationStateChanges);

        expect(notification).toMatchObject({
          type: 'Notification',
          request_id: 'tool-1',
          message: {
            method: 'notifications/message',
            params: {
              level: 'info',
              logger: 'subagent:session-1',
              data: {
                text: 'Running search...',
              },
            },
          },
        });
      });

      it('maps in-progress tool progress notifications', () => {
        const adapter = createAcpSessionNotificationAdapter();

        const notificationStateChanges = adapter.apply(
          acpUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'in_progress',
            _meta: {
              toolNotification: {
                type: 'progress',
                params: {
                  progressToken: 'scan-repo',
                  progress: 3,
                  total: 10,
                  message: 'Scanned 3 of 10 directories',
                },
              },
            },
          })
        );
        const notification = expectOnlyNotificationChange(notificationStateChanges);

        expect(notification).toMatchObject({
          type: 'Notification',
          request_id: 'tool-1',
          message: {
            method: 'notifications/progress',
            params: {
              progressToken: 'scan-repo',
              progress: 3,
              total: 10,
              message: 'Scanned 3 of 10 directories',
            },
          },
        });
      });
    });
  });

  describe('applyGoose', () => {
    it('maps usage updates into token state', () => {
      const adapter = createAcpSessionNotificationAdapter();

      expect(
        adapter.applyGoose(
          gooseUpdate({
            sessionUpdate: 'usage_update',
            used: 42,
            contextLimit: 200,
            accumulatedInputTokens: 10,
            accumulatedOutputTokens: 15,
            accumulatedCost: 0.12,
          })
        )
      ).toEqual([
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

    it('maps status messages and keeps later id-less chunks separate', () => {
      const adapter = createAcpSessionNotificationAdapter();

      const noticeStateChanges = adapter.applyGoose(
        gooseUpdate({
          sessionUpdate: 'status_message',
          status: { type: 'notice', message: 'Checking files' },
        })
      );
      let messages = expectOnlyMessagesChange(noticeStateChanges);

      expect(messages).toHaveLength(1);
      expect(messages[0].metadata).toMatchObject({ userVisible: true, agentVisible: false });
      expect(firstContent(messages[0])).toMatchObject({
        type: 'systemNotification',
        notificationType: 'inlineMessage',
        msg: 'Checking files',
      });

      const textStateChanges = adapter.apply(agentText('Result'));
      messages = expectOnlyMessagesChange(textStateChanges);

      expect(messages).toHaveLength(2);
      expect(firstContent(messages[1])).toMatchObject({ type: 'text', text: 'Result' });

      const progressStateChanges = adapter.applyGoose(
        gooseUpdate({
          sessionUpdate: 'status_message',
          status: { type: 'progress', message: 'Still working' },
        })
      );
      expect(progressStateChanges).toEqual([{ type: 'progressMessage', message: 'Still working' }]);
    });
  });

  it('keeps CodePro milestones in live progress instead of the transcript', () => {
    const adapter = createAcpSessionNotificationAdapter();
    const changes = adapter.applyGoose(
      gooseUpdate({
        sessionUpdate: 'status_message',
        status: { type: 'progress', message: 'CodePro activity' },
      })
    );
    expect(changes).toEqual([
      {
        type: 'progressMessage',
        message: 'CodePro activity',
      },
    ]);
  });

  it('keeps task snapshots out of the transcript while retaining them for live progress', () => {
    const adapter = createAcpSessionNotificationAdapter();
    const snapshot = [
      'CodePro · 任务规划完成',
      '进度：0 / 2 个任务已完成',
      '下一步：task-1 · 分析项目',
      '说明：读取项目结构',
      '--- CodePro 任务快照 ---',
      '⏳ task-1: 分析项目',
      '⏳ task-2: 运行测试',
    ].join('\n');

    const changes = adapter.applyGoose(
      gooseUpdate({
        sessionUpdate: 'status_message',
        status: { type: 'progress', message: snapshot },
      })
    );

    expect(changes).toEqual([{ type: 'progressMessage', message: snapshot }]);
  });

  it('keeps task progress visible while merging tool start and completion into one activity', () => {
    const adapter = createAcpSessionNotificationAdapter();
    const snapshot = [
      'CodePro · 任务规划完成',
      '进度：0 / 2 个任务已完成',
      '下一步：task-1 · 分析项目',
      '--- CodePro 任务快照 ---',
      '⏳ task-1: 分析项目',
      '⏳ task-2: 运行测试',
    ].join('\n');
    adapter.applyGoose(
      gooseUpdate({
        sessionUpdate: 'status_message',
        status: { type: 'progress', message: snapshot },
      })
    );

    const started = adapter.applyGoose(
      gooseUpdate({
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: [
            'CodePro · 正在读取文件',
            '活动ID：tool-1',
            '功能：读取项目文件',
            '路径：D:\\CodeBuddy\\README.md',
          ].join('\n'),
        },
      })
    );
    const completed = adapter.applyGoose(
      gooseUpdate({
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: [
            'CodePro · 已读取文件',
            '活动ID：tool-1',
            '功能：读取项目文件',
            '路径：D:\\CodeBuddy\\README.md',
            '状态：成功',
            '结果：读取完成',
          ].join('\n'),
        },
      })
    );

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ type: 'messages' });
    if (started[0]?.type !== 'messages') {
      throw new Error('expected a messages change');
    }
    expect(started[0].messages).toHaveLength(1);
    expect(started[0].messages[0].content[0]).toMatchObject({
      type: 'systemNotification',
      notificationType: 'codeProActivity',
      msg: expect.stringContaining('正在读取文件'),
      data: {
        schema_version: 1,
        event_id: 'tool-1',
        event_type: 'file_read',
        status: 'running',
      },
    });

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ type: 'messages' });
    if (completed[0]?.type !== 'messages') {
      throw new Error('expected a messages change');
    }
    expect(completed[0].messages).toHaveLength(1);
    expect(completed[0].messages[0].content[0]).toMatchObject({
      type: 'systemNotification',
      notificationType: 'codeProActivity',
      msg: expect.stringContaining('已读取文件'),
      data: {
        schema_version: 1,
        event_id: 'tool-1',
        event_type: 'file_read',
        status: 'completed',
      },
    });
  });

  it('prefers a structured status_message event over legacy activity text', () => {
    const adapter = createAcpSessionNotificationAdapter();
    const changes = adapter.applyGoose(
      gooseUpdate({
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: 'CodePro · 旧标题\n活动ID：legacy-id\n状态：成功',
          data: {
            schema_version: 1,
            event_id: 'structured-id',
            event_type: 'file_read',
            session_id: SESSION_ID,
            run_id: 'analysis-run-1',
            task_id: null,
            parent_task_id: null,
            agent_role: 'planner',
            effective_model: 'ollama_cloud/glm-5.2',
            status: 'running',
            started_at: '2026-07-30T12:00:00Z',
            finished_at: null,
            title: '正在读取真实文件',
            technical_details: '范围：最多 100 行',
            path: 'D:\\CodeBuddy\\README.md',
            command_summary: null,
            exit_code: null,
            diff_summary: null,
            include_in_model_context: false,
            retryable: false,
            retry_from_event_id: null,
          },
        },
      })
    );

    expect(changes).toHaveLength(1);
    if (changes[0]?.type !== 'messages') {
      throw new Error('expected a messages change');
    }
    expect(changes[0].messages[0].id).toContain('structured-id');
    expect(changes[0].messages[0].content[0]).toMatchObject({
      type: 'systemNotification',
      notificationType: 'codeProActivity',
      data: {
        event_id: 'structured-id',
        title: '正在读取真实文件',
        status: 'running',
      },
    });

    const completed = adapter.applyGoose(
      gooseUpdate({
        sessionUpdate: 'status_message',
        status: {
          type: 'progress',
          message: 'CodePro · 已读取真实文件',
          data: {
            ...(
              changes[0].messages[0].content[0] as {
                data: Record<string, unknown>;
              }
            ).data,
            event_type: 'file_read',
            status: 'completed',
            finished_at: '2026-07-30T12:00:01Z',
            technical_details: '读取完成',
          },
        },
      })
    );
    expect(completed).toHaveLength(1);
    if (completed[0]?.type !== 'messages') {
      throw new Error('expected a messages change');
    }
    expect(completed[0].messages).toHaveLength(1);
    expect(completed[0].messages[0].id).toContain('structured-id');
    expect(completed[0].messages[0].content[0]).toMatchObject({
      type: 'systemNotification',
      notificationType: 'codeProActivity',
      data: {
        event_id: 'structured-id',
        status: 'completed',
        finished_at: '2026-07-30T12:00:01Z',
      },
    });
  });
  describe('applyPermissionRequest', () => {
    it('maps permission requests to action-required tool confirmations', () => {
      const adapter = createAcpSessionNotificationAdapter();

      const request: RequestPermissionRequest = {
        sessionId: SESSION_ID,
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        toolCall: {
          toolCallId: 'tool-1',
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

      const permissionStateChanges = adapter.applyPermissionRequest(request);
      const messages = expectOnlyMessagesChange(permissionStateChanges);

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(firstContent(messages[0])).toMatchObject({
        type: 'actionRequired',
        data: {
          actionType: 'toolConfirmation',
          id: 'tool-1',
          toolName: 'edit_file',
          arguments: { path: 'README.md' },
          prompt: 'Allow editing README.md?',
        },
      });
    });
  });
});
