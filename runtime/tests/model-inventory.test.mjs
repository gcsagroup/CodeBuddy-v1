import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { ModelInventory } from '../model-inventory.mjs';
import { driverProvider, discover, inventory } from '../providers.mjs';
import { Compat } from '../compat.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';

test('connection switch persists, preserves selections and prevents disabled network calls', async t => {
  const { dir, store, owner } = await fixture(t);
  const host = new Compat(store, { close: async () => {}, permissions: permissionDriver() });
  t.after(() => host.close());
  const request = (enabled) => host.request('_goose/unstable/providers/set-enabled', { providerId: 'p', enabled }, { notify() {} });
  await assert.rejects(request('false'), /boolean/);
  await request(false);
  const provider = store.read(['providers']).providers[0];
  assert.equal(inventory(provider).enabled, false);
  assert.equal((await openStore(dir)).read(['providers']).providers[0].enabled, false);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected network'); });
  await owner.startup();
  await assert.rejects(owner.refresh('p'), /disabled/);
  await assert.rejects(discover(provider, provider), /disabled/);
  await assert.rejects(driverProvider(provider, 'keep'), /disabled/);
  const refreshed = await host.request('_goose/unstable/providers/inventory/refresh', {}, { notify() {} });
  assert.deepEqual(refreshed.started, []);
  assert.equal(calls, 0);
  assert.equal(store.read(['defaults']).defaults.modelId, 'old');
  assert.equal(store.readSession('chat').modelId, 'old');
  await assert.rejects(host.sessionModel(store.readSession('chat')), error => error.data?.code === 'provider_disabled');
  await assert.rejects(host.request('_goose/unstable/defaults/save', { providerId: 'p', modelId: 'keep' }, { notify() {} }), error => error.data?.code === 'provider_disabled');
  await assert.rejects(host.request('session/set_config_option', { sessionId: 'chat', configId: 'provider_model', value: JSON.stringify({ providerId: 'p', modelId: 'keep' }) }, { notify() {} }), error => error.data?.code === 'provider_disabled');
  await request(true);
  assert.equal(store.read(['providers']).providers[0].enabled, true);
  host.active.set('chat', {});
  await assert.rejects(request(false), /Stop active sessions/);
  assert.equal(store.read(['providers']).providers[0].enabled, true);
  host.active.clear();
  // A chat may have switched providers while another task still uses this one.
  await store.updateSession('chat', saved => { saved.providerId = 'other'; });
  host.active.set('chat', {});
  host.routing.set('chat', { main: { provider: { id: 'p' } } });
  await assert.rejects(request(false), /Stop active sessions/);
  host.routing.set('chat', { roleModels: { reviewer: { provider: { id: 'p' } } } });
  await assert.rejects(request(false), /Stop active sessions/);
  host.active.clear(); host.routing.clear();
  host.reviewExecutions.set('review', 'p');
  await assert.rejects(request(false), /active review/);
  host.reviewExecutions.clear();
  await request(false);
  assert.equal(store.read(['providers']).providers[0].enabled, false);
});

test('pending refresh is visible and a late result cannot update a disabled connection', async t => {
  const { store, owner } = await fixture(t);
  const response = Promise.withResolvers(), started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', () => { started.resolve(); return response.promise; });
  const pending = owner.refresh('p'); await started.promise;
  assert.equal(owner.status()[0].loading, true);
  await store.update(state => { state.providers[0].enabled = false; });
  response.resolve(Response.json({ data: [{ id: 'new' }] }));
  await pending;
  assert.deepEqual(owner.status(), []);
  assert.deepEqual(store.read(['providers']).providers[0].models, ['old', 'keep']);
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codebuddy-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  const provider = { id: 'p', displayName: 'Test provider', apiUrl: `http://${path.basename(dir)}.invalid`, engine: 'openai_compatible', requiresAuth: false, models: ['old', 'keep'] };
  await store.update(s => { s.providers = [provider]; s.defaults = { providerId: 'p', modelId: 'old' }; s.sessions = [{ id: 'chat', providerId: 'p', modelId: 'old' }]; });
  return { dir, store, owner: new ModelInventory(store), provider };
}

test('refresh keeps safe transport diagnostics without leaking upstream text', async t => {
  const { owner, store } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error('private-key'), { cause: { code: 'ECONNREFUSED' } }); });
  await owner.startup();
  assert.equal(owner.status()[0].networkCode, 'ECONNREFUSED');
  assert.equal(owner.status()[0].errorCode, 'custom_provider_endpoint_unreachable');
  assert.equal(JSON.stringify(owner.status()).includes('private-key'), false);
  assert.deepEqual(store.read(['providers']).providers[0].models, ['old', 'keep']);
});

test('startup refreshes models, preserves selections and persists capability baseline across restarts', async t => {
  const { dir, store, owner } = await fixture(t);
  let context = 8192;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'keep', context_window: context, supports_reasoning: false }] }));
  await owner.startup();
  assert.deepEqual(store.read(['providers']).providers[0].models, ['keep']);
  assert.equal(store.read(['defaults']).defaults.modelId, 'old');
  assert.equal(store.readSession('chat').modelId, 'old');
  assert.deepEqual(owner.status()[0].changes, [{ kind: 'removed', model: 'old' }]);
  const firstNotice = owner.status()[0].noticeId;
  await owner.acknowledge('p', firstNotice);
  await owner.close();
  const nextStore = await openStore(dir), next = new ModelInventory(nextStore);
  context = 16384;
  await next.startup();
  assert.deepEqual(next.status()[0].changes, [{ kind: 'capabilities', model: 'keep', fields: ['context'] }]);
  await next.acknowledge('p', firstNotice);
  assert.equal(next.status().length, 1, 'stale acknowledgements cannot erase newer changes');
  const notice = next.status()[0].noticeId;
  const savedBytes = await readFile(path.join(dir, 'state.json'), 'utf8');
  await next.startup();
  assert.equal(next.status()[0].noticeId, notice, 'unchanged inventory does not duplicate notices');
  assert.equal(await readFile(path.join(dir, 'state.json'), 'utf8'), savedBytes, 'unchanged startup does not rewrite history');
  await next.acknowledge('p', notice);
  assert.deepEqual(next.status(), []);
});

test('valid empty inventory is removal, transport failure retains models and is not removal', async t => {
  const { store, owner } = await fixture(t);
  let offline = true;
  t.mock.method(globalThis, 'fetch', async () => offline ? new Response('', { status: 503 }) : Response.json({ data: [] }));
  await owner.startup();
  assert.deepEqual(store.read(['providers']).providers[0].models, ['old', 'keep']);
  assert.equal(owner.status()[0].failed, true);
  assert.equal(owner.status()[0].httpStatus, 503);
  assert.equal(owner.status()[0].errorCode, 'custom_provider_model_list_unavailable');
  assert.deepEqual(owner.status()[0].changes, []);
  offline = false;
  await owner.startup();
  assert.deepEqual(store.read(['providers']).providers[0].models, []);
  assert.equal(owner.status()[0].changes.length, 2);
  assert.equal(owner.status()[0].failed, undefined);
  assert.equal(store.read(['defaults']).defaults.modelId, 'old');
});

test('late discovery cannot overwrite edited connection or resurrect deleted provider', async t => {
  for (const deleted of [false, true]) {
    const { store, owner } = await fixture(t);
    const response = Promise.withResolvers();
    const started = Promise.withResolvers();
    t.mock.method(globalThis, 'fetch', () => { started.resolve(); return response.promise; });
    const refresh = owner.refresh('p'); await started.promise;
    await store.update(s => { if (deleted) s.providers = []; else s.providers[0].apiUrl = 'http://edited.invalid'; });
    response.resolve(Response.json({ data: [{ id: 'replacement' }] }));
    await refresh;
    assert.deepEqual(store.read(['providers']).providers.map(p => p.models), deleted ? [] : [['old', 'keep']]);
  }
});

test('an edited connection does not inherit the previous endpoint refresh failure', async t => {
  const { store, owner } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await owner.startup();
  assert.equal(owner.status()[0].failed, true);
  await store.update(s => { s.providers[0].apiUrl = 'http://replacement.invalid'; });
  assert.deepEqual(owner.status(), [], 'the new endpoint has not failed discovery');
  await owner.startup();
  assert.equal(owner.status()[0].failed, true, 'a failure from the replacement endpoint is still reported');
});

test('incomplete metadata does not claim lost capabilities and refresh failure does not erase a pending notice', async t => {
  const { store, owner } = await fixture(t);
  let data = [{ id: 'keep', context_window: 8192 }];
  let offline = false;
  t.mock.method(globalThis, 'fetch', async () => offline ? new Response('', { status: 401 }) : Response.json({ data }));
  await owner.startup();
  data = [{ id: 'keep' }]; await owner.startup();
  assert.equal(store.read(['providers']).providers[0].inventoryState.capabilities.keep.context, 8192);
  assert.deepEqual(owner.status()[0].changes, [{ kind: 'removed', model: 'old' }]);
  offline = true; await owner.startup();
  assert.equal(owner.status()[0].failed, true);
  assert.equal(owner.status()[0].changes.length, 1);
});

test('network consent blocks discovery; shutdown fences an admitted refresh', async t => {
  const { dir, store, owner } = await fixture(t);
  const old = process.env.CODEBUDDY_USER_DATA_DIR;
  process.env.CODEBUDDY_USER_DATA_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.CODEBUDDY_USER_DATA_DIR; else process.env.CODEBUDDY_USER_DATA_DIR = old; });
  let calls = 0;
  const response = Promise.withResolvers(), started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', () => { calls++; started.resolve(); return response.promise; });
  await owner.startup(); assert.equal(calls, 0);
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ networkAccessAllowed: true }));
  const refresh = owner.refresh('p'); await started.promise;
  assert.equal(owner.refresh('p'), refresh);
  const close = owner.close(); response.resolve(Response.json({ data: [] }));
  await close;
  assert.deepEqual(store.read(['providers']).providers[0].models, ['old', 'keep']);
});
