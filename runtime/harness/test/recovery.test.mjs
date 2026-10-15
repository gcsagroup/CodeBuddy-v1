import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../index.mjs';

async function fixture(t, handler, retryPolicy) {
  const root = await mkdtemp(join(tmpdir(), 'harness-recovery-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    await handler(req, res, body, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const session = await driver.createSession({ sessionId: randomUUID(), cwd: root, model: 'fixture', provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'PRIVATE_FIXTURE_KEY_NEVER_LOG', ...(retryPolicy ? { retryPolicy } : {}) } });
  return { driver, sessionId: session.sessionId, requests, root };
}
function start(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
  return (text, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason }] })}\n\n`);
}
function done(res, emit) { emit(null, 'stop'); res.end('data: [DONE]\n\n'); }

test('official retry recovers one transport failure and preserves spaced streaming deltas', { timeout: 15000 }, async t => {
  const sent = [];
  const { driver, sessionId, requests } = await fixture(t, async (req, res, _body, count) => {
    if (count === 1) { req.socket.destroy(); return; }
    const emit = start(res);
    for (const text of ['first ', 'middle ', 'last']) { sent.push(Date.now()); emit(text); await delay(200); }
    done(res, emit);
  });
  const events = [], deltas = [];
  const result = await driver.prompt(sessionId, 'Reply with three words', { onEvent(event) { events.push(event); if (event.type === 'text_delta') deltas.push({ text: event.text, at: Date.now() }); } });
  assert.equal(result.stopReason, 'end_turn'); assert.equal(requests.length, 2); assert.ok(requests.every(r => r.stream === true));
  assert.deepEqual(deltas.map(d => d.text), ['first ', 'middle ', 'last']);
  assert.ok(deltas[1].at - deltas[0].at >= 150); assert.ok(deltas[2].at - deltas[1].at >= 150);
  for (let i = 0; i < sent.length; i++) assert.ok(deltas[i].at - sent[i] < 150);
  const retry = events.find(e => e.type === 'harness_event' && e.event.type === 'llm/retry');
  assert.equal(retry.event.data.maxRetries, 5); assert.equal(retry.event.data.failure.code, 'TRANSPORT');
  const failure = events.find(e => e.type === 'model_diagnostic' && e.failureCode === 'TRANSPORT');
  assert.ok(failure.transportCodes.includes('UND_ERR_SOCKET'), JSON.stringify(failure));
  assert.equal(failure.requests, 1);
  assert.doesNotMatch(JSON.stringify(events.filter(e => e.type === 'model_diagnostic')), /PRIVATE_FIXTURE_KEY_NEVER_LOG|Reply with three words|Authorization|http:\/\//);
  const history = await driver.history(sessionId);
  assert.equal(history.events.filter(e => e.type === 'turn/end').length, 1);
});

test('authentication failure is not retried and network backoff is cancellable', { timeout: 15000 }, async t => {
  const first = await fixture(t, async (_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid credential fixture' } })));
  await assert.rejects(first.driver.prompt(first.sessionId, 'hello'), /credential|401/i);
  assert.equal(first.requests.length, 1);
  const second = await fixture(t, async (req) => req.socket.destroy());
  const controller = new AbortController(), events = [];
  const result = await second.driver.prompt(second.sessionId, 'hello', { signal: controller.signal, onEvent(e) { events.push(e); if (e.type === 'harness_event' && e.event.type === 'llm/retry') controller.abort(); } });
  assert.equal(result.stopReason, 'cancelled'); assert.equal(second.requests.length, 1);
  assert.equal(events.filter(e => e.type === 'harness_event' && e.event.type === 'llm/retry-started').length, 0);
});

test('official finite retry exhaustion retains transport failure instead of successful completion', { timeout: 15000 }, async t => {
  const { driver, sessionId, requests } = await fixture(t, async (req) => req.socket.destroy(), { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 } });
  await assert.rejects(driver.prompt(sessionId, 'hello'), error => error.code === 'TRANSPORT');
  assert.equal(requests.length, 3);
  const history = await driver.history(sessionId);
  assert.equal(history.events.filter(e => e.type === 'llm/retry').length, 2);
  assert.equal(history.events.at(-1).data.reason.kind, 'error');
});

test('stream interruption after a completed tool keeps partial evidence and retries without repeating the side effect', { timeout: 15000 }, async t => {
  const f = await fixture(t, async (req, res, _body, count) => {
    if (count === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ tool_calls: [{ index: 0, id: 'effect-once', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] }, null], [{}, 'tool_calls']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    const emit = start(res);
    if (count === 2) { emit('PARTIAL_BEFORE_DISCONNECT'); await delay(50); req.socket.destroy(); return; }
    emit('FINAL_AFTER_RECOVERY'); done(res, emit);
  });
  let writes = 0;
  await f.driver.configureSession(f.sessionId, { tools: [{ name: 'fixture_effect', description: 'Write an isolated checkpoint once', inputSchema: { type: 'object', properties: {} }, async execute() { writes++; await writeFile(join(f.root, 'once.txt'), 'Completed before network interruption'); return { written: true }; } }] });
  const events = [];
  const result = await f.driver.prompt(f.sessionId, 'Write the fixture checkpoint then summarize it', { onPermission: () => true, onEvent: event => events.push(event) });
  assert.equal(result.stopReason, 'end_turn'); assert.equal(writes, 1); assert.equal(f.requests.length, 3);
  assert.equal(await readFile(join(f.root, 'once.txt'), 'utf8'), 'Completed before network interruption');
  const partial = events.find(e => e.type === 'text_delta' && e.text === 'PARTIAL_BEFORE_DISCONNECT');
  const final = events.find(e => e.type === 'text_delta' && e.text === 'FINAL_AFTER_RECOVERY');
  assert.ok(partial && final); assert.notEqual(partial.attemptId, final.attemptId);
  assert.equal(events.filter(e => e.type === 'tool_result' && e.id === 'effect-once').length, 1);
  assert.doesNotMatch(JSON.stringify(f.requests[2].messages), /PARTIAL_BEFORE_DISCONNECT/);
  assert.ok(f.requests[2].messages.some(m => m.role === 'tool' && m.tool_call_id === 'effect-once'));
  const history = await f.driver.history(f.sessionId);
  const attempt = history.events.find(e => e.type === 'assistant/attempt' && JSON.stringify(e.data.stream).includes('PARTIAL_BEFORE_DISCONNECT'));
  assert.ok(attempt); assert.equal(history.events.filter(e => e.type === 'tool/result' && e.data.message.toolCallId === 'effect-once').length, 1);
  assert.equal(history.events.filter(e => e.type === 'turn/end').length, 1);
  assert.equal(history.events.at(-1).data.reason.kind, 'completed');
});
