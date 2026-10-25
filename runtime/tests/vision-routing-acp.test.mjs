import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from '../../ui/node_modules/esbuild/lib/main.js';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { zCodeProModelRoutingReadResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

const require = createRequire(new URL('../harness/package.json', import.meta.url)), sharp = require('sharp');
const secret = 'vision-controlled-fixture', ext = name => `_goose/unstable/${name}`;
async function connect(url) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`), notifications = [], pending = new Map(); let seq = 0;
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data)), item = pending.get(message.id);
    if (!item) {
      notifications.push(message);
      if (message.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
      return;
    }
    pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);
  });
  return { notifications, close: () => ws.close(), request(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }); } };
}

test('ACP vision settings reach official image model while frozen renderer and restarted history keep original images', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-vision-acp-'))), requests = [], errors = [], slowStarted = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    try {
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: ['main', 'vision', 'slow'].map(id => ({ id, input_modalities: id === 'main' ? ['text'] : ['text', 'image'] })) })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk; const request = JSON.parse(raw);
      if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); return; }
      requests.push(request); res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'vision-fixture', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (request.model === 'slow') { emit({ role: 'assistant', content: 'partial observation' }); slowStarted.resolve(); return; }
      emit({ role: 'assistant', content: request.model === 'vision' ? 'The attached image shows a blue square.' : 'The image contains a blue square.' }); emit({}, 'stop'); res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app = await createCompatServer({ dataDir: path.join(root, 'data'), secret }), client = await connect(await app.listen());
  t.after(async () => { client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { providerId } = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Vision fixture', apiUrl: `http://127.0.0.1:${server.address().port}`, requiresAuth: false, models: ['main', 'vision', 'slow'], headers: {}, supportsStreaming: true });
  await client.request(ext('defaults/save'), { providerId, modelId: 'main' });
  const config = { version: 2, advancedRoutingEnabled: false, routes: [], maxParallelCoders: 1, visionRoute: { enabled: true, mode: 'auto', providerId, modelId: 'vision' } };
  await client.request(ext('codepro/model-routing/save'), { config });
  zCodeProModelRoutingReadResponse_unstable.parse(await client.request(ext('codepro/model-routing/read')));
  await client.request(ext('model-capabilities/save'), { config: { version: 1, overrides: [{ providerId, modelId: 'main', imageInput: 'force_unsupported' }, ...['vision', 'slow'].map(modelId => ({ providerId, modelId, imageInput: 'force_supported' }))] } });
  const cwd = path.join(root, 'workspace');
  const lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const { sessionId } = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, enabledExtensions: [] } });
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const image = { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, prompt = [image];
  assert.equal((await client.request('session/prompt', { sessionId, prompt })).stopReason, 'end_turn');
  const imageStages = client.notifications.filter(item => item.method === '_goose/unstable/session/update' && item.params.update?.sessionUpdate === 'status_message')
    .map(item => item.params.update.status).filter(status => /识别图片|图片识别完成/.test(status.message));
  assert.equal(imageStages.length, 2);
  assert.match(imageStages[0].message, /正在识别图片/);
  assert.match(imageStages[1].message, /图片识别完成/);
  assert.deepEqual(requests.map(request => request.model), ['vision', 'main']);
  assert.equal(requests[0].tools?.length ?? 0, 0); assert.match(JSON.stringify(requests[0].messages), /image_url/);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /image_url/); assert.match(JSON.stringify(requests[1].messages), /Untrusted auxiliary image observation/);
  const output = await build({ entryPoints: [fileURLToPath(new URL('../../ui/desktop/src/acp/sessionNotificationAdapter.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { createAcpSessionNotificationAdapter } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`), adapter = createAcpSessionNotificationAdapter();
  for (const item of client.notifications.filter(item => item.method === 'session/update')) adapter.apply(item.params);
  assert.deepEqual(adapter.getMessages().find(message => message.role === 'user').content.find(part => part.type === 'image'), image);
  assert.equal(adapter.getMessages().some(message => JSON.stringify(message).includes('Untrusted auxiliary image observation')), false);
  client.close(); await app.close(); app = await createCompatServer({ dataDir: path.join(root, 'data'), secret }); client = await connect(await app.listen());
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const exported = JSON.parse((await client.request(ext('session/export'), { sessionId })).data);
  assert.deepEqual(exported.conversation.find(message => message.role === 'user').content.find(part => part.type === 'image'), image);
  const restoredLease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: (await readdir(cwd)).length ? 'non-empty-directory' : 'empty-directory', expectedIdentity: workspaceIdentity(cwd) });
  await client.request('session/load', { sessionId, cwd, mcpServers: [], _meta: { workspaceLeaseId: restoredLease.leaseId } });
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Continue briefly.' }] });
  assert.deepEqual(requests.map(request => request.model), ['vision', 'main', 'main']); assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /image_url/);

  await client.request(ext('codepro/model-routing/save'), { config: { ...config, visionRoute: { ...config.visionRoute, modelId: 'slow' } } });
  const running = client.request('session/prompt', { sessionId, prompt }); await slowStarted.promise;
  await assert.rejects(client.request(ext('providers/custom/delete'), { providerId }), /active/i);
  await client.request('session/cancel', { sessionId }); assert.equal((await running).stopReason, 'cancelled');
  assert.equal(requests.at(-1).model, 'slow', 'cancelled partial observation must never launch the main model');
});

test('ACP computer screenshot uses saved auxiliary settings; renderer retains original image and tool status', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-tool-vision-acp-'))), requests = [], calls = [];
  const image = { type: 'image', mimeType: 'image/png', data: (await sharp({ create: { width: 20, height: 20, channels: 3, background: 'blue' } }).png().toBuffer()).toString('base64') };
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: ['main', 'vision'].map(id => ({ id, input_modalities: id === 'vision' ? ['text', 'image'] : ['text'] })) })); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const c of req) raw += c; const m = JSON.parse(raw);
    if (req.url === '/mcp') {
      if (!('id' in m)) { res.writeHead(202).end(); return; }
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'screen', version: '1' } };
      else if (m.method === 'tools/list') result = { tools: [{ name: 'observe', description: 'Observe test screen', inputSchema: { type: 'object', properties: {} } }] };
      else if (m.method === 'tools/call') { calls.push(m); result = { content: [{ type: 'text', text: 'window=test; observation=current' }, image] }; }
      else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unsupported fixture method' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); return;
    }
    if (!m.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
    requests.push(m); res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'screenshot', object: 'chat.completion.chunk', model: m.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (m.model === 'vision') { emit({ role: 'assistant', content: 'BLUE_RECTANGLE_VISIBLE' }); emit({}, 'stop'); }
    else if (!m.messages.some(x => x.role === 'tool')) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'observe', type: 'function', function: { name: 'mcp__qwen_computer__observe', arguments: '{}' } }] }); emit({}, 'tool_calls'); }
    else { emit({ role: 'assistant', content: 'Observed blue rectangle' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const app = await createCompatServer({ dataDir: path.join(root, 'data'), secret }), client = await connect(await app.listen());
  t.after(async () => { client.close(); await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { providerId } = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Vision fixture', apiUrl: `http://127.0.0.1:${server.address().port}`, requiresAuth: false, models: ['main', 'vision'], headers: {}, supportsStreaming: true });
  await client.request(ext('defaults/save'), { providerId, modelId: 'main' });
  await client.request(ext('codepro/model-routing/save'), { config: { version: 2, advancedRoutingEnabled: false, routes: [], maxParallelCoders: 1, visionRoute: { enabled: true, mode: 'auto', providerId, modelId: 'vision' } } });
  await client.request(ext('model-capabilities/save'), { config: { version: 1, overrides: [{ providerId, modelId: 'main', imageInput: 'force_unsupported' }, { providerId, modelId: 'vision', imageInput: 'force_supported' }] } });
  const mcpServers = [{ name: 'qwen_computer', type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [] }];
  const { sessionId } = await client.request('session/new', { cwd: root, mcpServers, _meta: { enabledExtensions: ['qwen_computer'] } });
  assert.equal((await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Observe the current screen' }] })).stopReason, 'end_turn');
  assert.deepEqual(requests.map(r => r.model), ['main', 'vision', 'main']);
  assert.equal(requests[1].tools?.length ?? 0, 0); assert.match(JSON.stringify(requests[1].messages), /image_url/);
  assert.match(JSON.stringify(requests[2].messages), /BLUE_RECTANGLE_VISIBLE/); assert.doesNotMatch(JSON.stringify(requests[2].messages), /image_url/);
  assert.equal(calls.length, 1);
  const output = await build({ entryPoints: [fileURLToPath(new URL('../../ui/desktop/src/acp/sessionNotificationAdapter.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { createAcpSessionNotificationAdapter } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`), adapter = createAcpSessionNotificationAdapter();
  for (const n of client.notifications.filter(n => n.method === 'session/update')) adapter.apply(n.params);
  const response = adapter.getMessages().flatMap(m => m.content).find(c => c.type === 'toolResponse');
  assert.equal(response.toolResult.status, 'success'); assert.ok(JSON.stringify(adapter.getMessages()).includes(image.data), JSON.stringify(adapter.getMessages()).slice(-6000));
  await client.request(ext('codepro/model-routing/save'), { config: { version: 2, advancedRoutingEnabled: false, routes: [], maxParallelCoders: 1, visionRoute: { enabled: false, mode: 'auto' } } });
  const unavailable = await client.request('session/new', { cwd: root, mcpServers, _meta: { enabledExtensions: ['qwen_computer'] } });
  await assert.rejects(client.request('session/prompt', { sessionId: unavailable.sessionId, prompt: [{ type: 'text', text: 'Observe the current screen' }] }), /电脑控制已停止/);
  assert.equal(requests.length, 4, 'ACP must report the vision failure before another model request');
  assert.equal(calls.length, 2, 'an executed observation must not be replayed after losing vision');
});
