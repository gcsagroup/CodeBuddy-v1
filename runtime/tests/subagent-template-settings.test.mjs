import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';

test('template config ACP validates atomically, persists selections and resolves only approved provider references', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codebuddy-template-settings-')));
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

test('retired generic model choices no longer override new children and stale connections do not block settings', async t => {
  const store = await openStore(await mkdtemp(join(tmpdir(), 'codebuddy-retired-generic-')));
  const legacy = { version: 1, models: { generic: { providerId: 'removed', modelId: 'legacy-model' } } };
  await store.update(state => { state.config.subagentTemplates = { value: legacy }; });
  const compat = new Compat(store, { close: async () => {}, listTools: async () => [] });
  await compat.initialize(); t.after(() => compat.close());
  assert.deepEqual((await compat.sessionOptions({ id: 'fixture', cwd: store.directory })).subagentModels, {});
  await compat.request('_goose/unstable/config/upsert', { key: 'subagentTemplates', value: legacy, isSecret: false }, { sessionIds: new Set() });
  assert.equal(store.read(['config']).config.subagentTemplates.value.models.generic, null);
});

test('subagent limits persist without permissions or execution state and invalid edits are atomic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-subagent-limits-'));
  const store = await openStore(root);
  const compat = new Compat(store, { close: async () => {} });
  await compat.initialize(); t.after(() => compat.close());
  const request = (method, params) => compat.request('_goose/unstable/' + method, params, { sessionIds: new Set() });
  const read = () => request('config/read', { key: 'subagentLimits', isSecret: false });
  const save = value => request('config/upsert', { key: 'subagentLimits', value, isSecret: false });
  assert.deepEqual((await read()).value, { maxDepth: 1, maxActiveSubagents: 3 });
  const value = { maxDepth: 0, maxActiveSubagents: 4 };
  await save(value);
  assert.deepEqual((await openStore(root)).read(['config']).config.subagentLimits.value, value);
  for (const invalid of [null, {}, { ...value, maxDepth: -1 }, { ...value, maxDepth: .5 }, { ...value, maxActiveSubagents: 0 }, { ...value, maxActiveSubagents: Number.MAX_SAFE_INTEGER + 1 }, { ...value, permissions: 'full-access' }]) {
    await assert.rejects(save(invalid));
    assert.deepEqual((await read()).value, value);
  }
  await assert.rejects(request('config/upsert', { key: 'subagentLimits', value, isSecret: true }));
  await request('config/remove', { key: 'subagentLimits', isSecret: false });
  assert.deepEqual((await read()).value, { maxDepth: 1, maxActiveSubagents: 3 });
});

test('custom template edits validate atomically without storing execution state or granting permissions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-custom-templates-'));
  const store = await openStore(root);
  await store.update(state => { state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', requiresAuth: false }]; });
  const compat = new Compat(store, { close: async () => {}, listTools: async () => [] });
  await compat.initialize(); t.after(() => compat.close());
  const request = (method, params) => compat.request('_goose/unstable/' + method, params, { sessionIds: new Set() });
  const template = { id: 'reviewer', name: '代码审查', description: '需要独立审查时使用', prompt: '只审查并列出证据，示例 {{file}}。', model: null, tools: 'read-only' };
  const config = { version: 1, models: { explorer: null, browser: null, generic: null }, custom: [template] };
  const save = value => request('config/upsert', { key: 'subagentTemplates', value, isSecret: false });
  await save(config);
  assert.deepEqual((await openStore(root)).read(['config']).config.subagentTemplates.value, config);
  const session = { id: 'fixture-session', cwd: root, type: 'code_pro' };
  assert.deepEqual((await compat.sessionOptions(session)).subagentTemplates, [template]);
  for (const custom of [
    [template, template], [{ ...template, name: 'explorer' }], [{ ...template, prompt: '' }],
    [{ ...template, model: { providerId: 'missing', modelId: 'one' } }],
    [{ ...template, tools: ['mcp_*'] }], [{ ...template, tools: 'read' }],
    [{ ...template, permissions: 'full-access' }], [{ ...template, sessionId: 'another-chat' }],
    [{ ...template, prompt: 'x'.repeat(8001) }],
  ]) {
    await assert.rejects(save({ ...config, custom }));
    assert.deepEqual(store.read(['config']).config.subagentTemplates.value, config);
  }
  await save({ ...config, custom: [{ ...template, tools: 'none', model: { providerId: 'fixture', modelId: 'one' } }] });
  const selected = (await compat.sessionOptions(session)).subagentTemplates[0];
  assert.equal(selected.model.model, 'one');
  assert.equal(selected.tools, 'none', 'No tools is distinct from inheritance');
  await store.update(state => { state.providers = []; });
  assert.match((await compat.sessionOptions(session)).subagentTemplates[0].model.error, /unavailable/);
  await save({ ...config, custom: [] });
  assert.deepEqual((await compat.sessionOptions(session)).subagentTemplates, []);
});
