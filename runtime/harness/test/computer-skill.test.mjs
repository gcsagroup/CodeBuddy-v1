import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../index.mjs';

test('first request exposes the desktop skill; loading it preserves deferred tools and input permissions', { timeout: 60000 }, async t => {
  const requests = [], desktopCalls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (req.url === '/mcp') {
      if (!('id' in message)) { res.writeHead(202).end(); return; }
      let result = {};
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'desktop-fixture', version: '1' } };
      if (message.method === 'tools/list') result = { tools: ['list_apps', 'get_app_state', 'press_key'].map(name => ({ name, description: 'Desktop window operation', inputSchema: { type: 'object', properties: {} } })) };
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
  assert.equal(desktopCalls.length, 0, 'loading instructions does not perform desktop actions');
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
  assert.deepEqual(desktopCalls, ['list_apps'], 'skill loading must not authorize input');
});
