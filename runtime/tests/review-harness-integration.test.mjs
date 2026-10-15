import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { CODEPRO_ROLES } from '../roles.mjs';
import { zCodeProReviewSnapshotResponse_unstable, zCodeProReviewResultResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

const secret = 'review-harness-isolated-fixture', ext = name => `_goose/unstable/${name}`;
async function connect(url) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/acp?token=${secret}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let counter = 0; const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data)), item = pending.get(msg.id);
    if (item) { clearTimeout(item.timer); pending.delete(msg.id); msg.error ? item.reject(Error(msg.error.message)) : item.resolve(msg.result); return; }
    if (msg.method === 'session/request_permission') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }));
  });
  return { close: () => ws.close(), request(method, params = {}) { const id = ++counter; return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`ACP timeout ${method}`)); }, 40_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }); } };
}
const content = item => typeof item.content === 'string' ? item.content : item.content.map(part => part.text ?? '').join('');

test('original ACP Git and Review flow uses only reviewer Harness result tool, persists results and cancels actual HTTP execution', { timeout: 90_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-review-harness-'))), cwd = path.join(root, 'project'), dataDir = path.join(root, 'data');
  const requests = [], failures = [], phases = new Map(); let phase = 'valid', heldResponse;
  const model = http.createServer(async (req, res) => {
    try {
      if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'main-fixture' }, { id: 'reviewer-fixture' }] })); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (!request.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); return; }
      requests.push(request);
      assert.equal(request.model, 'reviewer-fixture', 'configured reviewer route owns actual model invocation');
      assert.deepEqual(request.tools.map(item => item.function.name), ['codebuddy_review_result'], 'native write/shell/subagent/MCP tools must be absent');
      const snapshot = JSON.parse(content(request.messages.find(item => item.role === 'user')));
      const step = (phases.get(snapshot.snapshotId) ?? 0) + 1; phases.set(snapshot.snapshotId, step);
      assert.match(content(request.messages.find(item => item.role === 'system')), /untrusted/);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (phase === 'cancel') { chunk({ role: 'assistant', content: '' }); heldResponse = res; return; }
      if (phase === 'valid' && step === 1) {
        const findings = [{ id: 'wrong-sum', priority: 1, title: 'sum subtracts instead of adding', body: 'sum(1,2) returns -1 instead of 3.', path: snapshot.files[0].path, side: 'new', startLine: 1, endLine: 1 }];
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'same-result-call', type: 'function', function: { name: 'codebuddy_review_result', arguments: JSON.stringify({ findings }) } }] }); chunk({}, 'tool_calls');
      } else {
        if (phase === 'valid') assert.equal(JSON.parse(content(request.messages.findLast(item => item.role === 'tool'))).accepted, true, 'actual host accepted structured result');
        chunk({ role: 'assistant', content: phase === 'valid' ? 'Review submitted.' : 'No issues, according to this plain text.' }); chunk({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message, type: 'fixture_error' } })); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  let app = await createCompatServer({ dataDir, secret }), client = await connect(await app.listen());
  t.after(async () => { client.close(); await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const provider = await client.request(ext('providers/custom/create'), { engine: 'openai_compatible', displayName: 'Review fixture', apiUrl: `http://127.0.0.1:${model.address().port}`, requiresAuth: false, models: ['main-fixture', 'reviewer-fixture'], supportsStreaming: true, headers: {} });
  await client.request(ext('defaults/save'), { providerId: provider.providerId, modelId: 'main-fixture' });
  await client.request(ext('codepro/model-routing/save'), { config: { version: 2, advancedRoutingEnabled: true, routes: CODEPRO_ROLES.map(role => ({ role, providerId: provider.providerId, modelId: role === 'reviewer' ? 'reviewer-fixture' : 'main-fixture' })), maxParallelCoders: 1, visionRoute: { enabled: false, mode: 'disabled' } } });
  let lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const session = await client.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(cwd, 'module.mjs'), 'export const sum = (a,b) => a+b;\n'); git('add', '--', 'module.mjs');
  await writeFile(path.join(cwd, 'module.mjs'), 'export const sum = (a,b) => a-b;\n');
  const beforeIndex = await readFile(path.join(cwd, '.git/index'));
  const tools = await client.request(ext('tools/list'), { sessionId: session.sessionId, extensionName: 'git' });
  assert.ok(tools.tools.some(tool => tool.name === 'git__git_repository_snapshot'));
  const repository = await client.request(ext('tools/call'), { sessionId: session.sessionId, name: 'git_repository_snapshot', arguments: {} });
  assert.equal(repository.isError, false); assert.equal(JSON.parse(repository.content[0].text).status.entries[0].path, 'module.mjs');
  async function review(method, params) {
    const result = await client.request(ext(`codepro/review/${method}`), { schemaVersion: 1, sessionId: session.sessionId, ...params });
    (method === 'snapshot' ? zCodeProReviewSnapshotResponse_unstable : zCodeProReviewResultResponse_unstable).parse(result); return result;
  }
  async function terminal(reviewId) {
    for (let i = 0; i < 10; i++) { const value = await review('get', { reviewId, includeSnapshot: true }); if (value.result.status !== 'running') return value; await delay(25); }
    throw Error('Review did not settle');
  }
  let snapshot = (await review('snapshot', { scope: 'working_tree' })).snapshot;
  assert.equal(snapshot.model.model, 'reviewer-fixture');
  let result = (await review('start', { snapshotId: snapshot.snapshotId, requestId: 'valid-review' })).result;
  const completed = await terminal(result.reviewId);
  assert.deepEqual(failures, []); assert.equal(completed.result.status, 'completed'); assert.equal(completed.result.findings[0].id, 'wrong-sum');
  assert.equal(requests.length, 2);
  phase = 'plain'; snapshot = (await review('snapshot', { scope: 'working_tree' })).snapshot;
  result = (await review('start', { snapshotId: snapshot.snapshotId, requestId: 'plain-text-review' })).result;
  assert.equal((await terminal(result.reviewId)).result.status, 'failed');
  phase = 'cancel'; snapshot = (await review('snapshot', { scope: 'working_tree' })).snapshot;
  result = (await review('start', { snapshotId: snapshot.snapshotId, requestId: 'cancel-review' })).result;
  for (let i = 0; !heldResponse && i < 100; i++) await delay(20);
  assert.ok(heldResponse, 'cancellation must reach a real running provider request');
  assert.equal((await review('cancel', { reviewId: result.reviewId })).result.status, 'cancelled');
  assert.deepEqual(failures, []); assert.equal(requests.length, 4);
  assert.deepEqual(await readFile(path.join(cwd, '.git/index')), beforeIndex);
  assert.equal(git('for-each-ref').trim(), '');
  client.close(); await app.close();
  app = await createCompatServer({ dataDir, secret }); client = await connect(await app.listen());
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  lease = await client.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'non-empty-directory', expectedIdentity: workspaceIdentity(cwd) });
  await client.request('session/load', { sessionId: session.sessionId, cwd, mcpServers: [], _meta: { workspaceLeaseId: lease.leaseId } });
  const reloaded = await review('get', { reviewId: completed.result.reviewId, includeSnapshot: true });
  assert.equal(reloaded.result.status, 'completed'); assert.deepEqual(reloaded.result.findings, completed.result.findings);
  assert.equal(requests.length, 4, 'reading restored reviews does not rerun the model');
});
