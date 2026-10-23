import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';

test('single-session snapshots stay detached and observe only committed changes and deletion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-session-snapshot-'));
  const store = await openStore(root);
  await store.update(s => { s.sessions = [{ id: 'current', updates: [{ text: 'saved' }] }, { id: 'other', updates: [{ text: 'unrelated' }] }]; });
  const snapshot = store.readSession('current');
  snapshot.updates[0].text = 'outside mutation';
  assert.equal(store.readSession('current').updates[0].text, 'saved');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const write = store.update(async s => { s.sessions[0].updates[0].text = 'committed'; entered.resolve(); await release.promise; });
  await entered.promise;
  assert.equal(store.readSession('current').updates[0].text, 'saved');
  release.resolve(); await write;
  assert.equal(store.readSession('current').updates[0].text, 'committed');
  await store.update(s => { s.sessions = s.sessions.filter(row => row.id !== 'current'); });
  assert.equal(store.readSession('current'), undefined);
  assert.equal(store.readSession('other').updates[0].text, 'unrelated');
});

test('configuration snapshots exclude histories, remain detached and publish only committed updates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-store-projection-'));
  const store = await openStore(root);
  await store.update(s => {
    s.preferences = { gooseThinkingEffort: 'high' };
    s.sessions = Array.from({length: 650}, (_, i) => ({id: String(i), updates: [{text: 'history '.repeat(200)}]}));
  });
  const snapshot = store.read(['preferences', 'revision']);
  assert.deepEqual(Object.keys(snapshot), ['preferences', 'revision']);
  snapshot.preferences.gooseThinkingEffort = 'low';
  assert.equal(store.read(['preferences']).preferences.gooseThinkingEffort, 'high');
  let release, entered;
  const gate = new Promise(r => {release = r;});
  const ready = new Promise(r => {entered = r;});
  const pending = store.update(async s => {s.preferences.gooseThinkingEffort = 'medium'; entered(); await gate;});
  await ready;
  assert.equal(store.read(['preferences']).preferences.gooseThinkingEffort, 'high');
  release(); await pending;
  assert.equal(store.read(['preferences']).preferences.gooseThinkingEffort, 'medium');
  assert.equal(store.read().sessions.length, 650);
});

test('scoped ledger and full history writes remain serialized, detached and durable together', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-store-scoped-'));
  const store = await openStore(root);
  await store.update(s => { s.sessions = [{id: 'chat', updates: ['saved']}]; s.codeproRuns = [{id: 'run', events: ['created']}]; });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const roots = ['codeproRuns'];
  const ledger = store.update(async draft => {
    assert.deepEqual(Object.keys(draft), ['codeproRuns'], 'ledger writer has no historical transcript reference');
    draft.codeproRuns[0].events.push('stopped');
    entered.resolve(); await release.promise;
  }, roots);
  roots.push('sessions');
  await entered.promise;
  assert.deepEqual(store.read(['codeproRuns']).codeproRuns[0].events, ['created']);
  const history = store.update(s => {
    assert.deepEqual(s.codeproRuns[0].events, ['created', 'stopped']);
    s.sessions[0].updates.push('next');
  });
  release.resolve(); await Promise.all([ledger, history]);
  const restored = await openStore(root);
  assert.deepEqual(restored.readSession('chat').updates, ['saved', 'next']);
  assert.deepEqual(restored.read(['codeproRuns']).codeproRuns[0].events, ['created', 'stopped']);
});

test('failed scoped mutations never publish partial ledger changes or modify unrelated roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-store-scoped-failure-'));
  const store = await openStore(root);
  await store.update(s => { s.sessions = [{id: 'chat', updates: ['saved']}]; s.codeproRuns = []; });
  await assert.rejects(store.update(s => { s.codeproRuns.push('uncommitted'); s.sessions = []; }, ['codeproRuns']), TypeError);
  await assert.rejects(store.update(s => { s.codeproRuns.push('uncommitted'); throw Error('mutation fixture'); }, ['codeproRuns']), /mutation fixture/);
  assert.deepEqual(store.read(['codeproRuns']).codeproRuns, []);
  assert.deepEqual((await openStore(root)).readSession('chat').updates, ['saved']);
  await store.update(s => { s.codeproRuns.push('committed'); }, ['codeproRuns']);
  assert.deepEqual((await openStore(root)).read(['codeproRuns']).codeproRuns, ['committed']);
});

test('a transient Windows replace denial keeps the old snapshot until one atomic commit and preserves queued writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-store-retry-'));
  let denied = 0, updates = 0;
  const store = await openStore(root, { replaceFile: async (from, to) => {
    if (denied++ < 2) throw Object.assign(Error('Sharing violation fixture'), { code: 'EPERM' });
    return rename(from, to);
  } });
  const first = store.update(s => { updates++; s.revision = 1; });
  const second = store.update(s => { assert.equal(s.revision, 1); s.revision = 2; });
  assert.equal(store.read().revision, 0);
  await Promise.all([first, second]);
  assert.equal(updates, 1, 'Retries do not repeat the mutation or its side effects');
  assert.equal(store.read().revision, 2);
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'))).revision, 2);
  assert.deepEqual(await readdir(root), ['state.json']);
});

test('persistent replace failure remains an error without publishing a partial state or poisoning future updates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-store-failure-'));
  let deny = false, attempts = 0;
  const store = await openStore(root, { replaceFile: async (from, to) => {
    if (deny) { attempts++; throw Object.assign(Error('Persistent denial fixture'), { code: 'EACCES' }); }
    return rename(from, to);
  } });
  await store.update(s => { s.revision = 1; });
  deny = true;
  await assert.rejects(store.update(s => { s.revision = 2; }), { code: 'EACCES' });
  assert.equal(attempts, 7);
  assert.equal(store.read().revision, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'))).revision, 1);
  assert.deepEqual(await readdir(root), ['state.json']);
  deny = false; await store.update(s => { s.revision = 3; });
  assert.equal(store.read().revision, 3);
});

test('nontransient storage errors are surfaced immediately', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-store-space-'));
  let calls = 0;
  const store = await openStore(root, { replaceFile: async () => { calls++; throw Object.assign(Error('Disk full fixture'), { code: 'ENOSPC' }); } });
  await assert.rejects(store.update(s => { s.revision = 1; }), { code: 'ENOSPC' });
  assert.equal(calls, 1); assert.equal(store.read().revision, 0);
});

test('timing observer failures cannot roll back a committed write or mask a storage error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-store-timing-'));
  const observations = []; let deny = false;
  const store = await openStore(root, {
    replaceFile: async (from, to) => {
      if (deny) throw Object.assign(Error('Disk full fixture'), { code: 'ENOSPC' });
      return rename(from, to);
    },
    onTiming: measurement => { observations.push(measurement); throw Error('Observer fixture'); },
  });
  await store.update(s => { s.revision = 1; });
  deny = true;
  await assert.rejects(store.update(s => { s.revision = 2; }), { code: 'ENOSPC' });
  assert.equal(store.read().revision, 1);
  assert.deepEqual(observations.map(item => item.committed), [true, false]);
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'))).revision, 1);
});
