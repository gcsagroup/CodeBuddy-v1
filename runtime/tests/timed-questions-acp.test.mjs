import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCompatServer } from '../server.mjs';

test('real ACP carries the native deadline, late reply, turn close and cross-session rejection', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-timed-acp-'));
  const gate = Promise.withResolvers(), continued = Promise.withResolvers(), form = Promise.withResolvers();
  const bodies = [], notifications = [];
  const model = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    if (!body.stream) { res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
    bodies.push(body);
    const hasTool = body.messages.some(m => m.role === 'tool');
    if (hasTool) await gate.promise;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'timed-acp', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (hasTool) { emit({ role: 'assistant', content: 'Done.' }); emit({}, 'stop'); }
    else {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'color-call', type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ timeout: 1, questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Mint' }, { label: 'Cream' }] }] }) } }] });
      emit({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const secret = 'isolated-timed-question-test';
  const app = await createCompatServer({ dataDir: path.join(root, 'data'), secret });
  const ws = new WebSocket((await app.listen()).replace('http:', 'ws:') + '/acp?token=' + secret);
  const pending = new Map(); let seq = 0;
  t.after(async () => { gate.resolve(); ws.close(); await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)), task = pending.get(message.id);
    if (task) {
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
    } else {
      notifications.push(message);
      if (message.method === 'elicitation/create') form.resolve(message.params);
      const snapshot = message.params?.update?._meta?.['codebuddy/questions'];
      if (snapshot?.active.some(q => q.state === 'continued')) continued.resolve(snapshot.active[0]);
    }
  };
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const ext = (method, params) => rpc('_goose/unstable/' + method, params);
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { providerId } = await ext('providers/custom/create', { engine: 'openai_compatible', displayName: 'Fixture', apiUrl: `http://127.0.0.1:${model.address().port}`, requiresAuth: false, models: ['fixture'], headers: {}, supportsStreaming: true });
  await ext('defaults/save', { providerId, modelId: 'fixture' });
  const create = () => rpc('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: ['developer'] } });
  const { sessionId } = await create(), other = await create();
  const prompt = rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Ask an optional color and continue independent work.' }] });
  prompt.catch(() => {});
  const stage = async (promise, label) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out awaiting ${label}`)), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  const initial = await stage(form.promise, 'initial question');
  const wait = initial._meta['codebuddy/question'];
  assert.equal(wait.state, 'open');
  assert.ok(wait.remainingMs > 0 && wait.remainingMs <= 1000);
  const late = await stage(continued.promise, 'continued question');
  const input = { sessionId, callId: late.callId, nativeSessionId: wait.nativeSessionId,
    response: { action: 'accept', content: { answer_0: 'Mint' } } };
  await assert.rejects(ext('session/questions/answer', { ...input, sessionId: other.sessionId }), /会话已改变/);
  await assert.rejects(ext('session/questions/answer', { ...input, response: { action: 'accept', content: { answer_0: {} } } }), /格式无效/);
  assert.deepEqual(await ext('session/questions/answer', input), { accepted: true });
  await assert.rejects(ext('session/questions/answer', input), /queued/);
  gate.resolve(); await prompt;
  const updates = notifications.filter(n => n.params?.sessionId === sessionId && n.params.update?._meta?.['codebuddy/questions']);
  assert.equal(updates.at(-1).params.update._meta['codebuddy/questions'].active.length, 0);
  const count = bodies.length;
  await assert.rejects(ext('session/questions/answer', input), /问题已结束|本轮已结束/);
  assert.equal(bodies.length, count, 'A stale card must not wake the completed agent');
  assert.ok(bodies.some(body => body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('answer_to_pending_question'))), 'Late answer must reach the model through the native reply message');
});
