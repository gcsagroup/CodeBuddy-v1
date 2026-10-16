import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { build } from '../../ui/node_modules/esbuild/lib/main.js';
import { createCompatServer } from '../server.mjs';
import { unfinishedCompactions, recoveredCompactionUpdates } from '../context-updates.mjs';
import { zSessionUsageUpdate } from '../../ui/sdk/src/generated/zod.gen.ts';

test('ACP live threshold, repeated compaction, manual command, cancellation and replay use Harness facts', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-compaction-acp-'));
  const requests = [], notifications = [];
  let slow = false, slowStarted = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture', contextWindow: 32768 }] })); return; }
    let raw = ''; for await (const c of req) raw += c;
    const request = JSON.parse(raw);
    if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
    requests.push(request);
    const summary = JSON.stringify(request.messages.at(-1)).includes('compaction engine');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (slow && summary) { slowStarted.resolve(); return; }
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant', content: summary ? 'Preserved requirement: integer cents. Next: verify tests.' : 'Actual project evidence for a controlled fixture. '.repeat(700) });
    emit({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const secret = 'controlled-compaction-secret', dataDir = path.join(root, 'data');
  let app, ws, seq = 0; const pending = new Map();
  async function connect() {
    app = await createCompatServer({ dataDir, secret });
    ws = new WebSocket((await app.listen()).replace('http:', 'ws:') + '/acp?token=' + secret);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(String(data)), p = pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
      else notifications.push(m);
    };
    await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  }
  function rpc(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('Timeout ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }); }
  const ext = (name, params) => rpc('_goose/unstable/' + name, params);
  t.after(async () => { ws?.close(); await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await connect();
  const { providerId } = await ext('providers/custom/create', { engine: 'openai_compatible', displayName: 'Fixture', apiUrl: `http://127.0.0.1:${server.address().port}`, requiresAuth: false, models: ['fixture'], headers: {}, supportsStreaming: true });
  await ext('defaults/save', { providerId, modelId: 'fixture' });
  const threshold = async value => { const { revision } = await ext('preferences/read', {}); await ext('preferences/save', { expectedRevision: revision, values: [{ key: 'autoCompactThreshold', value }] }); };
  await threshold(0.9);
  const { sessionId } = await rpc('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: [] } });
  const prompt = text => rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const updates = () => notifications.filter(n => n.method === '_goose/unstable/session/update').map(n => n.params.update);
  const compact = () => updates().filter(u => u.status?.data?.event === 'compaction_lifecycle');
  await prompt('Preserve integer cents and complete the project.');
  assert.equal(compact().length, 0);
  await threshold(0.2);
  for (let i = 0; i < 3; i++) await prompt('Continue project stage ' + i);
  assert.ok(compact().filter(u => u.status.data.status === 'completed').length >= 2);
  assert.ok(compact().every(u => u.status.data.trigger === 'auto'));
  const usages = updates().filter(u => u.sessionUpdate === 'usage_update');
  usages.forEach(u => zSessionUsageUpdate.parse(u));
  assert.ok(usages.some((u, i) => i && u.used < usages[i - 1].used), 'context must shrink while the same chat stays open');
  const previous = compact().length;
  await prompt('/compact');
  assert.ok(compact().slice(previous).every(u => u.status.data.trigger === 'manual'));
  assert.equal(compact().at(-1).status.data.status, 'completed');
  assert.ok(requests.every(r => !r.messages.some(m => m.content === '/compact')));
  await prompt('Add further evidence.');
  slow = true; const running = prompt('/compact'); await slowStarted.promise;
  // The HTTP request can arrive before the async durable notification append.
  // Load only after the lifecycle under test has actually reached this client.
  for (let i = 0; compact().at(-1)?.status.data.status !== 'started' && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(compact().at(-1)?.status.data.status, 'started');
  await rpc('session/load', { sessionId, cwd: root, mcpServers: [] });
  assert.equal(compact().at(-1).status.data.status, 'started', 'loading a live operation must not mark it interrupted');
  await rpc('session/cancel', { sessionId }); assert.equal((await running).stopReason, 'cancelled');
  assert.equal(compact().at(-1).status.data.status, 'cancelled'); slow = false;
  // Existing renderer consumes the same usage and lifecycle contract unchanged.
  const output = await build({ entryPoints: [path.resolve('ui/desktop/src/acp/sessionNotificationAdapter.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
  const { createAcpSessionNotificationAdapter } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
  const adapter = createAcpSessionNotificationAdapter();
  const changes = notifications.filter(n => n.method === '_goose/unstable/session/update').flatMap(n => adapter.applyGoose(n.params));
  assert.ok(changes.some(c => c.type === 'tokenState' && c.tokenState.totalTokens > 0));
  assert.ok(changes.some(c => c.type === 'compactionLifecycle' && c.lifecycle.status === 'completed'));
  ws.close(); await app.close(); await connect(); notifications.length = 0;
  await rpc('session/load', { sessionId, cwd: root, mcpServers: [] });
  assert.ok(updates().some(u => u.sessionUpdate === 'usage_update'));
  assert.equal(compact().at(-1).status.data.status, 'cancelled');
  assert.equal((await prompt('Resume after restart.')).stopReason, 'end_turn');
});

test('recovery uses the exact durable Harness outcome when its desktop notification was lost', () => {
  const started = id => ({ sessionUpdate: 'status_message', status: { type: 'progress', data: { event: 'compaction_lifecycle', operation_id: id, status: 'started' } } });
  const updates = [started('committed'), started('failed'), started('unknown'), started('already-closed'), { status: { data: { event: 'compaction_lifecycle', operation_id: 'already-closed', status: 'cancelled' } } }];
  const reconciled = recoveredCompactionUpdates(unfinishedCompactions(updates), [
    { type: 'compaction/end', data: { compactionId: 'other' } },
    { type: 'compaction/end', data: { compactionId: 'committed' } },
    { type: 'compaction/end', data: { compactionId: 'failed', error: 'Controlled native failure' } },
  ]);
  assert.deepEqual(reconciled.map(u => [u.status.data.operation_id, u.status.data.status]), [['committed', 'completed'], ['failed', 'failed'], ['unknown', 'failed']]);
  assert.equal(reconciled[1].status.data.error, 'Controlled native failure');
  assert.match(reconciled[2].status.message, /结果未确认/);
  assert.equal(updates[0].status.data.status, 'started', 'persisted projection remains unchanged');
});

test('a process killed during compaction restarts without a stale renderer spinner and keeps original facts', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-compaction-crash-'));
  let slow = false, started = Promise.withResolvers();
  const requests = [], notifications = [], pending = new Map();
  const endpoint = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture', contextWindow: 32768 }] })); return; }
    let raw = ''; for await (const c of req) raw += c;
    const request = JSON.parse(raw); requests.push(request);
    if (!request.stream) { res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
    const summary = JSON.stringify(request.messages.at(-1)).includes('compaction engine');
    if (slow && summary) { started.resolve(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant', content: summary ? 'Original fact: ORION-739. Use integer cents.' : 'Verified fixture evidence. '.repeat(400) });
    emit({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  let child, ws, seq = 0, stderr = '';
  const secret = 'controlled-crash-secret';
  async function connect() {
    child = spawn(process.execPath, ['runtime/server.mjs', '--port', '0', '--data-dir', path.join(root, 'data')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODEBUDDY_SERVER__SECRET_KEY: secret },
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const address = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        for (const line of output.split('\n').slice(0, -1)) {
          try { const value = JSON.parse(line); if (value.ready) resolve(value.url); } catch { /* Other startup logs. */ }
        }
      });
      child.once('error', reject); child.once('exit', code => reject(Error(`Server exited ${code}: ${stderr}`)));
    });
    ws = new WebSocket(address.replace('http:', 'ws:') + '/acp?token=' + secret);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(String(data)), p = pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
      else notifications.push(m);
    };
    ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Server disconnected')); } pending.clear(); };
    await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  }
  function rpc(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('Timeout ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }); }
  async function kill() { if (child?.exitCode === null && child?.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; } }
  t.after(async () => { await kill(); ws?.close(); endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)); });
  await connect();
  const ext = (name, params) => rpc('_goose/unstable/' + name, params);
  const { providerId } = await ext('providers/custom/create', { engine: 'openai_compatible', displayName: 'Crash fixture', apiUrl: `http://127.0.0.1:${endpoint.address().port}`, requiresAuth: false, models: ['fixture'], headers: {}, supportsStreaming: true });
  await ext('defaults/save', { providerId, modelId: 'fixture' });
  const { sessionId } = await rpc('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: [] } });
  const prompt = text => rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  await prompt('Remember ORION-739, integer cents, and shipping is never taxed.');
  slow = true; const running = prompt('/compact').catch(error => error); await started.promise;
  await kill(); assert.match((await running).message, /disconnected/);
  slow = false; await connect(); notifications.length = 0;
  await rpc('session/load', { sessionId, cwd: root, mcpServers: [] });
  const output = await build({ entryPoints: [path.resolve('ui/desktop/src/acp/sessionNotificationAdapter.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
  const { createAcpSessionNotificationAdapter } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
  const adapter = createAcpSessionNotificationAdapter();
  const changes = notifications.filter(n => n.method === '_goose/unstable/session/update').flatMap(n => adapter.applyGoose(n.params));
  const lifecycle = changes.filter(c => c.type === 'compactionLifecycle');
  assert.ok(lifecycle.length, 'interrupted maintenance remains visible in history');
  assert.notEqual(lifecycle.at(-1).lifecycle.status, 'started', 'replay must not leave a dead operation running');
  assert.notEqual(lifecycle.at(-1).lifecycle.status, 'completed', 'a killed summary must not be reported as committed');
  assert.equal((await prompt('Continue using the original project constraints.')).stopReason, 'end_turn');
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('shipping is never taxed'), 'uncommitted compaction must retain the original messages');
  assert.equal((await prompt('/compact')).stopReason, 'end_turn', 'Harness must release its stale maintenance bracket after restart');
});
