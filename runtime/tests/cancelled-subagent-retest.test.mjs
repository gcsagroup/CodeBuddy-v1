import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';

async function fixture(t, { childCount = 1, customTemplate = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-retest-cancel-'));
  const requests = [], failures = [], childResponses = [];
  const childStarted = Promise.withResolvers();
  let childId, driver;
  const model = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      // Synthetic test markers only; native injected user-role context is not
      // a human input. Product routing never uses this fixture classifier.
      const index = body.messages.findLastIndex(message => message.role === 'user' && /CHILD_WAIT_RETEST|CHILD_RESUME_RETEST|REUSE_CHILD_RETEST|FRESH_USER_TURN|PARENT_DELEGATE_RETEST/.test(JSON.stringify(message.content)));
      const latest = JSON.stringify(body.messages[index]?.content);
      const resume = latest?.includes('CHILD_RESUME_RETEST');
      const child = resume || latest?.includes('CHILD_WAIT_RETEST');
      const fresh = latest?.includes('FRESH_USER_TURN');
      const reuse = latest?.includes('REUSE_CHILD_RETEST');
      requests.push({ child, fresh, reuse, resume, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      if (child && !resume) {
        childResponses.push(res);
        res.flushHeaders();
        if (childResponses.length === childCount) childStarted.resolve();
        return;
      }
      const serviced = body.messages.slice(index + 1).some(message => message.role === 'tool');
      if (!child && !fresh && !serviced) {
        const calls = reuse
          ? [{ name: 'send_message', arguments: { agent_id: childId, message: 'CHILD_RESUME_RETEST' } }]
          : Array.from({ length: childCount }, (_, i) => ({ name: 'subagent', arguments: { description: 'Independent waiting fixture ' + i, prompt: 'CHILD_WAIT_RETEST ' + i, ...(customTemplate ? { template: 'waiting-reviewer' } : {}) } }));
        emit({ role: 'assistant', tool_calls: calls.map((call, i) => ({ index: i, id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
        emit({}, 'tool_calls');
      } else {
        emit({ role: 'assistant', content: fresh ? 'FRESH_TURN_OK' : resume ? 'SAME_CHILD_OK' : 'The independent children are working.' });
        emit({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); res.destroy(error); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'local-cancel-fixture', baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'synthetic-token', protocol: 'openai-completions' };
  const sessionId = randomUUID();
  async function open() {
    driver = await createHarnessDriver({ dataDir: join(directory, 'native'), cwd: directory });
    await driver.createSession({ sessionId, cwd: directory, provider, model: 'fixture-model', options: { tools: [],
      ...(customTemplate ? { subagentTemplates: [{ id: 'waiting-reviewer', name: 'Waiting reviewer', description: 'Review current work', prompt: 'CUSTOM_CANCEL_RESPONSIBILITY', model: null, tools: 'none' }] } : {}),
    } });
  }
  await open();
  t.after(async () => {
    for (const response of childResponses) response.destroy();
    await driver.close();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  });
  return {
    directory, requests, failures, sessionId, childStarted,
    get waitingChildren() { return childResponses.length; },
    get driver() { return driver; },
    set childId(id) { childId = id; },
    async otherSession() {
      const other = randomUUID();
      await driver.createSession({ sessionId: other, cwd: directory, provider, model: 'fixture-model', options: { tools: [] } });
      return other;
    },
    async restart() { await driver.close(); await open(); },
    async close() { await driver.close(); },
    async reopen() { await open(); },
  };
}

for (const cut of ['before-extra-admit', 'after-one-extra-admit', 'after-all-admit', 'after-first-retire', 'after-last-retire'])
test(`native notice admission survives a persisted prefix at ${cut}`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { childCount: 3 });
  const controller = new AbortController();
  const active = f.driver.prompt(f.sessionId, 'PARENT_DELEGATE_RETEST', { signal: controller.signal, onPermission: () => true });
  active.catch(() => {});
  await f.childStarted.promise;
  const deadline = Date.now() + 5000;
  while (!(await f.driver.history(f.sessionId)).events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed') && Date.now() < deadline) await delay(10);
  controller.abort();
  assert.equal((await active).stopReason, 'cancelled');
  const originals = (await f.driver.history(f.sessionId)).events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).filter(message => message.source?.kind === 'subagent-settled');
  assert.equal(originals.length, 3);
  await f.driver.prompt(f.sessionId, 'FRESH_USER_TURN first recovery', { onPermission: () => true });
  await f.close();
  async function find(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { const nested = await find(file); if (nested) return nested; }
      else if (entry.name === 'session.v4.jsonl' && directory.endsWith(f.sessionId)) return file;
    }
  }
  const file = await find(join(f.directory, 'native'));
  const rows = (await readFile(file, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const admissions = rows.filter(row => row.type === 'user/message' && originals.some(message => row.data.id === message.id));
  assert.equal(admissions.length, originals.length);
  const retirements = rows.filter(row => row.type === 'agent/inbox/spliced' && row.data.outcome === 'canceled' && row.seq > admissions.at(-1).seq);
  assert.equal(retirements.length, 2);
  const boundary = cut === 'before-extra-admit' ? admissions[0].seq : cut === 'after-one-extra-admit' ? admissions[1].seq : cut === 'after-all-admit' ? admissions.at(-1).seq : cut === 'after-first-retire' ? retirements[0].seq : retirements.at(-1).seq;
  // Only the synthetic journal is truncated; native restoration reads it as-is.
  await writeFile(file, rows.filter(row => row.seq === undefined || row.seq <= boundary).map(row => JSON.stringify(row)).join('\n') + '\n');
  const beforeRestart = f.requests.length;
  await f.reopen();
  assert.equal(f.requests.length, beforeRestart, 'Opening the native session cannot restart a model');
  await f.driver.prompt(f.sessionId, 'FRESH_USER_TURN after process loss', { onPermission: () => true });
  const requests = f.requests.slice(beforeRestart);
  assert.equal(requests.length, 1, 'Recovery enters one model turn with all native notices');
  const admitted = (await f.driver.history(f.sessionId)).events.filter(row => row.type === 'user/message' && row.data.source?.kind === 'subagent-settled').map(row => row.data);
  assert.deepEqual(admitted, originals, 'Every original notice is admitted once, including a partially admitted batch');
  for (const message of originals) assert.ok(JSON.stringify(requests[0].body.messages).includes(message.source.summary));
  assert.deepEqual(f.failures, []);
});

for (const [restart, customTemplate] of [[false, false], [true, false], [true, true]]) test(`cancelled ${customTemplate ? 'custom ' : ''}child notices survive ${restart ? 'cold restart' : 'live recovery'} without waking the stopped parent or replaying the old child task`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { childCount: 3, customTemplate });
  const events = [];
  const controller = new AbortController();
  const pending = f.driver.prompt(f.sessionId, 'PARENT_DELEGATE_RETEST', { signal: controller.signal, onPermission: () => true, onEvent: event => events.push(event) });
  pending.catch(() => {});
  await f.childStarted.promise;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !(await f.driver.history(f.sessionId)).events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')) await delay(10);
  assert.ok((await f.driver.history(f.sessionId)).events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'));
  const ids = (await f.driver.listSubagentChildren(f.sessionId)).map(child => child.id);
  assert.equal(ids.length, 3);
  const beforeCancel = f.requests.length;
  controller.abort();
  assert.equal((await pending).stopReason, 'cancelled');
  assert.equal(f.requests.length, beforeCancel, 'Settlement cannot make an automatic model request after cancellation');
  const stopped = (await f.driver.history(f.sessionId)).events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : []).filter(message => message.source?.kind === 'subagent-settled');
  assert.equal(stopped.length, 3);
  for (const id of ids) {
    const child = await f.driver.history(id);
    assert.ok(child.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
  }
  if (restart) {
    await f.restart();
    assert.equal(f.requests.length, beforeCancel, 'Cold inspection and reconstruction must not start a model');
  }
  await f.driver.prompt(f.sessionId, 'FRESH_USER_TURN: report the actual stopped children; do not repeat their tasks.', { onPermission: () => true });
  assert.equal(f.requests.slice(beforeCancel).filter(request => request.fresh).length, 1, 'All parked child notices share one actual recovery model request');
  const first = f.requests[beforeCancel];
  assert.equal(first.fresh, true, 'The first recovery request must already include the new human instruction');
  assert.ok(ids.every(id => JSON.stringify(first.body.messages).includes(id)) && JSON.stringify(first.body.messages).includes('native-subagent-turns'), 'The first recovery request includes the native child execution snapshot');
  if (!restart) assert.ok(stopped.some(message => JSON.stringify(first.body.messages).includes(message.source.summary)), 'Live recovery also includes a real settlement');
  const history = await f.driver.history(f.sessionId);
  const delivered = history.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'subagent-settled');
  assert.deepEqual(delivered.map(event => event.data.id).sort(), restart ? [] : stopped.map(message => message.id).sort(), 'Live notices use native FIFO exactly once; native shutdown-discarded notices are not replayed');
  const context = history.events.findLast(event => event.type === 'user/message' && event.data.source?.kind === 'runtime-context' && event.data.source.sections?.some(section => section.name === 'codebuddy:subagent-turns'));
  const text = context?.data.source.sections.find(section => section.name === 'codebuddy:subagent-turns').text;
  const facts = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.deepEqual(facts.children.map(child => child.id).sort(), [...ids].sort());
  assert.ok(facts.children.every(child => child.reason === 'aborted' && child.state === 'ended'), 'Stopped is derived from native terminal records, including after shutdown');
  assert.equal(f.requests.filter(request => request.child).length, 3, 'Recovery must not replay an old child task');
  f.childId = ids[0];
  await f.driver.prompt(f.sessionId, 'REUSE_CHILD_RETEST', { onPermission: () => true });
  assert.deepEqual((await f.driver.listSubagentChildren(f.sessionId)).map(child => child.id), ids);
  const resumed = f.requests.find(request => request.resume);
  assert.ok(resumed && JSON.stringify(resumed.body.messages).includes('CHILD_WAIT_RETEST'), 'The same child continues with its existing history');
  if (customTemplate) assert.match(JSON.stringify(resumed.body.messages), /CUSTOM_CANCEL_RESPONSIBILITY/);
  assert.deepEqual(f.failures, []);
});

test('immediate cancellation retires only its unclaimed prompt and returns a native terminal before a new user turn', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.driver.prompt(f.sessionId, 'PARENT_DELEGATE_RETEST', { requestId: 'cancelled-admission', signal: controller.signal });
  controller.abort();
  assert.equal((await pending).stopReason, 'cancelled');
  assert.equal(f.requests.length, 0);
  const history = await f.driver.history(f.sessionId);
  assert.ok(history.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'));
  await f.driver.prompt(f.sessionId, 'FRESH_USER_TURN: no old task is authorized.', { onPermission: () => true });
  assert.equal(f.requests[0].fresh, true);
  assert.ok(!JSON.stringify(f.requests[0].body.messages).includes('PARENT_DELEGATE_RETEST'), 'The cancelled unclaimed task cannot execute in a later turn');
  assert.deepEqual(f.failures, []);
});

test('stopping one chat leaves another chat child running and excludes its facts from recovery', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const a = new AbortController(), b = new AbortController();
  const first = f.driver.prompt(f.sessionId, 'PARENT_DELEGATE_RETEST A', { signal: a.signal, onPermission: () => true });
  first.catch(() => {});
  await f.childStarted.promise;
  const other = await f.otherSession();
  const second = f.driver.prompt(other, 'PARENT_DELEGATE_RETEST B', { signal: b.signal, onPermission: () => true });
  second.catch(() => {});
  const deadline = Date.now() + 5_000;
  while (f.waitingChildren < 2 && Date.now() < deadline) await delay(10);
  assert.equal(f.waitingChildren, 2);
  const own = (await f.driver.listSubagentChildren(f.sessionId))[0].id;
  const foreign = (await f.driver.listSubagentChildren(other))[0].id;
  a.abort();
  assert.equal((await first).stopReason, 'cancelled');
  const otherHistory = await f.driver.history(foreign);
  assert.equal(otherHistory.events.findLast(event => ['turn/start', 'turn/end'].includes(event.type)).type, 'turn/start', 'Stopping A must not stop the running child in B');
  const beforeRecovery = f.requests.length;
  await f.driver.prompt(f.sessionId, 'FRESH_USER_TURN A', { onPermission: () => true });
  const recovered = JSON.stringify(f.requests[beforeRecovery].body.messages);
  assert.ok(recovered.includes(own) && recovered.includes('native-subagent-turns'));
  assert.ok(!recovered.includes(foreign), 'A recovery cannot read B child identities or execution facts');
  assert.equal(f.requests.filter(request => request.child).length, 2, 'Neither child task is replayed by A recovery');
  b.abort();
  assert.equal((await second).stopReason, 'cancelled');
  assert.deepEqual(f.failures, []);
});
