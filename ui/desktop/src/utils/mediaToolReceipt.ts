import type { ToolResponseMessageContent } from '../types/message';

export function mediaDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const name = value.trim();
  if (!name || Array.from(name).length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) return;
  return name;
}

// Read the tool's receipt, never infer generation status from assistant prose.
export function generatedMediaReceipt(
  response?: ToolResponseMessageContent
): Record<string, unknown> | undefined {
  const result = response?.toolResult;
  if (
    result?.status !== 'success' ||
    !result.value ||
    typeof result.value !== 'object' ||
    Array.isArray(result.value)
  )
    return;
  const value = result.value as Record<string, unknown>;
  if (value.isError) return;
  let receipt: unknown = value.structuredContent;
  if (!receipt) {
    const text = Array.isArray(value.content)
      ? value.content.find(
          (item) => item && typeof item === 'object' && !Array.isArray(item) && item.type === 'text'
        )
      : undefined;
    if (text && typeof text === 'object' && !Array.isArray(text) && typeof text.text === 'string') {
      try {
        receipt = JSON.parse(text.text);
      } catch {
        return;
      }
    }
  }
  if (receipt && typeof receipt === 'object' && !Array.isArray(receipt))
    return receipt as Record<string, unknown>;
  return undefined;
}
