import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../harness/index.mjs';
import { openStore } from '../store.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { ConversationEditing } from '../conversation-editing.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-conversation-edit-'));
  const requests = [], resourceCalls = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    if (req.url === '/mcp') {
      if (!('id' in data)) { res.writeHead(202); res.end(); return; }
      resourceCalls.push(data);
      const resource = { uri: 'ui://edited/resource', mimeType: 'text/html', name: 'Edited session resource' };
      let result;
      if (data.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'edit-resource-fixture', version: '1' } };
      else if (data.method === 'tools/list') result = { tools: [] };
      else if (data.method === 'resources/list') result = { resources: [resource] };
      else if (data.method === 'resources/read') result = { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: '<p>MAPPED_EDIT_RESOURCE</p>', _meta: { ui: { prefersBorder: true } } }] };
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, error: { code: -32601, message: 'Fixture method unavailable' } })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result })); return;
    }
    requests.push(data);
    const prompt = [...data.messages].reverse().find(m => m.role === 'user' && JSON.stringify(m.content).includes('USER_'));
    const index = data.messages.indexOf(prompt);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'edit-fixture', object: 'chat.completion.chunk', created: 1, model: data.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (JSON.stringify(prompt?.content).includes('USER_CHILD_ROOT') && !data.messages.slice(index + 1).some(m => m.role === 'tool')) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'spawn-fixture', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ description: 'Identity mapping child fixture', prompt: 'USER_CALL_HOST CHILD' }) } }] }); emit({}, 'tool_calls');
    } else if (JSON.stringify(prompt?.content).includes('USER_CALL_HOST') && !data.messages.slice(index + 1).some(m => m.role === 'tool')) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'identity_receipt', arguments: '{}' } }] }); emit({}, 'tool_calls');
    } else { emit({ role: 'assistant', content: 'FIXTURE_ANSWER' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'edit-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-fixture-token', protocol: 'openai-completions' };
  let rawDriver = await createHarnessDriver({ dataDir: join(directory, 'native'), cwd: directory });
  let store = await openStore(join(directory, 'product'));
  let driver = createConversationDriver(rawDriver, store);
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const hostCalls = [];
  const options = { tools: [{ name: 'identity_receipt', description: 'Return fixture identity', inputSchema: { type: 'object', properties: {} }, async execute(_args, exec) { hostCalls.push(exec); return { identity: exec.sessionId }; } }] };
  const setup = async id => driver.createSession({ sessionId: id, cwd: directory, provider, model: 'fixture-model', options });
  async function create(type = 'user') {
    const id = randomUUID(), now = new Date().toISOString();
    await store.update(s => s.sessions.push({ id, type, title: 'Fixture session', cwd: directory, providerId: provider.id, modelId: 'fixture-model', createdAt: now, updatedAt: now, updates: [], usageUpdates: [], messageCount: 0, extensions: [] }));
    await setup(id); return id;
  }
  async function turn(id, text, created, { requestId = randomUUID(), onPermission = () => true, onToolStart } = {}) {
    const events = [];
    await driver.prompt(id, text, { requestId, onEvent: e => events.push(e), onPermission, onToolStart });
    const assistantId = randomUUID();
    await store.update(s => {
      const session = s.sessions.find(s => s.id === id);
      session.updates.push({ sessionUpdate: 'user_message_chunk', messageId: requestId, content: { type: 'text', text }, _meta: { goose: { messageId: requestId, created } } }, { sessionUpdate: 'agent_message_chunk', messageId: assistantId, content: { type: 'text', text: 'FIXTURE_ANSWER' }, _meta: { goose: { messageId: assistantId, created } } });
      session.usageUpdates.push({ sessionUpdate: 'message_usage', messageId: assistantId, tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      session.messageCount += 2;
    });
    return { requestId, events };
  }
  const mcp = serverName => ({ serverName, transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp`, reconnect: { enabled: false } });
  return { directory, requests, resourceCalls, mcp, provider, options, setup, create, turn, hostCalls, get store() { return store; }, get driver() { return driver; }, get rawDriver() { return rawDriver; }, async restart() { await driver.close(); store = await openStore(join(directory, 'product')); rawDriver = await createHarnessDriver({ dataDir: join(directory, 'native'), cwd: directory }); driver = createConversationDriver(rawDriver, store); } };
}

test('official fork powers in-place edits, preserves old native facts, maps host/permission/event identities, and survives restart', async t => {
  const f = await fixture(t), id = await f.create();
  await f.turn(id, 'USER_KEEP', 10);
  const dropped = await f.turn(id, 'USER_DISCARD', 20);
  const oldNative = await f.driver.history(id);
  const changed = [];
  const editing = new ConversationEditing(f.store, f.driver, { onChanged: id => changed.push(id) });
  assert.deepEqual(await editing.request('session/conversation/truncate', { sessionId: id, truncateFrom: 20 }), {});
  const session = f.store.read().sessions.find(s => s.id === id);
  assert.notEqual(session.nativeSessionId, id);
  assert.equal(session.messageCount, 2); assert.equal(session.usageUpdates.length, 1);
  assert.equal(session.conversationEdits[0].beforeRequestId, dropped.requestId);
  assert.equal(session.conversationEdits[0].workspaceEffectsRetained, true);
  assert.deepEqual(changed, [id]);
  assert.deepEqual((await f.rawDriver.history(id)).events, oldNative.events);
  await f.restart(); await f.setup(id);
  const approvals = [];
  const outcome = await f.turn(id, 'USER_CALL_HOST EDITED', 30, { onPermission: call => { approvals.push(call); return true; } });
  assert.ok(outcome.events.every(e => e.sessionId === id));
  assert.equal(approvals[0].sessionId, id); assert.equal(f.hostCalls[0].sessionId, id);
  const modelInput = JSON.stringify(f.requests.at(-1).messages);
  assert.match(modelInput, /USER_KEEP/); assert.match(modelInput, /USER_CALL_HOST EDITED/); assert.doesNotMatch(modelInput, /USER_DISCARD/);
  const listed = await f.driver.listSessions();
  assert.equal(listed.filter(s => (s.id ?? s.sessionId) === id).length, 1);
  assert.equal(f.store.read().sessions.find(s => s.id === id).nativeSessionId, session.nativeSessionId);
  const childApprovals = [];
  // This test observes identity mapping, not the sandbox/approval contract of
  // this arbitrary host capability (covered by the permission integration).
  await f.driver.permissions(id, { preset: 'danger-full-access' });
  const delegated = await f.turn(id, 'USER_CHILD_ROOT', 40, { onToolStart: call => { childApprovals.push(call); } });
  const start = delegated.events.find(e => e.type === 'subagent_start');
  assert.equal(start.sessionId, id); assert.notEqual(start.childSessionId, id); assert.notEqual(start.childSessionId, session.nativeSessionId);
  assert.equal(f.hostCalls.at(-1).sessionId, start.childSessionId);
  assert.ok(childApprovals.some(c => c.name === 'identity_receipt' && c.sessionId === start.childSessionId));
  assert.ok(delegated.events.some(e => e.type === 'tool_result' && e.name === 'identity_receipt' && e.sessionId === start.childSessionId));
});

test('forking before the first prompt leaves no queued old input; plain full fork keeps history but never a run or approval receipt', async t => {
  const f = await fixture(t), id = await f.create();
  await f.turn(id, 'USER_ORIGINAL', 10);
  await f.store.update(s => Object.assign(s.sessions.find(s => s.id === id), { transcriptTurns: { previous: { seq: 10 } }, approvals: ['old'], activeRunId: 'old' }));
  const editing = new ConversationEditing(f.store, f.driver);
  const empty = await editing.request('session/fork', { sessionId: id, cwd: f.directory, _meta: { conversationBefore: 10 } });
  assert.equal(f.store.read().sessions.find(s => s.id === empty.sessionId).updates.length, 0);
  await f.setup(empty.sessionId); await f.turn(empty.sessionId, 'USER_REPLACEMENT', 20);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /USER_ORIGINAL/);
  const full = await editing.request('session/fork', { sessionId: id });
  const copy = f.store.read().sessions.find(s => s.id === full.sessionId);
  assert.equal(copy.updates.length, 2); assert.equal(copy.activeRunId, undefined); assert.equal(copy.approvals, undefined); assert.equal(copy.transcriptTurns, undefined);
  assert.equal(copy.forkedFrom.sessionId, id);
  await f.setup(full.sessionId); await f.turn(full.sessionId, 'USER_FOLLOW_UP', 30);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /USER_ORIGINAL/);
  assert.equal(f.store.read().sessions.find(s => s.id === id).updates.length, 2);
});

test('editing ignores UI-only failed submissions but preserves the exact admitted model prefix', async t => {
  const f = await fixture(t), id = await f.create();
  await f.store.update(state => {
    const session = state.sessions.find(item => item.id === id);
    for (const created of [1, 2]) {
      const messageId = `not-admitted-${created}`;
      session.updates.push({ sessionUpdate: 'user_message_chunk', messageId, content: { type: 'text', text: `USER_FAILED_${created}` }, _meta: { goose: { messageId, created } } });
    }
    session.messageCount = 2;
  });
  await f.turn(id, 'USER_ADMITTED_KEEP', 10);
  await f.turn(id, 'USER_ADMITTED_REPLACE', 20);
  await new ConversationEditing(f.store, f.driver).request('session/conversation/truncate', { sessionId: id, truncateFrom: 20 });
  assert.equal(f.store.read().sessions.find(item => item.id === id).updates.length, 4);
  await f.setup(id);
  await f.turn(id, 'USER_EDITED_AFTER_FAILURE', 30);
  const input = JSON.stringify(f.requests.at(-1).messages);
  assert.match(input, /USER_ADMITTED_KEEP/);
  assert.match(input, /USER_EDITED_AFTER_FAILURE/);
  assert.doesNotMatch(input, /USER_FAILED_|USER_ADMITTED_REPLACE/);
});

test('editing a failed first submission cuts before the first admitted request', async t => {
  const f = await fixture(t), id = await f.create();
  await f.store.update(state => state.sessions.find(item => item.id === id).updates.push({ sessionUpdate: 'user_message_chunk', messageId: 'failed-first', content: { type: 'text', text: 'USER_FAILED_FIRST' }, _meta: { goose: { messageId: 'failed-first', created: 1 } } }));
  await f.turn(id, 'USER_ADMITTED_AFTER_FAILURE', 10);
  await new ConversationEditing(f.store, f.driver).request('session/conversation/truncate', { sessionId: id, truncateFrom: 1 });
  await f.setup(id);
  await f.turn(id, 'USER_RETRY_FROM_START', 20);
  const input = JSON.stringify(f.requests.at(-1).messages);
  assert.match(input, /USER_RETRY_FROM_START/);
  assert.doesNotMatch(input, /USER_FAILED_FIRST|USER_ADMITTED_AFTER_FAILURE/);
});

test('CodePro editing requires idle owner cancellation and preserves source history if cancellation or commit fails', async t => {
  const f = await fixture(t), id = await f.create('code_pro');
  await f.turn(id, 'USER_BEFORE', 10); await f.turn(id, 'USER_AFTER', 20);
  let active = true, cancelled = 0;
  const editing = new ConversationEditing(f.store, f.driver, { isActive: () => active, beforeTruncate: async s => { assert.equal(s.id, id); cancelled++; } });
  const params = { sessionId: id, truncateFrom: 20 };
  await assert.rejects(editing.request('session/conversation/truncate', params), /active/);
  active = false;
  await assert.rejects(editing.request('session/fork', { sessionId: id }), /CodePro/);
  await assert.rejects(new ConversationEditing(f.store, f.driver).request('session/conversation/truncate', params), /cancellation/);
  await assert.rejects(new ConversationEditing(f.store, f.driver, { beforeTruncate() { throw new Error('owner rejected'); } }).request('session/conversation/truncate', params), /owner rejected/);
  assert.equal(f.store.read().sessions.find(s => s.id === id).nativeSessionId, undefined);
  const failStore = { read: () => f.store.read(), update() { throw new Error('fixture state commit failed'); } };
  await assert.rejects(new ConversationEditing(failStore, f.driver, { beforeTruncate: async () => {} }).request('session/conversation/truncate', params), /state commit failed/);
  assert.equal(f.store.read().sessions.find(s => s.id === id).nativeSessionId, undefined);
  assert.equal(f.store.read().sessions.find(s => s.id === id).updates.length, 4);
  await editing.request('session/conversation/truncate', params);
  assert.equal(cancelled, 1);
  assert.equal(f.store.read().sessions.find(s => s.id === id).updates.length, 2);
});

test('timestamps use original whole-second prefix semantics and reject ambiguous or uncorrelated histories', async t => {
  const f = await fixture(t), id = await f.create();
  await f.turn(id, 'USER_SAME_SECOND_A', 10); await f.turn(id, 'USER_SAME_SECOND_B', 10);
  const editing = new ConversationEditing(f.store, f.driver);
  const empty = await editing.request('session/fork', { sessionId: id, _meta: { conversationBefore: 10 } });
  assert.equal(f.store.read().sessions.find(s => s.id === empty.sessionId).updates.length, 0);
  await assert.rejects(editing.request('session/conversation/truncate', { sessionId: id, truncateFrom: 10.5 }), /integer/);
  await assert.rejects(editing.request('session/fork', { sessionId: id, cwd: join(f.directory, 'different') }), /workspace/);
  await f.store.update(s => { const session = s.sessions.find(s => s.id === id); session.updates[0].messageId = 'legacy-ui-id'; });
  await assert.rejects(editing.request('session/fork', { sessionId: id }), /exact UI-to-Harness/);
  await assert.rejects(editing.request('session/conversation/truncate', { sessionId: id, truncateFrom: 10 }), /exact UI-to-Harness/);
  await f.store.update(s => { s.sessions.find(s => s.id === id).readonlyHistory = true; });
  await assert.rejects(editing.request('session/fork', { sessionId: id }), /read-only/);
});

test('facade maps only the root execution identity and serializes edits against prompts and direct tools', async () => {
  const calls = [], store = { read: () => ({ sessions: [{ id: 'product', nativeSessionId: 'native' }] }) };
  let release;
  const driver = createConversationDriver({
    memory: { native: true }, refreshSkills: () => 'refresh', testExtension: () => 'test',
    async prompt(id, _content, options) { calls.push(id); await options.onEvent({ sessionId: id, childSessionId: 'child' }); await options.onEvent({ sessionId: 'child', parentSessionId: id }); await options.onPermission({ sessionId: 'child' }); await new Promise(resolve => { release = resolve; }); },
    cancel(id) { calls.push(id); release(); },
    async callTool(id) { calls.push(id); },
  }, store);
  const events = [], permissions = [];
  const run = driver.prompt('product', '', { onEvent: e => events.push(e), onPermission: c => permissions.push(c) });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(driver.withConversationLock('product', () => {}), /active/);
  await assert.rejects(driver.callTool('product', 'x', {}), /active/);
  assert.deepEqual(events, [{ sessionId: 'product', childSessionId: 'child' }, { sessionId: 'child', parentSessionId: 'product' }]);
  assert.equal(permissions[0].sessionId, 'child');
  driver.cancel('product'); await run;
  await driver.callTool('product', 'x', {});
  assert.deepEqual(calls, ['native', 'native', 'native']);
  assert.equal(driver.memory.native, true); assert.equal(driver.refreshSkills(), 'refresh'); assert.equal(driver.testExtension(), 'test');
  assert.deepEqual(driver.listTools('product'), []); assert.deepEqual(driver.extensionStatus('product'), []);
});

test('edited and restarted product sessions read and list resources from their current native MCP scope with product approval identity', async t => {
  const f = await fixture(t), id = await f.create();
  await f.driver.configureSession(id, { mcpServers: [f.mcp('retired')] });
  await f.turn(id, 'USER_EDIT_RESOURCE', 10);
  await new ConversationEditing(f.store, f.driver).request('session/conversation/truncate', { sessionId: id, truncateFrom: 10 });
  const nativeId = f.driver.nativeSessionId(id); assert.notEqual(nativeId, id);
  await f.setup(id); await f.driver.configureSession(id, { mcpServers: [f.mcp('current')] });
  const approvals = [];
  const onPermission = call => { approvals.push(call); return call.sessionId === id && ['list_mcp_resources', 'read_mcp_resource'].includes(call.name) && call.arguments.server === 'current'; };
  await assert.rejects(f.rawDriver.listResources(id, 'current', undefined, { onPermission: () => true }), /unavailable|unknown|not found/i);
  await assert.rejects(f.driver.readResource(id, 'current', 'ui://edited/resource'), /declined|approval|failed/i);
  assert.equal(f.resourceCalls.filter(c => c.method === 'resources/read').length, 0);
  const listed = await f.driver.listResources(id, 'current', undefined, { onPermission });
  assert.equal(listed.resources[0].uri, 'ui://edited/resource');
  const resource = await f.driver.readResource(id, 'current', listed.resources[0].uri, { onPermission });
  assert.equal(resource.contents[0].text, '<p>MAPPED_EDIT_RESOURCE</p>');
  assert.deepEqual(resource.contents[0]._meta, { ui: { prefersBorder: true } });
  assert.deepEqual(approvals.map(c => [c.sessionId, c.name]), [[id, 'list_mcp_resources'], [id, 'read_mcp_resource']]);
  await f.restart(); await f.setup(id); await f.driver.configureSession(id, { mcpServers: [f.mcp('current')] });
  assert.equal(f.driver.nativeSessionId(id), nativeId);
  assert.equal((await f.driver.readResource(id, 'current', listed.resources[0].uri, { onPermission })).contents[0].text, '<p>MAPPED_EDIT_RESOURCE</p>');
  assert.equal(f.resourceCalls.filter(c => c.method === 'resources/read').length, 2);
});
