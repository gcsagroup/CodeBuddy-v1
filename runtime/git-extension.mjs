import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_DIFF = 64 * 1024;
const empty = { type: "object", properties: {}, additionalProperties: false };
export const GIT_READ_TOOL_NAMES = Object.freeze([
  "git_runtime_status",
  "github_runtime_status",
  "git_repository_snapshot",
  "git_status",
  "git_conflicts",
  "git_branches",
  "git_diff",
  "git_restore_preview",
]);
export const GIT_WRITE_TOOL_NAMES = Object.freeze([
  "git_stage",
  "git_unstage",
  "git_commit",
  "git_branch_create",
  "git_branch_switch",
  "git_restore",
]);
export const GIT_TOOL_NAMES = Object.freeze([
  ...GIT_READ_TOOL_NAMES,
  ...GIT_WRITE_TOOL_NAMES,
]);
const repositoryQueues = new Map();
const pathsSchema = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 1024 },
    },
  },
  required: ["paths"],
  additionalProperties: false,
};
const branchSchema = {
  type: "object",
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
  required: ["name"],
  additionalProperties: false,
};
const commitSchema = {
  type: "object",
  properties: { message: { type: "string", minLength: 1, maxLength: 4096 } },
  required: ["message"],
  additionalProperties: false,
};
const diffSchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["working_tree", "staged", "base"] },
    base: { type: ["string", "null"] },
    paths: {
      type: "array",
      maxItems: 256,
      items: { type: "string", minLength: 1 },
    },
  },
  required: ["scope"],
  additionalProperties: false,
};

function assertArguments(args, allowed) {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !allowed.includes(key))
  )
    throw new TypeError("Invalid Git tool arguments");
}

function repositoryEnvironment(input) {
  // Git needs executable/config locations, not the model, MCP or provider credentials.
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ]);
  const env = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        allowed.has(key.toUpperCase()) && typeof value === "string",
    ),
  );
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
}

async function withRepositoryLock(root, signal, action) {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const previous = repositoryQueues.get(key) ?? Promise.resolve();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  repositoryQueues.set(key, pending);
  try {
    await previous;
    signal?.throwIfAborted();
    return await action();
  } finally {
    release();
    if (repositoryQueues.get(key) === pending) repositoryQueues.delete(key);
  }
}

function boundedDiff(scope, bytes) {
  if (bytes.length <= MAX_DIFF)
    return { scope, text: bytes.toString("utf8"), truncated: false };
  let end = MAX_DIFF;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return {
    scope,
    text: bytes.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

function parseStatus(bytes, repositoryRoot) {
  const records = bytes.toString("utf8").split("\0");
  let branch = "",
    detached = false,
    oid = "",
    upstream = null,
    ahead = 0,
    behind = 0;
  const entries = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      branch = record.slice(14);
      detached = branch === "(detached)";
      continue;
    }
    if (record.startsWith("# branch.oid ")) {
      oid = record.slice(13);
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice(18);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(record);
      if (!match) throw Error("Invalid Git branch counts");
      ahead = Number(match[1]);
      behind = Number(match[2]);
      continue;
    }
    if (record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      entries.push({
        path: record.slice(2),
        original_path: null,
        index_status: "?",
        worktree_status: "?",
      });
      continue;
    }
    const fields = record.split(" "),
      type = fields[0],
      count = { 1: 8, 2: 9, u: 10 }[type];
    if (!count || fields.length <= count || fields[1].length !== 2)
      throw Error("Invalid Git status record");
    let original = null;
    if (type === "2") {
      original = records[++i];
      if (!original) throw Error("Incomplete Git rename record");
    }
    entries.push({
      path: fields.slice(count).join(" "),
      original_path: original,
      index_status: fields[1][0].replace(".", " "),
      worktree_status: fields[1][1].replace(".", " "),
    });
  }
  if (!branch) throw Error("Missing Git branch status");
  if (detached) branch = oid.slice(0, 12);
  return {
    repository_root: repositoryRoot,
    branch,
    detached,
    upstream,
    ahead,
    behind,
    truncated: entries.length > 2000,
    entries: entries.slice(0, 2000),
  };
}

function parseConflicts(bytes) {
  const paths = new Map();
  for (const record of bytes.toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t"),
      stage = Number(record.slice(0, tab).split(" ").at(-1)),
      file = record.slice(tab + 1);
    if (tab < 0 || ![1, 2, 3].includes(stage) || !file)
      throw Error("Invalid Git conflict record");
    if (!paths.has(file)) paths.set(file, new Set());
    paths.get(file).add(stage);
  }
  const classifications = {
    1: ["DD", "both_deleted"],
    2: ["AU", "added_by_us"],
    3: ["UA", "added_by_them"],
    "1,2": ["UD", "deleted_by_them"],
    "1,3": ["DU", "deleted_by_us"],
    "2,3": ["AA", "both_added"],
    "1,2,3": ["UU", "both_modified"],
  };
  return {
    has_conflicts: paths.size > 0,
    total_conflicts: paths.size,
    truncated: paths.size > 500,
    conflicts: [...paths]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 500)
      .map(([file, stages]) => {
        const sorted = [...stages].sort(),
          [code, kind] = classifications[sorted.join(",")];
        return { path: file, code, kind, stages: sorted };
      }),
  };
}

function validatePaths(paths = []) {
  if (!Array.isArray(paths) || paths.length > 256)
    throw new TypeError(
      "Git paths must contain at most 256 repository-relative paths",
    );
  return paths.map((file) => {
    if (
      typeof file !== "string" ||
      !file ||
      file.length > 1024 ||
      file.includes("\0") ||
      path.posix.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      /^[A-Za-z]:/.test(file) ||
      file
        .replaceAll("\\", "/")
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git",
        )
    )
      throw new TypeError(
        "Git paths must be repository-relative without parent traversal or metadata paths",
      );
    return file;
  });
}

/** Fixed Git CLI operations for the frozen UI; Harness owns permission and execution. */
function createGitAdapter(
  cwd,
  {
    gitCommand = "git",
    ghCommand = "gh",
    environment = process.env,
    timeoutMs = 30_000,
  } = {},
  includeWrites = false,
) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd))
    throw new TypeError("Git requires an absolute session working directory");
  const env = repositoryEnvironment(environment);
  let repositorySettings = [];
  let configuredFilters = [];
  const hooksPath = path.join(cwd, `.codebuddy-no-hooks-${randomUUID()}`);
  async function command(
    binary,
    args,
    {
      signal,
      directory = cwd,
      allowedExitCodes = [],
      timeout = timeoutMs,
      input,
      operation = args[0] ?? "command",
    } = {},
  ) {
    signal?.throwIfAborted();
    try {
      const pending = exec(binary, args, {
        cwd: directory,
        env,
        signal,
        timeout,
        maxBuffer: MAX_OUTPUT,
        encoding: "buffer",
        windowsHide: true,
      });
      pending.child.stdin?.on("error", () => {});
      pending.child.stdin?.end(input);
      return { ...(await pending), exitCode: 0 };
    } catch (error) {
      if (
        Number.isInteger(error.code) &&
        allowedExitCodes.includes(error.code) &&
        !error.killed &&
        !signal?.aborted
      )
        return {
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.code,
        };
      if (error.code === "ENOENT" || signal?.aborted) throw error;
      // Do not echo raw command output: a repository or CLI error may contain credentials.
      throw new Error(
        `${path.basename(binary)} ${operation} failed (${error.killed ? "terminated or timed out" : (error.code ?? "process error")})`,
        { cause: error },
      );
    }
  }
  const git = (args, options) =>
    command(
      gitCommand,
      [
        "--no-pager",
        "--no-optional-locks",
        "--no-replace-objects",
        "--literal-pathspecs",
        "-c",
        `core.hooksPath=${hooksPath}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "color.ui=false",
        "-c",
        "core.quotepath=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-c",
        "submodule.recurse=false",
        ...repositorySettings,
        ...args,
      ],
      { ...options, operation: args[0] },
    );
  async function repository(signal, configure = true) {
    const directory = await realpath(cwd);
    const { stdout } = await git(["rev-parse", "--show-toplevel"], {
      directory,
      signal,
    });
    let root = stdout.toString("utf8").replace(/[\r\n]+$/, "");
    if (!root || !path.isAbsolute(root))
      throw Error("Git returned an invalid repository root");
    root = await realpath(root);
    const relative = path.relative(root, directory);
    if (
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw Error(
        "Git repository root does not contain the session working directory",
      );
    }
    if (!configure) return root;
    repositorySettings = [];
    const filters = await git(
      [
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process|required)$",
      ],
      { directory: root, signal, allowedExitCodes: [1] },
    );
    configuredFilters = filters.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    repositorySettings = configuredFilters.flatMap((key) => [
      "-c",
      `${key}=${key.endsWith(".required") ? "false" : ""}`,
    ]);
    return root;
  }
  async function status(root, signal) {
    return parseStatus(
      (
        await git(
          [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
          ],
          { directory: root, signal },
        )
      ).stdout,
      root,
    );
  }
  async function conflicts(root, signal) {
    const result = parseConflicts(
      (
        await git(["ls-files", "--unmerged", "--stage", "-z"], {
          directory: root,
          signal,
        })
      ).stdout,
    );
    const directory = (
      await git(["rev-parse", "--absolute-git-dir"], {
        directory: root,
        signal,
      })
    ).stdout
      .toString("utf8")
      .replace(/[\r\n]+$/, "");
    if (!path.isAbsolute(directory))
      throw Error("Git returned an invalid state directory");
    let operation = result.has_conflicts ? "unknown" : "none";
    outer: for (const [name, markers] of [
      ["rebase", ["rebase-merge", "rebase-apply"]],
      ["merge", ["MERGE_HEAD"]],
      ["cherry_pick", ["CHERRY_PICK_HEAD"]],
      ["revert", ["REVERT_HEAD"]],
    ]) {
      for (const marker of markers) {
        try {
          await lstat(path.join(directory, marker));
          operation = name;
          break outer;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    return { ...result, operation };
  }
  async function branches(root, signal) {
    const { stdout } = await git(
      [
        "for-each-ref",
        "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)%00",
        "refs/heads",
        "refs/remotes",
      ],
      { directory: root, signal },
    );
    const fields = stdout.toString("utf8").split("\0"),
      result = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const ref = fields[i].replace(/^[\r\n]+/, ""),
        remote = ref.startsWith("refs/remotes/");
      if (!ref.startsWith("refs/heads/") && !remote)
        throw Error("Invalid Git branch record");
      result.push({
        name: ref.replace(/^refs\/(heads|remotes)\//, ""),
        current: fields[i + 1] === "*",
        remote,
        upstream: fields[i + 2] || null,
        commit: fields[i + 3],
      });
    }
    return { truncated: result.length > 1000, branches: result.slice(0, 1000) };
  }
  async function diff(root, args, signal) {
    assertArguments(args, ["scope", "base", "paths"]);
    if (!["working_tree", "staged", "base"].includes(args.scope))
      throw new TypeError("Invalid Git diff scope");
    if (args.scope !== "base" && args.base != null)
      throw new TypeError("Only base diff accepts a base reference");
    const files = validatePaths(args.paths),
      argv = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    if (args.scope === "staged") argv.push("--cached");
    if (args.scope === "base") {
      if (
        typeof args.base !== "string" ||
        !args.base ||
        args.base.includes("\0") ||
        args.base.startsWith("-")
      )
        throw new TypeError("Base diff requires a commit reference");
      const { stdout } = await git(
        ["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`],
        { directory: root, signal },
      );
      const oid = stdout.toString("utf8").trim();
      if (!/^[0-9a-f]{40,64}$/.test(oid))
        throw Error("Git returned an invalid base commit");
      argv.push(oid);
    }
    argv.push("--", ...files);
    return boundedDiff(
      args.scope,
      (await git(argv, { directory: root, signal })).stdout,
    );
  }
  async function runtime(binary, expectedPrefix, signal) {
    try {
      const { stdout } = await command(binary, ["--version"], {
        signal,
        timeout: 5000,
      });
      const version = stdout.toString("utf8").split(/\r?\n/, 1)[0];
      if (!version.startsWith(expectedPrefix) || version.length > 256)
        throw Error("Invalid executable version response");
      return { available: true, version };
    } catch (error) {
      if (error.code === "ENOENT") return { available: false, version: null };
      throw error;
    }
  }
  async function selectedPaths(root, args, signal) {
    assertArguments(args, ["paths"]);
    const files = validatePaths(args.paths);
    if (!files.length || new Set(files).size !== files.length)
      throw new TypeError("Select at least one distinct explicit Git path");
    const changed = (await status(root, signal)).entries;
    for (const file of files) {
      const segments = file.replaceAll("\\", "/").split("/");
      if (
        !changed.some(
          (entry) =>
            entry.path === segments.join("/") ||
            entry.original_path === segments.join("/"),
        )
      )
        throw Error(
          "Selected Git path no longer has changes; refresh repository status",
        );
      let current = root;
      for (let index = 0; index < segments.length; index++) {
        current = path.join(current, segments[index]);
        try {
          const entry = await lstat(current);
          if (
            index < segments.length - 1 &&
            (entry.isSymbolicLink() || !entry.isDirectory())
          )
            throw Error("Git path crosses a linked or non-directory ancestor");
          if (index === segments.length - 1 && entry.isDirectory())
            throw Error(
              "Git path must select a file; directory and submodule staging require a separate workflow",
            );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    return files;
  }
  async function requireNoExternalFilters(root, files, signal, targetBranch) {
    const externalFilters = configuredFilters.filter(
      (key) => !key.endsWith(".required"),
    );
    if (!externalFilters.length) return;
    async function usesFilter(input, source) {
      const attributes = (
        await git(
          [
            "check-attr",
            ...(source ? [`--source=${source}`] : []),
            "-z",
            "--stdin",
            "filter",
          ],
          { directory: root, signal, input },
        )
      ).stdout
        .toString("utf8")
        .split("\0");
      const selected = new Set();
      for (let index = 0; index + 2 < attributes.length; index += 3)
        selected.add(attributes[index + 2]);
      return externalFilters.some((key) =>
        selected.has(key.slice(7, key.lastIndexOf("."))),
      );
    }
    const currentPaths = files
      ? Buffer.from(`${files.join("\0")}\0`)
      : (
          await git(
            ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            { directory: root, signal },
          )
        ).stdout;
    let usesExternalFilter =
      currentPaths.length && (await usesFilter(currentPaths));
    if (!usesExternalFilter && targetBranch) {
      const targetPaths = (
        await git(
          [
            "ls-tree",
            "--full-tree",
            "-r",
            "--name-only",
            "-z",
            `refs/heads/${targetBranch}`,
          ],
          { directory: root, signal },
        )
      ).stdout;
      usesExternalFilter =
        targetPaths.length &&
        (await usesFilter(targetPaths, `refs/heads/${targetBranch}`));
    }
    if (!usesExternalFilter) return;
    throw Error(
      "Repository uses external Git filters; use its configured Git workflow before staging or switching branches",
    );
  }
  async function prepareRestore(root, args, signal) {
    const files = await selectedPaths(root, args, signal);
    await requireNoExternalFilters(root, files, signal);
    const options = { directory: root, signal };
    const fullDiff = (await git([
      "diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--", ...files,
    ], options)).stdout;
    const index = (await git(["ls-files", "--stage", "-z", "--", ...files], options)).stdout;
    const entries = index.toString("utf8").split("\0").filter(Boolean).map(row => {
      const tab = row.indexOf("\t");
      const [mode, oid, stage] = row.slice(0, tab).split(" ");
      return { path: row.slice(tab + 1), mode, oid, stage };
    });
    const changed = (await git(["diff", "--name-only", "-z", "--", ...files], options))
      .stdout.toString("utf8").split("\0").filter(Boolean);
    const blocked = [];
    if (!changed.length) blocked.push("No tracked working-tree changes to restore");
    for (const file of files) {
      const rows = entries.filter(e => e.path === file.replaceAll("\\", "/"));
      if (!rows.length) blocked.push(`Untracked or missing index path: ${file}`);
      if (rows.some(e => e.stage !== "0")) blocked.push(`Use the conflict workflow for: ${file}`);
      if (rows.some(e => !["100644", "100755", "120000"].includes(e.mode)))
        blocked.push(`Unsupported index entry: ${file}`);
    }
    const displayed = boundedDiff("working_tree", fullDiff);
    const preview = {
      paths: files,
      changed_paths: changed,
      diff: displayed.text,
      diff_truncated: displayed.truncated,
      blocked_reasons: blocked,
    };
    // Bind the full binary diff and source index, not only the truncated UI text.
    const preflight_id = createHash("sha256")
      .update(JSON.stringify([root, await realpath(cwd), preview]))
      .update(index).update(fullDiff).digest("hex");
    return { ...preview, preflight_id };
  }
  async function currentBranch(root, signal) {
    const { stdout, exitCode } = await git(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { directory: root, signal, allowedExitCodes: [1] },
    );
    if (exitCode) throw Error("A checked-out local branch is required");
    return stdout.toString("utf8").trim();
  }
  async function mutate(root, name, args, signal) {
    if (name === "git_restore") {
      assertArguments(args, ["paths", "preflight_id"]);
      if (typeof args.preflight_id !== "string" || !/^[0-9a-f]{64}$/.test(args.preflight_id))
        throw new TypeError("Run git_restore_preview before confirming a restore");
      const preview = await prepareRestore(root, { paths: args.paths }, signal);
      if (preview.blocked_reasons.length)
        throw Error(`Git restore blocked: ${preview.blocked_reasons.join("; ")}`);
      if (preview.preflight_id !== args.preflight_id)
        throw Error("Git restore preview is stale; preview current contents again");
      await git(["restore", "--worktree", "--", ...preview.paths], { directory: root, signal });
      return { restored_paths: preview.changed_paths };
    }
    if (name === "git_stage" || name === "git_unstage") {
      const files = await selectedPaths(root, args, signal);
      if (name === "git_stage") {
        await requireNoExternalFilters(root, files, signal);
        await git(["add", "--", ...files], { directory: root, signal });
        return { staged_paths: files };
      }
      const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
        directory: root,
        signal,
        allowedExitCodes: [1],
      });
      // With no HEAD, unstaging means removing only selected index entries.
      // --cached preserves even files edited after staging; never remove disk files.
      await git(head.exitCode
        ? ["rm", "--cached", "--force", "--ignore-unmatch", "--", ...files]
        : ["restore", "--staged", "--", ...files], {
        directory: root,
        signal,
      });
      return { unstaged_paths: files };
    }
    if (name === "git_branch_create" || name === "git_branch_switch") {
      assertArguments(args, ["name"]);
      if (
        typeof args.name !== "string" ||
        args.name.length > 200 ||
        !/^[A-Za-z0-9/_.-]+$/.test(args.name) ||
        args.name.startsWith("-") ||
        args.name.includes("..")
      )
        throw new TypeError("Invalid Git branch name");
      await git(["check-ref-format", "--branch", args.name], {
        directory: root,
        signal,
      });
      const create = name === "git_branch_create";
      if (!create) {
        const ref = await git(
          ["show-ref", "--verify", "--quiet", `refs/heads/${args.name}`],
          { directory: root, signal, allowedExitCodes: [1] },
        );
        if (ref.exitCode)
          throw Error("Requested local Git branch does not exist");
      }
      await requireNoExternalFilters(
        root,
        null,
        signal,
        create ? null : args.name,
      );
      await git(
        create
          ? ["switch", "--no-guess", "-c", args.name]
          : ["switch", "--no-guess", "--", args.name],
        { directory: root, signal },
      );
      return { branch: await currentBranch(root, signal), created: create };
    }
    assertArguments(args, ["message"]);
    if (
      typeof args.message !== "string" ||
      !args.message.trim() ||
      [...args.message.trim()].length > 4096 ||
      args.message.includes("\0")
    )
      throw new TypeError(
        "Commit message must contain 1 to 4096 characters without NUL",
      );
    const branch = await currentBranch(root, signal);
    const signing = await git(["config", "--bool", "--get", "commit.gpgsign"], {
      directory: root,
      signal,
      allowedExitCodes: [1],
    });
    if (signing.stdout.toString("utf8").trim() === "true")
      throw Error(
        "Commit signing is configured; complete the commit using the configured signing workflow",
      );
    const staged = (
      await git(
        [
          "diff",
          "--cached",
          "--name-only",
          "--no-ext-diff",
          "--no-textconv",
          "-z",
        ],
        { directory: root, signal },
      )
    ).stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (!staged.length) throw Error("No staged Git changes to commit");
    await git(["commit", "-m", args.message.trim()], {
      directory: root,
      signal,
    });
    const details = (
      await git(["show", "--no-patch", "--format=%H%x00%s", "HEAD"], {
        directory: root,
        signal,
      })
    ).stdout
      .toString("utf8")
      .trimEnd()
      .split("\0");
    if (details.length !== 2 || !/^[0-9a-f]{40,64}$/.test(details[0]))
      throw Error("Git returned an invalid commit receipt");
    return {
      commit: details[0],
      branch,
      subject: details[1],
      committed_paths: staged,
    };
  }
  async function execute(name, args, signal) {
    if (!["git_diff", "git_restore_preview"].includes(name) && !GIT_WRITE_TOOL_NAMES.includes(name))
      assertArguments(args, []);
    if (name === "git_runtime_status")
      return {
        ...(await runtime(gitCommand, "git version ", signal)),
        install_url: "https://git-scm.com/downloads",
      };
    if (name === "github_runtime_status") {
      const result = await runtime(ghCommand, "gh version ", signal);
      const authenticated =
        result.available &&
        (
          await command(
            ghCommand,
            ["auth", "status", "--active", "--hostname", "github.com"],
            { signal, allowedExitCodes: [1], timeout: 10_000 },
          )
        ).exitCode === 0;
      return {
        ...result,
        authenticated,
        hostname: "github.com",
        install_url: "https://cli.github.com/",
        login_command: "gh auth login --hostname github.com --web",
      };
    }
    const root = await repository(signal, false);
    return withRepositoryLock(root, signal, async () => {
      // Re-resolve after queueing: a retargeted session path must not mutate another repository.
      if ((await repository(signal)) !== root)
        throw Error(
          "Git repository changed while waiting; refresh the session",
        );
      if (GIT_WRITE_TOOL_NAMES.includes(name))
        return mutate(root, name, args, signal);
      if (name === "git_status") return status(root, signal);
      if (name === "git_conflicts") return conflicts(root, signal);
      if (name === "git_branches") return branches(root, signal);
      if (name === "git_diff") return diff(root, args, signal);
      if (name === "git_restore_preview") return prepareRestore(root, args, signal);
      const [state, conflictState, branchState, working, staged] =
        await Promise.all([
          status(root, signal),
          conflicts(root, signal),
          branches(root, signal),
          diff(root, { scope: "working_tree" }, signal),
          diff(root, { scope: "staged" }, signal),
        ]);
      return {
        status: state,
        conflicts: conflictState,
        branches: branchState,
        diff: working,
        staged_diff: staged,
      };
    });
  }
  const descriptions = {
    git_runtime_status:
      "Detect the installed Git executable and official installation page.",
    github_runtime_status:
      "Detect GitHub CLI and its github.com authentication status without returning credentials.",
    git_repository_snapshot:
      "Read repository status, conflicts, branches, working diff and staged diff. Does not run a code review.",
    git_status:
      "Read repository-relative file changes and branch tracking status.",
    git_conflicts:
      "Read actual unmerged index stages and the current Git conflict operation.",
    git_branches:
      "Read existing local and remote branches without creating or switching a branch.",
    git_diff:
      "Read a bounded working tree, staged, or commit-base diff. Untracked contents are not part of Git diff.",
    git_restore_preview:
      "Preview restoring explicitly selected working-tree files from the index, preserving staging. Return a content-bound preflight_id and blocking reasons without modifying files.",
    git_restore:
      "After approval of git_restore_preview, discard only its selected working-tree changes using its current preflight_id. Preserve staging and reject stale previews, untracked files and conflicts.",
    git_stage:
      "Stage only the explicitly selected changed repository files. Does not run repository hooks or external filters.",
    git_unstage:
      "Unstage only the selected index entries, preserving working files. Before the first commit, remove these entries from the index; otherwise restore them from HEAD.",
    git_commit:
      "Commit the current staging area on the checked-out local branch. Does not stage other changes or run repository hooks.",
    git_branch_create:
      "Create and switch to a named local branch without discarding local changes.",
    git_branch_switch:
      "Switch to an existing local branch without forcing or discarding local changes.",
  };
  const schemas = {
    git_diff: diffSchema,
    git_stage: pathsSchema,
    git_unstage: pathsSchema,
    git_restore_preview: pathsSchema,
    git_restore: {
      ...pathsSchema,
      properties: { ...pathsSchema.properties, preflight_id: { type: "string", pattern: "^[0-9a-f]{64}$" } },
      required: ["paths", "preflight_id"],
    },
    git_commit: commitSchema,
    git_branch_create: branchSchema,
    git_branch_switch: branchSchema,
  };
  const tools = (includeWrites ? GIT_TOOL_NAMES : GIT_READ_TOOL_NAMES).map(
    (name) => ({
      name,
      description: descriptions[name],
      inputSchema: schemas[name] ?? empty,
      annotations: {
        readOnlyHint: !GIT_WRITE_TOOL_NAMES.includes(name),
        destructiveHint: GIT_WRITE_TOOL_NAMES.includes(name),
        openWorldHint: name === "github_runtime_status",
      },
      execute: (args = {}, execution = {}) =>
        execute(name, args, execution.signal),
    }),
  );
  return { tools, run: git, root: repository };
}

export const createGitReader = (cwd, options) => createGitAdapter(cwd, options);
export const gitTools = (cwd, options) =>
  createGitAdapter(cwd, options, true).tools;
