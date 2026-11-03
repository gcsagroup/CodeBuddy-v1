// Some Gemma 4 chat-template servers send an empty thought envelope as ordinary
// content, even when they also supply native reasoning and tool-call blocks.
const emptyThought = '<|channel>thought\n<channel|>';
const close = '<channel|>';

function visibleBlock(text) {
  if (text.startsWith(emptyThought)) text = text.slice(emptyThought.length);
  return text.endsWith(close) ? text.slice(0, -close.length) : text;
}

// Only hold an ambiguous boundary, so plain text still streams immediately.
function visibleDelta(state, text) {
  const pending = state.pending + text;
  if (state.start && emptyThought.startsWith(pending) && pending !== emptyThought) {
    state.pending = pending;
    return '';
  }
  const value = state.start && pending.startsWith(emptyThought) ? pending.slice(emptyThought.length) : pending;
  state.start = false;
  let keep = Math.min(close.length, value.length);
  while (keep && !value.endsWith(close.slice(0, keep))) keep--;
  state.pending = value.slice(value.length - keep);
  return value.slice(0, value.length - keep);
}

// Check reasoning and tool-producing generation. A normal final answer can
// legitimately contain repetition requested by the user.
function repeatedParagraph(state, text) {
  const parts = (state.tail + text).split('\n\n');
  const remainder = parts.pop();
  for (const part of parts) {
    // Ignore long sections instead of comparing only a common suffix.
    const paragraph = !state.truncated && part.length <= 1024 ? part : '';
    state.count = paragraph === state.previous ? state.count + 1 : 1;
    state.previous = paragraph;
    state.truncated = false;
    if (paragraph.length >= 32 && state.count >= 16) return true;
  }
  state.truncated ||= remainder.length > 1024;
  state.tail = remainder.slice(-1024);
  return false;
}

export async function* normalizeGemmaResponse(stream) {
  const blocks = new Map();
  let toolProposed = false;
  for await (const chunk of stream) {
    if (chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') toolProposed = true;
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const state = blocks.get(chunk.index) ?? { start: true, pending: '', tail: '', count: 0 };
      blocks.set(chunk.index, state);
      if ((toolProposed || chunk.type === 'reasoning-delta') && repeatedParagraph(state, chunk.text)) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'REPETITIVE_MODEL_OUTPUT', message: '模型连续生成相同段落，本次生成已停止。请查看已有工具回执后重试。',
        } } };
        return;
      }
      if (chunk.type === 'reasoning-delta') yield chunk;
      else {
        const text = visibleDelta(state, chunk.text);
        if (text) yield { ...chunk, text };
      }
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      const state = blocks.get(chunk.index);
      if (state?.pending && state.pending !== close) yield { type: 'text-delta', index: chunk.index, text: state.pending };
      blocks.delete(chunk.index);
      yield { ...chunk, block: { ...chunk.block, text: visibleBlock(chunk.block.text) } };
    } else {
      if (chunk.type === 'block-end') blocks.delete(chunk.index);
      yield chunk;
    }
  }
}
