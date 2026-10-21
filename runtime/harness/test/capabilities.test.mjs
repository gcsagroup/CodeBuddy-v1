import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../index.mjs';
import { createConversationDriver } from '../../conversation-driver.mjs';
import { listSubagentCatalog, readSubagentConversation } from '../../subagent-conversations.mjs';
import sharp from 'sharp';
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai';

let driver, server, root, provider, mcpUrl;
let siblingFixture, capacityFixture;
let overflowExecutions = 0;
const requests = [], mcpCalls = [];
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'codebuddy-harness-capabilities-'));
  server = createServer(async (req, res) => {
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405).end(); return; }
    let raw = '';
    for await (const part of req) raw += part;
    const request = JSON.parse(raw);
    if (req.url === '/mcp') {
      if (!('id' in request)) { res.writeHead(202).end(); return; }
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      else if (request.method === 'tools/list') result = { tools: [{ name: 'remember', description: 'A fixture memory transport', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
      else if (request.method === 'tools/call') { mcpCalls.push({ ...request.params, authorization: req.headers.authorization }); result = { content: [{ type: 'text', text: `Stored: ${request.params.arguments.text}` }] }; }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })); return;
    }
    requests.push(request);
    const lastUser = request.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('fixture_'));
    const prompt = JSON.stringify(request.messages[lastUser]?.content ?? '');
    const since = request.messages.slice(lastUser + 1);
    const nativeBudget = PiAiConfig.dict.providers.inner.dict.defaultMaxTokens.meta.default;
    const toolChars = request.messages.filter(m => m.role === 'tool').reduce((sum, m) => sum + String(m.content).length, 0);
    if (request.model === 'fixture-retained-overflow' && toolChars + (request.max_tokens ?? request.max_completion_tokens) > nativeBudget * 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: {
        code: 'context_length_exceeded', message: 'This model\'s maximum context length is exceeded by the retained tool result and requested output tokens.',
      } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'capabilities', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const call = (name, args) => { emit({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); emit({}, 'tool_calls'); };
    if (prompt.includes('fixture_retained_overflow') && !since.some(message => message.role === 'tool')) call('oversized_evidence', {});
    else if (prompt.includes('fixture_child_slow')) {
      emit({ role: 'assistant', content: 'child waiting' });
      const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 30000);
      res.on('close', () => clearTimeout(timer)); return;
    }
    else if (prompt.includes('fixture_capacity_child')) { await capacityFixture.promise; emit({ role: 'assistant', content: 'Capacity child completed' }); emit({}, 'stop'); }
    else if (prompt.includes('fixture_capacity_parent') && !since.some(message => message.role === 'tool')) {
      const count = prompt.includes('fixture_capacity_parent_five') ? 5 : 2;
      emit({ role: 'assistant', tool_calls: Array.from({ length: count }, (_, index) => ({ index, id: `capacity-${index}`, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ description: `Capacity fixture ${index}`, prompt: 'fixture_capacity_child' }) } })) }); emit({}, 'tool_calls');
    }
    else if (prompt.includes('fixture_capacity_parent')) { capacityFixture.resolve(); emit({ role: 'assistant', content: 'Capacity admissions checked' }); emit({}, 'stop'); }
    else if (prompt.includes('fixture_background_cancel') && !since.some(message => message.role === 'tool')) call(process.platform === 'win32' ? 'pwsh' : 'bash', { description: 'Wait in cancellable fixture job', command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', run_in_background: true });
    else if (prompt.includes('fixture_role_parent') && !since.some(message => message.role === 'tool')) call('subagent', { description: 'Inherited main model fixture', prompt: 'fixture_role_child' });
    else if (prompt.includes('fixture_role_child') && !since.some(message => message.role === 'tool')) call('search_mcp_tools', { names: ['subagent'] });
    else if (prompt.includes('fixture_depth_parent') && !since.some(message => message.role === 'tool')) call('subagent', { description: 'Depth one child', prompt: 'fixture_depth_child' });
    else if (prompt.includes('fixture_depth_child') && !since.some(message => message.role === 'tool')) call('subagent', { description: 'Rejected nested child', prompt: 'fixture_depth_grandchild' });
    else if (prompt.includes('fixture_capability_parent') && !since.some(message => message.role === 'tool')) call('subagent', { description: 'Inherited host and MCP capabilities fixture', prompt: 'fixture_capability_child' });
    else if (prompt.includes('fixture_capability_child') && !since.some(message => message.role === 'tool')) call('child_contract', { value: 'confirmed' });
    else if (prompt.includes('fixture_capability_child') && since.filter(message => message.role === 'tool').length === 1) call('search_mcp_tools', { names: ['mcp__child_memory__remember'] });
    else if (prompt.includes('fixture_capability_child') && since.filter(message => message.role === 'tool').length === 2) call('mcp__child_memory__remember', { text: 'delegated memory' });
    else if (prompt.includes('fixture_delegate') && !since.some(message => message.role === 'tool')) call('subagent', { description: 'Independent module fixture', prompt: prompt.includes('cancel') ? 'fixture_child_slow' : 'fixture_child_write' });
    else if (prompt.includes('fixture_child_write') && !since.some(message => message.role === 'tool')) call('read', { file_path: join(root, 'source.txt') });
    else if (prompt.includes('fixture_child_write') && since.filter(message => message.role === 'tool').length === 1) call('write', { file_path: join(root, 'child.txt'), content: 'actual child write' });
    else if (prompt.includes('fixture_catalog_sibling_')) {
      const number = [1, 2, 3, 4].find(value => prompt.includes(`fixture_catalog_sibling_${value}`));
      siblingFixture.started.add(number);
      if (siblingFixture.started.size === 3) siblingFixture.ready.resolve();
      await siblingFixture.release.promise;
      emit({ role: 'assistant', content: `CATALOG_SIBLING_READY_${number}` }); emit({}, 'stop');
    }
    else if (prompt.includes('fixture_catalog_parallel_root') && !since.some(message => message.role === 'tool')) {
      emit({ role: 'assistant', tool_calls: [1, 2, 3].map(number => ({ index: number - 1, id: `catalog-${number}`, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ description: `Parallel catalog child ${number}`, prompt: `fixture_catalog_sibling_${number}` }) } })) }); emit({}, 'tool_calls');
    }
    else if (prompt.includes('fixture_catalog_parallel_root') && since.filter(message => message.role === 'tool').length === 3) {
      await siblingFixture.ready.promise;
      call('subagent', { description: 'Rejected fourth catalog child', prompt: 'fixture_catalog_sibling_4' });
    }
    else if (prompt.includes('fixture_limit')) call('read', { file_path: join(root, 'source.txt') });
    else if (prompt.includes('fixture_host') && !since.some(message => message.role === 'tool')) call('record_artifact', { value: 'first' });
    else if (prompt.includes('fixture_host') && since.filter(message => message.role === 'tool').length === 1) call('finish_artifact', {});
    else if (prompt.includes('fixture_large')) { emit({ role: 'assistant', content: 'Long evidence '.repeat(1800) }); emit({}, 'stop'); }
    else { emit({ role: 'assistant', content: 'fixture summary and response' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', contextWindow: 32768, maxTokens: 4096, compat: { thinkingFormat: 'openai' }, reasoningEfforts: { low: 'low', high: 'high' } };
  await writeFile(join(root, 'source.txt'), 'source fixture');
  await mkdir(join(root, '.dsh', 'skills', 'fixture-skill'), { recursive: true });
  await writeFile(join(root, '.dsh', 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Fixture skill for module tests\n---\nUse the existing module contracts.\n');
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
});
after(async () => { await driver?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });
async function session(options) { return driver.createSession({ sessionId: randomUUID(), cwd: root, provider, model: 'fixture-model', options }); }

test('read-only approval capabilities bind to actual native and host definitions', async () => {
  const created = await session();
  async function capability(id, name, args = {}, field = 'readOnly') {
    let observed;
    await driver.callTool(id, name, args, { onToolPolicy: async call => { observed = call[field]; return { kind: 'deny', reason: 'Capability observation only; do not dispatch.' }; } });
    return observed;
  }
  assert.equal(await capability(created.sessionId, 'read', { file_path: join(root, 'source.txt') }), true);
  assert.equal(await capability(created.sessionId, 'read', { file_path: join(root, 'source.txt') }, 'delegationControl'), false);
  for (const [name, args] of [['subagent', { description: 'No dispatch', prompt: 'No dispatch' }], ['send_message', { agent_id: randomUUID(), message: 'No dispatch' }], ['interrupt_agent', { agent_id: randomUUID() }]]) {
    assert.equal(await capability(created.sessionId, name, args, 'delegationControl'), true, `${name} must carry the native control identity`);
  }
  assert.equal(await capability(created.sessionId, 'write', { file_path: join(root, 'not-written.txt'), content: 'no' }), false);
  assert.equal(await capability(created.sessionId, 'web_fetch', { url: 'http://127.0.0.1:1/not-requested' }), false, 'An arbitrary outbound URL is not a local read-only grant');
  await assert.rejects(access(join(root, 'not-written.txt')));
  const automaticWrite = await driver.callTool(created.sessionId, 'write', { file_path: join(root, 'smart-allowed.txt'), content: 'actual confined write' }, {
    onToolPolicy: async call => ({ kind: call.nativeCapability ? 'allow' : 'deny' }),
  });
  assert.equal(automaticWrite.isError, false);
  assert.equal(await readFile(join(root, 'smart-allowed.txt'), 'utf8'), 'actual confined write');
  // The fixture workspace lives under the platform temp root, so a sibling
  // there is still writable by the native policy. Use a non-temp target.
  const outside = join(process.cwd(), '.preview-data', `smart-denied-${randomUUID()}.txt`);
  const deniedWrite = await driver.callTool(created.sessionId, 'write', { file_path: outside, content: 'must not exist' }, {
    onToolPolicy: async call => ({ kind: call.nativeCapability ? 'allow' : 'deny' }),
  });
  assert.equal(deniedWrite.isError, true);
  assert.match(JSON.stringify(deniedWrite), /sandbox.*denied|FS_SANDBOX_DENIED/i);
  await assert.rejects(access(outside));
  let escalationGrant;
  await driver.callTool(created.sessionId, 'write', { file_path: outside, content: 'no', sandbox_permissions: 'danger-full-access', justification: 'controlled escalation check' }, {
    onToolPolicy: async call => { escalationGrant = call.nativeCapability; return { kind: 'deny' }; },
  });
  assert.equal(escalationGrant, true, 'The native definition retains identity; escalation is decided by its native capability, not an automatic write grant');
  assert.equal(await capability(created.sessionId, 'working_directory'), true);
  assert.equal(await capability(created.sessionId, 'working_directory', { cd: root }), false);
  assert.equal(await capability(created.sessionId, 'search_mcp_tools', { query: 'read' }), true);
  const discoveryEvents=[];
  await driver.callTool(created.sessionId,'search_mcp_tools',{query:'subagent'}, {
    onPermission:()=>true,onEvent:event=>discoveryEvents.push(event),
  });
  assert.ok(discoveryEvents.filter(event=>['tool_call','tool_result'].includes(event.type)).every(event=>event.internalControl===true));
  const replacement = await session({ tools: [
    { name: 'read', inputSchema: { type: 'object', properties: {} }, async execute() { throw Error('Must not dispatch'); } },
    { name: 'send_message', inputSchema: { type: 'object', properties: {} }, async execute() { throw Error('Must not dispatch'); } },
    { name: 'reviewed_query', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: {} }, async execute() { return {}; } },
    { name: 'conflicting_query', annotations: { readOnlyHint: true, destructiveHint: true }, inputSchema: { type: 'object', properties: {} }, async execute() { return {}; } },
  ] });
  assert.equal(await capability(replacement.sessionId, 'read'), false, 'A same-name replacement does not inherit the native grant');
  assert.equal(await capability(replacement.sessionId, 'send_message', {}, 'delegationControl'), false, 'A same-name replacement cannot inherit internal control authorization');
  for (const [sessionId, expected] of [[created.sessionId, true], [replacement.sessionId, false]]) {
    const events=[];
    await driver.callTool(sessionId,'send_message',{agent_id:randomUUID(),message:'No dispatch'}, {
      onPermission:()=>false,onEvent:event=>events.push(event),
    });
    assert.equal(events.find(event=>event.type==='tool_call')?.internalControl,expected,
      'Only the actual native control definition can hide its receipt from the main chat');
  }
  assert.equal(await capability(replacement.sessionId, 'reviewed_query'), true);
  assert.equal(await capability(replacement.sessionId, 'conflicting_query'), false);
  const remote = await session({ mcpServers: [{ serverName: 'capability', transport: 'streamable-http', url: mcpUrl, reconnect: { enabled: false } }] });
  assert.equal(await capability(remote.sessionId, 'mcp__capability__remember', { text: 'not-dispatched' }), false);
});

test('runtime settings affect real HTTP request and remain scoped to the session', async () => {
  const a = await session({ systemPrompt: 'SESSION_A_POLICY', maxTokens: 256, temperature: 0.25, thinkingEffort: 'high' });
  await driver.prompt(a.sessionId, 'fixture_settings');
  assert.equal(requests.at(-1).max_tokens ?? requests.at(-1).max_completion_tokens, 256);
  assert.equal(requests.at(-1).temperature, 0.25);
  assert.equal(requests.at(-1).reasoning_effort, 'high');
  assert.match(JSON.stringify(requests.at(-1).messages), /SESSION_A_POLICY/);
  const b = await session();
  await driver.prompt(b.sessionId, 'fixture_settings');
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /SESSION_A_POLICY/);
});

test('output budgets use native defaults and preserve explicit provider and session overrides', async () => {
  const nativeBudget = PiAiConfig.dict.providers.inner.dict.defaultMaxTokens.meta.default;
  const { maxTokens: _fixtureBudget, ...route } = { ...provider, contextWindow: nativeBudget * 4 };
  for (const { expected, ...settings } of [
    { model: 'fixture-native-budget', provider: route, expected: nativeBudget },
    { model: 'fixture-native-budget', provider: { ...route, outputTokenCapacity: nativeBudget / 2 }, expected: nativeBudget / 2 },
    { model: 'fixture-provider-budget', provider: { ...route, maxTokens: 8192 }, expected: 8192 },
    { model: 'fixture-session-budget', provider: { ...route, maxTokens: 8192 }, options: { maxTokens: 2048 }, expected: 2048 },
  ]) {
    const created = await driver.createSession({ cwd: root, ...settings });
    await driver.prompt(created.sessionId, 'fixture_settings');
    assert.equal(requests.at(-1).max_tokens ?? requests.at(-1).max_completion_tokens, expected);
  }
});

test('official instructions load the configured global and project chain with isolated homes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-instructions-'));
  const globalHome = join(directory, 'home'), project = join(directory, 'project'), child = join(project, 'packages');
  await mkdir(globalHome); await mkdir(join(project, '.git'), { recursive: true }); await mkdir(child);
  await writeFile(join(globalHome, 'AGENTS.md'), 'GLOBAL_RULE_519: preserve exported API names.');
  await writeFile(join(project, 'AGENTS.md'), 'PROJECT_RULE_519: test cross-module changes.');
  await writeFile(join(child, 'AGENTS.md'), 'NESTED_RULE_519: use the package contract.');
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME };
  const isolated = await createHarnessDriver({ dataDir: join(directory, 'state'), cwd: child, instructionsHome: globalHome });
  try {
    assert.deepEqual({ DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME }, previous);
    const created = await isolated.createSession({ cwd: child, provider, model: 'fixture-instructions' });
    await isolated.prompt(created.sessionId, 'fixture_instructions');
    const wire = JSON.stringify(requests.at(-1).messages);
    assert.match(wire, /GLOBAL_RULE_519/); assert.match(wire, /PROJECT_RULE_519/); assert.match(wire, /NESTED_RULE_519/);
    const history = await isolated.history(created.sessionId);
    assert.ok(history.events.some(event => event.type === 'user/message' && event.data.source.kind === 'agent-instructions'));
    await writeFile(join(globalHome, 'AGENTS.md'), 'GLOBAL_RULE_UPDATED_519: preserve API and runtime contracts.');
    const next = await isolated.createSession({ cwd: child, provider, model: 'fixture-instructions' });
    await isolated.prompt(next.sessionId, 'fixture_instructions fresh');
    assert.match(JSON.stringify(requests.at(-1).messages), /GLOBAL_RULE_UPDATED_519/);
    const unrelated = await session(); await driver.prompt(unrelated.sessionId, 'fixture_instructions unrelated');
    assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /GLOBAL_RULE_.*519|PROJECT_RULE_519|NESTED_RULE_519/);
  } finally { await isolated.close(); }
});

test('image prompt uses official admission and actual vision HTTP content across restart', async () => {
  const visionProvider = { ...provider, inputModalities: ['text', 'image'] };
  const created = await driver.createSession({ sessionId: randomUUID(), cwd: root, provider: visionProvider, model: 'fixture-vision' });
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const image = { type: 'image', mediaType: 'image/png', name: 'fixture.png', data: png.toString('base64') };
  const before = requests.length;
  await assert.rejects(driver.prompt(created.sessionId, [{ type: 'text', text: 'fixture_bad_image' }, { ...image, mediaType: 'image/jpeg' }]));
  assert.equal(requests.length, before, 'invalid image must fail before sending a provider request');
  await driver.prompt(created.sessionId, [{ type: 'text', text: 'fixture_vision image' }, image]);
  const parts = requests.at(-1).messages.filter(message => message.role === 'user').flatMap(message => message.content);
  const sentImage = parts.find(part => part.type === 'image_url');
  assert.match(sentImage?.image_url?.url ?? '', /^data:image\/(png|jpeg|webp);base64,/);
  const history = await driver.history(created.sessionId);
  const uploaded = history.events.find(event => event.type === 'user/message').data.content.find(part => part.type === 'image');
  assert.equal(uploaded.attachment.width, 1);
  assert.equal(uploaded.attachment.height, 1);
  assert.equal('data' in uploaded, false);
  assert.equal(JSON.stringify(history.events).includes(image.data), false, 'durable event stores only normalized attachment references');
  await driver.close();
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  await driver.createSession({ sessionId: created.sessionId, cwd: root, provider: visionProvider, model: 'fixture-vision' });
  await driver.prompt(created.sessionId, 'fixture_vision followup');
  assert.ok(requests.at(-1).messages.filter(message => message.role === 'user').flatMap(message => message.content).some(part => part.type === 'image_url'));
});

test('generic file upload uses session-owned receipts and read-on-demand projection', async () => {
  const created = await session(), other = await session();
  const payload = 'FILE_BODY_IS_READ_ON_DEMAND_84b6';
  const uploaded = await driver.upload(created.sessionId, { data: Buffer.from(payload).toString('base64'), name: 'fixture.txt' });
  const parts = [{ type: 'text', text: 'fixture_file attachment' }, { type: 'file', receiptId: uploaded.receiptId }];
  await assert.rejects(driver.prompt(other.sessionId, parts), error => error.code === 'session/attachment-invalid');
  await driver.prompt(created.sessionId, parts);
  assert.match(JSON.stringify(requests.at(-1).messages), /fixture\.txt/);
  assert.equal(JSON.stringify(requests.at(-1).messages).includes(payload), false);
  const history = await driver.history(created.sessionId);
  const file = history.events.find(event => event.type === 'user/message').data.content.find(part => part.type === 'file');
  assert.deepEqual(file.attachment, uploaded.file);
  assert.equal(file.attachment.bytes, Buffer.byteLength(payload));
  await assert.rejects(driver.prompt(created.sessionId, parts), error => error.code === 'session/attachment-invalid', 'consumed receipts must not be replayed');
});

test('host tools use official registry, permission and awaited result ordering', async () => {
  const sequence = [];
  const created = await session({ tools: [
    { name: 'record_artifact', description: 'Record fixture', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, async execute(args) { sequence.push('execute'); return { written: args.value }; } },
    { name: 'finish_artifact', description: 'Check fixture', inputSchema: { type: 'object', properties: {} }, async execute() { assert.ok(sequence.includes('durable-result')); return { checked: true }; } },
  ] });
  await driver.prompt(created.sessionId, 'fixture_host', { onPermission: async () => { sequence.push('permission'); return true; }, async onEvent(event) { if (event.type === 'tool_result') { await delay(25); sequence.push('durable-result'); } } });
  assert.equal(sequence.filter(item => item === 'permission').length, 2);
  const denied = await driver.callTool(created.sessionId, 'record_artifact', { value: 'denied' });
  assert.equal(denied.isError, true);
  const invalid = await driver.callTool(created.sessionId, 'record_artifact', {}, { onPermission: async () => true });
  assert.equal(invalid.isError, true);
  assert.equal(sequence.filter(item => item === 'execute').length, 1);
  const unrelated = await session();
  assert.equal((await driver.listTools(unrelated.sessionId)).some(tool => tool.name === 'record_artifact'), false);
});

test('MCP connection is session scoped, approval gated and does not persist credentials', async () => {
  const secret = 'MCP_FIXTURE_TOKEN_DO_NOT_PERSIST_8a4d';
  const created = await session({ mcpServers: [{ serverName: 'memory', transport: 'streamable-http', url: mcpUrl, headers: { Authorization: `Bearer ${secret}` }, reconnect: { enabled: false } }] });
  assert.ok((await driver.listTools(created.sessionId)).some(tool => tool.name === 'mcp__memory__remember'));
  assert.equal((await driver.callTool(created.sessionId, 'mcp__memory__remember', { text: 'denied' })).isError, true);
  assert.equal(mcpCalls.length, 0);
  const result = await driver.callTool(created.sessionId, 'mcp__memory__remember', { text: 'project convention' }, { onPermission: async () => true });
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /project convention/);
  assert.equal(mcpCalls[0].authorization, `Bearer ${secret}`);
  assert.ok((await driver.testExtension({ serverName: 'probe', transport: 'streamable-http', url: mcpUrl })).some(tool => tool.name === 'mcp__probe__remember'));
  assert.equal((await driver.listTools()).some(tool => tool.name.startsWith('mcp__probe__')), false);
  assert.equal((await driver.listTools((await session()).sessionId)).some(tool => tool.name === 'mcp__memory__remember'), false);
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else {
        // Native persistence atomically renames temporary snapshots during the
        // scan. A vanished entry has no durable bytes to inspect.
        const bytes = await readFile(file).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (bytes) assert.equal(bytes.includes(Buffer.from(secret)), false, file);
      }
    }
  }
  await scan(join(root, 'state'));
});

test('unavailable optional MCP reports error while native tools and conversation remain usable', async () => {
  const created = await session({ mcpServers: [{ serverName: 'offline', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', reconnect: { enabled: false } }] });
  assert.equal(driver.extensionStatus(created.sessionId)[0].status, 'error');
  assert.ok((await driver.listTools(created.sessionId)).some(tool => tool.name === 'write'));
  assert.equal((await driver.prompt(created.sessionId, 'fixture_offline_mcp')).stopReason, 'end_turn');
});

test('independent MCP startups run concurrently and retain explicit timeout status without hiding ready tools', { timeout: 10000 }, async t => {
  const seen = new Set(), gate = Promise.withResolvers();
  const independent = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (!('id' in message)) { res.writeHead(202).end(); return; }
    if (req.url === '/timeout') return;
    let result;
    if (message.method === 'initialize') {
      seen.add(req.url); if (seen.size === 2) gate.resolve();
      await gate.promise;
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: req.url.slice(1), version: '1' } };
    } else if (message.method === 'tools/list') result = { tools: [{ name: 'probe', description: 'Ready fixture capability', inputSchema: { type: 'object', properties: {} } }] };
    else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Fixture speaks MCP 2025' } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => independent.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gate.resolve(); independent.closeAllConnections(); await new Promise(resolve => independent.close(resolve)); });
  const created = await session({ mcpServers: ['first', 'second', 'timeout'].map(serverName => ({ serverName, transport: 'streamable-http', url: `http://127.0.0.1:${independent.address().port}/${serverName}`, toolCallTimeoutMs: 300, reconnect: { enabled: false } })) });
  assert.deepEqual(driver.extensionStatus(created.sessionId).map(s => [s.serverName, s.status]), [['first', 'ready'], ['second', 'ready'], ['timeout', 'error']]);
  const tools = await driver.listTools(created.sessionId);
  assert.ok(tools.some(tool => tool.name === 'mcp__first__probe')); assert.ok(tools.some(tool => tool.name === 'mcp__second__probe'));
  assert.ok(!tools.some(tool => tool.name === 'mcp__timeout__probe'));
  assert.equal((await driver.prompt(created.sessionId, 'fixture_chat after MCP timeout')).stopReason, 'end_turn');
});

test('official filesystem skill is discoverable and callable through permission pipeline', async () => {
  const created = await session();
  const skills = await driver.listSkills(created.sessionId);
  assert.ok(skills.some(skill => skill.name === 'fixture-skill'));
  const result = await driver.callTool(created.sessionId, 'skill', { name: 'fixture-skill' }, { onPermission: async () => true });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /existing module contracts/);
  await writeFile(join(root, '.dsh', 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Updated fixture skill\n---\nUPDATED_SKILL_BODY\n');
  await driver.refreshSkills();
  await driver.prompt(created.sessionId, '/fixture-skill fixture_skill_invocation');
  assert.match(JSON.stringify(requests.at(-1).messages), /UPDATED_SKILL_BODY/);
});

test('subagent file execution uses native permissions and parent waits for its actual result', async () => {
  const created = await session();
  const approvals = [];
  await driver.prompt(created.sessionId, 'fixture_delegate', { onToolStart: async call => { approvals.push(call); }, onPermission: () => assert.fail('Permitted native file work needs no additional approval') });
  assert.equal(await readFile(join(root, 'child.txt'), 'utf8'), 'actual child write');
  assert.ok(approvals.some(call => call.name === 'subagent' && call.sessionId === created.sessionId && call.delegationControl === true));
  assert.ok(approvals.some(call => call.name === 'write' && call.sessionId !== created.sessionId));
  assert.ok(approvals.filter(call => call.name === 'write').every(call => call.readOnly === false));
  assert.ok(approvals.some(call => call.name === 'read' && call.sessionId !== created.sessionId && call.readOnly === true));
  const requestCount = requests.length, approvalCount = approvals.length;
  const children = await driver.listSubagentChildren(created.sessionId);
  assert.equal(children.length, 1);
  assert.equal(children[0].mode, 'continuable');
  assert.equal(children[0].label, 'Independent module fixture');
  assert.ok(Number.isSafeInteger(children[0].createdAt) && children[0].createdAt >= 0);
  assert.ok(approvals.some(call => call.name === 'write' && call.sessionId === children[0].id));
  const before = await driver.history(children[0].id);
  assert.deepEqual(await driver.listSubagentChildren(created.sessionId), children);
  assert.deepEqual(await driver.listSubagentChildren(children[0].id), []);
  assert.deepEqual(await driver.history(children[0].id), before);
  assert.equal(requests.length, requestCount, 'Catalog inspection must not call a model');
  assert.equal(approvals.length, approvalCount, 'Catalog inspection must not dispatch a tool');
});

test('native three sibling catalogs and conversations stay read-only at capacity three', { timeout: 15000 }, async () => {
  const created = await session(), approvals = [], events = [];
  siblingFixture = { started: new Set(), ready: Promise.withResolvers(), release: Promise.withResolvers() };
  const refused = Promise.withResolvers();
  const running = driver.prompt(created.sessionId, 'fixture_catalog_parallel_root', {
    signal: AbortSignal.timeout(10000),
    onToolStart: async call => { approvals.push(call); },
    onEvent: event => {
      events.push(event);
      if (event.type === 'tool_result' && event.name === 'subagent' && event.isError) refused.resolve(event);
    },
  });
  try {
    const rejection = await Promise.race([
      refused.promise,
      running.then(() => { throw new Error('Parent ended before the fourth admission was refused'); }),
    ]);
    assert.deepEqual([...siblingFixture.started].sort(), [1, 2, 3], 'All three accepted children are still occupying native slots');
    assert.match(JSON.stringify(rejection.result), /active child limit: 3/);
    assert.equal((await driver.listSubagentChildren(created.sessionId)).length, 3);
  } finally { siblingFixture.release.resolve(); }
  const result = await running;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(approvals.length, 4, 'The three starts and refused fourth call pass through ordinary tool approval');
  assert.ok(approvals.every(call => call.name === 'subagent'), 'No file, shell or unrelated tool is dispatched');
  assert.equal(events.filter(event => event.type === 'subagent_start').length, 3);
  assert.ok(events.filter(event => event.type === 'subagent_end').every(event => event.stopReason === 'completed'));
  assert.equal(siblingFixture.started.has(4), false, 'The refused child is not queued for a later model request');

  const requestCount = requests.length, approvalCount = approvals.length;
  // prompt settles execution; native JSONL writes remain buffered. The official
  // teardown awaits every writer's drain before this cold-read restart.
  await driver.close();
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });

  // Only the product root is mapped. Child ids come from the real native catalog.
  const parent = { id: randomUUID(), nativeSessionId: created.sessionId };
  const reader = createConversationDriver(driver, {
    readSession: id => id === parent.id ? structuredClone(parent) : undefined,
    update() { assert.fail('Readonly inspection must not change product state'); },
  });
  const files = async (directory, prefix = '') => {
    const snapshot = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = join(prefix, entry.name), file = join(directory, entry.name);
      if (entry.isDirectory()) Object.assign(snapshot, await files(file, name));
      else snapshot[name] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
    return snapshot;
  };
  const before = await files(root);
  const rootCatalog = await listSubagentCatalog(parent, {}, reader);
  assert.equal(rootCatalog.children.length, 3);
  assert.equal(new Set(rootCatalog.children.map(child => child.id)).size, 3);
  assert.deepEqual(rootCatalog.children.map(child => child.label).sort(), [1, 2, 3].map(number => `Parallel catalog child ${number}`));
  for (const child of rootCatalog.children) {
    const number = Number(child.label.at(-1));
    assert.equal(child.mode, 'continuable');
    assert.notEqual(child.id, created.sessionId);
    const page = await readSubagentConversation(parent, { childSessionId: child.id, ancestorSessionIds: [] }, reader);
    assert.deepEqual(page.ancestorSessionIds, []);
    assert.ok(page.events.some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes(`fixture_catalog_sibling_${number}`))));
    assert.ok(page.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === `CATALOG_SIBLING_READY_${number}`)));
    assert.ok(page.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'));
    assert.equal(page.hasMore, false);
    const unchanged = await readSubagentConversation(parent, { childSessionId: child.id, ancestorSessionIds: [], afterSeq: page.throughSeq }, reader);
    assert.deepEqual(unchanged.events, []);
    assert.deepEqual((await listSubagentCatalog(parent, { ancestorSessionIds: [child.id] }, reader)).children, []);
  }
  assert.deepEqual(await listSubagentCatalog(parent, {}, reader), rootCatalog, 'The fourth call never publishes catalog membership');
  assert.equal(requests.length, requestCount, 'Catalog and history inspection must not issue another model request');
  assert.equal(approvals.length, approvalCount, 'Inspection must not dispatch a tool or ask for approval');
  assert.deepEqual(await files(root), before, 'Inspection must not mutate workspace or native persisted files');
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'source fixture');
});

test('generic subagent inherits the actual parent model and effort despite obsolete role options', async () => {
  const created = await session({ thinkingEffort: 'high', roleModels: { coder: { provider, model: 'fixture-coder', thinkingEffort: 'low' } } });
  const events = [];
  await driver.prompt(created.sessionId, 'fixture_role_parent', { onPermission: async () => true, onEvent: event => events.push(event) });
  const childRequests = requests.filter(request => request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('fixture_role_child')));
  assert.ok(childRequests.length > 0);
  assert.equal(childRequests[0].model, 'fixture-model');
  assert.equal(childRequests[0].reasoning_effort, 'high');
  assert.equal(requests.some(request => request.model === 'fixture-coder'), false);
  const toolNames = childRequests[0].tools.map(tool => tool.function.name);
  assert.ok(toolNames.includes('search_mcp_tools'));
  assert.ok(!toolNames.includes('subagent'), 'optional schemas remain deferred for a newly spawned child');
  assert.ok(toolNames.every(name => !name.startsWith('subagent_')));
  const started = events.find(event => event.type === 'subagent_start');
  const parameters = childRequests.at(-1).tools.find(tool => tool.function.name === 'subagent').function.parameters.properties;
  for (const field of ['provider', 'model', 'reasoning_effort']) assert.equal(Object.hasOwn(parameters, field), false);
  assert.ok(started?.childSessionId);
  assert.ok(events.some(event => event.type === 'subagent_end' && event.childSessionId === started.childSessionId));
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'subagent' && event.structuredContent?.subagentId === started.childSessionId));
});

test('obsolete per-session concurrency settings cannot narrow or widen the native Host cap', async () => {
  const one = await session({ maxParallelSubagents: 1, maxParallelCoders: 1 });
  capacityFixture = Promise.withResolvers();
  const first = [];
  await driver.prompt(one.sessionId, 'fixture_capacity_parent', { onPermission: () => true, onEvent: event => first.push(event) });
  const firstSpawns = first.filter(event => event.type === 'tool_result' && event.name === 'subagent');
  assert.equal(firstSpawns.filter(event => !event.isError).length, 2);
  assert.equal(firstSpawns.filter(event => event.isError).length, 0);
  const upper = await session({ maxParallelSubagents: 32, maxParallelCoders: 32 });
  capacityFixture = Promise.withResolvers();
  const third = [];
  await driver.prompt(upper.sessionId, 'fixture_capacity_parent_five', { onPermission: () => true, onEvent: event => third.push(event) });
  assert.equal(third.filter(event => event.type === 'tool_result' && event.name === 'subagent' && !event.isError).length, 3);
  const refused = third.filter(event => event.type === 'tool_result' && event.name === 'subagent' && event.isError);
  assert.equal(refused.length, 2);
  assert.ok(refused.every(event => /active child limit: 3/.test(JSON.stringify(event.result))));
});

test('native depth one rejects a child attempting to spawn a grandchild', async () => {
  const created = await session(), events = [];
  await driver.prompt(created.sessionId, 'fixture_depth_parent', { onPermission: () => true, onEvent: event => events.push(event) });
  const child = events.find(event => event.type === 'subagent_start')?.childSessionId;
  assert.ok(child);
  const refusal = events.find(event => event.type === 'tool_result' && event.name === 'subagent' && event.sessionId === child && event.isError);
  assert.ok(refusal);
  assert.match(JSON.stringify(refusal.result), /depth 2 exceeds maxDepth 1/);
  assert.equal(events.filter(event => event.type === 'subagent_start').length, 1);
  assert.deepEqual(await driver.listSubagentChildren(child), []);
  assert.equal(requests.some(request => request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('fixture_depth_grandchild'))), false);
});

test('owned child receives configured host tools, MCP and instructions before its first model step', async () => {
  const calls = [], approvals = [];
  const created = await session({
    systemPrompt: 'CHILD_INHERITED_HOST_POLICY_821',
    tools: [{ name: 'child_contract', description: 'Host task contract', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, execute(args, exec) { calls.push({ args, exec }); return { accepted: true }; } }],
    mcpServers: [{ serverName: 'child_memory', transport: 'streamable-http', url: mcpUrl, reconnect: { enabled: false } }],
  });
  await driver.permissions(created.sessionId, { preset: 'danger-full-access' });
  let rootApproval;
  await driver.callTool(created.sessionId, 'mcp__child_memory__remember', { text: 'identity-only' }, {
    onToolPolicy: call => { rootApproval = call.sessionApproval; return { kind: 'deny', reason: 'Observe identity without calling MCP' }; },
  });
  await driver.prompt(created.sessionId, 'fixture_capability_parent', { onToolStart: async (call) => { approvals.push({ ...call, approvalCurrent: call.sessionApproval?.isCurrent() }); } });
  const request = requests.find(request => request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('fixture_capability_child')));
  assert.ok(request.tools.some(tool => tool.function.name === 'child_contract'));
  assert.ok(request.tools.some(tool => tool.function.name === 'search_mcp_tools'));
  assert.ok(!request.tools.some(tool => tool.function.name === 'mcp__child_memory__remember'));
  assert.ok(requests.filter(request => request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('fixture_capability_child'))).at(-1).tools.some(tool => tool.function.name === 'mcp__child_memory__remember'));
  assert.match(JSON.stringify(request.messages), /CHILD_INHERITED_HOST_POLICY_821/);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].exec.sessionId, created.sessionId);
  assert.ok(approvals.some(call => call.name === 'child_contract' && call.sessionId === calls[0].exec.sessionId));
  assert.ok(approvals.some(call => call.name === 'mcp__child_memory__remember' && call.sessionId === calls[0].exec.sessionId));
  const childApproval = approvals.find(call => call.name === 'mcp__child_memory__remember').sessionApproval;
  assert.equal(childApproval.owner, rootApproval.owner, 'Child consumes the actual root approval owner');
  assert.equal(childApproval.tool, rootApproval.tool, 'Child resolves the same live MCP definition');
  assert.equal(approvals.find(call => call.name === 'mcp__child_memory__remember').approvalCurrent, true);
});

test('cancelling a parent also quiesces its active child', { timeout: 10000 }, async () => {
  const created = await session();
  const abort = new AbortController();
  const started = Date.now();
  const result = await driver.prompt(created.sessionId, 'fixture_delegate cancel', { signal: abort.signal, onPermission: async () => true, onEvent(event) { if (event.type === 'text_delta' && event.sessionId !== created.sessionId) abort.abort(); } });
  assert.equal(result.stopReason, 'cancelled');
  assert.ok(Date.now() - started < 8000);
});

test('steering enters the official inbox before the next model step', async () => {
  const created = await session();
  let steered = false;
  await driver.prompt(created.sessionId, 'fixture_limit', { onToolStart: async () => {
    if (!steered) { steered = true; await driver.steer(created.sessionId, 'fixture_followup STEERING_SCOPE_17'); }
    return true;
  } });
  assert.match(JSON.stringify(requests.at(-1).messages), /STEERING_SCOPE_17/);
  const history = await driver.history(created.sessionId);
  assert.ok(history.events.some(event => event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('STEERING_SCOPE_17')));
});

test('native background jobs return handles and actual terminal output within their owning session', async () => {
  const created = await session();
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  const command = process.platform === 'win32' ? "Start-Sleep -Milliseconds 150; Write-Output 'NATIVE_JOB_OK'" : "sleep 0.15; printf 'NATIVE_JOB_OK'";
  const options = { onPermission: async () => true };
  const launched = await driver.callTool(created.sessionId, shell, { description: 'Run isolated background fixture', command, run_in_background: true }, options);
  assert.equal(launched.isError, false, JSON.stringify(launched));
  assert.equal(launched.value.kind, 'background');
  const read = await driver.callTool(created.sessionId, 'job_output', { job_id: launched.value.jobId, wait: true, timeout_ms: 5000 }, options);
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.match(JSON.stringify(read.content), /NATIVE_JOB_OK/);
  const outsider = await session();
  const refused = await driver.callTool(outsider.sessionId, 'job_output', { job_id: launched.value.jobId }, options);
  assert.equal(refused.isError, true);
});

test('prompt cancellation settles its native background jobs before returning', { timeout: 10000 }, async () => {
  const created = await session();
  const abort = new AbortController();
  const result = await driver.prompt(created.sessionId, 'fixture_background_cancel', { signal: abort.signal, onPermission: async () => true, onEvent(event) {
    if (event.type === 'tool_result' && event.structuredContent?.kind === 'background') abort.abort();
  } });
  assert.equal(result.stopReason, 'cancelled');
  assert.ok(result.jobs.length > 0);
  assert.ok(result.jobs.every(job => ['completed', 'killed', 'failed'].includes(job.status)), JSON.stringify(result.jobs));
});

test('step limit is a resumable bound and never successful task completion', async () => {
  const created = await session({ maxTurns: 2 });
  const result = await driver.prompt(created.sessionId, 'fixture_limit', { onPermission: async () => true });
  assert.equal(result.stopReason, 'max_turns');
  const history = await driver.history(created.sessionId);
  assert.equal(history.events.filter(event => event.type === 'tool/result').length, 2);
  await driver.configureSession(created.sessionId, { maxTurns: 5 });
  assert.equal((await driver.prompt(created.sessionId, 'fixture_followup')).stopReason, 'end_turn');
});

test('manual compaction uses official summarization and preserves transcript evidence', async () => {
  const created = await session({ autoCompact: false });
  for (let n = 0; n < 3; n++) await driver.prompt(created.sessionId, `fixture_large ${n}`);
  const beforeHistory = await driver.history(created.sessionId);
  const beforeUsage = await driver.contextUsage(created.sessionId);
  const events = [];
  const result = await driver.compact(created.sessionId, { onEvent: event => events.push(event) });
  assert.ok(result && result.shadowedSeqs.length > 0, JSON.stringify(result));
  const afterHistory = await driver.history(created.sessionId);
  assert.deepEqual(afterHistory.events.slice(0, beforeHistory.events.length), beforeHistory.events);
  assert.ok(afterHistory.events.some(event => event.type === 'compaction/end'));
  const afterUsage = await driver.contextUsage(created.sessionId);
  assert.ok(afterUsage.used < beforeUsage.used, JSON.stringify({ beforeUsage, afterUsage }));
  assert.deepEqual(events.filter(e => e.type === 'harness_event').map(e => e.event.type), ['compaction/start', 'compaction/summary', 'compaction/end']);
  assert.equal(events.findLast(e => e.type === 'context_usage').used, afterUsage.used);
});

test('configured pressure threshold automatically compacts long conversation context', async () => {
  const created = await session({ autoCompactThreshold: 0.35 });
  const events = [];
  for (let n = 0; n < 5; n++) await driver.prompt(created.sessionId, `fixture_large auto ${n}`, { onEvent: e => events.push(e) });
  assert.ok((await driver.history(created.sessionId)).events.filter(event => event.type === 'compaction/end' && !event.data.error).length >= 2);
  assert.ok(events.some(e => e.type === 'context_usage' && e.contextLimit === 32768 && e.used > 0));
  const usage = await driver.contextUsage(created.sessionId);
  assert.equal(events.findLast(e => e.type === 'context_usage').used, usage.used);
});

test('tool schema pressure preserves explicit output budget with the actual model window and contributes to automatic compaction', async () => {
  const tools = [{ name: 'large_catalog_fixture', description: 'Schema reference '.repeat(10500), parameters: { type: 'object', properties: {} }, execute: async () => 'fixture' }];
  const created = await driver.createSession({ sessionId: randomUUID(), cwd: root,
    provider: { ...provider, contextWindow: 65536, maxTokens: 4096 }, model: 'fixture-tool-capacity',
    options: { tools, autoCompactThreshold: 0.8 } });
  const first = await driver.prompt(created.sessionId, 'fixture_settings');
  assert.equal(first.stopReason, 'end_turn');
  assert.equal(requests.at(-1).max_tokens ?? requests.at(-1).max_completion_tokens, 4096);
  const initial = await driver.contextUsage(created.sessionId);
  assert.equal(initial.contextLimit, 65536);
  assert.ok(initial.used > 32768, 'the model meter counts the large tool schema');
  for (let n = 0; n < 5; n++) await driver.prompt(created.sessionId, `fixture_large schema ${n}`);
  const history = await driver.history(created.sessionId);
  assert.ok(history.events.some(e => e.type === 'compaction/end' && !e.data.error), 'history pressure on top of tools triggers official compaction');
  assert.ok(requests.at(-1).tools.some(t => t.function?.name === 'large_catalog_fixture'), 'compaction preserves tool access');
});

test('output capability preserves native dynamic fitting on small windows without inventing a call default', async () => {
  const nativeBudget = PiAiConfig.dict.providers.inner.dict.defaultMaxTokens.meta.default;
  const { maxTokens: _fixtureBudget, ...route } = { ...provider, contextWindow: nativeBudget / 4, outputTokenCapacity: nativeBudget / 4 };
  const created = await driver.createSession({ cwd: root, provider: route, model: 'fixture-small-capability' });
  for (let n = 0; n < 2; n++) {
    const result = await driver.prompt(created.sessionId, `fixture_settings small-window ${n}`);
    assert.equal(result.stopReason, 'end_turn');
    const wireBudget = requests.at(-1).max_tokens ?? requests.at(-1).max_completion_tokens;
    assert.ok(wireBudget > 0 && wireBudget < route.contextWindow, 'native fitting leaves room for input');
  }
  const history = await driver.history(created.sessionId);
  assert.ok(history.events.filter(e => e.type === 'request/header').every(e => e.data.header.config.maxTokens === undefined), 'capability is not a fixed request reservation');
});

test('native overflow recovery reduces a retained oversized receipt without re-executing its tool or erasing original evidence', async () => {
  const nativeBudget = PiAiConfig.dict.providers.inner.dict.defaultMaxTokens.meta.default;
  const { maxTokens: _fixtureBudget, ...route } = { ...provider, contextWindow: nativeBudget * 2 };
  const evidence = 'overflow evidence '.repeat(3600);
  overflowExecutions = 0;
  const created = await driver.createSession({ cwd: root, provider: route, model: 'fixture-retained-overflow', options: {
    tools: [{ name: 'oversized_evidence', description: 'Read fixture evidence', parameters: { type: 'object', properties: {} }, execute: async () => { overflowExecutions++; return evidence; } }],
  } });
  const events = [];
  const result = await driver.prompt(created.sessionId, 'fixture_retained_overflow', { onPermission: async () => true, onEvent: event => events.push(event) });
  assert.equal(result.stopReason, 'end_turn', 'native overflow recovery must reach a usable answer');
  assert.equal(overflowExecutions, 1, 'retrying the model cannot replay the completed tool');
  assert.equal(events.filter(e => e.type === 'tool_result').length, 1, 'a model-surface replacement is not a second execution receipt');
  const history = await driver.history(created.sessionId);
  assert.ok(history.events.some(e => e.type === 'compaction/prune'), 'the native pruner participates in overflow recovery');
  assert.ok(history.events.some(e => e.type === 'tool/result' && JSON.stringify(e).includes(evidence)), 'the original full receipt remains in durable history');
  assert.ok(requests.at(-1).messages.some(m => m.role === 'tool' && String(m.content).includes('tool result middle pruned')), 'the recovered request marks omitted content rather than fabricating it');
});

test('memory reuses Harness domain durability with project isolation across restart', async () => {
  await driver.memory.set('project-a', 'convention', { content: 'Use typed module boundaries' });
  await driver.memory.set('project-b', 'convention', { content: 'Other project' });
  await driver.close();
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  assert.deepEqual(driver.memory.get('project-a', 'convention'), { content: 'Use typed module boundaries' });
  assert.equal(driver.memory.list('project-b').length, 1);
  const copy = driver.memory.get('project-a', 'convention'); copy.content = 'modified clone';
  assert.equal(driver.memory.get('project-a', 'convention').content, 'Use typed module boundaries');
  await driver.memory.delete('project-a', 'convention');
  assert.equal(driver.memory.get('project-a', 'convention'), undefined);
  assert.equal(driver.memory.list('project-b').length, 1);
});

test('large retained input does not repeatedly summarize a lone checkpoint before every tool step', async () => {
  const created = await session({ autoCompactThreshold: 0.35, maxTurns: 3 });
  await driver.prompt(created.sessionId, 'fixture_large original');
  await driver.prompt(created.sessionId, 'fixture_limit retained data ' + 'archived record '.repeat(3500), { onPermission: () => true });
  const history = await driver.history(created.sessionId);
  const summaries = history.events.filter(e => e.type === 'compaction/summary');
  assert.ok(summaries.length > 0, 'ordinary historical compaction still occurs');
  assert.ok(summaries.every(e => e.data.shadowedSeqs.length !== 1 || history.events.find(x => x.seq === e.data.shadowedSeqs[0])?.data?.source?.kind !== 'compact-checkpoint'), 'do not pay to recompress an unchanged checkpoint with no new facts');
});
