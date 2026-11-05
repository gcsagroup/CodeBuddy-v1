import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { createCompatServer } from '../server.mjs';

import { answerTitleRequest } from './fixtures/title-request.mjs';

async function connect(url, secret) {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let serial = 0;
  const pending = new Map();
  const notifications = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), waiter = pending.get(message.id);
    if (!waiter) { if (message.method) notifications.push(message); return; }
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('ACP closed')); }
    pending.clear();
  });
  return { notifications, close: () => socket.close(), request(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`ACP timed out: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  } };
}

test('role workspace survives a complete Compat and Harness restart with its original model and persona', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-role-integration-')));
  const requests = [];
  const notifications = [];
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixed' }, { id: 'other' }] }));
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (answerTitleRequest(body, res)) return;
    requests.push(body);
    assert.equal(notifications.filter(n => n.params.update?._meta?.['codebuddy/agent-input']).length, requests.length,
      'the client receives native admission before model output, including after restart');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'ROLE_INTEGRATION_OK' }, null], [{}, 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'role-integration', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  let host;
  t.after(async () => {
    await host?.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    assert.equal(path.dirname(root), await realpath(tmpdir()));
    assert.ok(path.basename(root).startsWith('codebuddy-role-integration-'));
    await rm(root, { recursive: true, force: true });
  });
  const start = async () => {
    const store = await openStore(path.join(root, 'data'));
    const native = await createHarnessDriver({ dataDir: path.join(root, 'native'), cwd: root });
    host = new Compat(store, createConversationDriver(native, store));
    await host.initialize();
    return store;
  };
  let store = await start();
  await store.update(state => {
    state.providers = [{ id: 'fixture', displayName: 'Fixture', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${model.address().port}`, models: ['fixed', 'other'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'other' };
  });
  const connection = { notify(method, params) { notifications.push({ method, params }); }, async ask() { throw new Error('No tool approval expected'); } };
  const request = (method, params) => host.request(method, params, connection);
  const catalog = await request('_codebuddy/agents/catalog', {});
  for (const name of ['read', 'write', 'subagent']) assert.ok(catalog.tools.some(tool => tool.name === name), `role catalog exposes ${name}`);
  const { profile } = await request('_codebuddy/agents/save', { profile: {
    name: 'Integration role', avatar: 'app-logo', providerId: 'fixture', modelId: 'fixed',
    prompt: 'ORIGINAL_ROLE_SENTINEL: Answer carefully.', skills: [], tools: [], mcpServers: [],
  } });
  const { sessionId } = await request('_codebuddy/agents/create-workspace', { id: profile.id });
  const cwd = store.readSession(sessionId).cwd;
  const prompt = () => request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply briefly.' }] });
  assert.equal((await prompt()).stopReason, 'end_turn');
  await request('_codebuddy/agents/save', { profile: { ...profile, prompt: 'REPLACEMENT_ROLE_SENTINEL', modelId: 'other' } });
  await request('_codebuddy/agents/delete', { id: profile.id });
  await host.close(); host = undefined;
  store = await start();
  const lease = await request('_goose/unstable/workspace/lease/acquire', { requestedPath: cwd, expectedState: (await readdir(cwd)).length ? 'non-empty-directory' : 'empty-directory', expectedIdentity: workspaceIdentity(cwd) });
  const loaded = await request('session/load', { sessionId, cwd, mcpServers: [], _meta: { workspaceLeaseId: lease.leaseId } });
  assert.ok(loaded.configOptions.some(option => option.id === 'model'));
  assert.equal((await prompt()).stopReason, 'end_turn');
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(body.model, 'other');
    assert.match(JSON.stringify(body.messages), /ORIGINAL_ROLE_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(body.messages), /REPLACEMENT_ROLE_SENTINEL/);
    assert.equal(body.tools?.length ?? 0, 0);
  }
  assert.match(JSON.stringify(notifications), /ROLE_INTEGRATION_OK/);
  assert.equal(store.readSession(sessionId).agentProfile.revision, 1);
});

test('the actual server forwards native role queries and restores an adopted choice without generating', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-role-server-')));
  const requests = [];
  let beforeOutput = async () => {};
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (answerTitleRequest(body, res)) return;
    requests.push(body);
    await beforeOutput();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'ROLE_SERVER_OK' }, null], [{}, 'stop']])
      res.write(`data: ${JSON.stringify({ id: 'role-server', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const dataDir = path.join(root, 'data'), secret = 'isolated-role-server-secret';
  const store = await openStore(dataDir);
  await store.update(state => {
    state.providers = [{ id: 'fixture', displayName: 'Fixture', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${model.address().port}`, models: ['fixture-model'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture-model' };
  });
  let app, client;
  t.after(async () => {
    client?.close(); await app?.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const start = async () => {
    app = await createCompatServer({ dataDir, secret });
    client = await connect(await app.listen(), secret);
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  };
  await start();
  const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [] });
  const { profile } = await client.request('_codebuddy/agents/save', { profile: {
    name: 'Server role', avatar: 'app-logo', providerId: '', modelId: '', prompt: 'SERVER_ROLE_LITERAL {{kept}}',
    capabilities: 'inherit', skills: [], tools: [], mcpServers: [],
  } });
  let result = await client.request('_codebuddy/agents/select', { sessionId, id: profile.id, expectedRevision: 0 });
  assert.equal(result.pending, true);
  beforeOutput = async () => {
    const current = await client.request('_codebuddy/agents/current', { sessionId });
    assert.equal(current.pending, false, 'native adoption is readable while the model response is still unfinished');
    assert.equal(current.effective.id, profile.id);
    assert.ok(client.notifications.some(n => n.method === 'session/update' && n.params.sessionId === sessionId
      && n.params.update._meta?.['codebuddy/agent-input']), 'the actual WebSocket carries the admission invalidation before output');
  };
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply briefly.' }] });
  beforeOutput = async () => {};
  result = await client.request('_codebuddy/agents/current', { sessionId });
  assert.equal(result.effective.id, profile.id);
  assert.equal(result.pending, false);
  assert.match(JSON.stringify(requests.at(-1).messages), /SERVER_ROLE_LITERAL \{\{kept\}\}/);
  client.close(); client = undefined; await app.close(); app = undefined;
  await start();
  const count = requests.length;
  result = await client.request('_codebuddy/agents/current', { sessionId });
  assert.equal(result.effective.id, profile.id);
  assert.equal(result.pending, false);
  assert.equal(requests.length, count, 'cold role queries cannot generate another model request');
  result = await client.request('_codebuddy/agents/select', { sessionId, id: null, expectedRevision: 1 });
  assert.equal(result.effective.id, profile.id);
  assert.equal(result.pending, true);
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Continue briefly.' }] });
  result = await client.request('_codebuddy/agents/current', { sessionId });
  assert.equal(result.effective, null);
  assert.equal(result.pending, false);
  const { presets } = await client.request('_codebuddy/agents/list');
  const builtin = presets.find(item => item.key === 'frontend-developer').profile;
  await client.request('_codebuddy/agents/select', { sessionId, id: builtin.id, expectedRevision: 2 });
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Continue briefly with the selected built-in role.' }] });
  assert.match(JSON.stringify(requests.at(-1).messages), /你是一位前端开发工程师/);
  assert.equal(requests.at(-1).model, 'fixture-model');
  assert.deepEqual((await client.request('_codebuddy/agents/list')).profiles.map(p => p.id), [profile.id]);
});
