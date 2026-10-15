import { invalid, requireString } from './providers.mjs';

const MAX_SCANNED_EVENTS = 512;
const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_CONTENT_BLOCKS = 64;
const MAX_TEXT_CHARS = 8192;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

function bounded(value, limit, clipping) {
  if (typeof value !== 'string') return undefined;
  if (value.length <= limit) return value;
  clipping.truncated = true;
  return value.slice(0, limit);
}

function contentBlock(block, clipping) {
  if (!record(block)) return;
  if (block.type === 'text' && typeof block.text === 'string')
    return { type: 'text', text: bounded(block.text, MAX_TEXT_CHARS, clipping) };
  if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string')
    return {
      type: 'tool-call', id: bounded(block.id, 256, clipping),
      name: bounded(block.name, 256, clipping), arguments: bounded(block.arguments, MAX_TEXT_CHARS, clipping),
    };
  if (['image', 'file'].includes(block.type) && record(block.attachment) && typeof block.attachment.attachmentId === 'string') {
    const source = block.attachment;
    const attachment = { attachmentId: bounded(source.attachmentId, 256, clipping) };
    for (const key of ['name', 'mediaType']) {
      const value = bounded(source[key], 256, clipping);
      if (value !== undefined) attachment[key] = value;
    }
    for (const key of ['bytes', 'width', 'height']) if (integer(source[key])) attachment[key] = source[key];
    return { type: block.type, attachment };
  }
}

function publicMessage(message, role, clipping) {
  if (!record(message) || message.role !== role || typeof message.id !== 'string' || !Array.isArray(message.content)) return;
  const content = [];
  let bytes = 2;
  for (const block of message.content) {
    const projected = contentBlock(block, clipping);
    if (!projected) continue;
    const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
    if (content.length >= MAX_CONTENT_BLOCKS || bytes + size > MAX_CONTENT_BYTES) {
      clipping.truncated = true;
      break;
    }
    content.push(projected);
    bytes += size;
  }
  const value = { id: bounded(message.id, 256, clipping), role, content };
  if (role === 'tool') {
    if (typeof message.toolCallId !== 'string') return;
    value.toolCallId = bounded(message.toolCallId, 256, clipping);
    if (typeof message.isError === 'boolean') value.isError = message.isError;
  }
  return value;
}

function errorDetails(source, clipping) {
  if (!record(source)) return;
  const result = {};
  for (const key of ['name', 'code', 'message', 'reason']) {
    const value = bounded(source[key], key === 'code' || key === 'name' ? 256 : MAX_TEXT_CHARS, clipping);
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

// Select display fields rather than copying opaque request, provider or tool metadata.
function publicEvent(event) {
  if (!record(event) || !integer(event.seq) || !record(event.data)) return;
  const source = event.data, clipping = { truncated: false };
  let data;
  if (event.type === 'user/message') {
    // Native user events also carry injected AGENTS/skills/context. Those are not a child conversation.
    if (!['user', 'agent-message'].includes(source.source?.kind) ||
        (source.source.form !== undefined && source.source.form !== 'relay')) return;
    data = publicMessage(source, 'user', clipping);
  } else if (event.type === 'assistant/message' || event.type === 'tool/result') {
    const tool = event.type === 'tool/result';
    const message = publicMessage(source.message, tool ? 'tool' : 'assistant', clipping);
    if (!message) return;
    data = { message };
    if (!tool && source.interrupted === true) data.interrupted = true;
    if (tool && message.isError === true) {
      const error = errorDetails(source.error, clipping);
      if (error) data.error = error;
    }
  } else if (event.type === 'tool/call') {
    if (typeof source.callId !== 'string' || typeof source.name !== 'string' || typeof source.arguments !== 'string') return;
    data = {
      callId: bounded(source.callId, 256, clipping), name: bounded(source.name, 256, clipping),
      arguments: bounded(source.arguments, MAX_TEXT_CHARS, clipping),
    };
  } else if (event.type === 'turn/start' || event.type === 'turn/end') {
    if (!integer(source.turn)) return;
    data = {};
    if (event.type === 'turn/end') {
      if (!record(source.reason) || typeof source.reason.kind !== 'string') return;
      data.reason = { kind: bounded(source.reason.kind, 256, clipping) };
      const error = errorDetails(source.reason.error, clipping);
      if (error) data.reason.error = error;
    }
  } else return;
  if (!data) return;
  if (event.type !== 'user/message') {
    for (const key of ['turn', 'step']) if (integer(source[key])) data[key] = source[key];
  }
  const projected = { seq: event.seq, type: event.type, data };
  if (typeof event.time === 'number' && Number.isFinite(event.time)) projected.time = event.time;
  if (typeof event.time === 'string') projected.time = bounded(event.time, 64, clipping);
  if (clipping.truncated) projected.truncated = true;
  return projected;
}

/** Cold inspection only: no Agent activation, tool dispatch, permissions or state writes. */
export async function readSubagentConversation(parent, params, driver) {
  const childSessionId = requireString(params.childSessionId, 'childSessionId');
  if (childSessionId.length > 256) throw invalid('childSessionId is too long');
  const afterSeq = params.afterSeq === undefined ? -1 : params.afterSeq;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw invalid('afterSeq must be an integer greater than or equal to -1');
  if (typeof driver.nativeSessionId !== 'function' || typeof driver.history !== 'function')
    throw Object.assign(new Error('Subagent conversation inspection is unavailable'), { code: -32601 });
  const nativeParent = driver.nativeSessionId(parent.id);
  const history = await driver.history(childSessionId);
  if (history?.meta?.id !== childSessionId || history.meta.origin !== 'subagent' || history.meta.parentSession !== nativeParent)
    throw invalid('Subagent does not belong to this conversation');
  if (driver.nativeSessionId(parent.id) !== nativeParent) throw invalid('Parent conversation changed during inspection');
  if (!Array.isArray(history.events) || !integer(history.inheritedEventCount) || history.inheritedEventCount > history.events.length)
    throw invalid('Subagent history boundary is unavailable');
  if (afterSeq >= history.events.length) throw invalid('afterSeq is ahead of the subagent history');
  let index = Math.max(afterSeq + 1, history.inheritedEventCount);
  let throughSeq = index - 1, scanned = 0, bytes = 0;
  const events = [];
  while (index < history.events.length && scanned < MAX_SCANNED_EVENTS && events.length < MAX_BATCH_EVENTS) {
    const source = history.events[index];
    const projected = publicEvent(source);
    const size = projected ? Buffer.byteLength(JSON.stringify(projected)) : 0;
    if (events.length && bytes + size > MAX_BATCH_BYTES - 1024) break;
    if (projected) { events.push(projected); bytes += size; }
    throughSeq = source.seq;
    index += 1;
    scanned += 1;
  }
  return { sessionId: parent.id, childSessionId, throughSeq, hasMore: index < history.events.length, events };
}
