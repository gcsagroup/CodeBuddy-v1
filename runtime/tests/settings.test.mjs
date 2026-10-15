import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { RuntimeSettings, validatePreference } from '../settings.mjs';
import { zGetConfigExtensionsResponse_unstable, zCodeProModelRoutingReadResponse_unstable, zListPromptsResponse_unstable, zModelCapabilityResolveResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  let changed = 0;
  const settings = new RuntimeSettings(store, { changed: () => changed++, testExtension: async () => { throw Error('Fixture MCP unavailable'); } });
  return { dir, store, settings, changed: () => changed };
}
test('extension settings survive restart, protect MCP credentials and update atomically', async t => {
  const f = await fixture(t);
  const extension = { type: 'mcp', description: '本机隔离 MCP 使用统计验收；繁體 🔑', server: { name: 'local_fixture', type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: [{ name: 'Authorization', value: 'Bearer fixture-sensitive-value' }] }, available_tools: ['read'] };
  await f.settings.request('config/extensions/add', { extension, enabled: false });
  await f.settings.request('config/extensions/set-enabled', { configKey: 'local_fixture', enabled: true });
  assert.ok(!(await readFile(path.join(f.dir, 'state.json'), 'utf8')).includes('fixture-sensitive-value'));
  const reopened = new RuntimeSettings(await openStore(f.dir));
  const result = await reopened.request('config/extensions/list', {});
  zGetConfigExtensionsResponse_unstable.parse(result);
  assert.deepEqual(result.extensions[0].extension, extension);
  assert.equal(result.extensions[0].extension.server.headers[0].value, 'Bearer fixture-sensitive-value');
  assert.equal(result.extensions[0].enabled, true);
  await assert.rejects(() => reopened.request('config/extensions/update', { configKey: 'missing', extension }), /removed/);
  await reopened.request('config/extensions/remove', { configKey: 'local_fixture' });
  assert.deepEqual((await reopened.extensions()), []);
});
test('MCP test reports connection errors and does not persist a successful configuration', async t => {
  const { settings, store } = await fixture(t);
  const result = await settings.request('config/extensions/test', { extension: { type: 'builtin', name: 'developer' } });
  assert.equal(result.success, false); assert.match(result.error, /unavailable/); assert.equal(store.read().extensions.length, 0);
});
test('routing requires real configured models and preserves disabled combinations', async t => {
  const { settings, store } = await fixture(t);
  await store.update(s => s.providers.push({ id: 'fixture', models: ['model'], requiresAuth: false }));
  const config = { version: 1, advancedRoutingEnabled: true, routes: ['main', 'planner', 'coder', 'tester', 'reviewer'].map(role => ({ role, providerId: 'fixture', modelId: 'model' })), visionRoute: { enabled: false, mode: 'disabled' }, maxParallelCoders: 2 };
  await settings.request('codepro/model-routing/save', { config });
  const saved = await settings.request('codepro/model-routing/read', {}); zCodeProModelRoutingReadResponse_unstable.parse(saved);
  const invalid = structuredClone(config); invalid.routes[0].modelId = 'unavailable';
  await assert.rejects(() => settings.request('codepro/model-routing/save', { config: invalid }), /selected role model/);
  assert.deepEqual((await settings.request('codepro/model-routing/read', {})).config, config);
  invalid.advancedRoutingEnabled = false;
  await settings.request('codepro/model-routing/save', { config: invalid });
  assert.equal((await settings.request('codepro/model-routing/read', {})).config.routes[0].modelId, 'unavailable');
});
test('prompt settings, explicit model capabilities and usage receipts use original SDK shapes', async t => {
  const { settings } = await fixture(t);
  await settings.request('config/prompts/save', { name: 'system', content: 'fixture instructions' });
  zListPromptsResponse_unstable.parse(await settings.request('config/prompts/list', {}));
  assert.equal((await settings.request('config/prompts/get', { name: 'system' })).content, 'fixture instructions');
  await settings.request('config/prompts/reset', { name: 'system' });
  assert.equal((await settings.request('config/prompts/get', { name: 'system' })).isCustomized, false);
  await settings.request('model-capabilities/save', { config: { version: 1, overrides: [{ providerId: 'p', modelId: 'm', imageInput: 'force_unsupported' }] } });
  const resolution = await settings.request('model-capabilities/resolve', { providerId: 'p', modelId: 'm' });
  zModelCapabilityResolveResponse_unstable.parse(resolution); assert.equal(resolution.imageInput, 'unsupported');
  const receipt = { eventId: 'event1', kind: 'external', capabilityId: 'fixture', recentResult: 'done' };
  assert.equal((await settings.request('capability-usage/record-success', receipt)).recorded, true);
  assert.equal((await settings.request('capability-usage/record-success', receipt)).recorded, false);
  assert.equal((await settings.request('capability-usage/list', {})).records[0].successCount, 1);
});
test('invalid runtime preferences are rejected before saving', () => {
  for (const [key, value] of [['gooseMaxTurns', 0], ['autoCompactThreshold', 3], ['personalizedMemoryEnabled', 'yes'], ['gooseMode', 'anything']]) assert.throws(() => validatePreference(key, value));
  validatePreference('gooseMaxTurns', 1000); validatePreference('autoCompactThreshold', 0.8);
});
