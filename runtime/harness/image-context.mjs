import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';

// Bound visual input at the model projection seam. Durable messages, files and
// UI receipts stay intact; an omitted image can be loaded again with read_image.
export function projectImageContext(messages, limit = 8) {
  const images = [];
  for (const [index, message] of messages.entries())
    for (const [part, block] of (Array.isArray(message.content) ? message.content : []).entries())
      if (block.type === 'image') images.push({ index, part, block });
  if (images.length <= limit) return messages;
  const selected = new Set(images.slice(-limit));
  const omitted = new Map();
  for (const item of images) if (!selected.has(item)) {
    const parts = omitted.get(item.index) ?? new Map();
    parts.set(item.part, item.block); omitted.set(item.index, parts);
  }
  return messages.map((message, index) => !omitted.has(index) ? message : {
    ...message, content: message.content.map((block, part) => !omitted.get(index).has(part) ? block : {
      type: 'text', text: `[Earlier image omitted from this model request to stay within the ${limit}-image context budget. The original attachment and any saved generated file are retained; this does not mean generation failed. Use the recorded file path with read_image if this image is needed, in batches within the budget. Do not regenerate it.]`,
    }),
  });
}

export function installImageContextProjection(ctx) {
  return ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options) || !Array.isArray(options.messages)) return next();
    const messages = projectImageContext(options.messages);
    return messages === options.messages ? next() : ctx.llm.stream({ ...options, messages });
  });
}
