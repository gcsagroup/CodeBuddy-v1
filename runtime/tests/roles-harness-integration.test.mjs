import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import { answerTitleRequest } from './fixtures/title-request.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createCompatServer } from '../server.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { zCodeProRunSnapshot } from '../../ui/sdk/src/generated/zod.gen.ts';

const secret = 'isolated-official-harness-role-fixture';
const ext = name => `_goose/unstable/${name}`;
async function connect(url) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0; const requests = new Map(); const notifications = [];
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data)); const request = requests.get(msg.id);
    if (request) { clearTimeout(request.timer); requests.delete(msg.id); msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result); return; }
    notifications.push(msg);
    if (msg.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
  });
  ws.addEventListener('close', () => { for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('ACP closed')); } requests.clear(); });
  return { notifications, close: () => ws.close(), request(method, params = {}) { const current = ++id; return new Promise((resolve, reject) => { const timer = setTimeout(() => { requests.delete(current); reject(new Error(`Timed out: ${method}`)); }, 70_000); requests.set(current, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: current, method, params })); }); } };
}
function content(message) { return typeof message.content === 'string' ? message.content : message.content.map(item => item.text ?? '').join(''); }
async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error('Timed out waiting for actual worker lifecycle');
}

async function modelFixture(cwd, completedChildren) {
  const failures = []; const requests = []; const count = { main: 0, a: 0, b: 0, c: 0 };
  let releaseChildren; const childrenMayRun = new Promise(resolve => { releaseChildren = resolve; });
  const todo = status => ({ name: 'todo_write', args: { todos: [{ content: 'Implement and verify independent worker modules', status }] } });
  const spawn = marker => ({ name: 'subagent', args: { description: `Fixture ${marker}`, prompt: `role_fixture_child_${marker}: perform only the delegated module work ${marker}` } });
  const scripts = {
    main: [
      () => ({ name: 'search_mcp_tools', args: { names: ['subagent', 'write', 'todo_write', process.platform === 'win32' ? 'pwsh' : 'bash'] } }),
      () => todo('in_progress'),
      () => spawn('a'),
      () => spawn('b'),
      () => spawn('c'),
      () => spawn('fourth'),
      async request => {
        const result = [...request.messages].reverse().find(message => message.role === 'tool');
        assert.match(content(result), /active child limit: 3/i, 'the fourth concurrent child is refused by the native Host');
        releaseChildren();
        await until(async () => await completedChildren() === 3);
        return { name: 'write', args: { file_path: path.join(cwd, 'project.test.mjs'), content: "import test from 'node:test'; import assert from 'node:assert/strict'; import {invoice} from './invoice.mjs'; test('parallel role modules integrate',()=>assert.equal(invoice(),6));\n" } };
      },
      () => {
        const quote = value => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
        return { name: process.platform === 'win32' ? 'pwsh' : 'bash', args: { command: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} --test ${quote(path.join(cwd, 'project.test.mjs'))}`, description: 'Verify modules written by independent actual Harness children' } };
      },
      () => todo('completed'),
      () => ({ text: 'OFFICIAL_ROLE_PROJECT_VERIFIED' }),
    ],
    c: [async () => { await childrenMayRun; return { text: 'GENERIC_THIRD_CHILD_DONE' }; }],
  };
  for (const actor of ['a', 'b']) scripts[actor] = [
    async () => { await childrenMayRun; return { name: 'write', callId: 'same-native-write-call-id', args: { file_path: path.join(cwd, actor === 'a' ? 'math.mjs' : 'invoice.mjs'), content: actor === 'a' ? 'export const three=3;\n' : "import {three} from './math.mjs'; export const invoice=()=>three*2;\n" } }; },
    () => ({ text: `WORKER_${actor.toUpperCase()}_DONE` }),
  ];
  const models = ['selected-main', ...['default', 'main', 'planner', 'coder', 'tester', 'reviewer'].map(role => `role-${role}`)];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.endsWith('/api/tags')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({models: models.map(name => ({name}))})); return; }
      if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: models.map(id => ({ id })) })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
    if (replyToNoActionReview(request, res)) return;
      if (req.url.endsWith('/api/show')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({capabilities:['completion','thinking','tools'],thinking:{values:['low','medium','high'],default:'medium'}})); return; }
    if (answerTitleRequest(request, res)) return;
      requests.push(request);
      if (!request.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); return; }
      assert.equal(request.model, 'selected-main', 'the current session model owns main and child requests despite saved role routes');
      assert.equal(request.reasoning_effort, 'high', 'native children inherit the actual parent effort');
      const actor = ['a', 'b', 'c', 'fourth'].find(candidate => request.messages.some(message => message.role === 'user' && content(message).includes(`role_fixture_child_${candidate}:`))) ?? 'main';
      assert.notEqual(actor, 'fourth', 'a refused child must not reach a model');
      const next = scripts[actor][count[actor]++]; assert.ok(next, `Unplanned model continuation for ${actor}`);
      let response = await next(request);
      if (response.name && !request.tools.some(t => t.function.name === response.name)) {
        count[actor]--;
        response = { name: 'search_mcp_tools', args: { names: [response.name] } };
      }
      assert.ok(!request.tools.some(tool => tool.function.name === 'codebuddy_task'));
      assert.ok(!request.tools.some(tool => ['subagent_coder', 'subagent_planner', 'subagent_reviewer', 'subagent_tester'].includes(tool.function.name)));
      const spawnTool = request.tools.find(tool => tool.function.name === 'subagent');
      if (spawnTool) for (const key of ['provider', 'model', 'reasoning_effort']) assert.equal(Object.hasOwn(spawnTool.function.parameters.properties, key), false);
      if (response.name) assert.ok(request.tools.some(tool => tool.function.name === response.name), `Missing actual tool ${response.name}`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (response.name) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: response.callId ?? randomUUID(), type: 'function', function: { name: response.name, arguments: JSON.stringify(response.args) } }] }); emit({}, 'tool_calls'); }
      else { emit({ role: 'assistant', content: response.text }); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); releaseChildren(); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message, type: 'fixture_contract_error' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, failures, count, models, url: `http://127.0.0.1:${server.address().port}`, async close() { releaseChildren(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('ACP uses the selected main model and three native generic children despite obsolete role routing', { timeout: 90_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-official-roles-')));
  const cwd = path.join(root, 'project'); const dataDir = path.join(root, 'data');
  let client;
  const endedChildren = new Set();
  const model = await modelFixture(cwd, async () => endedChildren.size);
  const native = await createHarnessDriver({ dataDir: path.join(dataDir, 'harness'), instructionsHome: root });
  // Observe actual driver notifications after the compatibility consumer commits
  // them. Repeatedly opening state.json while Windows replaces it adds fixture
  // lock contention; durable state is still read independently after completion.
  const driver = new Proxy(native, { get(target, key) {
    if (key === 'prompt') return (sessionId, prompt, options = {}) => target.prompt(sessionId, prompt, { ...options, onEvent: async event => {
      await options.onEvent?.(event);
      if (event.type === 'subagent_end') endedChildren.add(event.runId);
    } });
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
  const app = await createCompatServer({ dataDir, secret, driver }); client = await connect(await app.listen());
  t.after(async () => { client.close(); await model.close(); await app.close(); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const provider = await client.request(ext('providers/custom/create'), { engine: 'ollama_compatible', displayName: 'Official roles fixture', apiUrl: model.url, requiresAuth: false, models: model.models, supportsStreaming: true, headers: {} });
  await client.request(ext('defaults/save'), { providerId: provider.providerId, modelId: 'role-default' });
  await client.request(ext('codepro/model-routing/save'), { config: { version: 2, advancedRoutingEnabled: true, routes: ['main', 'planner', 'coder', 'tester', 'reviewer'].map(role => ({ role, providerId: provider.providerId, modelId: `role-${role}` })), maxParallelCoders: 2, visionRoute: { enabled: false, mode: 'disabled' } } });
  await client.request(ext('preferences/save'), { expectedRevision: 0, values: [{ key: 'gooseThinkingEffort', value: 'high' }] });
  const lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const session = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } });
  // Child execution is unattended. Project writes require the parent's smart
  // policy; answering root approval RPCs cannot grant a child's denied write.
  // Manual-mode denials are covered by native-delegation.test.mjs.
  await client.request('session/set_mode', { sessionId: session.sessionId, modeId: 'workspace-write' });
  await client.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: 'selected-main' });
  const result = await client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'official_role_fixture: develop and verify a multi-module project with independent workers' }], _meta: { 'codeagentpro/source-message-id': randomUUID() } }).catch(error => {
    throw new Error(`${error.message}; actual model counts=${JSON.stringify(model.count)}; fixture failures=${JSON.stringify(model.failures.map(failure => failure.message))}`, { cause: error });
  });
  assert.deepEqual(model.failures.map(error => error.message), []);
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(model.count, { main: 10, a: 2, b: 2, c: 1 });
  const snapshot = client.notifications.filter(msg => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  zCodeProRunSnapshot.parse(snapshot);
  assert.equal(snapshot.state, 'completed');
  const stored = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(stored.sessions.find(item => item.id === session.sessionId).modelId, 'selected-main');
  const events = stored.codeproRuns.find(run => run.runId === snapshot.runId).events;
  const writes = events.filter(event => event.eventType === 'tool_result' && event.payload.callId.endsWith(':same-native-write-call-id'));
  assert.equal(writes.length, 2); assert.equal(new Set(writes.map(event => event.payload.callId)).size, 2);
  assert.ok(writes.every(event => event.payload.taskId === null), 'native workers do not need host task registration');
  assert.ok(writes.every(event => event.payload.internal === true), 'child receipts remain internal while retaining their audit identity');
  assert.equal(events.filter(event => event.eventType === 'plan_submitted').length, 0);
  const lifecycle = events.filter(event => event.eventType === 'harness_event' && event.payload.event.type.startsWith('subagent/'));
  assert.equal(lifecycle.filter(event => event.payload.event.type === 'subagent/start').length, 3);
  assert.equal(lifecycle.filter(event => event.payload.event.type === 'subagent/end').length, 3);
  const captions = client.notifications.filter(message => message.method === 'session/update')
    .map(message => message.params.update._meta?.goose?.subagentLifecycle).filter(Boolean);
  assert.equal(captions.filter(caption => caption.phase === 'start').length, 3);
  assert.equal(captions.filter(caption => caption.phase === 'end').length, 3);
  assert.equal(new Set(captions.map(caption => caption.event_id)).size, 6);
  assert.ok(captions.every(caption => caption.session_id === session.sessionId));
  for (const caption of captions) assert.ok(lifecycle.some(event =>
    event.payload.event.data.id === caption.child_session_id && event.payload.event.data.runId === caption.activation_id));
  const beforeReplay = client.notifications.length;
  await client.request('session/load', { sessionId: session.sessionId, cwd, mcpServers: [] });
  const replayedCaptions = client.notifications.slice(beforeReplay).filter(message => message.method === 'session/update')
    .map(message => message.params.update._meta?.goose?.subagentLifecycle).filter(Boolean);
  assert.deepEqual(replayedCaptions.map(caption => caption.event_id), captions.map(caption => caption.event_id));
  assert.deepEqual(model.count, { main: 10, a: 2, b: 2, c: 1 }, 'Replaying display receipts must not resume any Agent');
  assert.equal(events.filter(event => event.eventType === 'tool_result' && event.payload.kind === 'command' && event.payload.exitCode === 0).length, 1);
  assert.match(await readFile(path.join(cwd, 'math.mjs'), 'utf8'), /three=3/);
  assert.match(await readFile(path.join(cwd, 'invoice.mjs'), 'utf8'), /math.mjs/);
});
