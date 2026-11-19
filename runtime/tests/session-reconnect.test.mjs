import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createCompatServer } from '../server.mjs';

async function connect(url, secret) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/acp?token=' + secret);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const pending = new Map(), notifications = [];
  let serial = 0;
  ws.on('message', bytes => {
    const message = JSON.parse(String(bytes)), request = pending.get(message.id);
    if (request) {
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result);
    } else notifications.push(message);
  });
  ws.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('test client disconnected')); }
    pending.clear();
  });
  return { ws, notifications, rpc(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timed out: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  } };
}
async function until(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Expected renderer notification was not delivered');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-reconnect-'));
  const started = Promise.withResolvers(), resume = Promise.withResolvers(), middle = Promise.withResolvers(), finish = Promise.withResolvers();
  let streams = 0;
  const model = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/openapi.json')) { res.writeHead(404).end(); return; }
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.stream) { res.end(JSON.stringify({ choices: [{ message: { content: 'Reconnect fixture' } }] })); return; }
    streams++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (text, reason = null) => res.write(`data: ${JSON.stringify({ id: 'reconnect-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: reason }] })}\n\n`);
    emit('WAITING_FOR_IMAGE'); started.resolve();
    await resume.promise; emit('IMAGE_RECEIPT_READY'); middle.resolve();
    await finish.promise; emit('PET_ASSEMBLY_DONE', 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const secret = 'isolated-session-reconnect-fixture';
  const app = await createCompatServer({ dataDir: join(root, 'data'), secret });
  const url = await app.listen(0, '127.0.0.1');
  const clients = [];
  const open = async () => {
    const client = await connect(url, secret); clients.push(client);
    await client.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  };
  t.after(async () => {
    resume.resolve(); finish.resolve();
    for (const client of clients) client.ws.close();
    await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  });
  const first = await open();
  const { providerId } = await first.rpc('_goose/unstable/providers/custom/create', {
    engine: 'openai_compatible', displayName: 'Fixture', apiUrl: `http://127.0.0.1:${model.address().port}`,
    requiresAuth: false, models: ['fixture'], supportsStreaming: true, headers: {},
  });
  await first.rpc('_goose/unstable/defaults/save', { providerId, modelId: 'fixture' });
  const { sessionId } = await first.rpc('session/new', { cwd: root, mcpServers: [] });
  await first.rpc('_goose/unstable/session/rename', { sessionId, title: 'Reconnect fixture' });
  return { root, sessionId, first, open, started, resume, middle, finish, streams: () => streams };
}

test('real Harness keeps executing while disconnected, replays the gap and delivers the live tail once', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const prompting = f.first.rpc('session/prompt', { sessionId: f.sessionId, prompt: [{ type: 'text', text: 'Complete this isolated pet-like workflow once.' }] });
  prompting.catch(() => {});
  await f.started.promise;
  f.first.ws.terminate();
  await assert.rejects(prompting, /disconnected/);
  f.resume.resolve(); await f.middle.promise;
  const second = await f.open();
  await second.rpc('session/load', { sessionId: f.sessionId, cwd: f.root, mcpServers: [] });
  const replay = JSON.stringify(second.notifications);
  assert.match(replay, /WAITING_FOR_IMAGE/); assert.match(replay, /IMAGE_RECEIPT_READY/);
  assert.ok(second.notifications.some(n => typeof n.params?.update?._meta?.goose?.activeRunId === 'string'));
  f.finish.resolve();
  await until(() => second.notifications.some(n => n.params?.update?._meta?.goose?.activeRunId === null));
  const tail = second.notifications.filter(n => n.params?.update?.content?.text === 'PET_ASSEMBLY_DONE');
  assert.equal(tail.length, 1);
  assert.equal(f.streams(), 1, 'reconnect must not submit a second model request');
  const state = JSON.parse(await readFile(join(f.root, 'data/state.json'), 'utf8'));
  assert.match(JSON.stringify(state.sessions.find(s => s.id === f.sessionId).updates), /PET_ASSEMBLY_DONE/);
});

test('explicit stop after reconnect still cancels the same native turn', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const prompting = f.first.rpc('session/prompt', { sessionId: f.sessionId, prompt: [{ type: 'text', text: 'Wait for an explicit stop.' }] });
  prompting.catch(() => {});
  await f.started.promise; f.first.ws.terminate(); await assert.rejects(prompting);
  const second = await f.open();
  await second.rpc('session/load', { sessionId: f.sessionId, cwd: f.root, mcpServers: [] });
  await second.rpc('session/cancel', { sessionId: f.sessionId });
  await until(() => second.notifications.some(n => n.params?.update?._meta?.goose?.activeRunId === null));
  assert.equal(f.streams(), 1);
  assert.doesNotMatch(JSON.stringify(second.notifications), /PET_ASSEMBLY_DONE/);
});
