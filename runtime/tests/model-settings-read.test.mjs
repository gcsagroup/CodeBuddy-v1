import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSettings } from '../settings.mjs';
import { thinkingProfile, driverProvider } from '../providers.mjs';
import { modelThinkingPreference, applyModelThinking } from '../model-settings.mjs';

test('model snapshot resolves only the selected model, refreshes explicitly and matches execution after stale preferences', async t => {
  const provider = { id: 'snapshot', engine: 'openai_compatible', apiUrl: 'http://snapshot.invalid', requiresAuth: false,
    models: ['A', 'B'], thinkingEfforts: { A: 'high', B: 'none' } };
  let reduced = false;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(new URL(url).pathname);
    assert.equal(new URL(url).pathname, '/v1/models');
    return Response.json({ data: [
      { id: 'A', reasoning_efforts: reduced ? ['low'] : ['low', 'high'] },
      { id: 'B', reasoning_efforts: ['none', 'medium'], default_reasoning_effort: 'medium' },
    ] });
  });
  const state = { providers: [provider], preferences: {} };
  const settings = new RuntimeSettings({ read: () => structuredClone(state) });
  const read = (modelId, refresh = false) => settings.request('model-settings/read', { providerId: provider.id, modelId, refresh });
  for (const modelId of ['A', 'B', 'A', 'B', 'A']) {
    const result = await read(modelId);
    assert.deepEqual(result.thinking.options, modelId === 'A' ? ['default', 'low', 'high'] : ['default', 'none', 'medium']);
    assert.equal(result.thinking.value, provider.thinkingEfforts[modelId]);
    const selected = applyModelThinking(await driverProvider(provider, modelId), modelThinkingPreference(thinkingProfile(provider, modelId), provider.thinkingEfforts[modelId]));
    assert.equal(selected.provider.reasoningEfforts[selected.thinkingEffort], provider.thinkingEfforts[modelId]);
  }
  assert.deepEqual(calls, ['/v1/models']);
  reduced = true;
  const refreshed = await read('A', true);
  assert.equal(refreshed.thinking.value, 'default');
  assert.equal(refreshed.thinking.stalePreference, true);
  const selected = applyModelThinking(await driverProvider(provider, 'A'), modelThinkingPreference(thinkingProfile(provider, 'A'), 'high'));
  assert.equal(selected.thinkingEffort, undefined);
  assert.equal(provider.thinkingEfforts.A, 'high', 'Reads do not migrate the stored preference');
  assert.equal(calls.length, 2);
});

test('unknown differs from unsupported and neither invents selectable effort levels', async t => {
  const provider = { id: 'unknown-state', engine: 'openai_compatible', apiUrl: 'http://unknown-state.invalid', requiresAuth: false, models: ['unknown', 'plain'] };
  t.mock.method(globalThis, 'fetch', async url => new URL(url).pathname === '/v1/models'
    ? Response.json({ data: [{ id: 'unknown' }, { id: 'plain', supports_reasoning: false }] })
    : Response.json({ paths: { '/v1/chat/completions': { post: { requestBody: { content: { 'application/json': { schema: { properties: { reasoning_effort: { enum: ['low', 'medium', 'high'] } } } } } } } } } }));
  const settings = new RuntimeSettings({ read: () => ({ providers: [provider], preferences: {} }) });
  for (const modelId of provider.models) {
    const { thinking } = await settings.request('model-settings/read', { providerId: provider.id, modelId });
    assert.deepEqual(thinking.options, modelId === 'plain' ? ['none'] : ['default']);
    assert.equal(thinking.value, modelId === 'plain' ? 'none' : 'default');
    assert.equal(thinking.state, modelId === 'plain' ? 'unsupported' : 'unknown');
  }
});

test('missing service defaults never choose Off or the lowest effort on model switch', async t => {
  const provider = { id: 'service-default', engine: 'openai_compatible', apiUrl: 'http://service-default.invalid', requiresAuth: false,
    models: ['declared', 'unspecified'], thinkingEfforts: {} };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [
    { id: 'declared', reasoning_efforts: ['none', 'low', 'high'], default_reasoning_effort: 'high' },
    { id: 'unspecified', reasoning_efforts: ['none', 'low', 'high'] },
  ] }));
  const settings = new RuntimeSettings({ read: () => ({ providers: [provider], preferences: {} }) });
  for (const modelId of ['declared', 'unspecified', 'declared']) {
    const { thinking } = await settings.request('model-settings/read', { providerId: provider.id, modelId });
    assert.equal(thinking.value, modelId === 'declared' ? 'high' : 'default');
    assert.deepEqual(thinking.options, ['default', 'none', 'low', 'high']);
  }
  assert.deepEqual(provider.thinkingEfforts, {}, 'Reading and switching never persists a preference');
});

test('off-capable model respects service defaults and keeps explicit levels isolated across models', async t => {
  const provider = { id: 'off-default', engine: 'openai_compatible', apiUrl: 'http://off-default.invalid', requiresAuth: false,
    models: ['graded', 'toggle', 'always'], thinkingEfforts: { graded: 'default', toggle: 'medium' } };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [
    { id: 'graded', reasoning_efforts: ['none', 'low', 'medium', 'high'], default_reasoning_effort: 'high' },
    { id: 'toggle', reasoning_efforts: ['none', 'medium'] },
    { id: 'always', reasoning_efforts: ['medium'] },
  ] }));
  const settings = new RuntimeSettings({ read: () => ({ providers: [provider], preferences: {} }) });
  for (const modelId of ['graded', 'toggle', 'always', 'graded']) {
    const { thinking } = await settings.request('model-settings/read', { providerId: provider.id, modelId });
    const profile = thinkingProfile(provider, modelId);
    const preference = modelThinkingPreference(profile, provider.thinkingEfforts[modelId]);
    const actual = applyModelThinking(await driverProvider(provider, modelId), preference);
    if (modelId === 'graded') {
      assert.deepEqual(thinking.options, ['default', 'none', 'low', 'medium', 'high']);
      assert.equal(thinking.value, 'default');
      assert.equal(actual.source, 'provider_default');
      assert.equal(modelThinkingPreference(profile, undefined), 'high');
      assert.equal(modelThinkingPreference(profile, 'max'), 'high');
    } else if (modelId === 'toggle') {
      assert.equal(thinking.value, 'medium');
      assert.equal(actual.provider.reasoningEfforts[actual.thinkingEffort], 'medium');
    } else assert.equal(thinking.options.includes('none'), false, 'Never fabricate an off control');
  }
  assert.equal(provider.thinkingEfforts.graded, 'default', 'Read-only resolution does not rewrite old records');
});
