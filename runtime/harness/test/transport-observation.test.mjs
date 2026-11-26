import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { observeModelTransport } from '../transport-observation.mjs';

test('connection diagnostics follow actual socket reuse and never expose request data', async t => {
  const server = createServer((_req, res) => res.end('private response'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  let handler;
  t.after(observeModelTransport({ on(_name, callback) { handler = callback; return () => {}; } }, () => {}));
  for (let i = 0; i < 3; i++) {
    for await (const _ of handler({ sessionId: 'fixture-socket' }, async function* () {
      await (await fetch(`http://127.0.0.1:${server.address().port}/private-path`, { headers: { Authorization: 'secret-token' } })).text();
      await delay(10);
      yield { type: 'text-delta', text: 'private answer' };
    })) { /* unchanged stream */ }
  }
  const rows = logs.filter(row => row[0] === '[Harness connection timing]').map(row => JSON.parse(row[1]));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].reused, false);
  assert.ok(rows.some(row => row.reused === true));
  assert.doesNotMatch(JSON.stringify(rows), /secret|private|127\.0\.0\.1|Authorization/);
});

test('transport timings separate response wait from reasoning and text without collecting secrets', async t => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume test upload */ }
    await delay(130);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('private response');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  let handler;
  const events = [];
  const dispose = observeModelTransport({ on(_name, callback) { handler = callback; return () => {}; } }, e => events.push(e));
  t.after(dispose);
  const next = async function* () {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/secret-path`, { method: 'POST', body: 'private request', headers: { Authorization: 'secret-token' } });
    await response.text();
    yield { type: 'reasoning-delta', text: 'private reasoning' };
    await delay(130);
    yield { type: 'text-delta', text: 'private answer' };
    yield { type: 'usage', usage: { inputTokens: 3000, cacheReadTokens: 2000, cacheWriteTokens: 500, totalTokens: 13692, outputTokens: 8192, reasoningTokens: 8000, secret: 'never log this' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const output = [];
  for await (const chunk of handler({ sessionId: 'fixture', purpose: 'compaction', provider: 'fixture', model: 'summary-model', maxTokens: 8192, reasoningEffort: 'low' }, next)) output.push(chunk);
  assert.equal(output.length, 4);
  const reasoning = events.find(e => e.phase === 'first_reasoning');
  const text = events.find(e => e.phase === 'first_text');
  const end = events.at(-1);
  assert.ok(events.every(event => Number.isSafeInteger(event.at_ms) && event.at_ms > 0));
  const phases = events.map(event => event.phase);
  for (const [before, after] of [['start','request_created'], ['request_created','request_sent'], ['request_sent','response_headers'], ['response_headers','first_reasoning']])
    assert.ok(phases.indexOf(before) < phases.indexOf(after), `${before} precedes ${after}`);
  assert.ok(text.elapsedMs - reasoning.elapsedMs >= 100);
  assert.equal(end.requests, 1);
  assert.equal(end.textDeltaChars, 'private answer'.length);
  assert.equal(end.reasoningDeltaChars, 'private reasoning'.length);
  assert.equal(end.toolCallBlocks, 0);
  assert.equal(end.finishKind, 'stop');
  assert.equal(end.purpose, 'compaction');
  assert.equal(end.maxTokens, 8192);
  assert.equal(end.reasoningEffort, 'low');
  assert.deepEqual(end.usage, { inputTokens: 3000, outputTokens: 8192, totalTokens: 13692, reasoningTokens: 8000, cacheReadTokens: 2000, cacheWriteTokens: 500 });
  const timing = end.timings[0];
  assert.ok(timing.headersMs - timing.bodySentMs >= 100, JSON.stringify(timing));
  assert.ok(timing.sendHeadersMs >= timing.createdMs);
  assert.equal(timing.status, 200);
  assert.ok(timing.bodyCompleteMs >= timing.headersMs);
  assert.doesNotMatch(JSON.stringify(events), /private|secret|Authorization|127\.0\.0\.1/);
});

test('tail timings distinguish consumer backpressure from stream completion without changing chunks', async t => {
  let handler;
  const events = [];
  t.after(observeModelTransport({ on(_name, callback) { handler = callback; return () => {}; } }, e => events.push(e)));
  const chunks = [{ type: 'tool-call-delta', argumentsDelta: 'private' }, { type: 'finish', reason: { kind: 'stop' } }];
  const received = [];
  for await (const chunk of handler({ sessionId: 'tail' }, async function* () {
    yield chunks[0];
    await delay(110);
    yield chunks[1];
    await delay(110);
  })) {
    received.push(chunk);
    await delay(110);
  }
  const end = events.at(-1);
  assert.deepEqual(received, chunks);
  assert.ok(end.consumerWaitMs >= 200);
  assert.ok(end.finishMs - end.lastContentMs >= 200);
  assert.ok(end.elapsedMs - end.finishMs >= 200);
  assert.doesNotMatch(JSON.stringify(events), /private/);
});

test('a tool-only stream records first arguments and wall time without exposing arguments', async t => {
  let handler;
  const events = [];
  t.after(observeModelTransport({ on(_name, callback) { handler = callback; return () => {}; } }, e => events.push(e)));
  const next = async function* () {
    yield { type: 'tool-call-delta', argumentsDelta: 'PRIVATE_CODE' };
    yield { type: 'block-end', block: { type: 'tool-call' } };
  };
  for await (const _ of handler({ sessionId: 'tool-only' }, next)) { /* passthrough */ }
  assert.ok(events.some(e => e.phase === 'first_chunk'));
  assert.ok(events.some(e => e.phase === 'first_tool_arguments'));
  assert.equal(events.at(-1).toolArgumentChars, 12);
  assert.equal(events.at(-1).toolCallBlocks, 1);
  assert.ok(events.every(e => Number.isSafeInteger(e.at_ms) && e.at_ms > 0));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_CODE/);
});


test('assembled request sizes separate skill metadata and never expose contents', async () => {
  const { requestContextSizes } = await import('../transport-observation.mjs');
  const result = requestContextSizes({ messages: [
    { role: 'system', content: 'PRIVATE_SYSTEM' },
    { role: 'user', source: {kind: 'skill-catalog'}, content: 'PRIVATE_SKILLS' },
    { role: 'user', content: 'ÄãºÃ' },
    { role: 'tool', content: 'PRIVATE_RESULT' },
  ], tools: [{name:'PRIVATE_TOOL', parameters:{}}] });
  assert.equal(result.groups.skillCatalog.items, 1);
  assert.equal(result.groups.system.characters, JSON.stringify('PRIVATE_SYSTEM').length);
  assert.ok(result.groups.conversation.bytes > result.groups.conversation.characters);
  assert.equal(result.groups.toolSchemas.items, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|ÄãºÃ/);
});
