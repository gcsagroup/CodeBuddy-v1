// Some Gemma 4 chat-template servers send an empty thought envelope as ordinary
// content, even when they also supply native reasoning and tool-call blocks.
const emptyThought = '<|channel>thought\n<channel|>';
const close = '<channel|>';

// Gemma's tool-response boundary belongs to the host. Without the documented
// inference stop, a server can generate fictitious receipts and dependent calls
// after a valid tool call. Do not stop at tool_call: parallel calls remain valid.
export function gemmaToolResponseStop(payload, model) {
  if (model.api !== 'openai-completions' ||
      !/^gemma-?4(?:[-:]|$)/i.test(model.id?.split('/').at(-1) ?? '') || !payload.tools?.length) return payload;
  const stop = payload.stop === undefined ? [] : Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  return { ...payload, stop: [...new Set([...stop, '<|tool_response>'])] };
}

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

async function* cleanGemmaResponse(stream) {
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

// Some Gemma parsers split the end of a raw thought envelope across native
// reasoning and content fields (e.g. reasoning="<|c", content="ught\n<channel|>...").
// Only reconcile a matching native opener/closer, never classify prose by words.
async function* cleanThoughtBoundary(stream) {
  const opening = '<|channel>thought\n';
  let reasoningIndex, head = '', tail = '', closed = false, open = false;
  const texts = new Map();
  for await (const chunk of stream) {
    if (chunk.type === 'reasoning-delta') {
      if (reasoningIndex !== chunk.index) { reasoningIndex = chunk.index; head = ''; tail = ''; closed = false; }
      head = (head + chunk.text).slice(0, opening.length);
      closed ||= (tail + chunk.text).includes(close);
      tail = (tail + chunk.text).slice(-close.length);
      open = !closed && head.length > 0 && (opening.startsWith(head) || head.startsWith(opening));
    }
    if (chunk.type === 'text-delta') {
      let state = texts.get(chunk.index);
      if (!state) { state = { pending: '', checking: open, dropped: 0 }; texts.set(chunk.index, state); open = false; }
      if (state.checking) {
        state.pending += chunk.text;
        const end = state.pending.indexOf(close);
        // Backticked protocol examples are literal text, not a boundary.
        if (end >= 0 && !state.pending.slice(0, end).includes('`')) {
          state.dropped = end + close.length;
          state.pending = state.pending.slice(state.dropped);
        } else if (end < 0 && state.pending.length <= 1024 && !state.pending.includes('`')) continue;
        state.checking = false;
        if (state.pending) yield { ...chunk, text: state.pending };
        state.pending = '';
        continue;
      }
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      const state = texts.get(chunk.index);
      if (state?.pending) yield { type: 'text-delta', index: chunk.index, text: state.pending };
      texts.delete(chunk.index);
      yield { ...chunk, block: { ...chunk.block, text: chunk.block.text.slice(state?.dropped ?? 0) } };
      continue;
    }
    yield chunk;
  }
}

// A misconfigured/degenerate Gemma server can leak its wire-format tool call
// into OpenAI content. Do not promote that text into an invocation. Reject the
// whole malformed response so the provider's existing SERVER retry policy owns
// recovery. A leading raw call is invalid even if the server appends invented
// results/reasoning after it. Quoted examples and introductory prose stay text.
export async function* normalizeGemmaResponse(stream) {
  const pending = new Map();
  const ordinary = new Set();
  const prefixes = ['call:', '<|tool_call>call:'];
  for await (const chunk of cleanGemmaResponse(cleanThoughtBoundary(stream))) {
    if (chunk.type === 'text-delta' && !ordinary.has(chunk.index)) {
      const text = (pending.get(chunk.index) ?? '') + chunk.text;
      if (prefixes.some(prefix => prefix.startsWith(text) || text.startsWith(prefix))) {
        pending.set(chunk.index, text);
        continue;
      }
      pending.delete(chunk.index);
      ordinary.add(chunk.index);
      yield { ...chunk, text };
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      if (/^(?:<\|tool_call>)?call:[A-Za-z_][\w.-]*\{[\s\S]*?\}<tool_call\|>/.test(chunk.block.text.trim())) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'SERVER', message: 'Gemma provider returned an unparsed tool-call envelope as text instead of a structured tool call.',
        } } };
        return;
      }
      if (pending.has(chunk.index)) yield { type: 'text-delta', index: chunk.index, text: pending.get(chunk.index) };
      pending.delete(chunk.index);
      ordinary.delete(chunk.index);
      yield chunk;
    } else yield chunk;
  }
}
