import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { SessionDeletionCleanup } from '../session-deletion-cleanup.mjs';
import { Compat } from '../compat.mjs';

async function fixture(options) {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-async-delete-'));
  const store = await openStore(root, options);
  await store.update(state => {
    state.sessions = [
      { id: 'large', nativeSessionId: 'native-large', cwd: root, title: 'Large', updates: [{ text: 'actual transcript payload\n'.repeat(350000) }] },
      { id: 'keep', cwd: root, title: 'Keep', updates: [{ text: 'Retained history' }] },
    ];
  });
  return { root, store };
}

test('durable acceptance bypasses an unrelated blocked state write and survives its late commit and restart', { timeout: 15000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let block = false;
  const { root, store } = await fixture({ replaceFile: async (from, to) => {
    if (block) { entered.resolve(); await release.promise; }
    return rename(from, to);
  } });
  t.after(() => release.resolve());
  block = true;
  const writing = store.update(state => { state.preferences.survivor = true; });
  await entered.promise;
  const savedBytes = (await readFile(path.join(root, 'state.json'))).length;
  const record = await store.acceptSessionDeletion('large');
  assert.equal(record.nativeSessionId, 'native-large');
  assert.equal(store.readSession('large'), undefined);
  assert.deepEqual(store.read(['sessions']).sessions.map(s => s.id), ['keep']);
  assert.equal(store.read().sessions.length, 1);
  const journalFiles = await readdir(path.join(root, 'session-deletions'));
  assert.equal(journalFiles.length, 1);
  assert.ok((await readFile(path.join(root, 'session-deletions', journalFiles[0]))).length < 512);
  assert.ok(savedBytes > 8_000_000);
  assert.equal((await openStore(root)).readSession('large'), undefined, 'crash before the old snapshot settles');
  release.resolve(); await writing;
  assert.equal((await openStore(root)).readSession('large'), undefined, 'late old snapshot cannot revive deletion');
  await assert.rejects(store.updateSession('large', s => { s.title = 'resurrect'; }), /missing/);
  await store.finishSessionDeletion('large');
  assert.deepEqual(store.pendingSessionDeletions(), []);
  const reopened = await openStore(root);
  assert.equal(reopened.readSession('large'), undefined);
  assert.equal(reopened.readSession('keep').updates[0].text, 'Retained history');
  assert.equal(reopened.read(['preferences']).preferences.survivor, true);
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).sessions.length, 1);
});

test('failed tombstone persistence leaves the session visible and never reports acceptance', async () => {
  const failure = Object.assign(new Error('disk denied'), { code: 'EACCES' });
  const { root, store } = await fixture({ replaceDeletionFile: async () => { throw failure; } });
  await assert.rejects(store.acceptSessionDeletion('large'), error => error === failure);
  assert.ok(store.readSession('large'));
  assert.deepEqual(store.pendingSessionDeletions(), []);
  assert.ok((await openStore(root)).readSession('large'));
  assert.deepEqual(await readdir(path.join(root, 'session-deletions')), []);
});

test('duplicate acceptance is idempotent and unrelated snapshots cannot expose a deleted session', async () => {
  const { root, store } = await fixture();
  const [a, b] = await Promise.all([store.acceptSessionDeletion('large'), store.acceptSessionDeletion('large')]);
  assert.deepEqual(a, b);
  await store.update(s => { s.preferences.saved = 'yes'; }, ['preferences']);
  const raw = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
  assert.deepEqual(raw.sessions.map(s => s.id), ['keep']);
  await assert.rejects(store.insertSession(() => ({ id: 'large' })), /unique/);
});

test('cleanup failure retains the tombstone, then restart resumes and removes it only after durable cleanup', async () => {
  const { root, store } = await fixture();
  await store.acceptSessionDeletion('large');
  const failures = [];
  const worker = new SessionDeletionCleanup(store, async () => { throw new Error('fixture cleanup offline'); }, {
    onError: (id, error) => failures.push([id, error.message]),
  });
  worker.resume(); await worker.settle('large'); await worker.close();
  assert.deepEqual(failures, [['large', 'fixture cleanup offline']]);
  const restarted = await openStore(root), cleaned = [];
  assert.equal(restarted.readSession('large'), undefined);
  const resumed = new SessionDeletionCleanup(restarted, async record => cleaned.push(record.nativeSessionId));
  resumed.resume(); await resumed.settle('large'); await resumed.close();
  assert.deepEqual(cleaned, ['native-large']);
  assert.deepEqual(restarted.pendingSessionDeletions(), []);
  assert.equal((await openStore(root)).readSession('large'), undefined);
});

test('failed full-snapshot cleanup remains hidden and retries without requiring another delete request', async t => {
  let deny = false;
  const { root, store } = await fixture({ replaceFile: async (from, to) => {
    if (deny) throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' });
    return rename(from, to);
  } });
  await store.acceptSessionDeletion('large'); deny = true;
  const failed = Promise.withResolvers(), retried = Promise.withResolvers(), allowRetry = Promise.withResolvers();
  let attempts = 0;
  const worker = new SessionDeletionCleanup(store, async () => { if (++attempts > 1) { retried.resolve(); await allowRetry.promise; } }, {
    retryMs: 10, onError: () => failed.resolve(),
  });
  t.after(async () => { allowRetry.resolve(); await worker.close(); });
  worker.resume(); await failed.promise;
  assert.equal(store.readSession('large'), undefined);
  assert.equal((await openStore(root)).pendingSessionDeletions().length, 1);
  deny = false;
  // The production retry timer is unref'd; a bounded test timer keeps the test alive.
  await Promise.race([retried.promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('cleanup did not retry')), 3000);
    retried.promise.then(() => clearTimeout(timer));
  })]);
  allowRetry.resolve();
  await worker.settle('large');
  assert.deepEqual(store.pendingSessionDeletions(), []);
});

test('a malformed durable deletion record fails closed instead of reviving history', async () => {
  const { root, store } = await fixture();
  await store.acceptSessionDeletion('large');
  const [name] = await readdir(path.join(root, 'session-deletions'));
  await writeFile(path.join(root, 'session-deletions', name), '{}');
  await assert.rejects(openStore(root), /Invalid session deletion record/);
});

test('Compat acknowledges a large deletion before blocked resource cleanup, rejects reuse and keeps workspace files', async t => {
  const { root, store } = await fixture();
  const keepFile = path.join(root, 'user-work.txt'); await writeFile(keepFile, 'keep this');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let checks = 0;
  const driver = {
    async assertNativeSessionIdle(id) { assert.equal(id, 'native-large'); checks++; },
    async withConversationLock(_id, action) { return action(); },
    async releaseNativeSessionCapabilities(id) { assert.equal(id, 'native-large'); entered.resolve(); await release.promise; },
  };
  const compat = new Compat(store, driver);
  t.after(async () => { release.resolve(); await compat.sessionDeletions.close(); });
  await compat.request('session/delete', { sessionId: 'large' });
  assert.equal(checks, 1);
  assert.equal(store.readSession('large'), undefined);
  assert.throws(() => compat.assertSessionAvailable('large'), /not found/);
  await entered.promise;
  await compat.request('session/delete', { sessionId: 'large' });
  assert.equal(checks, 1, 'duplicate request does not rerun admission');
  assert.equal(store.pendingSessionDeletions().length, 1);
  release.resolve(); await compat.sessionDeletions.settle('large');
  assert.deepEqual(store.pendingSessionDeletions(), []);
  assert.equal(await readFile(keepFile, 'utf8'), 'keep this');
});

test('running tasks fail admission before any deletion record is written', async () => {
  const { store } = await fixture();
  const compat = new Compat(store, {
    async withConversationLock(_id, action) { return action(); },
    assertNativeSessionIdle() { throw new Error('active background jobs'); },
  });
  await assert.rejects(compat.request('session/delete', { sessionId: 'large' }), /active background jobs/);
  assert.ok(store.readSession('large'));
  assert.deepEqual(store.pendingSessionDeletions(), []);
});
