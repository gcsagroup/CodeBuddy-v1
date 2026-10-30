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

test('role workspace survives a complete Compat and Harness restart with its original model and persona', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-role-integration-')));
  const requests = [];
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fixed' }, { id: 'other' }] }));
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
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
  const notifications = [];
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
  assert.deepEqual(loaded.configOptions, []);
  assert.equal((await prompt()).stopReason, 'end_turn');
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(body.model, 'fixed');
    assert.match(JSON.stringify(body.messages), /ORIGINAL_ROLE_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(body.messages), /REPLACEMENT_ROLE_SENTINEL/);
    assert.equal(body.tools?.length ?? 0, 0);
  }
  assert.match(JSON.stringify(notifications), /ROLE_INTEGRATION_OK/);
  assert.equal(store.readSession(sessionId).agentProfile.revision, 1);
});
