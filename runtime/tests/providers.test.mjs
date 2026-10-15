import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  discover,
  driverProvider,
  inventory,
  resolvedInventory,
  modelBase,
  readProvider,
  saveProvider,
} from "../providers.mjs";
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
  assert.equal((await driverProvider(provider, 'invalid')).contextWindow, undefined);
  assert.equal((await driverProvider(provider, 'absent')).contextWindow, undefined);
  assert.equal(api.requests.length, 1);
  const changed = await endpoint(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'fixture-model', max_model_len: 8192 }] })));
  assert.equal((await driverProvider({ ...provider, apiUrl: changed.url }, 'fixture-model')).contextWindow, 8192);
});

test('unavailable model metadata keeps completions usable and does not retry for every session', async t => {
  const api = await endpoint(t, (_req, res) => { res.writeHead(404); res.end('{}'); });
  const provider = { ...input(api.url), id: 'offline-metadata' };
  assert.equal((await driverProvider(provider, 'fixture-model')).contextWindow, undefined);
  assert.equal((await driverProvider(provider, 'fixture-model')).contextWindow, undefined);
  assert.equal(api.requests.length, 1);
  assert.equal(inventory(provider).models[0].contextLimit, 32768);
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
  assert.equal((await resolvedInventory(unavailable)).models[0].contextLimit, 32768);
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
  assert.equal(inventory(provider).models[0].contextLimit, 32768, 'desktop displays the operational Harness context limit instead of its 128k fallback');
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
