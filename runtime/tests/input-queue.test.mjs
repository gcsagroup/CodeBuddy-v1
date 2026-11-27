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
  const consumed = new Set(), nativePending = new Set(), calls = [], steering = [];
  let inputIds = async (_id, committedOnly = true) => [...(committedOnly ? consumed : nativePending)];
  let steer = async (_id, row) => { steering.push(row); consumed.add(row.id); };
  let dispatch = async (_id, batch) => {
    calls.push(batch); batch.forEach(row => consumed.add(row.id));
    return { stopReason: 'end_turn' };
  };
  let cancel = async () => { cancelCalls++; };
  const queue = new InputQueue(store, { active: () => active,
    cancel: (...args) => cancel(...args), dispatch: (...args) => dispatch(...args),
    steer: (...args) => steer(...args),
    inputIds: (...args) => inputIds(...args), closing: () => closing });
  const request = command => queue.request('s', { revision: queue.read('s').revision, commandId: randomUUID(), ...command }, {});
  const idle = async () => { while (queue.workers.size) await Promise.all([...queue.workers.values()]); };
  t.after(async () => { closing = true; active?.release?.(); await idle(); await rm(root, { recursive: true, force: true }); });
  return { queue, store, calls, consumed, nativePending, steering, request, idle,
    cancelCalls: () => cancelCalls,
    hold(runId = 'run') { const done = Promise.withResolvers(); const owner = { run: { runId }, done: done.promise,
      release() { if (active === owner) active = undefined; done.resolve(); } }; active = owner; return owner; },
    setInputIds(fn) { inputIds = fn; },
    setCancel(fn) { cancel = fn; }, setDispatch(fn) { dispatch = fn; }, setSteer(fn) { steer = fn; } };
}

async function until(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'expected queue transition did not occur');
    await new Promise(setImmediate);
  }
}

test('steering wakes a queue worker waiting on the old run without cancellation or duplicate delivery', async t => {
  const f = await fixture(t), old = f.hold(), delivered = Promise.withResolvers();
  await f.request({ action: 'enqueue', items: [item('queued')] });
  f.setSteer(async (_id, row) => {
    f.steering.push(row); f.consumed.add(row.id);
    await f.queue.consumed('s', row.id); delivered.resolve();
  });
  const command = { action: 'enqueue', commandId: 'stable-steer-command', revision: f.queue.read('s').revision, expectedRunId: 'run', items: [{ ...item('guide'), mode: 'steer' }] };
  await f.request(command);
  await delivered.promise;
  await f.request(command);
  assert.equal(f.cancelCalls(), 0);
  assert.deepEqual(f.steering.map(row => row.id), ['guide']);
  assert.deepEqual(f.calls, []);
  old.release(); await f.idle();
  assert.deepEqual(f.calls.flat().map(row => row.id), ['queued']);
});

test('admission is not consumption and a run ending before consumption retains uncertain input', async t => {
  const f = await fixture(t), old = f.hold(), admitted = Promise.withResolvers();
  f.setSteer(async () => admitted.resolve());
  await f.request({ action: 'enqueue', expectedRunId: 'run', items: [{ ...item('guide'), mode: 'steer' }] });
  await admitted.promise;
  old.release(); await f.idle();
  assert.equal(f.queue.snapshot('s').items[0].state, 'uncertain');
  assert.equal(f.queue.snapshot('s').paused, true);
  await f.queue.initialize(); await f.idle();
  assert.deepEqual(f.calls, []);
});

test('steering also wakes the worker that started the active prompt itself', async t => {
  const f = await fixture(t), started = Promise.withResolvers(), delivered = Promise.withResolvers();
  f.setDispatch(async (_id, rows) => {
    f.calls.push(rows); rows.forEach(row => f.consumed.add(row.id));
    const owner = f.hold(); started.resolve(owner);
    await owner.done;
    return { stopReason: 'end_turn' };
  });
  f.setSteer(async (_id, row) => { f.steering.push(row); f.consumed.add(row.id); delivered.resolve(); });
  await f.request({ action: 'enqueue', items: [item('start')] });
  const owner = await started.promise;
  await f.request({ action: 'enqueue', expectedRunId: 'run', items: [{ ...item('guide'), mode: 'steer' }] });
  await delivered.promise;
  assert.deepEqual(f.steering.map(row => row.id), ['guide']);
  assert.equal(f.calls.length, 1); assert.equal(f.cancelCalls(), 0);
  owner.release(); await f.idle();
  assert.deepEqual(f.queue.snapshot('s').items, []);
});

test('steering does not release a paused legacy queue or target a different run', async t => {
  const f = await fixture(t), old = f.hold(), delivered = Promise.withResolvers();
  await f.request({ action: 'pause' });
  await f.request({ action: 'enqueue', items: [item('queued')] });
  f.setSteer(async (_id, row) => { f.consumed.add(row.id); delivered.resolve(); });
  await assert.rejects(f.request({ action: 'enqueue', expectedRunId: 'other', items: [{ ...item('stale'), mode: 'steer' }] }), /执行已变化/);
  await f.request({ action: 'enqueue', expectedRunId: 'run', items: [{ ...item('guide'), mode: 'steer' }] });
  await delivered.promise;
  old.release(); await f.idle();
  assert.equal(f.queue.read('s').paused, true);
  assert.equal(f.queue.read('s').items.find(row => row.id === 'queued').state, 'pending');
  assert.deepEqual(f.calls, []);
});

test('a delayed guide cannot start a new turn after its selected run ends', async t => {
  const f = await fixture(t), old = f.hold();
  old.release();
  await assert.rejects(f.request({ action: 'enqueue', expectedRunId: 'run',
    items: [{ ...item('late-guide'), mode: 'steer' }] }), /执行已变化/);
  await f.idle();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.queue.snapshot('s').items, []);
});

test('a paused queue still tracks admitted steering until its run ends', async t => {
  const f = await fixture(t), old = f.hold(), admitted = Promise.withResolvers();
  await f.request({ action: 'pause' });
  f.setSteer(async () => admitted.resolve());
  await f.request({ action: 'enqueue', expectedRunId: 'run', items: [{ ...item('guide'), mode: 'steer' }] });
  await admitted.promise;
  old.release(); await f.idle();
  assert.equal(f.queue.snapshot('s').items[0].state, 'uncertain');
  assert.equal(f.queue.snapshot('s').paused, true);
});
test('ordinary enqueue waits for the old run then consumes each message in FIFO order', async t => {
  const f = await fixture(t), old = f.hold();
  const images = [{ data: 'Zmlyc3Q=', mimeType: 'image/png' }, { data: 'c2Vjb25k', mimeType: 'image/png' }];
  await f.request({ action: 'enqueue', items: [{ ...item('a'), images: [images[0]] }, { ...item('b'), images: [images[1]] }] });
  assert.equal(f.calls.length, 0); assert.equal(f.cancelCalls(), 0);
  old.release(); await f.idle();
  assert.deepEqual(f.calls.map(batch => batch.map(row => row.id)), [['a'], ['b']]);
  assert.deepEqual(f.calls.map(batch => batch[0].images), [[images[0]], [images[1]]]);
  assert.deepEqual(f.queue.snapshot('s').items, []);
});

test('next-step sends selected queue identities through native steering without cancelling the run', async t => {
  const f = await fixture(t), old = f.hold(), delivered = Promise.withResolvers();
  const images = ['YQ==', 'Yg==', 'Yw=='].map(data => ({ data, mimeType: 'image/png' }));
  await f.request({ action: 'enqueue', items: ['a', 'b', 'c'].map((id, index) => ({ ...item(id, '1'), images: [images[index]] })) });
  f.setSteer(async (_id, row) => {
    f.steering.push(row); f.consumed.add(row.id);
    if (row.id === 'b') delivered.resolve();
  });
  const command = { action: 'next-step', ids: ['a', 'b'], expectedRunId: 'run',
    commandId: 'native-step-selection', revision: f.queue.read('s').revision };
  await f.request(command); await delivered.promise; await f.request(command);
  assert.equal(f.cancelCalls(), 0);
  assert.deepEqual(f.steering.map(row => row.id), ['a', 'b']);
  assert.deepEqual(f.steering.map(row => row.images), [[images[0]], [images[1]]]);
  assert.ok(f.steering.every(row => row.mode !== 'steer' && row.deliveryTarget === 'next-step'));
  assert.deepEqual(f.calls, []);
  old.release(); await f.idle();
  assert.deepEqual(f.calls.flat().map(row => row.id), ['c']);
  assert.deepEqual(f.calls[0][0].images, [images[2]]);
});

test('legacy stop-and-send is rejected while idle queue resume preserves separate next turns', async t => {
  const f = await fixture(t), old = f.hold();
  await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
  await assert.rejects(f.request({ action: 'send', ids: ['a'], expectedRunId: 'run' }));
  assert.equal(f.cancelCalls(), 0);
  await f.queue.pause('s'); old.release(); await f.idle();
  await f.request({ action: 'resume' }); await f.idle();
  assert.deepEqual(f.calls.map(rows => rows.map(row => row.id)), [['a'], ['b']]);
});

test('native-owned next-step input stays admitted across stop and restart without replay', async t => {
  const f = await fixture(t), old = f.hold();
  f.setSteer(async (_id, row) => { f.nativePending.add(row.id); f.steering.push(row); });
  await f.request({ action: 'enqueue', items: [item('owned')] });
  await f.request({ action: 'next-step', ids: ['owned'], expectedRunId: 'run' });
  await until(() => f.queue.read('s').items[0].state === 'admitted');
  await f.queue.pause('s'); old.release(); await f.idle();
  assert.equal(f.queue.snapshot('s').items[0].state, 'admitted');
  await f.queue.initialize();
  const restored = await f.request({ action: 'get' });
  assert.equal(restored.items[0].state, 'admitted');
  assert.equal(restored.paused, true);
  assert.equal(f.steering.length, 1); assert.deepEqual(f.calls, []);
});

test('withdrawing a next-step choice before native dispatch leaves an ordinary pending message', async t => {
  const f = await fixture(t), old = f.hold();
  await f.request({ action: 'enqueue', items: [item('withdrawn')] });
  await f.store.updateSession('s', s => {
    Object.assign(s.inputQueue.items[0], { deliveryTarget: 'next-step', targetRunId: 'run' });
  });
  await f.queue.pause('s');
  // The worker may have selected this ID just before Stop acquired the serial boundary.
  await f.queue.deliverSteering('s', old, 'withdrawn');
  assert.equal(f.queue.snapshot('s').items[0].state, 'pending');
  assert.equal(f.steering.length, 0); assert.equal(f.cancelCalls(), 0);
  old.release(); await f.idle(); assert.deepEqual(f.calls, []);
});

test('a delayed old inbox query cannot withdraw a next-step choice for a new run', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await f.request({ action: 'pause' });
  await f.store.updateSession('s', s => { s.inputQueue.items = [
    { ...item('owned'), state: 'admitted', deliveryTarget: 'next-step', targetRunId: 'old' },
    { ...item('old-unattempted'), state: 'pending', deliveryTarget: 'next-step', targetRunId: 'old' },
    { ...item('new-choice'), state: 'pending' },
  ]; });
  f.nativePending.add('owned');
  let delayed = false;
  f.setInputIds(async (_id, committedOnly) => {
    if (!committedOnly && !delayed) { delayed = true; entered.resolve(); await release.promise; }
    return [...(committedOnly ? f.consumed : f.nativePending)];
  });
  f.queue.kick('s'); await entered.promise;
  const current = f.hold('new');
  await f.request({ action: 'next-step', ids: ['new-choice'], expectedRunId: 'new' });
  release.resolve();
  await until(() => f.steering.some(row => row.id === 'new-choice'));
  assert.equal(f.steering[0].targetRunId, 'new');
  assert.equal(f.steering[0].deliveryTarget, 'next-step');
  assert.equal(f.queue.read('s').items.find(row => row.id === 'old-unattempted').deliveryTarget, undefined);
  assert.equal(f.cancelCalls(), 0);
  await f.queue.pause('s'); current.release(); await f.idle();
});
test('ten identical queued texts retain ten identities when moved to next step', async t => {
  const f = await fixture(t), old = f.hold(), delivered = Promise.withResolvers();
  const rows = Array.from({ length: 10 }, (_, i) => item(`query-${i}`, '1'));
  await f.request({ action: 'enqueue', items: rows });
  f.setSteer(async (_id, row) => {
    f.steering.push(row); f.consumed.add(row.id);
    if (f.steering.length === 10) delivered.resolve();
  });
  await f.request({ action: 'next-step', ids: rows.map(row => row.id), expectedRunId: 'run' });
  await delivered.promise;
  assert.deepEqual(f.steering.map(row => row.id), rows.map(row => row.id));
  assert.ok(f.steering.every(row => row.content === '1'));
  assert.equal(f.cancelCalls(), 0); assert.deepEqual(f.calls, []);
  old.release(); await f.idle();
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
  await f.request({ action: 'resume' }); await f.idle();
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
test('restart withdraws a legacy stop-and-send selection without cancelling or replaying', async t => {
  const f = await fixture(t), old = f.hold();
  await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
  await f.store.updateSession('s', s => { s.inputQueue.selection = { id: 'legacy', ids: ['a'], expectedRunId: 'run' }; });
  await f.queue.initialize(); old.release(); await f.idle();
  assert.equal(f.cancelCalls(), 0);
  assert.equal(f.calls.length, 0); assert.equal(f.queue.snapshot('s').items.length, 2);
});
test('stale run ID cannot cancel or dispatch a newer run', async t => {
  const f = await fixture(t), old = f.hold();
  await f.request({ action: 'enqueue', items: [item('a')] });
  await assert.rejects(f.request({ action: 'next-step', ids: ['a'], expectedRunId: 'stale' }), /已变化/);
  assert.equal(f.cancelCalls(), 0); await f.queue.pause('s'); old.release();
});

test('next-step admission freezes the selected identity and repeated commands never cancel or re-admit', async t => {
 const f=await fixture(t), old=f.hold();
 const started=Promise.withResolvers(), release=Promise.withResolvers();
 f.setSteer(async (_id,row)=>{ f.steering.push(row);started.resolve();await release.promise;f.consumed.add(row.id); });
 await f.request({action:'enqueue',items:[item('a'),item('b')]});
 const command={action:'next-step',ids:['a'],expectedRunId:'run',commandId:'same',revision:f.queue.read('s').revision};
 await f.request(command);await started.promise;await f.request(command);
 for(const action of [{action:'edit',id:'a',content:'changed'},{action:'remove',id:'a'},{action:'reorder',ids:['b','a']}])
   await assert.rejects(f.request(action));
 await f.request({action:'clear'});
 assert.equal(f.cancelCalls(),0);assert.equal(f.steering.length,1);
 release.resolve();old.release();await f.idle();
 assert.equal(f.steering[0].content,'a');assert.deepEqual(f.calls,[]);
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
 await f.request({action:'resume'});await f.idle();
 assert.equal(f.calls[0][0].content,'edited text');
});

for (const scenario of ['fifo', 'resume', 'stop']) {
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
    if (scenario === 'resume') await f.request({ action: 'pause' });
    await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
    if (scenario === 'resume') await f.request({ action: 'resume' });
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
      assert.deepEqual(f.calls.map(batch => batch.map(row => row.id)), [['a'], ['b']]);
      assert.equal(f.queue.snapshot('s').paused, false);
      assert.deepEqual(f.queue.snapshot('s').items, []);
    }
  });
}
test('resuming while idle does not cancel a direct owner appearing during persistence', async t => {
  const f = await fixture(t);
  await f.request({ action: 'pause' });
  await f.request({ action: 'enqueue', items: [item('a'), item('b')] });
  const update = f.store.updateSession.bind(f.store);
  let owner;
  f.store.updateSession = async (...args) => {
    await update(...args);
    if (!owner && !f.queue.read('s').paused) owner = f.hold();
  };
  await f.request({ action: 'resume' });
  assert.equal(f.cancelCalls(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queue.snapshot('s').paused, false);
  owner.release(); await f.idle();
  assert.deepEqual(f.calls.map(batch => batch.map(row => row.id)), [['a'], ['b']]);
});
