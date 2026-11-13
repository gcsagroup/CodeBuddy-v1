import { replyToNoActionReview } from './review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../index.mjs';
import { workStatusUpdates } from '../../work-status.mjs';

async function fixture(t, handler, retryPolicy) {
  const root = await mkdtemp(join(tmpdir(), 'harness-recovery-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return; requests.push(body);
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
  const project = workStatusUpdates({ sessionId, sourceMessageId: 'input', runId: 'run' }), statuses = [];
  await assert.rejects(driver.prompt(sessionId, 'hello', { onEvent: event => statuses.push(...project(event)) }), error => error.code === 'TRANSPORT');
  assert.equal(requests.length, 3);
  const history = await driver.history(sessionId);
  assert.equal(history.events.filter(e => e.type === 'llm/retry').length, 2);
  assert.equal(history.events.at(-1).data.reason.kind, 'error');
  assert.ok(statuses.some(update => update.status.message.includes('正在重新连接（1/2）')));
  assert.ok(statuses.some(update => update.status.message.includes('正在重新连接（2/2）')));
  assert.equal(statuses.at(-1).status.type, 'notice');
  assert.match(statuses.at(-1).status.message, /原因尚未确认/);
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

test('account and unknown request failures retain native retry policy, useful notices and completed work', { timeout: 30000 }, async t => {
  for (const scenario of [
    { status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota.', native: 'QUOTA', notice: /额度不足/, retries: 0 },
    { status: 400, code: 'insufficient_balance', message: 'Insufficient balance.', native: 'QUOTA', notice: /额度不足/, retries: 0 },
    { status: 402, code: 'unrecognized_fixture_error', message: 'PRIVATE_UPSTREAM_DETAIL', native: 'PI_AI_ERROR', notice: /账户额度或付费状态/, retries: 0 },
    { status: 413, code: 'payload_too_large', message: 'Request body too large.', native: 'INVALID_REQUEST', notice: /请求体过大/, retries: 0 },
    { status: 200, code: 'insufficient_quota', message: 'You exceeded your current quota.', native: 'QUOTA', notice: /额度不足/, retries: 0, streamError: true },
    { status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached.', native: 'RATE_LIMIT', notice: /请求受限/, retries: 1 },
  ]) await t.test(`${scenario.status} ${scenario.code}`, async t => {
    let online = false, effects = 0;
    const f = await fixture(t, async (_req, res, _body, count) => {
      if (count === 1) {
        start(res);
        res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'checkpoint', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
        res.end('data: [DONE]\n\n'); return;
      }
      if (online) { const emit = start(res); emit('Continued from the existing checkpoint.'); done(res, emit); return; }
      if (scenario.streamError) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ error: { code: scenario.code, message: scenario.message } })}\n\n`); return;
      }
      res.writeHead(scenario.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: scenario.code, message: scenario.message } }));
    }, { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 } });
    await f.driver.configureSession(f.sessionId, { tools: [{ name: 'fixture_effect', description: 'Write an isolated checkpoint once', inputSchema: { type: 'object', properties: {} }, async execute() {
      effects++; await writeFile(join(f.root, 'checkpoint.txt'), 'Completed before request failure'); return { written: true };
    } }] });
    const project = workStatusUpdates({ sessionId: f.sessionId }), statuses = [];
    await assert.rejects(f.driver.prompt(f.sessionId, 'Write the checkpoint, then continue.', { onPermission: () => true, onEvent: event => statuses.push(...project(event)) }), error => error.code === scenario.native);
    const history = await f.driver.history(f.sessionId);
    assert.equal(history.events.filter(e => e.type === 'llm/retry').length, scenario.retries);
    assert.equal(f.requests.length, 2 + scenario.retries, 'Presentation must not add requests or change native retry policy');
    assert.equal(history.events.at(-1).data.reason.kind, 'error');
    assert.equal(statuses.at(-1).status.type, 'notice');
    assert.match(statuses.at(-1).status.message, scenario.notice);
    if (scenario.status >= 400) assert.match(statuses.at(-1).status.message, new RegExp(`HTTP ${scenario.status}`));
    assert.match(statuses.at(-1).status.message, /本轮已停止.*查看未完成原因/);
    assert.doesNotMatch(statuses.at(-1).status.message, /PRIVATE|已回滚|已保存/);
    assert.ok(statuses.filter(s => s.status.message.includes('正在重试')).every(s => s.status.type === 'progress' && !s.status.message.includes('已停止')));
    assert.equal(await readFile(join(f.root, 'checkpoint.txt'), 'utf8'), 'Completed before request failure');
    online = true;
    const continued = await f.driver.prompt(f.sessionId, 'Continue without repeating completed work.');
    assert.equal(continued.stopReason, 'end_turn');
    assert.equal(effects, 1);
    assert.ok(f.requests.at(-1).messages.some(m => m.role === 'tool' && m.tool_call_id === 'checkpoint'));
  });
});

test('explicit always retry remains native and can be cancelled without a false terminal error', { timeout: 15000 }, async t => {
  let online = false;
  const f = await fixture(t, async (_req, res) => {
    if (online) { const emit = start(res); emit('Service recovered.'); done(res, emit); return; }
    res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' } }));
  }, { mode: 'always', backoff: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 } });
  const controller = new AbortController(), project = workStatusUpdates({ sessionId: f.sessionId, signal: controller.signal });
  const statuses = []; let retries = 0;
  const result = await f.driver.prompt(f.sessionId, 'hello', { signal: controller.signal, onEvent(event) {
    statuses.push(...project(event));
    if (event.type === 'harness_event' && event.event.type === 'llm/retry' && ++retries === 2) controller.abort();
  } });
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(retries, 2);
  assert.equal(f.requests.length, 2, 'Cancelling backoff must prevent the third request');
  assert.ok(statuses.some(s => /正在重试.*额度不足/.test(s.status.message)));
  assert.ok(statuses.every(s => s.status.type !== 'notice' && !s.status.message.includes('本轮已停止')));
  const history = await f.driver.history(f.sessionId);
  assert.equal(history.events.at(-1).data.reason.kind, 'aborted');
  online = true;
  assert.equal((await f.driver.prompt(f.sessionId, 'Continue after service recovery.')).stopReason, 'end_turn');
  assert.equal(f.requests.length, 3);
});

test('a tool proposed in an interrupted response cannot execute until the native retry completes that response', { timeout: 15000 }, async t => {
  let effects = 0;
  const f = await fixture(t, async (req, res, _body, count) => {
    const emit = start(res);
    if (count <= 2) {
      res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'interrupted-call', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] }, finish_reason: count === 2 ? 'tool_calls' : null }] })}\n\n`);
      if (count === 1) { await delay(60); req.socket.destroy(); return; }
      res.end('data: [DONE]\n\n'); return;
    }
    emit('Completed after the one actual tool execution.'); done(res, emit);
  }, { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 } });
  await f.driver.configureSession(f.sessionId, { tools: [{ name: 'fixture_effect', description: 'Count an isolated side effect', inputSchema: { type: 'object', properties: {} }, async execute() {
    effects++; return { count: effects };
  } }] });
  const result = await f.driver.prompt(f.sessionId, 'Execute the fixture effect once.', { onPermission: () => true });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(effects, 1);
  assert.equal(f.requests.length, 3);
  assert.ok(!f.requests[1].messages.some(m => m.role === 'tool' && m.tool_call_id === 'interrupted-call'));
  assert.ok(f.requests[2].messages.some(m => m.role === 'tool' && m.tool_call_id === 'interrupted-call'));
  const history = await f.driver.history(f.sessionId);
  assert.equal(history.events.filter(e => e.type === 'llm/retry').length, 1);
  assert.equal(history.events.filter(e => e.type === 'tool/result' && e.data.message.toolCallId === 'interrupted-call').length, 1);
});
