import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

let credentialProcesses = 0;
const spawn = cp.spawn;
cp.spawn = function (command, ...args) {
  if (path.basename(command).toLowerCase() === "powershell.exe")
    credentialProcesses++;
  return spawn.call(this, command, ...args);
};
syncBuiltinESMExports();
const { openStore } = await import("../store.mjs");
const { RuntimeSettings } = await import("../settings.mjs");
const { protectSecret, revealSecret } = await import("../secrets.mjs");
const {
  resolveSessionExtensions,
  selectedExtensions,
  activeMcpServers,
  sealSessionExtensions,
  isExtensionSnapshotChanged,
} = await import("../session-extensions.mjs");
const { toolEnabled } = await import("../tool-policy.mjs");

const extension = (name) => ({
  type: "mcp",
  server: {
    type: "http",
    name,
    url: "http://127.0.0.1:1/mcp",
    headers: [{ name: "Authorization", value: "Bearer fixture-only" }],
  },
});

test('concurrent reads share DPAPI work without retaining plaintext or failures', async () => {
  const first = await protectSecret('fixture-first'), second = await protectSecret('fixture-rotated');
  let before = credentialProcesses;
  const values = await Promise.all(Array.from({length: 8}, () => revealSecret(structuredClone(first))));
  assert.deepEqual(values, Array(8).fill('fixture-first'));
  assert.equal(credentialProcesses - before, 1);
  before = credentialProcesses;
  assert.deepEqual(await Promise.all([revealSecret(first), revealSecret(second)]), ['fixture-first', 'fixture-rotated']);
  assert.equal(credentialProcesses - before, 2, 'settled results must not be cached');
  const invalid = {kind:'windows-dpapi',ciphertext:'invalid-fixture'};
  before = credentialProcesses;
  const errors = await Promise.allSettled([revealSecret(invalid), revealSecret(invalid)]);
  assert.ok(errors.every(result => result.status === 'rejected'));
  assert.equal(credentialProcesses - before, 1);
  await assert.rejects(revealSecret(invalid));
  assert.equal(credentialProcesses - before, 2, 'a failed OS read must be retried on the next operation');
});
async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codebuddy-extension-resolution-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(
      path.basename(directory).startsWith("codebuddy-extension-resolution-"),
    );
    await rm(directory, { recursive: true, force: true });
  });
  const store = await openStore(directory),
    settings = new RuntimeSettings(store);
  await settings.initialize();
  return { store, settings };
}

test('configured selections do not decrypt unused historical definitions, but removed globals require the fallback', async t => {
  const { store, settings } = await fixture(t);
  const remote = extension('remote');
  await settings.saveExtension({ extension: remote, enabled: true });
  const session = { id: 'fallback', extensions: ['developer', 'remote'], extensionDefinitions: { kind: 'invalid-fixture-secret' } };
  const snapshot = await resolveSessionExtensions(session, settings);
  assert.deepEqual(snapshot.selected.map(e => e.configKey), ['developer', 'remote']);
  await settings.request('config/extensions/set-enabled', { configKey: 'remote', enabled: false });
  assert.deepEqual((await resolveSessionExtensions(session, settings)).selected.map(e => e.configKey), ['developer']);
  await settings.request('config/extensions/remove', { configKey: 'remote' });
  await assert.rejects(resolveSessionExtensions(session, settings), /Unknown credential format/);
});

test("one operation decrypts each required definition once and never decrypts disabled extensions for native tool filtering", async (t) => {
  const { store, settings } = await fixture(t);
  const remote = extension("remote"),
    privateExtension = extension("private");
  const protectedValue = await protectSecret(JSON.stringify(remote));
  await store.update((state) =>
    state.extensions.push(
      { configKey: "remote", enabled: true, protected: protectedValue },
      {
        configKey: "remote_mixed",
        enabled: false,
        protected: { kind: "invalid-fixture-secret" },
      },
      {
        configKey: "other_disabled",
        enabled: false,
        protected: { kind: "invalid-fixture-secret" },
      },
    ),
  );
  const session = {
    id: "session",
    type: "code_pro",
    ...(await sealSessionExtensions(
      [
        { type: "builtin", name: "developer" },
        remote,
        extension("Remote_Mixed"),
        privateExtension,
      ],
      [extension("Remote_Mixed").server, extension("adhoc").server],
    )),
  };
  const before = credentialProcesses;
  let snapshots = 0;
  const resolve = settings.extensionSnapshot.bind(settings);
  settings.extensionSnapshot = () => {
    snapshots++;
    return resolve();
  };
  const snapshot = await resolveSessionExtensions(session, settings);
  assert.equal(
    credentialProcesses - before,
    3,
    "one enabled global definition, one session definition and one server list",
  );
  assert.deepEqual(
    snapshot.selected.map((entry) => entry.configKey),
    ["developer", "remote", "private"],
  );
  assert.deepEqual(
    snapshot.mcpServers.map((server) => server.name),
    ["adhoc"],
  );
  for (const name of [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "shell",
    "todo_read",
    "todo_write",
    "job_start",
    "job_stop",
    "job_list",
    "job_wait",
    "skill",
    "subagent",
    "send_message",
    "list_agents",
    "working_directory",
  ]) {
    assert.equal(await toolEnabled(session, settings, name, snapshot), true);
  }
  assert.equal(
    await toolEnabled(session, settings, "mcp__Remote_Mixed__noop", snapshot),
    false,
  );
  assert.equal(
    await toolEnabled(session, settings, "mcp__private__noop", snapshot),
    true,
  );
  assert.equal(
    await toolEnabled(session, settings, "mcp__adhoc__noop", snapshot),
    true,
  );
  assert.equal(
    await toolEnabled(session, settings, "read_mcp_resource", snapshot),
    true,
  );
  assert.deepEqual(
    await selectedExtensions(session, settings, snapshot),
    snapshot.selected,
  );
  assert.deepEqual(
    await activeMcpServers(session, settings, snapshot),
    snapshot.mcpServers,
  );
  assert.equal(snapshots, 1);
  assert.equal(
    credentialProcesses - before,
    3,
    "all permission checks share the operation result without subprocesses",
  );
});

test("settings disable, update and removal invalidate prior results while later operations read current policy", async (t) => {
  const { settings } = await fixture(t);
  const session = { id: "session", type: "user", extensions: null };
  const initial = await resolveSessionExtensions(session, settings);
  await settings.request("config/extensions/set-enabled", {
    configKey: "developer",
    enabled: false,
  });
  assert.throws(() => initial.assertCurrent(session), /settings changed/);
  await assert.rejects(
    toolEnabled(session, settings, "read", initial),
    /settings changed/,
  );
  assert.equal(await toolEnabled(session, settings, "read"), false);
  const disabled = await resolveSessionExtensions(session, settings);
  await settings.request("config/extensions/update", {
    configKey: "developer",
    extension: {
      type: "builtin",
      name: "developer",
      available_tools: ["read"],
    },
    enabled: true,
  });
  assert.throws(() => disabled.assertCurrent(session), /settings changed/);
  const updated = await resolveSessionExtensions(session, settings);
  assert.equal(await toolEnabled(session, settings, "read", updated), true);
  assert.equal(await toolEnabled(session, settings, "write", updated), false);
  await settings.request("config/extensions/remove", {
    configKey: "developer",
  });
  assert.throws(() => updated.assertCurrent(session), /settings changed/);
});

test("a concurrent registry change during decryption rejects the result and a changed session selection cannot reuse it", async (t) => {
  const { store, settings } = await fixture(t);
  await settings.saveExtension({
    extension: extension("remote"),
    enabled: true,
  });
  const session = { id: "session", extensions: null };
  const resolving = resolveSessionExtensions(session, settings);
  const changed = settings.request("config/extensions/set-enabled", {
    configKey: "remote",
    enabled: false,
  });
  await Promise.all([
    changed,
    assert.rejects(resolving, (error) => {
      assert.match(error.message, /settings changed/);
      assert.equal(isExtensionSnapshotChanged(error), true);
      return true;
    }),
  ]);
  const current = await resolveSessionExtensions(session, settings);
  session.extensions = [];
  assert.throws(
    () => current.assertCurrent(session),
    (error) =>
      isExtensionSnapshotChanged(error) &&
      /Session extensions changed/.test(error.message),
  );
  assert.equal(await toolEnabled(session, settings, "read"), false);
  assert.equal(
    store.read().extensions.find((entry) => entry.configKey === "remote")
      .enabled,
    false,
  );
});

test("read-only UI extension listing preserves snapshots and errors unrelated to configuration are not retryable", async (t) => {
  const { settings } = await fixture(t);
  const session = { id: "session", extensions: null };
  const snapshot = await resolveSessionExtensions(session, settings);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      settings.request("config/extensions/list", {}),
    ),
  );
  snapshot.assertCurrent(session);
  assert.equal(await toolEnabled(session, settings, "read", snapshot), true);
  assert.equal(
    isExtensionSnapshotChanged(
      Error("Extension settings changed; retry the operation"),
    ),
    false,
  );
  await assert.rejects(
    settings.saveExtension({ extension: { type: "invalid" } }),
    (error) => {
      assert.equal(isExtensionSnapshotChanged(error), false);
      return true;
    },
  );
});

test("repeated UI synchronization of identical settings preserves prepared capabilities", async (t) => {
  const { settings, store } = await fixture(t);
  const configured = extension("remote");
  await settings.saveExtension({ extension: configured, enabled: true });
  const session = { id: "session", extensions: null };
  const snapshot = await resolveSessionExtensions(session, settings);
  let invalidations = 0;
  settings.changed = () => {
    invalidations++;
  };
  await settings.request("config/extensions/set-enabled", {
    configKey: "remote",
    enabled: true,
  });
  await settings.saveExtension({
    extension: structuredClone(configured),
    enabled: true,
  });
  snapshot.assertCurrent(session);
  assert.equal(invalidations, 0);
  await settings.request("config/extensions/set-enabled", {
    configKey: "remote",
    enabled: false,
  });
  assert.throws(
    () => snapshot.assertCurrent(session),
    isExtensionSnapshotChanged,
  );
  assert.equal(invalidations, 1);
  await store.update((state) => {
    state.extensions.find((entry) => entry.configKey === "remote").protected = {
      kind: "broken-old-credential-fixture",
    };
  });
  await settings.saveExtension({
    extension: structuredClone(configured),
    enabled: false,
  });
  assert.deepEqual(
    (await settings.extensions()).find((entry) => entry.configKey === "remote")
      .extension,
    configured,
  );
  assert.equal(
    invalidations,
    2,
    "explicit saves can replace unreadable old credentials",
  );
});

test("settings-owned definitions are invalidated on credential changes and are never shared globally", async (t) => {
  const { settings, store } = await fixture(t);
  const first = extension("remote");
  await settings.saveExtension({ extension: first, enabled: true });
  const session = { id: "session", extensions: ["remote"] };
  const old = await resolveSessionExtensions(session, settings);
  const replacement = extension("remote");
  replacement.server.headers[0].value = "Bearer replacement-fixture-only";
  await settings.saveExtension({ extension: replacement });
  assert.throws(() => old.assertCurrent(session), /settings changed/);
  const current = await resolveSessionExtensions(session, settings);
  assert.equal(
    current.selected[0].extension.server.headers[0].value,
    replacement.server.headers[0].value,
  );
  const before = credentialProcesses;
  await resolveSessionExtensions(session, settings);
  assert.equal(
    credentialProcesses - before,
    0,
    "the current configuration revision reuses its resolved credential view",
  );
  await resolveSessionExtensions(session, new RuntimeSettings(store));
  assert.equal(credentialProcesses - before, 1, "another settings owner must decode its own view");
});
