import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../index.mjs';

test('native templates preserve chat-local histories, roles and resolved models across turns and cold restart', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-template-contract-'));
  const script = join(root, 'mcp-fixture.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline'; createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:['allowed','blocked'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}))}:{content:[{type:'text',text:'fixture'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const requests = [], plans = new Map();
  const isChild = request => request.messages.some(message => message.role === 'user' && (JSON.stringify(message.content).includes('Your parent agent id is') || (typeof message.content === 'string' && message.content.startsWith('CHILD_'))));
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (req.url === '/mcp') {
      if (!('id' in body)) { res.writeHead(202).end(); return; }
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'remote', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'blocked', description: 'Remote fixture', inputSchema: { type: 'object', properties: {} } }] }
        : body.method === 'resources/list' ? { resources: [] } : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    requests.push({ ...body, url: req.url });
    const child = isChild(body);
    const index = body.messages.findLastIndex(message => message.role === 'user' && /ROOT_ACTION_\d+/.test(JSON.stringify(message.content)));
    const action = index < 0 ? undefined : JSON.stringify(body.messages[index].content).match(/ROOT_ACTION_\d+/)[0];
    const childIndex = body.messages.findLastIndex(message => message.role === 'user' && ['CHILD_SAVED_INITIAL', 'CHILD_SAVED_COLD', 'CHILD_FRONTEND_ONLY'].some(marker => JSON.stringify(message.content).includes(marker)));
    const tool = child && childIndex >= 0 && !body.messages.slice(childIndex + 1).some(message => message.role === 'tool')
      ? { name: 'search_mcp_tools', args: { names: JSON.stringify(body.messages[childIndex].content).includes('CHILD_FRONTEND_ONLY')
        ? ['subagent', 'send_message'] : ['grep', 'write', 'mcp__local__allowed', 'mcp__local__blocked', 'fixture_host_tool'] } }
      : !child && action && !body.messages.slice(index + 1).some(message => message.role === 'tool') ? plans.get(action) : undefined;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (tool) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, null);
      emit({}, 'tool_calls');
    } else { emit({ role: 'assistant', content: child ? 'Child completed its assigned task.' : 'Main conversation received the result.' }, null); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only', contextWindow: 32768 };
  const models = Object.fromEntries(['explorer', 'browser', 'generic'].map(role => [role, { provider, model: `fixture-${role}` }]));
  let currentProvider = provider;
  const restoreSubagentProvider = async (_model, matches) => matches(currentProvider) ? currentProvider : undefined;
  const custom = { id: 'saved-review', name: '保存的审查员', description: '在需要独立代码审查时使用', prompt: 'SAVED_RESPONSIBILITY {{literal}}: 只审查本次给定任务，并报告证据。', model: null, tools: 'read-only' };
  const options = { conversationLocale: 'zh-CN', subagentModels: models, subagentTemplates: [custom], restoreSubagentProvider,
    tools: ['fixture_host_tool', 'fixture_allowed_tool'].map(name => ({ name, description: 'Fixture host capability', inputSchema: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'fixture' }] }) })),
    mcpServers: [
      { serverName: 'local', transport: 'stdio', command: process.execPath, args: [script], cwd: root, reconnect: { enabled: false } },
      { serverName: 'remote', transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp`, reconnect: { enabled: false } },
    ],
  };
  let driver;
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
  const main = await driver.createSession({ sessionId: randomUUID(), provider, model: 'fixture-main', options });
  assert.equal(requests.length, 0, 'Templates must not prestart children or call a model');
  assert.deepEqual(await driver.listSubagentChildren(main.sessionId), []);
  let sequence = 0;
  async function action(sessionId, name, args, extra = '') {
    const marker = `ROOT_ACTION_${++sequence}`; plans.set(marker, { name, args });
    const events = [];
    const result = await driver.prompt(sessionId, marker + extra, { onEvent: event => events.push(event), onPermission: () => true });
    assert.notEqual(result.stopReason, 'error');
    const receipt = events.find(event => event.type === 'tool_result' && event.name === name && event.sessionId === sessionId);
    assert.ok(receipt, `Missing actual tool receipt for ${name}`);
    return receipt;
  }
  const spawn = async (sessionId, name, args, extra) => {
    const receipt = await action(sessionId, name, args, extra);
    assert.equal(receipt.isError, false, JSON.stringify(receipt));
    assert.equal(receipt.internalControl, true, "Template receipts must keep the internal-control identity");
    return receipt.structuredContent.subagentId;
  };
  const byTask = marker => requests.filter(request => isChild(request) && request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(marker)));
  assert.equal((await action(main.sessionId, 'subagent', { role: 'Reviewer' })).isError, true);
  assert.deepEqual(await driver.listSubagentChildren(main.sessionId), []);
  const saved = await spawn(main.sessionId, 'subagent', { template: custom.id, prompt: 'CHILD_SAVED_INITIAL' });
  const followup = requests.filter(request => !isChild(request)).at(-1).tools.find(tool => tool.function.name === 'send_message');
  assert.ok(followup?.function.parameters.required.includes('agent_id'), 'After a successful spawn the parent sees how to address its child');
  const savedRequest = byTask('CHILD_SAVED_INITIAL').at(-1);
  assert.ok(savedRequest, 'The native child must receive the delegated task');
  const requestCount = requests.length;
  const observer = new AbortController();
  const feed = driver.followSubagent({ parentSessionId: main.sessionId, childSessionId: saved, mode: 'unknown' }, observer.signal);
  const snapshot = (await feed.next()).value;
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.header.id, saved);
  assert.ok(snapshot.records.some(row => row.event?.type === 'assistant/message'));
  observer.abort();
  await feed.return();
  assert.equal(requests.length, requestCount, 'Viewing and closing a child must never invoke the model');
  assert.equal(savedRequest.model, 'fixture-main', 'Custom inheritance must not use the generic role model override');
  assert.equal((await driver.listSubagentChildren(main.sessionId)).find(row => row.id === saved).label, custom.name);
  assert.match(JSON.stringify(savedRequest.messages.filter(message => message.role === 'system')), /SAVED_RESPONSIBILITY/);
  // The bundled computer guide makes the already-allowed read-only skill loader available.
  assert.deepEqual(savedRequest.tools.map(tool => tool.function.name).sort(), ['read', 'grep', 'skill', 'search_mcp_tools'].sort(), 'Discovery only exposes the native-filtered child tool catalog');
  assert.ok(savedRequest.messages.some(message => message.role === 'tool' && message.content.includes('"missingNames":["write","mcp__local__allowed","mcp__local__blocked","fixture_host_tool"]')), 'Read-only discovery cannot load native writes, MCP or host tools');
  const rootSchema = (await driver.listTools(main.sessionId)).find(tool => tool.name === 'subagent');
  assert.ok(JSON.stringify(rootSchema).includes(custom.description));
  assert.ok(!JSON.stringify(rootSchema).includes('SAVED_RESPONSIBILITY'), 'Parent sees when to delegate, not the full child persona');
  for (const args of [{ template: 'missing-template' }, { template: custom.id, role: 'Override saved role' }]) {
    assert.equal((await action(main.sessionId, 'subagent', { description: 'Invalid template', prompt: 'NO_CHILD_CREATED', ...args })).isError, true);
  }
  const explorer = await spawn(main.sessionId, 'subagent_explorer', { description: 'Read August', prompt: 'CHILD_AUGUST_ONLY' }, ' ROOT_PRIVATE_CANARY');
  assert.equal(byTask('CHILD_AUGUST_ONLY').at(-1).model, 'fixture-explorer');
  assert.ok(byTask('CHILD_AUGUST_ONLY').every(request => !JSON.stringify(request).includes('ROOT_PRIVATE_CANARY')));
  await action(main.sessionId, 'send_message', { agent_id: explorer, message: 'CHILD_JULY_ONLY' });
  assert.equal((await driver.listSubagentChildren(main.sessionId)).length, 2);
  assert.ok(byTask('CHILD_JULY_ONLY').at(-1).messages.some(message => JSON.stringify(message.content).includes('CHILD_AUGUST_ONLY')));
  assert.ok(byTask('CHILD_JULY_ONLY').at(-1).tools.every(tool => !['write', 'edit', 'pwsh', 'bash'].includes(tool.function.name)));
  await assert.rejects(driver.callTool(explorer, 'write', { file_path: join(root, 'must-not-exist'), content: 'no' }), /owned by subagent routing/);
  const role = '代码审查 {{component}}';
  const reviewer = await spawn(main.sessionId, 'subagent', { role, prompt: 'CHILD_FRONTEND_ONLY' });
  assert.ok(byTask('CHILD_FRONTEND_ONLY').at(-1).messages.some(message => message.role === 'tool' && message.content.includes('"missingNames":["subagent"]')));
  await action(main.sessionId, 'send_message', { agent_id: reviewer, message: 'CHILD_BACKEND_ONLY' });
  assert.equal((await driver.listSubagentChildren(main.sessionId)).find(row => row.id === reviewer).label, role);
  assert.equal(byTask('CHILD_BACKEND_ONLY').at(-1).model, 'fixture-generic');
  assert.ok(JSON.stringify(byTask('CHILD_BACKEND_ONLY').at(-1)).includes('代码审查'));
  for (const request of [requests[0], byTask('CHILD_JULY_ONLY').at(-1), byTask('CHILD_BACKEND_ONLY').at(-1)]) {
    const instructions = JSON.stringify(request.messages.filter(message => ['system', 'developer'].includes(message.role)));
    assert.ok(instructions.includes('Write delegation prompts and follow-up messages'), 'The shared conversation-language instruction must survive template and custom child personas');
    assert.ok(instructions.includes('zh-CN'), 'The explicit UI language hint must reach both parent and children');
  }
  await spawn(main.sessionId, 'subagent_browser', { description: 'Browser research', prompt: 'CHILD_BROWSER_ONLY' });
  assert.equal(byTask('CHILD_BROWSER_ONLY').at(-1).model, 'fixture-browser');
  const other = await driver.createSession({ sessionId: randomUUID(), provider, model: 'fixture-other', options: { restoreSubagentProvider } });
  const otherExplorer = await spawn(other.sessionId, 'subagent_explorer', { description: 'Independent exploration', prompt: 'CHILD_OTHER_CHAT_ONLY' });
  assert.notEqual(otherExplorer, explorer);
  assert.equal(byTask('CHILD_OTHER_CHAT_ONLY').at(-1).model, 'fixture-other', 'Unset template model inherits the actual parent model');
  assert.ok(!JSON.stringify(byTask('CHILD_OTHER_CHAT_ONLY')).includes('CHILD_AUGUST_ONLY'));
  assert.equal((await action(other.sessionId, 'send_message', { agent_id: explorer, message: 'FOREIGN_MUST_NOT_ARRIVE' })).isError, true);
  assert.equal(byTask('FOREIGN_MUST_NOT_ARRIVE').length, 0);
  const updated = { ...options, subagentTemplates: [{ ...custom, name: '改名后的审查员', prompt: 'UPDATED_RESPONSIBILITY', model: { provider, model: 'fixture-custom' }, tools: 'none' }], subagentModels: { ...models, explorer: { provider, model: 'fixture-explorer-updated' } } };
  await driver.configureSession(main.sessionId, updated);
  await action(main.sessionId, 'send_message', { agent_id: saved, message: 'CHILD_SAVED_AFTER_EDIT' });
  assert.equal(byTask('CHILD_SAVED_AFTER_EDIT').at(-1).model, 'fixture-main');
  assert.match(JSON.stringify(byTask('CHILD_SAVED_AFTER_EDIT').at(-1).messages), /SAVED_RESPONSIBILITY/);
  assert.ok(!JSON.stringify(byTask('CHILD_SAVED_AFTER_EDIT').at(-1).messages).includes('UPDATED_RESPONSIBILITY'));
  await spawn(main.sessionId, 'subagent', { description: 'Changed template', template: custom.id, prompt: 'CHILD_UPDATED_TEMPLATE' });
  assert.equal(byTask('CHILD_UPDATED_TEMPLATE').at(-1).model, 'fixture-custom');
  assert.deepEqual(byTask('CHILD_UPDATED_TEMPLATE').at(-1).tools?.map(tool => tool.function.name) ?? [], []);
  await action(main.sessionId, 'send_message', { agent_id: explorer, message: 'CHILD_OLD_MODEL_ONLY' });
  assert.equal(byTask('CHILD_OLD_MODEL_ONLY').at(-1).model, 'fixture-explorer');
  const updatedExplorer = await spawn(main.sessionId, 'subagent_explorer', { description: 'New independent exploration', prompt: 'CHILD_NEW_MODEL_ONLY' });
  assert.notEqual(updatedExplorer, explorer);
  assert.equal(byTask('CHILD_NEW_MODEL_ONLY').at(-1).model, 'fixture-explorer-updated');
  await driver.close();
  currentProvider = { ...provider, outputTokenCapacity: 8192 };
  driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
  const coldCount = requests.length, coldObserver = new AbortController();
  const coldFeed = driver.followSubagent({ parentSessionId: main.sessionId, childSessionId: saved, mode: 'unknown' }, coldObserver.signal);
  assert.equal((await coldFeed.next()).value.header.id, saved);
  coldObserver.abort();
  await coldFeed.return();
  assert.equal(requests.length, coldCount, 'Cold viewing must not restore an executing child or invoke a provider');
  await driver.createSession({ sessionId: main.sessionId, provider, model: 'fixture-main', options: { ...updated, subagentTemplates: [] } });
  const before = (await driver.listSubagentChildren(main.sessionId)).map(row => row.id);
  await action(main.sessionId, 'send_message', { agent_id: saved, message: 'CHILD_SAVED_COLD' });
  const coldSaved = byTask('CHILD_SAVED_COLD').at(-1);
  assert.equal(coldSaved.model, 'fixture-main');
  assert.match(JSON.stringify(coldSaved.messages), /SAVED_RESPONSIBILITY/);
  assert.deepEqual(coldSaved.tools.map(tool => tool.function.name).sort(), ['read', 'grep', 'skill', 'search_mcp_tools'].sort(), 'Deleting a template does not change a cold child tool restriction');
  await action(main.sessionId, 'send_message', { agent_id: explorer, message: 'CHILD_COLD_CONTINUE_ONLY' });
  assert.equal(byTask('CHILD_COLD_CONTINUE_ONLY').at(-1).model, 'fixture-explorer');
  assert.ok(JSON.stringify(byTask('CHILD_COLD_CONTINUE_ONLY').at(-1)).includes('CHILD_JULY_ONLY'));
  await action(main.sessionId, 'send_message', { agent_id: reviewer, message: 'CHILD_COLD_REVIEW_ONLY' });
  assert.equal(byTask('CHILD_COLD_REVIEW_ONLY').at(-1).model, 'fixture-generic');
  assert.ok(JSON.stringify(byTask('CHILD_COLD_REVIEW_ONLY').at(-1)).includes('代码审查'));
  assert.ok(JSON.stringify(byTask('CHILD_COLD_REVIEW_ONLY').at(-1).messages.filter(message => ['system', 'developer'].includes(message.role))).includes('Write delegation prompts and follow-up messages'), 'Cold-resumed children retain the conversation-language instruction');
  assert.deepEqual((await driver.listSubagentChildren(main.sessionId)).map(row => row.id), before);
  await driver.configureSession(main.sessionId, { ...updated, subagentModels: { ...updated.subagentModels, explorer: { error: 'Configured explorer connection unavailable' } } });
  assert.equal((await action(main.sessionId, 'subagent_explorer', { description: 'Unavailable route', prompt: 'NO_NEW_CHILD' })).isError, true);
  assert.deepEqual((await driver.listSubagentChildren(main.sessionId)).map(row => row.id), before, 'A missing connection must not silently create a replacement worker');
  await action(main.sessionId, 'send_message', { agent_id: explorer, message: 'CHILD_EXISTING_AFTER_SETTINGS_ERROR' });
  assert.equal(byTask('CHILD_EXISTING_AFTER_SETTINGS_ERROR').at(-1).model, 'fixture-explorer');
  const invalid = await driver.callTool(main.sessionId, 'subagent', { description: 'Invalid role', prompt: 'NO_DISPATCH', role: { injected: true } }, { onPermission: () => true });
  assert.equal(invalid.isError, true);
  const restricted = await driver.createSession({ provider, model: 'fixture-main', options: { toolFilter: { allow: ['read', 'subagent'], deny: ['subagent'] } } });
  const visible = (await driver.listTools(restricted.sessionId)).map(tool => tool.name);
  assert.ok(!visible.includes('subagent') && !visible.includes('subagent_explorer') && !visible.includes('subagent_browser'), 'Scoped adapters must not bypass explicit tool restrictions');
  const limited = await driver.createSession({ provider, model: 'fixture-main', options: { ...options, toolFilter: { deny: ['read'] } } });
  await spawn(limited.sessionId, 'subagent', { description: 'Restricted template', template: custom.id, prompt: 'CHILD_PARENT_RESTRICTED' });
  assert.ok(byTask('CHILD_PARENT_RESTRICTED').at(-1).tools.every(tool => tool.function.name !== 'read'), 'A template allow list cannot restore a parent-disabled tool');
});
