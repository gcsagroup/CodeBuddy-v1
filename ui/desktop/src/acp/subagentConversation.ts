import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { Message } from '../types/message';
import type { PromptActivity } from './chatSessionStore';
import { createAcpSessionNotificationAdapter } from './sessionNotificationAdapter';
import { getAcpControlClient } from './acpConnection';
import { parseToolInputPreview, type ToolInputPreview } from '../types/toolInputPreview';

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
  ancestorSessionIds?: string[];
  throughSeq: number;
  hasMore: boolean;
  attributionUnavailable?: boolean;
  events: SubagentConversationEvent[];
}

export interface SubagentViewUpdate {
  type: 'reset' | 'history' | 'ready' | 'stream' | 'error';
  events?: SubagentConversationEvent[];
  message?: string;
  active?: {
    attemptId: string;
    turn: number;
    step: number;
    chunks: { type: string; text: string; preview?: ToolInputPreview }[];
  };
  frame?: {
    type: string;
    attemptId: string;
    turn?: number;
    step?: number;
    chunk?: { type: string; text: string; preview?: ToolInputPreview };
  };
}
type Viewer = {
  parent: string;
  child: string;
  receive: (value: SubagentViewUpdate) => void;
  bind: (signal: globalThis.AbortSignal) => void;
};
const viewers = new Map<string, Viewer>();

export function applySubagentViewNotification(
  notification: SessionNotification,
  signal?: globalThis.AbortSignal
) {
  if (notification.update.sessionUpdate !== 'session_info_update') return false;
  const value = notification.update._meta?.['codebuddy/subagent-view'];
  if (!value || typeof value !== 'object' || !('subscriptionId' in value)) return false;
  const viewer = viewers.get(String(value.subscriptionId));
  if (
    !viewer ||
    signal?.aborted ||
    notification.sessionId !== viewer.parent ||
    !('childSessionId' in value) ||
    value.childSessionId !== viewer.child
  )
    return true;
  const update = value as unknown as SubagentViewUpdate;
  if (signal) viewer.bind(signal);
  if (['reset', 'history', 'ready', 'stream', 'error'].includes(update.type))
    viewer.receive(update);
  return true;
}

export function watchSubagentConversation(
  parent: string,
  child: string,
  ancestors: readonly string[] | undefined,
  receive: (value: SubagentViewUpdate) => void
) {
  const subscriptionId = globalThis.crypto.randomUUID();
  let disposed = false;
  let client = getAcpControlClient();
  let detach = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let boundSignal: globalThis.AbortSignal | undefined;
  const bind = (signal: globalThis.AbortSignal) => {
    if (signal === boundSignal) return;
    detach();
    boundSignal = signal;
    const disconnected = () => {
      if (disposed) return;
      receive({ type: 'error', message: 'Subagent viewing connection closed' });
      // Reopen only the read-only observer after transport recovery. The native
      // snapshot replaces its projection without resuming the child.
      timer = setTimeout(() => {
        client = getAcpControlClient();
        void start();
      }, 1500);
    };
    signal.addEventListener('abort', disconnected, { once: true });
    detach = () => signal.removeEventListener('abort', disconnected);
  };
  viewers.set(subscriptionId, { parent, child, receive, bind });
  const stop = async () => {
    const connection = await client;
    await connection.extMethod('_goose/unstable/subagent/conversation/unfollow', {
      subscriptionId,
    });
  };
  const start = () =>
    client
      .then(async (connection) => {
        if (disposed) return;
        if (connection.signal) bind(connection.signal);
        await connection.extMethod('_goose/unstable/subagent/conversation/follow', {
          sessionId: parent,
          childSessionId: child,
          subscriptionId,
          ...(ancestors ? { ancestorSessionIds: [...ancestors] } : {}),
        });
        if (disposed) await stop();
      })
      .catch((error) => {
        if (!disposed) receive({ type: 'error', message: String(error) });
      });
  void start();
  return () => {
    disposed = true;
    detach();
    clearTimeout(timer);
    viewers.delete(subscriptionId);
    void stop().catch(() => {});
  };
}

export async function readSubagentConversation(
  sessionId: string,
  childSessionId: string,
  afterSeq: number,
  ancestorSessionIds?: readonly string[]
): Promise<SubagentConversationPage> {
  const ancestors = ancestorSessionIds && [...ancestorSessionIds];
  const client = await getAcpControlClient();
  const value = (await client.extMethod('_goose/unstable/subagent/conversation/get', {
    sessionId,
    childSessionId,
    afterSeq,
    ...(ancestors ? { ancestorSessionIds: ancestors } : {}),
  })) as unknown as SubagentConversationPage;
  if (
    value.sessionId !== sessionId ||
    value.childSessionId !== childSessionId ||
    (ancestors !== undefined &&
      (!Array.isArray(value.ancestorSessionIds) ||
        value.ancestorSessionIds.length !== ancestors.length ||
        value.ancestorSessionIds.some((id, index) => id !== ancestors[index]))) ||
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

export function subagentTurnEvent(event: SubagentConversationEvent) {
  if (event.type === 'turn/start') return { status: 'running' as const };
  if (event.type !== 'turn/end') return;
  const kind = record(event.data.reason).kind;
  const status =
    kind === 'completed'
      ? ('completed' as const)
      : kind === 'aborted' || kind === 'interrupted'
        ? ('interrupted' as const)
        : kind === 'max-tokens' ||
            (kind === 'error' &&
              [
                'OUTPUT_LIMIT_REACHED',
                'OUTPUT_TRUNCATED',
                'OUTPUT_LENGTH_STOP',
                'LOCAL_OUTPUT_BUDGET_EXHAUSTED',
              ].includes(String(record(record(event.data.reason).error).code)))
          ? ('limited' as const)
          : kind === 'blocked'
            ? ('blocked' as const)
            : kind === 'error'
              ? ('failed' as const)
              : undefined;
  const time = new Date(event.time ?? NaN).getTime();
  return { status, endedAt: Number.isFinite(time) ? time : undefined };
}

// A display projection only: it never registers, loads or activates an Agent.
export function createSubagentConversationProjection(sessionId: string) {
  const adapter = createAcpSessionNotificationAdapter();
  let throughSeq = -1;
  let messages: Message[] = [];
  let activity: PromptActivity | undefined;
  let pendingTool: { id: string; name: string; arguments: Record<string, unknown> } | undefined;
  let live:
    | {
        attemptId: string;
        turn?: number;
        step?: number;
        adapter: ReturnType<typeof createAcpSessionNotificationAdapter>;
      }
    | undefined;
  let status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'limited'
    | 'blocked'
    | undefined;
  const parentInputs = new Map<string, string>();
  const apply = (update: SessionNotification['update']) => adapter.apply({ sessionId, update });
  return {
    append(events: SubagentConversationEvent[], realtime = false): Message[] {
      for (const event of events) {
        // A background reread can recover optional attribution after the
        // transcript was already displayed. Never replay its native messages.
        if (
          event.type === 'tool/call' &&
          typeof event.data.callId === 'string' &&
          typeof event.data.parentUserMessageId === 'string'
        )
          parentInputs.set(event.data.callId, event.data.parentUserMessageId);
        if (event.seq <= throughSeq) continue;
        throughSeq = event.seq;
        const data = event.data;
        const created = new Date(event.time ?? 0).getTime() / 1000;
        const message = record(event.type === 'user/message' ? data : data.message);
        if (
          event.type === 'assistant/message' &&
          live?.turn === data.turn &&
          live?.step === data.step
        ) {
          live = undefined;
          activity = undefined;
        }
        const id = typeof message.id === 'string' ? message.id : `child:${event.seq}`;
        const meta = { goose: { messageId: id, created } };
        const turn = subagentTurnEvent(event);
        if (turn) status = turn.status;
        if (event.type === 'turn/end') {
          activity = undefined;
          pendingTool = undefined;
        }
        if (event.type === 'user/message' || event.type === 'assistant/message') {
          for (const item of Array.isArray(message.content) ? message.content : []) {
            const block = record(item);
            if (
              ['text', 'reasoning'].includes(String(block.type)) &&
              typeof block.text === 'string'
            ) {
              apply({
                sessionUpdate:
                  event.type === 'user/message'
                    ? 'user_message_chunk'
                    : block.type === 'reasoning'
                      ? 'agent_thought_chunk'
                      : 'agent_message_chunk',
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
          if (realtime) {
            pendingTool = { id: data.callId, name: data.name, arguments: rawInput };
            activity = {
              promptAttemptId: `child-tool:${data.callId}`,
              sourceUserMessageId: '',
              startedAt: Date.now(),
              receivedAt: Date.now(),
              kind: 'tool',
            };
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
          if (pendingTool?.id === message.toolCallId) {
            pendingTool = undefined;
            activity = undefined;
          }
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
            ...(data.fileResult ? { rawOutput: data.fileResult } : {}),
            _meta: meta,
          });
        }
      }
      messages = adapter.getMessages().map((message) => ({
        ...message,
        content: message.content.map((entry) =>
          entry.type === 'toolRequest' && parentInputs.has(entry.id)
            ? {
                ...entry,
                metadata: { ...entry.metadata, parentUserMessageId: parentInputs.get(entry.id)! },
              }
            : entry
        ),
      }));
      return this.messages;
    },
    stream(frame: NonNullable<SubagentViewUpdate['frame']>) {
      if (frame.type === 'start') {
        live = {
          attemptId: frame.attemptId,
          turn: frame.turn,
          step: frame.step,
          adapter: createAcpSessionNotificationAdapter(),
        };
        pendingTool = undefined;
        activity = {
          promptAttemptId: frame.attemptId,
          sourceUserMessageId: '',
          startedAt: Date.now(),
          execution: { phase: 'model', childCount: 0, modelRequestPhase: 'waiting' },
        };
      }
      if (!live || live.attemptId !== frame.attemptId) return this.messages;
      if (frame.type === 'end') {
        live = undefined;
        activity = undefined;
      } else if (frame.chunk?.type === 'tool-call-delta') {
        const preview = parseToolInputPreview(frame.chunk.preview);
        activity = {
          ...activity!,
          receivedAt: Date.now(),
          kind: 'tool',
          execution: {
            phase: 'model',
            childCount: 0,
            modelRequestPhase: 'receiving',
            ...(preview ? { toolInput: preview } : {}),
          },
        };
      } else if (frame.chunk && ['text-delta', 'reasoning-delta'].includes(frame.chunk.type)) {
        activity = {
          ...activity!,
          execution: undefined,
          receivedAt: Date.now(),
          kind: frame.chunk.type === 'text-delta' ? 'text' : 'thought',
        };
        const id = `child-live:${frame.attemptId}`;
        live.adapter.apply({
          sessionId,
          update: {
            sessionUpdate:
              frame.chunk.type === 'reasoning-delta'
                ? 'agent_thought_chunk'
                : 'agent_message_chunk',
            content: { type: 'text', text: frame.chunk.text },
            messageId: id,
            _meta: { goose: { messageId: id } },
          },
        });
      }
      return this.messages;
    },
    get messages(): Message[] {
      return live ? [...messages, ...live.adapter.getMessages()] : messages;
    },
    get streaming() {
      return live !== undefined;
    },
    // Display observations only. A cold open turn alone cannot prove live work.
    get activity() {
      return activity;
    },
    get pendingTool() {
      return pendingTool;
    },
    get status() {
      return status;
    },
  };
}
