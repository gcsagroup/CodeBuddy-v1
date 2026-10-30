import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay, setImmediate as immediate } from 'node:timers/promises';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

const names = ['list_apps', 'get_app_state', 'click', 'drag', 'perform_secondary_action', 'press_key', 'scroll', 'set_value', 'type_text', 'open_path'];
const definition = name => ({ name, description: 'Isolated approval fixture', inputSchema: { type: 'object', properties: {} } });
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(20); }
  assert.fail('Expected approval/catalog phase was not reached');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-computer-approval-'));
  const catalog = names.map(definition), executions = [], questions = [], contexts = [], streams = new Set();
  let listCount = 0;
  const remote = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw);
    if (!('id' in msg)) { res.writeHead(202).end(); return; }
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'approval-fixture', version: '1' } };
    else if (msg.method === 'tools/list') { listCount++; result = { tools: catalog }; }
    else if (msg.method === 'tools/call') { executions.push(msg.params.name); result = { content: [{ type: 'text', text: `Executed fixture ${msg.params.name}` }] }; }
    else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } })); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'approval-fixture' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${remote.address().port}/mcp`;
  const driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
  t.after(async () => { await driver.close(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); });
  const store = await openStore(join(root, 'host'));
  const host = Object.assign(Object.create(Compat.prototype), { store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store) });
  const mcp = { serverName: 'qwen_computer', transport: 'streamable-http', url, sessionApprovalScope: 'module', reconnect: { enabled: false } };
  const session = async () => {
    const s = { id: randomUUID(), cwd: root, mode: 'approve', updates: [], mcpServers: [{ name: 'qwen_computer', type: 'http', url, headers: [] }, { name: 'other', type: 'http', url, headers: [] }] };
    await store.update(state => state.sessions.push(s));
    await driver.createSession({ sessionId: s.id, cwd: root, provider: { id: 'fixture', baseUrl: url, apiKey: 'fixture' }, model: 'fixture', options: { mcpServers: [mcp, { ...mcp, serverName: 'other' }] } });
    return s;
  };
  const controls = { choice: 'allow_always', answer: null };
  const connection = { async ask(method, params) {
    assert.equal(method, 'session/request_permission'); questions.push(params);
    return controls.answer ? controls.answer(params) : { outcome: { outcome: 'selected', optionId: controls.choice } };
  } };
  const callbacks = s => ({ onToolPolicy: call => { contexts.push(call); return host.toolPolicy(s, call, call.signal); }, onPermission: call => host.approveTool(s, call, connection, call.signal) });
  const invoke = (s, name, server = 'qwen_computer') => driver.callTool(s.id, `mcp__${server}__${name}`, {}, callbacks(s));
  const refresh = async () => {
    await until(() => streams.size > 0);
    const previous = listCount;
    for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
    await until(() => listCount > previous);
    // A fresh list round-trip alone is not proof that the registry has applied it.
    await until(async () => {
      const tools = await driver.listTools(first.id);
      return catalog.every(tool => tools.some(item => item.name === `mcp__qwen_computer__${tool.name}` && item.description === tool.description));
    });
  };
  const first = await session();
  return { first, session, invoke, driver, mcp, host, store, catalog, refresh, executions, questions, contexts, controls, connection };
}

test('one computer module approval covers all ten tools and later calls, but not other chats or modules', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const name of names) assert.equal((await f.invoke(f.first, name)).isError, false);
  assert.deepEqual(f.executions, names);
  assert.equal(f.questions.length, 1);
  assert.equal(f.questions[0]._meta.codepro.authorizationGroup, 'mcp_module');
  assert.equal(f.questions[0].options.find(o => o.kind === 'allow_always').name, 'Allow qwen_computer for this session');
  assert.equal((await f.invoke(f.first, 'click')).isError, false);
  assert.equal(f.questions.length, 1);
  assert.equal(f.store.read(['toolPermissions']).toolPermissions, undefined, 'No global permission is written');
  f.controls.choice = 'reject_once';
  assert.equal((await f.invoke(await f.session(), 'get_app_state')).isError, true);
  assert.equal((await f.invoke(f.first, 'get_app_state', 'other')).isError, true);
  assert.equal(f.questions.at(-1)._meta.codepro.authorizationGroup, 'mcp_module');
  assert.equal(f.executions.length, 11);
});

test('allow-once, rejection and concurrent different tools preserve explicit module consent', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.controls.choice = 'allow_once';
  assert.equal((await f.invoke(f.first, 'list_apps')).isError, false);
  f.controls.choice = 'reject_once';
  assert.equal((await f.invoke(f.first, 'get_app_state')).isError, true);
  assert.equal((await f.invoke(f.first, 'click')).isError, true);
  assert.equal(f.questions.length, 3);
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  f.controls.answer = async () => { ready.resolve(); await release.promise; return { outcome: { outcome: 'selected', optionId: 'allow_always' } }; };
  const one = f.invoke(f.first, 'get_app_state');
  await ready.promise;
  // Direct maintenance calls are intentionally serialized by Harness. Exercise
  // concurrent approval consumers with the real second tool's captured binding.
  const two = f.host.approveTool(f.first, f.contexts.find(call => call.name === 'mcp__qwen_computer__click'), f.connection);
  await immediate(); await immediate();
  assert.equal(f.questions.length, 4);
  assert.deepEqual(f.executions, ['list_apps'], 'No action before module approval');
  release.resolve();
  const [firstResult, secondAllowed] = await Promise.all([one, two]);
  assert.equal(firstResult.isError, false);
  assert.equal(secondAllowed, true);
  assert.equal((await f.invoke(f.first, 'click')).isError, false);
  assert.equal(f.questions.length, 4, 'Different tools share the pending module choice');
});

test('unchanged catalogs keep the grant; added or changed tools and replacement connections revoke it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.invoke(f.first, 'list_apps');
  const old = f.contexts.at(-1).sessionApproval;
  await f.refresh();
  assert.equal((await f.invoke(f.first, 'click')).isError, false);
  assert.equal(f.questions.length, 1);
  f.controls.choice = 'reject_once';
  f.catalog.push(definition('new_tool'));
  await f.refresh();
  await until(() => !old.isCurrent());
  assert.equal((await f.invoke(f.first, 'click')).isError, true, 'Even an unchanged member must ask after catalog growth');
  assert.equal((await f.invoke(f.first, 'new_tool')).isError, true);
  f.controls.choice = 'allow_always';
  await f.invoke(f.first, 'click');
  const changed = f.contexts.at(-1).sessionApproval;
  f.catalog[0].description = 'Changed behavior';
  await f.refresh();
  await until(() => !changed.isCurrent());
  f.controls.choice = 'reject_once';
  assert.equal((await f.invoke(f.first, 'type_text')).isError, true);
  f.controls.choice = 'allow_always';
  await f.invoke(f.first, 'click');
  const previous = f.contexts.at(-1).sessionApproval;
  await f.driver.configureSession(f.first.id, { mcpServers: [{ ...f.mcp, headers: { 'x-fixture-generation': '2' } }] });
  assert.equal(previous.isCurrent(), false);
  f.controls.choice = 'reject_once';
  assert.equal((await f.invoke(f.first, 'click')).isError, true);
});

test('module grant does not override explicit deny, ask-before, safety or destructive tools', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.catalog.push({ ...definition('destructive'), annotations: { destructiveHint: true } });
  await f.refresh();
  await f.invoke(f.first, 'list_apps');
  await f.store.update(state => { state.toolPermissions = { mcp__qwen_computer__click: 'never_allow' }; });
  assert.equal((await f.invoke(f.first, 'click')).isError, true);
  assert.equal(f.questions.length, 1);
  await f.store.update(state => { state.toolPermissions = { mcp__qwen_computer__click: 'ask_before' }; });
  f.controls.choice = 'reject_once';
  assert.equal((await f.invoke(f.first, 'click')).isError, true);
  assert.equal(f.questions.at(-1).options.some(o => o.kind === 'allow_always'), false);
  await f.store.update(state => { state.toolPermissions = {}; });
  assert.equal((await f.invoke(f.first, 'destructive')).isError, true);
  assert.equal(f.questions.at(-1).options.some(o => o.kind === 'allow_always'), false);
  f.host.safety = { inspect: async () => ({ requiresApproval: true, explanation: 'Explicit fixture safety check' }) };
  assert.equal((await f.invoke(f.first, 'type_text')).isError, true);
  assert.equal(f.questions.at(-1).options.some(o => o.kind === 'allow_always'), false);
  assert.deepEqual(f.executions, ['list_apps']);
});

test('a late answer to a retired module catalog grants neither the old call nor new tools', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  f.controls.answer = async () => { ready.resolve(); await release.promise; return { outcome: { outcome: 'selected', optionId: 'allow_always' } }; };
  const work = f.invoke(f.first, 'list_apps');
  await ready.promise;
  const old = f.contexts.at(-1).sessionApproval;
  f.catalog.push(definition('late_tool'));
  await f.refresh();
  await until(() => !old.isCurrent());
  release.resolve();
  assert.equal((await work).isError, true);
  f.controls.answer = null; f.controls.choice = 'reject_once';
  assert.equal((await f.invoke(f.first, 'click')).isError, true);
  assert.deepEqual(f.executions, []);
});
