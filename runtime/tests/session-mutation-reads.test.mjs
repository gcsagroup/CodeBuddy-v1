import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';

test('role-picker refresh waits for an edit commit while executable and mutating requests remain rejected', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cb-edit-read-'));
  const store = await openStore(root);
  await store.update(s => s.sessions.push({ id: 'editing', title: 'old', type: 'user', cwd: root, updates: [], usageUpdates: [] }));
  const observed = [];
  const driver = { permissions: permissionDriver(), close: async () => {} };
  const host = new Compat(store, driver);
  // Isolate the read owner from the write-admission barrier under test.
  const dispatch = host.request.bind(host);
  host.request = (method, params, connection) => {
    if (method === '_codebuddy/agents/current' && !host.sessionMutations.has(params.sessionId)) {
      observed.push(host.session(params.sessionId).title);
      return Promise.resolve({ selection: { profile: null } });
    }
    return dispatch(method, params, connection);
  };
  const release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await host.close(); await rm(root, { recursive: true, force: true }); });
  const mutation = host.mutateSession('editing', async () => {
    await release.promise;
    await store.update(s => { s.sessions.find(s => s.id === 'editing').title = 'committed'; });
  });
  let settled = false;
  const read = host.request('_codebuddy/agents/current', { sessionId: 'editing' }).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(observed, []);
  for (const method of ['session/prompt', 'session/delete', '_goose/unstable/session/working_dir/update']) {
    await assert.rejects(host.request(method, { sessionId: 'editing', prompt: [{ type: 'text', text: 'do not execute' }] }), /Wait for the session change/);
  }
  release.resolve();
  await mutation;
  assert.equal((await read).selection.profile, null);
  assert.deepEqual(observed, ['committed']);
  assert.equal(host.sessionMutations.has('editing'), false);
});
