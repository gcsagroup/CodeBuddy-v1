import { invalid, requireString } from './providers.mjs';
import { createToolInputPreview } from './harness/tool-input-preview.mjs';

const MAX_SCANNED_EVENTS = 512;
const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_ANCESTORS = 32;
const CATALOG_MODES = new Set(['one-shot', 'continuable', 'external', 'unknown']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** Display a published native activation boundary, never infer one from prose. */
export function subagentLifecycleUpdate(parentSessionId, event, entry) {
  const childId = event.childSessionId ?? event.id;
  if (!['subagent_start', 'subagent_end'].includes(event.type) ||
      typeof event.runId !== 'string' || !event.runId || entry?.id !== childId ||
      !['one-shot', 'continuable'].includes(entry.mode)) return;
  const phase = event.type === 'subagent_start' ? 'start' : 'end';
  const eventId = `subagent-lifecycle:${JSON.stringify([parentSessionId, event.runId, phase])}`;
  const created = Date.now() / 1000;
  return { sessionUpdate: 'session_info_update', _meta: { goose: {
    messageId: eventId, created,
    subagentLifecycle: { schema_version: 1, type: 'subagent_lifecycle', event_id: eventId,
      session_id: parentSessionId, child_session_id: childId, activation_id: event.runId,
      phase, label: (entry.label?.trim() || childId).slice(0, 1000), created_at: created },
  } } };
}

function sessionId(value, name) {
  const id = requireString(value, name);
  if (id.length > 256) throw invalid(`${name} is too long`);
  return id;
}

function ancestorPath(params) {
  const value = params.ancestorSessionIds;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ANCESTORS)
    throw invalid(`ancestorSessionIds must be an array of at most ${MAX_ANCESTORS} session ids`);
  const path = value.map(id => sessionId(id, 'ancestorSessionId'));
  if (new Set(path).size !== path.length) throw invalid('ancestorSessionIds must not contain a cycle');
  return path;
}

function assertChild(history, childId, parentId) {
  if (history?.meta?.id !== childId || history.meta.origin !== 'subagent' || history.meta.parentSession !== parentId)
    throw invalid('Subagent does not belong to this conversation');
}

async function readCatalog(parentId, driver, assertCurrent) {
  const entries = await driver.listSubagentChildren(parentId);
  assertCurrent();
  if (!Array.isArray(entries)) throw invalid('Subagent catalog is unavailable');
  return entries.map(entry => {
    if (!record(entry) || !integer(entry.createdAt) || !CATALOG_MODES.has(entry.mode) ||
        (entry.label !== undefined && typeof entry.label !== 'string') ||
        (entry.mode === 'continuable' && typeof entry.label !== 'string'))
      throw invalid('Subagent catalog entry is unavailable');
    return {
      id: sessionId(entry.id, 'catalog child id'), createdAt: entry.createdAt, mode: entry.mode,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    };
  });
}

function assertCatalogChild(entries, childId) {
  const entry = entries.find(child => child.id === childId);
  if (!entry) throw invalid('Subagent does not belong to this conversation catalog');
  if (entry.mode !== 'one-shot' && entry.mode !== 'continuable')
    throw invalid('Subagent conversation is unavailable for this catalog mode');
}

// The root is a product identity; every subsequent address is an immutable native child.
async function resolveAncestorPath(parent, path, driver) {
  const nativeRoot = driver.nativeSessionId(parent.id);
  const assertCurrent = () => {
    if (driver.nativeSessionId(parent.id) !== nativeRoot) throw invalid('Parent conversation changed during inspection');
  };
  let nativeParent = nativeRoot, catalogParent = nativeRoot;
  for (const id of path) {
    if (id === nativeRoot || id === parent.id) throw invalid('ancestorSessionIds must not contain a cycle');
    assertCatalogChild(await readCatalog(catalogParent, driver, assertCurrent), id);
    const history = await driver.nativeHistory(id);
    assertCurrent();
    assertChild(history, id, nativeParent);
    nativeParent = id;
    catalogParent = id;
  }
  assertCurrent();
  return { nativeRoot, nativeParent, catalogParent, assertCurrent };
}

/** Read DSH's parent-owned catalog without creating or resuming an Agent. */
export async function listSubagentCatalog(parent, params, driver) {
  const path = ancestorPath(params);
  if (typeof driver.nativeSessionId !== 'function' || typeof driver.listSubagentChildren !== 'function' ||
      (path.length && typeof driver.nativeHistory !== 'function'))
    throw Object.assign(new Error('Subagent catalog inspection is unavailable'), { code: -32601 });
  const { catalogParent, assertCurrent } = await resolveAncestorPath(parent, path, driver);
  const children = await readCatalog(catalogParent, driver, assertCurrent);
  return { sessionId: parent.id, ancestorSessionIds: path, children };
}

function bounded(value, limit, clipping) {
  if (typeof value !== 'string') return undefined;
  if (value.length <= limit) return value;
  clipping.truncated = true;
  return value.slice(0, limit);
}

function contentBlock(block, clipping) {
  if (!record(block)) return;
  if (block.type === 'text' && typeof block.text === 'string')
    return { type: 'text', text: block.text };
  if (block.type === 'reasoning' && typeof block.text === 'string')
    return { type: 'reasoning', text: block.text };
  if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string')
    return {
      type: 'tool-call', id: bounded(block.id, 256, clipping),
      name: bounded(block.name, 256, clipping), arguments: block.arguments,
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
  for (const block of message.content) {
    const projected = contentBlock(block, clipping);
    if (!projected) continue;
    content.push(projected);
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
    const value = key === 'code' || key === 'name' ? bounded(source[key], 256, clipping)
      : typeof source[key] === 'string' ? source[key] : undefined;
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

// File tools persist their display receipts in meta, separately from model text.
// Only these public fields cross the bridge; opaque tool/provider metadata stays private.
function fileResult(source, clipping) {
  if (!record(source) || typeof source.path !== 'string') return;
  const result = { path: bounded(source.path, 4096, clipping) };
  if (['create', 'update'].includes(source.operation)) result.operation = source.operation;
  if (Array.isArray(source.diffs)) {
    const diffs = [];
    for (const entry of source.diffs) {
      if (!record(entry) || typeof entry.oldText !== 'string' || typeof entry.newText !== 'string') return;
      const diff = { oldText: entry.oldText, newText: entry.newText };
      diffs.push(diff);
    }
    result.diffs = diffs;
  }
  return result;
}

// Select display fields rather than copying opaque request, provider or tool metadata.
function publicEvent(event, parentInputs = []) {
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
    if (tool) {
      const result = fileResult(source.meta, clipping);
      if (result) data.fileResult = result;
    }
    if (!tool && source.interrupted === true) data.interrupted = true;
    if (tool && message.isError === true) {
      const error = errorDetails(source.error, clipping);
      if (error) data.error = error;
    }
  } else if (event.type === 'tool/call') {
    if (typeof source.callId !== 'string' || typeof source.name !== 'string' || typeof source.arguments !== 'string') return;
    data = {
      callId: bounded(source.callId, 256, clipping), name: bounded(source.name, 256, clipping),
      arguments: source.arguments,
    };
    // Attribute display receipts to native human-input admission, never the
    // compatibility journal's second-resolution timestamps or model prose.
    const time = new Date(event.time).getTime();
    const input = parentInputs.findLast(item => item.time <= time);
    if (input && input.time < time) data.parentUserMessageId = input.id;
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
  const childSessionId = sessionId(params.childSessionId, 'childSessionId');
  const path = ancestorPath(params);
  const afterSeq = params.afterSeq === undefined ? -1 : params.afterSeq;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw invalid('afterSeq must be an integer greater than or equal to -1');
  if (typeof driver.nativeSessionId !== 'function' || typeof driver.nativeHistory !== 'function' ||
      (params.ancestorSessionIds !== undefined && typeof driver.listSubagentChildren !== 'function'))
    throw Object.assign(new Error('Subagent conversation inspection is unavailable'), { code: -32601 });
  const { nativeRoot, nativeParent, catalogParent, assertCurrent } = await resolveAncestorPath(parent, path, driver);
  if (childSessionId === nativeRoot || childSessionId === parent.id || path.includes(childSessionId))
    throw invalid('Subagent path must not contain a cycle');
  // Explicit paths use native catalog membership, including the leaf. Omitted
  // paths retain the original direct-child inspection contract.
  if (params.ancestorSessionIds !== undefined)
    assertCatalogChild(await readCatalog(catalogParent, driver, assertCurrent), childSessionId);
  const history = await driver.nativeHistory(childSessionId);
  assertCurrent();
  assertChild(history, childSessionId, nativeParent);
  if (!Array.isArray(history.events) || !integer(history.inheritedEventCount) || history.inheritedEventCount > history.events.length)
    throw invalid('Subagent history boundary is unavailable');
  if (afterSeq >= history.events.length) throw invalid('afterSeq is ahead of the subagent history');
  let index = Math.max(afterSeq + 1, history.inheritedEventCount);
  let throughSeq = index - 1, scanned = 0, bytes = 0;
  let parentInputs = [], attributionUnavailable = false;
  if (!path.length && history.events.slice(index, index + MAX_SCANNED_EVENTS).some(event => event.type === 'tool/call' && ['write', 'edit'].includes(event.data?.name))) {
    let owner;
    try { owner = await driver.nativeHistory(nativeRoot); }
    catch { /* Optional turn statistics must not hide the child's readable history. */ }
    assertCurrent();
    attributionUnavailable = owner?.meta?.id !== nativeRoot || !Array.isArray(owner.events);
    if (!attributionUnavailable) {
      const seen = new Set();
      for (const event of owner.events) {
        const inputs = event.type === 'agent/inbox/spliced' ? event.data?.inserted : event.type === 'user/message' ? [event.data] : [];
        for (const message of inputs ?? []) {
          const id = message.source?.rpcId, time = new Date(event.time).getTime();
          if (message.source?.kind !== 'user' || typeof id !== 'string' || !id || id.length > 256 || !Number.isFinite(time) || seen.has(id)) continue;
          seen.add(id);
          parentInputs.push({ id, time });
        }
      }
      parentInputs.sort((left, right) => left.time - right.time);
    }
  }
  const events = [];
  while (index < history.events.length && scanned < MAX_SCANNED_EVENTS && events.length < MAX_BATCH_EVENTS) {
    const source = history.events[index];
    const projected = publicEvent(source, parentInputs);
    const size = projected ? Buffer.byteLength(JSON.stringify(projected)) : 0;
    if (events.length && bytes + size > MAX_BATCH_BYTES - 1024) break;
    if (projected) { events.push(projected); bytes += size; }
    throughSeq = source.seq;
    index += 1;
    scanned += 1;
  }
  return {
    sessionId: parent.id, childSessionId,
    ...(params.ancestorSessionIds === undefined ? {} : { ancestorSessionIds: path }),
    ...(attributionUnavailable ? { attributionUnavailable: true } : {}),
    throughSeq, hasMore: index < history.events.length, events,
  };
}

// Viewing uses the native durable child address. It never resolves/activates an
// Agent or subscribes to the session execution/control APIs.
export async function followSubagentConversation(parent, params, driver, signal, publish) {
  const childSessionId = sessionId(params.childSessionId, 'childSessionId');
  const path = ancestorPath(params);
  if (typeof driver.nativeSessionId !== 'function' || typeof driver.nativeHistory !== 'function' ||
      typeof driver.listSubagentChildren !== 'function' || typeof driver.followSubagent !== 'function')
    throw Object.assign(Error('Subagent streaming is unavailable'), { code: -32601 });
  const { nativeRoot, nativeParent, assertCurrent } = await resolveAncestorPath(parent, path, driver);
  if (childSessionId === nativeRoot || childSessionId === parent.id || path.includes(childSessionId))
    throw invalid('Subagent path must not contain a cycle');
  assertCatalogChild(await readCatalog(nativeParent, driver, assertCurrent), childSessionId);
  const history = await driver.nativeHistory(childSessionId);
  assertCurrent();
  assertChild(history, childSessionId, nativeParent);
  if (!integer(history.inheritedEventCount)) throw invalid('Subagent history boundary is unavailable');
  const previews = createToolInputPreview();
  const displayChunk = chunk => {
    previews.push(chunk);
    if (record(chunk) && ['text-delta', 'reasoning-delta'].includes(chunk.type) && typeof chunk.text === 'string')
      return { type: chunk.type, text: chunk.text };
    if (record(chunk) && chunk.type === 'tool-call-delta') {
      const preview = previews.read(chunk.index);
      return { type: chunk.type, text: '', ...(preview ? { preview } : {}) };
    }
  };
  const emit = value => { signal.throwIfAborted(); assertCurrent(); return publish(value); };
  for await (const item of driver.followSubagent({ parentSessionId: nativeParent, childSessionId, mode: 'unknown' }, signal)) {
    signal.throwIfAborted();
    assertCurrent();
    if (item.type === 'snapshot') {
      previews.clear();
      assertChild({ meta: item.header }, childSessionId, nativeParent);
      await emit({ type: 'reset' });
      let events = [];
      for (const row of item.records ?? []) {
        const event = row.event;
        if (event?.seq < history.inheritedEventCount) continue;
        const projected = publicEvent(event);
        if (projected) events.push(projected);
        if (events.length === MAX_BATCH_EVENTS) { await emit({ type: 'history', events }); events = []; }
      }
      const active = item.assistantStream?.activeAttempt;
      await emit({ type: 'ready', events, ...(active ? { active: {
        attemptId: active.attemptId, turn: active.turn, step: active.step,
        chunks: active.chunks.map(displayChunk).filter(Boolean),
      } } : {}) });
    } else if (item.type === 'event') {
      if (item.event.seq < history.inheritedEventCount) continue;
      const event = publicEvent(item.event);
      if (event) await emit({ type: 'history', events: [event] });
    } else if (item.type === 'assistant-stream') {
      const frame = item.frame;
      if (frame.type === 'start' || frame.type === 'end') previews.clear();
      const chunk = frame.type === 'chunk' ? displayChunk(frame.chunk) : undefined;
      if (['start', 'end'].includes(frame.type) || chunk) await emit({ type: 'stream', frame: {
        type: frame.type, attemptId: frame.attemptId, turn: frame.turn, step: frame.step,
        ...(chunk ? { chunk } : {}),
      } });
    }
  }
}
