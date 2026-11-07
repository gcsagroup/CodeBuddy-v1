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
const metadataModel = { ...defaultModel, additionalProviders: [{ providerId: 'custom_example', displayName: 'Example Cloud', engine: 'openai_compatible', baseUrl: 'https://example.com', requiresAuth: true, models: ['example-model'] }] };

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
  assert.equal(state.providers.length, 2);
  assert.deepEqual(state.providers[1].models, ['Qwen3.8-27B-FP4', 'Qwen3.8-27B-CyberSecurity']);
  assert.equal(state.providers[0].secret, null);
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codebuddy-default-model-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh installed profile exposes Gemma and both Qwen models without credentials', async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, { defaultModel });
  const { defaults, providers } = store.read();
  assert.equal(providers.length, 2);
  const qwen = providers.find(provider => provider.id === 'custom_codebuddy_qwen_lan');
  assert.equal(qwen.apiUrl, 'http://192.168.9.120:8001');
  assert.deepEqual(qwen.models, ['Qwen3.8-27B-FP4', 'Qwen3.8-27B-CyberSecurity']);
  assert.equal(qwen.requiresAuth, false);
  assert.equal(qwen.secret, null);
  assert.equal(qwen.headersProtected, null);
  assert.equal(providerStatus(qwen).isConfigured, true);
  assert.equal(providers[0].secret, null);
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

test('legacy distribution credentials are ignored and never imported into new profiles', async t => {
  const dir = await fixture(t);
  const credentialFile = path.join(dir, 'distribution.json');
  const key = 'isolated-legacy-key-fixture';
  await writeFile(credentialFile, JSON.stringify({ version: 1, providers: [{ providerId: 'custom_example', baseUrl: 'https://example.com', apiKey: key }] }));
  const store = await openStore(path.join(dir, 'profile'), { defaultModel: metadataModel, distributionCredentialsFile: credentialFile });
  const cloud = store.read().providers[1];
  assert.equal(cloud.secret, null);
  assert.equal(providerStatus(cloud).isConfigured, false);
  await store.update(() => {});
  assert.equal((await readFile(path.join(store.directory, 'state.json'), 'utf8')).includes(key), false);
});

test('upgrades preserve user-owned cloud configuration and credentials', async t => {
  const dir = await fixture(t);
  const store = await openStore(dir, { defaultModel });
  await store.update(state => {
    state.providers.push({ id: 'custom_codebuddy_ollama', models: ['user-model'], secret: { kind: 'fixture-only', value: 'protected-user-credential' } });
    state.defaults = { providerId: 'custom_codebuddy_ollama', modelId: 'user-model' };
  });
  assert.deepEqual((await openStore(dir, { defaultModel })).read(), store.read());
});

test('distribution cloud presets reject duplicate providers, invalid endpoints and embedded secrets', async t => {
  const dir = await fixture(t);
  const preset = metadataModel.additionalProviders[0];
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
