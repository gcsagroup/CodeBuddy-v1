import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitTools } from "../git-extension.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "codebuddy-git-remote-"));
  t.after(async () => {
    assert.equal(
      (await realpath(path.dirname(root))).toLowerCase(),
      (await realpath(tmpdir())).toLowerCase(),
    );
    assert.ok(path.basename(root).startsWith("codebuddy-git-remote-"));
    await rm(root, { recursive: true, force: true });
  });
  const local = path.join(root, "本地 仓库"),
    peer = path.join(root, "peer"),
    remote = path.join(root, "remote.git");
  await mkdir(local);
  await mkdir(peer);
  const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(root, "init", "--bare", "--initial-branch=main", remote);
  for (const cwd of [local, peer]) {
    git(cwd, "init", "--initial-branch=main");
    git(cwd, "config", "--local", "user.name", "CodeBuddy acceptance");
    git(cwd, "config", "--local", "user.email", "acceptance@example.invalid");
    git(cwd, "config", "--local", "commit.gpgsign", "false");
    git(cwd, "config", "--local", "core.autocrlf", "false");
    git(cwd, "remote", "add", "origin", remote);
  }
  await writeFile(path.join(local, "file.txt"), "baseline\n");
  git(local, "add", "file.txt");
  git(local, "commit", "-m", "fixture baseline");
  const tools = gitTools(local);
  const call = async (name, args = {}) => {
    const tool = tools.find((tool) => tool.name === name);
    assert.ok(tool, `${name} must be available to the existing repository UI`);
    return tool.execute(args, {});
  };
  return { root, local, peer, remote, git, call };
}

test("real remote lifecycle: preview, first push, tracking, incoming pull, divergence refusal and stale push", async (t) => {
  const f = await fixture(t);
  const { local, peer, remote, git, call } = f;
  const target = { remote: "origin", branch: "main" };
  const initial = await call("git_push_preview", target);
  assert.deepEqual(initial.blocked_reasons, []);
  assert.equal(initial.outgoing_commit_count, 1);
  await call("git_push", { ...target, preflight_id: initial.preflight_id });
  assert.equal(
    git(remote, "rev-parse", "main"),
    git(local, "rev-parse", "HEAD"),
  );
  assert.equal(
    git(local, "rev-parse", "--abbrev-ref", "@{upstream}"),
    "origin/main",
  );
  git(peer, "pull", "--ff-only", "origin", "main");
  await writeFile(path.join(peer, "incoming.txt"), "remote change\n");
  git(peer, "add", ".");
  git(peer, "commit", "-m", "incoming");
  git(peer, "push", "origin", "main");
  await call("git_pull", target);
  assert.equal(
    await readFile(path.join(local, "incoming.txt"), "utf8"),
    "remote change\n",
  );
  await writeFile(path.join(local, "file.txt"), "local update\n");
  await call("git_stage", { paths: ["file.txt"] });
  await call("git_commit", { message: "local update" });
  const preview = await call("git_push_preview", target);
  assert.equal(preview.outgoing_commit_count, 1);
  await call("git_branch_create", { name: "fixture/feature" });
  await assert.rejects(
    call("git_push", { ...target, preflight_id: preview.preflight_id }),
    /stale/,
  );
  await call("git_branch_switch", { name: "main" });
  await writeFile(path.join(peer, "peer.txt"), "divergent remote\n");
  git(peer, "add", ".");
  git(peer, "commit", "-m", "divergent");
  git(peer, "push", "origin", "main");
  const before = git(local, "rev-parse", "HEAD");
  await assert.rejects(call("git_pull", target));
  assert.equal(git(local, "rev-parse", "HEAD"), before);
  const blocked = await call("git_push_preview", target);
  assert.ok(blocked.blocked_reasons.length);
  await assert.rejects(
    call("git_push", { ...target, preflight_id: blocked.preflight_id }),
    /blocked/,
  );
});

for (const operation of ["merge", "rebase", "cherry_pick", "revert"]) {
  test(`${operation}: reject unresolved continue, stale abort, then abort and resolve/continue`, async (t) => {
    const { local, git, call } = await fixture(t);
    const commit = async (text) => {
      await writeFile(path.join(local, "file.txt"), text + "\n");
      git(local, "add", ".");
      git(local, "commit", "-m", text);
      return git(local, "rev-parse", "HEAD");
    };
    git(local, "switch", "-c", "side");
    const side = await commit("side");
    git(local, "switch", "main");
    await commit("main");
    const before = git(local, "rev-parse", "HEAD");
    const begin = () => {
      const args =
        operation === "merge"
          ? ["merge", "side"]
          : operation === "rebase"
            ? ["rebase", "side"]
            : operation === "cherry_pick"
              ? ["cherry-pick", side]
              : ["revert", "--no-edit", side];
      assert.throws(() => git(local, ...args));
    };
    begin();
    assert.equal((await call("git_conflicts")).operation, operation);
    await assert.rejects(
      call("git_conflict_continue", { operation }),
      /Resolve and stage/,
    );
    const preview = await call("git_conflict_abort_preview");
    assert.deepEqual(preview.conflicted_paths, ["file.txt"]);
    await writeFile(
      path.join(local, "file.txt"),
      "resolution edited after preview\n",
    );
    await assert.rejects(
      call("git_conflict_abort", {
        operation,
        preflight_id: preview.preflight_id,
      }),
      /stale/,
    );
    const current = await call("git_conflict_abort_preview");
    await call("git_conflict_abort", {
      operation,
      preflight_id: current.preflight_id,
    });
    assert.equal(git(local, "rev-parse", "HEAD"), before);
    assert.equal(git(local, "status", "--porcelain"), "");
    begin();
    await writeFile(path.join(local, "file.txt"), "resolved\n");
    await call("git_stage", { paths: ["file.txt"] });
    await call("git_conflict_continue", { operation });
    assert.equal((await call("git_conflicts")).operation, "none");
    assert.equal(git(local, "status", "--porcelain"), "");
    assert.equal(
      await readFile(path.join(local, "file.txt"), "utf8"),
      "resolved\n",
    );
    assert.notEqual(git(local, "rev-parse", "HEAD"), before);
  });
}

test("push preview binds destination and remote revision; pull preserves dirty files and rejects incoming external filters", async (t) => {
  const { root, local, peer, remote, git, call } = await fixture(t);
  const target = { remote: "origin", branch: "main" };
  let preview = await call("git_push_preview", target);
  assert.deepEqual(preview.changed_paths, ["file.txt"]);
  const second = path.join(root, "second.git");
  git(root, "init", "--bare", second);
  git(local, "remote", "set-url", "origin", second);
  await assert.rejects(
    call("git_push", { ...target, preflight_id: preview.preflight_id }),
    /stale/,
  );
  git(local, "remote", "set-url", "origin", remote);
  await call("git_push", { ...target, preflight_id: preview.preflight_id });
  git(peer, "pull", "--ff-only", "origin", "main");
  preview = await call("git_push_preview", target);
  await writeFile(path.join(peer, "incoming.txt"), "incoming");
  git(peer, "add", ".");
  git(peer, "commit", "-m", "incoming");
  git(peer, "push", "origin", "main");
  await assert.rejects(
    call("git_push", { ...target, preflight_id: preview.preflight_id }),
    /blocked|stale/,
  );
  await writeFile(path.join(local, "file.txt"), "unsaved");
  await assert.rejects(call("git_pull", target), /local changes/);
  assert.equal(await readFile(path.join(local, "file.txt"), "utf8"), "unsaved");
  const restore = await call("git_restore_preview", { paths: ["file.txt"] });
  await call("git_restore", {
    paths: ["file.txt"],
    preflight_id: restore.preflight_id,
  });
  await writeFile(
    path.join(peer, ".gitattributes"),
    "incoming.txt filter=fixture\n",
  );
  git(peer, "add", ".");
  git(peer, "commit", "-m", "incoming filter");
  git(peer, "push", "origin", "main");
  git(local, "config", "filter.fixture.smudge", "echo should-not-run");
  const head = git(local, "rev-parse", "HEAD");
  await assert.rejects(call("git_pull", target), /external Git filters/);
  assert.equal(git(local, "rev-parse", "HEAD"), head);
});
