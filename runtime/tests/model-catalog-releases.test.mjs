import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSettings } from '../settings.mjs';
import { driverProvider, invalidateModelMetadata, thinkingProfile } from '../providers.mjs';
import { applyModelThinking, modelThinkingPreference } from '../model-settings.mjs';

const models = ['gpt-6.2-astra', 'gpt-6.2-sol'];

test('new official releases missing from the pinned SDK share supported efforts between display and execution', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? 'GET' });
    assert.equal(new URL(url).pathname, '/v1/models');
    return Response.json({ data: models.map(id => ({ id, object: 'model', owned_by: 'system' })) });
  });
  const provider = { id: 'new-official-release', engine: 'openai_compatible', apiUrl: 'https://api.openai.com', requiresAuth: false,
    models, thinkingEfforts: { 'gpt-6.2-astra': 'low', 'gpt-6.2-sol': 'max' } };
  invalidateModelMetadata(provider);
  const settings = new RuntimeSettings({ read: () => ({ providers: [provider], preferences: {} }) });
  for (const model of [...models, ...models]) {
    const result = await settings.request('model-settings/read', { providerId: provider.id, modelId: model });
    assert.deepEqual(result.thinking.options, ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(result.thinking.value, provider.thinkingEfforts[model]);
    assert.equal(result.contextWindow, 1_050_000);
    assert.equal(result.contextSource, 'catalog');
    const native = await driverProvider(provider, model);
    assert.equal(native.protocol, 'openai-responses');
    assert.equal(native.outputTokenCapacity, 128_000);
    const selected = applyModelThinking(native, modelThinkingPreference(thinkingProfile(provider, model), provider.thinkingEfforts[model]));
    assert.equal(selected.provider.reasoningEfforts[selected.thinkingEffort], provider.thinkingEfforts[model]);
    assert.throws(() => applyModelThinking(native, 'none'), /absent/);
    assert.throws(() => applyModelThinking(native, 'minimal'), /absent/);
  }
  assert.deepEqual(calls, [{ url: 'https://api.openai.com/v1/models', method: 'GET' }], 'No generation probes or repeated inventory reads on switches');
});

test('service declarations win and catalog supplements never infer capabilities from proxy names or future IDs', async t => {
  let declaration;
  t.mock.method(globalThis, 'fetch', async url => new URL(url).pathname.endsWith('/models')
    ? Response.json({ data: [{ id: models[0], ...declaration }, { id: 'gpt-6.3-astra' }] })
    : Response.json({}, { status: 404 }));
  for (const [apiUrl, model, expected] of [
    ['https://proxy.invalid', models[0], undefined],
    ['https://api.openai.com/proxy/v1', models[0], undefined],
    ['https://api.openai.com', 'gpt-6.3-astra', undefined],
  ]) {
    const provider = { id: apiUrl, displayName: 'OpenAI', engine: 'openai_compatible', apiUrl, requiresAuth: false, models: [model] };
    invalidateModelMetadata(provider);
    assert.equal((await driverProvider(provider, model)).reasoningEfforts, expected);
  }
  const official = { id: 'declared-release', engine: 'openai_compatible', apiUrl: 'https://api.openai.com', requiresAuth: false, models };
  declaration = { reasoning_efforts: ['low', 'high'] };
  invalidateModelMetadata(official);
  assert.deepEqual((await driverProvider(official, models[0])).reasoningEfforts, { low: 'low', high: 'high' });
  declaration = { supports_reasoning: false };
  invalidateModelMetadata(official);
  assert.equal((await driverProvider(official, models[0])).reasoningEfforts, false);
});
