import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';

test('[retest-20261016] child cancellation notices cannot restart a cancelled parent, and a fresh turn still works', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-retest-cancel-'));
  const requests = [], events = [], failures = [];
  const childStarted = Promise.withResolvers();
  let childResponse;
  const model = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      // Native runtime-context snapshots are also user-role messages. Select
      // only our synthetic test input rather than interpreting that snapshot.
      const latest = [...body.messages].reverse().find(message => message.role === 'user' && /CHILD_WAIT_RETEST|FRESH_USER_TURN|PARENT_DELEGATE_RETEST/.test(JSON.stringify(message.content)));
      const child = JSON.stringify(latest?.content).includes('CHILD_WAIT_RETEST');
      const fresh = JSON.stringify(latest?.content).includes('FRESH_USER_TURN');
      requests.push({ child, fresh, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      if (child) {
        childResponse = res;
        res.flushHeaders();
        childStarted.resolve();
        return;
      }
      const spawned = body.messages.some(message => message.role === 'tool');
      if (!spawned && !fresh) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'delegate-once', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ description: 'Independent waiting fixture', prompt: 'CHILD_WAIT_RETEST' }) } }] });
        emit({}, 'tool_calls');
      } else {
        emit({ role: 'assistant', content: fresh ? 'FRESH_TURN_OK' : 'The independent child is working.' });
        emit({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); res.destroy(error); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(directory, 'native'), cwd: directory });
  t.after(async () => {
    childResponse?.destroy();
    await driver.close();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  });
  const sessionId = randomUUID();
  await driver.createSession({ sessionId, cwd: directory, provider: { id: 'local-cancel-fixture', baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'synthetic-token', protocol: 'openai-completions' }, model: 'fixture-model', options: { tools: [] } });
  const controller = new AbortController();
  const pending = driver.prompt(sessionId, 'PARENT_DELEGATE_RETEST', { signal: controller.signal, onPermission: () => true, onEvent: event => events.push(event) });
  pending.catch(() => {});
  await childStarted.promise;
  const deadline = Date.now() + 5_000;
  let completed = false;
  while (Date.now() < deadline) {
    const history = await driver.history(sessionId);
    if (history.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')) { completed = true; break; }
    await delay(10);
  }
  assert.equal(completed, true, 'Parent must be waiting for its child after completing its own native turn');
  const beforeCancel = requests.length;
  controller.abort();
  const stopped = await pending;
  assert.equal(stopped.stopReason, 'cancelled');
  assert.equal(requests.length, beforeCancel, 'Child stopped notification must not request another model step');
  assert.ok(events.some(event => event.type === 'subagent_start'), 'Exercise real native delegation');
  const history = await driver.history(sessionId);
  assert.ok(history.events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted?.some(item => item.source?.kind === 'subagent-settled')), 'Exercise actual child settlement delivery');
  const freshEvents = [];
  const result = await driver.prompt(sessionId, 'FRESH_USER_TURN', { onPermission: () => true, onEvent: event => freshEvents.push(event) });
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(freshEvents.some(event => event.type === 'text_delta' && event.text.includes('FRESH_TURN_OK')));
  assert.deepEqual(failures, []);
});
