import test from 'node:test';
import assert from 'node:assert/strict';
import { Compat } from '../compat.mjs';
import { readSubagentConversation } from '../subagent-conversations.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';

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
    async nativeHistory(id) { reads.push(id); return history; },
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
  const read = f.driver.nativeHistory;
  f.driver.nativeHistory = async id => { const value = await read(id); f.rebind(); return value; };
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

function catalogFixture() {
  const state = { sessions: [{ id: 'parent-product', nativeSessionId: 'parent-native', type: 'code_pro', updates: [] }] };
  const calls = [];
  const histories = new Map([
    ['child-native', { meta: { id: 'child-native', origin: 'subagent', parentSession: 'parent-native' }, inheritedEventCount: 0, events: [] }],
    ['grandchild', { meta: { id: 'grandchild', origin: 'subagent', parentSession: 'child-native', token: 'PRIVATE_HEADER' }, inheritedEventCount: 1, events: [
      event(0, 'assistant/message', { message: assistant('inherited', 'PRIVATE_INHERITED') }),
      event(1, 'user/message', user('task', 'Read the nested child')),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ] }],
  ]);
  const catalogs = new Map([
    ['parent-native', [
      { id: 'child-native', createdAt: 1792060000000, mode: 'continuable', label: 'Inspect module', provider: 'PRIVATE_PROVIDER', request: 'PRIVATE_REQUEST' },
      { id: 'external-child', createdAt: 1792060000001, mode: 'external', label: 'External task' },
      { id: 'old-child', createdAt: 1792060000002, mode: 'one-shot' },
      { id: 'unknown-child', createdAt: 1792060000003, mode: 'unknown' },
    ]],
    ['child-native', [{ id: 'grandchild', createdAt: 1792060000004, mode: 'continuable', label: 'Nested review' }]],
  ]);
  const rawDriver = {
    async history(id) {
      calls.push(['history', id]);
      const value = histories.get(id);
      if (!value) throw new Error('Native child history is unavailable');
      return value;
    },
    async listSubagentChildren(id, signal) {
      calls.push(['catalog', id]);
      assert.equal(signal, undefined);
      if (!catalogs.has(id)) throw new Error('Native catalog is unavailable');
      return catalogs.get(id);
    },
  };
  const store = {
    read: () => structuredClone(state),
    readSession: id => structuredClone(state.sessions.find(session => session.id === id)),
    update() { assert.fail('Catalog inspection must not write product state'); },
  };
  const driver = createConversationDriver(rawDriver, store), compat = new Compat(store, driver);
  return {
    state, calls, histories, catalogs, rawDriver, driver,
    catalog: extra => compat.request('_goose/unstable/subagent/catalog/list', { sessionId: 'parent-product', ...extra }),
    conversation: extra => compat.request(method, { sessionId: 'parent-product', childSessionId: 'grandchild', ...extra }),
  };
}

test('catalog reads native membership in order through the product mapping and exposes only public fields', async () => {
  const f = catalogFixture(), before = JSON.stringify([...f.catalogs]);
  const root = await f.catalog();
  assert.deepEqual(root, {
    sessionId: 'parent-product', ancestorSessionIds: [], children: [
      { id: 'child-native', createdAt: 1792060000000, mode: 'continuable', label: 'Inspect module' },
      { id: 'external-child', createdAt: 1792060000001, mode: 'external', label: 'External task' },
      { id: 'old-child', createdAt: 1792060000002, mode: 'one-shot' },
      { id: 'unknown-child', createdAt: 1792060000003, mode: 'unknown' },
    ],
  });
  assert.deepEqual(f.calls, [['catalog', 'parent-native']]);
  assert.deepEqual(await f.catalog(), root, 'Repeated viewing must preserve the same catalog');
  assert.doesNotMatch(JSON.stringify(root), /PRIVATE_|running|activity/);
  assert.equal(JSON.stringify([...f.catalogs]), before);
  await assert.rejects(f.catalog({ sessionId: 'missing' }), /Session not found/);
  f.catalogs.set('parent-native', []);
  assert.deepEqual((await f.catalog()).children, [], 'A successful empty native catalog stays empty');
});

test('nested catalog and conversation reads validate every direct-parent edge without activation', async () => {
  const f = catalogFixture(), path = ['child-native'];
  const nested = await f.catalog({ ancestorSessionIds: path });
  assert.deepEqual(nested, { sessionId: 'parent-product', ancestorSessionIds: path, children: [
    { id: 'grandchild', createdAt: 1792060000004, mode: 'continuable', label: 'Nested review' },
  ] });
  assert.deepEqual(f.calls, [['catalog', 'parent-native'], ['history', 'child-native'], ['catalog', 'child-native']]);
  f.calls.length = 0;
  const page = await f.conversation({ ancestorSessionIds: path });
  assert.deepEqual(f.calls, [['catalog', 'parent-native'], ['history', 'child-native'], ['catalog', 'child-native'], ['history', 'grandchild']]);
  assert.deepEqual(page.ancestorSessionIds, path);
  assert.deepEqual(page.events.map(item => item.seq), [1, 2]);
  assert.deepEqual(page.events.at(-1).data.reason, { kind: 'completed' });
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_/);
  assert.deepEqual(await f.conversation({ ancestorSessionIds: path, afterSeq: 2 }), {
    sessionId: 'parent-product', childSessionId: 'grandchild', ancestorSessionIds: path,
    throughSeq: 2, hasMore: false, events: [],
  });
  await assert.rejects(f.conversation(), /does not belong/, 'A grandchild is never accepted as a direct child');
  const direct = await f.conversation({ childSessionId: 'child-native' });
  assert.equal(Object.hasOwn(direct, 'ancestorSessionIds'), false, 'Legacy direct responses retain their shape');
  assert.deepEqual((await f.conversation({ childSessionId: 'child-native', ancestorSessionIds: [] })).ancestorSessionIds, []);
});

test('unrelated, forged, skipped and cyclic descendant paths fail before exposing a catalog or transcript', async () => {
  const f = catalogFixture();
  for (const patch of [{ id: 'forged' }, { origin: undefined }, { parentSession: 'unrelated' }]) {
    const original = { ...f.histories.get('child-native').meta };
    Object.assign(f.histories.get('child-native').meta, patch);
    f.calls.length = 0;
    await assert.rejects(f.catalog({ ancestorSessionIds: ['child-native'] }), /does not belong/);
    await assert.rejects(f.conversation({ ancestorSessionIds: ['child-native'] }), /does not belong/);
    assert.ok(f.calls.every(([kind, id]) => (kind === 'history' && id === 'child-native') || (kind === 'catalog' && id === 'parent-native')));
    f.histories.get('child-native').meta = original;
  }
  await assert.rejects(f.catalog({ ancestorSessionIds: ['grandchild'] }), /does not belong/);
  await assert.rejects(f.conversation({ ancestorSessionIds: ['grandchild', 'child-native'] }), /does not belong/);
  for (const path of [['child-native', 'child-native'], ['parent-native'], ['parent-product']]) {
    f.calls.length = 0;
    await assert.rejects(f.catalog({ ancestorSessionIds: path }), /cycle/);
    assert.deepEqual(f.calls, []);
  }
  await assert.rejects(f.conversation({ ancestorSessionIds: ['child-native'], childSessionId: 'child-native' }), /cycle/);
  for (const childSessionId of ['parent-native', 'parent-product'])
    await assert.rejects(f.conversation({ childSessionId }), /cycle/);
});

test('ancestor input limits and unavailable native catalog data fail explicitly without fabricated empty results', async () => {
  const f = catalogFixture();
  for (const path of [null, 'child-native', {}, [null], [''], ['x'.repeat(257)], Array.from({ length: 33 }, (_, i) => `child-${i}`)]) {
    f.calls.length = 0;
    await assert.rejects(f.catalog({ ancestorSessionIds: path }));
    await assert.rejects(f.conversation({ ancestorSessionIds: path }));
    assert.deepEqual(f.calls, []);
  }
  await assert.rejects(f.catalog({ ancestorSessionIds: ['external-child'] }), /catalog mode/);
  await assert.rejects(f.conversation({ childSessionId: 'external-child' }), /history is unavailable/);
  await assert.rejects(f.conversation({ childSessionId: 'external-child', ancestorSessionIds: [] }), /catalog mode/);
  const original = f.catalogs.get('parent-native');
  for (const entries of [undefined, [{ id: 'bad', mode: 'continuable', createdAt: 1 }],
    [{ id: 'bad', mode: 'future-mode', createdAt: 1 }], [{ id: 'bad', mode: 'one-shot', createdAt: -1 }]]) {
    f.catalogs.set('parent-native', entries);
    await assert.rejects(f.catalog(), /catalog.*unavailable/);
  }
  f.catalogs.set('parent-native', original);
  f.rawDriver.listSubagentChildren = async () => { throw new Error('Native catalog read failed'); };
  await assert.rejects(f.catalog(), /Native catalog read failed/);
});

test('rebinding the product root during an ancestor or catalog read rejects stale results', async () => {
  const ancestor = catalogFixture(), read = ancestor.rawDriver.history;
  ancestor.rawDriver.history = async id => {
    const value = await read(id);
    ancestor.state.sessions[0].nativeSessionId = 'new-parent';
    return value;
  };
  await assert.rejects(ancestor.catalog({ ancestorSessionIds: ['child-native'] }), /changed during inspection/);
  assert.deepEqual(ancestor.calls, [['catalog', 'parent-native'], ['history', 'child-native']]);

  const catalog = catalogFixture(), list = catalog.rawDriver.listSubagentChildren;
  catalog.rawDriver.listSubagentChildren = async (...args) => {
    const value = await list(...args);
    catalog.state.sessions[0].nativeSessionId = 'new-parent';
    return value;
  };
  await assert.rejects(catalog.catalog(), /changed during inspection/);

  const transcript = catalogFixture(), history = transcript.rawDriver.history;
  transcript.rawDriver.history = async id => {
    const value = await history(id);
    if (id === 'grandchild') transcript.state.sessions[0].nativeSessionId = 'new-parent';
    return value;
  };
  await assert.rejects(transcript.conversation({ ancestorSessionIds: ['child-native'] }), /changed during inspection/);
});

test('explicit paths honor native catalog membership even when metadata exists or was inherited from a fork', async () => {
  const f = catalogFixture();
  f.catalogs.set('parent-native', []);
  await assert.rejects(f.catalog({ ancestorSessionIds: ['child-native'] }), /conversation catalog/);
  assert.deepEqual(f.calls, [['catalog', 'parent-native']], 'Excluded fork membership never triggers a child read');
  await assert.rejects(f.conversation({ childSessionId: 'child-native', ancestorSessionIds: [] }), /conversation catalog/);
  assert.equal((await f.conversation({ childSessionId: 'child-native' })).childSessionId, 'child-native', 'Omitted paths keep the original direct metadata contract');

  const nested = catalogFixture();
  nested.catalogs.set('child-native', []);
  await assert.rejects(nested.conversation({ ancestorSessionIds: ['child-native'] }), /conversation catalog/);
  assert.ok(!nested.calls.some(([kind, id]) => kind === 'history' && id === 'grandchild'));
  for (const mode of ['external', 'unknown']) {
    const blocked = catalogFixture();
    blocked.catalogs.get('parent-native')[0].mode = mode;
    await assert.rejects(blocked.catalog({ ancestorSessionIds: ['child-native'] }), /catalog mode/);
    await assert.rejects(blocked.conversation({ childSessionId: 'child-native', ancestorSessionIds: [] }), /catalog mode/);
    assert.ok(blocked.calls.every(([kind]) => kind === 'catalog'), 'Nonlocal or unknown modes cannot be crossed through valid-looking metadata');
  }
  const historical = catalogFixture();
  historical.catalogs.get('parent-native')[0].mode = 'one-shot';
  assert.equal((await historical.catalog({ ancestorSessionIds: ['child-native'] })).children[0].id, 'grandchild');
});

test('native child browsing never follows product aliases with the same id as a native address', async () => {
  const f = catalogFixture();
  f.state.sessions.push(
    { id: 'parent-native', nativeSessionId: 'unrelated-root' },
    { id: 'child-native', nativeSessionId: 'unrelated-child' },
    { id: 'grandchild', nativeSessionId: 'unrelated-grandchild' },
  );
  assert.equal((await f.catalog()).children[0].id, 'child-native');
  assert.equal((await f.catalog({ ancestorSessionIds: ['child-native'] })).children[0].id, 'grandchild');
  const page = await f.conversation({ ancestorSessionIds: ['child-native'] });
  assert.equal(page.childSessionId, 'grandchild');
  assert.deepEqual(page.events.map(item => item.seq), [1, 2]);
  assert.ok(f.calls.every(([, id]) => !id.startsWith('unrelated-')));
  await assert.rejects(f.driver.history('child-native'), /history is unavailable/, 'Existing product history still honors its product alias');
  assert.deepEqual(f.calls.at(-1), ['history', 'unrelated-child']);
});
