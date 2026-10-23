import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { existsSync } from 'node:fs';
import {
  builtinMcp,
  builtinToolNames,
  isBuiltinMcp,
  listAvailableBuiltins,
  toTestExtension,
} from "../builtin-extensions.mjs";
import { createHarnessDriver } from "../harness/index.mjs";
import { openStore } from "../store.mjs";
import { commonQueryMetadata, COMMON_QUERY_KEY } from "../common-query-settings.mjs";

const nativeArtifactsPrepared = process.platform === 'win32' && process.arch === 'x64' ||
  process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch) &&
  existsSync(new URL('../tools/artifacts.json', import.meta.url));

test("standalone query MCP uses current settings in an already connected Harness session", { skip: !nativeArtifactsPrepared, timeout: 60_000 }, async t => {
  const options = await fixture(t);
  const store = await openStore(options.dataDir);
  await store.update(s => { s.config[COMMON_QUERY_KEY] = { value: { network_enabled: false, timezone: "Asia/Shanghai" } }; });
  const driver = await createHarnessDriver({ dataDir: path.join(options.root, "harness"), cwd: options.cwd });
  try {
    const config = await builtinMcp({ type: "builtin", name: "commonqueries" }, options);
    const { sessionId } = await driver.createSession({ cwd: options.cwd, provider: { id: "query-fixture", protocol: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused" }, model: "fixture-model", options: { mcpServers: [config], mcpRequestMetadata: name => name === "commonqueries" ? commonQueryMetadata(store) : undefined } });
    const call = name => driver.callTool(sessionId, `mcp__commonqueries__${name}`, {}, { onPermission: () => true });
    const first = await call("time_now");
    assert.equal(first.isError, false);
    assert.match(JSON.stringify(first.content), /Asia\/Shanghai/);
    const disabled = await call("weather_get");
    assert.equal(disabled.isError, true);
    assert.match(JSON.stringify(disabled.content), /network_disabled/);
    await store.update(s => { s.config[COMMON_QUERY_KEY].value.timezone = "UTC"; });
    const updated = await call("time_now");
    assert.equal(updated.isError, false);
    assert.match(JSON.stringify(updated.content), /UTC/);
  } finally { await driver.close(); }
});

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-builtin-mcp-")),
  );
  const cwd = path.join(root, "workspace"),
    dataDir = path.join(root, "data");
  await mkdir(cwd);
  await mkdir(dataDir);
  t.after(async () => {
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codebuddy-builtin-mcp-"));
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, dataDir };
}

test("legacy document configuration reconnects with residual tools and upstream Office skills", { skip: !nativeArtifactsPrepared, timeout: 60_000 }, async t => {
  const options = await fixture(t);
  const dataDir = path.join(options.root, "harness-office-migration");
  const config = await builtinMcp({ type: "builtin", name: "computercontroller" }, options);
  let driver = await createHarnessDriver({ dataDir, cwd: options.cwd });
  let sessionId;
  try {
    ({ sessionId } = await driver.createSession({ cwd: options.cwd,
      provider: { id: "office-fixture", protocol: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused" },
      model: "fixture", options: { mcpServers: [config] } }));
    await driver.close();
    driver = await createHarnessDriver({ dataDir, cwd: options.cwd });
    await driver.configureSession(sessionId, { mcpServers: [config] });
    const names = (await driver.listTools(sessionId)).map(tool => tool.name);
    assert.deepEqual(names.filter(name => name.startsWith("mcp__computercontroller__")).sort(),
      ["cache", "pdf_tool", "web_scrape"].map(name => `mcp__computercontroller__${name}`).sort());
    for (const name of ["office-docx", "office-xlsx", "office-pptx"]) {
      assert.ok((await driver.listSkills(sessionId)).some(skill => skill.name === name));
    }
    const discovery = await driver.callTool(sessionId, "search_mcp_tools", { names: ["skill", "load_workspace_dependencies"] }, { onPermission: () => true });
    assert.equal(discovery.isError, false);
    assert.ok(names.includes('skill'), 'Skills remain directly callable without deferred discovery');
    assert.deepEqual(discovery.value.tools.map(tool => tool.name), ['load_workspace_dependencies']);
    const skill = await driver.callTool(sessionId, 'skill', { name: 'office-docx' }, { onPermission: () => true });
    assert.equal(skill.isError, false);
    const cache = await driver.callTool(sessionId, "mcp__computercontroller__cache", { command: "list" }, { onPermission: () => true });
    assert.equal(cache.isError, false);
  } finally { await driver.close(); }
});

test("bundled catalog validates pinned artifacts and reports unsupported platforms explicitly", async () => {
  const catalog = await listAvailableBuiltins();
  assert.deepEqual(catalog.map((row) => row.configKey).sort(), [
    "autovisualiser",
    "commonqueries",
    "computercontroller",
    "playwright",
    "playwright_user",
    "qwen_computer",
  ]);
  for (const row of catalog) {
    assert.equal(
      row.available,
      row.configKey.startsWith("playwright") ? true : nativeArtifactsPrepared,
      row.reason,
    );
    assert.equal(row.enabled, false);
    assert.equal(row.extension.type, "builtin");
  }
  for (const row of await listAvailableBuiltins({
    platform: "linux",
    arch: "arm64",
  })) {
    assert.equal(row.available, false);
    assert.match(row.reason, /linux\/arm64/u);
  }
  assert.equal(isBuiltinMcp({ type: "mcp", name: "qwen_computer" }), false);
  assert.equal(isBuiltinMcp({ type: "builtin", name: "__proto__" }), false);
  assert.deepEqual(builtinToolNames("__proto__"), []);
  if (process.platform !== 'win32') return;
  const provenance = JSON.parse(
    await readFile(
      new URL("../tools/provenance.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(provenance.artifacts.length, 2);
  assert.equal(provenance.artifacts.find(artifact => artifact.name === "codebuddy-tools").rebuiltForThisRevision, true);
  assert.equal(provenance.artifacts.find(artifact => artifact.name === "qwen-computer-use").rebuiltForThisRevision, false);
  assert.deepEqual(provenance.artifacts.map((row) => row.license).sort(), [
    "Apache-2.0",
    "MIT",
  ]);
});

test(
  "builtin launch uses fixed commands and private profile/cache roots without mutating parent environment",
  { skip: !nativeArtifactsPrepared },
  async (t) => {
    const fixtureOptions = await fixture(t);
    const before = { ...process.env };
    const config = await toTestExtension(
      {
        type: "builtin",
        name: "computercontroller",
        timeout: 42,
        command: "unexpected.exe",
        args: ["run"],
        env: { CODEBUDDY_HOME: "C:/outside" },
      },
      fixtureOptions,
    );
    assert.equal(config.serverName, "computercontroller");
    assert.equal(config.transport, "stdio");
    assert.deepEqual(config.args, ["mcp", "computercontroller"]);
    assert.equal(path.basename(config.command), process.platform === 'win32' ? 'codebuddy-tools.exe' : 'codebuddy-tools');
    assert.equal(config.cwd, fixtureOptions.cwd);
    assert.equal(config.toolCallTimeoutMs, 42000);
    assert.equal(config.failOnStartupError, true);
    for (const key of [
      "CODEBUDDY_HOME",
      "CODEAGENTPRO_HOME",
      "GOOSE_PATH_ROOT",
      "HOME",
      "USERPROFILE",
      "TEMP",
      "TMP",
      "TMPDIR",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR",
    ]) {
      const relative = path.relative(
        path.join(fixtureOptions.dataDir, "tool-runtime", "computercontroller"),
        config.env[key],
      );
      assert.ok(
        relative && !relative.startsWith("..") && !path.isAbsolute(relative),
        key,
      );
      assert.equal(await realpath(config.env[key]), config.env[key]);
    }
    assert.equal(config.env.GOOSE_TELEMETRY_OFF, "1");
    assert.equal(config.env.OTEL_SDK_DISABLED, "true");
    for (const flag of [
      "ALLOW_APP_LAUNCH",
      "ALLOW_FOCUS_ACTIONS",
      "ALLOW_UIA_TEXT_FALLBACK",
    ])
      assert.equal(
        Object.hasOwn(config.env, `OPEN_COMPUTER_USE_WINDOWS_${flag}`),
        false,
      );
    assert.deepEqual({ ...process.env }, before);
    assert.equal(
      await builtinMcp({ type: "builtin", name: "memory" }, fixtureOptions),
      undefined,
    );
    await assert.rejects(
      builtinMcp(
        { type: "builtin", name: "computercontroller", timeout: -1 },
        fixtureOptions,
      ),
      /timeout/u,
    );
    await assert.rejects(
      builtinMcp(
        { type: "builtin", name: "computercontroller" },
        { ...fixtureOptions, cwd: "relative" },
      ),
      /absolute/u,
    );
    const alias = path.join(fixtureOptions.root, "data-alias");
    await symlink(fixtureOptions.dataDir, alias, "junction");
    await assert.rejects(
      builtinMcp(
        { type: "builtin", name: "computercontroller" },
        { ...fixtureOptions, dataDir: alias },
      ),
      /symbolic links/u,
    );
  },
);

test(
  "official Harness discovers the three real standalone MCP servers without executing any tool",
  {
    skip: !nativeArtifactsPrepared,
    timeout: 60_000,
  },
  async (t) => {
    const options = await fixture(t);
    const driver = await createHarnessDriver({
      dataDir: path.join(options.root, "harness"),
      cwd: options.cwd,
    });
    try {
      for (const name of [
        "qwen_computer",
        "computercontroller",
        "autovisualiser",
      ]) {
        const config = await builtinMcp({ type: "builtin", name }, options);
        const tools = await driver.testExtension(config);
        assert.deepEqual(
          tools.map((tool) => tool.name).sort(),
          builtinToolNames(name)
            .map((tool) => `mcp__${name}__${tool}`)
            .sort(),
        );
        for (const tool of tools)
          assert.ok(
            typeof tool.description === "string" && tool.description.length > 0,
          );
        const directory = path.join(options.dataDir, "tool-runtime", name);
        assert.ok((await readdir(directory)).includes("profile"));
        if (name !== "qwen_computer") {
          await assert.rejects(readdir(path.join(config.env.CODEBUDDY_HOME, "logs")),
            { code: 'ENOENT' }, 'Tool-only startup must not initialize legacy CLI state');
          if (process.platform === 'win32') {
            assert.ok((await readdir(config.env.LOCALAPPDATA)).length > 0,
              "Document/chart cache must use isolated LOCALAPPDATA");
          } else {
            assert.ok((await readdir(config.env.XDG_CACHE_HOME)).length > 0,
              "Document/chart cache must use isolated XDG_CACHE_HOME");
          }
        }
      }
      assert.deepEqual(
        await readdir(options.cwd),
        [],
        "Metadata discovery must leave the project directory untouched",
      );
    } finally {
      await driver.close();
    }
  },
);
