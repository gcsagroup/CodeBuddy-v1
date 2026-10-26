import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createCompatServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';

async function clientFor(url, secret) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/acp?token=' + secret);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const pending = new Map();
  let id = 0;
  ws.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(Error(message.error.message));
    else waiter.resolve(message.result);
  });
  ws.on('close', () => {
    for (const waiter of pending.values()) waiter.resolve({ disconnected: true });
    pending.clear();
  });
  return { ws, request(method, params = {}) {
    const key = ++id, waiter = Promise.withResolvers();
    pending.set(key, waiter);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }));
    return waiter.promise;
  } };
}

test('shutdown rejects reconnects while native cleanup is still running', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-shutdown-'));
  const server = await createCompatServer({ dataDir: directory, secret: 'isolated-shutdown-fixture', driver: {
    async close() { entered.resolve(); await release.promise; },
  } });
  const url = await server.listen(0, '127.0.0.1');
  const closing = server.close();
  await entered.promise;
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/acp?token=isolated-shutdown-fixture');
  let opened;
  try {
    opened = await new Promise(resolve => { ws.once('open', () => resolve(true)); ws.once('error', () => resolve(false)); });
  } finally { ws.terminate(); release.resolve(); await closing; }
  assert.equal(opened, false, 'the desktop reconnect loop must not keep a closing runtime alive');
});

for (const realHarness of [false, true])
test(`confirmed update cancels an active conversation and preserves partial history (native Harness: ${realHarness})`, { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), cancelled = Promise.withResolvers(), saved = Promise.withResolvers();
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-active-update-'));
  const secret = 'isolated-active-update-fixture';
  const model = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (raw && JSON.parse(raw).stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'update-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: '更新前已生成的内容' }, finish_reason: null }] })}\n\n`);
      res.once('close', () => cancelled.resolve());
      entered.resolve();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'fixture' }] }
      : { choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => { model.closeAllConnections(); model.close(); });
  let closed = false;
  const driver = {
    permissions: permissionDriver(),
    async createSession({ sessionId }) { return { sessionId }; },
    async prompt(_id, _content, options) {
      await options.onEvent({ type: 'text_delta', text: '更新前已生成的内容' });
      entered.resolve();
      if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      cancelled.resolve();
      await saved.promise;
      return { stopReason: 'cancelled' };
    },
    async cancel() {},
    async close() { closed = true; },
  };
  const server = await createCompatServer({ dataDir: directory, secret, ...(realHarness ? {} : { driver }) });
  const url = await server.listen(0);
  t.after(async () => { saved.resolve(); await server.close(); });
  const client = await clientFor(url, secret);
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { providerId } = await client.request('_goose/unstable/providers/custom/create', {
    engine: 'openai_compatible', displayName: 'Shutdown fixture', apiUrl: `http://127.0.0.1:${model.address().port}`,
    requiresAuth: false, models: ['fixture'], supportsStreaming: true, headers: {},
  });
  await client.request('_goose/unstable/defaults/save', { providerId, modelId: 'fixture' });
  const { sessionId } = await client.request('session/new', { cwd: directory, mcpServers: [] });
  const visible = Promise.withResolvers();
  client.ws.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    if (message.params?.update?.content?.text === '更新前已生成的内容') visible.resolve();
  });
  const prompting = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '保存这次任务要求' }] });
  await entered.promise;
  await visible.promise;
  assert.equal(await server.closeForUpdate(), false, 'unconfirmed calls remain idle-only');
  let finished = false;
  const updating = server.closeForUpdate({ stopTasks: true }).then(value => { finished = true; return value; });
  await cancelled.promise;
  if (!realHarness) {
    assert.equal(finished, false);
    assert.equal(closed, false);
    assert.equal((await fetch(url + '/health', { headers: { 'x-secret-key': secret } })).status, 503);
  }
  saved.resolve();
  assert.equal(await updating, true);
  await prompting;
  const reopened = await openStore(directory);
  const history = JSON.stringify(reopened.readSession(sessionId));
  assert.match(history, /保存这次任务要求/);
  assert.match(history, /更新前已生成的内容/);
  assert.equal(reopened.read(['defaults']).defaults.modelId, 'fixture');
  if (!realHarness) assert.equal(closed, true);
});

for (const failWrite of [false, true])
test(`update drains admitted settings writes and rejects failed saves (${failWrite})`, { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), finishWrite = Promise.withResolvers();
  const original = Compat.prototype.request;
  t.mock.method(Compat.prototype, 'request', async function(method, params, connection) {
    if (method !== 'fixture/delayed-settings') return original.call(this, method, params, connection);
    entered.resolve();
    await finishWrite.promise;
    if (failWrite) throw Error('settings persistence failed');
    await this.store.update(state => { state.config.savedDuringUpdate = true; });
    return {};
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-update-write-'));
  const secret = 'isolated-pending-write-fixture';
  const server = await createCompatServer({ dataDir: directory, secret, driver: { async close() {} } });
  t.after(async () => { finishWrite.resolve(); await server.close().catch(() => {}); });
  const client = await clientFor(await server.listen(0), secret);
  await client.request('initialize', { protocolVersion: 1 });
  const writing = client.request('fixture/delayed-settings');
  await entered.promise;
  let done = false;
  const updating = server.closeForUpdate({ stopTasks: true }).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(done, false);
  finishWrite.resolve();
  if (failWrite) await assert.rejects(updating, /settings persistence failed/);
  else await updating;
  await writing;
  assert.equal((await openStore(directory)).read().config.savedDuringUpdate, failWrite ? undefined : true);
});

test('shutdown failure never returns an installation acknowledgement', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-update-failure-'));
  const server = await createCompatServer({ dataDir: directory, secret: 'isolated-update-failure',
    driver: { async close() { throw Error('native persistence failed'); } } });
  await server.listen(0);
  await assert.rejects(server.closeForUpdate({ stopTasks: true }), /native persistence failed/);
});

test('idle update shutdown flushes and preserves conversations and configuration across restart', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-update-preserve-'));
  const store = await openStore(directory);
  await store.update(state => {
    state.preferences = { language: 'zh-CN', customValue: '配置保留' };
    state.config = { userSetting: '保持原样' };
    state.sessions.push({ id: 'preserved-history', title: '升级前的聊天', messages: [{ role: 'user', content: '不要丢失这条历史' }], readonlyHistory: true });
  });
  await store.flush();
  const driver = { async close() {} };
  const server = await createCompatServer({ dataDir: directory, secret: 'isolated-upgrade-fixture', driver });
  await server.listen(0, '127.0.0.1');
  assert.equal(await server.closeForUpdate(), true);
  const reopened = await openStore(directory);
  assert.equal(reopened.read().sessions.find(s => s.id === 'preserved-history').messages[0].content, '不要丢失这条历史');
  assert.deepEqual(reopened.read().preferences, { language: 'zh-CN', customValue: '配置保留' });
  assert.equal(reopened.read().config.userSetting, '保持原样');
  const restarted = await createCompatServer({ dataDir: directory, secret: 'isolated-upgrade-fixture', driver });
  await restarted.listen(0, '127.0.0.1');
  await restarted.close();
});
