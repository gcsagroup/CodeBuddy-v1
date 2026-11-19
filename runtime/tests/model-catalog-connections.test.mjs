import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSettings } from '../settings.mjs';
import { driverProvider, invalidateModelMetadata } from '../providers.mjs';
import { catalogProviderForEndpoint, catalogModelId, catalogThinkingProfile } from '../harness/model-catalog.mjs';

test('official compatibility identities resolve provider catalogs without matching proxy names or arbitrary paths', () => {
  for (const [url, provider] of [
    ['https://api.openai.com/v1/', 'openai'],
    ['https://api.mistral.ai/v1/', 'mistral'],
    ['https://generativelanguage.googleapis.com/v1beta/', 'google'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'google'],
    ['https://generativelanguage.googleapis.com/v1/openai', 'google'],
  ]) assert.equal(catalogProviderForEndpoint(url), provider, url);
  for (const url of [
    'https://proxy.invalid/v1beta/openai',
    'https://generativelanguage.googleapis.com/proxy/v1beta/openai',
    'https://generativelanguage.googleapis.com.evil.invalid/v1beta/openai',
    'https://generativelanguage.googleapis.com:444/v1beta/openai',
    'https://generativelanguage.googleapis.com/v1beta/openai?proxy=true',
  ]) assert.equal(catalogProviderForEndpoint(url), undefined, url);
  assert.equal(catalogModelId('google', 'models/gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(catalogModelId('openai', 'models/gemini-3.5-flash-lite'), 'models/gemini-3.5-flash-lite');
  assert.deepEqual(catalogThinkingProfile('google', 'models/unannounced-model'), {});
});

test('resource-name inventories keep model-specific controls and capacity aligned with native request serialization', async t => {
  const calls = [];
  const ids = ['models/gemini-3.5-flash-lite', 'models/gemini-3.1-flash-lite-image', 'models/gemini-3.1-pro-preview'];
  const provider = { id: 'google-resource-models', engine: 'openai_compatible',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', requiresAuth: false,
    models: ids, thinkingEfforts: Object.fromEntries(ids.map(id => [id, 'high'])) };
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/openai/models');
    return Response.json({ data: ids.map(id => ({ id, object: 'model' })) });
  });
  invalidateModelMetadata(provider);
  const settings = new RuntimeSettings({ read: () => ({ providers: [provider], preferences: {} }) });
  const { stream } = await import('../harness/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js');
  const expected = [['minimal', 'low', 'medium', 'high'], ['minimal', 'high'], ['low', 'medium', 'high']];
  for (const index of [0, 1, 2, 0]) {
    const id = ids[index];
    const snapshot = await settings.request('model-settings/read', { providerId: provider.id, modelId: id });
    assert.deepEqual(snapshot.thinking.options, ['default', ...expected[index]]);
    assert.equal(snapshot.thinking.value, 'high');
    assert.equal(snapshot.contextSource, 'catalog');
    assert.equal(snapshot.contextWindow, index === 1 ? 65536 : 1048576);
    const route = await driverProvider(provider, id);
    assert.deepEqual(Object.keys(route.reasoningEfforts), expected[index]);
    let payload;
    await stream({ id, name: id, provider: 'fixture-google', api: 'openai-completions', baseUrl: route.baseUrl,
      compat: route.compat, reasoning: true, thinkingLevelMap: route.reasoningEfforts,
      input: ['text'], contextWindow: route.contextWindow, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] },
    { apiKey: 'fixture', reasoningEffort: 'high', onPayload: value => { payload = value; throw new Error('capture before network'); } }).result();
    assert.equal(payload.model, id, 'Catalog canonicalization must not rewrite the service model ID');
    assert.equal(payload.reasoning_effort, 'high');
    assert.equal(Object.hasOwn(payload, 'store'), false);
  }
  assert.equal(calls.length, 1, 'Switches reuse inventory and require no generation or remote catalog probes');
  assert.equal(Object.hasOwn(catalogThinkingProfile('google', 'models/gemini-2.5-pro').reasoningEfforts, 'off'), false);
});

test('explicit service capabilities override normalized catalogs and proxy resource names remain unknown', async t => {
  let declaration = { reasoning_efforts: ['low'] };
  const model = 'models/gemini-3.5-flash-lite';
  t.mock.method(globalThis, 'fetch', async url => new URL(url).pathname.endsWith('/models')
    ? Response.json({ data: [{ id: model, ...declaration }] }) : Response.json({}, { status: 404 }));
  const provider = { id: 'declared-google', engine: 'openai_compatible',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresAuth: false, models: [model] };
  for (const [declared, expected] of [[declaration, { low: 'low' }], [{ supports_reasoning: false }, false]]) {
    declaration = declared;
    invalidateModelMetadata(provider);
    assert.deepEqual((await driverProvider(provider, model)).reasoningEfforts, expected);
  }
  declaration = {};
  const proxy = { ...provider, id: 'proxy-google', apiUrl: 'https://proxy.invalid/v1' };
  invalidateModelMetadata(proxy);
  assert.equal((await driverProvider(proxy, model)).reasoningEfforts, undefined);
});
