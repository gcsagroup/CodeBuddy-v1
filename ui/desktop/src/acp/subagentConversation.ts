import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { Message } from '../types/message';
import { createAcpSessionNotificationAdapter } from './sessionNotificationAdapter';
import { getAcpControlClient } from './acpConnection';

export interface SubagentConversationEvent {
  seq: number;
  type: string;
  time?: number | string;
  data: Record<string, unknown>;
  truncated?: boolean;
}

export interface SubagentConversationPage {
  sessionId: string;
  childSessionId: string;
  throughSeq: number;
  hasMore: boolean;
  events: SubagentConversationEvent[];
}

export async function readSubagentConversation(
  sessionId: string,
  childSessionId: string,
  afterSeq: number
): Promise<SubagentConversationPage> {
  const client = await getAcpControlClient();
  const value = (await client.extMethod('_goose/unstable/subagent/conversation/get', {
    sessionId,
    childSessionId,
    afterSeq,
  })) as unknown as SubagentConversationPage;
  if (
    value.sessionId !== sessionId ||
    value.childSessionId !== childSessionId ||
    !Number.isSafeInteger(value.throughSeq) ||
    value.throughSeq < afterSeq ||
    !Array.isArray(value.events)
  )
    throw new Error('Invalid subagent conversation response');
  return value;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// A display projection only: it never registers, loads or activates an Agent.
export function createSubagentConversationProjection(sessionId: string) {
  const adapter = createAcpSessionNotificationAdapter();
  let throughSeq = -1;
  let status: 'running' | 'completed' | 'failed' | 'interrupted' | undefined;
  const apply = (update: SessionNotification['update']) => adapter.apply({ sessionId, update });
  return {
    append(events: SubagentConversationEvent[]): Message[] {
      for (const event of events) {
        if (event.seq <= throughSeq) continue;
        throughSeq = event.seq;
        const data = event.data;
        const created = Math.floor(new Date(event.time ?? 0).getTime() / 1000);
        const message = record(event.type === 'user/message' ? data : data.message);
        const id = typeof message.id === 'string' ? message.id : `child:${event.seq}`;
        const meta = { goose: { messageId: id, created } };
        if (event.type === 'turn/start') status = 'running';
        if (event.type === 'turn/end') {
          const kind = record(data.reason).kind;
          status =
            kind === 'completed'
              ? 'completed'
              : kind === 'aborted' || kind === 'interrupted'
                ? 'interrupted'
                : kind === 'error'
                  ? 'failed'
                  : undefined;
        }
        if (event.type === 'user/message' || event.type === 'assistant/message') {
          for (const item of Array.isArray(message.content) ? message.content : []) {
            const block = record(item);
            if (block.type === 'text' && typeof block.text === 'string') {
              apply({
                sessionUpdate:
                  event.type === 'user/message' ? 'user_message_chunk' : 'agent_message_chunk',
                content: { type: 'text', text: block.text },
                messageId: id,
                _meta: meta,
              });
            }
          }
        } else if (
          event.type === 'tool/call' &&
          typeof data.callId === 'string' &&
          typeof data.name === 'string'
        ) {
          let rawInput = {};
          try {
            rawInput =
              typeof data.arguments === 'string'
                ? JSON.parse(data.arguments)
                : record(data.arguments);
          } catch {
            /* Partial arguments remain unavailable. */
          }
          apply({
            sessionUpdate: 'tool_call',
            toolCallId: data.callId,
            title: data.name,
            status: 'in_progress',
            kind: 'execute',
            rawInput,
            _meta: {
              goose: {
                messageId: `child-tool:${data.callId}`,
                created,
                toolCall: { toolName: data.name, extensionName: 'harness' },
              },
            },
          });
        } else if (event.type === 'tool/result' && typeof message.toolCallId === 'string') {
          const content = (Array.isArray(message.content) ? message.content : []).flatMap(
            (item) => {
              const block = record(item);
              return block.type === 'text' && typeof block.text === 'string'
                ? [
                    {
                      type: 'content' as const,
                      content: { type: 'text' as const, text: block.text },
                    },
                  ]
                : [];
            }
          );
          apply({
            sessionUpdate: 'tool_call_update',
            toolCallId: message.toolCallId,
            status: message.isError ? 'failed' : 'completed',
            content,
            _meta: meta,
          });
        }
      }
      return adapter.getMessages();
    },
    get status() {
      return status;
    },
  };
}
