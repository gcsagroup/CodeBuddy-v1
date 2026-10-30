import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'codebuddy-session-read-'));
  const store = await openStore(directory);
  await store.update(state => { state.sessions = [{ id: 'product', nativeSessionId: 'root', updates: [{ text: 'PRIVATE_PARENT_HISTORY' }] }]; });
  const reads = [];
  const observed = { ...store, readSession(...args) {
    const value = store.readSession(...args);
    reads.push(value);
    return value;
  } };
  const catalogs = new Map([
    ['root', [{ id: 'child', mode: 'continuable', createdAt: 1, label: 'Review' }]],
    ['child', [{ id: 'grandchild', mode: 'continuable', createdAt: 2, label: 'Nested' }]],
  ]);
  const raw = {
    async listSubagentChildren(id) { return catalogs.get(id) ?? []; },
    async history(id) { return { meta: { id, origin: 'subagent', parentSession: id === 'child' ? 'root' : 'child' },
      inheritedEventCount: 0, events: [{ seq: 0, time: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }] }; },
    async createSession() { assert.fail('Inspection must not activate an agent'); },
    async prompt() { assert.fail('Inspection must not request a model'); },
  };
  const driver = createConversationDriver(raw, observed);
  const compat = new Compat(observed, driver);
  const request = (name, extra = {}) => compat.request(`_goose/unstable/subagent/${name}`, { sessionId: 'product', ancestorSessionIds: [], ...extra });
  return { directory, store, raw, driver, compat, reads, request };
}

test('catalog and nested child pages inspect current identities without copying parent transcript payloads', async t => {
  const f = await fixture();
  const file = path.join(f.directory, 'state.json'), before = await readFile(file, 'utf8');
  const clone = globalThis.structuredClone;
  let transcriptCopies = 0;
  const spy = t.mock.method(globalThis, 'structuredClone', (value, options) => {
    if (value && Object.hasOwn(value, 'updates')) transcriptCopies++;
    return clone(value, options);
  });
  assert.equal((await f.request('catalog/list')).children[0].id, 'child');
  const direct = await f.request('conversation/get', { childSessionId: 'child' });
  const nested = await f.request('conversation/get', { childSessionId: 'grandchild', ancestorSessionIds: ['child'] });
  assert.deepEqual(direct.events[0].data.reason, { kind: 'completed' });
  assert.deepEqual(nested.events, direct.events);
  assert.ok(f.reads.length > 0);
  assert.equal(f.reads.filter(value => value && Object.hasOwn(value, 'updates')).length, 0,
    'Readonly child inspection must not deep-copy opaque parent history for identity checks');
  assert.equal(transcriptCopies, 0, 'Selecting fields after a full clone would still block the model stream');
  spy.mock.restore();
  assert.equal(await readFile(file, 'utf8'), before, 'Viewing child records must not write product state');
  assert.deepEqual(f.store.readSession('product').updates, [{ text: 'PRIVATE_PARENT_HISTORY' }], 'Default history reads remain complete');
  await assert.rejects(f.request('conversation/get', { childSessionId: 'foreign' }), /does not belong/);
  await assert.rejects(f.request('catalog/list', { sessionId: 'missing' }), /Session not found/);
});

test('projected root checks still reject committed rebinding or mapped-parent deletion during a native await', async () => {
  for (const remove of [false, true]) {
    const f = await fixture();
    const list = f.raw.listSubagentChildren;
    f.raw.listSubagentChildren = async id => {
      const result = await list(id);
      await f.store.update(state => {
        if (remove) state.sessions = [];
        else state.sessions[0].nativeSessionId = 'replacement';
      });
      return result;
    };
    await assert.rejects(f.request('catalog/list'), /changed during inspection/);
    assert.equal(f.driver.nativeSessionId('product'), remove ? 'product' : 'replacement');
    assert.equal(f.driver.nativeSessionId('native-only'), 'native-only', 'Native IDs and new sessions keep their existing fallback');
    if (remove) await assert.rejects(f.request('catalog/list'), /Session not found/);
  }
});

test('schedule catalog maps identities once without cloning histories and observes committed rebinding', async t => {
  const f = await fixture();
  const file = path.join(f.directory, 'state.json');
  const before = await readFile(file, 'utf8');
  const raw = { async nativeScheduleRequest() {
    return { records: Array.from({ length: 12 }, (_, index) => ({ id: `task-${index}`, sessionId: index === 11 ? 'native-only' : 'root' })) };
  } };
  const driver = createConversationDriver(raw, f.store);
  const clone = globalThis.structuredClone;
  const snapshots = [];
  const spy = t.mock.method(globalThis, 'structuredClone', (value, options) => {
    if (Array.isArray(value?.sessions)) snapshots.push(value.sessions);
    return clone(value, options);
  });
  const result = await driver.nativeScheduleRequest('catalog');
  assert.equal(snapshots.length, 1, 'A task list must not copy the session catalog once per task');
  assert.ok(snapshots[0].every(session => !Object.hasOwn(session, 'updates')),
    'Identity lookup must select metadata before deep cloning');
  assert.deepEqual(result.records.map(row => row.sessionId), [...Array(11).fill('product'), 'native-only']);
  spy.mock.restore();
  assert.equal(await readFile(file, 'utf8'), before, 'Reading the task list must not mutate persisted state');
  await f.store.update(state => { state.sessions[0].nativeSessionId = 'replacement'; });
  assert.equal((await driver.nativeScheduleRequest('catalog')).records[0].sessionId, 'root',
    'Do not reuse a stale identity cache after a conversation is rebound');
});
