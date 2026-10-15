import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../ui/node_modules/esbuild/lib/main.js";
import { createGitReader, GIT_READ_TOOL_NAMES } from "../git-extension.mjs";
const gitTools = (cwd, options) => createGitReader(cwd, options).tools;

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "codebuddy-git-read-")),
  );
  const cwd = path.join(root, "仓库 with spaces");
  await mkdir(cwd);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  git("config", "core.autocrlf", "false");
  const name = "原 文件.txt";
  await writeFile(path.join(cwd, name), "index baseline\n");
  git("add", "--", name);
  await writeFile(path.join(cwd, name), "working edit\n");
  await writeFile(path.join(cwd, "未跟踪.txt"), "untracked bytes\n");
  const tools = gitTools(cwd, {
    ghCommand: path.join(root, "gh-not-installed"),
  });
  const call = (name, args = {}, execution) =>
    tools.find((tool) => tool.name === name).execute(args, execution);
  return { root, cwd, name, git, tools, call };
}

test("real unborn repository snapshot matches frozen renderer and keeps index, HEAD and files unchanged", async (t) => {
  const f = await fixture();
  const before = await Promise.all(
    [".git/index", ".git/HEAD", f.name, "未跟踪.txt"].map((file) =>
      readFile(path.join(f.cwd, file)),
    ),
  );
  const state = await f.call("git_repository_snapshot");
  assert.equal(
    state.status.repository_root.replaceAll("\\", "/"),
    f.cwd.replaceAll("\\", "/"),
  );
  assert.equal(state.status.detached, false);
  assert.equal(state.status.upstream, null);
  assert.deepEqual(state.status.entries, [
    {
      path: f.name,
      original_path: null,
      index_status: "A",
      worktree_status: "M",
    },
    {
      path: "未跟踪.txt",
      original_path: null,
      index_status: "?",
      worktree_status: "?",
    },
  ]);
  assert.deepEqual(
    state.branches.branches,
    [],
    "unborn branch is a status fact, not an existing ref",
  );
  assert.equal(state.conflicts.operation, "none");
  assert.match(state.diff.text, /-index baseline\n\+working edit/);
  assert.match(state.staged_diff.text, /\+index baseline/);
  assert.ok(
    !state.diff.text.includes("untracked bytes"),
    "Git diff does not pretend to cover untracked content",
  );

  const key = `gitFixture${Date.now()}`;
  globalThis[key] = {
    goose: {
      toolsCall_unstable: async ({ sessionId, name, arguments: args }) => {
        assert.equal(sessionId, "fixture");
        const value = await f.call(name, args);
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        };
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
  const renderer = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  const parsed = await renderer.loadGitRepository("fixture");
  assert.equal(parsed.status.entries[0].indexStatus, "A");
  assert.equal(parsed.status.entries[0].worktreeStatus, "M");
  assert.equal(parsed.stagedDiff.scope, "staged");
  assert.equal(
    (await renderer.loadGitRuntimeStatus("fixture")).available,
    true,
  );
  assert.deepEqual(await renderer.loadGitHubRuntimeStatus("fixture"), {
    available: false,
    authenticated: false,
    version: null,
    hostname: "github.com",
    installUrl: "https://cli.github.com/",
    loginCommand: "gh auth login --hostname github.com --web",
  });
  const after = await Promise.all(
    [".git/index", ".git/HEAD", f.name, "未跟踪.txt"].map((file) =>
      readFile(path.join(f.cwd, file)),
    ),
  );
  assert.deepEqual(after, before);
  assert.deepEqual(
    f.git("for-each-ref").trim(),
    "",
    "fixture creates no branches or commits",
  );
});

test("read adapter binds the session repository, rejects path/argument injection and surfaces cancellation", async () => {
  const f = await fixture(),
    other = await fixture(),
    nested = path.join(f.cwd, "nested");
  await mkdir(nested);
  const tools = gitTools(nested, {
    environment: {
      ...process.env,
      GIT_DIR: path.join(other.cwd, ".git"),
      GIT_WORK_TREE: other.cwd,
      GIT_INDEX_FILE: path.join(other.cwd, ".git/index"),
    },
  });
  const state = await tools
    .find((tool) => tool.name === "git_status")
    .execute({});
  assert.equal(
    state.repository_root.replaceAll("\\", "/"),
    f.cwd.replaceAll("\\", "/"),
  );
  for (const file of [
    "../outside",
    "a/../../outside",
    "C:\\outside",
    "/outside",
    "bad\0name",
  ])
    await assert.rejects(
      f.call("git_diff", { scope: "working_tree", paths: [file] }),
      /repository-relative/,
    );
  await assert.rejects(
    f.call("git_diff", { scope: "base", base: "--output=outside" }),
    /commit reference/,
  );
  await assert.rejects(
    f.call("git_diff", { scope: "staged", base: "HEAD" }),
    /Only base/,
  );
  await assert.rejects(f.call("git_status", { command: "init" }), /arguments/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.call("git_runtime_status", {}, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.deepEqual(
    GIT_READ_TOOL_NAMES,
    f.tools.map((tool) => tool.name),
  );
  assert.ok(
    f.tools.every(
      (tool) =>
        tool.annotations.readOnlyHint && !tool.annotations.destructiveHint,
    ),
  );
  assert.ok(
    !f.tools.some((tool) =>
      ["git_init", "git_stage", "git_commit", "git_push"].includes(tool.name),
    ),
  );
});

test("bounded actual diff preserves UTF-8 while not-a-repository and missing Git stay distinct", async () => {
  const f = await fixture();
  await writeFile(path.join(f.cwd, f.name), "新增中文字符\n".repeat(7000));
  const diff = await f.call("git_diff", { scope: "working_tree" });
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.text) <= 65536);
  assert.ok(!diff.text.includes("\ufffd"));
  const emptyDir = path.join(f.root, "not-a-repository");
  await mkdir(emptyDir);
  const noRepo = gitTools(emptyDir);
  await assert.rejects(
    noRepo.find((tool) => tool.name === "git_status").execute({}),
    /failed/,
  );
  assert.equal(
    (
      await noRepo
        .find((tool) => tool.name === "git_runtime_status")
        .execute({})
    ).available,
    true,
  );
  const absent = gitTools(emptyDir, {
    gitCommand: path.join(f.root, "git-not-installed"),
  });
  assert.deepEqual(
    await absent.find((tool) => tool.name === "git_runtime_status").execute({}),
    {
      available: false,
      version: null,
      install_url: "https://git-scm.com/downloads",
    },
  );
});

test("conflict stages are read from the actual index without making a commit or switching a branch", async () => {
  const f = await fixture();
  const hash = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: f.cwd,
    input: "conflict fixture\n",
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  execFileSync("git", ["update-index", "--index-info"], {
    cwd: f.cwd,
    input: `0 ${"0".repeat(40)}\t${f.name}\n100644 ${hash} 1\t${f.name}\n100644 ${hash} 2\t${f.name}\n100644 ${hash} 3\t${f.name}\n`,
    encoding: "utf8",
    windowsHide: true,
  });
  const index = await readFile(path.join(f.cwd, ".git/index"));
  const state = await f.call("git_conflicts");
  assert.deepEqual(state, {
    has_conflicts: true,
    total_conflicts: 1,
    truncated: false,
    operation: "unknown",
    conflicts: [
      { path: f.name, code: "UU", kind: "both_modified", stages: [1, 2, 3] },
    ],
  });
  assert.equal((await f.call("git_status")).entries[0].index_status, "U");
  assert.deepEqual(await readFile(path.join(f.cwd, ".git/index")), index);
  assert.equal(f.git("for-each-ref").trim(), "");
});

test("read-only status and diff suppress configured clean filters, diff commands and fsmonitor hooks", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.cwd, ".gitattributes"),
    "*.txt filter=fixture diff=fixture\n",
  );
  const marker = path.join(f.cwd, "unexpected-filter-ran");
  await writeFile(
    path.join(f.cwd, "filter.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.exit(7);`,
  );
  const command = `"${process.execPath.replaceAll("\\", "/")}" filter.cjs`;
  f.git("config", "filter.fixture.clean", command);
  f.git("config", "filter.fixture.required", "true");
  f.git("config", "diff.fixture.command", command);
  f.git("config", "core.fsmonitor", command);
  const snapshot = await f.call("git_repository_snapshot");
  assert.match(snapshot.diff.text, /working edit/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
