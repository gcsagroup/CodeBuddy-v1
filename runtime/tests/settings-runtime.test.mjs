import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { Compat } from "../compat.mjs";
import { openStore } from "../store.mjs";
import { CODEPRO_ROLES } from "../roles.mjs";
import { commonQueryMetadata } from "../common-query-settings.mjs";

const ext = (name) => `_goose/unstable/${name}`;

test("common query settings reach the standalone tool without leaking other config", async () => {
  const f = await fixture();
  const key = "CODEBUDDY_COMMON_QUERIES";
  const value = { network_enabled: false, default_city: "上海", country_code: "CN", timezone: "Asia/Shanghai", units: "metric" };
  await f.compat.request(ext("config/upsert"), { key: "unrelated", value: "must-not-reach-query-process" });
  f.compat.initialized.add(f.session.id);
  await f.compat.request(ext("config/upsert"), { key, value });
  assert.equal(f.compat.initialized.has(f.session.id), true, "query settings are read per call and must not reconnect tools");
  const current = () => commonQueryMetadata(f.store)["codebuddy/common-query-settings"];
  assert.deepEqual(Object.keys(commonQueryMetadata(f.store)), ["codebuddy/common-query-settings"]);
  assert.deepEqual(current(), value);
  await assert.rejects(f.compat.request(ext("config/upsert"), { key, value: { ...value, network_enabled: "false" } }), /query settings/i);
  await assert.rejects(f.compat.request(ext("config/upsert"), { key, value, isSecret: true }), /query settings/i);
  for (const patch of [{ timezone: "not/a/zone" }, { timezone: "+01:00" }, { country_code: "CHINA" }, { unknown: true }])
    await assert.rejects(f.compat.request(ext("config/upsert"), { key, value: { ...value, ...patch } }), /query settings/i);
  assert.deepEqual(current(), value);
  await f.compat.request(ext("config/upsert"), { key, value: { ...value, timezone: "UTC" } });
  assert.equal(current().timezone, "UTC");
  await f.compat.request(ext("config/remove"), { key });
  assert.equal(f.compat.initialized.has(f.session.id), true, "removing query settings also uses live defaults");
  const reset = current();
  assert.equal(reset.network_enabled, true);
  assert.equal(reset.timezone, "");
  await f.store.update(s => { s.config[key] = { value: { network_enabled: "legacy-invalid" } }; });
  assert.throws(current, /query settings/i);
  await Promise.all(["Asia/Shanghai", "UTC"].map(timezone => f.compat.request(ext("config/upsert"), { key, value: { ...value, timezone } })));
  assert.equal(current().timezone, "UTC");
  await f.compat.request(ext("config/upsert"), { key: "unrelated", value: "new" });
  assert.equal(f.compat.initialized.has(f.session.id), false, "other configuration retains capability invalidation");
});
async function fixture({ codepro = false } = {}) {
  const directory = await realpath(await mkdtemp(
    path.join(tmpdir(), "codebuddy-settings-runtime-"),
  ));
  const store = await openStore(path.join(directory, "data"));
  const cwd = path.join(directory, "project");
  await mkdir(cwd);
  const provider = (id) => ({
    id,
    displayName: id,
    engine: "openai_compatible",
    apiUrl: "http://127.0.0.1:1",
    models: ["shared-model"],
    requiresAuth: false,
  });
  const session = {
    id: "session",
    cwd,
    providerId: "default-provider",
    modelId: "shared-model",
    type: codepro ? "code_pro" : "user",
    updates: [],
    messageCount: 0,
  };
  await store.update((state) => {
    state.providers = [provider("default-provider"), provider("role-provider")];
    state.sessions = [session];
    state.defaults = {
      providerId: session.providerId,
      modelId: session.modelId,
    };
    if (codepro)
      state.modelRouting = {
        version: 2,
        advancedRoutingEnabled: true,
        routes: CODEPRO_ROLES.map((role) => ({
          role,
          providerId: "role-provider",
          modelId: "shared-model",
        })),
        maxParallelCoders: 1,
        visionRoute: { enabled: false, mode: "disabled" },
      };
  });
  const created = [];
  const driver = {
    createSession: async (options) => {
      const { mcpImageFallback, mcpRequestMetadata, restoreSubagentProvider, ...serializableOptions } = options.options;
      assert.equal(typeof mcpImageFallback, "function");
      created.push(
        structuredClone({
          ...options,
          options: { ...serializableOptions, tools: [] },
        }),
      );
    },
    listTools: async () => [],
  };
  const compat = new Compat(store, driver);
  return { compat, store, created, session, driver };
}

test('settings model discovery accepts a healthy response slower than advisory metadata probing', async t => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.write('{"data":[');
    const timer = setTimeout(() => res.end('{"id":"slow-model"}]}'), 2300);
    res.once('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const f = await fixture();
  await f.store.update(state => {
    state.providers[0].apiUrl = `http://127.0.0.1:${server.address().port}`;
  });
  const before = f.store.read(['providers']).providers;
  const result = await f.compat.request(ext('providers/supported-models/list'), {
    providerId: 'default-provider',
  });
  assert.deepEqual(result.models, ['slow-model']);
  assert.deepEqual(f.store.read(['providers']).providers, before,
    'Discovery must not rewrite saved connections or model selections');
});

test("session prompt set replaces the base and append keeps separate keyed instructions through clear", async () => {
  const f = await fixture();
  await f.store.update((state) => {
    state.prompts = { system: "GLOBAL_BASE_INSTRUCTION" };
  });
  const update = (mode, text) =>
    f.compat.request(ext("session/system-prompt/set"), {
      sessionId: f.session.id,
      mode,
      key: "same-key",
      text,
    });
  await update("set", "SESSION_BASE_INSTRUCTION");
  await update("append", "EXTRA_INSTRUCTION");
  const current = () => f.compat.sessionOptions(f.compat.session(f.session.id));
  assert.equal(
    (await current()).systemPrompt,
    "SESSION_BASE_INSTRUCTION\n\nEXTRA_INSTRUCTION",
  );
  await update("set", "");
  assert.equal(
    (await current()).systemPrompt,
    "GLOBAL_BASE_INSTRUCTION\n\nEXTRA_INSTRUCTION",
  );
  await update("append", "");
  assert.equal((await current()).systemPrompt, "GLOBAL_BASE_INSTRUCTION");
});

test('native activation and extension preparation overlap before model admission', async () => {
  const f = await fixture({ codepro: true });
  const release = Promise.withResolvers(), entered = Promise.withResolvers();
  let discoveryStarted = false, reads = 0;
  const snapshot = f.compat.settings.extensionSnapshot.bind(f.compat.settings);
  f.compat.settings.extensionSnapshot = async () => { reads++; entered.resolve(); await release.promise; return snapshot(); };
  f.driver.listTools = async () => { discoveryStarted = true; return []; };
  const pending = f.compat.ensureSession(f.session);
  await entered.promise;
  try {
    assert.equal(discoveryStarted, true, 'Host startup must not wait for protected extension preparation');
    assert.equal(f.created.length, 0, 'No session/model admission with unfinished configuration');
  } finally { release.resolve(); await pending; }
  assert.equal(reads, 1, 'Do not decrypt the snapshot a second time');
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].provider.id, 'default-provider');
  assert.equal(Object.hasOwn(f.created[0].options, 'roleModels'), false);
  assert.equal(Object.hasOwn(f.created[0].options, 'maxParallelSubagents'), false);
});

test("toolbox retains structured output schema and normalizes original public permissions", async () => {
  const f = await fixture();
  await f.compat.settings.initialize();
  const outputSchema = {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
  };
  f.driver.listTools = async () => [
    {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
      },
      outputSchema,
    },
  ];
  await f.compat.request(ext("tools/permissions/set"), {
    toolPermissions: [
      { toolName: "developer__read", permission: "never_allow" },
    ],
  });
  const result = await f.compat.request(ext("tools/list"), {
    sessionId: f.session.id,
  });
  assert.equal(result.tools.length, 1);
  assert.deepEqual(result.tools[0].outputSchema, outputSchema);
  assert.equal(result.tools[0].name, "developer__read");
  assert.equal(result.tools[0].permission, "never_allow");
});

test("saving image capability refreshes an existing idle Harness session before its next use", async () => {
  const f = await fixture();
  await f.compat.ensureSession(f.session);
  await f.compat.request(ext("model-capabilities/save"), {
    config: {
      version: 1,
      overrides: [
        {
          providerId: f.session.providerId,
          modelId: f.session.modelId,
          imageInput: "force_supported",
        },
      ],
    },
  });
  await f.compat.ensureSession(f.session);
  assert.equal(
    f.created.length,
    2,
    "saved model capability must reach the existing session",
  );
  assert.deepEqual(f.created.at(-1).provider.inputModalities, [
    "text",
    "image",
  ]);
});

test("current session model owns image capability even with obsolete advanced routing", async () => {
  const f = await fixture({ codepro: true });
  await f.compat.request(ext("model-capabilities/save"), {
    config: {
      version: 1,
      overrides: [
        {
          providerId: "role-provider",
          modelId: "shared-model",
          imageInput: "force_unsupported",
        },
        {
          providerId: "default-provider",
          modelId: "shared-model",
          imageInput: "force_supported",
        },
      ],
    },
  });
  await f.compat.ensureSession(f.session);
  assert.equal(f.created[0].provider.id, "default-provider");
  assert.deepEqual(
    f.created[0].provider.inputModalities,
    ["text", "image"],
    "current session provider owns capability lookup",
  );
});

test("deleting the current model provider is rejected before settings mutate", async () => {
  const f = await fixture({ codepro: true });
  await f.compat.ensureSession(f.session);
  f.compat.active.set(f.session.id, { run: { runId: "active-project" } });
  await assert.rejects(
    f.compat.request(ext("providers/custom/delete"), {
      providerId: "default-provider",
    }),
    /Stop active sessions/,
  );
  assert.ok(
    f.store
      .read()
      .providers.some((provider) => provider.id === "default-provider"),
  );
});

test("obsolete role providers do not become execution dependencies or block unrelated deletion", async () => {
  const f = await fixture({ codepro: true });
  await f.compat.ensureSession(f.session);
  f.compat.active.set(f.session.id, {
    driverStarted: true,
    run: { runId: "active-project" },
  });
  await f.compat.request(ext("providers/custom/delete"), { providerId: "role-provider" });
  assert.equal(
    f.store
      .read()
      .providers.some((provider) => provider.id === "role-provider"),
    false,
  );
  f.compat.active.delete(f.session.id);
  await f.compat.ensureSession(f.session);
  assert.equal(f.created.at(-1).provider.id, 'default-provider');
});

test('an unavailable current session model is rejected instead of falling back to an obsolete role model', async () => {
  const f = await fixture({ codepro: true });
  await f.store.update(state => { state.providers.find(provider => provider.id === 'default-provider').models = []; });
  await assert.rejects(f.compat.ensureSession(f.session), /current session model/);
  assert.equal(f.created.length, 0);
});

test("listing tools after global preference save does not reconfigure an active Harness session", async () => {
  const f = await fixture();
  await f.compat.ensureSession(f.session);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  f.driver.prompt = async () => {
    entered.resolve();
    await finish.promise;
    return { stopReason: "end_turn" };
  };
  const prompt = f.compat.request(
    "session/prompt",
    {
      sessionId: f.session.id,
      prompt: [{ type: "text", text: "controlled active request" }],
    },
    { notify() {} },
  );
  await entered.promise;
  try {
    await f.compat.request(ext("preferences/save"), {
      expectedRevision: 0,
      values: [{ key: "gooseThinkingEffort", value: "high" }],
    });
    await f.compat.request(ext("tools/list"), { sessionId: f.session.id });
    assert.equal(
      f.created.length,
      1,
      "active tool registrations must remain stable until this prompt quiesces",
    );
  } finally {
    finish.resolve();
    await prompt;
  }
  await f.compat.ensureSession(f.session);
  assert.equal(f.created.length, 2);
  assert.equal(f.created[1].options.thinkingEffort, undefined, "unknown models must not inherit undeclared reasoning controls from legacy global preferences");
});

test("changing a saved MCP configuration value refreshes the next idle session connection", async () => {
  const f = await fixture();
  await f.store.update((state) =>
    state.extensions.push({
      configKey: "fixture_mcp",
      enabled: true,
      extension: {
        type: "mcp",
        envKeys: ["FIXTURE_VALUE"],
        server: {
          name: "fixture_mcp",
          type: "http",
          url: "http://127.0.0.1:1/mcp",
          headers: [{ name: "Authorization", value: "${FIXTURE_VALUE}" }],
        },
      },
    }),
  );
  await f.compat.request(ext("config/upsert"), {
    key: "FIXTURE_VALUE",
    value: "fixture-old",
    isSecret: false,
  });
  await f.compat.ensureSession(f.session);
  assert.equal(
    f.created[0].options.mcpServers[0].headers.Authorization,
    "fixture-old",
  );
  await f.compat.request(ext("config/upsert"), {
    key: "FIXTURE_VALUE",
    value: "fixture-new",
    isSecret: false,
  });
  await f.compat.ensureSession(f.session);
  assert.equal(
    f.created.at(-1).options.mcpServers[0].headers.Authorization,
    "fixture-new",
    "saved MCP environment must replace cached connection configuration",
  );
});

test("enabled detection with unavailable classification escalates auto mode to one-time approval", async () => {
  const f = await fixture();
  await f.compat.settings.initialize();
  await f.store.update((state) => {
    state.preferences.gooseMode = "auto";
    state.config.SECURITY_PROMPT_ENABLED = { value: true };
  });
  const asked = [];
  const connection = {
    ask: async (method, params) => {
      asked.push({ method, params });
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    },
  };
  const call = { name: 'pwsh', arguments: { command: 'Write-Output fixture' } };
  assert.equal((await f.compat.toolPolicy(f.session, call)).kind, 'ask');
  assert.equal(
    await f.compat.approveTool(
      f.session,
      call,
      connection,
      new AbortController().signal,
    ),
    true,
  );
  assert.equal(asked.length, 1);
  assert.equal(
    asked[0].params.options.some((x) => x.optionId === "allow_always"),
    false,
  );
  assert.ok(asked[0].params.toolCall.content[0].content.text);
  await f.store.update((state) => {
    state.toolPermissions = { developer__pwsh: "never_allow" };
  });
  assert.equal(
    await f.compat.approveTool(
      f.session,
      { name: "pwsh", arguments: { command: "Write-Output fixture" } },
      connection,
      new AbortController().signal,
    ),
    false,
  );
  assert.equal(
    asked.length,
    1,
    "deny remains stronger than a scanner or approval",
  );
});

test("toolbox disables native schemas and exposes stored public-name permissions to the UI", async () => {
  const f = await fixture();
  await f.compat.settings.initialize();
  f.driver.listTools = async () => [
    { name: "read", parameters: { type: "object" } },
    { name: "pwsh", parameters: { type: "object" } },
  ];
  await f.compat.request(ext("tools/permissions/set"), {
    toolPermissions: [
      { toolName: "developer__read", permission: "always_allow" },
    ],
  });
  const enabled = await f.compat.request(ext("tools/list"), {
    sessionId: f.session.id,
  });
  assert.equal(
    enabled.tools.find((x) => x.name === "developer__read").permission,
    "always_allow",
  );
  await f.compat.request(ext("config/extensions/set-enabled"), {
    configKey: "developer",
    enabled: false,
  });
  const disabled = await f.compat.request(ext("tools/list"), {
    sessionId: f.session.id,
  });
  assert.equal(disabled.tools.length, 0);
  assert.deepEqual(f.created.at(-1).options.toolFilter.allow, []);
});

test("failed MCP connection status is returned to the original extension toast contract", async () => {
  const f = await fixture();
  f.driver.extensionStatus = () => [
    { serverName: "working", status: "ready" },
    { serverName: "offline", status: "error", error: "Connection failed" },
  ];
  assert.deepEqual(await f.compat.extensionResults(f.session), [
    { name: "working", success: true },
    { name: "offline", success: false, error: "Connection failed" },
  ]);
});
