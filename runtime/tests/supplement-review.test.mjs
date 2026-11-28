import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../harness/index.mjs';
import { Compat } from '../compat.mjs';

async function fixture(t, preset, { readFirst = false, queuedWrite = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cb-supplement-review-')));
  const once = join(root, 'once.txt'), extra = join(root, 'extra.md');
  const queued = join(root, 'queued.md');
  if (readFirst) await writeFile(once, 'SOURCE\n');
  let step = 0, driver;
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const actions = readFirst ? [['read', { file_path: once }], ['write', { file_path: extra, content: '# Report\n' }]] : [ ['write', { file_path: once, content: 'ONCE\n' }],
        ['write', { file_path: once, content: 'ONCE\nONCE\n' }],
        ['read', { file_path: once }], ['write', { file_path: extra, content: 'QUEUE-OK' }] ];
      const action = step === 6 ? ['write', queuedWrite
        ? { file_path: queued, content: '# Queued report\n' }
        : { file_path: once, content: 'ONCE\nONCE\n' }] : actions[step];
      step++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: randomUUID(), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (action) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] });
        emit({}, 'tool_calls');
      } else { emit({ role: 'assistant', content: 'Fixture answer.' }); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); res.destroy(error); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  const { sessionId } = await driver.createSession({ provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, model: 'fixture' });
  if (preset) await driver.permissions(sessionId, { cwd: root, preset });
  let first = true;
  const start = (onPermission, queuedWhileBusy = false, onToolPolicy = () => ({ kind: 'allow' })) => driver.prompt(sessionId, 'Write once.', {
    queuedWhileBusy,
    onToolPolicy, onPermission,
    onToolStart: async () => { if (first) { first = false; await driver.steer(sessionId, 'Also create extra, preserving existing work.'); } },
  });
  return { root, once, extra, queued, driver, sessionId, start, failures };
}

test('native supplement reviews exact proposals despite allow policy; rejection preserves old effect and next ordinary turn is independent', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const asked = Promise.withResolvers(), decision = Promise.withResolvers();
  const calls = [];
  const running = f.start(async call => {
    calls.push(call);
    assert(call.supplementReview);
    if (calls.length === 1) { asked.resolve(); return decision.promise; }
    return true;
  }, true);
  await asked.promise;
  assert.equal(await readFile(f.once, 'utf8'), 'ONCE\n', 'proposal has no effect while review waits');
  decision.resolve(false);
  await running;
  assert.equal(await readFile(f.once, 'utf8'), 'ONCE\n');
  assert.equal(await readFile(f.extra, 'utf8'), 'QUEUE-OK');
  assert.equal(calls.length, 2, 'native read needs no new approval');
  assert.equal(calls[0].arguments.content, 'ONCE\nONCE\n');
  assert(calls[0].supplementReview.receipts.some(r => r.path === f.once));
  const history = await f.driver.history(f.sessionId);
  assert.equal(history.events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').length, 2);
  await f.driver.prompt(f.sessionId, 'A new ordinary request.', { onPermission: () => { throw Error('prior supplement leaked'); } });
  await f.driver.prompt(f.sessionId, 'Repeat intentionally.', { onPermission: () => { throw Error('ordinary intentional repeat must not inherit review'); } });
  assert.equal(await readFile(f.once, 'utf8'), 'ONCE\nONCE\n');
  assert.deepEqual(f.failures, []);
});

test('full access preserves allowed Markdown creation after native steering', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'danger-full-access', { readFirst: true });
  await f.start(() => { throw Error('full access must not request approval for an allowed file write'); });
  assert.equal(await readFile(f.extra, 'utf8'), '# Report\n',
    'A supplemental user message must not remove the native full-access write capability');
  assert.deepEqual(f.failures, []);
});

test('approval:never still rejects an explicit host approval requirement after steering', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'danger-full-access');
  await f.start(() => { throw Error('never mode must not ask'); }, false,
    call => ({ kind: call.arguments.file_path === f.extra ? 'ask' : 'allow' }));
  assert.equal(await readFile(f.once, 'utf8'), 'ONCE\nONCE\n');
  await assert.rejects(readFile(f.extra), { code: 'ENOENT' });
  assert.match(JSON.stringify(await f.driver.history(f.sessionId)), /APPROVAL_UNAVAILABLE/);
});

test('a queued native turn keeps full-access writes without an impossible approval', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'danger-full-access', { queuedWrite: true });
  const onPermission = () => { throw Error('an allowed queued file write must not ask in never mode'); };
  await f.start(onPermission);
  await f.driver.prompt(f.sessionId, 'An ordinary explanation.');
  await f.driver.prompt(f.sessionId, 'Create the queued report.', { queuedWhileBusy: true, onPermission });
  assert.equal(await readFile(f.queued, 'utf8'), '# Queued report\n');
  assert.deepEqual(f.failures, []);
});

test('steering under never does not override explicit deny or cancel', { timeout: 30000 }, async t => {
  for (const kind of ['deny', 'cancel']) await t.test(kind, async t => {
    const f = await fixture(t, 'danger-full-access', { readFirst: true });
    await f.start(() => { throw Error('no approval is available'); }, false,
      call => call.name === 'write' ? { kind, ...(kind === 'deny' ? { reason: 'Fixture explicit deny' } : {}) } : { kind: 'allow' });
    await assert.rejects(readFile(f.extra), { code: 'ENOENT' });
    assert.equal(await readFile(f.once, 'utf8'), 'SOURCE\n');
  });
});

test('a read-only root retains its file sandbox after supplemental approval', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'read-only', { readFirst: true });
  assert.equal((await f.driver.permissions(f.sessionId)).approvalPolicy, 'ask');
  let confirmations = 0;
  await f.start(() => { confirmations++; return true; });
  assert.equal(confirmations, 1, 'Confirming a proposal does not itself widen the native file sandbox');
  await assert.rejects(readFile(f.extra), { code: 'ENOENT' });
  assert.equal(await readFile(f.once, 'utf8'), 'SOURCE\n');
  assert.match(JSON.stringify(await f.driver.history(f.sessionId)), /FS_SANDBOX_DENIED/);
});

test('queued follow-up admitted as a later native turn still requires a fresh decision', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.start(call => call.arguments.file_path === f.extra);
  await f.driver.prompt(f.sessionId, 'Ordinary explanation.');
  let confirmations = 0;
  await f.driver.prompt(f.sessionId, 'Previously queued follow-up.', {
    queuedWhileBusy: true, onToolPolicy: () => ({ kind: 'allow' }),
    onPermission: call => { confirmations++; assert(call.supplementReview); return false; },
  });
  assert.equal(confirmations, 1);
  assert.equal(await readFile(f.once, 'utf8'), 'ONCE\n');
});

test('cancelling unresolved supplemental approval never executes its proposal', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const asked = Promise.withResolvers();
  const running = f.start(call => { asked.resolve(); return new Promise(resolve => call.signal.addEventListener('abort', () => resolve(false), { once: true })); });
  await asked.promise;
  await f.driver.cancel(f.sessionId);
  assert.equal((await running).stopReason, 'cancelled');
  assert.equal(await readFile(f.once, 'utf8'), 'ONCE\n');
  await assert.rejects(readFile(f.extra), { code: 'ENOENT' });
});

test('Compat supplemental review ignores existing reusable grants and offers only allow-once/reject', async () => {
  const scope = { isCurrent: () => true };
  const host = Object.assign(Object.create(Compat.prototype), {
    store: { readSession: () => ({}), read: () => ({ toolPermissions: { write: 'always_allow' } }) },
    toolAvailable: async () => true, toolGrant: () => ({ allowed: true }), businessGrant: () => ({ allowed: true }),
  });
  const proposal = { id: 'call', name: 'write', arguments: { file_path: 'once.txt', content: 'duplicate' },
    sessionApproval: scope, supplementReview: { receipts: [{ path: 'once.txt' }] } };
  let question;
  const accepted = await host.approveTool({ id: 'session' }, proposal, { ask: async (_, q) => { question = q; return { outcome: { outcome: 'selected', optionId: 'allow_always' } }; } }, new AbortController().signal);
  assert.equal(accepted, false, 'a stale session-choice reply cannot authorize the new proposal');
  assert.deepEqual(question.options.map(o => o.kind), ['allow_once', 'reject_once']);
  assert.deepEqual(question.toolCall.rawInput, proposal.arguments);
  assert.match(JSON.stringify(question.toolCall.content), /previousReceipts/);
});

test('an unknown approval outcome does not authorize or automatically replay a supplemental effect', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.start(() => { throw new Error('Approval transport disconnected before a decision'); });
  assert.equal(await readFile(f.once, 'utf8'), 'ONCE\n');
  await assert.rejects(readFile(f.extra), { code: 'ENOENT' });
  assert.deepEqual(f.failures, []);
});
