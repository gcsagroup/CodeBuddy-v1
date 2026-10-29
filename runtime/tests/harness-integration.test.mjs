import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, readFile, access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createCompatServer } from '../server.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { zSessionNotification } from '../../ui/node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js';
import { zGooseToolCallResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';
import { workspaceIdentity } from '../workspaces.mjs';
import { statefulMcp } from '../harness/test/fixtures/stateful-mcp.mjs';
import { projectChatUpdates } from './helpers/renderer-projection.mjs';

const secret = 'harness-integration-loopback-only';
const ext = name => `_goose/unstable/${name}`;

async function connect(baseUrl) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const notifications = [];
  const waiters = new Set();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const task = pending.get(message.id);
    if (task) {
      pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) task.reject(Object.assign(new Error(message.error.message), message.error));
      else task.resolve(message.result);
    } else if (message.method) {
      notifications.push(message);
      for (const waiter of [...waiters]) if (waiter.match(message)) waiter.resolve(message);
    }
  });
  socket.addEventListener('close', () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('ACP connection closed')); }
    pending.clear();
  });
  return {
    notifications,
    request(method, params = {}) {
      const next = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(next); reject(new Error(`ACP ${method} timed out`)); }, 15000);
        pending.set(next, { resolve, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }));
      });
    },
    waitFor(match) {
      const existing = notifications.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: value => { clearTimeout(timer); waiters.delete(waiter); resolve(value); } };
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('Expected ACP notification timed out')); }, 10000);
        waiters.add(waiter);
      });
    },
    reply(id, result) { socket.send(JSON.stringify({ jsonrpc: '2.0', id, result })); },
    close() { socket.close(); },
  };
}

async function fixtureServer(root) {
  const requests = [];
  let bodylessResponses = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'bridge-model', inputModalities: ['text', 'image'] }, { id: 'bridge-model-two' }] }));
      return;
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    if (!request.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
      return;
    }
    const lastUser = request.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('bridge_fixture_'));
    const prompt = JSON.stringify(request.messages[lastUser]?.content) ?? '';
    if (prompt.includes('bridge_fixture_error')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'controlled bridge provider failure', type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'bridge-fixture-completion', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    if (prompt.includes('bridge_fixture_slow')) {
      emit({ role: 'assistant', content: 'bridge pending' });
      const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 30000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    const toolFinished = request.messages.slice(lastUser + 1).some(message => message.role === 'tool' && message.tool_call_id === 'bridge-call-write');
    if (prompt.includes('bridge_fixture_image') && !request.tools.some(t => t.function.name === 'read_image')) {
      emit({ tool_calls: [{ index: 0, id: 'discover-image', type: 'function', function: { name: 'search_mcp_tools', arguments: JSON.stringify({ names: ['read_image'] }) } }] });
      emit({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    if (prompt.includes('bridge_fixture_image') && !request.messages.slice(lastUser + 1).some(message => message.role === 'tool' && message.tool_call_id === 'bridge-call-image')) {
      emit({ tool_calls: [{ index: 0, id: 'bridge-call-image', type: 'function', function: { name: 'read_image', arguments: JSON.stringify({ file_path: path.join(root, 'image.png') }) } }] });
      emit({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    if (prompt.includes('bridge_fixture_write') && !request.tools.some(t => t.function.name === 'write')) {
      emit({tool_calls:[{index:0,id:'discover-write',type:'function',function:{name:'search_mcp_tools',arguments:JSON.stringify({names:['write']})}}]});
      emit({},'tool_calls');res.end('data: [DONE]\n\n');return;
    }
    if (prompt.includes('bridge_fixture_write') && !toolFinished) {
      emit({ role: 'assistant', content: 'Before the tool. ' });
      emit({ tool_calls: [{ index: 0, id: 'bridge-call-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: path.join(root, ...(prompt.includes('reasoning_stop') ? ['bodyless'] : []), prompt.includes('denied') ? 'denied.txt' : 'approved.txt'), content: 'actual Harness tool output\n' }) } }] });
      emit({}, 'tool_calls');
    } else if (prompt.includes('bridge_fixture_write_reasoning_stop') && bodylessResponses++ === 0) {
      emit({ reasoning: 'Unclosed reasoning with orphan channel endings <|close|>response<|sep|><|close|>message<|sep|>.' });
      emit({}, 'stop');
    } else {
      emit({ role: 'assistant', content: 'Harness bridge ' });
      emit({ content: 'complete.' });
      emit({}, 'stop', { prompt_tokens: 17, completion_tokens: 8, total_tokens: 25 });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('missing MCP credentials preserve normal chat and recover after configuration without reusing old tools', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-missing-mcp-')));
  const model = await fixtureServer(root), remote = await statefulMcp(t);
  const app = await createCompatServer({ dataDir: path.join(root, 'data'), secret });
  const client = await connect(await app.listen(0));
  t.after(async () => { client.close(); await app.close(); await model.close(); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const provider = await client.request(ext('providers/custom/create'), {
    engine: 'openai_compatible', displayName: 'Missing MCP fixture', apiUrl: model.url,
    requiresAuth: false, models: ['bridge-model'], supportsStreaming: true, headers: {},
  });
  await client.request(ext('defaults/save'), { providerId: provider.providerId, modelId: 'bridge-model' });
  const extension = { type: 'mcp', envKeys: ['CODEBUDDY_GITHUB_MCP_TOKEN'], server: {
    name: 'github_official', type: 'http', url: `${remote.baseUrl}/mcp`,
    headers: [{ name: 'Authorization', value: 'Bearer ${CODEBUDDY_GITHUB_MCP_TOKEN}' }],
  } };
  await client.request(ext('config/extensions/add'), { extension, enabled: true });
  const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: ['github_official'] } });
  const prompt = () => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '你好' }] });
  const load = () => client.request('session/load', { sessionId, cwd: root, mcpServers: [] });
  const expectedError = { name: 'github_official', success: false, error: 'Configure extension environment variable: CODEBUDDY_GITHUB_MCP_TOKEN' };
  assert.equal((await prompt()).stopReason, 'end_turn');
  assert.ok(client.notifications.some(msg => msg.params?.update?.content?.text === 'Harness bridge '));
  assert.deepEqual((await load())._meta.extensionResults, [expectedError]);
  assert.equal(remote.initializations(), 0, 'missing credentials must not reach the network');
  await client.request(ext('config/upsert'), { key: 'CODEBUDDY_GITHUB_MCP_TOKEN', value: 'isolated-fixture-token' });
  assert.equal((await prompt()).stopReason, 'end_turn');
  assert.deepEqual((await load())._meta.extensionResults, [{ name: 'github_official', success: true }]);
  assert.ok(remote.wire.some(item => item.authorization === 'Bearer isolated-fixture-token'));
  const count = remote.initializations();
  await client.request(ext('config/remove'), { key: 'CODEBUDDY_GITHUB_MCP_TOKEN' });
  assert.equal((await prompt()).stopReason, 'end_turn');
  assert.deepEqual((await load())._meta.extensionResults, [expectedError]);
  const tools = await client.request(ext('tools/list'), { sessionId });
  assert.ok(!tools.tools.some(tool => tool.name.startsWith('mcp__github_official__')));
  assert.equal(remote.initializations(), count);
});

test('ACP facade runs official Harness with permissions, cancellation and restart persistence', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-harness-acp-')));
  const dataDir = path.join(root, 'application-data');
  const model = await fixtureServer(root);
  // Deliberately no injected driver: this must use server.mjs -> official Harness.
  let app = await createCompatServer({ dataDir, secret });
  let client = await connect(await app.listen(0));
  t.after(async () => { client.close(); await app.close(); await model.close(); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const configured = await client.request(ext('providers/custom/create'), {
    engine: 'openai_compatible', displayName: 'Controlled Harness bridge fixture', apiUrl: model.url,
    requiresAuth: false, models: ['bridge-model', 'bridge-model-two'], supportsStreaming: true, headers: {},
  });
  await client.request(ext('defaults/save'), { providerId: configured.providerId, modelId: 'bridge-model' });
  await client.request(ext('tools/permissions/set'), { toolPermissions: [{ toolName: 'write', permission: 'ask_before' }] });
  const newSession = async () => (await client.request('session/new', { cwd: root, mcpServers: [] })).sessionId;
  const prompt = (sessionId, text) => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const updates = sessionId => client.notifications.filter(message => message.method === 'session/update' && message.params.sessionId === sessionId).map(message => message.params.update);
  const terminals = sessionId => client.notifications.filter(message => message.method === ext('session/update') && message.params.sessionId === sessionId).map(message => message.params.update.status?.data).filter(data => data?.terminal_message_id);
  const permission = async sessionId => {
    const first = await client.waitFor(message => message.method === 'session/request_permission' && message.params.sessionId === sessionId);
    if (first.params.toolCall.title !== 'search_mcp_tools') return first;
    client.reply(first.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
    return client.waitFor(message => message.method === 'session/request_permission' && message.params.sessionId === sessionId && message.params.toolCall.title === 'write');
  };
  let retainedSession;

  await t.test('ACP selection, load and another chat consume the native permission preset', async () => {
    const first = await newSession(), second = await newSession();
    await client.request('session/set_mode', { sessionId: first, modeId: 'read-only' });
    const loaded = await client.request('session/load', { sessionId: first, cwd: root, mcpServers: [] });
    assert.equal(loaded.modes.currentModeId, 'read-only');
    assert.deepEqual(loaded.modes.availableModes.map(mode => mode.id), ['read-only', 'workspace-write', 'danger-full-access']);
    assert.equal((await client.request('session/load', { sessionId: second, cwd: root, mcpServers: [] })).modes.currentModeId, 'workspace-write');
    assert.ok(updates(first).some(update => update.sessionUpdate === 'current_mode_update' && update.currentModeId === 'read-only'));
    await assert.rejects(client.request('session/set_mode', { sessionId: first, modeId: 'approve' }), /Unknown native/);
  });

  await t.test('the new-chat permission draft is committed natively before the first prompt', async () => {
    for (const preset of ['read-only', 'workspace-write', 'danger-full-access']) {
      const created = await client.request('session/new', { cwd: root, mcpServers: [], _meta: { initialPermissionPreset: preset } });
      assert.equal(created.modes.currentModeId, preset);
      assert.equal((await client.request('session/load', { sessionId: created.sessionId, cwd: root, mcpServers: [] })).modes.currentModeId, preset);
    }
    await assert.rejects(client.request('session/new', { cwd: root, mcpServers: [], _meta: { initialPermissionPreset: 'auto' } }), /Unknown native/);
  });

  await t.test('existing ACP content array reaches Harness; approval gates a real file tool', async () => {
    retainedSession = await newSession();
    const pending = prompt(retainedSession, 'bridge_fixture_write approved');
    const ask = await permission(retainedSession);
    assert.equal(ask.params.toolCall.title, 'write');
    assert.equal(ask.params.toolCall.rawInput.file_path, path.join(root, 'approved.txt'));
    await assert.rejects(access(path.join(root, 'approved.txt')), 'file must not exist before permission');
    client.reply(ask.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
    assert.equal((await pending).stopReason, 'end_turn');
    assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'actual Harness tool output\n');
    const live = updates(retainedSession);
    assert.ok(live.some(update => update.sessionUpdate === 'tool_call_update' && update.status === 'completed'));
    const text = live.filter(update => update.sessionUpdate === 'agent_message_chunk');
    assert.equal(text.map(update => update.content.text).join(''), 'Before the tool. Harness bridge complete.');
    assert.notEqual(text[0]._meta.goose.messageId, text.at(-1)._meta.goose.messageId, 'tool-separated model attempts need separate chat messages');
    assert.ok(model.requests.some(request => request.stream && request.tools.some(tool => tool.function.name === 'write')));
  });

  await t.test('native retry recovers a bodyless response without replaying the preceding file operation', async () => {
    const cwd = path.join(root, 'bodyless');
    const lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
    const { sessionId } = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } });
    const pending = prompt(sessionId, 'bridge_fixture_write_reasoning_stop approved');
    const ask = await permission(sessionId);
    client.reply(ask.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
    assert.equal((await pending).stopReason, 'end_turn');
    assert.equal(await readFile(path.join(cwd, 'approved.txt'), 'utf8'), 'actual Harness tool output\n');
    const live = updates(sessionId);
    const text = live.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text).join('');
    assert.equal(text, 'Before the tool. Harness bridge complete.', 'the actual retry supplies body text; reasoning is never reclassified');
    assert.match(live.filter(update => update.sessionUpdate === 'agent_thought_chunk').map(update => update.content.text).join(''), /<\|close\|>response/);
    const terminal = terminals(sessionId).at(-1);
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.visible_text_available, true);
    assert.equal(terminal.last_response_text_available, true);
    assert.equal(live.filter(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'bridge-call-write' && update.status === 'completed').length, 1, 'the completed file action must not be replayed');
    const nativeCount = model.requests.length;
    assert.equal((await prompt(sessionId, 'bridge_fixture_chat next_round')).stopReason, 'end_turn');
    assert.equal(model.requests.length, nativeCount + 1, 'no hidden retry or extra model turn');
    const nextTerminal = terminals(sessionId).at(-1);
    assert.equal(nextTerminal.last_response_text_available, true, 'a later answer clears the observation through new native data');
  });

  await t.test('rejecting the original ACP permission leaves the tool target untouched', async () => {
    const sessionId = await newSession();
    const pending = prompt(sessionId, 'bridge_fixture_write denied');
    const ask = await permission(sessionId);
    client.reply(ask.id, { outcome: { outcome: 'selected', optionId: 'reject_once' } });
    assert.equal((await pending).stopReason, 'end_turn');
    await assert.rejects(access(path.join(root, 'denied.txt')));
    assert.ok(updates(sessionId).some(update => update.sessionUpdate === 'tool_call_update' && update.status === 'failed'));
  });

  await t.test('cancel travels over the active WebSocket while the real model stream is pending', async () => {
    const sessionId = await newSession();
    const pending = prompt(sessionId, 'bridge_fixture_slow');
    await client.waitFor(message => message.method === 'session/update' && message.params.sessionId === sessionId && message.params.update.content?.text === 'bridge pending');
    await client.request('session/cancel', { sessionId });
    assert.equal((await pending).stopReason, 'cancelled');
  });

  await t.test('provider errors remain JSON-RPC errors through the actual execution core', async () => {
    const sessionId = await newSession();
    await assert.rejects(prompt(sessionId, 'bridge_fixture_error'), /controlled bridge provider failure|400/);
  });

  await t.test('changing models on an existing ACP session preserves history', async () => {
    await client.request('session/set_config_option', { sessionId: retainedSession, configId: 'model', value: 'bridge-model-two' });
    assert.equal((await prompt(retainedSession, 'bridge_fixture_chat changed_model')).stopReason, 'end_turn');
    assert.equal(model.requests.at(-1).model, 'bridge-model-two');
    assert.match(JSON.stringify(model.requests.at(-1).messages), /bridge_fixture_write approved/);
  });

  await t.test('restart replays identical message ids and continues the persisted Harness conversation', async () => {
    const before = updates(retainedSession).filter(update => update.sessionUpdate === 'agent_message_chunk');
    await client.request('session/set_mode', { sessionId: retainedSession, modeId: 'read-only' });
    client.close();
    await app.close();
    app = await createCompatServer({ dataDir, secret });
    client = await connect(await app.listen(0));
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const defaults = await client.request(ext('defaults/read'));
    assert.equal(defaults.providerId, configured.providerId);
    const loaded = await client.request('session/load', { sessionId: retainedSession, cwd: root, mcpServers: [] });
    assert.equal(loaded.modes.currentModeId, 'read-only');
    const replay = updates(retainedSession).filter(update => update.sessionUpdate === 'agent_message_chunk');
    assert.deepEqual([...new Set(replay.map(update => update.messageId))], [...new Set(before.map(update => update.messageId))], 'message identities and their order must survive restart');
    assert.deepEqual(await projectChatUpdates(replay), await projectChatUpdates(before), 'replay may assemble text frames, but every rendered message and its metadata must be identical');
    assert.equal((await prompt(retainedSession, 'bridge_fixture_chat after_restart')).stopReason, 'end_turn');
    const request = model.requests.at(-1);
    assert.match(JSON.stringify(request.messages), /bridge_fixture_write approved/);
    assert.match(JSON.stringify(request.messages), /bridge_fixture_chat changed_model/);
    assert.equal(request.model, 'bridge-model-two');
    const list = await client.request('session/list', {});
    assert.ok(list.sessions.some(session => session.sessionId === retainedSession));
  });
});

test('native image receipts and existing host previews cross ACP without stranding completed tools, including old replay', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-image-presentation-')));
  const dataDir = path.join(root, 'data');
  const sharp = createRequire(new URL('../harness/package.json', import.meta.url))('sharp');
  const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#ff0000' } }).png().toBuffer();
  await writeFile(path.join(root, 'image.png'), png);
  const model = await fixtureServer(root);
  const native = await createHarnessDriver({ dataDir: path.join(dataDir, 'harness'), cwd: root });
  let effects = 0;
  const hostTool = {
    name: 'fixture_image_output', description: 'Return the existing isolated image once', inputSchema: { type: 'object', properties: {} },
    async execute() { effects++; return { content: [{ type: 'text', text: 'Original host image receipt.' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }; },
  };
  const driver = new Proxy(native, { get(target, key) {
    if (key === 'createSession') return input => target.createSession({ ...input, options: { ...input.options, tools: [...(input.options.tools ?? []), hostTool] } });
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
  let app = await createCompatServer({ dataDir, secret, driver });
  let client = await connect(await app.listen(0));
  t.after(async () => { client.close(); await app.close(); await model.close(); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const configured = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Image projection fixture', apiUrl: model.url, requiresAuth: false, models: ['bridge-model'], supportsStreaming: true, headers: {} });
  await client.request(ext('defaults/save'), { providerId: configured.providerId, modelId: 'bridge-model' });
  await client.request(ext('tools/permissions/set'), { toolPermissions: ['read_image', 'fixture_image_output', 'search_mcp_tools'].map(toolName => ({ toolName, permission: 'always_allow' })) });
  const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [] });
  const updates = () => client.notifications.filter(message => message.method === 'session/update' && message.params.sessionId === sessionId).map(message => message.params.update);
  const validUpdates = () => updates().map(update => zSessionNotification.parse({ sessionId, update }).update);
  const call = (name, args) => client.request(ext('tools/call'), { sessionId, name, arguments: args });
  assert.equal((await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'bridge_fixture_image inspect the isolated fixture.' }] })).stopReason, 'end_turn');
  assert.equal(validUpdates().find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'bridge-call-image').status, 'completed');
  const direct = await call('read_image', { file_path: path.join(root, 'image.png') });
  zGooseToolCallResponse_unstable.parse(direct);
  assert.equal(direct.isError, false, JSON.stringify(direct));
  assert.equal(direct.content.find(block => block.type === 'image').data, png.toString('base64'));
  const originalRef = direct.structuredContent.image;
  const directId = updates().find(update => update.sessionUpdate === 'tool_call' && update.title === 'read_image').toolCallId;
  const successful = validUpdates().find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === directId);
  assert.equal(successful.status, 'completed');
  assert.equal(successful.content.find(part => part.content?.type === 'image').content.mimeType, 'image/png');
  const host = await call('fixture_image_output', {});
  zGooseToolCallResponse_unstable.parse(host);
  assert.equal(host.isError, false);
  assert.equal(host.content.find(block => block.type === 'image').data, png.toString('base64'), 'the original host display bytes remain authoritative');
  assert.equal(effects, 1);
  const missing = await call('read_image', { file_path: path.join(root, 'missing.png') });
  zGooseToolCallResponse_unstable.parse(missing);
  assert.equal(missing.isError, true);
  assert.ok(validUpdates().some(update => update.sessionUpdate === 'tool_call_update' && update.status === 'failed'));
  const projected = await projectChatUpdates(validUpdates());
  const requests = projected.flatMap(message => message.content).filter(part => part.type === 'toolRequest');
  const responses = projected.flatMap(message => message.content).filter(part => part.type === 'toolResponse');
  assert.ok(requests.every(request => responses.some(response => response.id === request.id)), 'every started native/host tool has its actual terminal receipt');
  const history = await native.history(sessionId);
  const originalNative = history.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'bridge-call-image');
  assert.ok(originalNative.data.message.content.some(block => block.type === 'image' && block.attachment && !block.data), 'native Session v4 retains the original durable attachment shape');
  const modelRequests = model.requests.length;
  client.close(); await app.close();
  // Simulate the precise old journal shape captured in the product failure.
  // One second preview reference is unavailable; neither terminal may be lost.
  const stateFile = path.join(dataDir, 'state.json'), state = JSON.parse(await readFile(stateFile, 'utf8'));
  const saved = state.sessions.find(session => session.id === sessionId);
  const oldUpdate = saved.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === directId);
  oldUpdate.content = [{ type: 'content', content: { type: 'image', attachment: originalRef } }];
  const hostId = saved.updates.find(update => update.sessionUpdate === 'tool_call' && update.title === 'fixture_image_output').toolCallId;
  const unavailable = saved.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === hostId);
  unavailable.content = [{ type: 'content', content: { type: 'image', attachment: { ...originalRef, attachmentId: 'sha256:' + '0'.repeat(64) } } }];
  await writeFile(stateFile, JSON.stringify(state));
  const beforeReplay = await readFile(stateFile, 'utf8');
  app = await createCompatServer({ dataDir, secret });
  client = await connect(await app.listen(0));
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await client.request('session/load', { sessionId, cwd: root, mcpServers: [] });
  const restored = validUpdates();
  const restoredDirect = restored.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === directId);
  assert.equal(restoredDirect.status, 'completed');
  assert.equal(restoredDirect.content[0].content.data, png.toString('base64'));
  const restoredUnavailable = restored.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === hostId);
  assert.equal(restoredUnavailable.status, 'completed', 'a missing optional preview does not turn a completed tool into a failure');
  assert.match(restoredUnavailable.content[0].content.text, /preview is unavailable/);
  assert.equal(restored.filter(update => update.sessionUpdate === 'tool_call_update' && update.status === 'failed').length, 1);
  assert.equal(effects, 1); assert.equal(model.requests.length, modelRequests, 'replay never repeats the tool or model action');
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).sessions.find(session => session.id === sessionId).updates,
    JSON.parse(beforeReplay).sessions.find(session => session.id === sessionId).updates,
    'repairing display must not rewrite the persisted transcript');
  client.close(); await app.close();
  const replayNative = await createHarnessDriver({ dataDir: path.join(dataDir, 'harness'), cwd: root });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let blocked = false;
  const replayDriver = new Proxy(replayNative, { get(target, key) {
    if (key === 'presentationContent') return async content => {
      if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
      return target.presentationContent(content);
    };
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
  app = await createCompatServer({ dataDir, secret, driver: replayDriver });
  client = await connect(await app.listen(0));
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const loading = client.request('session/load', { sessionId, cwd: root, mcpServers: [] });
  await entered.promise;
  const concurrentRequest = 'bridge_fixture_chat completed while an older preview was loading.';
  try {
    assert.equal((await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: concurrentRequest }] })).stopReason, 'end_turn');
  } finally { release.resolve(); }
  await loading;
  const afterRead = validUpdates();
  const reset = afterRead.findLastIndex(update => update.sessionUpdate === 'session_info_update' && update._meta?.goose?.transcriptReplayStarted);
  assert.ok(afterRead.slice(reset + 1).some(update => update.sessionUpdate === 'user_message_chunk' && update.content.text === concurrentRequest), 'replay must capture the new durable high water mark after optional preview I/O');
  assert.equal(model.requests.length, modelRequests + 1);
  assert.equal(effects, 1);
});
