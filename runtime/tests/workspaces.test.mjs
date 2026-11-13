import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceService, workspaceIdentity } from "../workspaces.mjs";
import {
  zCreateSourceResponse_unstable,
  zExportSourceResponse_unstable,
  zImportSourcesResponse_unstable,
  zListSourcesResponse_unstable,
} from "../../ui/sdk/src/generated/zod.gen.ts";
import { build } from "../../ui/node_modules/esbuild/lib/main.js";
import { fileURLToPath } from "node:url";

const leaseMethod = (action) => `_goose/unstable/workspace/lease/${action}`;
const sourceMethod = (action) => `_goose/unstable/sources/${action}`;

async function fixture(t, options = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codebuddy-workspace-")),
  );
  const service = new WorkspaceService(
    {},
    { projectDirectory: path.join(root, "metadata"), ...options },
  );
  const connection = {};
  t.after(async () => {
    await service.close();
    assert.ok(path.basename(root).startsWith("codebuddy-workspace-"));
    assert.equal(
      workspaceIdentity(path.dirname(root)),
      workspaceIdentity(await realpath(os.tmpdir())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const request = (action, directory, state = "missing") =>
    service.request(
      leaseMethod(action),
      {
        requestedPath: directory,
        expectedState: state,
        expectedIdentity: workspaceIdentity(directory),
      },
      connection,
    );
  return { root, service, connection, request };
}

test("new task creates a real unique workspace, consumes it once, and retains files on close", async (t) => {
  const { root, service, connection, request } = await fixture(t);
  const cwd = path.join(root, "first-task");
  const lease = await request("acquire", cwd);
  assert.ok((await stat(cwd)).isDirectory());
  assert.equal(lease.created, true);
  assert.equal(
    lease.normalizedIdentity,
    workspaceIdentity(await realpath(cwd)),
  );
  await assert.rejects(
    service.consumeLease({ leaseId: lease.leaseId, cwd, sessionId: "one" }, {}),
    /another connection/,
  );
  await service.consumeLease(
    { leaseId: lease.leaseId, cwd, sessionId: "one" },
    connection,
  );
  await assert.rejects(
    service.consumeLease(
      { leaseId: lease.leaseId, cwd, sessionId: "two" },
      connection,
    ),
    /consumed/,
  );
  await writeFile(path.join(cwd, "result.txt"), "user result");
  await service.validateSession("one", cwd);
  await service.releaseSession("one");
  assert.equal(
    await readFile(path.join(cwd, "result.txt"), "utf8"),
    "user result",
  );
  await assert.rejects(service.validateSession("one", cwd), /confirmed again/);
});

test("failed creation only discards its still-empty allocation and rechecks initial contents", async (t) => {
  const { root, service, connection, request } = await fixture(t);
  for (const kind of [
    "allocated-empty",
    "allocated-changed",
    "existing-empty",
  ]) {
    const cwd = path.join(root, kind);
    if (kind === "existing-empty") await mkdir(cwd);
    const lease = await request(
      "acquire",
      cwd,
      kind === "existing-empty" ? "empty-directory" : "missing",
    );
    await service.consumeLease(
      { leaseId: lease.leaseId, cwd, sessionId: kind },
      connection,
    );
    await service.validateSession(kind, cwd, { initialContents: true });
    if (kind === "allocated-changed") {
      await writeFile(path.join(cwd, "user.txt"), "Retain user content");
      await assert.rejects(
        service.validateSession(kind, cwd, { initialContents: true }),
        /contents changed/,
      );
    }
    await service.releaseSession(kind, { discardUnused: true });
    if (kind === "allocated-empty")
      await assert.rejects(stat(cwd), (error) => error.code === "ENOENT");
    else assert.ok((await stat(cwd)).isDirectory());
    if (kind === "allocated-changed")
      assert.equal(
        await readFile(path.join(cwd, "user.txt"), "utf8"),
        "Retain user content",
      );
    await assert.rejects(service.validateSession(kind, cwd), /confirmed again/);
  }
});

test("existing project is preserved and a changed inspection is rejected", async (t) => {
  const { root, service, connection, request } = await fixture(t);
  const cwd = path.join(root, "existing-project");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "source.js"), "existing source");
  await assert.rejects(
    request("acquire", cwd, "empty-directory"),
    /changed since inspection/,
  );
  await assert.rejects(
    request("acquire", cwd, "missing"),
    /changed since inspection/,
  );
  const lease = await request("acquire", cwd, "non-empty-directory");
  assert.equal(lease.created, false);
  await service.request(
    leaseMethod("release"),
    { leaseId: lease.leaseId },
    connection,
  );
  assert.equal(
    await readFile(path.join(cwd, "source.js"), "utf8"),
    "existing source",
  );
});

test("lease expiry and disconnect remove only still-empty created directories", async (t) => {
  let now = 1000;
  const { root, service, connection, request } = await fixture(t, {
    now: () => now,
    leaseLifetimeMs: 100,
  });
  const empty = path.join(root, "empty");
  const changed = path.join(root, "changed");
  const first = await request("acquire", empty);
  await request("acquire", changed);
  await writeFile(path.join(changed, "keep.txt"), "retain");
  now = 1200;
  await assert.rejects(
    service.consumeLease(
      { leaseId: first.leaseId, cwd: empty, sessionId: "expired" },
      connection,
    ),
    /expired/,
  );
  await assert.rejects(stat(empty), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(changed, "keep.txt"), "utf8"),
    "retain",
  );
  const disconnected = path.join(root, "disconnected");
  await request("acquire", disconnected);
  await service.disconnect(connection);
  await assert.rejects(stat(disconnected), { code: "ENOENT" });
});

test("Windows path casing preserves lease identity through confirmation and resume without accepting replacement", { skip: process.platform !== "win32" }, async (t) => {
  const { root, service, connection, request } = await fixture(t);
  const cwd = path.join(root, "MiXeD-Project");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "source.txt"), "retained source");
  const lease = await request("acquire", cwd.toLowerCase(), "non-empty-directory");
  await service.consumeLease({ leaseId: lease.leaseId, cwd: cwd.toUpperCase(), sessionId: "mixed" }, connection);
  await service.validateSession("mixed", cwd.toLowerCase());
  await service.releaseSession("mixed");
  const resumed = await request("acquire", cwd.toUpperCase(), "non-empty-directory");
  await service.consumeLease({ leaseId: resumed.leaseId, cwd, sessionId: "resumed" }, connection);
  await service.validateSession("resumed", cwd.toLowerCase());
  assert.equal(await readFile(path.join(cwd, "source.txt"), "utf8"), "retained source");
  await rename(cwd, path.join(root, "original-directory"));
  await mkdir(cwd);
  await assert.rejects(service.validateSession("resumed", cwd.toUpperCase()), /changed/);
});

test("directory replacement and new contents invalidate a pending lease", async (t) => {
  const { root, service, connection, request } = await fixture(t);
  const cwd = path.join(root, "replaced");
  const lease = await request("acquire", cwd);
  await rename(cwd, path.join(root, "old-directory"));
  await mkdir(cwd);
  await assert.rejects(
    service.consumeLease(
      { leaseId: lease.leaseId, cwd, sessionId: "replaced" },
      connection,
    ),
    /changed since confirmation/,
  );
  const next = path.join(root, "contents-changed");
  const contentLease = await request("acquire", next);
  await writeFile(path.join(next, "new.txt"), "external write");
  await assert.rejects(
    service.consumeLease(
      { leaseId: contentLease.leaseId, cwd: next, sessionId: "changed" },
      connection,
    ),
    /contents changed/,
  );
  // Closing must not delete a replacement directory it did not create.
  await service.close();
  assert.ok((await stat(cwd)).isDirectory());
});

test("root, relative path, mismatched identity and junction ancestry are rejected", async (t) => {
  const { root, service, connection, request } = await fixture(t);
  await assert.rejects(
    request("acquire", path.parse(root).root, "non-empty-directory"),
    /filesystem root/,
  );
  await assert.rejects(request("acquire", "relative"), /absolute/);
  await assert.rejects(
    service.acquire(
      {
        requestedPath: path.join(root, "bad"),
        expectedState: "missing",
        expectedIdentity: "another",
      },
      connection,
    ),
    /changed since inspection/,
  );
  const target = path.join(root, "real");
  const linked = path.join(root, "linked");
  await mkdir(target);
  await symlink(
    target,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    service.acquire(
      {
        requestedPath: linked,
        expectedState: "empty-directory",
        expectedIdentity: workspaceIdentity(target),
      },
      connection,
    ),
    /contains a link/,
  );
  await assert.rejects(
    request("acquire", path.join(linked, "child")),
    /contains a link/,
  );
  assert.deepEqual(await readdir(target), []);
});

test("a restarted service requires a fresh lease for an existing session", async (t) => {
  const { root, service, connection, request } = await fixture(t);
  const cwd = path.join(root, "restart-project");
  const lease = await request("acquire", cwd);
  await service.consumeLease(
    { leaseId: lease.leaseId, cwd, sessionId: "resume" },
    connection,
  );
  const restarted = new WorkspaceService(
    {},
    { projectDirectory: path.join(root, "metadata") },
  );
  await assert.rejects(
    restarted.validateSession("resume", cwd),
    /confirmed again/,
  );
  const renewed = await restarted.acquire(
    {
      requestedPath: cwd,
      expectedState: "empty-directory",
      expectedIdentity: workspaceIdentity(cwd),
    },
    connection,
  );
  await restarted.consumeLease(
    { leaseId: renewed.leaseId, cwd, sessionId: "resume" },
    connection,
  );
  await restarted.validateSession("resume", cwd);
  await restarted.close();
});

test("project source CRUD matches the original schema and never deletes project files", async (t) => {
  const { root, service } = await fixture(t);
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "source.txt"), "source");
  const source = await service.request(sourceMethod("create"), {
    type: "project",
    name: "a-project",
    description: "A project",
    content: "Notes",
    target: { scope: "global" },
    properties: {
      title: "Project A",
      workingDirs: [cwd],
      codeproWorkspaceIdentity: workspaceIdentity(cwd),
    },
  });
  zCreateSourceResponse_unstable.parse(source);
  assert.ok((await stat(source.source.path)).isFile());
  assert.match(await readFile(source.source.path, "utf8"), /Notes/u);
  const restarted = new WorkspaceService(
    {},
    { projectDirectory: path.join(root, "metadata") },
  );
  const listed = await restarted.request(sourceMethod("list"), {
    type: "project",
  });
  zListSourcesResponse_unstable.parse(listed);
  assert.equal(listed.sources[0].properties.title, "Project A");
  const updated = await restarted.request(sourceMethod("update"), {
    type: "project",
    path: source.source.path,
    name: "a-project",
    description: "Changed",
    content: "New notes",
  });
  assert.equal(updated.source.properties.workingDirs[0], cwd);
  const exported = zExportSourceResponse_unstable.parse(
    await restarted.request(sourceMethod("export"), {
      type: "project",
      path: source.source.path,
    }),
  );
  assert.equal(JSON.parse(exported.json).version, 1);
  assert.equal(JSON.parse(exported.json).type, "project");
  const imported = zImportSourcesResponse_unstable.parse(
    await restarted.request(sourceMethod("import"), {
      data: exported.json,
      target: { scope: "global" },
    }),
  );
  assert.equal(imported.sources[0].name, "a-project-imported");
  assert.equal(imported.sources[0].content, "New notes");
  await assert.rejects(
    service.request(sourceMethod("delete"), {
      type: "project",
      path: path.join(cwd, "source.txt"),
    }),
    /not found/,
  );
  await restarted.request(sourceMethod("delete"), {
    type: "project",
    path: source.source.path,
  });
  assert.equal(await readFile(path.join(cwd, "source.txt"), "utf8"), "source");
});

test("the original host inspection and confirmation accept the real acquired workspace", async (t) => {
  const { root, service, connection } = await fixture(t);
  const bundled = await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../../ui/desktop/src/codepro/projectWorkspace.ts",
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const original = await import(
    "data:text/javascript;base64," +
      Buffer.from(bundled.outputFiles[0].text).toString("base64")
  );
  const [candidate] = await original.inspectCodeProWorkspace({
    prompt: "",
    selectedWorkingDir: path.join(root, "new-task"),
  });
  assert.equal(candidate.state, "missing");
  const lease = await service.acquire(
    {
      requestedPath: candidate.normalizedPath,
      expectedState: candidate.state,
      expectedIdentity: candidate.normalizedIdentity,
    },
    connection,
  );
  const confirmation = await original.confirmCodeProWorkspace({
    normalizedPath: lease.workingDir,
    expectedState: "empty-directory",
    expectedIdentity: lease.normalizedIdentity,
  });
  assert.equal(confirmation.workingDir, lease.workingDir);
  await service.consumeLease(
    {
      leaseId: lease.leaseId,
      cwd: confirmation.workingDir,
      sessionId: "original-host",
    },
    connection,
  );
});
