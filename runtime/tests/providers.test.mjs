import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  discover,
  driverProvider,
  inventory,
  resolvedInventory,
  resolveImageCapability,
  modelBase,
  readProvider,
  saveProvider,
} from "../providers.mjs";
import { RuntimeSettings } from '../settings.mjs';
import {
  zCustomProviderCreateResponse_unstable,
  zCustomProviderReadResponse_unstable,
  zListProvidersResponse_unstable,
} from "../../ui/sdk/src/generated/zod.gen.ts";

async function endpoint(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (handler) return handler(req, res, body);
    res.end(
      JSON.stringify(
        req.url.endsWith("/models")
          ? { data: [{ id: "fixture-model" }, { id: "other-model" }] }
          : req.url.endsWith("/tags")
            ? { models: [{ name: "fixture-model" }] }
            : req.url.endsWith("/responses")
              ? { output_text: "OK" }
              : {
                  choices: [{ message: { role: "assistant", content: "OK" } }],
                },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function memoryStore() {
  let state = { providers: [] };
  return {
    read: () => structuredClone(state),
    async update(fn) {
      const next = structuredClone(state);
      await fn(next);
      state = next;
    },
  };
}

test('official endpoints resolve native catalog capabilities without guessing from names or proxy URLs', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    data: [{ id: 'gpt-6.1-sol' }, { id: 'deepseek-flash' }],
  }), { headers: { 'content-type': 'application/json' } }));
  for (const [url, model] of [['https://api.openai.com', 'gpt-6.1-sol'], ['https://api.deepseek.com', 'deepseek-flash']]) {
    const provider = { ...input(url), id: url, models: [model] };
    const resolved = await driverProvider(provider, model);
    assert.ok(Object.keys(resolved.reasoningEfforts).length > 1);
    assert.equal(resolved.contextSource, 'catalog');
    assert.equal((await resolveImageCapability(provider, model)).imageInput, 'supported');
    assert.equal(provider.catalogProviderId, undefined, 'advisory lookup does not rewrite saved settings');
  }
  for (const url of ['https://openai-proxy.invalid', 'https://api.openai.com/proxy/v1']) {
    const proxy = { ...input(url), displayName: 'OpenAI', id: url, models: ['gpt-6.1-sol'] };
    assert.equal((await driverProvider(proxy, 'gpt-6.1-sol')).reasoningEfforts, undefined);
    assert.equal((await resolveImageCapability(proxy, 'gpt-6.1-sol')).imageInput, 'unknown');
  }
});

test('OpenAI numbered models sort by version even when alias creation dates are older, without changing the saved default', async t => {
  const rows = [
    { id: 'gpt-4', created: 1000 },
    { id: 'tts-1', created: 9999 },
    { id: 'gpt-6.1-sol', created: 200 },
    { id: 'gpt-6.1-terra', created: 150 },
    { id: 'unknown-model', created: 300 },
  ];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: rows })));
  const provider = { ...input('https://api.openai.com'), models: rows.map(row => row.id) };
  const expected = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-4', 'tts-1', 'unknown-model'];
  assert.deepEqual(await discover(provider), expected);
  assert.deepEqual(inventory(provider).models.map(model => model.id), expected);
  assert.equal(inventory(provider).defaultModel, 'gpt-4');
  assert.deepEqual(provider.models, rows.map(row => row.id));
  const proxy = { ...provider, apiUrl: 'https://proxy.invalid', displayName: 'OpenAI' };
  assert.deepEqual(await discover(proxy), ['tts-1', 'gpt-4', 'unknown-model', 'gpt-6.1-sol', 'gpt-6.1-terra']);
});

test('local Ollama show metadata distinguishes vision, tool support and non-chat models', async t => {
  const api = await endpoint(t, (req, res, body) => res.end(JSON.stringify(req.url.endsWith('/api/tags')
    ? { models: ['vision-agent', 'text-only', 'embedding', 'unknown'].map(name => ({ name })) }
    : req.url.endsWith('/api/show') ? ({
      'vision-agent': { capabilities: ['completion', 'vision', 'tools'] },
      'text-only': { capabilities: ['completion'] },
      embedding: { capabilities: ['embedding'] },
      unknown: {},
    }[body.model]) : {})));
  const provider = input(api.url, { engine: 'ollama', models: ['vision-agent', 'text-only', 'embedding', 'unknown'] });
  assert.equal((await resolveImageCapability(provider, 'vision-agent')).imageInput, 'supported');
  assert.equal((await resolveImageCapability(provider, 'text-only')).imageInput, 'unsupported');
  await assert.rejects(driverProvider(provider, 'text-only'), error => error.data.code === 'custom_provider_tools_unsupported');
  await assert.rejects(driverProvider(provider, 'embedding'), error => error.data.code === 'custom_provider_model_unavailable');
  assert.ok(!(await resolvedInventory(provider)).models.some(m => m.id === 'embedding'));
  await driverProvider(provider, 'vision-agent');
  await driverProvider(provider, 'unknown');
});

test('Ollama cloud details supply capacity once per model; local architectural limits are not adopted', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url, options={})=>{
    calls.push({url:String(url),body:options.body});
    return new Response(JSON.stringify(String(url).endsWith('/api/show')
      ? {model_info:{'kimi-k3.context_length':1048576}, capabilities:['completion','vision','thinking','tools']}
      : String(url).endsWith('/api/tags') ? {models:[{name:'kimi-k3',capabilities:['completion','thinking']}]}
      : {data:[{id:'kimi-k3'}]}),{headers:{'content-type':'application/json'}});
  });
  const p={...input('https://ollama.com'),id:'cloud-capacity',models:['kimi-k3']};
  const [a,b]=await Promise.all([driverProvider(p,'kimi-k3'),driverProvider(p,'kimi-k3')]);
  assert.equal(a.contextWindow,1048576);assert.equal(b.contextSource,'service');
  assert.deepEqual(await resolveImageCapability(p, 'kimi-k3'), {imageInput:'supported',source:'provider_metadata'});
  assert.equal(calls.filter(c=>c.url.endsWith('/api/show')).length,1);
  assert.equal((await driverProvider({...p,contextWindows:{'kimi-k3':65536}},'kimi-k3')).contextWindow,65536);
  const local=await driverProvider({...p,apiUrl:'http://localhost:11434'},'kimi-k3');
  assert.equal(local.contextSource,'fallback');
  assert.equal(calls.filter(c=>c.url.includes('localhost')&&c.url.endsWith('/api/show')).length,0);
});

test('Ollama discovery excludes declared decision and embedding models before save and chat selection', async t => {
  const api = await endpoint(t, (req, res) => res.end(JSON.stringify(req.url.endsWith('/api/tags')
    ? { models: [
      { name: 'decision-model', capabilities: ['decision', 'vision'] },
      { name: 'embedding-model', capabilities: ['embedding'] },
      { name: 'chat-model', capabilities: ['completion', 'thinking'] },
      { name: 'older-model' },
    ] } : req.url.endsWith('/api/show') ? {} : { choices: [{ message: { role: 'assistant', content: 'OK' } }] })));
  const config = input(api.url, { engine: 'ollama_compatible', models: ['chat-model', 'older-model'] });
  assert.deepEqual(await discover(config), ['chat-model', 'older-model']);
  const previous = { ...config, id: 'previous', models: ['decision-model', 'chat-model', 'embedding-model'] };
  assert.deepEqual((await resolvedInventory(previous)).models.map(model => model.id), ['chat-model']);
  assert.equal(previous.models.length, 3, 'Capability projection must not modify saved user configuration');
  const store = memoryStore();
  await assert.rejects(saveProvider(store, { ...config, models: ['decision-model'] }), /not available/);
  assert.equal(store.read().providers.length, 0);
  assert.ok(!api.requests.some(request => request.url.endsWith('/chat/completions')));
  await saveProvider(store, config);
  assert.equal(api.requests.filter(request => request.url.endsWith('/chat/completions')).length, 1);
  await assert.rejects(driverProvider(previous, 'decision-model'), /does not support chat/);
});

test('image capability uses declared metadata, preserves manual denial and never guesses from model names', async t => {
  const api = await endpoint(t, (_req, res) => res.end(JSON.stringify({ data: [
    { id: 'seeing', input_modalities: ['text', 'image'] },
    { id: 'plain', input: ['text'] },
    { id: 'vision-in-name-only', input_modalities: 'image' },
  ] })));
  const provider = { ...input(api.url), id: 'image-metadata', models: ['seeing', 'plain', 'vision-in-name-only'] };
  const store = memoryStore();
  await store.update(s => { s.providers = [provider]; });
  const settings = new RuntimeSettings(store);
  const resolve = modelId => settings.request('model-capabilities/resolve', { providerId: provider.id, modelId });
  assert.equal((await resolve('seeing')).imageInput, 'supported');
  assert.equal((await resolve('plain')).imageInput, 'unsupported');
  assert.equal((await resolve('vision-in-name-only')).imageInput, 'unknown');
  await settings.request('model-capabilities/save', { config: { version: 1, overrides: [
    { providerId: provider.id, modelId: 'seeing', imageInput: 'force_unsupported' },
  ] } });
  assert.deepEqual(await resolve('seeing'), { providerId: provider.id, modelId: 'seeing', imageInput: 'unsupported', source: 'user_override' });
  assert.equal(api.requests.length, 1, 'Capability and context share one cached discovery');
});

test('explicit catalog provider uses official Harness metadata and unknown model keeps upstream fallback', async t => {
  const api=await endpoint(t,(_req,res)=>res.end(JSON.stringify({data:[{id:'gpt-4'},{id:'gpt-4o'},{id:'unknown'}]})));
  const p={...input(api.url),catalogProviderId:'openai'};
  const known=await driverProvider(p,'gpt-4');
  assert.equal(known.contextSource,'catalog');assert.ok(known.contextWindow>0);
  assert.ok(known.outputTokenCapacity > 0, 'the native catalog supplies the model output capacity');
  assert.deepEqual(await resolveImageCapability(p, 'gpt-4o'), { imageInput: 'supported', source: 'catalog' });
  const unknown=await driverProvider(p,'unknown');
  assert.equal(unknown.contextSource,'fallback');assert.equal(unknown.contextWindow,262144);
  assert.equal(unknown.outputTokenCapacity, undefined, 'an unknown model leaves the fallback to the installed adapter');
});

test('service output capacities are per model, override catalog values and share the discovery cache', async t => {
  const api = await endpoint(t, (_req, res) => res.end(JSON.stringify({ data: [
    { id: 'gpt-4', max_model_len: 65536, max_output_tokens: 1536, input: ['text'] },
    { id: 'other-model', context_window: 131072, limit: { output: 12288 } },
    { id: 'invalid', max_output_tokens: -1 },
  ] })));
  const provider = { ...input(api.url), catalogProviderId: 'openai' };
  const [a, b, again] = await Promise.all([
    driverProvider(provider, 'gpt-4'), driverProvider(provider, 'other-model'), driverProvider(provider, 'gpt-4'),
  ]);
  assert.equal(a.outputTokenCapacity, 1536);
  assert.equal(a.maxTokens, undefined, 'a capability must not become a fixed request default');
  assert.equal(a.contextWindow, 65536);
  assert.equal(a.contextSource, 'service');
  assert.equal(b.outputTokenCapacity, 12288);
  assert.equal(again.outputTokenCapacity, a.outputTokenCapacity);
  assert.equal((await driverProvider(provider, 'invalid')).outputTokenCapacity, undefined);
  assert.equal(api.requests.length, 1);
});

test('cloud context metadata does not hide a separately declared catalog output capacity', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(JSON.stringify(
    new URL(url).pathname.endsWith('/api/show')
      ? { model_info: { 'fixture.context_length': 65536 } }
      : { data: [{ id: 'gpt-4' }] }
  ), { headers: { 'content-type': 'application/json' } }));
  const provider = { ...input('https://ollama.com/v1'), catalogProviderId: 'openai',
    headers: { 'X-Fixture': 'partial-output-metadata' } };
  const resolved = await driverProvider(provider, 'gpt-4');
  assert.equal(resolved.contextWindow, 65536);
  assert.equal(resolved.contextSource, 'service');
  assert.equal(resolved.outputTokenCapacity, 8192);
  assert.equal(resolved.outputTokenCapacitySource, 'catalog');
});

test('provider edits retain model output budgets without turning them into capacity', async t => {
  const api = await endpoint(t);
  const store = memoryStore();
  await store.update(state => state.providers.push({ ...input(api.url), id: 'budget-fixture',
    outputBudgets: { 'fixture-model': 65536 } }));
  await saveProvider(store, { ...input(api.url), providerId: 'budget-fixture', displayName: 'Renamed fixture' }, true);
  const saved = store.read().providers[0];
  assert.deepEqual(saved.outputBudgets, { 'fixture-model': 65536 });
  const resolved = await driverProvider(saved, 'fixture-model');
  assert.equal(resolved.requestMaxTokens, 65536);
  assert.equal(resolved.outputTokenCapacity, undefined);
  await assert.rejects(driverProvider({ ...saved, outputBudgets: { 'fixture-model': 0 } }, 'fixture-model'), /positive integer/);
});

test('a delayed connection probe cannot overwrite a separately committed output budget', async t => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const api = await endpoint(t, async (req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    reached.resolve();
    await release.promise;
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  const store = memoryStore();
  await store.update(state => state.providers.push({ ...input(api.url), id: 'budget-race', outputBudgets: { 'fixture-model': 128 } }));
  const editing = saveProvider(store, { ...input(api.url), providerId: 'budget-race', displayName: 'Edited connection' }, true);
  await reached.promise;
  await new RuntimeSettings(store).request('providers/config/save', { providerId: 'budget-race', fields: [{ key: 'maxTokens:fixture-model', value: '1024' }] });
  release.resolve();
  await editing;
  assert.equal(store.read().providers[0].displayName, 'Edited connection');
  assert.deepEqual(store.read().providers[0].outputBudgets, { 'fixture-model': 1024 });
});

test('editing the active connection selection updates new-chat defaults atomically', async t => {
  const api = await endpoint(t);
  const store = memoryStore();
  const provider = { ...input(api.url), id: 'selected-provider', models: ['fixture-model', 'other-model'] };
  await store.update(state => {
    state.providers = [provider];
    state.defaults = { providerId: provider.id, modelId: 'fixture-model' };
    state.sessions = [{ id: 'existing-chat', providerId: provider.id, modelId: 'fixture-model' }];
  });
  await saveProvider(store, { ...provider, providerId: provider.id, models: ['other-model', 'fixture-model'] }, true);
  assert.deepEqual(store.read().defaults, { providerId: provider.id, modelId: 'other-model' });
  assert.equal(store.read().sessions[0].modelId, 'fixture-model');
  await assert.rejects(saveProvider(store, { ...provider, providerId: provider.id, models: ['missing-model'] }, true));
  assert.equal(store.read().defaults.modelId, 'other-model');
  await store.update(state => { state.defaults = { providerId: 'another-provider', modelId: 'another-model' }; });
  await saveProvider(store, { ...provider, providerId: provider.id }, true);
  assert.deepEqual(store.read().defaults, { providerId: 'another-provider', modelId: 'another-model' });
});

test('a connection verification finishing late preserves a newer default selection', async t => {
  const probing = Promise.withResolvers();
  const release = Promise.withResolvers();
  const api = await endpoint(t, async (req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'other-model' }] }));
    probing.resolve();
    await release.promise;
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  const store = memoryStore();
  const provider = { ...input(api.url), id: 'selection-race' };
  await store.update(state => {
    state.providers = [provider];
    state.defaults = { providerId: provider.id, modelId: 'fixture-model' };
  });
  const saving = saveProvider(store, { ...provider, providerId: provider.id, models: ['other-model', 'fixture-model'] }, true);
  await probing.promise;
  await store.update(state => { state.defaults = { providerId: 'new-selection', modelId: 'new-model' }; });
  release.resolve();
  await saving;
  assert.deepEqual(store.read().defaults, { providerId: 'new-selection', modelId: 'new-model' });
});

function input(apiUrl, overrides = {}) {
  return {
    engine: "openai_compatible",
    displayName: "Fixture provider",
    apiUrl,
    requiresAuth: false,
    headers: {},
    models: ["fixture-model"],
    ...overrides,
  };
}

test('server-advertised context is preserved per model and concurrent session routes reuse discovery', async t => {
  const api = await endpoint(t, (_req, res) => res.end(JSON.stringify({ data: [
    { id: 'fixture-model', max_model_len: 65536 },
    { id: 'other-model', context_window: 131072 },
    { id: 'invalid', max_model_len: -1 },
  ] })));
  const provider = { ...input(api.url), id: 'metadata-fixture' };
  const [main, other, again] = await Promise.all([
    driverProvider(provider, 'fixture-model'), driverProvider(provider, 'other-model'), driverProvider(provider, 'fixture-model'),
  ]);
  assert.equal(main.contextWindow, 65536);
  assert.equal(other.contextWindow, 131072);
  assert.equal(again.contextWindow, 65536);
  assert.equal(api.requests.length, 1);
  assert.equal(inventory(provider).models[0].contextLimit, 65536);
  assert.equal((await driverProvider(provider, 'invalid')).contextSource, 'fallback');
  assert.equal((await driverProvider(provider, 'absent')).contextSource, 'fallback');
  assert.equal(api.requests.length, 1);
  const changed = await endpoint(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'fixture-model', max_model_len: 8192 }] })));
  assert.equal((await driverProvider({ ...provider, apiUrl: changed.url }, 'fixture-model')).contextWindow, 8192);
});

test('unavailable model metadata keeps completions usable and does not retry for every session', async t => {
  const api = await endpoint(t, (_req, res) => { res.writeHead(404); res.end('{}'); });
  const provider = { ...input(api.url), id: 'offline-metadata' };
  assert.equal((await driverProvider(provider, 'fixture-model')).contextWindow, 262144);
  assert.equal((await driverProvider(provider, 'fixture-model')).contextSource, 'fallback');
  assert.equal(api.requests.length, 1);
  assert.equal(inventory(provider).models[0].contextLimit, 262144);
});

test('configured context cannot exceed a service cap and preserves a smaller user budget', async t => {
  const api=await endpoint(t,(_req,res)=>res.end(JSON.stringify({data:[{id:'fixture-model',max_model_len:65536}]})));
  const provider={...input(api.url),id:'configured-capacity',contextWindows:{'fixture-model':131072}};
  assert.equal((await driverProvider(provider,'fixture-model')).contextWindow,65536);
  assert.equal((await driverProvider(provider,'fixture-model')).contextSource,'service');
  provider.contextWindows['fixture-model']=16384;
  assert.equal((await driverProvider(provider,'fixture-model')).contextWindow,16384);
  assert.equal((await driverProvider(provider,'fixture-model')).contextSource,'configured');
});

test('initial desktop inventory resolves capacity before any conversation and shares the routing cache', async t => {
  const api = await endpoint(t, (_req, res) => res.end(JSON.stringify({ data: [
    { id: 'fixture-model', max_model_len: 65536 },
    { id: 'other-model', max_model_len: 131072 },
  ] })));
  const provider = { ...input(api.url), id: 'homepage-capacity', models: ['fixture-model', 'other-model'] };
  const [first, concurrent] = await Promise.all([resolvedInventory(provider), resolvedInventory(provider)]);
  zListProvidersResponse_unstable.parse({ entries: [first] });
  assert.deepEqual(first.models.map(model => model.contextLimit), [65536, 131072]);
  assert.deepEqual(concurrent, first);
  assert.equal((await driverProvider(provider, 'fixture-model')).contextWindow, 65536);
  assert.equal(api.requests.length, 1, 'homepage and first conversation share one metadata request');
  const offline = await endpoint(t, (_req, res) => { res.writeHead(404); res.end('{}'); });
  const unavailable = { ...input(offline.url), id: 'homepage-offline' };
  assert.equal((await resolvedInventory(unavailable)).models[0].contextLimit, 262144);
  await resolvedInventory(unavailable);
  assert.equal(offline.requests.length, 1);
});

test("manual provider save discovers then verifies selected model before publishing SDK-compatible config", async (t) => {
  const api = await endpoint(t);
  const store = memoryStore();
  assert.deepEqual(await discover(input(api.url)), [
    "fixture-model",
    "other-model",
  ]);
  assert.equal(store.read().providers.length, 0);
  const saved = zCustomProviderCreateResponse_unstable.parse(
    await saveProvider(store, input(api.url)),
  );
  const provider = store.read().providers[0];
  assert.equal(saved.providerId, provider.id);
  assert.equal(api.requests.filter((req) => req.body).length, 1);
  assert.equal(api.requests.at(-1).body.model, "fixture-model");
  assert.ok(api.requests.at(-1).body.max_tokens >= 16);
  assert.ok(api.requests.at(-1).body.max_tokens <= 512);
  assert.equal(api.requests.at(-1).body.stream, false);
  assert.ok(!api.requests.some((req) => req.headers.authorization));
  zListProvidersResponse_unstable.parse({ entries: [inventory(provider)] });
  assert.equal(inventory(provider).models[0].contextLimit, 262144, 'desktop displays the upstream default budget when service capacity is unknown');
  const read = zCustomProviderReadResponse_unstable.parse(
    await readProvider(provider),
  );
  assert.equal(read.provider.apiKeySet, false);
  assert.equal(read.provider.engine, "openai_compatible");
  assert.deepEqual((await driverProvider(provider)).headers, {});
});

test("saved base URLs preserve full completion endpoints and explicit API paths", async (t) => {
  const api = await endpoint(t, (req, res, body) => {
    if (req.url.endsWith('/responses') && body.max_output_tokens < 16) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { code: 'integer_below_min_value', param: 'max_output_tokens' } }));
      return;
    }
    res.end(JSON.stringify(req.url.endsWith('/models')
      ? { data: [{ id: 'fixture-model' }] }
      : { output_text: 'OK' }));
  });
  for (const [urlPath, basePath, expected] of [
    ["", null, "/v1"],
    ["/v1/", null, "/v1"],
    ["/api/paas/v4/chat/completions", null, "/api/paas/v4"],
    ["/unused", "/proxy/v1/chat/completions", "/proxy/v1"],
    ["/v1/responses", null, "/v1"],
  ])
    assert.equal(
      modelBase(input(api.url + urlPath, { basePath })),
      api.url + expected,
    );
  const store = memoryStore();
  await saveProvider(store, input(api.url + "/v1/responses"));
  assert.equal(
    (await driverProvider(store.read().providers[0])).protocol,
    "openai-responses",
  );
  assert.ok(api.requests.at(-1).body.max_output_tokens >= 16);
  assert.ok(api.requests.at(-1).body.max_output_tokens <= 512);
  assert.equal(api.requests.at(-1).body.input, "Reply OK.");
});

test('official OpenAI chat probes use completion budgets without legacy max_tokens', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (body?.max_tokens !== undefined) return new Response(JSON.stringify({
      error: { code: 'unsupported_parameter', param: 'max_tokens' },
    }), { status: 400 });
    return new Response(JSON.stringify(String(url).endsWith('/models')
      ? { data: [{ id: 'fixture-model' }] }
      : { choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
      { headers: { 'content-type': 'application/json' } });
  });
  const store = memoryStore();
  await saveProvider(store, input('https://api.openai.com', { basePath: '/v1/chat/completions' }));
  const generated = calls.filter(call => call.body);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.ok(generated[0].body.max_completion_tokens >= 16);
  assert.ok(!Object.hasOwn(generated[0].body, 'max_tokens'));
});

test('failed probes preserve bounded error identifiers without echoing service messages', async t => {
  const api = await endpoint(t, (req, res) => {
    if (req.url.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      return;
    }
    res.writeHead(400);
    res.end(JSON.stringify({ error: { code: 'unsupported_parameter', param: 'max_tokens',
      message: 'Do not expose this echoed credential: PRIVATE_FIXTURE_CREDENTIAL' } }));
  });
  const store = memoryStore();
  await assert.rejects(saveProvider(store, input(api.url)), error => {
    assert.equal(error.data.httpStatus, 400);
    assert.equal(error.data.upstreamCode, 'unsupported_parameter');
    assert.equal(error.data.upstreamParam, 'max_tokens');
    assert.match(error.message, /unsupported_parameter: max_tokens/);
    assert.ok(!JSON.stringify(error.data).includes('PRIVATE_FIXTURE_CREDENTIAL'));
    return true;
  });
  assert.equal(store.read().providers.length, 0);
});

test('provider routes keep discovery, save and chat aligned without guessing a proxy protocol', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(String(url).endsWith('/models')
      ? { data: [{ id: 'fixture-model' }] }
      : String(url).endsWith('/responses') ? { output_text: 'OK' }
        : { choices: [{ message: { content: 'OK' } }] }));
  });
  for (const [url, basePath, root, protocol] of [
    ['https://api.openai.com', null, 'https://api.openai.com/v1', 'responses'],
    ['https://api.openai.com/v1/', null, 'https://api.openai.com/v1', 'responses'],
    ['https://api.openai.com', '/v1/chat/completions', 'https://api.openai.com/v1', 'chat/completions'],
    ['https://api.deepseek.com', null, 'https://api.deepseek.com/v1', 'chat/completions'],
    ['https://api.siliconflow.cn/v1', null, 'https://api.siliconflow.cn/v1', 'chat/completions'],
    ['https://api.moonshot.cn/v1', null, 'https://api.moonshot.cn/v1', 'chat/completions'],
    ['https://open.bigmodel.cn/api/paas/v4/chat/completions', null, 'https://open.bigmodel.cn/api/paas/v4', 'chat/completions'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', null, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'chat/completions'],
    ['https://api.openai.com.proxy.invalid', null, 'https://api.openai.com.proxy.invalid/v1', 'chat/completions'],
    ['https://proxy.invalid/unused', '/tenant/v2/responses', 'https://proxy.invalid/tenant/v2', 'responses'],
  ]) {
    calls.length = 0;
    const store = memoryStore();
    await saveProvider(store, input(url, { basePath }));
    const generated = calls.filter(call => call.body);
    assert.equal(generated.length, 1);
    assert.equal(generated[0].url, `${root}/${protocol}`);
    assert.equal(calls[0].url, `${root}/models`);
    assert.equal(generated[0].body.tools.length, 1);
    assert.equal(generated[0].body.reasoning_effort, undefined, 'Unknown models receive no invented thinking control');
    const native = await driverProvider(store.read().providers[0], 'fixture-model');
    assert.equal(native.baseUrl, root);
    assert.equal(native.protocol, protocol === 'responses' ? 'openai-responses' : 'openai-completions');
  }
});

test('a model listing cannot validate rejected tools or thinking parameters, and failed edits preserve the old connection', async t => {
  for (const param of ['tools', 'reasoning_effort']) {
    const api = await endpoint(t, (req, res, body) => {
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      assert.equal(body.tools[0].function.name, 'connection_check');
      assert.equal(body.reasoning_effort, 'high');
      assert.equal(body.max_tokens, 4096);
      res.writeHead(400);
      res.end(JSON.stringify({ error: { code: 'unsupported_parameter', param, message: 'PRIVATE_TOKEN' } }));
    });
    const provider = { ...input(api.url), id: 'existing', thinkingEfforts: { 'fixture-model': 'high' } };
    const store = memoryStore();
    await store.update(state => { state.providers.push(provider); });
    const before = store.read();
    assert.deepEqual(await discover(provider), ['fixture-model']);
    await assert.rejects(saveProvider(store, { ...provider, providerId: provider.id }, true), error => {
      assert.equal(error.data.upstreamParam, param);
      assert.match(error.message, /loading the model list does not verify generation/);
      assert.doesNotMatch(error.message, /PRIVATE_TOKEN/);
      return true;
    });
    assert.deepEqual(store.read(), before);
    assert.equal(api.requests.filter(req => req.body).length, 1, 'No hidden downgrade or protocol retry');
  }
});

test('probe respects discovered Ollama thinking and tools capabilities', async t => {
  const api = await endpoint(t, (req, res, body) => res.end(JSON.stringify(req.url.endsWith('/tags')
    ? { models: [{ name: 'fixture-model' }] }
    : req.url.endsWith('/show') ? { capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [false, 'low', 'high'], default: 'high' } }
      : { choices: [{ message: { content: 'OK' } }] })));
  await saveProvider(memoryStore(), input(api.url, { engine: 'ollama_compatible' }));
  const body = api.requests.at(-1).body;
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.tools[0].function.name, 'connection_check');
});

test('Responses probe includes the same saved reasoning preference with function tools', async t => {
  const api = await endpoint(t);
  const store = memoryStore();
  const provider = { ...input(api.url, { basePath: '/v1/responses' }), id: 'reasoning', thinkingEfforts: { 'fixture-model': 'none' } };
  await store.update(state => { state.providers.push(provider); });
  await saveProvider(store, { ...provider, providerId: provider.id }, true);
  const body = api.requests.at(-1).body;
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.tools[0].name, 'connection_check');
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.max_output_tokens, 128, 'Disabled thinking needs no expanded reasoning budget');
});

test('Gemma template probe does not invent an OpenAI reasoning_effort field', async t => {
  const api = await endpoint(t, (req, res) => res.end(JSON.stringify(req.url.endsWith('/models')
    ? { data: [{ id: 'gemma-4-local' }] } : { choices: [{ message: { content: 'OK' } }] })));
  await saveProvider(memoryStore(), input(api.url, { models: ['gemma-4-local'] }));
  const body = api.requests.at(-1).body;
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  assert.equal(body.reasoning_effort, undefined);
});

test('empty, truncated and unfinished probes never publish a provider', async t => {
  for (const [name, basePath, reply] of [
    ['empty-chat', null, { choices: [{ message: { content: '  ' }, finish_reason: 'stop' }] }],
    ['truncated-chat', null, { choices: [{ message: { content: 'O' }, finish_reason: 'length' }] }],
    ['filtered-chat', null, { choices: [{ message: { content: 'O' }, finish_reason: 'content_filter' }] }],
    ['reasoning-only', '/v1/responses', { status: 'completed', output: [{ type: 'reasoning', summary: [] }] }],
    ['empty-responses', '/v1/responses', { status: 'completed', output_text: '' }],
    ['truncated-responses', '/v1/responses', { status: 'incomplete', output_text: 'O', incomplete_details: { reason: 'max_output_tokens' } }],
    ['unfinished-responses', '/v1/responses', { status: 'in_progress', output_text: 'OK' }],
    ['malformed-responses', '/v1/responses', { output: [null, { type: 'message', role: 'assistant', content: [null] }] }],
  ]) {
    await t.test(name, async () => {
      const api = await endpoint(t, (req, res) => res.end(JSON.stringify(req.url.endsWith('/models')
        ? { data: [{ id: 'fixture-model' }] } : reply)));
      const store = memoryStore();
      await assert.rejects(saveProvider(store, input(api.url, { basePath })),
        error => error.data?.code === 'custom_provider_model_unavailable');
      assert.equal(store.read().providers.length, 0);
    });
  }
});

test('structured Responses assistant text verifies without an output_text convenience field', async t => {
  const api = await endpoint(t, (req, res) => res.end(JSON.stringify(req.url.endsWith('/models')
    ? { data: [{ id: 'fixture-model' }] }
    : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] })));
  const store = memoryStore();
  await saveProvider(store, input(api.url, { basePath: '/v1/responses' }));
  assert.equal(store.read().providers.length, 1);
});

test('forbidden access is distinguished from rejected credentials during discovery and save', async t => {
  for (const deniedAt of ['discovery', 'completion']) {
    await t.test(deniedAt, async () => {
      const api = await endpoint(t, (req, res) => {
        if (deniedAt === 'completion' && req.url.endsWith('/models')) {
          res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
          return;
        }
        res.writeHead(403);
        res.end(JSON.stringify({ error: { code: 'permission_denied', message: 'PRIVATE_FIXTURE_CREDENTIAL' } }));
      });
      const store = memoryStore();
      await assert.rejects(saveProvider(store, input(api.url)), error => {
        assert.equal(error.data.code, 'custom_provider_permission_denied');
        assert.equal(error.data.httpStatus, 403);
        assert.equal(error.data.upstreamCode, 'permission_denied');
        assert.ok(!JSON.stringify(error.data).includes('PRIVATE_FIXTURE_CREDENTIAL'));
        return true;
      });
      assert.equal(store.read().providers.length, 0);
    });
  }
});

test("Ollama UI engine discovers tags and uses the compatible completion endpoint", async (t) => {
  const api = await endpoint(t);
  const store = memoryStore();
  await saveProvider(store, input(api.url, { engine: "ollama_compatible" }));
  assert.deepEqual(
    api.requests.map((req) => req.url),
    ["/api/tags", "/api/show", "/v1/chat/completions"],
  );
  assert.equal(
    (await driverProvider(store.read().providers[0])).baseUrl,
    api.url + "/v1",
  );
});

test("rejected credentials and unavailable selections never persist partial providers", async (t) => {
  const rejected = await endpoint(t, (_req, res) => {
    res.writeHead(401);
    res.end("{}");
  });
  const store = memoryStore();
  await assert.rejects(
    saveProvider(store, input(rejected.url)),
    (error) => error.data?.code === "custom_provider_invalid_credentials",
  );
  assert.equal(store.read().providers.length, 0);
  const healthy = await endpoint(t);
  await assert.rejects(
    saveProvider(store, input(healthy.url, { models: ["missing-model"] })),
    (error) => error.data?.code === "custom_provider_model_unavailable",
  );
  assert.equal(store.read().providers.length, 0);
  assert.equal(
    healthy.requests.some((req) => req.body),
    false,
  );
  const badCompletion = await endpoint(t, (req, res) => {
    res.end(
      JSON.stringify(
        req.url.endsWith("/models") ? { data: [{ id: "fixture-model" }] } : {},
      ),
    );
  });
  await assert.rejects(
    saveProvider(store, input(badCompletion.url)),
    (error) => error.data?.code === "custom_provider_model_unavailable",
  );
  assert.equal(store.read().providers.length, 0);
});

test("malformed, oversized, and redirected discoveries have bounded actionable errors", async (t) => {
  const invalid = await endpoint(t, (_req, res) =>
    res.end("<html>not a model endpoint</html>"),
  );
  await assert.rejects(
    discover(input(invalid.url)),
    (error) => error.data?.code === "custom_provider_invalid_response",
  );
  const nullBody = await endpoint(t, (_req, res) => res.end("null"));
  await assert.rejects(
    discover(input(nullBody.url)),
    (error) => error.data?.code === "custom_provider_invalid_response",
  );
  const large = await endpoint(t, (_req, res) => {
    res.setHeader("content-length", 3 * 1024 * 1024);
    res.end("large");
  });
  await assert.rejects(
    discover(input(large.url)),
    (error) => error.data?.code === "custom_provider_response_too_large",
  );
  let destinationCalls = 0;
  const destination = await endpoint(t, (_req, res) => {
    destinationCalls++;
    res.end("{}");
  });
  const redirect = await endpoint(t, (_req, res) => {
    res.writeHead(302, { location: destination.url + "/models" });
    res.end();
  });
  await assert.rejects(
    discover(input(redirect.url)),
    (error) => error.data?.code === "custom_provider_endpoint_unreachable",
  );
  assert.equal(destinationCalls, 0);
});

test(
  "new keys and headers are encrypted, while an endpoint change cannot reuse saved credentials",
  { skip: process.platform !== "win32" },
  async (t) => {
    const api = await endpoint(t);
    const store = memoryStore();
    const request = input(api.url, {
      requiresAuth: true,
      apiKey: "fixture-secret-123",
      headers: { "x-extra-key": "fixture-header-456" },
    });
    const created = await saveProvider(store, request);
    assert.ok(!JSON.stringify(store.read()).includes("fixture-secret-123"));
    assert.ok(!JSON.stringify(store.read()).includes("fixture-header-456"));
    const provider = store.read().providers[0];
    const driver = await driverProvider(provider);
    assert.equal(driver.apiKey === request.apiKey, true);
    assert.equal(
      driver.headers["x-extra-key"] === request.headers["x-extra-key"],
      true,
    );
    const update = {
      ...request,
      providerId: created.providerId,
      apiKey: "",
      headers: undefined,
      displayName: "Edited fixture",
    };
    await saveProvider(store, update, true);
    assert.equal(store.read().providers[0].displayName, "Edited fixture");
    const other = await endpoint(t);
    await assert.rejects(
      saveProvider(store, { ...update, apiUrl: other.url }, true),
      (error) => error.data?.code === "custom_provider_api_key_required",
    );
    assert.equal(other.requests.length, 0);
    assert.equal(store.read().providers[0].apiUrl, api.url);
  },
);
