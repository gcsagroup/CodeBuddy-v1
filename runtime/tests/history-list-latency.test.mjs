import test from 'node:test';
import assert from 'node:assert/strict';
import {Compat} from '../compat.mjs';
import {openStore} from '../store.mjs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('changing the default model preserves history and repeated selection skips the durable write', async () => {
  const timings = [];
  const directory = await mkdtemp(path.join(tmpdir(), 'codebuddy-default-selection-'));
  const store = await openStore(directory, { onTiming: event => timings.push(event) });
  const history = { id: 'existing', updates: [{ content: { type: 'text', text: 'saved history '.repeat(1000) } }] };
  await store.update(state => {
    state.providers = [{ id: 'p', models: ['a','b'], engine: 'openai_compatible', apiUrl: 'http://fixture.invalid', requiresAuth: false }];
    state.sessions.push(history);
  });
  const host = new Compat(store, {});
  timings.length = 0;
  for (const modelId of ['a','b','b']) await host.request('_goose/unstable/defaults/save', { providerId:'p', modelId });
  assert.deepEqual(timings.filter(e => e.operation === 'commit').map(e => [e.roots,e.committed]),
    [[['defaults'],true],[['defaults'],true],[['defaults'],false]]);
  const reloaded = await openStore(directory);
  assert.deepEqual(reloaded.readSession(history.id), history);
  assert.deepEqual(reloaded.read(['defaults']).defaults, { providerId:'p', modelId:'b' });
  await host.request('_goose/unstable/defaults/clear');
  assert.deepEqual(store.readSession(history.id), history);
  await store.updateSession(history.id, s => Object.assign(s, { providerId: 'p', modelId: 'a' }));
  timings.length = 0;
  const result = await host.request('session/set_config_option', { sessionId: history.id, configId: 'model', value: 'b' });
  assert.equal(result.configOptions.find(option => option.id === 'model').currentValue, 'b');
  const commits = timings.filter(e => e.operation === 'commit');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].session_id, history.id);
  assert.deepEqual(commits[0].roots, ['sessions']);
  assert.deepEqual((await openStore(directory)).readSession(history.id), { ...history, providerId: 'p', modelId: 'b' });
});

test('large migrated history lists from one snapshot and preserves latest run metadata', async () => {
  const state = {sessions: Array.from({length: 650}, (_, i) => ({
    id: `session-${i}`, cwd: 'D:\\fixture', title: `history ${i}`,
    type: 'code_pro', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
    updates: [{content: {type: 'text', text: 'history '.repeat(512)}}],
    readonlyHistory: i !== 0,
  })), codeproRuns: []};
  let reads = 0;
  const store = {read(){ reads++; return structuredClone(state); }, async update(fn){return fn(state);}};
  const compat = new Compat(store, {});
  await compat.runs.create({sessionId:'session-0',runId:'first',sourceMessageId:'u1',goal:'hello',executionOwner:'harness'});
  reads = 0;
  const listed = await compat.request('session/list');
  assert.equal(listed.sessions.length, 650);
  assert.equal(listed.sessions.find(s=>s.sessionId==='session-0')._meta.activeRunId,'first');
  assert.equal(listed.sessions.find(s=>s.sessionId==='session-1')._meta.activeRunId,undefined);
  assert.equal(listed.sessions.find(s=>s.sessionId==='session-1')._meta.userSetName,true);
  assert.equal(reads, 1, 'Sidebar refresh must not clone all histories once for each row');
  state.sessions[0].title = 'changed';
  const fresh = await compat.request('session/list',{_meta:{query:'changed',types:['code_pro']}});
  assert.deepEqual(fresh.sessions.map(s=>s.sessionId),['session-0']);
  assert.equal(fresh.sessions[0].title,'changed');
});

test('sidebar metadata excludes transcript payloads while body search, archive and scheduled origin still work', async () => {
  const store = await openStore(await mkdtemp(path.join(tmpdir(), 'codebuddy-history-metadata-')));
  const session = (id, extra = {}) => ({id, cwd:'D:\\fixture', title:id, type:'code_pro',
    createdAt:'2026-10-14T00:00:00Z', updatedAt:'2026-10-14T00:00:00Z',
    updates:[{content:{type:'text',text:'unique-in-body'}}], ...extra});
  await store.update(s => {
    s.sessions = [session('current'), session('imported', {readonlyHistory:true}),
      session('archived', {archivedAt:'2026-10-15T00:00:00Z'}), session('scheduled')];
    s.schedules = [{sessions:['scheduled']}];
  });
  const snapshots = [];
  const observed = {...store, read(keys, options) {const value=store.read(keys,options); snapshots.push(value); return value;},
    readSession(id, options) { const value=store.readSession(id,options); snapshots.push(value); return value; }};
  const compat = new Compat(observed, {});
  await compat.runs.create({sessionId:'current',runId:'run',sourceMessageId:'u',goal:'hello',executionOwner:'harness'});
  snapshots.length = 0;
  const listed = await compat.request('session/list');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].sessions.some(s => Object.hasOwn(s,'updates')), false);
  assert.equal(listed.sessions.some(s => s.sessionId==='archived'), false);
  assert.equal(listed.sessions.find(s => s.sessionId==='imported')._meta.userSetName, true);
  assert.equal(listed.sessions.find(s => s.sessionId==='scheduled')._meta.sessionType, 'scheduled');
  assert.equal(listed.sessions.find(s => s.sessionId==='current')._meta.activeRunId, 'run');
  snapshots.length = 0;
  const info = await compat.request('_goose/unstable/session/info', {sessionId:'current'});
  assert.deepEqual(info.session, listed.sessions.find(s => s.sessionId==='current'));
  assert.equal(Object.hasOwn(snapshots[0], 'updates'), false, 'opening metadata must not clone transcript chunks');
  const found = await compat.request('session/list', {_meta:{query:'unique-in-body',includeArchived:true,types:['code_pro']}});
  assert.equal(found.sessions.length, 4, 'explicit search still reads historical message bodies');
  assert.deepEqual((await compat.request('session/list',{cwd:'D:\\other'})).sessions, []);
});
