import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { openStore } from "../store.mjs";
import { protectSecret } from "../secrets.mjs";
import {
  TranscriptionService,
  transcriptionEndpoint,
} from "../transcription.mjs";
import {
  zDictationConfigResponse_unstable,
  zDictationTranscribeRequest_unstable,
  zDictationTranscribeResponse_unstable,
} from "../../ui/sdk/dist/generated/zod.gen.js";

const method = (name) => `_goose/unstable/dictation/${name}`;
const apiKey = "isolated-dictation-fixture-key";
function wav() {
  const bytes = Buffer.alloc(44 + 6400);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
const audio = wav();
const input = (provider) =>
  zDictationTranscribeRequest_unstable.parse({
    provider,
    audio: audio.toString("base64"),
    mimeType: "audio/wav",
  });

async function fixture(t, options = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-dictation-")),
  );
  const store = await openStore(root);
  const service = new TranscriptionService(store, options);
  t.after(async () => {
    service.close();
    await store.flush();
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codebuddy-dictation-"));
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, service };
}

async function endpoint(t, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      const webRequest = new Request("http://fixture" + request.url, {
        method: request.method,
        headers: request.headers,
        body: Readable.toWeb(request),
        duplex: "half",
      });
      const form = await webRequest.formData();
      const file = form.get("file");
      requests.push({
        url: request.url,
        headers: request.headers,
        model: form.get("model"),
        modelId: form.get("model_id"),
        type: file.type,
        filename: file.name,
        audio: Buffer.from(await file.arrayBuffer()),
      });
      response.setHeader("content-type", "application/json");
      if (handler) await handler(request, response);
      else
        response.end(JSON.stringify({ text: "这是本地服务夹具的转写结果。" }));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test("dictation configuration follows original SDK and secrets persist protected with no unrelated-provider fallback", async (t) => {
  const { root, store, service } = await fixture(t);
  await store.update((state) => {
    state.providers.push({
      id: "unrelated",
      engine: "ollama_compatible",
      apiUrl: "https://ollama.example",
      requiresAuth: false,
    });
    state.defaults.providerId = "unrelated";
  });
  const original = zDictationConfigResponse_unstable.parse(
    await service.request(method("config")),
  );
  assert.equal(original.providers.openai.configured, false);
  assert.equal(original.providers.openai.usesProviderConfig, true);
  assert.equal(original.providers.elevenlabs.defaultModel, "scribe_v2");
  assert.equal(Object.hasOwn(original.providers, "local"), false);
  for (const provider of ["groq", "elevenlabs"])
    await service.request(method("secret/save"), { provider, value: apiKey });
  const saved = await readFile(path.join(root, "state.json"), "utf8");
  assert.equal(saved.includes(apiKey), false);
  const reopened = new TranscriptionService(await openStore(root));
  try {
    const current = zDictationConfigResponse_unstable.parse(
      await reopened.request(method("config")),
    );
    assert.equal(current.providers.groq.configured, true);
    assert.equal(current.providers.elevenlabs.configured, true);
    assert.equal(JSON.stringify(current).includes(apiKey), false);
    await reopened.request(method("secret/delete"), { provider: "groq" });
    assert.equal(
      (await reopened.request(method("config"))).providers.groq.configured,
      false,
    );
  } finally {
    reopened.close();
  }
  await assert.rejects(
    service.request(method("secret/save"), {
      provider: "openai",
      value: apiKey,
    }),
    /model provider settings/u,
  );
  await assert.rejects(
    service.request(method("secret/save"), {
      provider: "__proto__",
      value: apiKey,
    }),
    /Unknown/u,
  );
  await assert.rejects(
    service.request(method("secret/save"), {
      provider: "groq",
      value: "header\ninjection",
    }),
    /Invalid/u,
  );
  assert.equal(service.handles(method("transcribe")), true);
  assert.equal(await service.request("unrelated"), undefined);
});

test("OpenAI endpoint resolution preserves explicit gateway prefixes and query while rejecting credential URLs", () => {
  assert.equal(
    transcriptionEndpoint("https://example.test").href,
    "https://example.test/v1/audio/transcriptions",
  );
  assert.equal(
    transcriptionEndpoint("https://example.test/gateway/v1?api-version=test")
      .href,
    "https://example.test/gateway/v1/audio/transcriptions?api-version=test",
  );
  assert.equal(
    transcriptionEndpoint("https://example.test/custom/api").href,
    "https://example.test/custom/api/audio/transcriptions",
  );
  assert.equal(
    transcriptionEndpoint("https://example.test/v1/audio/transcriptions").href,
    "https://example.test/v1/audio/transcriptions",
  );
  assert.throws(
    () => transcriptionEndpoint("https://user:private@example.test/v1"),
    /without embedded/u,
  );
  assert.throws(() => transcriptionEndpoint("file:///tmp/audio"), /HTTP/u);
});

test("three original providers send actual multipart audio, model and authentication to a controlled HTTP fixture", async (t) => {
  const remote = await endpoint(t);
  const targets = [];
  const { store, service } = await fixture(t, {
    resolveOpenAI: async () => ({
      baseUrl: `${remote.url}/gateway/v1?version=fixture`,
      apiKey,
      headers: {
        "X-Fixture": "configured-header",
        "Content-Type": "application/json",
      },
      configured: true,
    }),
    fetch: (url, options) => {
      targets.push(String(url));
      return fetch(
        `${remote.url}${new URL(url).pathname}${new URL(url).search}`,
        options,
      );
    },
  });
  for (const provider of ["groq", "elevenlabs"])
    await service.request(method("secret/save"), { provider, value: apiKey });
  await store.update((state) => {
    state.config.OPENAI_TRANSCRIPTION_MODEL = {
      value: "explicit-speech-model",
    };
  });
  for (const provider of ["openai", "groq", "elevenlabs"]) {
    const output = zDictationTranscribeResponse_unstable.parse(
      await service.request(method("transcribe"), input(provider)),
    );
    assert.equal(output.text, "这是本地服务夹具的转写结果。");
  }
  assert.deepEqual(targets, [
    `${remote.url}/gateway/v1/audio/transcriptions?version=fixture`,
    "https://api.groq.com/openai/v1/audio/transcriptions",
    "https://api.elevenlabs.io/v1/speech-to-text",
  ]);
  assert.equal(remote.requests.length, 3);
  assert.equal(remote.requests[0].model, "explicit-speech-model");
  assert.equal(remote.requests[0].headers["x-fixture"], "configured-header");
  assert.equal(remote.requests[1].model, "whisper-large-v3-turbo");
  assert.equal(remote.requests[2].modelId, "scribe_v2");
  assert.equal(remote.requests[2].model, null);
  assert.equal(remote.requests[0].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(remote.requests[1].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(remote.requests[2].headers["xi-api-key"], apiKey);
  for (const request of remote.requests) {
    assert.deepEqual(request.audio, audio);
    assert.equal(request.filename, "audio.wav");
    assert.equal(request.type, "audio/wav");
    assert.match(
      request.headers["content-type"],
      /^multipart\/form-data; boundary=/u,
    );
  }
});

test("explicit model-provider identity and original encrypted OpenAI configuration are reused without exposing credentials", async (t) => {
  const remote = await endpoint(t);
  const { store, service } = await fixture(t);
  await store.update(async (state) => {
    state.providers.push({
      id: "selected-openai",
      catalogProviderId: "openai",
      engine: "openai_compatible",
      apiUrl: `${remote.url}/v1`,
      models: ["chat"],
      requiresAuth: true,
      secret: await protectSecret(apiKey),
    });
    state.defaults.providerId = "selected-openai";
  });
  assert.equal(
    (await service.request(method("config"))).providers.openai.configured,
    true,
  );
  await service.request(method("transcribe"), input("openai"));
  assert.equal(remote.requests[0].headers.authorization, `Bearer ${apiKey}`);
  await store.update(async (state) => {
    state.config.OPENAI_BASE_URL = {
      value: `${remote.url}/legacy/v1?version=hidden-query`,
    };
    state.config.OPENAI_API_KEY = {
      secret: await protectSecret("separate-fixture-key"),
    };
  });
  const status = await service.request(method("config"));
  assert.equal(status.providers.openai.host, `${remote.url}/legacy/v1`);
  assert.equal(JSON.stringify(status).includes("hidden-query"), false);
  await service.request(method("transcribe"), input("openai"));
  assert.equal(
    remote.requests[1].url,
    "/legacy/v1/audio/transcriptions?version=hidden-query",
  );
  assert.equal(
    remote.requests[1].headers.authorization,
    "Bearer separate-fixture-key",
  );
  await store.update((state) => {
    delete state.config.OPENAI_BASE_URL;
    state.config.OPENAI_HOST = { value: `${remote.url}/legacy-host` };
  });
  await service.request(method("transcribe"), input("openai"));
  assert.equal(remote.requests[2].url, "/legacy-host/v1/audio/transcriptions");
});

test("malformed audio, unsupported local inference and missing configuration fail before network requests", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, {
    fetch: () => {
      calls++;
      throw Error("Unexpected network");
    },
    maxAudioBytes: 10_000,
  });
  await assert.rejects(
    service.request(method("transcribe"), input("openai")),
    (error) => error.data.reason === "dictation_not_configured",
  );
  await assert.rejects(
    service.request(method("transcribe"), input("local")),
    (error) => error.data.reason === "local_dictation_unavailable",
  );
  const corrupt = Buffer.from(audio);
  corrupt.writeUInt32LE(48000, 24);
  for (const change of [
    { audio: "" },
    { audio: "a===" },
    { audio: Buffer.alloc(10001).toString("base64") },
    { audio: corrupt.toString("base64") },
    { mimeType: "text/plain" },
  ]) {
    await assert.rejects(
      service.request(method("transcribe"), { ...input("openai"), ...change }),
      (error) => error.code === -32602,
    );
  }
  assert.equal(calls, 0);
});

test("upstream errors, redirects and oversized/malformed responses never echo secrets or claim text success", async (t) => {
  const cases = [
    { status: 401, body: apiKey, reason: "dictation_authentication_failed" },
    { status: 429, body: apiKey, reason: "dictation_rate_limited" },
    { status: 302, body: apiKey, reason: "dictation_service_error" },
    { status: 200, body: "invalid JSON with " + apiKey },
    { status: 200, body: JSON.stringify({ wrong: apiKey }) },
    { status: 200, body: JSON.stringify({ text: "x".repeat(300) }) },
  ];
  const { service } = await fixture(t, {
    resolveOpenAI: async () => ({
      baseUrl: "https://example.test/v1",
      apiKey,
      configured: true,
    }),
    maxResponseBytes: 128,
    fetch: async (_url, options) => {
      assert.equal(options.redirect, "manual");
      const next = cases.shift();
      return new Response(next.body, {
        status: next.status,
        headers: { location: "https://other.test/" },
      });
    },
  });
  while (cases.length) {
    const expected = cases[0];
    await assert.rejects(
      service.request(method("transcribe"), input("openai")),
      (error) => {
        assert.equal(
          JSON.stringify({ message: error.message, data: error.data }).includes(
            apiKey,
          ),
          false,
        );
        if (expected.reason) assert.equal(error.data.reason, expected.reason);
        return error.code === -32602;
      },
    );
  }
});

test("disconnect, timeout and shutdown cancel in-flight requests without affecting unrelated connections", async (t) => {
  const started = [];
  const { service } = await fixture(t, {
    resolveOpenAI: async () => ({
      baseUrl: "https://example.test/v1",
      configured: true,
    }),
    timeoutMs: 500,
    fetch: async (_url, options) =>
      new Promise((resolve, reject) => {
        started.push({ resolve, signal: options.signal });
        options.signal.addEventListener(
          "abort",
          () => reject(Error("fixture private transport failure")),
          { once: true },
        );
      }),
  });
  const firstOwner = {},
    secondOwner = {};
  const first = service.request(
    method("transcribe"),
    input("openai"),
    firstOwner,
  );
  const second = service.request(
    method("transcribe"),
    input("openai"),
    secondOwner,
  );
  const firstAssertion = assert.rejects(
    first,
    (error) => error.data.reason === "dictation_cancelled",
  );
  while (started.length < 2)
    await new Promise((resolve) => setImmediate(resolve));
  service.disconnect(firstOwner);
  await firstAssertion;
  assert.equal(started[1].signal.aborted, false);
  started[1].resolve(Response.json({ text: "second request preserved" }));
  assert.deepEqual(await second, { text: "second request preserved" });
  service.timeoutMs = 10;
  await assert.rejects(
    service.request(method("transcribe"), input("openai")),
    (error) => error.data.reason === "dictation_timeout",
  );
  service.timeoutMs = 500;
  const closing = service.request(
    method("transcribe"),
    input("openai"),
    secondOwner,
  );
  const closingAssertion = assert.rejects(
    closing,
    (error) => error.data.reason === "dictation_cancelled",
  );
  while (started.length < 4)
    await new Promise((resolve) => setImmediate(resolve));
  service.close();
  await closingAssertion;
  await assert.rejects(service.request(method("config")), /closed/u);
});

test("remote ASR sends the configured endpoint and Qwen model without requiring an API key", async () => {
  const config = {};
  const calls = [];
  const service = new TranscriptionService({ read: () => ({ config }) }, {
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ text: "测试语音 submit (保留原文)" }), { headers: { "content-type": "application/json" } });
    },
  });
  try {
    const result = await service.request(method("transcribe"), input("remote"));
    assert.equal(result.text, "测试语音 submit (保留原文)");
    assert.equal(calls[0].url, "http://192.168.50.231:18003/v1/audio/transcriptions");
    assert.equal(calls[0].options.body.get("model"), "Qwen3-ASR-0.6B");
    assert.deepEqual(Buffer.from(await calls[0].options.body.get("file").arrayBuffer()), audio);
    assert.equal(calls[0].options.headers.has("authorization"), false);
    config.SPEECH_SERVICES = { value: { REMOTE_ASR_URL: "https://example.test/custom/transcribe", REMOTE_ASR_MODEL: "another-asr" } };
    await service.request(method("transcribe"), input("remote"));
    assert.equal(calls[1].url, config.SPEECH_SERVICES.value.REMOTE_ASR_URL);
    assert.equal(calls[1].options.body.get("model"), "another-asr");
  } finally { service.close(); }
});

test("recognition availability rejects transport errors and unhealthy status while allowing POST-only routes", async () => {
  for (const status of [200, 405, 401, 404, 503]) {
    const service = new TranscriptionService({ read: () => ({ config: {} }) }, {
      fetch: async (_url, options) => {
        assert.equal(options.method, 'HEAD');
        return new Response(null, { status });
      },
    });
    try {
      if (status === 200 || status === 405) assert.deepEqual(await service.request(method('check'), { provider: 'remote' }), { available: true });
      else await assert.rejects(service.request(method('check'), { provider: 'remote' }), /语音识别服务不可用/);
    } finally { service.close(); }
  }
  const service = new TranscriptionService({ read: () => ({ config: {} }) }, { fetch: async () => { throw new Error('connection refused'); } });
  try { await assert.rejects(service.request(method('check'), { provider: 'remote' }), /语音识别服务不可用/); }
  finally { service.close(); }
});

test('startup availability is shared and cached for both success and failure', async () => {
  for (const status of [405, 503]) {
    let probes = 0;
    const service = new TranscriptionService({ read: () => ({ config: {} }) }, {
      fetch: async () => { probes++; return new Response(null, { status }); },
    });
    try {
      await service.startAvailabilityCheck('remote');
      assert.equal(probes, 1);
      const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => service.request(method('check'), { provider: 'remote' })));
      assert.equal(probes, 1);
      assert.ok(attempts.every(result => result.status === (status === 405 ? 'fulfilled' : 'rejected')));
    } finally { service.close(); }
  }
});

test('manual availability refresh recovers a cached startup failure without probing on activation', async () => {
  let probes = 0;
  let status = 503;
  const service = new TranscriptionService({ read: () => ({ config: {} }) }, {
    fetch: async () => { probes++; return new Response(null, { status }); },
  });
  try {
    await service.startAvailabilityCheck('remote');
    status = 405;
    await assert.rejects(service.request(method('check'), { provider: 'remote' }), /HTTP 503/);
    assert.equal(probes, 1);
    assert.deepEqual(await service.request(method('check'), { provider: 'remote', refresh: true }), { available: true });
    await service.request(method('check'), { provider: 'remote' });
    assert.equal(probes, 2);
  } finally { service.close(); }
});

test('availability expires failures and invalidates changed speech settings', async t => {
  let now = 1000, status = 503, probes = 0;
  const config = {};
  t.mock.method(Date, 'now', () => now);
  const service = new TranscriptionService({ read: () => ({ config }) }, {
    fetch: async () => { probes++; return new Response(null, { status }); },
  });
  try {
    await assert.rejects(service.check('remote'), /HTTP 503/);
    status = 405; now += 5001;
    assert.deepEqual(await service.check('remote'), { available: true });
    assert.equal(probes, 2);
    config.SPEECH_SERVICES = { value: { REMOTE_ASR_URL: 'http://localhost:1234/transcribe' } };
    await service.check('remote');
    assert.equal(probes, 3);
    now += 60001;
    await service.check('remote');
    assert.equal(probes, 4);
  } finally { service.close(); }
});

test('availability retains safe transport reasons without exposing upstream messages', async () => {
  const service = new TranscriptionService({ read: () => ({ config: {} }) }, {
    fetch: async () => { throw Object.assign(new Error('secret-token'), { cause: { code: 'ECONNREFUSED' } }); },
  });
  try {
    await assert.rejects(service.check('remote'), error => error.message.includes('拒绝连接') && !error.message.includes('secret-token'));
  } finally { service.close(); }
});

test('voice configuration and availability never copy conversation history', async () => {
  const reads = [];
  const store = {
    read(keys) {
      assert.ok(Array.isArray(keys), 'speech reads must be scoped');
      assert.ok(keys.every(key => ['config', 'providers', 'defaults'].includes(key)), 'speech must not read session history');
      reads.push(keys);
      return { config: {}, providers: [], defaults: {} };
    },
  };
  const service = new TranscriptionService(store, {
    fetch: async (_url, options) => options.method === 'HEAD'
      ? new Response(null, { status: 405 })
      : new Response(JSON.stringify({ text: 'hello' })),
  });
  try {
    await service.startAvailabilityCheck('remote');
    const config = await service.request(method('config'));
    assert.equal(config.providers.remote.configured, true);
    await service.request(method('check'), { provider: 'remote' });
    assert.equal((await service.request(method('transcribe'), input('remote'))).text, 'hello');
    assert.ok(reads.length > 0);
  } finally { service.close(); }
});
