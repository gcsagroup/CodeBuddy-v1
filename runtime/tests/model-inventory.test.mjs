import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { ModelInventory } from '../model-inventory.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codebuddy-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  const provider = { id: 'p', displayName: 'Test provider', apiUrl: `http://${path.basename(dir)}.invalid`, engine: 'openai_compatible', requiresAuth: false, models: ['old', 'keep'] };
  await store.update(s => { s.providers = [provider]; s.defaults = { providerId: 'p', modelId: 'old' }; s.sessions = [{ id: 'chat', providerId: 'p', modelId: 'old' }]; });
  return { dir, store, owner: new ModelInventory(store), provider };
}

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
