import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCompatServer } from '../server.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { openStore } from '../store.mjs';

async function sessionFiles(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = join(prefix, entry.name), file = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await sessionFiles(file, name));
    else result[name] = await readFile(file, 'utf8');
  }
  return result;
}

test('default lazy server exposes cold native catalogs without models, tools or session writes', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-subagent-catalog-lazy-'));
  const dataDir = join(root, 'product'), nativeRoot = randomUUID(), productRoot = randomUUID();
  const secret = 'isolated-native-catalog-lazy-fixture';
  let modelRequests = 0;
  const model = createServer((_req, res) => { modelRequests++; res.writeHead(500); res.end('No model request expected'); });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });

  // Seed a real persisted blank Session, then inspect it through a separate Host.
  // No injected driver is passed to createCompatServer: its lazy whitelist is exercised.
  const native = await createHarnessDriver({ dataDir: join(dataDir, 'harness'), cwd: root });
  try {
    await native.createSession({ sessionId: nativeRoot, cwd: root, model: 'catalog-fixture',
      provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'isolated-fixture' } });
  } finally { await native.close(); }
  const store = await openStore(dataDir);
  await store.update(state => state.sessions.push({
    id: productRoot, nativeSessionId: nativeRoot, title: 'Catalog fixture', type: 'user', cwd: root,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    updates: [], usageUpdates: [], messageCount: 0,
  }));
  const beforeNative = await sessionFiles(join(dataDir, 'harness', 'sessions'));
  assert.ok(Object.keys(beforeNative).length > 0);
  const app = await createCompatServer({ dataDir, secret });
  t.after(() => app.close());
  const url = await app.listen();
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const receive = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id !== id) return;
      socket.removeEventListener('message', receive);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    };
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const beforeProduct = await readFile(join(dataDir, 'state.json'), 'utf8');
  const method = '_goose/unstable/subagent/catalog/list';
  const expected = { sessionId: productRoot, ancestorSessionIds: [], children: [] };
  assert.deepEqual(await request(method, { sessionId: productRoot }), expected);
  assert.deepEqual(await request(method, { sessionId: productRoot, ancestorSessionIds: [] }), expected);
  assert.equal(modelRequests, 0);
  assert.equal(await readFile(join(dataDir, 'state.json'), 'utf8'), beforeProduct);
  assert.deepEqual(await sessionFiles(join(dataDir, 'harness', 'sessions')), beforeNative);
});
