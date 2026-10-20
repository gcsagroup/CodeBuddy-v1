import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCompatServer } from '../server.mjs';
import { statefulMcp, until } from '../harness/test/fixtures/stateful-mcp.mjs';

const secret = 'mcp-session-recovery-local-fixture', ext = name => `_goose/unstable/${name}`;
async function connect(url) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let sequence = 0;
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data)), entry = pending.get(msg.id);
    if (entry) { clearTimeout(entry.timer); pending.delete(msg.id); msg.error ? entry.reject(Error(msg.error.message)) : entry.resolve(msg.result); }
    else if (msg.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
  });
  return { close: () => ws.close(), request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`ACP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  } };
}

test('desktop ACP settings disable/enable and delete/re-add renew the same remote MCP configuration', { timeout: 60000 }, async t => {
  const remote = await statefulMcp(t);
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-mcp-session-acp-'));
  const app = await createCompatServer({ dataDir: path.join(root, 'data'), secret });
  const client = await connect(await app.listen());
  t.after(async () => { client.close(); await app.close(); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const provider = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Recovery Fixture', apiUrl: remote.baseUrl, requiresAuth: false, models: ['fixture'], supportsStreaming: true, headers: {} });
  await client.request(ext('defaults/save'), { providerId: provider.providerId, modelId: 'fixture' });
  const extension = { type: 'mcp', server: { name: 'Hex', type: 'http', url: `${remote.baseUrl}/mcp`, headers: [] }, available_tools: [] };
  await client.request(ext('config/extensions/add'), { extension, enabled: true });
  const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: ['Hex'] } });
  const list = () => client.request(ext('tools/list'), { sessionId });
  const call = () => client.request(ext('tools/call'), { sessionId, name: 'mcp__Hex__health', arguments: {} });
  await list(); assert.equal((await call()).isError, false);
  const firstId = remote.wire.at(-1).sessionId;
  // Toggle without any intervening chat turn: no configureSession([]) is
  // delivered, so this specifically exercises settings-to-preset invalidation.
  await client.request(ext('config/extensions/set-enabled'), { configKey: 'hex', enabled: false });
  await client.request(ext('config/extensions/set-enabled'), { configKey: 'hex', enabled: true });
  assert.equal((await call()).isError, false);
  assert.notEqual(remote.wire.at(-1).sessionId, firstId);
  const secondId = remote.wire.at(-1).sessionId;
  await client.request(ext('config/extensions/remove'), { configKey: 'hex' });
  await client.request(ext('config/extensions/add'), { extension, enabled: true });
  assert.equal((await call()).isError, false);
  assert.notEqual(remote.wire.at(-1).sessionId, secondId);
  const initialized = remote.initializations();
  await list(); await list(); assert.equal(remote.initializations(), initialized, 'ordinary listing keeps a healthy connection warm');
  remote.expire();
  assert.equal((await call()).isError, true);
  await until(() => remote.initializations() === initialized + 1 && remote.wire.at(-1).method === 'tools/list');
  assert.equal((await call()).isError, false);
  const beforeSelectionChange = remote.wire.at(-1).sessionId;
  await client.request(ext('session/extensions/remove'), { sessionId, name: 'Hex' });
  await client.request(ext('session/extensions/add'), { sessionId, extension });
  assert.equal((await call()).isError, false);
  assert.notEqual(remote.wire.at(-1).sessionId, beforeSelectionChange);
  assert.ok(remote.wire.filter(x => x.method === 'initialize').every(x => x.sessionId === undefined));
});
