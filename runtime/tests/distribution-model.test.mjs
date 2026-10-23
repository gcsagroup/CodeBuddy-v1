import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import defaultModel from '../default-model.json' with { type: 'json' };
import { providerStatus, driverProvider } from '../providers.mjs';
import { createCompatServer } from '../server.mjs';
import { RuntimeSettings } from '../settings.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { revealSecret } from '../secrets.mjs';

test('preview CLI seeds the same main and vision defaults as the installed desktop', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codebuddy-cli-default-model-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--data-dir', dir, '--port', '0'], {
    env: { ...process.env, CODEBUDDY_SERVER__SECRET_KEY: 'isolated-cli-default-fixture' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = '', error = '';
    child.once('error', reject);
    child.once('exit', code => reject(Error(`CLI exited ${code}: ${error}`)));
    child.stderr.on('data', data => { error += data; });
    child.stdout.on('data', data => {
      output += data;
      if (output.split('\n').some(line => { try { return JSON.parse(line).ready === true; } catch { return false; } })) resolve();
    });
  });
  const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.providers[0].apiUrl, defaultModel.baseUrl);
  assert.deepEqual(state.modelRouting.visionRoute, { enabled: true, mode: 'auto', ...state.defaults });
  assert.equal(state.modelCapabilities.overrides[0].imageInput, 'force_supported');
  assert.equal(state.providers[1].apiUrl, 'https://ollama.com');
  const bundled = await readFile(new URL('../distribution-credentials.json', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(Boolean(state.providers[1].secret), Boolean(bundled));
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codebuddy-default-model-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh installed profile exposes the LAN model to the existing provider pipeline', async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, { defaultModel });
  const { defaults, providers } = store.read();
  assert.deepEqual(defaults, { providerId: defaultModel.providerId, modelId: defaultModel.modelId });
  assert.equal(providers[0].apiUrl, 'http://192.168.9.101:8001');
  assert.equal(providers[0].contextWindows[defaults.modelId], 65536);
  assert.equal(providerStatus(providers[0]).isConfigured, true);
  const settings = new RuntimeSettings(store);
  const routing = await settings.request('codepro/model-routing/read');
  assert.deepEqual(routing.config.visionRoute, { enabled: true, mode: 'auto', ...defaults });
  assert.equal((await settings.request('model-capabilities/resolve', defaults)).imageInput, 'supported');
  const resolved = await driverProvider(providers[0]);
  assert.ok(resolved);
  await store.update(() => {});
  assert.deepEqual((await openStore(dir, { defaultModel })).read().providers, providers);
});

test('restart preserves custom models and deliberate removal of the bundled provider', async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, { defaultModel });
  await store.update(state => {
    state.providers = [{ id: 'custom_user', models: ['user-model'] }];
    state.defaults = { providerId: 'custom_user', modelId: 'user-model' };
    state.modelRouting.visionRoute = { enabled: true, mode: 'auto', ...state.defaults };
    state.modelCapabilities.overrides = [];
  });
  const reopened = await openStore(dir, { defaultModel });
  assert.deepEqual(reopened.read(), store.read());
  await reopened.update(state => {
    state.providers = [];
    state.defaults = { providerId: null, modelId: null };
  });
  assert.deepEqual((await openStore(dir, { defaultModel })).read().providers, []);
});

test('metadata-only distributions offer the Ollama cloud catalogue without credentials', async t => {
  const store = await openStore(await fixture(t), { defaultModel, distributionCredentialsFile: null });
  const { providers, defaults } = store.read();
  assert.equal(providers.length, 2);
  const cloud = providers.find(provider => provider.id === 'custom_codebuddy_ollama');
  assert.equal(cloud.displayName, 'ollama');
  assert.equal(cloud.engine, 'openai_compatible');
  assert.equal(cloud.apiUrl, 'https://ollama.com');
  assert.equal(cloud.requiresAuth, true);
  assert.ok(cloud.models.includes('kimi-k3'));
  assert.ok(cloud.models.includes('gemma4:31b'));
  assert.deepEqual(cloud.models, defaultModel.additionalProviders[0].models);
  assert.equal(providerStatus(cloud).isConfigured, false);
  assert.equal(cloud.secret, null);
  assert.equal(cloud.headersProtected, null);
  assert.equal(defaults.providerId, 'custom_codebuddy_lan');
  await store.update(state => {
    state.providers[1].secret = { kind: 'fixture-only', value: 'local-encrypted-fixture' };
    state.defaults = { providerId: cloud.id, modelId: 'kimi-k3' };
  });
  assert.deepEqual((await openStore(store.directory, { defaultModel })).read(), store.read());
});

test('approved shared cloud credentials are usable on first launch and protected in user state', async t => {
  const dir = await fixture(t);
  const credentialFile = path.join(dir, 'distribution.json');
  const key = 'isolated-shared-cloud-fixture';
  const payload = { version: 1, providers: [{ providerId: 'custom_codebuddy_ollama', baseUrl: 'https://ollama.com', apiKey: key }] };
  await writeFile(credentialFile, JSON.stringify(payload));
  const store = await openStore(path.join(dir, 'profile'), { defaultModel, distributionCredentialsFile: credentialFile });
  const cloud = store.read().providers[1];
  assert.equal(providerStatus(cloud).isConfigured, true);
  assert.equal(await revealSecret(cloud.secret), key);
  assert.equal(cloud.apiKey, undefined);
  assert.equal(store.read().defaults.providerId, 'custom_codebuddy_lan');
  await store.update(() => {});
  assert.equal((await readFile(path.join(store.directory, 'state.json'), 'utf8')).includes(key), false);
  const original = store.read();
  await writeFile(credentialFile, '{broken');
  assert.deepEqual((await openStore(store.directory, { defaultModel, distributionCredentialsFile: credentialFile })).read(), original);
  await store.update(state => { state.providers = []; });
  assert.deepEqual((await openStore(store.directory, { defaultModel, distributionCredentialsFile: credentialFile })).read().providers, []);
});

test('shared credentials reject mismatched endpoints, duplicate providers and invalid payloads without leaking keys', async t => {
  const dir = await fixture(t);
  const credentialFile = path.join(dir, 'distribution.json');
  const entry = { providerId: 'custom_codebuddy_ollama', baseUrl: 'https://ollama.com', apiKey: 'must-not-appear-in-errors' };
  for (const payload of [null, {}, { version: 1, providers: [entry, entry] },
    ...[{ baseUrl: 'https://other.example' }, { providerId: 'custom_unknown' }, { apiKey: '' }].map(override => ({ version: 1, providers: [{ ...entry, ...override }] })),
  ]) {
    await writeFile(credentialFile, JSON.stringify(payload));
    await assert.rejects(openStore(path.join(dir, 'profile'), { defaultModel, distributionCredentialsFile: credentialFile }), error => {
      assert.equal(error.message.includes(entry.apiKey), false);
      return /distribution credential/i.test(error.message);
    });
  }
});

test('distribution cloud presets reject duplicate providers, invalid endpoints and embedded secrets', async t => {
  const dir = await fixture(t);
  const preset = defaultModel.additionalProviders[0];
  for (const override of [
    { providerId: defaultModel.providerId }, { baseUrl: 'file:///tmp/cloud' },
    { baseUrl: 'https://user:password@ollama.com' }, { baseUrl: 'https://ollama.com?token=fixture' },
    { models: [] }, { models: ['model', 'model'] },
    { apiKey: 'fixture-do-not-distribute' }, { secret: { kind: 'fixture' } },
  ]) {
    await assert.rejects(openStore(dir, { defaultModel: { ...defaultModel, additionalProviders: [{ ...preset, ...override }] } }));
  }
});

test('existing empty profiles and corrupt profiles are never replaced with distribution defaults', async t => {
  const dir = await fixture(t);
  const existing = await openStore(dir);
  await existing.update(() => {});
  assert.deepEqual((await openStore(dir, { defaultModel })).read().providers, []);
  await writeFile(path.join(dir, 'state.json'), '{broken');
  await assert.rejects(openStore(dir, { defaultModel }), SyntaxError);
});

test('invalid distribution endpoints and capacities fail before seeding', async t => {
  const dir = await fixture(t);
  for (const override of [{ baseUrl: 'file:///tmp/model' }, { baseUrl: 'http://user:password@localhost' }, { contextWindow: 0 }]) {
    await assert.rejects(openStore(dir, { defaultModel: { ...defaultModel, ...override } }));
  }
});

test('desktop server startup persists the preset without calling the model', async t => {
  const dir = await fixture(t);
  const server = await createCompatServer({
    dataDir: dir, secret: 'isolated-default-model-test', defaultModel,
    driver: { prompt: () => assert.fail('Startup must not contact the model'), close: async () => {} },
  });
  try {
    const url = await server.listen();
    const status = await fetch(`${url}/status`, { headers: { 'X-Secret-Key': 'isolated-default-model-test' } });
    assert.equal(status.status, 200);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.defaults.modelId, defaultModel.modelId);
    assert.equal(state.providers.length, 2);
  } finally { await server.close(); }
});
