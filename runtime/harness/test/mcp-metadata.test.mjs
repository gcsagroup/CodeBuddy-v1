import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../index.mjs';

test('shared MCP connection reads live metadata from the executing session only', async t => {
  const calls = [];
  let initializations = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (!('id' in message)) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') {
      initializations++;
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'metadata-fixture', version: '1' } };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: 'read', description: 'Read test metadata', inputSchema: { type: 'object', properties: {} } }] };
    } else if (message.method === 'tools/call') {
      calls.push(message.params);
      result = { content: [{ type: 'text', text: 'read' }] };
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported method' } })); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-live-metadata-'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const mcp = { serverName: 'metadata', transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp` };
  const session = async callback => (await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }, model: 'fixture', options: { mcpServers: [mcp], mcpRequestMetadata: callback } })).sessionId;
  let value = 'A';
  const a = await session(name => { assert.equal(name, 'metadata'); return { 'fixture/value': value }; });
  const b = await session(() => ({ 'fixture/value': 'B' }));
  const c = await session(undefined);
  const call = async id => assert.equal((await driver.callTool(id, 'mcp__metadata__read', {}, { onPermission: () => true })).isError, false);
  await call(a);
  await call(b);
  value = 'A-updated';
  await call(a);
  await call(c);
  assert.equal(initializations, 1, 'metadata changes must not reconnect a shared server');
  assert.deepEqual(calls.map(p => p._meta?.['fixture/value']), ['A', 'B', 'A-updated', undefined]);
  assert.ok(calls.every(p => !Object.hasOwn(p.arguments, '_meta')), 'host metadata is not a model argument');
});
