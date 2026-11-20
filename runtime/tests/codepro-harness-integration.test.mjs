import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import { answerTitleRequest } from './fixtures/title-request.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { zCodeProRunSnapshot } from '../../ui/sdk/src/generated/zod.gen.ts';

const secret = 'official-codepro-harness-isolated-fixture';
const ext = (name) => `_goose/unstable/${name}`;
async function connect(url) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map(); const notifications = [];
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data)); const request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); clearTimeout(request.timer); msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result); return; }
    notifications.push(msg);
    if (msg.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
  });
  ws.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('ACP closed')); } pending.clear(); });
  return { notifications, close: () => ws.close(), request(method, params = {}) { const id = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45_000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }); } };
}

function lastGoal(request) {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== 'tool') continue;
    try { const value = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map((block) => block.text ?? '').join('')); if (value.goal?.id) return value.goal; } catch {}
  }
  throw new Error('Official Harness request lacks a native goal result');
}

async function scriptedModel(cwd) {
  const requests = []; const failures = []; const sequence = { initial: 0, resume: 0 };
  const checkpoint = Promise.withResolvers();
  const todos = (implementation, verification) => ({ name: 'todo_write', args: { todos: [{ content: 'Implement independent math and invoice modules', status: implementation }, { content: 'Verify cross-module totals with actual node tests', status: verification }] } });
  const updateGoal = (request, action) => { const goal = lastGoal(request); return { name: 'update_goal', args: { goal_id: goal.id, revision: goal.revision, action } }; };
  const scripts = {
    initial: [
      () => ({ name: 'create_goal', args: { objective: 'Implement and verify the independent math and invoice project', max_goal_rounds: 12 } }),
      () => todos('in_progress', 'pending'),
      () => ({ name: 'write', args: { file_path: path.join(cwd, 'math.mjs'), content: 'export const add = (a,b) => a+b;\n' } }),
      () => ({ name: 'write', args: { file_path: path.join(cwd, 'invoice.mjs'), content: "import {add} from './math.mjs'; export const total = items => items.reduce(add,0);\n" } }),
      () => ({ name: 'write', args: { file_path: path.join(cwd, 'project.test.mjs'), content: "import test from 'node:test'; import assert from 'node:assert/strict'; import {total} from './invoice.mjs'; test('cross-module totals',()=>{assert.equal(total([4,-1,8]),11); assert.equal(total([]),0)});\n" } }),
      () => todos('completed', 'pending'),
      () => ({ text: 'Implementation is saved. Verification remains unfinished.' }),
    ],
    resume: [
      () => ({ name: 'get_goal', args: {} }),
      (request) => { assert.equal(lastGoal(request).phase, 'active'); assert.match(JSON.stringify(request.messages), /Implementation is saved/); return updateGoal(request, 'resume'); },
      () => todos('completed', 'in_progress'),
      () => {
        const quote = (value) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
        const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} --test ${quote(path.join(cwd, 'project.test.mjs'))}`;
        return { name: process.platform === 'win32' ? 'pwsh' : 'bash', args: { command, description: 'Run isolated actual Node multi-module integration tests' } };
      },
      () => todos('completed', 'completed'),
      () => ({ name: 'get_goal', args: {} }),
      (request) => updateGoal(request, 'complete'),
      () => ({ text: 'OFFICIAL_HARNESS_CODEPRO_VERIFIED' }),
    ],
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/openapi.json')) { res.writeHead(404).end(); return; }
    try {
      if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'official-codepro-fixture' }] })); return; }
      let raw = ''; for await (const part of req) raw += part;
      const request = JSON.parse(raw);
    if (replyToNoActionReview(request, res)) return; requests.push(request);
      if (!request.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); return; }
      if (answerTitleRequest(request, res, 'Math and invoice project')) return;
      const user = [...request.messages].reverse().find((message) => message.role === 'user' && JSON.stringify(message.content).includes('official_codepro_'));
      assert.ok(user, 'fixture should be isolated to explicit project requests');
      const phase = JSON.stringify(user.content).includes('official_codepro_resume') ? 'resume' : 'initial';
      if (phase === 'initial' && sequence.initial === scripts.initial.length) {
        sequence.initial++;
        checkpoint.resolve();
        await new Promise(resolve => res.once('close', resolve));
        return;
      }
      const next = scripts[phase][sequence[phase]++]; assert.ok(next, 'No unbounded model continuation');
      let result = next(request);
      if (result.name && !request.tools.some(t => t.function.name === result.name)) {
        sequence[phase]--;
        result = { name: 'search_mcp_tools', args: { names: [result.name] } };
      }
      assert.ok(!request.tools.some((tool) => tool.function.name === 'codebuddy_task'));
      if (result.name) assert.ok(request.tools.some((tool) => tool.function.name === result.name), `Official plugin missing ${result.name}`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (result.name) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: result.name, arguments: JSON.stringify(result.args) } }] }); emit({}, 'tool_calls'); }
      else { emit({ role: 'assistant', content: result.text }); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message, type: 'fixture_contract_error' } })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, failures, sequence, checkpoint: checkpoint.promise, url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

test('official Harness goal and todo write two modules, pause, restart and finish with native tools', { timeout: 90_000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-official-codepro-')));
  const dataDir = path.join(root, 'data'); const cwd = path.join(root, 'project');
  const model = await scriptedModel(cwd);
  // No injected driver: this exercises server -> Compat -> official Harness
  // AgentLoop -> plugin tools -> actual files/native shell -> persisted facts.
  let app = await createCompatServer({ dataDir, secret }); let client = await connect(await app.listen());
  t.after(async () => { client.close(); await app.close(); await model.close(); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const configured = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Official CodePro fixture', apiUrl: model.url, requiresAuth: false, models: ['official-codepro-fixture'], supportsStreaming: true, headers: {} });
  await client.request(ext('defaults/save'), { providerId: configured.providerId, modelId: 'official-codepro-fixture' });
  let lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const created = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } });
  const prompt = (marker) => client.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: marker }], _meta: { 'codeagentpro/source-message-id': randomUUID() } });
  const initial = prompt('official_codepro_initial: implement and verify the independent project modules');
  await model.checkpoint;
  await client.request('session/cancel', { sessionId: created.sessionId });
  assert.equal((await initial).stopReason, 'cancelled');
  assert.deepEqual(model.failures, []);
  const before = client.notifications.filter((msg) => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  assert.equal(before.state, 'paused');
  const file = path.join(cwd, 'invoice.mjs'); const beforeStat = await stat(file); const beforeContents = await readFile(file, 'utf8');
  assert.match(beforeContents, /math.mjs/);
  client.close(); await app.close();
  app = await createCompatServer({ dataDir, secret }); client = await connect(await app.listen());
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'non-empty-directory', expectedIdentity: workspaceIdentity(cwd) });
  await client.request('session/load', { sessionId: created.sessionId, cwd, mcpServers: [], _meta: { workspaceLeaseId: lease.leaseId } });
  const restored = await client.request(ext('codepro/run/get'), { schemaVersion: 1, sessionId: created.sessionId, runId: before.runId });
  assert.deepEqual(restored.snapshot, before);
  assert.equal((await prompt('official_codepro_resume: verify and finish existing work without rewriting the modules')).stopReason, 'end_turn');
  assert.deepEqual(model.failures, []);
  assert.deepEqual(model.sequence, { initial: 8, resume: 8 });
  const after = client.notifications.filter((msg) => msg.method === ext('codepro/run/update')).at(-1).params.snapshot;
  zCodeProRunSnapshot.parse(after);
  assert.equal(after.runId, before.runId); assert.equal(after.state, 'completed'); assert.equal(after.tasks.filter((task) => task.state === 'succeeded').length, 2);
  assert.equal((await stat(file)).mtimeMs, beforeStat.mtimeMs, 'completed file writes are not replayed after restart');
  assert.equal(await readFile(file, 'utf8'), beforeContents);
  const stored = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const row = stored.codeproRuns.find((run) => run.runId === before.runId);
  const results = row.events.filter((event) => event.eventType === 'tool_result');
  assert.equal(row.events.filter((event) => ['plan_submitted', 'task_started', 'run_completed'].includes(event.eventType)).length, 0, 'no second CodeBuddy execution protocol');
  assert.equal(row.events.at(-1).payload.completionKind, 'harness_goal');
  const command = results.find((event) => event.payload.kind === 'command');
  assert.equal(command.payload.exitCode, 0);
  assert.match(command.payload.command, /project\.test\.mjs/);
  assert.equal(results.filter((event) => event.payload.kind === 'write').length, 3);
  const independentlyVerified = spawnSync(process.execPath, ['--test', path.join(cwd, 'project.test.mjs')], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(independentlyVerified.status, 0, independentlyVerified.stdout + independentlyVerified.stderr);
  assert.equal(client.notifications.some((msg) => msg.method === 'session/request_permission' && msg.params.toolCall.title === (process.platform === 'win32' ? 'pwsh' : 'bash')), false, 'Native workspace commands do not need the former blanket CodeBuddy approval');
});
