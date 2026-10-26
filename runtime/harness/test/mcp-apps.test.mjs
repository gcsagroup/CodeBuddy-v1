import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../index.mjs';
import { Compat } from '../../compat.mjs';
import { openStore } from '../../store.mjs';
import { SafetyPolicy } from '../../safety-policy.mjs';

const resourceMeta = { ui: { prefersBorder: true, csp: { connectDomains: ['https://api.example.test'] } } };
const hiddenMeta = { privateUiState: 'HOST_ONLY_NOT_MODEL_VISIBLE' };
const resource = { uri: 'ui://fixture/chart', mimeType: 'text/html;profile=mcp-app', name: 'Chart' };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-mcp-app-wire-')), calls = [], models = [], held = new Map(), headers = [], streams = new Set(), controls = { rejectInitialize: false, liveNotifications: false, toolName: 'chart' };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && controls.liveNotifications && req.url === '/mcp') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk; const msg = JSON.parse(raw);
    if (req.url === '/mcp') {
      if (!('id' in msg)) { res.writeHead(202).end(); return; }
      calls.push(msg); headers.push(req.headers.authorization); let result;
      if (msg.method === 'initialize' && controls.rejectInitialize) { res.writeHead(503).end(); return; }
      if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: 'apps-fixture', version: '1' } };
      else if (msg.method === 'tools/list') result = { tools: [{ name: controls.toolName, description: 'Read chart values', inputSchema: { type: 'object', properties: {} }, ...(controls.noApp ? {} : { _meta: { ui: { resourceUri: resource.uri } } }) }, ...(controls.extraTool ? [{ name: 'extra', description: 'An independent tool', inputSchema: { type: 'object', properties: {} } }] : [])] };
      else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: 'chart values' }], structuredContent: { values: [3, 8] }, _meta: hiddenMeta };
      else if (msg.method === 'resources/list') result = { resources: [resource] };
      else if (msg.method === 'resources/templates/list') result = { resourceTemplates: [] };
      else if (msg.method === 'resources/read') {
        if (msg.params.uri === 'ui://fixture/wait') { held.set('resource', res); req.on('close', () => held.delete('resource')); return; }
        result = { contents: [{ uri: resource.uri, mimeType: resource.mimeType, blob: Buffer.from('<h1>中文图表</h1>').toString('base64'), _meta: resourceMeta }], _meta: { resourceReceipt: 'real-wire' } };
      } else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Missing fixture method' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json', ...(controls.liveNotifications ? { 'mcp-session-id': 'fixture-shared' } : {}) }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); return;
    }
    models.push(msg); res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: msg.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    if (JSON.stringify(msg.messages).includes('hold-model')) { chunk({ role: 'assistant', content: 'waiting' }); held.set('model', res); return; }
    if (!msg.messages.some(item => item.role === 'tool')) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'same-call', type: 'function', function: { name: 'mcp__chart__chart', arguments: '{}' } }] }); chunk({}, 'tool_calls');
    } else { chunk({ role: 'assistant', content: 'chart ready' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'data'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' };
  const mcp = { serverName: 'chart', transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp`, reconnect: { enabled: false } };
  const session = async (options = { mcpServers: [mcp] }) => (await driver.createSession({ sessionId: randomUUID(), cwd: root, provider, model: 'fixture', options })).sessionId;
  return { root, driver, calls, models, held, session, mcp, headers, controls, provider, streams };
}
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await delay(20); assert.ok(predicate(), 'fixture reached expected phase'); }

test('MCP resource approvals are reusable per live server and operation, including template discovery', async t => {
  const { root, driver, session, mcp, calls } = await fixture(t);
  const servers = [mcp, { ...mcp, serverName: 'other' }];
  const id = await session({ mcpServers: servers });
  const store = await openStore(path.join(root, 'approval-host'));
  const s = { id, cwd: root, extensions: [], mcpServers: servers.map(server => ({ name: server.serverName, url: server.url })) };
  await store.update(state => state.sessions.push(s));
  const host = Object.assign(Object.create(Compat.prototype), { store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store) });
  const questions = [];
  let choice = 'allow_always';
  const invoke = (name, server = 'chart', extras = {}) => driver.callTool(id, name, { server, ...(name === 'read_mcp_resource' ? { uri: resource.uri } : {}), ...extras }, {
    onToolPolicy: call => host.toolPolicy(s, call, call.signal),
    onPermission: call => host.approveTool(s, call, { async ask(_method, params) {
      questions.push(params);
      assert.ok(params.options.some(option => option.optionId === 'allow_always'), 'All three resource operations must offer session approval');
      return { outcome: { outcome: 'selected', optionId: choice } };
    } }, call.signal),
  });
  for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
    const before = questions.length;
    const first = await invoke(name);
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal((await invoke(name)).isError, false);
    assert.equal(questions.length, before + 1);
    await driver.configureSession(id, { mcpServers: servers });
    assert.equal((await invoke(name)).isError, false);
    assert.equal(questions.length, before + 1, 'Equivalent next-turn configuration preserves the resource grant');
  }
  choice = 'reject_once';
  const before = calls.filter(call => call.method === 'resources/read').length;
  assert.equal((await invoke('read_mcp_resource', 'other')).isError, true);
  assert.equal(calls.filter(call => call.method === 'resources/read').length, before, 'Another server requires its own approval before dispatch');
  await driver.configureSession(id, { mcpServers: [{ ...mcp, headers: { authorization: 'Bearer changed-fixture' } }] });
  assert.equal((await invoke('read_mcp_resource')).isError, true, 'A replacement connection cannot inherit the grant');
  await store.update(state => { state.sessions[0].mcpServers = [{ name: 'other', url: mcp.url }]; });
  const asked = questions.length;
  assert.equal((await invoke('list_mcp_resource_templates')).isError, true);
  assert.equal(questions.length, asked, 'Disabling the target blocks template discovery even while another server is enabled');
});

test('single official MCP connection preserves exact tool metadata for direct and model calls, without exposing UI-only data to model', async t => {
  const { driver, session, calls, models } = await fixture(t), id = await session();
  const tools = await driver.listTools(id), chart = tools.find(tool => tool.name === 'mcp__chart__chart');
  assert.equal(chart._meta.ui.resourceUri, resource.uri); assert.deepEqual(chart.mcpApp, { resourceUri: resource.uri, extensionName: 'chart', toolName: 'chart' });
  assert.equal((await driver.listTools()).some(tool => tool.name === chart.name), false);
  const denied = await driver.callTool(id, chart.name, {}); assert.equal(denied.isError, true); assert.equal(denied.mcpResult, undefined);
  assert.equal(denied.mcpSource, undefined);
  const directEvents = [];
  const direct = await driver.callTool(id, chart.name, {}, { onPermission: async () => true, onEvent: event => directEvents.push(event) });
  assert.deepEqual(direct.mcpResult._meta, hiddenMeta); assert.deepEqual(direct.mcpResult.structuredContent, { values: [3, 8] });
  const directSource = directEvents.find(event => event.type === 'tool_result').mcpSource;
  assert.deepEqual(directSource, { extensionName: 'chart', toolName: 'chart' });
  const events = []; await driver.prompt(id, 'Show the chart', { onPermission: async () => true, onEvent: event => events.push(event) });
  assert.deepEqual(events.find(event => event.type === 'tool_call').mcpApp, chart.mcpApp);
  assert.deepEqual(events.find(event => event.type === 'tool_result').mcpResult._meta, hiddenMeta);
  assert.deepEqual(events.find(event => event.type === 'tool_result').mcpSource, directSource);
  assert.ok(!JSON.stringify(models).includes(hiddenMeta.privateUiState));
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1, 'metadata uses the same MCP connection, no duplicate probe');
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 2);
});

test('plain MCP receipts preserve original server and tool identity even when the public name is hashed', async t => {
  const { driver, session, controls, mcp } = await fixture(t);
  controls.noApp = true;
  controls.toolName = '原始工具_' + 'long'.repeat(18);
  const id = await session({ mcpServers: [{ ...mcp, serverName: 'Case_Probe' }] });
  const tool = (await driver.listTools(id)).find(t => t.name.startsWith('mcp__'));
  assert.ok(tool);
  assert.ok(tool.name.length <= 64);
  const events = [];
  const result = await driver.callTool(id, tool.name, {}, { onPermission: async () => true, onEvent: event => events.push(event) });
  assert.equal(result.isError, false);
  assert.equal(result.mcpApp, undefined);
  assert.deepEqual(events.find(event => event.type === 'tool_result').mcpSource, { extensionName: 'Case_Probe', toolName: controls.toolName });
});

test('new sessions reuse one remote composition while retaining exact per-session tools, approvals and resources', async t => {
  const { root, driver, session, calls, mcp, provider, held } = await fixture(t);
  const first = await session({ mcpServers: [mcp], toolFilter: { allow: ['read'] } });
  const second = (await driver.createSession({ sessionId: randomUUID(), cwd: path.join(root, 'another-project'), provider, model: 'fixture', options: { mcpServers: [mcp] } })).sessionId;
  const disabled = await session({ mcpServers: [] });
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1);
  assert.equal(calls.filter(call => call.method === 'tools/list').length, 1);
  assert.ok((await driver.listTools(first)).some(tool => tool.name === 'mcp__chart__chart'));
  assert.equal((await driver.listTools(disabled)).some(tool => tool.name === 'mcp__chart__chart'), false);
  assert.equal((await driver.callTool(second, 'mcp__chart__chart', {})).isError, true);
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 0);
  assert.equal((await driver.callTool(first, 'mcp__chart__chart', {}, { onPermission: async () => true })).isError, false);
  assert.deepEqual((await driver.listResources(first, 'chart', undefined, { onPermission: async () => true })).resources, [resource]);
  const controller = new AbortController();
  const pending = driver.readResource(first, 'chart', 'ui://fixture/wait', { onPermission: async () => true, signal: controller.signal });
  pending.catch(() => {}); await until(() => held.has('resource'));
  assert.deepEqual((await driver.listResources(second, 'chart', undefined, { onPermission: async () => true })).resources, [resource]);
  controller.abort(); await assert.rejects(pending, /abort|cancel/i);
  assert.equal((await driver.readResource(second, 'chart', resource.uri, { onPermission: async () => true })).contents[0].uri, resource.uri);
  await driver.configureSession(first, { mcpServers: [] });
  assert.equal((await driver.listTools(first)).some(tool => tool.name === 'mcp__chart__chart'), false);
  assert.deepEqual((await driver.listResources(second, 'chart', undefined, { onPermission: async () => true })).resources, [resource]);
  await driver.releaseNativeSessionCapabilities(second);
  assert.equal((await driver.listTools(second)).some(tool => tool.name === 'mcp__chart__chart'), false);
  const third = await session({ mcpServers: [{ reconnect: mcp.reconnect, url: mcp.url, transport: mcp.transport, serverName: mcp.serverName }] });
  assert.equal((await driver.callTool(third, 'mcp__chart__chart', {}, { onPermission: async () => true })).isError, false);
  assert.equal(calls.filter(call => call.method === 'initialize').length, 2, 'explicit removal retires the old composition while existing leases remain usable');
});

test('credential changes select another composition and old sessions retain their own connection after retirement', async t => {
  const { driver, session, calls, headers, mcp } = await fixture(t);
  const old = await session({ mcpServers: [{ ...mcp, headers: { authorization: 'Bearer fixture-old' } }] });
  const fresh = await session({ mcpServers: [{ ...mcp, headers: { authorization: 'Bearer fixture-new' } }] });
  assert.equal(calls.filter(call => call.method === 'initialize').length, 2);
  for (let i = 0; i < 8; i++) await session({ mcpServers: [{ ...mcp, headers: { authorization: `Bearer fixture-${i}` } }] });
  const initialized = calls.filter(call => call.method === 'initialize').length;
  assert.equal((await driver.callTool(old, 'mcp__chart__chart', {}, { onPermission: async () => true })).isError, false);
  assert.equal(headers.at(-1), 'Bearer fixture-old');
  assert.equal((await driver.callTool(fresh, 'mcp__chart__chart', {}, { onPermission: async () => true })).isError, false);
  assert.equal(headers.at(-1), 'Bearer fixture-new');
  assert.equal(calls.filter(call => call.method === 'initialize').length, initialized, 'retired but leased revisions remain connected');
  await driver.configureSession(old, { mcpServers: [{ ...mcp, headers: { authorization: 'Bearer fixture-7' } }] });
  await driver.callTool(old, 'mcp__chart__chart', {}, { onPermission: async () => true });
  assert.equal(headers.at(-1), 'Bearer fixture-7');
  assert.equal(calls.filter(call => call.method === 'initialize').length, initialized);
});

test('startup preparation leases native remote MCP without creating a model request and the first chat reuses it', async t => {
  const { driver, session, calls, models, mcp } = await fixture(t);
  await driver.warmMcpServers([mcp]);
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1);
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 0);
  assert.equal(models.length, 0);
  const id = await session();
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1);
  assert.equal((await driver.callTool(id, 'mcp__chart__chart', {}, { onPermission: () => true })).isError, false);
  await assert.rejects(driver.warmMcpServers([{ transport: 'stdio', command: 'unused' }]), /remote MCP/);
});

test('failed shared startup is not cached and later new sessions recover without losing other capabilities', async t => {
  const { driver, session, calls, controls, mcp } = await fixture(t);
  controls.rejectInitialize = true;
  const first = await session();
  assert.equal((await driver.extensionStatus(first))[0].status, 'error');
  assert.ok((await driver.listTools(first)).some(tool => tool.name === 'read'));
  const attempts = calls.filter(call => call.method === 'initialize').length;
  controls.rejectInitialize = false;
  const next = await session();
  assert.equal((await driver.extensionStatus(next))[0].status, 'ready');
  assert.ok(calls.filter(call => call.method === 'initialize').length > attempts);
  assert.equal((await driver.callTool(next, 'mcp__chart__chart', {}, { onPermission: async () => true })).isError, false);
  await driver.configureSession(first, { mcpServers: [mcp] });
  assert.equal((await driver.extensionStatus(first))[0].status, 'ready');
});

test('unrelated MCP list refresh preserves an existing session grant, changed metadata revokes it', async t => {
  const { root, driver, session, controls, streams } = await fixture(t);
  controls.liveNotifications = true;
  const id = await session();
  const store = await openStore(path.join(root, 'approval-store'));
  const s = { id, cwd: root, type: 'code_pro', workspaceBinding: 'writable_project', mcpServers: [{ name: 'chart', type: 'http', url: 'http://fixture' }] };
  await store.update(state => state.sessions.push(s));
  const host = Object.assign(Object.create(Compat.prototype), { store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store) });
  let asked = 0;
  const invoke = () => driver.callTool(id, 'mcp__chart__chart', {}, {
    onToolPolicy: call => host.toolPolicy(s, call, call.signal),
    onPermission: call => host.approveTool(s, call, { async ask() {
      asked++; return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
    } }, call.signal),
  });
  assert.equal((await invoke()).isError, false);
  assert.equal(asked, 1);
  await until(() => streams.size > 0);
  const refresh = () => { for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`); };
  controls.extraTool = true; refresh();
  for (let i = 0; i < 100; i++) { if ((await driver.listTools(id)).some(tool => tool.name === 'mcp__chart__extra')) break; await delay(20); }
  assert.ok((await driver.listTools(id)).some(tool => tool.name === 'mcp__chart__extra'));
  assert.equal((await invoke()).isError, false);
  assert.equal(asked, 1, 'An unrelated added tool must not erase the unchanged tool grant');
  controls.noApp = true; refresh();
  for (let i = 0; i < 100; i++) { if (!(await driver.listTools(id)).find(tool => tool.name === 'mcp__chart__chart').mcpApp) break; await delay(20); }
  assert.equal((await driver.listTools(id)).find(tool => tool.name === 'mcp__chart__chart').mcpApp, undefined);
  assert.equal((await invoke()).isError, false);
  assert.equal(asked, 2, 'Changed tool metadata requires a fresh explicit grant');
});

test('shared MCP tool-list changes reach every restricted session without reconnecting or exposing disabled native tools', async t => {
  const { driver, session, calls, controls, streams, mcp } = await fixture(t);
  controls.liveNotifications = true;
  const first = await session({ mcpServers: [mcp], toolFilter: { allow: ['read'] } });
  const second = await session({ mcpServers: [mcp], toolFilter: { allow: ['read'] } });
  await until(() => streams.size > 0);
  controls.toolName = 'updated';
  for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
  for (let i = 0; i < 100; i++) { if ((await driver.listTools(first)).some(tool => tool.name === 'mcp__chart__updated')) break; await delay(20); }
  for (const id of [first, second]) {
    const names = (await driver.listTools(id)).map(tool => tool.name);
    assert.ok(names.includes('mcp__chart__updated'));
    assert.ok(!names.includes('mcp__chart__chart') && !names.includes('pwsh'));
    assert.equal((await driver.callTool(id, 'mcp__chart__updated', {}, { onPermission: async () => true })).isError, false);
  }
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1);
});

test('official scoped resource tools read while model runs, enforce permission and cancel actual HTTP request', async t => {
  const { driver, session, calls, held } = await fixture(t), id = await session(), other = await session({ mcpServers: [] });
  await assert.rejects(driver.readResource(id, 'chart', resource.uri), /approval|declined|failed/i);
  assert.equal(calls.filter(call => call.method === 'resources/read').length, 0);
  await assert.rejects(driver.readResource(other, 'chart', resource.uri, { onPermission: async () => true }), /unknown|unavailable|not found/i);
  const approval = tool => ['read_mcp_resource', 'list_mcp_resources'].includes(tool.name) && tool.arguments.server === 'chart';
  const active = driver.prompt(id, 'hold-model'); await until(() => held.has('model'));
  assert.deepEqual((await driver.listResources(id, 'chart', undefined, { onPermission: approval })).resources, [resource]);
  const read = await driver.readResource(id, 'chart', resource.uri, { onPermission: approval });
  assert.deepEqual(read.contents[0]._meta, resourceMeta); assert.equal(read._meta.resourceReceipt, 'real-wire');
  assert.equal(Buffer.from(read.contents[0].blob, 'base64').toString('utf8'), '<h1>中文图表</h1>');
  const controller = new AbortController(), pending = driver.readResource(id, 'chart', 'ui://fixture/wait', { onPermission: approval, signal: controller.signal });
  pending.catch(() => {}); await until(() => held.has('resource')); controller.abort();
  await assert.rejects(pending, /cancel|abort/i); await driver.cancel(id); assert.equal((await active).stopReason, 'cancelled');
});

test('stdio MCP launches once and closes its actual child process on session disposal', async t => {
  const { root, driver, session } = await fixture(t), script = path.join(root, 'server.mjs'), receipt = path.join(root, 'pid.txt');
  await writeFile(script, `import {writeFileSync} from 'node:fs'; import {createInterface} from 'node:readline';writeFileSync(process.argv[2],String(process.pid));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{},resources:{}},serverInfo:{name:'stdio',version:'1'}}:m.method==='tools/list'?{tools:[]}:m.method==='resources/list'?{resources:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const id = await session({ mcpServers: [{ serverName: 'local', transport: 'stdio', command: process.execPath, args: [script, receipt], cwd: root, reconnect: { enabled: false } }] });
  const pid = Number(await readFile(receipt, 'utf8')); assert.ok(pid > 0); assert.doesNotThrow(() => process.kill(pid, 0));
  assert.deepEqual(await driver.listResources(id, 'local', undefined, { onPermission: async () => true }), { resources: [] });
  await driver.configureSession(id, { mcpServers: [] });
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('stdio reconnect waits for the old process to close and republishes one scoped resource provider', async t => {
  const { root, driver, session } = await fixture(t), script = path.join(root, 'restart-server.mjs'), receipt = path.join(root, 'starts.json');
  await writeFile(script, `import {readFileSync,writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';let pids=[];try{pids=JSON.parse(readFileSync(process.argv[2],'utf8'))}catch{};pids.push(process.pid);writeFileSync(process.argv[2],JSON.stringify(pids));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{},resources:{}},serverInfo:{name:'retry',version:'1'}}:m.method==='tools/list'?{tools:[]}:m.method==='resources/list'?{resources:[{uri:'fixture://generation/'+pids.length,name:'generation'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});if(pids.length===1)setTimeout(()=>process.exit(0),300);`);
  const id = await session({ mcpServers: [{ serverName: 'retry', transport: 'stdio', command: process.execPath, args: [script, receipt], cwd: root, reconnect: { initialDelayMs: 10, maxDelayMs: 50, maxAttempts: 2 } }] });
  let pids = [];
  for (let i = 0; i < 100; i++) { pids = JSON.parse(await readFile(receipt, 'utf8')); if (pids.length === 2) break; await delay(20); }
  assert.equal(pids.length, 2); assert.throws(() => process.kill(pids[0], 0), /ESRCH/);
  let listed;
  for (let i = 0; i < 50; i++) { try { listed = await driver.listResources(id, 'retry', undefined, { onPermission: async () => true }); break; } catch { await delay(20); } }
  assert.equal(listed.resources[0].uri, 'fixture://generation/2');
  await driver.configureSession(id, { mcpServers: [] }); assert.throws(() => process.kill(pids[1], 0), /ESRCH/);
});
