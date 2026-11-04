import { getAcpControlClient } from '../acp/acpConnection';
import type { UserInput } from '../types/message';
import { AppEvents } from '../constants/events';
import { QueuedMessageStorage } from '../utils/queuedMessageStorage';

type Consumer = (input: UserInput) => void;
type Delivery = { timeout: ReturnType<typeof setTimeout>; input: UserInput; resolve: () => void; reject: (error: unknown) => void };
const waiting = new Map<string, Delivery[]>();
const consumers = new Map<string, Consumer>();
const deliveriesById = new Map<string, Promise<void>>();
export async function getMainConversation(): Promise<string> {
  const client = await getAcpControlClient();
  const result = await client.extMethod('_codebuddy/main-conversation/ensure', {}) as { sessionId: string };
  if (!result.sessionId) throw new Error('Main conversation is unavailable');
  return result.sessionId;
}
export async function clearMainConversation(sessionId: string): Promise<void> {
  if ((waiting.get(sessionId)?.length ?? 0) > 0 || new QueuedMessageStorage(window.localStorage, sessionId).read().length > 0) {
    throw new Error('主对话还有待发送消息，请处理消息队列后再清空历史');
  }
  const client = await getAcpControlClient();
  await client.extMethod('_codebuddy/main-conversation/clear', { sessionId });
  window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CONVERSATION_CHANGED, { detail: { sessionId } }));
}
function flush(sessionId: string) {
  const consumer = consumers.get(sessionId);
  if (!consumer) return;
  const deliveries = waiting.get(sessionId) ?? [];
  waiting.delete(sessionId);
  for (const delivery of deliveries) {
    clearTimeout(delivery.timeout);
    try { consumer(delivery.input); delivery.resolve(); }
    catch (error) { delivery.reject(error); }
  }
}
// The composer remains the sole writer of its persisted queue.
export function deliverMainConversationMessage(sessionId: string, input: UserInput): Promise<void> {
  const key = input.messageId ? `${sessionId}:${input.messageId}` : undefined;
  if (key && deliveriesById.has(key)) return deliveriesById.get(key)!;
  const deliveryResult = new Promise<void>((resolve, reject) => {
    const delivery: Delivery = { input, resolve, reject, timeout: setTimeout(() => {
      const remaining = (waiting.get(sessionId) ?? []).filter(item => item !== delivery);
      if (remaining.length) waiting.set(sessionId, remaining); else waiting.delete(sessionId);
      reject(new Error('主对话输入栏尚未就绪，请重试'));
    }, 25000) };
    waiting.set(sessionId, [...(waiting.get(sessionId) ?? []), delivery]);
    flush(sessionId);
  });
  if (key) {
    deliveriesById.set(key, deliveryResult);
    // Only failures may be retried. Identical text with a new ID is a new message.
    void deliveryResult.catch(() => deliveriesById.delete(key));
  }
  return deliveryResult;
}
export function receiveMainConversationMessages(sessionId: string, consumer: Consumer) {
  consumers.set(sessionId, consumer);
  flush(sessionId);
  return () => { if (consumers.get(sessionId) === consumer) consumers.delete(sessionId); };
}
