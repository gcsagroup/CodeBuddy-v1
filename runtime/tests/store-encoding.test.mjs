import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';

async function assertDiskMatches(store, root) {
  const expected = JSON.stringify(store.read()) + '\n';
  assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), expected);
  assert.deepEqual((await openStore(root)).read(), JSON.parse(expected));
}

test('batched writes preserve UTF-8 history across small and oversized chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'store-encoding-batches-'));
  const store = await openStore(root);
  await store.update(state => {
    state.sessions = Array.from({ length: 600 }, (_, index) => ({
      id: String(index), updates: [{ text: '客户🙂'.repeat(256) }],
    }));
    state.sessions.splice(300, 0, { id: 'large', updates: [{ text: '大🙂'.repeat(200000) }] });
  });
  await store.update(state => { state.config.batch = true; }, ['config']);
  await store.updateSession('large', session => { session.updates.push({ text: '末尾' }); });
  await assertDiskMatches(store, root);
});

test('encoded snapshots retain exact JSON across scoped edits, deletion, new keys and full invalidation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'store-encoding-json-'));
  const store = await openStore(root);
  await store.update(s => {
    s.sessions = [{ id: 'fixture', updates: [{ text: '中文🙂\u0000\n"\\\ud800' }] }];
    s.codeproRuns = [{ events: ['initial'] }];
    s.removable = 'old';
  });
  await store.update(s => { s.codeproRuns[0].events.push('next'); }, ['codeproRuns']);
  await assertDiskMatches(store, root);
  const detached = store.read(['sessions']);
  detached.sessions[0].updates[0].text = 'must not escape a read snapshot';
  await store.update(s => { s.config.enabled = true; }, ['config']);
  await assertDiskMatches(store, root);
  await store.update(s => { delete s.removable; s['key:\n"'] = { text: 'new' }; }, ['removable', 'key:\n"']);
  await assertDiskMatches(store, root);
  await store.update(s => { s.sessions[0].updates.push({ text: 'new history after full write' }); });
  await store.update(s => { s.codeproRuns[0].events.push('after full write'); }, ['codeproRuns']);
  await assertDiskMatches(store, root);
});

test('failed serialization or replacement cannot poison bytes reused by later writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'store-encoding-failed-'));
  let deny = false;
  const store = await openStore(root, { replaceFile: (from, to) => {
    if (deny) throw Object.assign(Error('fixture failure'), { code: 'ENOSPC' });
    return rename(from, to);
  } });
  await store.update(s => { s.sessions = [{ id: 'fixture', updates: ['saved'] }]; s.codeproRuns = []; });
  await assert.rejects(store.update(s => { s.codeproRuns = [1n]; }, ['codeproRuns']), TypeError);
  deny = true;
  await assert.rejects(store.update(s => { s.sessions[0].updates.push('must not publish'); }, ['sessions']), { code: 'ENOSPC' });
  deny = false;
  await store.update(s => { s.config.afterFailure = true; }, ['config']);
  assert.deepEqual(store.readSession('fixture').updates, ['saved']);
  assert.deepEqual(store.read(['codeproRuns']).codeproRuns, []);
  await assertDiskMatches(store, root);
});

test('queued writes reuse only the preceding committed snapshot while readers remain detached', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'store-encoding-queue-'));
  const store = await openStore(root);
  await store.update(s => { s.sessions = [{ id: 'fixture', updates: ['initial'] }]; s.codeproRuns = []; });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const first = store.update(async s => { s.sessions[0].updates.push('first'); entered.resolve(); await release.promise; }, ['sessions']);
  await entered.promise;
  const second = store.update(s => { s.codeproRuns.push('second'); }, ['codeproRuns']);
  assert.deepEqual(store.readSession('fixture').updates, ['initial']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(store.readSession('fixture').updates, ['initial', 'first']);
  await assertDiskMatches(store, root);
});
