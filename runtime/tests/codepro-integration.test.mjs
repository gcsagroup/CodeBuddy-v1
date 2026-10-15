import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from '../../ui/node_modules/esbuild/lib/main.js';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { CodeProRuns } from '../codepro.mjs';
import { zCodeProRunSnapshotResponse_unstable, zCodeProRunControlResponse_unstable, zCodeProRunNotification_unstable, zCreateSourceResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

const secret = 'codepro-integration-local-fixture';
const ext = (name) => `_goose/unstable/${name}`;
const turn = (sessionId, text = 'Build the two-module fixture') => ({ sessionId, prompt: [{ type: 'text', text }], _meta: { 'codeagentpro/source-message-id': randomUUID() } });

async function connect(url) {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); const notifications = []; const waiters = new Set(); let sequence = 0;
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data)); const entry = pending.get(msg.id);
    if (entry) { clearTimeout(entry.timer); pending.delete(msg.id); msg.error ? entry.reject(Object.assign(new Error(msg.error.message), msg.error)) : entry.resolve(msg.result); return; }
    if (!msg.method) return;
    notifications.push(msg);
    if (msg.method === 'session/request_permission') socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
    for (const waiter of [...waiters]) if (waiter.match(msg)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(msg); }
  });
  socket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Connection closed')); } pending.clear(); });
  const client = {
    notifications,
    request(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`ACP ${method} timed out`)); }, 12_000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
    },
    waitFor(match, from = 0) {
      const existing = notifications.slice(from).find(match); if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => { const entry = { match, resolve, timer: setTimeout(() => { waiters.delete(entry); reject(new Error('Expected ACP notification timed out')); }, 10_000) }; waiters.add(entry); });
    },
    close() { socket.close(); },
  };
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { goose: { customNotifications: true } } } });
  return client;
}

function controlledDriver() {
  const sessions = new Map(); const native = new Map(); const scripts = []; const prompts = []; const calls = [];
  return {
    scripts, prompts, calls,
    async createSession(input) { sessions.set(input.sessionId, input); return { sessionId: input.sessionId }; },
    async configureSession(sessionId, patch) { sessions.set(sessionId, { ...sessions.get(sessionId), ...patch }); },
    async prompt(sessionId, content, options) {
      const script = scripts.shift(); assert.ok(script, 'Fixture must explicitly enqueue each Harness execution');
      const session = sessions.get(sessionId); assert.ok(session);
      prompts.push({ sessionId, content });
      const state = native.get(sessionId) ?? { seq: 0, goal: null };
      native.set(sessionId, state);
      const event = (type, data) => options.onEvent({ type: 'harness_event', sessionId, event: { type, seq: ++state.seq, time: Date.now(), data } });
      const todo = todos => event('todo/write', { todos });
      const goal = async phase => {
        const previous = state.goal;
        state.goal = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, objective: 'Implement and verify the two-module project', phase, maxGoalRounds: 12, activation: phase === 'active' ? 'armed' : 'disarmed' };
        await event('goal/change', { kind: 'goal/change', version: 1, operation: previous ? phase === 'complete' ? 'complete' : 'update' : 'create', goal: state.goal, roundsStarted: prompts.filter(p => p.sessionId === sessionId).length });
      };
      const invoke = async (name, args, execute, structuredContent) => {
        const id = randomUUID();
        await options.onEvent({ type: 'tool_call', id, name, arguments: args, sessionId });
        const approved = await options.onPermission({ id, name, arguments: args, signal: options.signal, sessionId });
        assert.equal(approved, true, 'Fixture permissions must traverse the ACP approval handler');
        calls.push({ sessionId, name, arguments: args });
        const result = await execute();
        await options.onEvent({ type: 'tool_result', id, sessionId, result: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }], isError: false, ...(structuredContent ? { structuredContent: typeof structuredContent === 'function' ? structuredContent(result) : structuredContent } : {}) });
        return result;
      };
      assert.ok(!session.options.tools.some(tool => tool.name === 'codebuddy_task'), 'The compatibility bridge must not install the retired task scheduler');
      const waitForAbort = () => options.signal.aborted ? Promise.resolve() : new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      await event('turn/start', {});
      await script({ session, content, todo, goal, invoke, emit: options.onEvent, signal: options.signal, waitForAbort });
      return { stopReason: options.signal.aborted ? 'cancelled' : 'end_turn', reason: { kind: options.signal.aborted ? 'aborted' : 'completed' }, ...(state.goal ? { goal: state.goal } : {}) };
    },
    async cancel() {}, async close() {}, async listTools() { return []; },
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-codepro-acp-')));
  const dataDir = path.join(root, 'data'); const driver = controlledDriver();
  const model = http.createServer((req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'controlled-model' }] } : { choices: [{ message: { role: 'assistant', content: 'OK' } }] })); });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  let app = await createCompatServer({ dataDir, secret, driver });
  let url = await app.listen(); let client = await connect(url); const clients = [client];
  const provider = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Isolated model fixture', apiUrl: `http://127.0.0.1:${model.address().port}`, requiresAuth: false, models: ['controlled-model'], supportsStreaming: true, headers: {} });
  await client.request(ext('defaults/save'), { providerId: provider.providerId, modelId: 'controlled-model' });
  t.after(async () => { for (const entry of clients) entry.close(); await app.close(); model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); });
  return {
    root, dataDir, driver, get client() { return client; },
    async controlClient() { const c = await connect(url); clients.push(c); return c; },
    async restart() { client.close(); await app.close(); app = await createCompatServer({ dataDir, secret, driver }); url = await app.listen(); client = await connect(url); clients.push(client); return client; },
    async context(sessionId, runId) { const state = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8')); return new CodeProRuns({ read: () => state }).context({ sessionId, runId }); },
    async lease(cwd, expectedState = 'missing') { return client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState, expectedIdentity: workspaceIdentity(cwd) }); },
    async newSession(name = 'workspace') {
      const cwd = path.join(root, name);
      const lease = await this.lease(cwd);
      const source = await client.request(ext('sources/create'), { type: 'project', name, description: 'Isolated integration project', content: '', properties: { workingDirs: [cwd] }, target: { scope: 'global' } });
      zCreateSourceResponse_unstable.parse(source);
      const created = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, projectId: name } });
      return { sessionId: created.sessionId, cwd, source: source.source };
    },
  };
}

const projectTodos = (modules, validation) => [{ content: 'Implement modules', status: modules }, { content: 'Run integration tests', status: validation }];
async function beginPlan({ goal, todo }) { await goal('active'); await todo(projectTodos('in_progress', 'pending')); }
async function implementModules({ invoke, session }) {
  let present;
  try { present = await readFile(path.join(session.cwd, 'math.mjs'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (present === undefined) {
    await invoke('write', { file_path: path.join(session.cwd, 'math.mjs') }, async () => {
      await writeFile(path.join(session.cwd, 'math.mjs'), 'export const add = (a,b) => a+b;\n');
      await writeFile(path.join(session.cwd, 'index.mjs'), "import {add} from './math.mjs'; export const total = values => values.reduce(add,0);\n");
      await writeFile(path.join(session.cwd, 'project.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {total} from './index.mjs'; test('multi-module',()=>{assert.equal(total([3,-1,8]),10); assert.equal(total([]),0)});\n");
      return 'Three files written';
    });
  } else await invoke('read', { file_path: path.join(session.cwd, 'math.mjs') }, async () => { assert.match(present, /export const add/); return present; });
}
async function implementAndVerify(tools) {
  const { invoke, session, todo, goal } = tools;
  await beginPlan(tools);
  await implementModules(tools);
  await todo(projectTodos('completed', 'in_progress'));
  await invoke('bash', { command: 'node --test project.test.mjs' }, async () => {
    const result = spawnSync(process.execPath, ['--test', 'project.test.mjs'], { cwd: session.cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr); return { exitCode: result.status, output: result.stdout };
  }, (result) => ({ exitCode: result.exitCode, aborted: false, timedOut: false }));
  await todo(projectTodos('completed', 'completed'));
  await goal('complete');
}

test('ACP workspace, source, CodePro prompt and original renderer consume a complete tool-backed task', async (t) => {
  const f = await fixture(t); const session = await f.newSession();
  const info = await f.client.request(ext('session/info'), { sessionId: session.sessionId });
  assert.equal(info.session._meta.sessionType, 'code_pro');
  await f.client.request('session/load', { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [] });
  f.driver.scripts.push(async (tools) => { await implementAndVerify(tools); await tools.emit({ type: 'text_delta', text: 'Fixture implementation verified.' }); });
  assert.equal((await f.client.request('session/prompt', turn(session.sessionId))).stopReason, 'end_turn');
  const notices = f.client.notifications.filter((msg) => msg.method === ext('codepro/run/update') && msg.params.snapshot.sessionId === session.sessionId);
  for (const notice of notices) zCodeProRunNotification_unstable.parse(notice.params);
  assert.equal(notices.at(-1).params.snapshot.state, 'completed');
  assert.equal(notices.at(-1).params.snapshot.tasks.filter((task) => task.state === 'succeeded').length, 2);
  const runId = notices.at(-1).params.snapshot.runId;
  const context = await f.context(session.sessionId, runId);
  assert.equal(context.completionKind, 'harness_goal');
  assert.ok(context.tasks.every(task => task.source === 'harness_todo'));
  assert.equal(context.receipts.find(receipt => receipt.kind === 'command').exitCode, 0);
  assert.equal(context.receipts.find(receipt => receipt.kind === 'command').outcome, 'succeeded');
  zCodeProRunSnapshotResponse_unstable.parse(await f.client.request(ext('codepro/run/get'), { schemaVersion: 1, sessionId: session.sessionId, runId }));
  assert.ok(f.client.notifications.some((msg) => msg.method === 'session/request_permission'));
  assert.match(await readFile(path.join(session.cwd, 'index.mjs'), 'utf8'), /math.mjs/);
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../ui/desktop/src/acp/sessionNotificationAdapter.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const original = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const adapter = original.createAcpSessionNotificationAdapter(); let activeRunId;
  for (const msg of f.client.notifications.filter((msg) => msg.params?.sessionId === session.sessionId)) {
    const changes = msg.method === 'session/update' ? adapter.apply(msg.params) : msg.method === ext('session/update') ? adapter.applyGoose(msg.params) : [];
    for (const change of changes) if (change.type === 'sessionInfo' && change.activeRunId) activeRunId = change.activeRunId;
  }
  assert.equal(activeRunId, runId);
  assert.ok(adapter.getMessages().flatMap((message) => message.content).some((content) => content.data?.event_type === 'run_completed'));
  assert.ok(adapter.getMessages().flatMap((message) => message.content).some((content) => content.data?.type === 'codepro_plan_context'), 'actual bridge must send the existing PlanDock binding');
  const terminal = adapter.getMessages().flatMap((message) => message.content).find((content) => content.notificationType === 'turnTerminal');
  assert.ok(terminal, 'unchanged renderer must accept the committed terminal report');
  assert.equal(terminal.data.status, 'completed');
  assert.deepEqual(terminal.data.report.verification_summary, [], 'A successful command receipt is not a host-issued project verification verdict');
  assert.equal(terminal.data.report.recovery_action, 'none');
});

test('history replay distinguishes a live Harness turn from completed and paused runs', async (t) => {
  const f = await fixture(t); const session = await f.newSession(); const viewer = await f.controlClient();
  const activeOnLoad = async () => {
    const start = viewer.notifications.length;
    await viewer.request('session/load', { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [] });
    const text = viewer.notifications.slice(start).filter(msg => msg.method === 'session/update' &&
      msg.params.update.sessionUpdate === 'agent_message_chunk').map(msg => msg.params.update.content?.text).join('');
    if (f.driver.prompts.length > 1) assert.equal(text.split('Published live response.').length - 1, 1, 'Replay includes current messages exactly once, both before and after turn projection');
    return viewer.notifications.slice(start).filter(msg => msg.method === 'session/update' &&
      msg.params.update.sessionUpdate === 'session_info_update').at(-1)?.params.update._meta.goose.activeRunId;
  };
  f.driver.scripts.push(async (tools) => { await tools.emit({ type: 'text_delta', text: 'Hello.' }); });
  await f.client.request('session/prompt', turn(session.sessionId, 'Hello'));
  assert.equal(await activeOnLoad(), null, 'A completed history must not reopen the waiting indicator');
  let started; const ready = new Promise(resolve => { started = resolve; });
  f.driver.scripts.push(async tools => { await beginPlan(tools); await tools.emit({ type: 'text_delta', text: 'Published live response.' }); started(); await tools.waitForAbort(); });
  const running = f.client.request('session/prompt', turn(session.sessionId, 'Continue'));
  await ready;
  assert.equal(typeof await activeOnLoad(), 'string', 'Loading an executing turn must retain its live run');
  await f.client.request('session/cancel', { sessionId: session.sessionId });
  await running;
  assert.equal(await activeOnLoad(), null, 'A paused run remains inspectable without claiming a live model request');
  assert.ok(viewer.notifications.some(msg => msg.method === ext('codepro/run/update') && msg.params.snapshot.state === 'paused'));
});

test('ACP control connection pauses and resumes the same Harness task exactly once', async (t) => {
  const f = await fixture(t); const session = await f.newSession(); const control = await f.controlClient();
  let entered; const ready = new Promise((resolve) => { entered = resolve; });
  f.driver.scripts.push(async (tools) => { await beginPlan(tools); entered(); await tools.waitForAbort(); await tools.goal('paused'); });
  const first = f.client.request('session/prompt', turn(session.sessionId)); await ready;
  const observed = (await f.client.waitFor((msg) => msg.method === ext('codepro/run/update'))).params.snapshot;
  const latest = (await control.request(ext('codepro/run/get'), { schemaVersion: 1, sessionId: session.sessionId, runId: observed.runId })).snapshot;
  const pause = { schemaVersion: 1, sessionId: session.sessionId, runId: latest.runId, commandId: 'pause', expectedSequence: latest.lastSequence, action: { type: 'pause_run', reason: 'Pause integration fixture' } };
  const paused = await control.request(ext('codepro/run/control'), pause); zCodeProRunControlResponse_unstable.parse(paused);
  assert.equal((await first).stopReason, 'cancelled'); assert.equal(paused.snapshot.state, 'paused');
  assert.deepEqual(await control.request(ext('codepro/run/control'), pause), paused);
  f.driver.scripts.push(implementAndVerify);
  const from = f.client.notifications.length;
  const resume = { ...pause, commandId: 'resume', expectedSequence: paused.snapshot.lastSequence, action: { type: 'resume_run' } };
  const resumed = await control.request(ext('codepro/run/control'), resume);
  zCodeProRunControlResponse_unstable.parse(resumed);
  const done = await f.client.waitFor((msg) => msg.method === ext('codepro/run/update') && msg.params.snapshot.runId === latest.runId && msg.params.snapshot.state === 'completed', from);
  assert.deepEqual(await control.request(ext('codepro/run/control'), resume), resumed);
  assert.equal(done.params.snapshot.runId, latest.runId); assert.equal(f.driver.prompts.length, 2);
});

test('ACP backend restart restores plan and receipts and requires a fresh confirmed workspace', async (t) => {
  const f = await fixture(t); const session = await f.newSession();
  f.driver.scripts.push(async (tools) => {
    await beginPlan(tools);
    await implementModules(tools);
    await tools.todo(projectTodos('completed', 'pending'));
    await tools.goal('paused');
  });
  await f.client.request('session/prompt', turn(session.sessionId));
  const before = f.client.notifications.filter((msg) => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  assert.equal(before.state, 'paused');
  const moduleBefore = await readFile(path.join(session.cwd, 'math.mjs'), 'utf8');
  const modifiedBefore = (await stat(path.join(session.cwd, 'math.mjs'))).mtimeMs;
  await f.restart();
  await assert.rejects(f.client.request('session/load', { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [] }), /re-confirmed|confirmed again/);
  const lease = await f.lease(session.cwd, 'non-empty-directory');
  await f.client.request('session/load', { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [], _meta: { workspaceLeaseId: lease.leaseId } });
  const restored = await f.client.request(ext('codepro/run/get'), { schemaVersion: 1, sessionId: session.sessionId, runId: before.runId });
  assert.deepEqual(restored.snapshot, before);
  const facts = await f.context(session.sessionId, before.runId);
  assert.equal(facts.receipts.length, 1);
  assert.equal(facts.nativeGoal.phase, 'paused');
  assert.match(facts.goal, /two-module/);
  f.driver.scripts.push(implementAndVerify);
  await f.client.request('session/prompt', turn(session.sessionId, 'Continue from the saved work'));
  assert.equal(await readFile(path.join(session.cwd, 'math.mjs'), 'utf8'), moduleBefore);
  assert.equal((await stat(path.join(session.cwd, 'math.mjs'))).mtimeMs, modifiedBefore);
  assert.equal(f.driver.calls.filter(call => call.name === 'write').length, 1, 'Resume must inspect and test existing implementation, not rewrite it');
  const final = f.client.notifications.filter((msg) => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  assert.equal(final.state, 'completed');
  assert.equal(final.runId, before.runId);
});

test('explicit plain answer uses the latest CodePro UI without fake code or tests', async (t) => {
  const f = await fixture(t); const session = await f.newSession();
  f.driver.scripts.push(async ({ emit }) => { await emit({ type: 'text_delta', text: '你好，今天可以一起开发项目。' }); });
  await f.client.request('session/prompt', turn(session.sessionId, '你好'));
  const projection = f.client.notifications.filter((msg) => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  assert.equal(projection.state, 'completed'); assert.deepEqual(projection.tasks, []); assert.deepEqual(projection.effects, []);
  assert.equal((await f.context(session.sessionId, projection.runId)).completionKind, 'harness_turn');
  f.driver.scripts.push(async ({ emit }) => { await emit({ type: 'text_delta', text: '可以继续交流。' }); });
  await f.client.request('session/prompt', turn(session.sessionId, '再聊一句'));
  const second = f.client.notifications.filter(msg => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  assert.notEqual(second.runId, projection.runId, 'A finished ordinary turn does not become an unfinished goal');
  assert.equal((await f.context(session.sessionId, second.runId)).completionKind, 'harness_turn');
});

test('provider interruption leaves a failed run and a renderer-compatible failure report', async (t) => {
  const f = await fixture(t); const session = await f.newSession();
  f.driver.scripts.push(async () => { throw new Error('Isolated provider interruption'); });
  await assert.rejects(f.client.request('session/prompt', turn(session.sessionId)), /Isolated provider interruption/);
  const projection = f.client.notifications.filter((msg) => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  assert.equal(projection.state, 'failed');
  const context = await f.context(session.sessionId, projection.runId);
  assert.equal(context.completionKind, null);
  assert.equal(context.terminalError.message, 'Isolated provider interruption');
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../ui/desktop/src/acp/sessionNotificationAdapter.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const original = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const adapter = original.createAcpSessionNotificationAdapter();
  for (const msg of f.client.notifications.filter((msg) => msg.method === ext('session/update'))) adapter.applyGoose(msg.params);
  const terminal = adapter.getMessages().flatMap((message) => message.content).find((content) => content.notificationType === 'turnTerminal');
  assert.ok(terminal, 'original renderer should retain the interrupted run terminal');
  assert.equal(terminal.data.status, 'failed');
  assert.equal(terminal.data.report.outcome, 'failed');
});

for (const [name, details] of [
  ['nonzero exit', { exitCode: 1 }],
  ['aborted', { exitCode: 0, aborted: true }],
  ['timed out', { exitCode: 0, timedOut: true }],
  ['background process', { exitCode: 0, background: true }],
  ['missing exit code', {}],
]) test(`ACP ${name} tool result never becomes successful completion evidence`, async (t) => {
  const f = await fixture(t); const session = await f.newSession();
  f.driver.scripts.push(async ({ todo, invoke }) => {
    await todo([{ content: 'Check fixture', status: 'in_progress' }]);
    await invoke('bash', { command: 'node --test' }, async () => 'Tool execution envelope', details);
  });
  await f.client.request('session/prompt', turn(session.sessionId));
  const projection = f.client.notifications.filter((msg) => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  const context = await f.context(session.sessionId, projection.runId);
  assert.equal(context.completionKind, 'harness_turn');
  assert.notEqual(context.completionKind, 'verified_task');
  assert.equal(context.receipts.at(-1).outcome, name === 'nonzero exit' ? 'failed' : 'unknown');
  assert.equal(context.receipts.at(-1).exitCode, details.exitCode ?? null);
  assert.equal(context.tasks[0].state, 'running', 'A finished assistant turn does not complete an in-progress native todo');
});
