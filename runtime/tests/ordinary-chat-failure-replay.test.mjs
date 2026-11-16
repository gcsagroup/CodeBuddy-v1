import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, glob } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createCompatServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { Compat } from '../compat.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';

async function client(app) {
  const ws = new WebSocket((await app.listen()).replace('http:', 'ws:') + '/acp?token=ordinary-test-secret');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let serial = 0;
  const pending = new Map(), wire = [];
  ws.on('message', bytes => {
    const message = JSON.parse(String(bytes)); wire.push(message);
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message); }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timed out: ' + method)); }, 20000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  return { ws, rpc, wire, terminals: () => wire.flatMap(m => {
    const d = m.params?.update?.status?.data; return d?.terminal_message_id ? [d] : [];
  }) };
}

test('native terminal inspection keeps the initiating input after a consumed steer and retains completed tools', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-native-steer-terminal-'));
  let driver, requests = 0, effects = 0;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const endpoint = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); if (replyToNoActionReview(body, res)) return;
    if (!body.stream) return res.end(JSON.stringify({ choices: [{ message: { content: 'Isolated steer' } }] }));
    if (++requests > 1) return res.writeHead(401, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'PRIVATE_NATIVE_FAILURE' } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ tool_calls: [{ index: 0, id: 'effect-once', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] }, null], [{}, 'tool_calls']])
      res.write('data: ' + JSON.stringify({ id: 'steer', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release.resolve(); await driver?.close(); endpoint.closeAllConnections(); await new Promise(r => endpoint.close(r)); });
  driver = await createHarnessDriver({ dataDir: path.join(root, 'harness'), cwd: root });
  const { sessionId } = await driver.createSession({ cwd: root, provider: { id: 'steer', baseUrl: `http://127.0.0.1:${endpoint.address().port}`, apiKey: 'synthetic' },
    model: 'fixture', options: { tools: [{ name: 'fixture_effect', description: 'One completed synthetic action', inputSchema: { type: 'object', properties: {} },
      async execute() { effects++; entered.resolve(); await release.promise; return { completed: true }; } }] } });
  const running = driver.prompt(sessionId, 'Do the synthetic action', { requestId: 'initial', onPermission: () => true }).then(() => assert.fail('Expected native auth failure'), e => e);
  await entered.promise;
  const steering = driver.steer(sessionId, 'Then report existing work', { requestId: 'steer' });
  release.resolve(); await steering;
  assert.equal((await running).code, 'AUTH');
  const facts = await driver.userTurnTerminals(sessionId);
  assert.equal(facts.length, 1); assert.equal(facts[0].sourceId, 'initial');
  assert.deepEqual(facts[0].sourceIds, ['initial', 'steer']);
  const original = await driver.exportSessionLog(sessionId);
  await driver.close(); driver = await createHarnessDriver({ dataDir: path.join(root, 'harness'), cwd: root });
  assert.deepEqual(await driver.userTurnTerminals(sessionId), facts, 'Cold readonly inspection must agree with live native facts');
  assert.equal(requests, 2); assert.equal(effects, 1);
  assert.equal(await driver.exportSessionLog(sessionId), original);
});

test('ordinary native failures survive cold load, including legacy history, without inference or tool replay', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-ordinary-failure-')), dataDir = path.join(root, 'data');
  const privateText = 'PRIVATE_RAW_PROVIDER_PATH_AND_TOKEN';
  let mode = 'auth', requests = 0, app, c;
  const endpoint = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture', context_window: 65536 }] }));
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    if (!body.stream) return res.end(JSON.stringify({ choices: [{ message: { content: 'Isolated failure' } }] }));
    requests++;
    if (mode === 'auth') return res.writeHead(401, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { code: 'invalid_api_key', message: privateText } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'ordinary', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    emit({ content: 'Existing work remains intact. No tools were called.' });
    emit({}, mode === 'limit' ? 'length' : 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const connect = async () => { app = await createCompatServer({ dataDir, secret: 'ordinary-test-secret' }); c = await client(app); };
  const close = async () => { c.ws.terminate(); await app.close(); };
  t.after(async () => { c?.ws.terminate(); await app?.close(); endpoint.closeAllConnections(); await new Promise(r => endpoint.close(r)); });
  await connect();
  const added = await c.rpc('_goose/unstable/providers/custom/create', { engine: 'openai_compatible', displayName: 'Isolated ordinary',
    apiUrl: `http://127.0.0.1:${endpoint.address().port}`, models: ['fixture'], requiresAuth: false, supportsStreaming: true });
  assert.ok(added.result?.providerId);
  await c.rpc('_goose/unstable/defaults/save', { providerId: added.result.providerId, modelId: 'fixture' });
  const { sessionId } = (await c.rpc('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: [] } })).result;
  const prompt = (text, source) => c.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }],
    _meta: { 'codeagentpro/source-message-id': source } });
  assert.ok((await prompt('First isolated request', 'first')).error);
  assert.equal(c.terminals().at(-1).diagnostic.code, 'AUTH');
  assert.equal(c.terminals().at(-1).source_user_message_id, 'first');
  assert.equal(JSON.stringify(c.wire).includes(privateText), false);
  await close(); await connect();
  const sent = requests;
  for (let i = 0; i < 3; i++) {
    c.wire.length = 0;
    assert.ok((await c.rpc('session/load', { sessionId })).result);
    assert.deepEqual(c.terminals().map(d => [d.terminal_message_id, d.diagnostic.code]), [['failed:first', 'AUTH']]);
  }
  assert.equal(requests, sent, 'Cold/repeated load must not call a model');
  mode = 'success'; assert.equal((await prompt('Continue by reporting only', 'second')).result.stopReason, 'end_turn');
  mode = 'auth'; assert.ok((await prompt('Another isolated request', 'third')).error);
  await close();
  // Reproduce an older ordinary-chat projection: native failures exist, but no
  // failure cards were saved by that version. Never edit the native journal.
  const store = await openStore(dataDir);
  await store.updateSession(sessionId, s => { s.usageUpdates = s.usageUpdates.filter(u => !u.status?.data?.terminal_message_id); });
  const files = []; for await (const f of glob(path.join(dataDir, 'harness/sessions/**', sessionId, 'session.v4.jsonl').replaceAll('\\', '/'))) files.push(f);
  assert.equal(files.length, 1);
  const original = await readFile(files[0], 'utf8');
  assert.ok(original.includes(privateText), 'Private raw evidence is retained locally');
  await connect(); c.wire.length = 0;
  const beforeLegacyLoad = requests;
  assert.ok((await c.rpc('session/load', { sessionId })).result);
  assert.deepEqual(c.terminals().map(d => [d.source_user_message_id, d.diagnostic.code]), [['first', 'AUTH'], ['third', 'AUTH']]);
  assert.equal(JSON.stringify(c.wire).includes(privateText), false);
  assert.equal(requests, beforeLegacyLoad);
  assert.ok((await readFile(files[0], 'utf8')).startsWith(original), 'Recovery must preserve the complete native prefix');
  // Native output-limit recovery already owns this outcome. Reopening must not
  // invent a new failed terminal for a stopReason=max_tokens result.
  mode = 'limit';
  assert.equal((await prompt('Report within the remaining output budget', 'limited')).result.stopReason, 'max_tokens');
  c.wire.length = 0; const beforeLimitLoad = requests;
  await c.rpc('session/load', { sessionId });
  assert.equal(c.terminals().some(d => d.source_user_message_id === 'limited'), false);
  assert.equal(requests, beforeLimitLoad);
  const after = await readFile(files[0], 'utf8'); assert.ok(after.startsWith(original));
  assert.equal(after.split('\n').filter(Boolean).map(JSON.parse).filter(e => e.type === 'tool/call').length, 0);
});

test('ordinary replay stays idempotent across steering, inspection failure and a newer active input', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-ordinary-race-')), dataDir = path.join(root, 'data');
  const store = await openStore(dataDir);
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', models: ['fixture'], requiresAuth: false, headers: {} }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
  });
  let executions = 0, inspection, finishPrompt;
  const terminals = [{ sourceId: 'initial', sourceIds: ['initial', 'steer'], time: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'PRIVATE_INSPECTION' } } }];
  const driver = { permissions: permissionDriver(), async createSession() {}, async listTools() { return []; },
    async userTurnTerminals() { if (inspection) await inspection(); return terminals; },
    async prompt(_id, _content, options) { executions++; await new Promise(resolve => { finishPrompt = resolve; });
      await options.onEvent({ type: 'text_delta', text: 'New successful response' }); return { stopReason: 'end_turn', reason: { kind: 'completed' } }; },
    async close() {}, async cancel() {},
  };
  let app = await createCompatServer({ dataDir, secret: 'ordinary-test-secret', driver }), c = await client(app);
  t.after(async () => { finishPrompt?.(); c.ws.terminate(); await app.close(); });
  const { sessionId } = (await c.rpc('session/new', { cwd: root, mcpServers: [] })).result;
  const user = id => ({ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text: id } });
  // Seed only a legacy display transcript. Native terminal facts are supplied by
  // the driver boundary, with both human messages in one native turn.
  c.ws.terminate(); await app.close();
  await (await openStore(dataDir)).updateSession(sessionId, s => {
    s.updates = [user('initial'), { sessionUpdate: 'tool_call', toolCallId: 'one' }, user('steer'), { sessionUpdate: 'tool_call', toolCallId: 'two' }];
    s.usageUpdates = []; s.updatedAt = new Date().toISOString();
  });
  app = await createCompatServer({ dataDir, secret: 'ordinary-test-secret', driver }); c = await client(app);
  assert.ok((await c.rpc('session/load', { sessionId })).result);
  assert.equal(c.terminals().length, 1); assert.equal(c.terminals()[0].source_user_message_id, 'initial');
  assert.equal(c.terminals()[0].tool_action_count, 2);
  inspection = () => { throw Error('PRIVATE_INSPECTION'); };
  c.wire.length = 0;
  assert.ok((await c.rpc('session/load', { sessionId })).result, 'An optional inspection cannot hide readable history');
  assert.ok(c.wire.some(m => m.params?.update?.messageId === 'initial'));
  assert.equal(c.terminals().length, 0);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  inspection = async () => { entered.resolve(); await release.promise; };
  const loading = c.rpc('session/load', { sessionId }); await entered.promise;
  const prompting = c.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'A newer request' }], _meta: { 'codeagentpro/source-message-id': 'new' } });
  while (!finishPrompt) await new Promise(resolve => setTimeout(resolve, 5));
  c.wire.length = 0; release.resolve();
  assert.ok((await loading).result);
  assert.equal(c.terminals().length, 0, 'Old diagnosis must not settle the newer active input');
  assert.equal(executions, 1, 'Only the explicit prompt can execute');
  finishPrompt(); assert.equal((await prompting).result.stopReason, 'end_turn');
  const enteredAgain = Promise.withResolvers(), releaseAgain = Promise.withResolvers();
  inspection = async () => { enteredAgain.resolve(); await releaseAgain.promise; };
  finishPrompt = undefined;
  const loadingAgain = c.rpc('session/load', { sessionId }); await enteredAgain.promise;
  const newerPrompt = c.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Finish before inspection returns' }],
    _meta: { 'codeagentpro/source-message-id': 'newer' } });
  while (!finishPrompt) await new Promise(resolve => setTimeout(resolve, 5));
  finishPrompt(); assert.equal((await newerPrompt).result.stopReason, 'end_turn');
  c.wire.length = 0; releaseAgain.resolve(); assert.ok((await loadingAgain).result);
  assert.equal(c.terminals().length, 0, 'An ended newer input also invalidates the older read');
  inspection = undefined; c.wire.length = 0; await c.rpc('session/load', { sessionId });
  assert.equal(c.terminals().length, 1); assert.equal(c.terminals()[0].source_user_message_id, 'initial');
  assert.equal(JSON.stringify(c.wire).includes('PRIVATE_INSPECTION'), false);
});

for (const inspection of ['userTurnTerminals', 'lastUserStop']) test(`readable history survives a stalled ${inspection} without late projection`, { timeout: 5000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-stalled-inspection-'));
  const store = await openStore(root);
  await store.update(s => {
    s.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', models: ['fixture'], requiresAuth: false }];
    s.defaults = { providerId: 'fixture', modelId: 'fixture' };
  });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0, inspectionSignal;
  const driver = { permissions: permissionDriver(), async createSession() {}, async listTools() { return []; }, async close() {}, async cancel() {},
    async prompt() { calls++; throw Object.assign(Error('PRIVATE_SAVED_AUTH'), { code: 'AUTH' }); },
  };
  const compat = new Compat(store, driver); await compat.initialize();
  t.after(async () => { release.resolve(); t.mock.timers.reset(); await compat.close(); });
  const wire = [], connection = { notify(_method, value) { wire.push(value); }, async ask() {} };
  const { sessionId } = await compat.request('session/new', { cwd: root, mcpServers: [] }, connection);
  await compat.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Saved history' }] }, connection).catch(() => {});
  if (inspection === 'lastUserStop') await store.updateSession(sessionId, s => { s.usageUpdates = []; });
  driver[inspection] = async (...args) => {
    inspectionSignal = args.at(-1)?.signal; entered.resolve(); await release.promise;
    return inspection === 'lastUserStop' ? 1 : [{ sourceId: 'old', time: 1, reason: { kind: 'error', error: { code: 'AUTH' } } }];
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wire.length = 0;
  const loading = compat.request('session/load', { sessionId }, connection);
  await entered.promise; t.mock.timers.tick(5000);
  const completed = await Promise.race([loading.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
  assert.equal(completed, true, 'Optional diagnostics must not hide saved history indefinitely');
  assert.equal(inspectionSignal.aborted, true, 'Only the readonly inspection should receive cancellation');
  assert.ok(wire.some(x => x.update?.sessionUpdate === 'user_message_chunk'));
  assert.equal(wire.filter(x => x.update?.status?.data?.terminal_message_id).length, inspection === 'lastUserStop' ? 0 : 1);
  const snapshot = structuredClone(wire);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(wire, snapshot, 'A late diagnostic must not publish into the loaded session');
  assert.equal(calls, 1); assert.equal(JSON.stringify(wire).includes('PRIVATE_'), false);
});

for (const phase of ['before-native-end', 'driver-cleanup', 'compat-cleanup', 'recovered-error', 'child-error']) test(`ordinary stop ordering: ${phase}`, async t => {
  const late = ['driver-cleanup', 'compat-cleanup'].includes(phase);
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-terminal-stop-race-'));
  const store = await openStore(root);
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
  });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const driver = { permissions: permissionDriver(), async createSession() {}, async listTools() { return []; }, async close() {}, async cancel() {},
    async prompt(id, _text, { signal, onEvent }) {
      if (phase === 'recovered-error' || phase === 'child-error') {
        await onEvent({ type: 'harness_event', sessionId: phase === 'child-error' ? 'another-child' : id,
          event: { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'error', error: {
            code: phase === 'child-error' ? 'AUTH' : 'CONTEXT_WINDOW_EXCEEDED', message: 'PRIVATE_RECOVERED_ERROR',
          } } } } });
        await onEvent({ type: 'harness_event', sessionId: id, event: { type: 'turn/start', time: Date.now(), data: { turn: 2 } } });
      }
      if (phase === 'driver-cleanup') {
        await onEvent({ type: 'harness_event', sessionId: id, event: { type: 'turn/start', time: Date.now(), data: { turn: 1 } } });
        await onEvent({ type: 'harness_event', sessionId: id, event: { type: 'turn/end', time: Date.now(),
          data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'PRIVATE_NATIVE_AUTH' } } } } });
        entered.resolve(); await release.promise;
      }
      if (late) throw Object.assign(Error('PRIVATE_NATIVE_AUTH'), { code: 'AUTH' });
      entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(Error('PRIVATE_ABORTED'), { code: 'ABORTED' });
    } };
  const compat = new Compat(store, driver); await compat.initialize();
  t.after(async () => { release.resolve(); await compat.close(); });
  const connection = { notify() {}, async ask() {} };
  const { sessionId } = await compat.request('session/new', { cwd: root, mcpServers: [] }, connection);
  if (phase === 'compat-cleanup') {
    const begin = compat.desktop.begin.bind(compat.desktop);
    compat.desktop.begin = (...args) => {
      const turn = begin(...args);
      return { ...turn, async end() { entered.resolve(); await release.promise; await turn.end(); } };
    };
  }
  const running = compat.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Isolated stop ordering' }] }, connection)
    .then(result => result, error => error);
  await entered.promise;
  await compat.request('session/cancel', { sessionId }, connection); release.resolve();
  assert.equal((await running).stopReason, 'cancelled', 'Keep the existing explicit-cancel RPC contract');
  const terminal = store.readSession(sessionId).usageUpdates.filter(u => u.status?.data?.terminal_message_id).map(u => u.status.data);
  assert.equal(terminal.length, 1); assert.equal(terminal[0].status, late ? 'failed' : 'cancelled');
  assert.equal(terminal[0].diagnostic?.code, late ? 'AUTH' : undefined);
  assert.equal(JSON.stringify(terminal).includes('PRIVATE_'), false);
  driver.userTurnTerminals = async () => { throw Error('PRIVATE_INSPECTION'); };
  const replayed = [];
  await compat.request('session/load', { sessionId }, { ...connection, notify(_method, data) { replayed.push(data); } });
  const recovered = replayed.flatMap(d => d.update?.status?.data?.terminal_message_id ? [d.update.status.data] : []);
  assert.equal(recovered.length, 1); assert.equal(recovered[0].status, terminal[0].status);
  assert.equal(JSON.stringify(replayed).includes('PRIVATE_'), false);
});

test('real native AUTH remains visible when stop arrives while driver event cleanup is still pending', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-native-auth-stop-'));
  let requests = 0, compat;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const endpoint = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); if (replyToNoActionReview(body, res)) return;
    requests++; res.writeHead(401, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'PRIVATE_NATIVE_AUTH' } }));
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release.resolve(); await compat?.close(); endpoint.closeAllConnections(); await new Promise(r => endpoint.close(r)); });
  const store = await openStore(path.join(root, 'data'));
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${endpoint.address().port}`, models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
  });
  const native = await createHarnessDriver({ dataDir: path.join(root, 'native'), cwd: root });
  const prompt = native.prompt.bind(native);
  native.prompt = (id, content, options) => prompt(id, content, { ...options, async onEvent(event) {
    await options.onEvent(event);
    if (event.type === 'harness_event' && event.event.type === 'turn/end' && event.event.data.reason.kind === 'error') {
      entered.resolve(); await release.promise;
    }
  } });
  compat = new Compat(store, createConversationDriver(native, store)); await compat.initialize();
  const connection = { notify() {}, async ask() {} };
  const { sessionId } = await compat.request('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: [] } }, connection);
  const running = compat.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Real isolated authentication failure' }] }, connection);
  await entered.promise;
  assert.equal((await native.history(sessionId)).events.filter(e => e.type === 'turn/end').at(-1).data.reason.error.code, 'AUTH');
  await compat.request('session/cancel', { sessionId }, connection); release.resolve();
  assert.equal((await running).stopReason, 'cancelled');
  const data = store.readSession(sessionId).usageUpdates.filter(u => u.status?.data?.terminal_message_id).map(u => u.status.data);
  assert.equal(data.length, 1); assert.equal(data[0].status, 'failed'); assert.equal(data[0].diagnostic.code, 'AUTH');
  assert.equal(requests, 1); assert.equal(JSON.stringify(data).includes('PRIVATE_'), false);
});
