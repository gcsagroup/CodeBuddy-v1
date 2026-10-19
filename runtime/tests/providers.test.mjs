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

test('Ollama cloud details supply capacity once per model; local architectural limits are not adopted', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url, options={})=>{
    calls.push({url:String(url),body:options.body});
    return new Response(JSON.stringify(String(url).endsWith('/api/show')
      ? {model_info:{'kimi-k3.context_length':1048576}, capabilities:['completion','vision','thinking']}
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
  assert.equal(api.requests.at(-1).body.max_tokens, 1);
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
  const api = await endpoint(t);
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
  assert.equal(api.requests.at(-1).body.max_output_tokens, 1);
  assert.equal(api.requests.at(-1).body.input, "Reply OK.");
});

test("Ollama UI engine discovers tags and uses the compatible completion endpoint", async (t) => {
  const api = await endpoint(t);
  const store = memoryStore();
  await saveProvider(store, input(api.url, { engine: "ollama_compatible" }));
  assert.deepEqual(
    api.requests.map((req) => req.url),
    ["/api/tags", "/v1/chat/completions"],
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
