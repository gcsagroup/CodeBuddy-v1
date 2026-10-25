import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "../../ui/node_modules/esbuild/lib/main.js";
import { zGooseToolCallResponse_unstable } from "../../ui/sdk/src/generated/zod.gen.ts";
import {
  gitTools,
  createGitReader,
  GIT_TOOL_NAMES,
  GIT_WRITE_TOOL_NAMES,
} from "../git-extension.mjs";

// Every Git write, branch and commit in this file belongs to this disposable fixture.
async function fixture(t, { initialCommit = true } = {}) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "codebuddy-git-write-")),
  );
  t.after(async () => {
    assert.equal(
      path.dirname(root).toLowerCase(),
      (await realpath(tmpdir())).toLowerCase(),
    );
    assert.ok(path.basename(root).startsWith("codebuddy-git-write-"));
    await rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "临时仓库 with spaces");
  await mkdir(cwd);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "--initial-branch=main");
  for (const [key, value] of [
    ["user.name", "Isolated Git Fixture"],
    ["user.email", "git-fixture@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
  ])
    git("config", "--local", key, value);
  const file = "原 文件.txt";
  await writeFile(path.join(cwd, file), "baseline\n");
  if (initialCommit) {
    git("add", "--", file);
    git("commit", "-m", "Fixture baseline");
  }
  const tools = gitTools(cwd);
  const call = (name, args = {}, execution = {}) =>
    tools.find((tool) => tool.name === name).execute(args, execution);
  return { root, cwd, file, git, tools, call };
}

async function renderer(t, f) {
  const key = `gitWriteFixture${randomUUID()}`;
  globalThis[key] = {
    goose: {
      toolsCall_unstable: async ({ sessionId, name, arguments: args }) => {
        assert.equal(sessionId, "isolated-fixture");
        const value = await f.call(name, args);
        return zGooseToolCallResponse_unstable.parse({
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      },
    },
  };
  t.after(() => {
    delete globalThis[key];
  });
  const bundled = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../ui/desktop/src/acp/git.ts", import.meta.url),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [
      {
        name: "fixture-acp-transport",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/acpConnection$/ }, () => ({
            path: "acp",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `export const getAcpControlClient = async () => globalThis[${JSON.stringify(key)}];`,
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
}

test("unstaging an unborn repository preserves working bytes and unrelated index entries", async (t) => {
  const f = await fixture(t, { initialCommit: false });
  await writeFile(path.join(f.cwd, "other.txt"), "keep staged\n");
  f.git("add", "--", f.file, "other.txt");
  await writeFile(path.join(f.cwd, f.file), "edited after staging\n");
  const other = f.git("ls-files", "--stage", "--", "other.txt");
  assert.deepEqual(await f.call("git_unstage", { paths: [f.file] }), {
    unstaged_paths: [f.file],
  });
  assert.equal(f.git("ls-files", "--", f.file), "");
  assert.equal(f.git("ls-files", "--stage", "--", "other.txt"), other);
  assert.equal(
    await readFile(path.join(f.cwd, f.file), "utf8"),
    "edited after staging\n",
  );
  assert.equal(
    await readFile(path.join(f.cwd, "other.txt"), "utf8"),
    "keep staged\n",
  );
  assert.throws(() => f.git("rev-parse", "--verify", "HEAD"));
});

test("original renderer parses five real local Git write receipts; commit contains only staging area", async (t) => {
  const f = await fixture(t),
    ui = await renderer(t, f);
  await writeFile(path.join(f.cwd, f.file), "selected edit\n");
  await writeFile(path.join(f.cwd, "keep-untracked.txt"), "not selected\n");
  assert.deepEqual(await ui.stageGitPaths("isolated-fixture", [f.file]), {
    stagedPaths: [f.file],
  });
  assert.equal(f.git("show", `:${f.file}`), "selected edit\n");
  assert.deepEqual(await ui.unstageGitPaths("isolated-fixture", [f.file]), {
    unstagedPaths: [f.file],
  });
  assert.equal(f.git("show", `:${f.file}`), "baseline\n");
  assert.equal(
    await readFile(path.join(f.cwd, f.file), "utf8"),
    "selected edit\n",
  );
  await ui.stageGitPaths("isolated-fixture", [f.file]);
  await writeFile(path.join(f.cwd, f.file), "later unstaged edit\n");
  const receipt = await ui.commitStagedGitChanges(
    "isolated-fixture",
    "  中文提交\n\nPreserve body  ",
  );
  assert.equal(receipt.commit, f.git("rev-parse", "HEAD").trim());
  assert.equal(receipt.branch, "main");
  assert.equal(receipt.subject, "中文提交");
  assert.deepEqual(receipt.committedPaths, [f.file]);
  assert.equal(f.git("show", `HEAD:${f.file}`), "selected edit\n");
  assert.equal(
    await readFile(path.join(f.cwd, f.file), "utf8"),
    "later unstaged edit\n",
  );
  assert.deepEqual(
    f.git("ls-tree", "--name-only", "-z", "HEAD").split("\0").filter(Boolean),
    [f.file],
  );
  assert.deepEqual(
    await ui.createGitBranch("isolated-fixture", " fixture/next "),
    { branch: "fixture/next", created: true },
  );
  assert.deepEqual(await ui.switchGitBranch("isolated-fixture", "main"), {
    branch: "main",
    created: false,
  });
  assert.equal(
    await readFile(path.join(f.cwd, f.file), "utf8"),
    "later unstaged edit\n",
  );
  assert.deepEqual(
    GIT_TOOL_NAMES,
    f.tools.map((tool) => tool.name),
  );
  assert.deepEqual(
    f.tools
      .filter((tool) => !tool.annotations.readOnlyHint)
      .map((tool) => tool.name),
    GIT_WRITE_TOOL_NAMES,
  );
  assert.equal(
    createGitReader(f.cwd).tools.length,
    GIT_TOOL_NAMES.length - GIT_WRITE_TOOL_NAMES.length,
  );
  assert.ok(
    createGitReader(f.cwd).tools.every((tool) => tool.annotations.readOnlyHint),
  );
});

test("explicit paths reject traversal, metadata, pathspec magic, directories and stale selections before index mutation", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, "nested"));
  await writeFile(path.join(f.cwd, "nested", "file.txt"), "only file\n");
  await writeFile(
    path.join(f.cwd, "-option-like.txt"),
    "literal option filename\n",
  );
  const index = await readFile(path.join(f.cwd, ".git", "index"));
  for (const selected of [
    [],
    ["../outside"],
    ["/absolute"],
    ["C:\\outside"],
    ["."],
    ["nested"],
    [".git/config"],
    ["nested/../file"],
    [":(top)**"],
    ["*.txt"],
    ["missing"],
    ["-option-like.txt", "-option-like.txt"],
  ]) {
    await assert.rejects(f.call("git_stage", { paths: selected }));
    assert.deepEqual(await readFile(path.join(f.cwd, ".git", "index")), index);
  }
  await assert.rejects(
    f.call("git_stage", { paths: ["-option-like.txt"], force: true }),
    /arguments/,
  );
  await f.call("git_stage", { paths: ["-option-like.txt", "nested/file.txt"] });
  assert.deepEqual(
    f.git("diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean),
    ["-option-like.txt", "nested/file.txt"],
  );
  const nestedTools = gitTools(path.join(f.cwd, "nested"));
  await nestedTools
    .find((tool) => tool.name === "git_unstage")
    .execute({ paths: ["nested/file.txt"] });
  assert.deepEqual(
    f.git("diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean),
    ["-option-like.txt"],
  );
});

test("initial commit works while invalid messages, missing branches, dirty checkout and detached HEAD remain real Git failures", async (t) => {
  const unborn = await fixture(t, { initialCommit: false });
  await unborn.call("git_stage", { paths: [unborn.file] });
  await unborn.call("git_commit", {
    message: "First commit in isolated fixture",
  });
  await assert.rejects(
    unborn.call("git_commit", { message: "Empty commit" }),
    /No staged/,
  );
  for (const message of ["", " ", "x\0y", "a".repeat(4097)])
    await assert.rejects(
      unborn.call("git_commit", { message }),
      /Commit message/,
    );
  for (const name of [
    "--detach",
    "@{-1}",
    "bad..ref",
    "name with space",
    "refs/.hidden",
  ])
    await assert.rejects(unborn.call("git_branch_create", { name }));
  await assert.rejects(
    unborn.call("git_branch_switch", { name: "missing" }),
    /does not exist/,
  );
  await unborn.call("git_branch_create", { name: "fixture/change" });
  await writeFile(path.join(unborn.cwd, unborn.file), "other branch\n");
  await unborn.call("git_stage", { paths: [unborn.file] });
  await unborn.call("git_commit", { message: "Change in fixture branch" });
  await unborn.call("git_branch_switch", { name: "main" });
  await writeFile(
    path.join(unborn.cwd, unborn.file),
    "uncommitted protected content\n",
  );
  await assert.rejects(
    unborn.call("git_branch_switch", { name: "fixture/change" }),
    /failed/,
  );
  assert.equal(unborn.git("branch", "--show-current").trim(), "main");
  assert.equal(
    await readFile(path.join(unborn.cwd, unborn.file), "utf8"),
    "uncommitted protected content\n",
  );
  unborn.git("switch", "--detach");
  await unborn.call("git_stage", { paths: [unborn.file] });
  await assert.rejects(
    unborn.call("git_commit", { message: "Detached" }),
    /local branch/,
  );
});

test("repository hooks stay disabled and filter/signing configurations fail explicitly before content changes", async (t) => {
  const f = await fixture(t),
    marker = path.join(f.cwd, "hook-ran");
  const hook = path.join(f.cwd, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nprintf executed > hook-ran\nexit 1\n");
  await chmod(hook, 0o755);
  await writeFile(path.join(f.cwd, f.file), "without hook\n");
  await f.call("git_stage", { paths: [f.file] });
  await f.call("git_commit", {
    message: "Hooks remain disabled as in original host",
  });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await writeFile(path.join(f.cwd, f.file), "signing boundary\n");
  await f.call("git_stage", { paths: [f.file] });
  const head = f.git("rev-parse", "HEAD");
  f.git("config", "--local", "commit.gpgsign", "true");
  await assert.rejects(
    f.call("git_commit", { message: "Must preserve signing requirement" }),
    /signing is configured/,
  );
  assert.equal(f.git("rev-parse", "HEAD"), head);
  f.git("config", "--local", "commit.gpgsign", "false");
  await writeFile(path.join(f.cwd, ".gitattributes"), "*.txt filter=fixture\n");
  f.git(
    "config",
    "--local",
    "filter.fixture.clean",
    "echo filter-ran > filter-marker",
  );
  f.git(
    "config",
    "--local",
    "filter.fixture.smudge",
    "echo filter-ran > filter-marker",
  );
  f.git("config", "--local", "filter.fixture.required", "true");
  const index = await readFile(path.join(f.cwd, ".git", "index"));
  await assert.rejects(
    f.call("git_stage", { paths: [f.file] }),
    /external Git filters/,
  );
  await assert.rejects(
    f.call("git_branch_create", { name: "fixture/filter" }),
    /external Git filters/,
  );
  assert.deepEqual(await readFile(path.join(f.cwd, ".git", "index")), index);
  await assert.rejects(readFile(path.join(f.cwd, "filter-marker")), {
    code: "ENOENT",
  });
  assert.equal(f.git("show-ref", "--heads").includes("fixture/filter"), false);
  const target = await fixture(t);
  target.git("switch", "-c", "fixture/filtered-target");
  await writeFile(
    path.join(target.cwd, ".gitattributes"),
    "*.txt filter=targetfixture\n",
  );
  target.git("add", "--", ".gitattributes");
  target.git("commit", "-m", "Target attributes fixture");
  target.git("switch", "main");
  target.git(
    "config",
    "--local",
    "filter.targetfixture.smudge",
    "echo target-filter > target-filter-marker",
  );
  await assert.rejects(
    target.call("git_branch_switch", { name: "fixture/filtered-target" }),
    /external Git filters/,
  );
  assert.equal(target.git("branch", "--show-current").trim(), "main");
  await assert.rejects(
    readFile(path.join(target.cwd, "target-filter-marker")),
    { code: "ENOENT" },
  );
});

test("writes across session adapters serialize with snapshots and failed operations release the repository queue", async (t) => {
  const f = await fixture(t),
    otherTools = gitTools(f.cwd);
  const other = (name, args) =>
    otherTools.find((tool) => tool.name === name).execute(args);
  await writeFile(path.join(f.cwd, "a.txt"), "a\n");
  await writeFile(path.join(f.cwd, "b.txt"), "b\n");
  const results = await Promise.all([
    f.call("git_stage", { paths: ["a.txt"] }),
    other("git_stage", { paths: ["b.txt"] }),
    f.call("git_repository_snapshot"),
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(
    f.git("diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean),
    ["a.txt", "b.txt"],
  );
  const simultaneous = await Promise.allSettled([
    f.call("git_commit", { message: "One real commit" }),
    other("git_commit", { message: "Second sees empty index" }),
  ]);
  assert.equal(
    simultaneous.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    simultaneous.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(f.git("rev-list", "--count", "HEAD").trim(), "2");
  assert.deepEqual((await f.call("git_status")).entries, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.call(
      "git_branch_create",
      { name: "fixture/cancelled" },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(
    f.git("show-ref", "--heads").includes("fixture/cancelled"),
    false,
  );
});

test("actual child processes receive fixed argv, no shell and only Git runtime environment", async (t) => {
  const f = await fixture(t),
    original = childProcess.execFile,
    observed = [];
  childProcess.execFile = function (binary, args, options, callback) {
    observed.push({ binary, args, options });
    return original(binary, args, options, callback);
  };
  const observer = childProcess.execFile;
  observer[promisify.custom] = (...args) => {
    let child;
    const pending = new Promise((resolve, reject) => {
      child = observer(...args, (error, stdout, stderr) =>
        error
          ? reject(Object.assign(error, { stdout, stderr }))
          : resolve({ stdout, stderr }),
      );
    });
    pending.child = child;
    return pending;
  };
  syncBuiltinESMExports();
  let isolated;
  try {
    isolated = await import(`../git-extension.mjs?observe=${randomUUID()}`);
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
  const tools = isolated.gitTools(f.cwd, {
    environment: {
      ...process.env,
      OPENAI_API_KEY: "fixture-secret",
      GH_TOKEN: "fixture-secret",
      MCP_SECRET: "fixture-secret",
      NODE_OPTIONS: "--invalid-fixture-option",
      GIT_DIR: path.join(f.root, "wrong"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "injected",
    },
  });
  await writeFile(path.join(f.cwd, "argv;literal.txt"), "literal filename\n");
  await tools
    .find((tool) => tool.name === "git_stage")
    .execute({ paths: ["argv;literal.txt"] });
  assert.ok(observed.length > 0);
  for (const { binary, args, options } of observed) {
    assert.equal(binary, "git");
    assert.ok(Array.isArray(args));
    assert.notEqual(options.shell, true);
    for (const key of [
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "MCP_SECRET",
      "NODE_OPTIONS",
      "GIT_DIR",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_VALUE_0",
    ])
      assert.equal(options.env[key], undefined);
  }
  assert.ok(
    observed.some(
      ({ args }) => args.slice(-3).join("|") === "add|--|argv;literal.txt",
    ),
  );
  assert.equal(f.git("show", ":argv;literal.txt"), "literal filename\n");
});

test("restore preview uses the existing renderer contract and preserves staging and unrelated files", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, f.file), "staged revision\n");
  f.git("add", "--", f.file);
  await writeFile(path.join(f.cwd, f.file), "discard this working change\n");
  await writeFile(path.join(f.cwd, "keep.txt"), "untracked bytes\n");
  const index = f.git("ls-files", "--stage", "-z");
  const ui = await renderer(t, f);
  const preview = await ui.previewGitRestore("isolated-fixture", [f.file]);
  assert.deepEqual(preview.blockedReasons, []);
  assert.deepEqual(preview.changedPaths, [f.file]);
  assert.match(preview.diff, /discard this working change/);
  const result = await ui.restoreGitPaths("isolated-fixture", preview);
  assert.deepEqual(result.restoredPaths, [f.file]);
  assert.equal(
    await readFile(path.join(f.cwd, f.file), "utf8"),
    "staged revision\n",
  );
  assert.equal(f.git("ls-files", "--stage", "-z"), index);
  assert.equal(
    await readFile(path.join(f.cwd, "keep.txt"), "utf8"),
    "untracked bytes\n",
  );
});

test("restore rejects stale binary previews, changed index and cross-workspace tokens without touching bytes", async (t) => {
  const f = await fixture(t);
  const initial = Buffer.from([0, 1, 2, 3]);
  await writeFile(path.join(f.cwd, f.file), initial);
  const p = await f.call("git_restore_preview", { paths: [f.file] });
  const changed = Buffer.from([0, 1, 2, 4]);
  await writeFile(path.join(f.cwd, f.file), changed);
  await assert.rejects(
    f.call("git_restore", { paths: [f.file], preflight_id: p.preflight_id }),
    /stale/i,
  );
  assert.deepEqual(await readFile(path.join(f.cwd, f.file)), changed);
  const p2 = await f.call("git_restore_preview", { paths: [f.file] });
  f.git("add", "--", f.file);
  await writeFile(path.join(f.cwd, f.file), initial);
  await assert.rejects(
    f.call("git_restore", { paths: [f.file], preflight_id: p2.preflight_id }),
    /stale/i,
  );
  await mkdir(path.join(f.cwd, "subdir"));
  const childTool = gitTools(path.join(f.cwd, "subdir")).find(
    (t) => t.name === "git_restore",
  );
  const p3 = await f.call("git_restore_preview", { paths: [f.file] });
  await assert.rejects(
    childTool.execute({ paths: [f.file], preflight_id: p3.preflight_id }),
    /stale/i,
  );
  assert.deepEqual(await readFile(path.join(f.cwd, f.file)), initial);
});

test("restore preview blocks untracked and conflict paths and refuses path escapes", async (t) => {
  const f = await fixture(t, { initialCommit: false });
  const p = await f.call("git_restore_preview", { paths: [f.file] });
  assert.ok(p.blocked_reasons.length > 0);
  await assert.rejects(
    f.call("git_restore", { paths: [f.file], preflight_id: p.preflight_id }),
    /blocked/i,
  );
  await assert.rejects(
    f.call("git_restore_preview", { paths: ["../outside"] }),
  );
  f.git("add", "--", f.file);
  const oid = f.git("rev-parse", ":" + f.file).trim();
  const input =
    "0 " +
    "0".repeat(40) +
    "\t" +
    f.file +
    "\n100644 " +
    oid +
    " 1\t" +
    f.file +
    "\n100644 " +
    oid +
    " 2\t" +
    f.file +
    "\n100644 " +
    oid +
    " 3\t" +
    f.file +
    "\n";
  execFileSync("git", ["update-index", "--index-info"], {
    cwd: f.cwd,
    input,
    windowsHide: true,
  });
  const conflict = await f.call("git_restore_preview", { paths: [f.file] });
  assert.ok(conflict.blocked_reasons.some((x) => /conflict/i.test(x)));
  await assert.rejects(
    f.call("git_restore", {
      paths: [f.file],
      preflight_id: conflict.preflight_id,
    }),
    /blocked/i,
  );
  assert.equal(await readFile(path.join(f.cwd, f.file), "utf8"), "baseline\n");
});
