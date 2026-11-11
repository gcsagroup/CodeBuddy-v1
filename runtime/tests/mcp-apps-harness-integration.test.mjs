import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from '../../ui/node_modules/esbuild/lib/main.js';
import { createCompatServer } from '../server.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import { zReadResourceResponse_unstable, zGooseToolCallResponse_unstable, zAppsListResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

const secret = 'mcp-apps-controlled-acp-fixture', ext = name => `_goose/unstable/${name}`;
async function connect(url) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let count = 0, approval = 'allow_once'; const pending = new Map(), notifications = [];
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data)), item = pending.get(msg.id);
    if (item) { clearTimeout(item.timer); pending.delete(msg.id); msg.error ? item.reject(Error(msg.error.message)) : item.resolve(msg.result); return; }
    notifications.push(msg);
    if (msg.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: approval } } }));
  });
  return { notifications, setApproval: value => { approval = value; }, close: () => ws.close(), request(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++count, timer = setTimeout(() => { pending.delete(id); reject(Error(`ACP timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }); } };
}

// This fixture performs many separate native Keychain operations; retain the
// 20-second deadline on each ACP request while allowing the complete workflow.
test('frozen MCP Apps UI consumers read/call/import/export through ACP and official Harness with metadata and restart durability', { timeout: process.platform === 'darwin' ? 180_000 : 60_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-app-acp-')), calls = [], failures = [], resourceUri = 'ui://chart/view';
  const hiddenMeta = { chartControls: { active: 'y' } }, resourceMeta = { ui: { csp: { connectDomains: ['https://api.example.test'] } } };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let raw = ''; for await (const chunk of req) raw += chunk; const msg = JSON.parse(raw);
      if (req.url === '/mcp') {
        if (!('id' in msg)) { res.writeHead(202).end(); return; } calls.push(msg); let result;
        if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'chart', version: '1' } };
        else if (msg.method === 'tools/list') result = { tools: [{ name: 'view', description: 'Render a chart', inputSchema: { type: 'object', properties: { fail: { type: 'boolean' } } }, _meta: { ui: { resourceUri } } }] };
        else if (msg.method === 'tools/call') result = msg.params.arguments.fail ? { isError: true, content: [{ type: 'text', text: 'Controlled MCP tool failure' }] } : { content: [{ type: 'text', text: 'chart result' }], structuredContent: { rows: [1, 2] }, _meta: hiddenMeta };
        else if (msg.method === 'resources/list') result = { resources: [{ uri: resourceUri, name: 'Fixture chart', mimeType: 'text/html;profile=mcp-app' }] };
        else if (msg.method === 'resources/read') result = { contents: [{ uri: msg.params.uri, text: '<html><body>中文图表</body></html>', mimeType: 'text/html;profile=mcp-app', _meta: resourceMeta }] };
        else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Fixture uses MCP 2025 protocol' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); return;
      }
      if (replyToNoActionReview(msg, res)) return;
      if (!msg.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: msg.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (!msg.messages.some(item => item.role === 'tool')) { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'chart-call', type: 'function', function: { name: 'mcp__chart__view', arguments: '{}' } }] }); chunk({}, 'tool_calls'); }
      else { chunk({ role: 'assistant', content: 'Chart shown.' }); chunk({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app = await createCompatServer({ dataDir: path.join(root, 'data'), secret }), client = await connect(await app.listen());
  t.after(async () => { client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const provider = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'MCP Apps Fixture', apiUrl: `http://127.0.0.1:${server.address().port}`, requiresAuth: false, models: ['fixture'], supportsStreaming: true, headers: {} });
  await client.request(ext('defaults/save'), { providerId: provider.providerId, modelId: 'fixture' });
  const session = await client.request('session/new', { cwd: root, mcpServers: [{ name: 'chart', type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [] }], _meta: { enabledExtensions: ['chart'] } });
  const sessionId = session.sessionId, key = `mcpAppFixture${Date.now()}`;
  globalThis[key] = { goose: Object.fromEntries(Object.entries({ appsList_unstable: 'apps/list', appsExport_unstable: 'apps/export', appsImport_unstable: 'apps/import', appsDelete_unstable: 'apps/delete', resourcesRead_unstable: 'resources/read', toolsCall_unstable: 'tools/call', toolsList_unstable: 'tools/list' }).map(([name, method]) => [name, params => client.request(ext(method), params)])) };
  t.after(() => { delete globalThis[key]; });
  const bundle = async (file, plugins = []) => {
    const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, plugins });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  };
  const ui = await bundle('../../ui/desktop/src/acp/mcp-apps.ts', [{ name: 'fixture-transport', setup(builder) {
    builder.onResolve({ filter: /^\.\/acpConnection$/ }, () => ({ path: 'acp', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getAcpClient=async()=>globalThis[${JSON.stringify(key)}]`, loader: 'js' }));
  } }]);
  assert.equal((await ui.listMcpAppTools(sessionId, 'chart')).length, 1, JSON.stringify({ session, calls }));
  const usage = async () => (await client.request(ext('capability-usage/list'))).records.filter(r => r.kind === 'external' && r.capabilityId === 'chart');
  assert.deepEqual(await usage(), [], 'discovery does not count as execution');
  const direct = await ui.callMcpAppTool(sessionId, 'chart', 'view', {});
  zGooseToolCallResponse_unstable.parse(direct); assert.equal(direct.isError, false, JSON.stringify(direct)); assert.deepEqual(direct._meta, hiddenMeta); assert.deepEqual(direct.structuredContent, { rows: [1, 2] });
  assert.equal((await usage())[0]?.successCount, 1, 'a successful direct tool call updates external usage');
  assert.equal((await ui.callMcpAppTool(sessionId, 'chart', 'view', { fail: true })).isError, true);
  client.setApproval('reject_once');
  assert.equal((await ui.callMcpAppTool(sessionId, 'chart', 'view', {})).isError, true);
  client.setApproval('allow_once');
  assert.equal((await usage())[0]?.successCount, 1, 'tool failures and denied calls do not count');
  const resource = await ui.readMcpAppResource(sessionId, 'chart', resourceUri); assert.match(resource.text, /中文图表/); assert.deepEqual(resource._meta, resourceMeta);
  zReadResourceResponse_unstable.parse(await client.request(ext('resources/read'), { sessionId, extensionName: 'chart', uri: resourceUri }));
  await assert.rejects(ui.readMcpAppResource(sessionId, 'unselected', resourceUri), /not enabled/);
  assert.equal((await ui.listMcpAppTools(sessionId, 'chart')).length, 1);
  const discovered = await ui.listMcpApps(sessionId); assert.equal(discovered[0].name, 'Fixture chart'); assert.deepEqual(discovered[0]._meta, resourceMeta);
  await ui.importMcpApp('<html><head><script type="application/ld+json">{"name":"Local fixture"}</script></head><body>Local app</body></html>');
  assert.match(await ui.exportMcpApp('Local fixture'), /Local app/);
  const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Show the chart' }] }); assert.equal(result.stopReason, 'end_turn');
  assert.equal((await usage())[0]?.successCount, 2, 'the model path uses the same successful receipt');
  const original = await bundle('../../ui/desktop/src/acp/sessionNotificationAdapter.ts'), adapter = original.createAcpSessionNotificationAdapter();
  for (const msg of client.notifications.filter(msg => msg.method === 'session/update')) adapter.apply(msg.params);
  const responses = adapter.getMessages().flatMap(message => message.content).filter(content => content.type === 'toolResponse' && content.toolResult.status === 'success');
  assert.equal(responses.length, 2, 'direct UI and model calls both reach the renderer');
  for (const response of responses) {
    assert.equal(response.toolResult.status, 'success');
    assert.equal(response.toolResult.value._meta.ui.resourceUri, resourceUri);
    assert.equal(response.toolResult.value._meta.extensionName, 'chart');
    assert.deepEqual(response.toolResult.value.structuredContent, { rows: [1, 2] });
    assert.deepEqual(response.toolResult.value.content, [{ type: 'text', text: 'chart result' }]);
  }
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1, 'resource and metadata retrieval reuse one selected connection');
  client.close(); await app.close(); app = await createCompatServer({ dataDir: path.join(root, 'data'), secret }); client = await connect(await app.listen());
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal((await usage())[0]?.successCount, 2, 'usage survives restart without replaying execution');
  const executedBeforeReplay = calls.filter(call => call.method === 'tools/call').length;
  await client.request('session/load', { sessionId, cwd: root, mcpServers: [] });
  const restored = original.createAcpSessionNotificationAdapter();
  for (const msg of client.notifications.filter(msg => msg.method === 'session/update')) restored.apply(msg.params);
  const restoredResponses = restored.getMessages().flatMap(message => message.content).filter(content => content.type === 'toolResponse');
  assert.equal(restoredResponses.length, 4, 'direct success, failure and denial survive alongside the model call');
  assert.equal(restoredResponses.filter(item => item.toolResult.status === 'error').length, 2);
  for (const item of restoredResponses.filter(item => item.toolResult.status === 'success')) {
    assert.equal(item.toolResult.value._meta.ui.resourceUri, resourceUri);
    assert.deepEqual(item.toolResult.value.structuredContent, { rows: [1, 2] });
  }
  assert.equal(calls.filter(call => call.method === 'tools/call').length, executedBeforeReplay, 'history replay never calls a tool again');
  const cached = zAppsListResponse_unstable.parse(await client.request(ext('apps/list'), {}));
  assert.equal(cached.apps.length, 2); assert.equal(calls.filter(call => call.method === 'initialize').length, 1, 'offline app cache does not start MCP on restart');
  await ui.deleteMcpApp('Local fixture'); assert.equal((await ui.listMcpApps()).length, 1);
  assert.deepEqual(failures, []);
});
