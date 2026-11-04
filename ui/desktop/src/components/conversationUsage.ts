import type { Message, MessageUsage } from '../types/message';

/** Sum source message receipts once, never rendered parts or context-meter estimates. */
export function conversationUsage(
  messages: Message[],
  { attributedOnly = false } = {}
): MessageUsage | undefined {
  const receipts = new Map<string | Message, MessageUsage>();
  for (const message of messages)
    if (message.metadata.usage && !(attributedOnly && message.metadata.usageUnattributed))
      receipts.set(message.id ?? message, message.metadata.usage);
  const sum: MessageUsage = {};
  for (const usage of receipts.values()) {
    for (const field of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'cost',
    ] as const) {
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        sum[field] = (sum[field] ?? 0) + value;
    }
    if (usage.costSource === 'estimated') sum.costSource = 'estimated';
    else if (usage.costSource === 'provider_reported' && !sum.costSource)
      sum.costSource = 'provider_reported';
  }
  return Object.keys(sum).length ? sum : undefined;
}
