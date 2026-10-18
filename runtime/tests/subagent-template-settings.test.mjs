import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';

test('template config ACP validates atomically, persists selections and resolves only approved provider references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-template-settings-'));
  const store = await openStore(root);
  await store.update(state => { state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', requiresAuth: false, models: ['one'] }]; });
  const compat = new Compat(store, { close: async () => {}, listTools: async () => [] });
  await compat.initialize(); t.after(() => compat.close());
  const request = (method, params) => compat.request('_goose/unstable/' + method, params, { sessionIds: new Set() });
  const config = { version: 1, models: { explorer: { providerId: 'fixture', modelId: 'one' }, browser: null, generic: null } };
  await request('config/upsert', { key: 'subagentTemplates', value: config, isSecret: false });
  assert.deepEqual((await request('config/read', { key: 'subagentTemplates', isSecret: false })).value, config);
  assert.deepEqual((await openStore(root)).read(['config']).config.subagentTemplates.value, config);
  for (const value of [null, { version: 2, models: {} }, { version: 1, models: { reviewer: null } }, { version: 1, models: { explorer: { providerId: 'missing', modelId: 'x' } } }, { version: 1, models: { generic: { providerId: 'fixture', modelId: '' } } }]) {
    await assert.rejects(request('config/upsert', { key: 'subagentTemplates', value, isSecret: false }));
    assert.deepEqual(store.read(['config']).config.subagentTemplates.value, config);
  }
  await assert.rejects(request('config/upsert', { key: 'subagentTemplates', value: config, isSecret: true }));
  const session = { id: 'fixture-session', cwd: root, type: 'code_pro' };
  const options = await compat.sessionOptions(session);
  assert.equal(options.subagentModels.explorer.model, 'one');
  assert.equal(options.subagentModels.explorer.provider.id, 'fixture');
  assert.equal(options.subagentModels.browser, undefined);
  await request('model-capabilities/save', { config: { version: 1, overrides: [{ providerId: 'fixture', modelId: 'one', imageInput: 'force_supported' }] } });
  assert.deepEqual((await compat.sessionOptions(session)).subagentModels.explorer.provider.inputModalities, ['text', 'image']);
  await store.update(state => { state.providers = []; });
  const unavailable = await compat.sessionOptions(session);
  assert.match(unavailable.subagentModels.explorer.error, /unavailable/);
  assert.equal(unavailable.subagentModels.explorer.model, undefined, 'A missing connection must not silently select another model');
});
