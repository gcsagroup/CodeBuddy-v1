import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';

test('compaction model config is atomic, defaults to following, persists and rejects unavailable or secret selections', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'compaction-model-settings-')));
  const store = await openStore(root);
  await store.update(state => { state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', requiresAuth: false, models: ['summary'] }]; });
  const host = new Compat(store, { close: async () => {}, listTools: async () => [] });
  await host.initialize();
  t.after(() => host.close());
  const request = (method, params) => host.request('_goose/unstable/' + method, params, { sessionIds: new Set() });
  const save = (value, isSecret = false) => request('config/upsert', { key: 'compactionModel', value, isSecret });
  const session = { id: 'settings-session', cwd: root, type: 'code_pro' };
  assert.equal((await host.sessionOptions(session)).compactionModel, null);
  const choice = { providerId: 'fixture', modelId: 'summary' };
  await save(choice);
  assert.deepEqual((await openStore(root)).read(['config']).config.compactionModel.value, choice);
  const options = await host.sessionOptions(session);
  assert.equal(options.compactionModel.provider.id, 'fixture');
  assert.equal(options.compactionModel.model, 'summary');
  for (const value of [{ providerId: 'missing', modelId: 'summary' }, { ...choice, modelId: 'missing' }, { providerId: 'fixture' }, { ...choice, apiKey: 'forbidden' }]) {
    await assert.rejects(save(value));
    assert.deepEqual((await request('config/read', { key: 'compactionModel' })).value, choice);
  }
  await assert.rejects(save(choice, true));
  await store.update(state => { state.sessions.push({ id: 'active-summary', cwd: root, type: 'code_pro', providerId: 'main' }); });
  host.active.set('active-summary', {});
  host.routing.set('active-summary', { compaction: options.compactionModel });
  try {
    assert.throws(() => host.checkProviderMutation('fixture'), /Stop active sessions/);
    await save(null);
    assert.throws(() => host.checkProviderMutation('fixture'), /Stop active sessions/, 'changing future settings must not remove the active request snapshot protection');
  } finally { host.active.delete('active-summary'); }
  await save(choice);
  await store.update(state => { state.providers = []; });
  assert.match((await host.sessionOptions(session)).compactionModel.error, /unavailable/);
  await save(null);
  assert.equal((await host.sessionOptions(session)).compactionModel, null);
});
