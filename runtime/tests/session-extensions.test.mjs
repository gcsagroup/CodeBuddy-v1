import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../store.mjs";
import { RuntimeSettings } from "../settings.mjs";
import {
  sealSessionExtensions,
  selectedExtensions,
  sessionMcpServers,
  harnessMcpServer,
  prepareHarnessMcpServer,
  resolveSessionExtensions,
} from "../session-extensions.mjs";
import { recipeExtensions } from "../recipe-execution.mjs";

test('new toolbox services reach following sessions while custom selections require explicit addition', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'toolbox-live-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const settings = new RuntimeSettings(store);
  await settings.initialize();
  const service = name => ({ type: 'mcp', server: { name, type: 'http', url: `http://127.0.0.1:1/${name}` } });
  const first = service('ledger'), added = service('inventory');
  await settings.saveExtension({ extension: first, enabled: true });
  const custom = { id: 'custom', extensionSelection: 'custom', ...await sealSessionExtensions([first]) };
  const follow = { id: 'follow', extensionSelection: 'follow' };
  const before = await resolveSessionExtensions(follow, settings);
  await settings.saveExtension({ extension: added, enabled: true });
  assert.throws(() => before.assertCurrent(follow), /changed/i, 'a pre-install snapshot cannot be admitted as current');
  const names = async session => (await selectedExtensions(session, settings)).map(entry => entry.configKey);
  assert.ok((await names(follow)).includes('inventory'));
  assert.deepEqual(await names(custom), ['ledger']);
  const expanded = { ...custom, ...await sealSessionExtensions([first, added]) };
  assert.deepEqual(await names(expanded), ['ledger', 'inventory']);
  await settings.request('config/extensions/set-enabled', { configKey: 'inventory', enabled: false });
  assert.ok(!(await names(follow)).includes('inventory'));
  assert.deepEqual(await names(expanded), ['ledger'], 'a saved selection cannot revive a disabled service');
});

test('official GitHub writes use host approvals instead of a deferred MCP form, including existing profiles', async () => {
  const extension={type:'mcp',server:{name:'github_official',type:'http',url:'https://api.githubcopilot.com/mcp/',headers:[{name:'x-mcp-features',value:'remote_mcp_ui_apps'}]}};
  const prepared=await harnessMcpServer(extension,{},process.cwd());
  assert.equal(prepared.headers['x-mcp-features'],'remote_mcp_ui_apps,mcp_apps_disable_form_deferral');
  assert.equal(prepared.headers['X-MCP-Features'],undefined);
  assert.equal(extension.server.headers[0].value,'remote_mcp_ui_apps','transport adaptation does not rewrite stored configuration');
  const custom=await harnessMcpServer({...extension,server:{...extension.server,url:'https://example.invalid/mcp'}},{},process.cwd());
  assert.equal(custom.headers['x-mcp-features'],'remote_mcp_ui_apps');
});

test("actual renderer object selections load enabled tools and never store cleartext MCP credentials", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "codebuddy-extension-selection-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const settings = new RuntimeSettings(store);
  await settings.initialize();
  const ext = {
    type: "mcp",
    server: {
      name: "fixture",
      type: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: [
        { name: "Authorization", value: "Bearer isolated-secret-value" },
      ],
    },
  };
  await settings.saveExtension({ extension: ext, enabled: true });
  const session = {
    id: "fixture",
    ...(await sealSessionExtensions(
      [{ type: "builtin", name: "developer" }, ext],
      [ext.server],
    )),
  };
  await store.update((s) => s.sessions.push(session));
  assert.deepEqual(
    (await selectedExtensions(session, settings)).map((x) => x.configKey),
    ["developer", "fixture"],
  );
  assert.ok(
    !(await readFile(path.join(directory, "state.json"), "utf8")).includes(
      "isolated-secret-value",
    ),
  );
  assert.equal(
    (await sessionMcpServers(session))[0].headers[0].value,
    "Bearer isolated-secret-value",
  );
  await settings.request("config/extensions/set-enabled", {
    configKey: "fixture",
    enabled: false,
  });
  assert.deepEqual(
    (await selectedExtensions(session, settings)).map((x) => x.configKey),
    ["developer"],
  );
  assert.deepEqual(
    await selectedExtensions(await sealSessionExtensions([]), settings),
    [],
  );
});

test("MCP environment interpolation fails on missing configuration and expands real saved values", async () => {
  const extension = {
    type: "mcp",
    envKeys: ["TOKEN"],
    server: {
      name: "fixture",
      type: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: [{ name: "Authorization", value: "Bearer ${TOKEN}" }],
    },
  };
  await assert.rejects(
    () => harnessMcpServer(extension, { config: {} }, process.cwd()),
    /Configure extension/,
  );
  const result = await harnessMcpServer(
    extension,
    { config: { TOKEN: { value: "fixture" } } },
    process.cwd(),
  );
  assert.equal(result.headers.Authorization, "Bearer fixture");
  assert.deepEqual(await prepareHarnessMcpServer(extension, { config: {} }, process.cwd()), {
    serverName: 'fixture', configurationError: 'Configure extension environment variable: TOKEN', missingEnvironmentVariable: 'TOKEN',
  });
  assert.deepEqual(await prepareHarnessMcpServer(extension, { config: { TOKEN: { value: 'fixture' } } }, process.cwd()), result);
  await assert.rejects(prepareHarnessMcpServer({ ...extension, server: { ...extension.server, url: 'file:///private' } },
    { config: { TOKEN: { value: 'fixture' } } }, process.cwd()), /HTTP extension URL/);
  await assert.rejects(prepareHarnessMcpServer(extension,
    { config: { TOKEN: { secret: { kind: 'invalid-fixture-secret' } } } }, process.cwd()), /Unknown credential format/);
});

test("HTTP recipe environment resolves URL and headers once, preserves inline precedence and stays protected at rest", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "codebuddy-http-recipe-env-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory),
    settings = new RuntimeSettings(store);
  await settings.initialize();
  const literal = "isolated-inline-http-token";
  const [extension] = recipeExtensions([
    {
      type: "streamable_http",
      name: "inline-fixture",
      uri: "http://127.0.0.1:${ PORT }/mcp/$ROUTE",
      headers: { Authorization: "Bearer ${ TOKEN }", "X-Once": "$ONCE" },
      envs: { PORT: "12345", TOKEN: literal, ONCE: "$NOT_RECURSIVE" },
      env_keys: ["TOKEN", "ROUTE"],
    },
  ]);
  const session = {
    id: "fixture",
    ...(await sealSessionExtensions([extension])),
  };
  await store.update((state) => state.sessions.push(session));
  const [selected] = await selectedExtensions(session, settings);
  const input = { PRESERVE: "input-only" };
  const result = await harnessMcpServer(
    selected.extension,
    {
      config: {
        TOKEN: { value: "lower-precedence-config" },
        ROUTE: { value: "tools" },
      },
    },
    directory,
    input,
  );
  assert.equal(result.url, "http://127.0.0.1:12345/mcp/tools");
  assert.equal(result.headers.Authorization, `Bearer ${literal}`);
  assert.equal(result.headers["X-Once"], "$NOT_RECURSIVE");
  assert.deepEqual(input, { PRESERVE: "input-only" });
  assert.equal(Object.hasOwn(process.env, "NOT_RECURSIVE"), false);
  assert.ok(
    !(await readFile(path.join(directory, "state.json"), "utf8")).includes(
      literal,
    ),
  );
  await assert.rejects(
    harnessMcpServer(extension, { config: {} }, directory),
    /Configure extension environment variable: ROUTE/,
  );
  const bad = structuredClone(extension);
  bad.server.url = "file:///tmp/mcp";
  await assert.rejects(
    harnessMcpServer(bad, { config: { ROUTE: { value: "tools" } } }, directory),
    /HTTP extension URL/,
  );
});
