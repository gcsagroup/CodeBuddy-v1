"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const {
  defaultWorkspaceRoot,
  prepareDefaultWorkspace,
} = require("./default-workspace.cjs");

test("default workspaces are outside the application checkout and portable across platforms", () => {
  assert.equal(
    defaultWorkspaceRoot({
      env: {},
      platform: "win32",
      home: "C:\\Users\\Test",
    }),
    "C:\\Users\\Test\\.CodeBuddy\\workspaces",
  );
  assert.equal(
    defaultWorkspaceRoot({
      platform: "win32",
      home: "C:\\Users\\Test",
      env: { CODEBUDDY_HOME: "E:\\My CodeBuddy" },
    }),
    "E:\\My CodeBuddy\\workspaces",
  );
  assert.equal(
    defaultWorkspaceRoot({ env: {}, platform: "darwin", home: "/Users/test" }),
    "/Users/test/.CodeBuddy/workspaces",
  );
  assert.throws(
    () =>
      defaultWorkspaceRoot({
        env: { CODEBUDDY_WORKSPACE_ROOT: "D:\\" },
        platform: "win32",
      }),
    /non-root/,
  );
  assert.throws(
    () =>
      defaultWorkspaceRoot({ env: { CODEBUDDY_WORKSPACE_ROOT: "relative" } }),
    /absolute/,
  );
});

test("preparing an existing configured workspace retains its files", (t) => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "codebuddy-default-workspace-"),
  );
  t.after(() => {
    assert.ok(path.basename(parent).startsWith("codebuddy-default-workspace-"));
    assert.equal(path.dirname(parent), os.tmpdir());
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const root = defaultWorkspaceRoot({
    env: { CODEBUDDY_WORKSPACE_ROOT: path.join(parent, "work") },
  });
  prepareDefaultWorkspace(root);
  fs.writeFileSync(path.join(root, "retain.txt"), "existing project");
  assert.equal(prepareDefaultWorkspace(root), fs.realpathSync(root));
  assert.equal(
    fs.readFileSync(path.join(root, "retain.txt"), "utf8"),
    "existing project",
  );
  assert.deepEqual(fs.readdirSync(root), ["retain.txt"]);
});
