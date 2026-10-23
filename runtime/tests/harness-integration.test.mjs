import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';

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
      res.end(JSON.stringify({ data: [{ id: 'bridge-model' }, { id: 'bridge-model-two' }] }));
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
    const prompt = JSON.stringify(request.messages[lastUser]?.content);
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
    assert.deepEqual(replay, before);
    assert.equal((await prompt(retainedSession, 'bridge_fixture_chat after_restart')).stopReason, 'end_turn');
    const request = model.requests.at(-1);
    assert.match(JSON.stringify(request.messages), /bridge_fixture_write approved/);
    assert.match(JSON.stringify(request.messages), /bridge_fixture_chat changed_model/);
    assert.equal(request.model, 'bridge-model-two');
    const list = await client.request('session/list', {});
    assert.ok(list.sessions.some(session => session.sessionId === retainedSession));
  });
});
