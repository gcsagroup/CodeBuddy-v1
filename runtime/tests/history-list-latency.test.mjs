import test from 'node:test';
import assert from 'node:assert/strict';
import {Compat} from '../compat.mjs';

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
