import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { conversationUsage } from '../../components/conversationUsage';
import type { MessageUsage } from '../../types/message';
import { createAcpSessionNotificationAdapter } from '../sessionNotificationAdapter';

const sessionId = 'usage-regression';
const content = (
  messageId: string | undefined,
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' = 'agent_message_chunk'
): SessionNotification => ({
  sessionId,
  update: { sessionUpdate, messageId, content: { type: 'text', text: 'content' } },
});
const tool = (messageId: string, toolCallId: string): SessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'read_image',
    status: 'in_progress',
    _meta: { goose: { messageId } },
  },
});
const usage = (messageId: string, value: MessageUsage) => ({
  sessionId,
  update: { sessionUpdate: 'message_usage' as const, messageId, usage: value },
});

describe('message usage receipt identity', () => {
  it.each([
    {
      model: 'Gemma',
      receipts: [
        { inputTokens: 7028, outputTokens: 313, totalTokens: 7341 },
        { inputTokens: 7250, outputTokens: 25, totalTokens: 7275 },
        { inputTokens: 7895, outputTokens: 18, totalTokens: 7913 },
      ],
      expected: { inputTokens: 22173, outputTokens: 356, totalTokens: 22529 },
    },
    {
      model: 'DeepSeek',
      receipts: [
        { inputTokens: 7125, outputTokens: 67, totalTokens: 7192 },
        { inputTokens: 4763, outputTokens: 43, totalTokens: 7448, cacheReadTokens: 2642 },
        { inputTokens: 621, outputTokens: 14, totalTokens: 7953, cacheReadTokens: 7318 },
      ],
      expected: {
        inputTokens: 12509,
        outputTokens: 124,
        totalTokens: 22593,
        cacheReadTokens: 9960,
      },
    },
  ])(
    'matches the original $model receipts in live order and cold replay',
    ({ receipts, expected }) => {
      const live = createAcpSessionNotificationAdapter();
      live.apply(content('thinking', 'agent_thought_chunk'));
      live.applyGoose(usage('thinking', receipts[0]));
      const first = live.getMessages();
      live.applyGoose(usage('image', receipts[1]));
      expect(live.getMessages()[0].metadata.usage).toEqual(receipts[0]);
      live.apply(tool('image', 'read-image'));
      live.apply(content('answer'));
      live.applyGoose(usage('answer', receipts[2]));

      const cold = createAcpSessionNotificationAdapter();
      cold.apply(content('thinking', 'agent_thought_chunk'));
      cold.apply(tool('image', 'read-image'));
      cold.apply(content('answer'));
      ['thinking', 'image', 'answer'].forEach((id, i) => cold.applyGoose(usage(id, receipts[i])));

      expect(conversationUsage(live.getMessages())).toEqual(expected);
      expect(conversationUsage(cold.getMessages())).toEqual(expected);
      expect(first[0].metadata.usage).toEqual(receipts[0]);
      expect(live.getMessages().map((m) => [m.id, m.metadata.usage])).toEqual(
        cold.getMessages().map((m) => [m.id, m.metadata.usage])
      );
    }
  );

  it('counts consecutive tool-only attempts once, including duplicate and corrected receipts', () => {
    const adapter = createAcpSessionNotificationAdapter();
    adapter.applyGoose(usage('first', { inputTokens: 10, outputTokens: 0 }));
    const early = adapter.getMessages();
    adapter.apply(tool('first', 't1'));
    adapter.applyGoose(usage('second', { inputTokens: 20, outputTokens: 2 }));
    adapter.apply(tool('second', 't2'));
    adapter.applyGoose(usage('first', { inputTokens: 10, outputTokens: 0 }));
    adapter.applyGoose(usage('second', { inputTokens: 21, outputTokens: 3 }));

    expect(conversationUsage(adapter.getMessages())).toEqual({ inputTokens: 31, outputTokens: 3 });
    expect(adapter.getMessages()).toHaveLength(2);
    expect(adapter.getMessages().every((m) => m.metadata.userVisible)).toBe(true);
    expect(early[0]).toMatchObject({
      content: [],
      metadata: { userVisible: false, agentVisible: false, usage: { outputTokens: 0 } },
    });
  });

  it('retains internal-only work without making a visible transcript or borrowing the next answer', () => {
    const adapter = createAcpSessionNotificationAdapter();
    adapter.applyGoose(usage('internal', { inputTokens: 10, outputTokens: 2 }));
    adapter.apply(content('answer'));
    adapter.applyGoose(usage('answer', { inputTokens: 20, outputTokens: 3 }));
    const messages = adapter.getMessages();

    expect(messages.filter((m) => m.metadata.userVisible).map((m) => m.id)).toEqual(['answer']);
    expect(messages[1].metadata.usage).toEqual({ inputTokens: 20, outputTokens: 3 });
    expect(conversationUsage(messages)).toEqual({ inputTokens: 30, outputTokens: 5 });
  });

  it('preserves the existing anonymous-chunk adoption when usage arrives between chunks', () => {
    const adapter = createAcpSessionNotificationAdapter();
    adapter.apply(content(undefined));
    adapter.applyGoose(usage('answer', { inputTokens: 4, outputTokens: 2 }));
    adapter.apply(content('answer'));

    expect(adapter.getMessages()).toHaveLength(1);
    expect(adapter.getMessages()[0]).toMatchObject({
      id: 'answer',
      content: [{ type: 'text', text: 'contentcontent' }],
      metadata: { userVisible: true, agentVisible: true, usage: { inputTokens: 4 } },
    });
  });

  it('does not duplicate a receipt across provisional tool rows or later model content', () => {
    const adapter = createAcpSessionNotificationAdapter();
    const receipt = usage('parallel-attempt', { inputTokens: 7, outputTokens: 2 });
    for (const id of ['t1', 't2']) {
      const preview = tool('parallel-attempt', id);
      if (preview.update.sessionUpdate !== 'tool_call') throw new Error('Expected tool call');
      preview.update.rawInput = { __inputPreview: true };
      adapter.apply(preview);
    }
    adapter.applyGoose(receipt);
    adapter.apply(tool('parallel-attempt', 't1'));
    adapter.apply(tool('parallel-attempt', 't2'));
    expect(adapter.getMessages().filter((m) => m.metadata.userVisible)).toHaveLength(2);
    adapter.apply(content('parallel-attempt'));
    adapter.applyGoose(receipt);

    expect(adapter.getMessages().filter((m) => m.metadata.usage)).toHaveLength(1);
    expect(conversationUsage(adapter.getMessages())).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it('updates the identified older answer after a newer answer already exists', () => {
    const adapter = createAcpSessionNotificationAdapter();
    adapter.apply(content('first'));
    adapter.apply(content('second'));
    adapter.applyGoose(usage('second', { inputTokens: 2 }));
    adapter.applyGoose(usage('first', { inputTokens: 1 }));

    expect(adapter.getMessages().map((m) => m.metadata.usage?.inputTokens)).toEqual([1, 2]);
  });
});
