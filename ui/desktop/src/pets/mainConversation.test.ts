import { expect, it, vi } from 'vitest';
import { deliverMainConversationMessage, receiveMainConversationMessages } from './mainConversation';
vi.mock('../acp/acpConnection', () => ({ getAcpControlClient: vi.fn() }));
it('accepts three notifications for one delivery once, but accepts a new identical message', async () => {
  const input = { msg: 'hello', images: [], messageId: 'delivery-one' };
  const received = vi.fn();
  const pending = Array.from({ length: 3 }, () => deliverMainConversationMessage('dedup', input));
  const dispose = receiveMainConversationMessages('dedup', received);
  await Promise.all(pending);
  await deliverMainConversationMessage('dedup', input);
  expect(received).toHaveBeenCalledTimes(1);
  await deliverMainConversationMessage('dedup', { ...input, messageId: 'delivery-two' });
  expect(received).toHaveBeenCalledTimes(2);
  dispose();
});
it('retains ordered pet inputs until the existing composer queue mounts and acknowledges acceptance', async () => {
  const first = { msg: 'first', images: [] };
  const second = { msg: 'second', images: [] };
  const received = vi.fn();
  const pending = [deliverMainConversationMessage('main', first), deliverMainConversationMessage('main', second)];
  expect(received).not.toHaveBeenCalled();
  const dispose = receiveMainConversationMessages('main', received);
  await Promise.all(pending);
  expect(received.mock.calls).toEqual([[first], [second]]);
  dispose();
});
it('reports queue persistence errors instead of acknowledging delivery', async () => {
  const dispose = receiveMainConversationMessages('failed', () => { throw new Error('disk full'); });
  await expect(deliverMainConversationMessage('failed', { msg: 'keep draft', images: [] })).rejects.toThrow('disk full');
  dispose();
});
