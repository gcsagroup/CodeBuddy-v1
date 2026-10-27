import { expect, it } from 'vitest';
import type { Message, MessageUsage } from '../types/message';
import { conversationUsage } from './conversationUsage';

const message = (id: string, usage?: MessageUsage): Message => ({
  id,
  role: 'assistant',
  created: 1,
  content: [],
  metadata: { userVisible: true, agentVisible: true, usage },
});

it('counts hidden execution requests and the final reply together, including cache receipts', () => {
  expect(
    conversationUsage([
      message('tool-only', {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 130,
        cacheReadTokens: 100,
      }),
      message('stage', { inputTokens: 30, outputTokens: 5, totalTokens: 35 }),
      message('final', { inputTokens: 7, outputTokens: 8, totalTokens: 15 }),
    ])
  ).toEqual({ inputTokens: 47, outputTokens: 33, totalTokens: 180, cacheReadTokens: 100 });
});

it('does not add the same source receipt twice when it is split or replayed', () => {
  expect(
    conversationUsage([
      message('original', { inputTokens: 4, outputTokens: 1 }),
      message('original', { inputTokens: 8, outputTokens: 2 }),
      message('final', { inputTokens: 3, outputTokens: 5 }),
    ])
  ).toEqual({ inputTokens: 11, outputTokens: 7 });
});

it('keeps absent counters unknown and treats reported zero as a real value', () => {
  expect(conversationUsage([message('none')])).toBeUndefined();
  expect(conversationUsage([message('zero', { outputTokens: 0 })])).toEqual({ outputTokens: 0 });
});
