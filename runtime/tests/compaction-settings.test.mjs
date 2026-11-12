import test from 'node:test';
import assert from 'node:assert/strict';
import defaults from '../default-model.json' with { type: 'json' };
import { resolveCompactionFallbacks, validateCompactionFallbacks } from '../compaction-settings.mjs';

test('deployment fallback selects only an existing LAN route for the actual current model without discovery', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('Fallback configuration must not contact the network'); });
  const providers = [
    { id: 'gemma', apiUrl: defaults.baseUrl, models: [defaults.modelId], requiresAuth: false },
    { id: 'qwen', apiUrl: defaults.compactionFallback.baseUrl, models: ['qwen3.8-flash-next-uncensored'], requiresAuth: false },
  ];
  const selected = { provider: { id: 'gemma', baseUrl: defaults.baseUrl, compat: { thinkingFormat: 'chat-template' } }, model: defaults.modelId };
  const rules = resolveCompactionFallbacks({}, providers, selected);
  assert.equal(rules.length, 1);
  assert.strictEqual(rules[0].source, selected, 'use the already admitted provider identity, including current thinking compatibility');
  assert.equal(typeof rules[0].resolveFallback, 'function');
  assert.equal(resolveCompactionFallbacks({}, providers, { ...selected, model: 'other-model' }).length, 0);
  assert.equal(resolveCompactionFallbacks({ compactionFallbacks: { value: [] } }, providers, selected).length, 0);
  assert.equal(resolveCompactionFallbacks({}, providers.slice(0, 1), selected).length, 0);
  assert.equal(resolveCompactionFallbacks({}, [...providers, { ...providers[1], id: 'ambiguous-qwen' }], selected).length, 0);
  assert.equal(resolveCompactionFallbacks({}, [providers[0], { ...providers[1], apiUrl: 'https://different.example' }], selected).length, 0);
});

test('explicit compaction routes reject missing connections and duplicate sources independently of property order', () => {
  const providers = [{ id: 'a', models: ['gemma'], requiresAuth: false }, { id: 'b', models: ['qwen'], requiresAuth: false }];
  const rule = { source: { providerId: 'a', modelId: 'gemma' }, fallback: { providerId: 'b', modelId: 'qwen' } };
  assert.deepEqual(validateCompactionFallbacks([rule], providers), [rule]);
  assert.throws(() => validateCompactionFallbacks([rule], providers.slice(0, 1)));
  assert.throws(() => validateCompactionFallbacks([rule, { ...rule, source: { modelId: 'gemma', providerId: 'a' } }], providers));
});
