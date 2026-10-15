import test from 'node:test';
import assert from 'node:assert/strict';
import { Compat } from '../compat.mjs';
import { readSubagentConversation } from '../subagent-conversations.mjs';

const method = '_goose/unstable/subagent/conversation/get';
const event = (seq, type, data) => ({ seq, time: 1792060000000 + seq, type, data });
const user = (id, text, kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] });
const assistant = (id, text) => ({ id, role: 'assistant', source: { kind: 'model', provider: 'private', replayState: { token: 'PRIVATE_REPLAY' } }, content: [{ type: 'text', text }] });

function fixture(events = [], inheritedEventCount = 0) {
  const state = { sessions: [{ id: 'parent-product', nativeSessionId: 'parent-native', type: 'code_pro', updates: [] }] };
  const reads = [];
  let nativeParent = 'parent-native';
  const history = { meta: { id: 'child-native', origin: 'subagent', parentSession: nativeParent, model: { apiKey: 'PRIVATE_HEADER' } }, inheritedEventCount, events };
  const driver = {
    nativeSessionId(id) { assert.equal(id, 'parent-product'); return nativeParent; },
    async history(id) { reads.push(id); return history; },
  };
  const store = {
    read: () => structuredClone(state),
    readSession: id => structuredClone(state.sessions.find(session => session.id === id)),
    update() { assert.fail('Viewing a child conversation must not write product state'); },
  };
  const compat = new Compat(store, driver);
  const params = { sessionId: 'parent-product', childSessionId: 'child-native' };
  return { state, reads, history, driver, params, compat, request: extra => compat.request(method, { ...params, ...extra }), rebind() { nativeParent = 'forked-parent'; } };
}

test('Compat validates the product parent and exact native child ownership without activating any session', async () => {
  const f = fixture();
  assert.deepEqual(await f.request(), { ...f.params, throughSeq: -1, hasMore: false, events: [] });
  assert.deepEqual(f.reads, ['child-native']);
  await assert.rejects(f.request({ sessionId: 'missing-parent' }), /Session not found/);
  assert.equal(f.reads.length, 1, 'Unknown parents must fail before reading native history');
  for (const patch of [{ origin: undefined }, { parentSession: 'other-parent' }, { id: 'other-child' }]) {
    const original = { ...f.history.meta };
    Object.assign(f.history.meta, patch);
    await assert.rejects(f.request(), /does not belong/);
    f.history.meta = original;
  }
  const read = f.driver.history;
  f.driver.history = async id => { const value = await read(id); f.rebind(); return value; };
  await assert.rejects(f.request(), /changed during inspection/);
});

test('only public child-owned messages and actual terminal facts cross the bridge', async () => {
  const events = [
    event(0, 'user/message', user('inherited', 'PRIVATE_INHERITED')),
    event(1, 'assistant/message', { turn: 0, step: 0, message: assistant('inherited-answer', 'PRIVATE_PARENT') }),
    event(2, 'request/header', { headers: { Authorization: 'PRIVATE_REQUEST' }, system: 'PRIVATE_SYSTEM' }),
    event(3, 'user/message', { ...user('task', 'Inspect the module'), replayState: 'PRIVATE_USER_METADATA' }),
    event(4, 'user/message', user('injected', 'PRIVATE_AGENT_INSTRUCTIONS', 'agent-instructions')),
    event(5, 'turn/start', { turn: 1, request: 'PRIVATE_TURN' }),
    event(6, 'assistant/message', { turn: 1, step: 1, stream: 'PRIVATE_STREAM', message: {
      ...assistant('answer', 'Reading the file'),
      content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: 'Reading the file', provider: 'PRIVATE_BLOCK' },
        { type: 'tool-call', id: 'read-1', name: 'read', arguments: '{"file_path":"example.mjs"}', replayState: 'PRIVATE_CALL' }],
    } }),
    event(7, 'tool/call', { turn: 1, step: 1, callId: 'read-1', name: 'read', arguments: '{"file_path":"example.mjs"}', config: 'PRIVATE_CONFIG' }),
    event(8, 'tool/result', { turn: 1, step: 1, meta: { token: 'PRIVATE_TOOL_META' }, message: {
      id: 'result-1', role: 'tool', source: { kind: 'tool', provider: 'PRIVATE_SOURCE' }, toolCallId: 'read-1', isError: true,
      content: [{ type: 'text', text: 'The file is absent' }],
    }, error: { name: 'FsError', code: 'ENOENT', reason: 'The file is absent', headers: 'PRIVATE_ERROR' } }),
    event(9, 'system/message', { content: 'PRIVATE_SYSTEM_MESSAGE' }),
    event(10, 'turn/end', { turn: 1, reason: { kind: 'aborted', provider: 'PRIVATE_TERMINAL' }, request: 'PRIVATE_END' }),
  ];
  const f = fixture(events, 2), before = JSON.stringify(f.history);
  const result = await f.request();
  assert.deepEqual(result.events.map(item => item.seq), [3, 5, 6, 7, 8, 10]);
  assert.equal(result.throughSeq, 10);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.events.find(item => item.type === 'user/message').data, { id: 'task', role: 'user', content: [{ type: 'text', text: 'Inspect the module' }] });
  const call = result.events.find(item => item.type === 'tool/call').data;
  const response = result.events.find(item => item.type === 'tool/result').data;
  assert.equal(call.callId, response.message.toolCallId);
  assert.equal(response.message.isError, true);
  assert.equal(response.error.code, 'ENOENT');
  assert.deepEqual(result.events.at(-1).data, { reason: { kind: 'aborted' }, turn: 1 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.equal(JSON.stringify(f.history), before, 'Projection must not mutate the native history');
});

test('cursor batches are bounded, repeatable and advance over nonpublic events without replaying them', async () => {
  const events = Array.from({ length: 720 }, (_, seq) => seq < 550
    ? event(seq, 'request/context', { apiKey: 'PRIVATE_CONTEXT' })
    : event(seq, 'assistant/message', { turn: 1, step: seq, message: assistant(`message-${seq}`, `visible ${seq}`) }));
  const f = fixture(events);
  const first = await f.request();
  assert.equal(first.events.length, 0);
  assert.equal(first.hasMore, true);
  assert.ok(first.throughSeq < 550);
  assert.deepEqual(await f.request(), first);
  const all = [];
  let current = first, previous = -1;
  while (current.hasMore) {
    assert.ok(current.throughSeq > previous);
    previous = current.throughSeq;
    current = await f.request({ afterSeq: current.throughSeq });
    assert.ok(current.events.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(current)) <= 256 * 1024);
    all.push(...current.events);
  }
  assert.deepEqual(all.map(item => item.seq), Array.from({ length: 170 }, (_, index) => 550 + index));
  assert.deepEqual(await f.request({ afterSeq: current.throughSeq }), { ...f.params, throughSeq: 719, hasMore: false, events: [] });
  await assert.rejects(f.request({ afterSeq: 720 }), /ahead/);
  for (const afterSeq of [-2, 0.5, '1', NaN, null]) await assert.rejects(f.request({ afterSeq }), /afterSeq/);
});

test('large display payloads are explicitly clipped and cannot grow a response beyond the batch budget', async () => {
  const f = fixture(Array.from({ length: 20 }, (_, seq) => event(seq, 'assistant/message', { turn: 1, step: seq, message: {
    ...assistant(`large-${seq}`, ''), content: Array.from({ length: 80 }, () => ({ type: 'text', text: 'large result '.repeat(6000) })),
  } })));
  const result = await f.request();
  assert.equal(result.hasMore, true);
  assert.ok(result.events.every(item => item.truncated === true));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024);
  assert.ok(result.events[0].data.message.content[0].text.length < 10_000);
});

test('terminal errors and interrupted committed text remain observable while opaque metadata stays private', async () => {
  const f = fixture([
    event(0, 'assistant/message', { turn: 1, step: 1, interrupted: true, message: assistant('partial', 'Completed the first read') }),
    event(1, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'Connection closed', code: 'TRANSPORT', headers: 'PRIVATE_HEADERS' } } }),
  ]);
  const result = await f.request();
  assert.equal(result.events[0].data.interrupted, true);
  assert.deepEqual(result.events[1].data.reason, { kind: 'error', error: { code: 'TRANSPORT', message: 'Connection closed' } });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  f.history.inheritedEventCount = undefined;
  await assert.rejects(f.request(), /boundary/);
});

test('safe attachment descriptions omit file paths, bearer URLs and unrecognized content blocks', async () => {
  const f = fixture([event(0, 'user/message', {
    ...user('attachment-task', ''), content: [
      { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 10, width: 2, height: 3, name: 'view.png', path: 'PRIVATE_PATH', url: 'PRIVATE_URL' } },
      { type: 'file', attachment: { attachmentId: 'file-1', bytes: 5, name: 'notes.txt', request: 'PRIVATE_ATTACHMENT_REQUEST' } },
      { type: 'tool-addition', tool: { token: 'PRIVATE_TOOL_SCHEMA' } },
    ],
  })]);
  const result = await readSubagentConversation(f.state.sessions[0], f.params, f.driver);
  assert.equal(result.events[0].data.content.length, 2);
  assert.equal(result.events[0].data.content[0].attachment.mediaType, 'image/png');
  assert.equal(result.events[0].data.content[1].attachment.name, 'notes.txt');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});
