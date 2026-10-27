import type { Message } from '../types/message';
import { isPlanTool, isProgressTool, presentedToolCall } from './codepro/CodeProToolContent';

export interface MessageContentPart {
  message: Message;
  start: number;
  end: number;
}

/** Display ranges refer to the source message; they never become new messages. */
export function messageContentParts(message: Message): MessageContentPart[] {
  if (
    message.role !== 'assistant' ||
    message.content.some(
      (content) =>
        !['text', 'image', 'thinking', 'redactedThinking', 'toolRequest'].includes(content.type)
    )
  )
    return [{ message, start: 0, end: message.content.length }];

  const parts: MessageContentPart[] = [];
  let process: boolean | undefined;
  message.content.forEach((content, index) => {
    // Whitespace cannot create a public boundary inside a continuous process.
    if (content.type === 'text' && !content.text.trim()) {
      if (parts.length) parts[parts.length - 1].end = index + 1;
      return;
    }
    const call = content.type === 'toolRequest' ? presentedToolCall(content) : undefined;
    const publicTool = call && (isPlanTool(call.name) || isProgressTool(call.name));
    if (publicTool) {
      parts.push({ message, start: parts.length ? index : 0, end: index + 1 });
      process = undefined;
      return;
    }
    const nextProcess =
      content.type === 'thinking' ||
      content.type === 'redactedThinking' ||
      (content.type === 'toolRequest' && !publicTool);
    if (parts.length && process === nextProcess) parts[parts.length - 1].end = index + 1;
    else parts.push({ message, start: parts.length ? index : 0, end: index + 1 });
    process = nextProcess;
  });
  return parts;
}
