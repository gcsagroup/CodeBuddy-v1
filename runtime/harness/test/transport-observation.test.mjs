import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { observeModelTransport } from '../transport-observation.mjs';

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
  };
  const output = [];
  for await (const chunk of handler({ sessionId: 'fixture' }, next)) output.push(chunk);
  assert.equal(output.length, 2);
  const reasoning = events.find(e => e.phase === 'first_reasoning');
  const text = events.find(e => e.phase === 'first_text');
  const end = events.at(-1);
  assert.ok(text.elapsedMs - reasoning.elapsedMs >= 100);
  assert.equal(end.requests, 1);
  const timing = end.timings[0];
  assert.ok(timing.headersMs - timing.bodySentMs >= 100, JSON.stringify(timing));
  assert.ok(timing.sendHeadersMs >= timing.createdMs);
  assert.equal(timing.status, 200);
  assert.doesNotMatch(JSON.stringify(events), /private|secret|Authorization|127\.0\.0\.1/);
});
