import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCompatServer } from "../server.mjs";
import { workspaceIdentity } from "../workspaces.mjs";
import {
  GIT_READ_TOOL_NAMES,
  GIT_WRITE_TOOL_NAMES,
} from "../git-extension.mjs";
import { zGooseToolCallResponse_unstable } from "../../ui/sdk/src/generated/zod.gen.ts";

const secret = "isolated-git-acp-fixture-secret";
const ext = (name) => `_goose/unstable/${name}`;
async function connect(url) {
  const socket = new WebSocket(
    `${url.replace("http:", "ws:")}/acp?token=${secret}`,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map(),
    permissions = [], notifications = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === "session/request_permission") {
      permissions.push(message.params);
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { outcome: { outcome: "selected", optionId: "allow_once" } },
        }),
      );
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) { if (message.method === 'session/update') notifications.push(message.params); return; }
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    message.error
      ? waiter.reject(new Error(message.error.message))
      : waiter.resolve(message.result);
  });
  return {
    permissions,
    notifications,
    close: () => socket.close(),
    request(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP fixture timeout: ${method}`));
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
  };
}

test(
  "real ACP bare Git tools use SDK receipts: panel reads and restore previews skip prompts, local writes obey ask/deny",
  { timeout: 90_000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "codebuddy-git-acp-")),
    );
    const cwd = path.join(root, "project"),
      profile = path.join(root, "empty-cli-profile");
    await mkdir(cwd);
    await mkdir(profile);
    const previous = new Map(
      ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME"].map((key) => [
        key,
        process.env[key],
      ]),
    );
    // Isolate gh's existing CLI login/config files without altering PATH or user/machine environment.
    for (const key of previous.keys()) process.env[key] = profile;
    let app, client;
    const modelRequests = [];
    const model = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      modelRequests.push({
        url: request.url,
        body: body ? JSON.parse(body) : null,
      });
      response.setHeader("content-type", "application/json");
      if (request.url.endsWith("/models"))
        response.end(JSON.stringify({ data: [{ id: "git-fixture-model" }] }));
      else
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Local provider validation fixture",
                },
              },
            ],
          }),
        );
    });
    t.after(async () => {
      client?.close();
      await app?.close();
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
      for (const [key, value] of previous)
        value === undefined
          ? delete process.env[key]
          : (process.env[key] = value);
      assert.equal(
        path.dirname(root).toLowerCase(),
        (await realpath(tmpdir())).toLowerCase(),
      );
      assert.ok(path.basename(root).startsWith("codebuddy-git-acp-"));
      await rm(root, { recursive: true, force: true });
    });
    const git = (...args) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    git("init", "--initial-branch=main");
    git("config", "--local", "user.name", "Isolated ACP fixture");
    git("config", "--local", "user.email", "acp-fixture@example.invalid");
    git("config", "--local", "commit.gpgsign", "false");
    git("config", "--local", "core.autocrlf", "false");
    await writeFile(path.join(cwd, "file.txt"), "original\n");
    git("add", "--", "file.txt");
    git("commit", "-m", "Isolated ACP baseline");
    await writeFile(path.join(cwd, "file.txt"), "changed\n");
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    app = await createCompatServer({
      dataDir: path.join(root, "data"),
      secret,
    });
    client = await connect(await app.listen());
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const provider = await client.request(ext("providers/custom/create"), {
      engine: "openai_compatible",
      displayName: "Git local fixture",
      apiUrl: `http://127.0.0.1:${model.address().port}`,
      requiresAuth: false,
      models: ["git-fixture-model"],
      supportsStreaming: true,
      headers: {},
    });
    await client.request(ext("defaults/save"), {
      providerId: provider.providerId,
      modelId: "git-fixture-model",
    });
    const lease = await client.request(ext("workspace/lease/acquire"), {
      requestedPath: cwd,
      expectedState: "non-empty-directory",
      expectedIdentity: workspaceIdentity(cwd),
    });
    const { sessionId } = await client.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: {
        workspaceMode: "codepro",
        workspaceLeaseId: lease.leaseId,
        enabledExtensions: [{ type: "builtin", name: "git" }],
      },
    });
    await client.request("session/set_mode", { sessionId, modeId: "approve" });
    const setupModelRequests = modelRequests.filter(request => request.body).length;
    const toolList = await client.request(ext("tools/list"), {
      sessionId,
      extensionName: "git",
    });
    assert.deepEqual(
      toolList.tools.map((tool) => tool.name).sort(),
      [...GIT_READ_TOOL_NAMES, ...GIT_WRITE_TOOL_NAMES]
        .map((name) => `git__${name}`)
        .sort(),
    );
    const call = async (name, args = {}) =>
      zGooseToolCallResponse_unstable.parse(
        await client.request(ext("tools/call"), {
          sessionId,
          name,
          arguments: args,
        }),
      );
    const permission = async (names, level) =>
      client.request(ext("tools/permissions/set"), {
        toolPermissions: names.map((name) => ({
          toolName: `git__${name}`,
          permission: level,
        })),
      });
    for (const name of GIT_READ_TOOL_NAMES) {
      const result = await call(
        name,
        name === "git_diff" ? { scope: "working_tree" } : name === "git_restore_preview" ? { paths: ["file.txt"] } : {},
      );
      assert.equal(result.isError, false, name);
      if (name === "github_runtime_status")
        assert.equal(
          JSON.parse(result.content[0].text).authenticated,
          false,
          "isolated CLI profile has no user GitHub login",
        );
    }
    assert.equal(
      client.permissions.length,
      0,
      "opening/polling the panel and previewing changes does not ask for read approvals",
    );
    assert.equal(client.notifications.filter(n => n.update._meta?.goose?.directToolCall).length, 0);
    await permission(GIT_WRITE_TOOL_NAMES, "ask_before");
    const writes = [
      ["git_stage", { paths: ["file.txt"] }],
      ["git_unstage", { paths: ["file.txt"] }],
      ["git_branch_create", { name: "fixture/acp-branch" }],
      ["git_branch_switch", { name: "main" }],
    ];
    for (const [name, args] of writes) {
      const before = client.permissions.length;
      assert.equal((await call(name, args)).isError, false, name);
      assert.equal(
        client.permissions.length,
        before + 1,
        `${name} needs one actual ACP approval`,
      );
      assert.equal(client.permissions.at(-1).toolCall.title, name);
      assert.equal(client.permissions.at(-1)._meta.goose.directToolCall, true);
      const callId = client.permissions.at(-1).toolCall.toolCallId;
      assert.deepEqual(client.notifications.filter(n => n.update.toolCallId === callId).map(n => [n.update.sessionUpdate, n.update.status, n.update._meta.goose.directToolCall]), [
        ['tool_call', 'in_progress', true], ['tool_call_update', 'completed', true],
      ]);
    }
    assert.equal(
      (await call("git_stage", { paths: ["file.txt"] })).isError,
      false,
    );
    const beforeCommit = client.permissions.length,
      committed = await call("git_commit", {
        message: "Actual ACP approved commit",
      });
    assert.equal(committed.isError, false);
    assert.equal(client.permissions.length, beforeCommit + 1);
    assert.equal(
      JSON.parse(committed.content[0].text).commit,
      git("rev-parse", "HEAD").trim(),
    );
    await writeFile(path.join(cwd, "file.txt"), "discard this previewed change\n");
    const preview = (await call("git_restore_preview", { paths: ["file.txt"] })).structuredContent;
    const beforeRestore = client.permissions.length;
    assert.equal((await call("git_restore", { paths: preview.paths, preflight_id: preview.preflight_id })).isError, false);
    assert.equal(client.permissions.length, beforeRestore + 1, "restore requires actual ACP approval");
    assert.equal(client.permissions.at(-1).toolCall.title, "git_restore");
    assert.equal(await readFile(path.join(cwd, "file.txt"), "utf8"), "changed\n");
    await writeFile(path.join(cwd, "file.txt"), "must remain uncommitted\n");
    await permission(
      [...GIT_WRITE_TOOL_NAMES, ...GIT_READ_TOOL_NAMES],
      "never_allow",
    );
    const beforeDenied = client.permissions.length,
      head = git("rev-parse", "HEAD"),
      index = await readFile(path.join(cwd, ".git", "index"));
    for (const [name, args] of [
      ...writes,
      ["git_commit", { message: "Denied commit" }],
      ["git_restore", { paths: preview.paths, preflight_id: preview.preflight_id }],
    ])
      assert.equal((await call(name, args)).isError, true, name);
    for (const name of GIT_READ_TOOL_NAMES)
      assert.equal(
        (await call(name, name === "git_diff" ? { scope: "working_tree" } : {}))
          .isError,
        true,
        name,
      );
    assert.equal(
      client.permissions.length,
      beforeDenied,
      "never_allow rejects without requesting approval",
    );
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(path.join(cwd, ".git", "index")), index);
    assert.equal(
      await readFile(path.join(cwd, "file.txt"), "utf8"),
      "must remain uncommitted\n",
    );
    await permission(GIT_READ_TOOL_NAMES, "ask_before");
    await client.request(ext("session/extensions/remove"), {
      sessionId,
      name: "git",
    });
    const unavailable = await call("git_status");
    assert.equal(
      unavailable.isError,
      true,
      "explicit panel reads cannot bypass a removed extension",
    );
    assert.deepEqual(
      (
        await client.request(ext("tools/list"), {
          sessionId,
          extensionName: "git",
        })
      ).tools,
      [],
    );
    await client.request(ext("session/extensions/add"), {
      sessionId,
      extension: { type: "builtin", name: "git" },
    });
    const restored = await client.request(ext("tools/list"), {
      sessionId,
      extensionName: "git",
    });
    assert.equal(restored.tools.length, 14);
    assert.equal((await call("git_status")).isError, false);
    assert.equal(
      (await call("git_stage", { paths: ["file.txt"] })).isError,
      true,
      "re-enabling an extension preserves never_allow",
    );
    assert.equal(client.permissions.length, beforeDenied);
    assert.equal(
      modelRequests.filter(request => request.body).length,
      setupModelRequests,
      "host tool execution adds no model completions after provider validation (capacity discovery is read-only)",
    );
    assert.ok(
      modelRequests.every((request) => !request.body?.stream),
      "no model agent turn was executed",
    );
  },
);
