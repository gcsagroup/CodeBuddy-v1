// Some Gemma 4 chat-template servers send an empty thought envelope as ordinary
// content, even when they also supply native reasoning and tool-call blocks.
const opening = '<|channel>thought';
const close = '<channel|>';
const emptyThought = opening + '\n' + close;
const toolSeparator = '<|"|>\n<|channel>thought\n';

// Gemma's tool-response boundary belongs to the host. Without the documented
// inference stop, a server can generate fictitious receipts and dependent calls
// after a valid tool call. Do not stop at tool_call: parallel calls remain valid.
export function gemmaToolResponseStop(payload, model) {
  if (model.api !== 'openai-completions' ||
      !/^gemma-?4(?:[-:]|$)/i.test(model.id?.split('/').at(-1) ?? '') || !payload.tools?.length) return payload;
  const stop = payload.stop === undefined ? [] : Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  return { ...payload, stop: [...new Set([...stop, '<|tool_response>'])] };
}

function visibleBlock(text, reasoning = false) {
  const prefix = reasoning ? opening : emptyThought;
  if (reasoning && text.startsWith('<|') && opening.startsWith(text)) return '';
  if (text.startsWith(prefix)) text = text.slice(prefix.length);
  return text.endsWith(close) ? text.slice(0, -close.length) : text;
}

// Only hold an ambiguous boundary, so plain text still streams immediately.
function visibleDelta(state, text, reasoning) {
  const pending = state.pending + text;
  const prefix = reasoning ? opening : emptyThought;
  if (state.start && prefix.startsWith(pending) && pending !== prefix) {
    state.pending = pending;
    return '';
  }
  const value = state.start && pending.startsWith(prefix) ? pending.slice(prefix.length) : pending;
  state.start = false;
  let keep = Math.min(Math.max(close.length, opening.length), value.length);
  while (keep && ![close, opening].some(marker => keep <= marker.length && value.endsWith(marker.slice(0, keep)))) keep--;
  state.pending = value.slice(value.length - keep);
  return value.slice(0, value.length - keep);
}

// Check reasoning and tool-producing generation. A normal final answer can
// legitimately contain repetition requested by the user.
function repeatedParagraph(state, text) {
  // The installed Gemma stream also degenerated into a single endless line
  // (for example " l, l, l, ..."). Track short periods across transport chunks;
  // paragraph boundaries alone never see this case. Tool arguments and ordinary
  // final answers do not pass through this repetition guard.
  state.periods ??= new Uint16Array(32);
  state.characters ??= '';
  for (const character of text) {
    for (let period = 1; period <= state.periods.length; period++) {
      state.periods[period - 1] = state.characters.at(-period) === character
        ? state.periods[period - 1] + 1 : 0;
      if (state.periods[period - 1] >= Math.max(512, period * 16)) return true;
    }
    state.characters = (state.characters + character).slice(-32);
  }
  state.lines ??= { tail: '', count: 0 };
  const lines = (state.lines.tail + text).split('\n');
  const unfinished = lines.pop();
  for (const line of lines) {
    const complete = !state.lines.truncated && line.length <= 1024 ? line : '';
    state.lines.count = complete === state.lines.previous ? state.lines.count + 1 : 1;
    state.lines.previous = complete;
    state.lines.truncated = false;
    if (complete.length >= 8 && state.lines.count >= 16 && complete.length * state.lines.count >= 512) return true;
  }
  state.lines.truncated ||= unfinished.length > 1024;
  state.lines.tail = unfinished.slice(-1024);
  const parts = (state.tail + text).split('\n\n');
  const remainder = parts.pop();
  state.paragraphs ??= [];
  state.paragraphPeriods ??= new Uint16Array(8);
  for (const part of parts) {
    // Ignore long sections instead of comparing only a common suffix.
    const paragraph = !state.truncated && part.length <= 1024 ? part : '';
    state.count = paragraph === state.previous ? state.count + 1 : 1;
    state.previous = paragraph;
    state.truncated = false;
    if (paragraph.length >= 32 && state.count >= 16) return true;
    // Installed streams alternated several short paragraphs (receipt, done,
    // final answer), so no two adjacent paragraphs were equal. Detect bounded
    // cycles without inspecting tool arguments or ordinary final-answer text.
    for (let period = 1; period <= state.paragraphPeriods.length; period++) {
      state.paragraphPeriods[period - 1] = paragraph && state.paragraphs.at(-period) === paragraph
        ? state.paragraphPeriods[period - 1] + 1 : 0;
      if (state.paragraphPeriods[period - 1] >= period * 16 &&
          state.paragraphs.slice(-period).reduce((size, value) => size + value.length, 0) * 16 >= 512) return true;
    }
    state.paragraphs.push(paragraph);
    if (state.paragraphs.length > 8) state.paragraphs.shift();
  }
  state.truncated ||= remainder.length > 1024;
  state.tail = remainder.slice(-1024);
  return false;
}

async function* cleanGemmaResponse(stream, repairedBoundaries) {
  const blocks = new Map();
  let toolProposed = false;
  let fileCallCompleted = false;
  for await (const chunk of stream) {
    if (chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') toolProposed = true;
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const state = blocks.get(chunk.index) ?? { start: true, pending: '', tail: '', count: 0 };
      blocks.set(chunk.index, state);
      if ((toolProposed || chunk.type === 'reasoning-delta') && repeatedParagraph(state, chunk.text)) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'SERVER', message: 'Gemma returned repetitive output instead of completing its response.',
        } } };
        return;
      }
      const text = visibleDelta(state, chunk.text, chunk.type === 'reasoning-delta');
      if (chunk.type === 'text-delta') {
        state.answerHead = ((state.answerHead ?? '') + text).slice(0, toolSeparator.length + 1);
        if (state.answerHead.startsWith('<|') && !(toolProposed && toolSeparator.startsWith(state.answerHead))) {
          yield { type: 'finish', reason: { kind: 'error', failure: {
            code: 'SERVER', message: 'Gemma returned an unparsed native envelope in answer content.',
          } } };
          return;
        }
        state.openerCursor ??= { width: 0, ticks: 0, matched: 0, offset: 0, quotedEnd: 0 };
        if (!(toolProposed && toolSeparator.startsWith(state.answerHead)) &&
            scanThought(state.openerCursor, text, true, opening)) {
          yield { type: 'finish', reason: { kind: 'error', failure: {
            code: 'SERVER', message: 'Gemma returned an unparsed thought opener inside answer content.',
          } } };
          return;
        }
      }
      if (chunk.type === 'text-delta' && (toolProposed || repairedBoundaries.has(chunk.index))) {
        state.cursor ??= { width: 0, ticks: 0, matched: 0, offset: 0, quotedEnd: 0 };
        if (scanThought(state.cursor, text)) {
          yield { type: 'finish', reason: { kind: 'error', failure: {
            code: 'SERVER', message: 'Gemma returned an unparsed thought boundary in answer content.',
          } } };
          return;
        }
      }
      if (chunk.type === 'text-delta' && toolProposed) {
        // A native call is not executable until the whole response is valid.
        // Likewise, publish its accompanying prose only after block validation;
        // otherwise a broken parser can expose invented receipts before retry.
        state.deferred = true;
      } else if (text) yield { ...chunk, text };
    } else if (chunk.type === 'block-end' && ['text', 'reasoning'].includes(chunk.block.type)) {
      const state = blocks.get(chunk.index);
      const reasoning = chunk.block.type === 'reasoning';
      const visible = visibleBlock(chunk.block.text, reasoning);
      if (!reasoning && fileCallCompleted && containsNativeFileResult(visible)) {
        // Some servers strip the tool-response role token but leak the native
        // dsh-tool-fs envelope into assistant content. That result belongs to
        // the host. The provider adapter can reorder content and call blocks,
        // so it cannot prove which calls preceded this fabricated result.
        // Native retry must discard the whole speculative batch before execution.
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'SERVER', message: 'Gemma returned a model-authored native file receipt. Return structured tool calls and wait for the host result instead of fabricating tool output.',
        } } };
        return;
      }
      if (!reasoning && !(toolProposed && visible.trimEnd() === toolSeparator.trimEnd()) &&
          scanThought({ width: 0, ticks: 0, matched: 0, offset: 0, quotedEnd: 0 }, visible, true, opening)) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'SERVER', message: 'Gemma returned an unparsed thought opener inside answer content.',
        } } };
        return;
      }
      if (!reasoning && (toolProposed || repairedBoundaries.has(chunk.index)) &&
          scanThought({ width: 0, ticks: 0, matched: 0, offset: 0, quotedEnd: 0 }, visible)) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'SERVER', message: 'Gemma returned an unparsed thought boundary in answer content.',
        } } };
        return;
      }
      if (state?.deferred) {
        if (visible) yield { type: 'text-delta', index: chunk.index, text: visible };
      } else if (state?.pending && state.pending !== close &&
          !(reasoning && state.start && state.pending.startsWith('<|') && opening.startsWith(state.pending))) {
        yield { type: reasoning ? 'reasoning-delta' : 'text-delta', index: chunk.index, text: state.pending };
      }
      blocks.delete(chunk.index);
      repairedBoundaries.delete(chunk.index);
      yield { ...chunk, block: { ...chunk.block, text: visible } };
    } else {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' &&
          ['read', 'write', 'edit'].includes(chunk.block.name)) fileCallCompleted = true;
      if (chunk.type === 'block-end') blocks.delete(chunk.index);
      yield chunk;
    }
  }
}

function containsNativeFileResult(text) {
  // Match the pinned dsh-tool-fs model-facing envelope grammar, not the prose
  // describing success or the user's intent. Quoted/code examples remain text.
  const end = scanThought({ width: 0, ticks: 0, matched: 0, offset: 0, quotedEnd: 0 }, text, true, '<path>');
  return end > 0 && /^<path>[^\r\n]*<\/path>\r?\n<type>file<\/type>\r?\n<content>\r?\n[\s\S]*?\r?\n<\/content>/.test(text.slice(end - '<path>'.length));
}

// Backtick runs can straddle both transport chunks and the reasoning/text split.
// A protocol token inside a paired code span is literal. An unpaired run in a
// truncated filename does not quote a token through the end of the text block.
function scanThought(state, text, detectBoundary = true, token = close) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '`') {
      state.ticks++;
      state.matched = 0;
      continue;
    }
    if (state.ticks) {
      if (!state.width) state.width = state.ticks;
      else if (state.width === state.ticks) state.width = 0;
      state.ticks = 0;
    }
    if (!detectBoundary) continue;
    state.matched = char === token[state.matched] ? state.matched + 1 : Number(char === token[0]);
    if (state.matched === token.length) {
      state.matched = 0;
      if (!state.width) return state.offset + i + 1;
      state.quotedEnd ||= state.offset + i + 1;
    }
  }
  state.offset += text.length;
  return 0;
}

function closedCodeSpans(text, initial) {
  const state = { width: 0, ticks: 0, offset: 0, ...initial };
  scanThought(state, text, false);
  return state.ticks === state.width;
}

// Some Gemma parsers split the end of a raw thought envelope across native
// reasoning and content fields (e.g. reasoning="<|c", content="ught\n<channel|>...").
// Only reconcile a matching native opener/closer, never classify prose by words.
async function* cleanThoughtBoundary(stream, repairedBoundaries) {
  const opening = '<|channel>thought\n';
  let reasoningIndex, head, cursor, closed = false, open = false;
  const texts = new Map();
  for await (const chunk of stream) {
    if (chunk.type === 'reasoning-delta') {
      if (!cursor || reasoningIndex !== chunk.index) {
        reasoningIndex = chunk.index;
        head = '';
        closed = false;
        cursor = { width: 0, ticks: 0, matched: 0, offset: 0, quotedEnd: 0 };
      }
      head = (head + chunk.text).slice(0, opening.length);
      if (head.startsWith('<|') && !opening.startsWith(head) && !head.startsWith(opening)) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'SERVER', message: 'Gemma returned a malformed native thought opener.',
        } } };
        return;
      }
      closed ||= Boolean(scanThought(cursor, chunk.text));
      open = !closed && head.length > 0 && (opening.startsWith(head) || head.startsWith(opening));
    }
    if (chunk.type === 'text-delta') {
      let state = texts.get(chunk.index);
      if (!state) {
        const initial = { ...cursor, offset: 0, quotedEnd: 0 };
        state = { pending: '', checking: open, dropped: 0, initial, cursor: { ...initial } };
        texts.set(chunk.index, state);
        open = false;
      }
      if (state.deferred) continue;
      if (state.checking) {
        const held = state.pending.length;
        const end = scanThought(state.cursor, chunk.text.slice(0, 1024 - held));
        // An incomplete code span in native reasoning can appear to quote
        // the boundary. Later backticks may belong entirely to the answer.
        // Resolve this ambiguity on the provider's complete block, without
        // emitting the prefix or retaining a second copy of a long answer.
        if (state.cursor.quotedEnd) {
          state.deferred = true;
          state.pending = '';
          continue;
        }
        state.pending += chunk.text;
        if (end) { state.dropped = end; repairedBoundaries.add(chunk.index); }
        else if (state.pending.length <= 1024) continue;
        state.pending = state.pending.slice(state.dropped);
        state.checking = false;
        if (state.pending) yield { ...chunk, text: state.pending };
        state.pending = '';
        continue;
      }
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      const state = texts.get(chunk.index);
      if (state?.deferred) {
        const raw = chunk.block.text;
        const candidate = state.cursor.quotedEnd;
        const tail = raw.slice(candidate);
        state.dropped = !closedCodeSpans(raw, state.initial) && closedCodeSpans(tail)
          ? candidate : scanThought({ ...state.initial }, raw);
        if (state.dropped) repairedBoundaries.add(chunk.index);
        state.pending = raw;
      }
      const visible = state?.pending.slice(state.dropped);
      if (visible) yield { type: 'text-delta', index: chunk.index, text: visible };
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
export async function* normalizeGemmaResponse(stream, tools = []) {
  const pending = new Map();
  const ordinary = new Set();
  const prefixes = ['call:', '<|'];
  // Per-response parser facts, not inferred intent: only text whose native
  // thought boundary was repaired needs the extra framing check without a call.
  const repairedBoundaries = new Set();
  let inToolResponse = false;
  for await (const chunk of cleanGemmaResponse(cleanThoughtBoundary(stream, repairedBoundaries), repairedBoundaries)) {
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') inToolResponse = true;
    // Identity may arrive after the first delta. Only a completed block can
    // become a journal source or an approval request. Let native retry discard
    // this entire attempt, including any sibling calls that preceded it.
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' &&
        (!chunk.block.id?.trim() || !chunk.block.name?.trim())) {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'SERVER', message: 'Gemma returned a tool call without a call ID or tool name.',
      } } };
      return;
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      const schema = tools.find(tool => tool.name === chunk.block.name)?.parameters;
      // The server may bury file_path inside content while emitting a valid JSON
      // object. Native tool rejection then starts a fresh successful model step,
      // resetting recovery forever. Reject malformed wire arguments at the same
      // seam as missing call identities so native SERVER retry stays bounded.
      // Only check the advertised root shape/required fields here; the tool owner
      // still validates full arguments and arbitrary external schema keywords.
      if (schema?.type === 'object') {
        // Keep this parser importable before index.mjs installs SDK contracts.
        const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
        let violations;
        try {
          const required = Array.isArray(schema.required)
            ? schema.required.filter(key => typeof key === 'string') : [];
          violations = validateJsonSchemaValue({ type: 'object',
            properties: Object.fromEntries(required.map(key => [key, {}])), required,
          }, JSON.parse(chunk.block.arguments));
        } catch { violations = ['arguments must be a JSON object']; }
        if (violations.length) {
          yield { type: 'finish', reason: { kind: 'error', failure: {
            code: 'SERVER', message: `Gemma returned invalid arguments for ${chunk.block.name}: ${violations.join('; ')}`,
          } } };
          return;
        }
      }
    }
    if (chunk.type === 'text-delta' && !ordinary.has(chunk.index)) {
      const text = (pending.get(chunk.index) ?? '') + chunk.text;
      if (text.startsWith('<|') && !(inToolResponse && toolSeparator.startsWith(text))) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'SERVER', message: 'Gemma returned an unparsed native envelope in answer content.',
        } } };
        return;
      }
      if ((inToolResponse && toolSeparator.startsWith(text)) ||
          prefixes.some(prefix => prefix.startsWith(text) || text.startsWith(prefix))) {
        pending.set(chunk.index, text);
        continue;
      }
      pending.delete(chunk.index);
      ordinary.add(chunk.index);
      yield { ...chunk, text };
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      if (inToolResponse && chunk.block.text.trimEnd() === toolSeparator.trimEnd()) {
        pending.delete(chunk.index);
        yield { ...chunk, block: { ...chunk.block, text: '' } };
        continue;
      }
      if (chunk.block.text.startsWith('<|')) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'SERVER', message: 'Gemma returned an unparsed native envelope in answer content.',
        } } };
        return;
      }
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
