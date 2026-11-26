import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../store.mjs';
import { InputQueue } from '../input-queue.mjs';

const item = (id, content = id) => ({ id, content, timestamp: 1, images: [], desktopGeneration: 'old' });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-input-queue-'));
  const store = await openStore(root);
  await store.update(s => { s.sessions.push({ id: 's', updates: [] }); });
  let active, cancelCalls = 0, closing = false;
  const consumed = new Set(), calls = [];
  let dispatch = async (_id, batch) => {
    calls.push(batch); batch.forEach(row => consumed.add(row.id));
    return { stopReason: 'end_turn' };
  };
  let cancel = async () => { cancelCalls++; };
  const queue = new InputQueue(store, { active: () => active,
    cancel: (...args) => cancel(...args), dispatch: (...args) => dispatch(...args),
    inputIds: async () => [...consumed], closing: () => closing });
  const request = command => queue.request('s', { revision: queue.read('s').revision, commandId: randomUUID(), ...command }, {});
  const idle = async () => { while (queue.workers.size) await Promise.all([...queue.workers.values()]); };
  t.after(async () => { closing = true; active?.release?.(); await idle(); await rm(root, { recursive: true, force: true }); });
  return { queue, store, calls, consumed, request, idle,
    cancelCalls: () => cancelCalls,
    hold() { const done = Promise.withResolvers(); active = { run: { runId: 'run' }, done: done.promise,
      release() { active = undefined; done.resolve(); } }; return active; },
    setCancel(fn) { cancel = fn; }, setDispatch(fn) { dispatch = fn; } };
}
test('ordinary enqueue waits for the old run then consumes each message in FIFO order', async t => {
  const f = await fixture(t), old = f.hold();
  await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
  assert.equal(f.calls.length, 0); assert.equal(f.cancelCalls(), 0);
  old.release(); await f.idle();
  assert.deepEqual(f.calls.map(batch => batch.map(row => row.id)), [['a'], ['b']]);
  assert.deepEqual(f.queue.snapshot('s').items, []);
});
test('switch persists a batch, cancels the old run and never dispatches before settlement', async t => {
  const f = await fixture(t), old = f.hold();
  await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
  let cancelObserved = false;
  f.setCancel(async () => {
    assert.deepEqual(f.queue.read('s').selection.ids, ['b', 'a']); cancelObserved = true;
  });
  await f.request({ action: 'send', ids: ['b', 'a'], expectedRunId: 'run', desktopGeneration: 'new' });
  assert.equal(cancelObserved, true); assert.equal(f.calls.length, 0);
  old.release(); await f.idle();
  assert.deepEqual(f.calls[0].map(row => row.id), ['b', 'a']);
  assert.ok(f.calls[0].every(row => row.desktopGeneration === 'new'));
});
test('edit, reorder, remove and clear use revision checks without changing message identities', async t => {
  const f = await fixture(t); await f.request({ action: 'pause' });
  await f.request({ action: 'enqueue', items: [item('a'), item('b'), item('c')] });
  const revision = f.queue.read('s').revision;
  await f.request({ action: 'edit', id: 'b', content: 'changed' });
  await assert.rejects(f.request({ action: 'remove', id: 'b', revision }), /更新/);
  await assert.rejects(f.request({ action: 'edit', id: 'a', content: ' ' }), /Invalid/);
  await f.request({ action: 'reorder', ids: ['c', 'b', 'a'] });
  await f.request({ action: 'remove', id: 'a' });
  assert.deepEqual(f.queue.snapshot('s').items.map(row => [row.id, row.content]), [['c', 'c'], ['b', 'changed']]);
  await f.request({ action: 'clear' });
  assert.deepEqual(f.queue.snapshot('s').items, []);
});
test('the same durable command can be retried without duplicate input; changed payload is rejected', async t => {
  const f = await fixture(t); await f.request({ action: 'pause' });
  const command = { action: 'enqueue', commandId: 'stable', revision: f.queue.read('s').revision, items: [item('a')] };
  await f.request(command); await f.request(command);
  assert.equal(f.queue.snapshot('s').items.length, 1);
  assert.equal((await f.request({ action: 'get', commandId: 'stable' })).commandApplied, true);
  await assert.rejects(f.request({ ...command, items: [item('a', 'different')] }), /reused/);
});
test('batch failure preserves separate original items and requires confirmation before retry', async t => {
  const f = await fixture(t); await f.request({ action: 'pause' });
  const image = { data: 'aW1hZ2U=', mimeType: 'image/png' };
  await f.request({ action: 'enqueue', items: [{ ...item('a'), images: [image] }, item('b')] });
  f.setDispatch(async () => { throw new Error('transport unavailable'); });
  await f.request({ action: 'send', ids: ['a', 'b'], expectedRunId: null }); await f.idle();
  assert.deepEqual(f.queue.snapshot('s').items.map(row => row.id), ['a', 'b']);
  assert.deepEqual(f.queue.snapshot('s').items[0].images, [image]);
  assert.equal(f.queue.snapshot('s').paused, true);
  await assert.rejects(f.request({ action: 'remove', id: 'a' }), /不能再修改/);
  await f.request({ action: 'resolve', id: 'a' });
  assert.equal(f.queue.snapshot('s').items[0].state, 'pending');
});
test('restart pauses pending work and reconciles consumed receipts without replay', async t => {
  const f = await fixture(t); await f.request({ action: 'pause' });
  await f.request({ action: 'import', items: [{ ...item('a'), delivery: 'submitting' }, item('b')] });
  f.consumed.add('a'); await f.queue.initialize();
  const snap = await f.request({ action: 'get' });
  assert.equal(snap.paused, true); assert.deepEqual(snap.items.map(row => row.id), ['b']);
  assert.equal(f.calls.length, 0);
});
test('explicit stop withdraws a pending switch and retains all waiting messages', async t => {
  const f = await fixture(t), old = f.hold();
  await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
  await f.request({ action: 'send', ids: ['a'], expectedRunId: 'run' });
  await f.queue.pause('s'); old.release(); await f.idle();
  assert.equal(f.calls.length, 0); assert.equal(f.queue.snapshot('s').items.length, 2);
});
test('stale run ID cannot cancel or dispatch a newer run', async t => {
  const f = await fixture(t), old = f.hold();
  await f.request({ action: 'enqueue', items: [item('a')] });
  await assert.rejects(f.request({ action: 'send', ids: ['a'], expectedRunId: 'stale' }), /已变化/);
  assert.equal(f.cancelCalls(), 0); await f.queue.pause('s'); old.release();
});

test('selected identities are immutable until cancellation settles and duplicate sends cancel once', async t => {
 const f=await fixture(t), old=f.hold();
 await f.request({action:'enqueue',items:[item('a'),item('b')]});
 const command={action:'send',ids:['a'],expectedRunId:'run',commandId:'same',revision:f.queue.read('s').revision};
 await f.request(command);await f.request(command);
 for(const action of [{action:'edit',id:'a',content:'changed'},{action:'remove',id:'a'},{action:'clear'},{action:'reorder',ids:['b','a']}])
   await assert.rejects(f.request(action));
 assert.equal(f.cancelCalls(),1);old.release();await f.idle();
 assert.equal(f.calls[0][0].content,'a');
});

test('new inputs may append across consumption revisions without overwriting earlier messages',async t=>{
 const f=await fixture(t);await f.request({action:'pause'});
 const revision=f.queue.read('s').revision;
 await f.request({action:'enqueue',items:[item('a')]});
 await f.request({action:'enqueue',revision,items:[item('b')]});
 assert.deepEqual(f.queue.snapshot('s').items.map(row=>row.id),['a','b']);
 await assert.rejects(f.request({action:'edit',revision,id:'a',content:'stale edit'}),/更新/);
});

test('opening an editor pauses delivery before the running turn settles; only explicit send uses the saved edit',async t=>{
 const f=await fixture(t), old=f.hold();
 await f.request({action:'enqueue',items:[item('a','old text'),item('b')]});
 await f.request({action:'begin-edit',id:'a'});old.release();await f.idle();
 assert.equal(f.calls.length,0);
 await f.request({action:'edit',id:'a',content:'edited text'});await f.idle();assert.equal(f.calls.length,0);
 await f.request({action:'send',ids:['a'],expectedRunId:null});await f.idle();
 assert.equal(f.calls[0][0].content,'edited text');
});

for (const scenario of ['fifo', 'batch', 'stop']) {
  test(`direct prompt acquiring ownership during queue persistence preserves ${scenario}`, async t => {
    const f = await fixture(t);
    const entered = Promise.withResolvers();
    const update = f.store.updateSession.bind(f.store);
    let owner, intercepted = false;
    f.store.updateSession = async (...args) => {
      await update(...args);
      if (!intercepted && f.queue.read('s').items.some(row => row.state === 'dispatching')) {
        intercepted = true;
        owner = f.hold();
        entered.resolve();
      }
    };
    if (scenario === 'batch') await f.request({ action: 'pause' });
    await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
    if (scenario === 'batch') await f.request({ action: 'send', ids: ['b', 'a'], expectedRunId: null });
    await entered.promise;
    await f.queue.serial('s', () => {});
    assert.equal(f.calls.length, 0, 'new owner must not be raced by a queued prompt');
    assert.equal(f.cancelCalls(), 0, 'unobserved new owner must not be cancelled');
    assert.equal(f.queue.snapshot('s').paused, false);
    assert.ok(f.queue.snapshot('s').items.every(row => row.state === 'pending'));
    if (scenario === 'stop') await f.queue.pause('s');
    owner.release();
    await f.idle();
    if (scenario === 'stop') {
      assert.equal(f.calls.length, 0);
      assert.equal(f.queue.snapshot('s').paused, true);
      assert.equal(f.queue.snapshot('s').items.length, 2);
    } else {
      assert.deepEqual(f.calls.map(batch => batch.map(row => row.id)), scenario === 'batch' ? [['b', 'a']] : [['a'], ['b']]);
      assert.equal(f.queue.snapshot('s').paused, false);
      assert.deepEqual(f.queue.snapshot('s').items, []);
    }
  });
}
test('send accepted while idle does not cancel a direct owner appearing during selection persistence', async t => {
  const f = await fixture(t);
  await f.request({ action: 'pause' });
  await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
  const update = f.store.updateSession.bind(f.store);
  let owner;
  f.store.updateSession = async (...args) => {
    await update(...args);
    if (!owner && f.queue.read('s').selection) owner = f.hold();
  };
  await f.request({ action: 'send', ids: ['b', 'a'], expectedRunId: null });
  assert.equal(f.cancelCalls(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queue.snapshot('s').paused, false);
  owner.release(); await f.idle();
  assert.deepEqual(f.calls.map(batch => batch.map(row => row.id)), [['b', 'a']]);
});