import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { RuntimeSettings, validatePreference } from '../settings.mjs';
import { driverProvider } from '../providers.mjs';
import { zGetConfigExtensionsResponse_unstable, zCodeProModelRoutingReadResponse_unstable, zListPromptsResponse_unstable, zModelCapabilityResolveResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  let changed = 0;
  const settings = new RuntimeSettings(store, { changed: () => changed++, testExtension: async () => { throw Error('Fixture MCP unavailable'); } });
  return { dir, store, settings, changed: () => changed };
}

test('per-model context capacity persists, clears, validates atomically and is not shared across models', async t => {
  const f = await fixture(t);
  await f.store.update(s => s.providers.push({ id:'capacity', engine:'openai_compatible', apiUrl:'http://127.0.0.1:1', models:['one','two'], requiresAuth:false }));
  const save = fields => f.settings.request('providers/config/save', { providerId:'capacity', fields });
  await save([{ key:'contextWindow:one', value:'131072' }]);
  const p=f.store.read().providers[0];
  assert.equal((await driverProvider(p,'one')).contextWindow,131072);
  assert.equal((await driverProvider(p,'one')).contextSource,'configured');
  assert.equal((await driverProvider(p,'two')).contextSource,'fallback');
  await assert.rejects(save([{key:'contextWindow:one',value:'1'},{key:'contextWindow:two',value:'65536'}]), /capacity/);
  assert.deepEqual(f.store.read().providers[0].contextWindows,{one:131072});
  await f.store.flush();
  const reopened=new RuntimeSettings(await openStore(f.dir));
  const fields=(await reopened.request('providers/config/read',{providerId:'capacity'})).fields;
  assert.equal(JSON.parse(fields.find(x=>x.key==='contextWindow:one').value).configured,131072);
  await reopened.request('providers/config/save',{providerId:'capacity',fields:[],clearFields:['contextWindow:one']});
  assert.equal((await driverProvider(f.store.read().providers[0],'two')).contextSource,'fallback');
  assert.equal(JSON.parse((await reopened.request('providers/config/read',{providerId:'capacity'})).fields.find(x=>x.key==='contextWindow:one').value).contextSource,'fallback');
});
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

test('extension reads reuse the current decoded definition and invalidate on setting changes', async t => {
  const {store}=await fixture(t);
  await store.update(s=>{s.extensions=[{configKey:'fixture',enabled:true,protected:{kind:'fixture',ciphertext:'sealed'}}];});
  let decryptions=0;
  const settings=new RuntimeSettings(store,{reveal:async()=>{decryptions++;return JSON.stringify({type:'mcp',server:{name:'fixture',url:'http://127.0.0.1/mcp',headers:{fixture:'secret'}}});}});
  const [list,snapshot]=await Promise.all([settings.extensions(),settings.extensionSnapshot()]);
  list[0].extension.server.headers.fixture='mutated';
  assert.equal(snapshot.entries[0].extension.server.headers.fixture,'secret');
  assert.equal((await settings.extensions())[0].extension.server.headers.fixture,'secret');
  assert.equal(decryptions,1);
  await settings.request('config/extensions/set-enabled',{configKey:'fixture',enabled:false});
  assert.throws(()=>snapshot.assertCurrent(),/changed/);
  assert.equal((await settings.extensionSnapshot()).entries.length,0);
  await settings.extensions();
  assert.equal(decryptions,2);
});
