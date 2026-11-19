import { replyToNoActionReview } from './review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../index.mjs';
const { installToolDiscovery } = await import('../tool-discovery.mjs');

test('compact discovery gives the actual desktop skill entry only for an eligible connected chat', () => {
  const catalog = [{ name: 'skill' }];
  const sections = new Map(), hooks = new Map();
  const ctx = { tools: { schemas: () => catalog, register() {}, get() {} },
    systemPrompt: { section: section => sections.set(section.name, section) },
    on: (name, hook) => hooks.set(name, hook) };
  const agent = { id: 'main', session: { log: [], requestHeader() {} } };
  installToolDiscovery(ctx, agent, undefined, () => true, true);
  const hint = () => sections.get('codebuddy:mcp-discovery').text();
  assert.equal(hint(), '');
  catalog.push({ name: 'mcp__qwen_computer__get_app_state' });
  assert.match(hint(), /skill\(\{"name":"computer-use"\}\)/);
  assert.match(hint(), /named application, window, or on-screen form/);
  assert.match(hint(), /do not substitute shell UI scripts/,
    'compact roles must receive the desktop execution boundary before selecting a skill');
  assert.match(hint(), /current control receipts/);
  catalog.shift();
  assert.match(hint(), /mcp__qwen_computer__get_app_state/);
  assert.doesNotMatch(hint(), /skill\(|mcp__qwen_computer__list_apps/);
  catalog.push({ name: 'skill' });
  hooks.get('tools/result')({ agent, name: 'skill' }, { value: { name: 'computer-use', provider: 'codebuddy-computer-skill' } });
  assert.equal(hint(), '');
});

test('desktop skill revelation respects scoped registries and the originating agent', async () => {
  const hooks = new Map(), sections = new Map();
  const catalog = [{ name: 'mcp__qwen_computer__list_apps', parameters: { type: 'object' } }];
  const agent = { id: 'observer', session: { requestHeader: () => undefined } };
  const ctx = { tools: { schemas: () => catalog, register() {}, get() {} },
    systemPrompt: { section(section) { sections.set(section.name, section); } }, on: (name, fn) => hooks.set(name, fn) };
  installToolDiscovery(ctx, agent);
  const assemble = () => hooks.get('system-prompt/assemble')({}, {}, async () => ({ tools: catalog }));
  const loaded = { value: { name: 'computer-use', provider: 'codebuddy-computer-skill' } };
  hooks.get('tools/result')({ agent: { id: 'other' }, name: 'skill' }, loaded);
  assert.equal((await assemble()).tools.length, 0, 'another agent cannot alter this observer');
  hooks.get('tools/result')({ agent, name: 'skill' }, { ...loaded, isError: true });
  assert.equal((await assemble()).tools.length, 0, 'failed skill loads reveal nothing');
  hooks.get('tools/result')({ agent, name: 'skill' }, loaded);
  assert.deepEqual((await assemble()).tools.map(tool => tool.name), ['mcp__qwen_computer__list_apps'],
    'masked launch/input tools are not added to a restricted observer');
  const availability = () => sections.get('codebuddy:desktop-availability').text();
  assert.match(availability(), /open_path is unavailable in this connection/,
    'a scoped registry without launch support must not invite an extra discovery round');
  catalog.push({ name: 'mcp__qwen_computer__open_path', parameters: { type: 'object' } });
  assert.match(availability(), /Use open_path for a known local document\/folder/);
  assert.doesNotMatch(availability(), /open_path is unavailable/,
    'reconnection must use the current registry instead of caching platform assumptions');
  catalog.pop();
  assert.match(availability(), /open_path is unavailable/);
});

test('compact first request offers the selected pending desktop connection without forcing an action', { timeout: 30000 }, async t => {
  let release;
  const connecting = new Promise(resolve => { release = resolve; });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (replyToNoActionReview(message, res)) return;
    if (req.url === '/mcp') {
      if (!('id' in message)) { res.writeHead(202).end(); return; }
      if (message.method === 'initialize') await connecting;
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slow-desktop', version: '1' } }
        : { tools: [] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); return;
    }
    requests.push(message);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'No action.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'pending-desktop-'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { release(); await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const options = { mainAgentRole: { baseline: () => null, input: () => null }, backgroundMcp: true };
  const create = mcpServers => driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl, contextWindow: 65536 }, model: 'fixture', options: { ...options, mcpServers } });
  const pending = await create([{ serverName: 'qwen_computer', transport: 'streamable-http', url: `${baseUrl}/mcp`, backgroundStart: true }]);
  await driver.prompt(pending.sessionId, '请检查目标窗口。');
  assert.match(JSON.stringify(requests.at(-1).messages), /Pending MCP: qwen_computer/);
  assert.ok(requests.at(-1).messages.some(message => JSON.stringify(message).includes('servers')));
  const prompt = requests.at(-1).messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  assert.ok(prompt.includes('search_mcp_tools({"names":["skill"],"servers":["qwen_computer"]})'));
  assert.match(prompt, /do not substitute shell UI scripts/);
  assert.equal(requests.at(-1).tools.some(tool => tool.function.name.startsWith('mcp__')), false);
  const absent = await create([]);
  await driver.prompt(absent.sessionId, '请检查目标窗口。');
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /reveal the connected desktop tools/);
});

test('first request exposes the desktop skill; loading it preserves deferred tools and input permissions', { timeout: 60000 }, async t => {
  const requests = [], desktopCalls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (replyToNoActionReview(message, res)) return;
    if (req.url === '/mcp') {
      if (!('id' in message)) { res.writeHead(202).end(); return; }
      let result = {};
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'desktop-fixture', version: '1' } };
      if (message.method === 'tools/list') result = { tools: ['open_path', 'list_apps', 'get_app_state', 'click', 'press_key', 'type_text', 'drag', 'scroll', 'set_value', 'perform_secondary_action'].map(name => ({ name, description: 'Desktop window operation', inputSchema: name === 'drag' ? { type: 'object', properties: { app: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } }, required: ['app', 'from_x', 'from_y', 'to_x', 'to_y'] } : { type: 'object', properties: {} } })) };
      if (message.method === 'tools/call') { desktopCalls.push(message.params.name); result = { content: [{ type: 'text', text: 'fixture' }] }; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); return;
    }
    requests.push(message);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    // The fixture chooses by request sequence, never by user-text keywords.
    if (requests.length === 1) {
      emit({ tool_calls: [{ index: 0, id: 'load-skill', type: 'function', function: { name: 'skill', arguments: JSON.stringify({ name: 'computer-use' }) } }] });
      emit({}, 'tool_calls');
    } else { emit({ content: 'fixture response' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'computer-skill-'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { sessionId } = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl, contextWindow: 65536 }, model: 'fixture', options: { mcpServers: [{ serverName: 'qwen_computer', transport: 'streamable-http', url: `${baseUrl}/mcp` }] } });
  const bundled = (await driver.listBuiltinSkills(root)).find(skill => skill.name === 'computer-use');
  assert.equal(bundled?.source, 'bundled');
  await driver.prompt(sessionId, '请完成当前任务。', { onPermission: async () => true });
  assert.equal(requests.length, 2, 'model-selected skill completes within the first user turn');
  assert.match(JSON.stringify(requests[1].messages), /Tool exit code 0.*not completion evidence/);
  assert.match(JSON.stringify(requests[1].messages), /Activation denied is a foreground handoff/,
    'the actual post-skill request must distinguish an OS activation refusal from stale element recovery');
  assert.match(JSON.stringify(requests[1].messages), /fresh read of a background window does not resolve/);
  assert.equal(desktopCalls.length, 0, 'loading instructions does not perform desktop actions');
  for (const name of ['open_path', 'list_apps', 'get_app_state', 'click', 'press_key', 'type_text', 'drag', 'scroll', 'set_value', 'perform_secondary_action'])
    assert.ok(requests[1].tools.some(tool => tool.function.name === `mcp__qwen_computer__${name}`), 'skill load removes the extra discovery round');
  assert.deepEqual(requests[1].tools.find(tool => tool.function.name === 'mcp__qwen_computer__drag').function.parameters.required,
    ['app', 'from_x', 'from_y', 'to_x', 'to_y'], 'the first post-skill model request receives the actual drag schema, not just its name');
  assert.match(JSON.stringify(requests[1].messages), /Entry tool schemas are loaded/);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'skill'), 'first-turn instructions loader must be directly callable');
  assert.match(JSON.stringify(requests[0].messages), /computer-use.*Desktop computer use/);
  assert.match(JSON.stringify(requests[0].messages), /do not substitute shell UI scripts/);
  assert.equal(requests[0].tools.some(tool => tool.function.name.startsWith('mcp__')), false, 'full desktop schemas stay deferred');
  const other = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl, contextWindow: 65536 }, model: 'fixture' });
  await driver.prompt(other.sessionId, '打开桌面聊天软件并操作窗口。');
  assert.equal(requests.length, 3, 'host must not force a skill when the model chooses a normal reply');
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /Tool exit code 0.*not completion evidence/);
  const loaded = await driver.callTool(sessionId, 'skill', { name: 'computer-use' }, { onPermission: async () => true });
  assert.equal(loaded.isError, false);
  const content = JSON.stringify(loaded);
  assert.match(content, /mcp__qwen_computer__list_apps/);
  assert.match(content, /Tool exit code 0.*not completion evidence/);
  await driver.callTool(sessionId, 'search_mcp_tools', { names: ['mcp__qwen_computer__list_apps', 'mcp__qwen_computer__press_key'] }, { onPermission: async () => true });
  await driver.callTool(sessionId, 'mcp__qwen_computer__list_apps', {}, { onPermission: async () => true });
  const denied = await driver.callTool(sessionId, 'mcp__qwen_computer__press_key', {}, { onPermission: async () => false });
  assert.equal(denied.isError, true);
  const deniedLaunch = await driver.callTool(sessionId, 'mcp__qwen_computer__open_path', {}, { onPermission: async () => false });
  assert.equal(deniedLaunch.isError, true, 'revealing a launch schema never grants launch permission');
  assert.deepEqual(desktopCalls, ['list_apps'], 'skill loading must not authorize input');
  await driver.callTool(other.sessionId, 'skill', { name: 'computer-use' }, { onPermission: async () => true });
  await driver.prompt(other.sessionId, '继续');
  assert.match(JSON.stringify(requests.at(-1).messages), /no computer-control tools are available/);
  assert.equal(requests.at(-1).tools.some(tool => tool.function.name.startsWith('mcp__qwen_computer__')), false, 'offline skill never creates a connection');
  const compact = await driver.createSession({ cwd: root,
    provider: { id: 'fixture', baseUrl, contextWindow: 65536 }, model: 'fixture',
    options: { mainAgentRole: { baseline: () => null, input: () => null },
      mcpServers: [{ serverName: 'qwen_computer', transport: 'streamable-http', url: `${baseUrl}/mcp` }] } });
  await driver.prompt(compact.sessionId, '请在指定工单填写联系人，保留其他字段。');
  assert.match(JSON.stringify(requests.at(-1).messages), /named application, window, or on-screen form/);
  assert.match(JSON.stringify(requests.at(-1).messages), /do not substitute shell UI scripts/,
    'the real compact first request must retain the same UI execution boundary as full discovery');
  assert.match(JSON.stringify(requests.at(-1).messages), /current control receipts/);
  assert.equal(requests.at(-1).tools.some(tool => tool.function.name.startsWith('mcp__qwen_computer__')), false,
    'guidance does not force skill selection or bypass scoped tool discovery');
});
