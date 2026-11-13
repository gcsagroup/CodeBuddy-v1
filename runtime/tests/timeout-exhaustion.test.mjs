import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';
import { workStatusUpdates } from '../work-status.mjs';
import { publicRpcError } from '../error-presentation.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const { PiAiAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')).href);

for (const headers of [false, true]) test(`native TIMEOUT exhaustion (${headers ? 'SSE headers only' : 'no response'}) stops, reloads and continues without tool replay`, { timeout: 20000 }, async t => {
  // Shorten only the isolated provider's clock. Classification, retry admission,
  // five retries, terminal events and recovery still run in the native engine.
  const profileOf = PiAiAdapter.prototype.profileOf;
  t.mock.method(PiAiAdapter.prototype, 'profileOf', function (...args) {
    return { ...profileOf.apply(this, args), streamIdleTimeoutMs: 250 };
  });
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-timeout-exhaustion-'));
  const dataDir = path.join(root, 'harness'), ledger = path.join(root, 'effects.txt');
  const requests = [], waiting = [];
  let online = false, effects = 0, driver;
  const endpoint = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    if (!body.stream) return res.end(JSON.stringify({ choices: [{ message: { content: 'Timeout test' } }] }));
    requests.push(body);
    if (requests.length > 1 && !online) {
      const record = { started: Date.now() }; waiting.push(record);
      res.on('close', () => { record.closed = Date.now(); });
      if (headers) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'timeout-test', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (requests.length === 1) {
      emit({ tool_calls: [{ index: 0, id: 'completed-effect', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      emit({}, 'tool_calls');
    } else { emit({ content: 'Continued from the existing result without repeating the tool.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await driver?.close(); endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)); });
  const provider = { id: 'timeout-fixture', baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: 'isolated-no-key',
    retryPolicy: { mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 } } };
  const tool = { name: 'fixture_effect', description: 'One non-idempotent synthetic effect', inputSchema: { type: 'object', properties: {} },
    async execute() { effects++; await appendFile(ledger, 'effect\n'); return { written: true }; } };
  const sessionId = randomUUID();
  driver = await createHarnessDriver({ dataDir, cwd: root });
  await driver.createSession({ sessionId, cwd: root, provider, model: 'fixture', options: { tools: [tool] } });
  const events = [], updates = [], project = workStatusUpdates({ sessionId });
  const error = await driver.prompt(sessionId, 'Write the synthetic checkpoint, then report.', { onPermission: () => true,
    onEvent(event) { events.push(event); updates.push(...project(event)); } }).then(() => assert.fail('Timeout must not succeed'), e => e);
  assert.equal(error.code, 'TIMEOUT');
  assert.equal(requests.length, 7, 'One completed tool proposal plus six actual timed-out requests');
  const retries = events.filter(e => e.type === 'harness_event' && e.event.type === 'llm/retry').map(e => e.event.data);
  assert.deepEqual(retries.map(r => r.retry), [1, 2, 3, 4, 5]);
  assert.ok(retries.every(r => r.maxRetries === 5 && r.failure.code === 'TIMEOUT'));
  assert.equal(waiting.length, 6);
  await delay(100);
  assert.ok(waiting.every(r => r.closed && r.closed - r.started >= 150), 'Each connection must really wait and be aborted');
  assert.equal(requests.length, 7, 'Exhaustion must not schedule an extra retry');
  assert.ok(requests.slice(1).every(r => r.messages.some(m => m.role === 'tool' && m.tool_call_id === 'completed-effect')));
  const notice = updates.at(-1).status;
  assert.equal(notice.type, 'notice'); assert.match(notice.message, /超时/); assert.match(notice.message, /本轮已停止/);
  assert.equal(publicRpcError(error, 'session/prompt').data.diagnostic.code, 'TIMEOUT');
  const history = await driver.history(sessionId);
  assert.equal(history.events.at(-1).data.reason.kind, 'error');
  assert.equal(history.events.at(-1).data.reason.error.code, 'TIMEOUT');
  const prefix = await driver.exportSessionLog(sessionId);
  await driver.close(); driver = await createHarnessDriver({ dataDir, cwd: root });
  await driver.history(sessionId);
  assert.equal(requests.length, 7, 'Cold load cannot infer or replay tools');
  online = true;
  await driver.createSession({ sessionId, cwd: root, provider, model: 'fixture', options: { tools: [tool] } });
  await driver.prompt(sessionId, 'Continue without redoing completed work.');
  assert.equal(requests.length, 8); assert.equal(effects, 1);
  assert.equal(await readFile(ledger, 'utf8'), 'effect\n');
  assert.ok((await driver.exportSessionLog(sessionId)).startsWith(prefix));
  const after = await driver.history(sessionId);
  assert.equal(after.events.filter(e => e.type === 'tool/call').length, 1);
  assert.equal(after.events.filter(e => e.type === 'tool/result').length, 1);
});
