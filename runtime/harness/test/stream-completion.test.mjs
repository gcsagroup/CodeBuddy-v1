import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { streamCompletionPatch } from '../sdk-budget/stream-completion-patch.mjs';

const url = import.meta.resolve(streamCompletionPatch.name);
const hook = registerHooks({ load(target, context, next) {
  const loaded = next(target, context);
  return target === url ? { ...loaded, source: streamCompletionPatch.transform(readFileSync(new URL(url), 'utf8')) } : loaded;
} });
let Stream;
try { ({ Stream } = await import(url)); } finally { hook.deregister(); }
const bytes = text => new TextEncoder().encode(text);
const payload = 'data: {"choices":[{"delta":{"content":"fixture"}}]}\n\n';
const sentinel = 'data: [DONE]\n\n';
const consume = async (body, controller = new AbortController()) => {
  const out = [];
  for await (const event of Stream.fromSSEResponse(new Response(body), controller)) out.push(event);
  return out;
};

test('completed streams preserve outputs and reuse the connection after physical EOF', async t => {
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    sockets.add(req.socket);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(payload + sentinel);
    await delay(40);res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 4; i++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/fixture`);
    const result = [];
    for await (const event of Stream.fromSSEResponse(response, new AbortController())) result.push(event);
    assert.deepEqual(result, [{ choices: [{ delta: { content: 'fixture' } }] }]);
    await delay(80);
  }
  assert.equal(sockets.size, 1);
});

test('a stalled completed response returns immediately and is cancelled within the drain deadline', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ start(c) { c.enqueue(bytes(payload + sentinel)); }, cancel() { cancelled++; } });
  const start = performance.now();
  assert.equal((await consume(body)).length, 1);
  assert.ok(performance.now() - start < 300);
  assert.equal(cancelled, 0);
  await delay(1150);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('post-sentinel bytes are bounded and cannot become additional model output', async () => {
  let pulls = 0, cancelled = 0;
  const body = new ReadableStream({
    start(c) { c.enqueue(bytes(payload + sentinel)); },
    pull(c) { pulls++; c.enqueue(new Uint8Array(32768)); },
    cancel() { cancelled++; },
  });
  assert.equal((await consume(body)).length, 1);
  await delay(10);
  assert.equal(cancelled, 1);
  assert.ok(pulls <= 4, `bounded transport buffering: ${pulls}`);
  assert.equal(body.locked, false);
});

test('early caller return cancels before any completion sentinel', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ start(c) { c.enqueue(bytes(payload)); }, cancel() { cancelled++; } });
  const controller = new AbortController();
  for await (const _ of Stream.fromSSEResponse(new Response(body), controller)) break;
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('abort interrupts both pending inference and completed-body cleanup promptly', async () => {
  for (const completed of [false, true]) {
    let cancelled = 0;
    const controller = new AbortController();
    const body = new ReadableStream({ start(c) { c.enqueue(bytes(payload + (completed ? sentinel : ''))); }, cancel() { cancelled++; } });
    const result = consume(body, controller);
    await delay(20);controller.abort();await result;await delay(20);
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  }
});

test('errors and inexact completion strings retain the existing failure boundary', async () => {
  for (const invalid of ['data: [DONE] trailing\n\n', 'data: {"error":{"message":"fixture failure"}}\n\n']) {
    let cancelled = 0;
    const body = new ReadableStream({ start(c) { c.enqueue(bytes(invalid)); }, cancel() { cancelled++; } });
    await assert.rejects(consume(body));
    assert.equal(cancelled, 1);
  }
});

test('cleanup read failure after true completion does not replace successful model output', async () => {
  const body = new ReadableStream({
    start(c) { c.enqueue(bytes(payload + sentinel)); },
    pull() { throw new Error('fixture cleanup failure'); },
  });
  assert.equal((await consume(body)).length, 1);
  await delay(10);assert.equal(body.locked, false);
});
