import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectLegacyProfile,
  migrateLegacyProfile,
  loadLegacyConversation,
} from "../legacy-migration.mjs";
import { acquireProfileLock } from "../profile-lock.mjs";
import { openStore } from "../store.mjs";
import { updatesFromConversation } from "../history.mjs";
import { ProjectMemory } from "../memory.mjs";
import { revealSecret } from "../secrets.mjs";
import { createHarnessDriver } from "../harness/index.mjs";
import { createCompatServer } from "../server.mjs";

const projectIdentity = "a".repeat(32);
const now = "2026-10-14T00:00:00.000Z";
const memoryEntry = {
  id: "old-memory",
  kind: "project_rule",
  subject: "Testing",
  content: "Run isolated tests.",
  scope: "project",
  source: "user",
  status: "active",
  reason: "Reviewed in the previous version",
  source_ref: null,
  confidence: "high",
  created_at: now,
  updated_at: now,
  last_verified_at: null,
  expires_at: null,
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-legacy-migration-")),
  );
  const source = path.join(root, "source"),
    target = path.join(root, "target"),
    project = path.join(root, "project");
  for (const directory of [
    "sessions",
    "config/custom_providers",
    "memory/" + projectIdentity,
    "scheduled_recipes",
  ])
    await mkdir(path.join(source, directory), { recursive: true });
  await mkdir(project);
  const dbFile = path.join(source, "sessions", "sessions.db");
  const db = new DatabaseSync(dbFile);
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY,name TEXT,working_dir TEXT,session_type TEXT,created_at TEXT,updated_at TEXT,archived_at TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,message_id TEXT,session_id TEXT,role TEXT,content_json TEXT,created_timestamp INTEGER,metadata_json TEXT);`,
  );
  const insertSession = db.prepare(
    "INSERT INTO sessions VALUES(?,?,?,?,?,?,?)",
  );
  for (const [id, type] of [
    ["old-user", "user"],
    ["old-code", "code_pro"],
    ["old-hidden", "hidden"],
    ["old-child", "sub_agent"],
  ])
    insertSession.run(id, `${type} history`, project, type, now, now, null);
  const insertMessage = db.prepare(
    "INSERT INTO messages VALUES(?,?,?,?,?,?,?)",
  );
  insertMessage.run(
    1,
    "msg-user",
    "old-user",
    "user",
    JSON.stringify([{ type: "text", text: "A private historical request" }]),
    1791936000,
    JSON.stringify({ userVisible: true, agentVisible: true }),
  );
  insertMessage.run(
    2,
    "msg-tool",
    "old-user",
    "assistant",
    JSON.stringify([
      {
        type: "toolRequest",
        id: "tool-old",
        toolCall: {
          status: "success",
          value: { name: "shell", arguments: { command: "echo fixture" } },
        },
      },
    ]),
    1791936001,
    JSON.stringify({ userVisible: true }),
  );
  insertMessage.run(
    3,
    "msg-hidden",
    "old-user",
    "assistant",
    JSON.stringify([{ type: "text", text: "Internal private note" }]),
    1791936002,
    JSON.stringify({ userVisible: false }),
  );
  await writeFile(
    path.join(source, "config", "config.yaml"),
    `GOOSE_MODE: approve\nGOOSE_THINKING_EFFORT: low\nGOOSE_AUTO_COMPACT_THRESHOLD: 0.75\nCODEPRO_PERSONALIZED_MEMORY_ENABLED: true\nOPENAI_API_KEY: never-import-legacy-key\nextensions:\n  fixture-mcp:\n    type: streamable_http\n    name: fixture-mcp\n    uri: http://127.0.0.1:1/mcp\n    enabled: true\n    headers:\n      Authorization: Bearer old-mcp-token\n  developer:\n    type: builtin\n    name: developer\n    enabled: false\n`,
  );
  await writeFile(
    path.join(source, "config", "custom_providers", "custom_fixture.json"),
    JSON.stringify({
      name: "custom_fixture",
      engine: "openai",
      display_name: "Old model",
      base_url: "https://fixture.example/v1",
      models: [{ name: "old-model" }],
      headers: { "X-Credential": "old-provider-header" },
      requires_auth: true,
      supports_streaming: true,
    }),
  );
  await writeFile(
    path.join(source, "memory", projectIdentity, "memory.json"),
    JSON.stringify({
      schema_version: "2.0",
      project_identity: projectIdentity,
      entries: [
        memoryEntry,
        { ...memoryEntry, id: "disabled", status: "disabled" },
        { ...memoryEntry, id: "candidate", status: "candidate" },
        { ...memoryEntry, id: "user-scope", scope: "user" },
      ],
    }),
  );
  const recipePath = path.join(source, "scheduled_recipes", "job.yaml");
  await writeFile(
    recipePath,
    'version: 1.0.0\ntitle: Old scheduled task\ndescription: Imported fixture\nprompt: "Build {{name}}"\nparameters:\n  - key: name\n    description: Project\n    input_type: string\n    requirement: required\nextensions:\n  - type: streamable_http\n    name: schedule-mcp\n    uri: http://127.0.0.1:1/mcp\n    headers:\n      Authorization: Bearer old-schedule-token\n',
  );
  await writeFile(
    path.join(source, "schedule.json"),
    JSON.stringify([
      {
        id: "Old task",
        source: recipePath,
        cron: "0 0 9 * * *",
        paused: false,
        currently_running: true,
        current_session_id: "old-code",
        workspace_mode: "codepro",
        parameters: [["name", "isolated project"]],
      },
    ]),
  );
  const records = new Map();
  let driverCreated = 0,
    driverClosed = 0;
  const driver = {
    memory: {
      async list(scope) {
        return [...records.values()]
          .filter((row) => row.scope === scope)
          .map((row) => ({ key: row.key, value: structuredClone(row.value) }));
      },
      async get(scope, key) {
        return structuredClone(records.get(scope + "\0" + key)?.value);
      },
      async set(scope, key, value) {
        records.set(scope + "\0" + key, {
          scope,
          key,
          value: structuredClone(value),
        });
      },
      async delete(scope, key) {
        records.delete(scope + "\0" + key);
      },
    },
    async close() {
      driverClosed++;
    },
  };
  const driverFactory = async () => {
    driverCreated++;
    return driver;
  };
  t.after(async () => {
    db.close();
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codebuddy-legacy-migration-"));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    target,
    project,
    db,
    dbFile,
    driver,
    driverFactory,
    records,
    get driverCreated() {
      return driverCreated;
    },
    get driverClosed() {
      return driverClosed;
    },
    apply: (extra) =>
      migrateLegacyProfile({
        sourceDir: source,
        targetDir: target,
        offline: true,
        driverFactory,
        ...extra,
      }),
  };
}

test("dry-run reads schema and counts without target creation, message content or credentials", async (t) => {
  const context = await fixture(t);
  const before = digest(await readFile(context.dbFile));
  const report = await inspectLegacyProfile({
    sourceDir: context.source,
    targetDir: context.target,
  });
  assert.equal(report.history.sessions, 4);
  assert.equal(report.history.visibleSessions, 2);
  assert.equal(report.history.messages, 3);
  assert.equal(report.memory.records, 4);
  assert.deepEqual(report.memory.unmappedIdentities, [projectIdentity]);
  assert.equal(report.schedules.importedPaused, true);
  const serialized = JSON.stringify(report);
  for (const sensitive of [
    "A private historical request",
    "never-import-legacy-key",
    "old-mcp-token",
    "old-provider-header",
    "old-schedule-token",
  ])
    assert.ok(!serialized.includes(sensitive));
  await assert.rejects(stat(context.target), { code: "ENOENT" });
  assert.equal(digest(await readFile(context.dbFile)), before);
});

test("apply snapshots WAL history, stores only visible metadata and reads conversation on demand", async (t) => {
  const context = await fixture(t);
  const before = digest(await readFile(context.dbFile));
  const report = await context.apply();
  assert.equal(report.history.added, 2);
  assert.equal(report.memory.added, 0);
  assert.equal(context.driverCreated, 0);
  const state = JSON.parse(
    await readFile(path.join(context.target, "state.json"), "utf8"),
  );
  assert.equal(state.sessions.length, 2);
  assert.ok(
    state.sessions.every(
      (row) =>
        row.readonlyHistory && row.updates.length === 0 && row.legacyHistory,
    ),
  );
  assert.ok(!JSON.stringify(state).includes("A private historical request"));
  assert.ok(!JSON.stringify(state).includes("Internal private note"));
  const selected = state.sessions.find(
    (row) => row.legacyHistory.sessionId === "old-user",
  );
  const conversation = await loadLegacyConversation(
    context.target,
    selected.legacyHistory,
  );
  assert.equal(conversation.length, 3);
  assert.equal(conversation[0].content[0].text, "A private historical request");
  const updates = updatesFromConversation(conversation, selected.createdAt);
  assert.ok(updates.some((row) => row.sessionUpdate === "tool_call"));
  assert.ok(!JSON.stringify(updates).includes("Internal private note"));
  context.db
    .prepare("UPDATE messages SET content_json=? WHERE id=1")
    .run(JSON.stringify([{ type: "text", text: "Changed after snapshot" }]));
  assert.equal(
    (await loadLegacyConversation(context.target, selected.legacyHistory))[0]
      .content[0].text,
    "A private historical request",
  );
  assert.equal(
    digest(await readFile(context.dbFile)),
    before,
    "Read-only migration must not checkpoint the source WAL",
  );
  await assert.rejects(
    loadLegacyConversation(context.target, {
      archiveId: "../source",
      sessionId: "old-user",
    }),
    /invalid_legacy_history_reference/u,
  );
  await assert.rejects(
    loadLegacyConversation(context.target, {
      ...selected.legacyHistory,
      sessionId: "old-hidden",
    }),
    /legacy_session_not_found/u,
  );
});

test("configuration preserves current defaults and credentials, and imported schedules remain paused", async (t) => {
  const context = await fixture(t);
  const store = await openStore(context.target);
  const current = {
    id: "current-kimi",
    engine: "ollama_compatible",
    apiUrl: "https://current.example",
    displayName: "Current Kimi",
    requiresAuth: true,
    models: ["kimi-k3"],
    secret: { kind: "fixture-preserved", ciphertext: "existing-secret" },
  };
  await store.update((state) => {
    state.providers.push(current);
    state.defaults = { providerId: current.id, modelId: "kimi-k3" };
    state.preferences.gooseThinkingEffort = "high";
    state.extensions.push({
      configKey: "developer",
      enabled: true,
      extension: { type: "builtin", name: "developer" },
    });
  });
  const report = await context.apply();
  const state = JSON.parse(
    await readFile(path.join(context.target, "state.json"), "utf8"),
  );
  assert.deepEqual(
    state.providers.find((row) => row.id === current.id),
    current,
  );
  assert.deepEqual(state.defaults, {
    providerId: "current-kimi",
    modelId: "kimi-k3",
  });
  assert.equal(state.preferences.gooseThinkingEffort, "high");
  assert.equal(state.preferences.autoCompactThreshold, 0.75);
  assert.equal(
    state.extensions.find((row) => row.configKey === "developer").enabled,
    true,
  );
  const imported = state.providers.find(
    (row) => row.legacyProviderId === "custom_fixture",
  );
  assert.equal(imported.secret, null);
  assert.ok(report.providers.credentialsRequireReentry.includes(imported.id));
  assert.equal(
    JSON.parse(await revealSecret(imported.headersProtected))["X-Credential"],
    "old-provider-header",
  );
  const extension = state.extensions.find(
    (row) => row.configKey === "fixture-mcp",
  );
  assert.equal(extension.enabled, false);
  assert.ok(extension.protected);
  const schedule = state.schedules[0];
  assert.equal(schedule.paused, true);
  assert.equal(schedule.tested, false);
  assert.equal(schedule.currentlyRunning, false);
  assert.equal(schedule.currentSessionId, null);
  assert.deepEqual(schedule.attempts, []);
  assert.equal(schedule.recipe.parameters[0].default, "isolated project");
  assert.equal(schedule.recipe.extensions.length, 0);
  const serialized = JSON.stringify(state);
  for (const secret of [
    "never-import-legacy-key",
    "old-mcp-token",
    "old-provider-header",
    "old-schedule-token",
  ])
    assert.ok(!serialized.includes(secret));
  const scheduledYaml = await readFile(schedule.source, "utf8");
  assert.ok(!scheduledYaml.includes("old-schedule-token"));
});

test("explicit project mappings migrate memory through Harness storage while retaining review status", async (t) => {
  const context = await fixture(t);
  const report = await context.apply({
    projectMap: { [projectIdentity]: context.project },
  });
  assert.equal(report.memory.added, 3);
  assert.equal(context.driverCreated, 1);
  assert.equal(context.driverClosed, 1);
  assert.ok(
    report.warnings.some(
      (row) => row.reason === "legacy_user_memory_scope_requires_review",
    ),
  );
  const memory = new ProjectMemory(context.driver);
  const records = await memory.records(await memory.scope(context.project));
  assert.equal(records.length, 3);
  assert.equal((await memory.recall(context.project)).length, 1);
  assert.deepEqual(records.map((row) => row.status).sort(), [
    "active",
    "candidate",
    "disabled",
  ]);
  const archive = JSON.parse(
    await readFile(
      path.join(
        context.target,
        "legacy",
        report.archiveId,
        "memory",
        projectIdentity + ".json",
      ),
      "utf8",
    ),
  );
  assert.equal(archive.entries.length, 4);
  const repeat = await context.apply({
    projectMap: { [projectIdentity]: context.project },
  });
  assert.equal(repeat.history.added, 0);
  assert.equal(repeat.history.skipped, 2);
  assert.equal(repeat.providers.added, 0);
  assert.equal(repeat.schedules.added, 0);
  assert.equal(repeat.memory.added, 0);
  assert.equal(repeat.memory.skipped, 3);
});

test("running profile locks and live pre-lock launcher receipts reject migration before state writes", async (t) => {
  const context = await fixture(t);
  const lease = await acquireProfileLock(context.target);
  await assert.rejects(
    context.apply(),
    (error) => error.code === "PROFILE_IN_USE",
  );
  await assert.rejects(stat(path.join(context.target, "state.json")), {
    code: "ENOENT",
  });
  lease.close();
  await mkdir(path.join(context.target, "logs", "preview"), {
    recursive: true,
  });
  await writeFile(
    path.join(context.target, "logs", "preview", "launch.json"),
    JSON.stringify({ runtimePid: process.pid, status: "running" }),
  );
  await assert.rejects(
    context.apply(),
    (error) => error.code === "PROFILE_IN_USE",
  );
  await assert.rejects(stat(path.join(context.target, "legacy")), {
    code: "ENOENT",
  });
});

test("mapped memories persist in the official Harness storage and remain available after restart", async (t) => {
  const context = await fixture(t);
  const report = await migrateLegacyProfile({
    sourceDir: context.source,
    targetDir: context.target,
    offline: true,
    projectMap: { [projectIdentity]: context.project },
  });
  assert.equal(report.memory.added, 3);
  const driver = await createHarnessDriver({
    dataDir: path.join(context.target, "harness"),
    instructionsHome: context.root,
  });
  try {
    const memory = new ProjectMemory(driver);
    const recalled = await memory.recall(context.project);
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].content, "Run isolated tests.");
    assert.equal(
      (await memory.records(await memory.scope(context.project))).length,
      3,
    );
  } finally {
    await driver.close();
  }
});

test("profile lease is exclusive across processes and is released after the owner exits", async (t) => {
  const context = await fixture(t);
  const moduleUrl = new URL("../profile-lock.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {acquireProfileLock} from ${JSON.stringify(moduleUrl)};await acquireProfileLock(process.argv[1]);process.stdout.write('ready\\n');setInterval(()=>{},1000);`,
      context.target,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await once(child.stdout, "data");
  await assert.rejects(
    acquireProfileLock(context.target),
    (error) => error.code === "PROFILE_IN_USE",
  );
  child.kill();
  await once(child, "exit");
  const replacement = await acquireProfileLock(context.target);
  replacement.close();
});

test("migration rejects overlap and linked sources, and reports external recipes without reading them", async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    migrateLegacyProfile({
      sourceDir: context.source,
      targetDir: context.target,
    }),
    /offline_migration_required/u,
  );
  await assert.rejects(
    context.apply({ targetDir: context.source }),
    /source_target_overlap/u,
  );
  await assert.rejects(
    context.apply({ targetDir: path.join(context.source, "nested") }),
    /source_target_overlap/u,
  );
  const linked = path.join(context.root, "linked-source");
  await symlink(
    context.source,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    context.apply({ sourceDir: linked }),
    /linked_path_rejected/u,
  );
  await writeFile(
    path.join(context.source, "schedule.json"),
    JSON.stringify([
      {
        id: "external",
        source: path.join(context.root, "outside.yaml"),
        cron: "0 0 * * *",
      },
    ]),
  );
  const report = await context.apply();
  assert.equal(report.schedules.added, 0);
  assert.ok(
    report.warnings.some(
      (row) => row.reason === "recipe_outside_legacy_profile",
    ),
  );
});

test("CLI defaults to a read-only inventory and requires an explicit offline apply", async (t) => {
  const context = await fixture(t);
  const run = async (args) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("scripts/migrate-legacy-profile.mjs"),
        "--source",
        context.source,
        "--target",
        context.target,
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const [code] = await once(child, "exit");
    return { code, out, err };
  };
  const dry = await run([]);
  assert.equal(dry.code, 0);
  assert.equal(JSON.parse(dry.out).mode, "dry-run");
  await assert.rejects(stat(context.target), { code: "ENOENT" });
  const apply = await run(["--apply"]);
  assert.equal(apply.code, 1);
  assert.match(apply.err, /offline_migration_required/u);
  await assert.rejects(stat(context.target), { code: "ENOENT" });
});

test("real ACP lazily loads and exports imported history without invoking the agent, and its live server blocks migration", async (t) => {
  const context = await fixture(t);
  await context.apply();
  const secret = "isolated-legacy-history-contract-secret";
  const executionCalls = [];
  const driver = { async close() {} };
  for (const name of [
    "createSession",
    "configureSession",
    "prompt",
    "listTools",
    "extensionStatus",
    "callTool",
    "history",
    "cancel",
  ])
    driver[name] = async (...args) => {
      executionCalls.push({ name, args });
      throw new Error(`Historical viewing invoked ${name}`);
    };
  const app = await createCompatServer({
    dataDir: context.target,
    secret,
    driver,
  });
  let socket;
  try {
    const url = await app.listen(0, "127.0.0.1");
    socket = new WebSocket(
      `${url.replace(/^http/u, "ws")}/acp?token=${secret}`,
    );
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const notifications = [];
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method) notifications.push(message);
      else {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error)
          waiter.reject(
            Object.assign(new Error(message.error.message), message.error),
          );
        else waiter.resolve(message.result);
      }
    });
    const request = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP timeout: ${method}`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    await request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "legacy-contract", version: "1.0.0" },
      clientCapabilities: { _meta: { goose: { customNotifications: true } } },
    });
    const listed = await request("session/list", {});
    assert.equal(listed.sessions.length, 2);
    const stateBefore = JSON.parse(
      await readFile(path.join(context.target, "state.json"), "utf8"),
    );
    const selected = stateBefore.sessions.find(
      (row) => row.legacyHistory.sessionId === "old-user",
    );
    await request("session/load", {
      sessionId: selected.id,
      cwd: context.project,
      mcpServers: [],
    });
    const projected = notifications
      .filter((row) => row.method === "session/update")
      .map((row) => row.params.update);
    assert.ok(
      projected.some(
        (row) => row.content?.text === "A private historical request",
      ),
    );
    assert.ok(projected.some((row) => row.sessionUpdate === "tool_call"));
    assert.ok(!JSON.stringify(projected).includes("Internal private note"));
    const exported = await request("_goose/unstable/session/export", {
      sessionId: selected.id,
    });
    assert.equal(JSON.parse(exported.data).conversation.length, 3);
    assert.equal(
      JSON.parse(exported.data).conversation[0].content[0].text,
      "A private historical request",
    );
    await assert.rejects(
      request("session/prompt", {
        sessionId: selected.id,
        prompt: [{ type: "text", text: "Resume the old task" }],
      }),
      /read-only/u,
    );
    assert.deepEqual(executionCalls, []);
    const persisted = await readFile(
      path.join(context.target, "state.json"),
      "utf8",
    );
    assert.ok(!persisted.includes("A private historical request"));
    assert.deepEqual(
      JSON.parse(persisted).sessions.find((row) => row.id === selected.id)
        .updates,
      [],
    );
    await assert.rejects(
      context.apply(),
      (error) => error.code === "PROFILE_IN_USE",
    );
  } finally {
    socket?.close();
    await app.close();
  }
  const afterShutdown = await context.apply();
  assert.equal(afterShutdown.history.added, 0);
  assert.equal(afterShutdown.history.skipped, 2);
});
