import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';
import { Config } from '../harness/mcp-bridge.mjs';
import { harnessMcpServer } from '../session-extensions.mjs';
import { Compat } from '../compat.mjs';

const output = { content: [{ type: 'text', text: 'FINISHED_ONCE' }], structuredContent: { done: true } };
async function fixture(t, { mode = 'legacy', capability = true, support = 'optional', pending = false, failure = false, synchronous = false, malformed = false, requestDelay = 0, timeout, stdio = false, invalidOutput = false } = {}) {
  const calls = [], models = [], root = await mkdtemp(path.join(tmpdir(), 'codebuddy-mcp-tasks-'));
  const finalOutput = invalidOutput ? { ...output, structuredContent: { done: 'invalid' } } : output;
  let polls = 0;
  const task = status => ({ taskId: 'fixture-task', status, createdAt: '2026-10-16T00:00:00Z', lastUpdatedAt: '2026-10-16T00:00:00Z',
    ...(mode === 'modern' ? { ttlMs: null, pollIntervalMs: 100 } : { ttl: null, pollInterval: 100 }) });
  const capabilities = { tools: {}, ...(capability ? mode === 'modern'
    ? { extensions: { 'io.modelcontextprotocol/tasks': {} } }
    : { tasks: { requests: { tools: { call: {} } }, cancel: {} } } : {}) };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const part of req) raw += part;
    const m = JSON.parse(raw);
    if (req.url === '/v1/chat/completions') {
      models.push(m);
      const delta = models.length === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'async-call', type: 'function', function: { name: 'mcp__fixture__work', arguments: '{}' } }] } : { role: 'assistant', content: 'TASK_RESULT_RECEIVED' };
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk(delta, null) + chunk({}, models.length === 1 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
      return;
    }
    calls.push({ ...m, headers: req.headers });
    if (!('id' in m)) { res.writeHead(202).end(); return; }
    let result;
    if (m.method === 'server/discover') {
      if (mode !== 'modern') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'legacy' } })); return; }
      result = { supportedVersions: ['2026-07-28'], capabilities, ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1' } } };
    } else if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities, serverInfo: { name: 'fixture', version: '1' } };
    else if (m.method === 'tools/list') result = { ttlMs: 0, cacheScope: 'private', tools: [{ name: 'work', description: 'Fixture task', inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
      ...(support && mode === 'legacy' ? { execution: { taskSupport: support } } : {}) }] };
    else if (m.method === 'tools/call') {
      if (requestDelay) await delay(requestDelay);
      result = !capability || synchronous ? finalOutput : mode === 'modern' ? { resultType: 'task', ...task('working') } : { task: task('working') };
    } else if (m.method === 'tasks/get') {
      polls++;
      const status = pending || polls < 2 ? 'working' : failure ? 'failed' : 'completed';
      result = { ...task(status), ...(mode === 'modern' && status === 'completed' ? { result: malformed ? { content: 'invalid' } : finalOutput } : {}) };
    } else if (m.method === 'tasks/result') {
      if (failure) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'fixture task failed' } })); return; }
      result = malformed ? { content: 'invalid' } : finalOutput;
    }
    else if (m.method === 'tasks/cancel') result = {};
    else result = {};
    if (mode === 'modern') result = { resultType: 'complete', ...result };
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'harness'), cwd: root });
  t.after(() => driver.close());
  const config = { serverName: 'fixture', transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp`, ...(timeout ? { toolCallTimeoutMs: timeout } : {}) };
  if (stdio) {
    const script = path.join(root, 'stdio.mjs');
    await writeFile(script, `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 const response=await fetch(process.argv[2],{method:'POST',headers:{'content-type':'application/json'},body:line});
 if ('id' in request) console.log(await response.text());
}`);
    Object.assign(config, { transport: 'stdio', command: process.execPath, args: [script, config.url] });
    delete config.url;
  }
  const { sessionId } = await driver.createSession({ cwd: root, provider: { id: 'fixture', protocol: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, model: 'fixture', options: { mcpServers: [config] } });
  assert.ok((await driver.listTools(sessionId)).some(tool => tool.name === 'mcp__fixture__work'), JSON.stringify({ statuses: driver.extensionStatus(sessionId), calls }));
  const call = options => driver.callTool(sessionId, 'mcp__fixture__work', {}, { onPermission: async () => true, ...options });
  return { calls, models, call, driver, sessionId, config };
}

test('MCP configuration defaults to 300 seconds and preserves explicit seconds for HTTP and stdio', async () => {
  assert.equal(Config({ serverName: 'x', transport: 'stdio', command: 'fixture' }).toolCallTimeoutMs, 300000);
  assert.equal(Config({ serverName: 'x', transport: 'stdio', command: 'fixture', toolCallTimeoutMs: 60000 }).toolCallTimeoutMs, 60000);
  for (const server of [{ name: 'x', url: 'http://127.0.0.1/mcp' }, { name: 'x', command: 'fixture', args: [] }]) {
    const extension = { type: 'mcp', server };
    assert.equal((await harnessMcpServer(extension, { config: {} }, process.cwd())).toolCallTimeoutMs, 300000);
    assert.equal((await harnessMcpServer({ ...extension, timeout: 600 }, { config: {} }, process.cwd())).toolCallTimeoutMs, 600000);
    await assert.rejects(harnessMcpServer({ ...extension, timeout: -1 }, { config: {} }, process.cwd()), /MCP timeout/);
  }
});

test('extension test and session configuration share timeout and environment conversion', async () => {
  let tested;
  const compat = Object.create(Compat.prototype);
  compat.store = { directory: process.cwd(), read: () => ({ config: { TOKEN: { value: 'fixture-token' } } }) };
  compat.driver = { testExtension: async config => { tested = config; return [{ name: 'fixture' }]; } };
  const extension = { type: 'mcp', timeout: 300, envKeys: ['TOKEN'], server: { name: 'fixture', url: 'http://127.0.0.1/mcp', headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }] } };
  assert.deepEqual(await compat.testExtension({ extension }), { tools: ['fixture'] });
  assert.deepEqual(tested, await harnessMcpServer(extension, compat.store.read(), process.cwd()));
});

for (const mode of ['legacy', 'modern']) {
  test(`${mode} MCP discovers task capability and returns only the final receipt through Harness`, async t => {
    const f = await fixture(t, { mode, support: 'required', timeout: 150 });
    const denied = await f.driver.callTool(f.sessionId, 'mcp__fixture__work', {});
    assert.equal(denied.isError, true);
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 0);
    const result = await f.call();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(result.mcpResult.structuredContent, { done: true });
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
    assert.ok(f.calls.filter(c => c.method === 'tasks/get').length >= 2, 'total execution may exceed the per-request timeout');
    const submitted = f.calls.find(c => c.method === 'tools/call');
    if (mode === 'legacy') assert.deepEqual(submitted.params.task, {});
    else {
      assert.ok(submitted.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions['io.modelcontextprotocol/tasks']);
      assert.equal(f.calls.find(c => c.method === 'tasks/get').headers['mcp-name'], 'fixture-task');
    }
  });
  test(`${mode} MCP cancellation stops polling and requests remote cancellation without resubmission`, async t => {
    const f = await fixture(t, { mode, pending: true });
    const controller = new AbortController();
    const pending = f.call({ signal: controller.signal });
    const started = Date.now();
    while (!f.calls.some(c => c.method === 'tasks/get') && Date.now() - started < 3000) await delay(10);
    controller.abort();
    await pending.catch(() => {});
    const deadline = Date.now() + 2000;
    while (!f.calls.some(c => c.method === 'tasks/cancel') && Date.now() < deadline) await delay(10);
    assert.equal(f.calls.filter(c => c.method === 'tasks/cancel').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  });
  test(`${mode} malformed task results are errors and never trigger a second submission`, async t => {
    const f = await fixture(t, { mode, malformed: true });
    const result = await f.call();
    assert.equal(result.isError, true);
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  });
  test(`${mode} task capability also works over stdio`, async t => {
    const f = await fixture(t, { mode, stdio: true });
    const result = await f.call();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(result.mcpResult.structuredContent, { done: true });
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  });
  test(`${mode} remote task failure remains a failure and is not resubmitted`, async t => {
    const f = await fixture(t, { mode, failure: true });
    assert.equal((await f.call()).isError, true);
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  });
  test(`${mode} task results retain SDK output schema validation`, async t => {
    const f = await fixture(t, { mode, invalidOutput: true });
    const result = await f.call();
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /Structured content does not match/);
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  });
}

test('Harness model loop resumes only after the final async tool result', async t => {
  const f = await fixture(t, { mode: 'modern' });
  const events = [];
  await f.driver.prompt(f.sessionId, 'Run the fixture work tool', { onPermission: async () => true, onEvent: event => events.push(event) });
  assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  assert.equal(f.models.length, 2);
  assert.ok(JSON.stringify(f.models[1].messages).includes('FINISHED_ONCE'));
  assert.equal(JSON.stringify(f.models[1].messages).includes('fixture-task'), false);
  assert.equal(events.filter(event => event.type === 'tool_result' && event.mcpResult?.structuredContent?.done === true).length, 1);
});

test('a task-capable server may still return a synchronous result', async t => {
  const f = await fixture(t, { mode: 'modern', synchronous: true });
  assert.equal((await f.call()).isError, false);
  assert.equal(f.calls.filter(c => c.method.startsWith('tasks/')).length, 0);
});

test('server-level task capability does not override a legacy tool without task support', async t => {
  const f = await fixture(t, { support: null, synchronous: true });
  assert.equal((await f.call()).isError, false);
  assert.equal(f.calls.find(c => c.method === 'tools/call').params.task, undefined);
});

test('a required task tool without negotiated server support fails before dispatch', async t => {
  const f = await fixture(t, { capability: false, support: 'required' });
  assert.equal((await f.call()).isError, true);
  assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 0);
});

test('undeclared task support uses one synchronous call, with no speculative task request', async t => {
  const f = await fixture(t, { capability: false });
  const result = await f.call();
  assert.equal(result.isError, false);
  assert.equal(f.calls.find(c => c.method === 'tools/call').params.task, undefined);
  assert.equal(f.calls.filter(c => c.method.startsWith('tasks/')).length, 0);
});

test('an explicit short timeout remains effective and does not replay the operation', async t => {
  const f = await fixture(t, { capability: false, requestDelay: 100, timeout: 30 });
  const result = await f.call();
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /timed out/i);
  assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  await f.driver.configureSession(f.sessionId, { mcpServers: [{ ...f.config, toolCallTimeoutMs: 300000 }] });
  assert.equal((await f.call()).isError, false, 'the same session uses the newly applied timeout');
});

test('default synchronous MCP timeout permits a real result after 60 seconds', { timeout: 80000 }, async t => {
  const f = await fixture(t, { capability: false, requestDelay: 65000 });
  const start = Date.now();
  const result = await f.call();
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(Date.now() - start >= 65000);
  assert.deepEqual(result.mcpResult.structuredContent, { done: true });
  assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
});
