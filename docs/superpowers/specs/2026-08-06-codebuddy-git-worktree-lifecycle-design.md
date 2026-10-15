# CodeBuddy Git Worktree Lifecycle Design

**Status:** Accepted

**Date:** 2026-08-06

**Scope:** Windows Beta, Git-backed CodePro sessions

## 1. Decision

CodeBuddy will stop running write-capable CodePro tasks in the user's active checkout. A Git-backed session that can modify files or run potentially mutating project commands will execute in a CodeBuddy-owned Git worktree created from the selected checkout's local `HEAD`.

The Rust host owns workspace creation, validation, persistence, apply, discard, recovery, and cleanup. The main Agent and Workers receive an already-selected execution directory; they cannot choose a less isolated directory or declare that changes were applied.

Conversation and strictly read-only analysis can continue to use the selected project directory under the existing read-only tool policy. Change, simple-change, and test workflows use the isolated worktree. Non-Git projects are a separate follow-up design because Git worktrees cannot protect them.

This replaces the current production behavior where `CodeProWorkspace::direct` deliberately points the execution path at the user's project.

## 2. Why This Approach

Three approaches were considered:

1. **CodeBuddy-owned Git worktree per session — selected.** It uses Git's native checkout and index isolation, supports parallel tasks, preserves a reviewable diff, and makes discard bounded.
2. **Full directory copy or shadow repository — rejected.** It duplicates large dependency trees, has ambiguous symlink and ignore behavior, and is harder to reconcile safely with the real repository.
3. **Direct edits plus undo snapshots — rejected for Git projects.** Undo helps recovery but does not isolate concurrent editors or agents and cannot make the user's active index independent.

The direction matches current public product behavior rather than copying an implementation detail: the Codex app describes agents operating on isolated worktree copies and allowing local review without touching the active Git state; Claude Code documents automatic desktop worktrees and explicit keep/remove behavior; Hermes documents one branch and worktree per session or experiment. CodeBuddy retains its own Rust authority, evidence, and permission model.

References:

- OpenAI, “Introducing the Codex app”: <https://openai.com/index/introducing-the-codex-app/>
- Anthropic, “Run parallel sessions with worktrees”: <https://code.claude.com/docs/en/worktrees>
- NousResearch Hermes Agent, “Git Worktrees”: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/git-worktrees.md>

## 3. Product Contract

For a Git-backed task:

1. The user selects a project and starts a CodePro session.
2. The first write-capable or test turn creates or reopens that session's isolated worktree.
3. All main-Agent and Worker filesystem tools receive the worktree execution directory.
4. The user's active checkout, index, untracked files, and ignored files remain untouched during execution.
5. Completion means “ready for review,” not “written to the current project.”
6. The result shows the isolated path, changed files, diff, validation evidence, and any environment limitations.
7. The user can continue the same session, apply its changes, or discard it.
8. Apply writes the verified patch into the selected checkout without committing or staging it.
9. Discard removes only the verified CodeBuddy-owned worktree and its internal branch.
10. Restart reattaches the session to the same registered worktree. Missing or inconsistent workspace state becomes “needs attention”; it is never silently recreated.

Existing saved runs with identical source and worktree paths are treated as `direct_legacy`. They remain readable but do not gain apply or discard controls retroactively.

## 4. Base Revision and Dirty Checkouts

The worktree starts from the selected checkout's local `HEAD`, not `origin/HEAD`. This preserves the branch and local commits the user intentionally selected without performing a network fetch.

Uncommitted and untracked files in the selected checkout are not copied into the worktree. Their paths and a bounded status fingerprint are recorded as source context, and the UI explains that they are protected but not part of the Agent's baseline.

Ignored files, including `.env`, are not copied automatically. Automatically copying secrets would violate the existing credential boundary. A future opt-in include policy may copy only Git-ignored files after sensitive-path and symlink validation; it is not part of this slice.

Repositories without a valid `HEAD`, repositories whose Git root cannot be resolved, and paths inside an inconsistent existing worktree fail closed. They do not fall back to direct writes.

## 5. Workspace Identity and Location

Worktrees live outside the selected repository:

```text
%LOCALAPPDATA%\CodeBuddy\worktrees\<repository-id>\<session-id>\
```

`repository-id` is a stable truncated SHA-256 of the canonical common Git directory and canonical repository root. `session-id` is sanitized and combined with a hash so two raw identifiers cannot normalize to the same directory.

The internal branch follows this shape:

```text
codebuddy/<repository-id>/<session-id>
```

Before using or deleting a path, the host verifies all of the following:

- the path is an absolute direct descendant of the CodeBuddy worktree root;
- the parent root is not a reparse point;
- `git worktree list --porcelain` associates the path with the expected common Git directory;
- the branch and base commit match persisted metadata;
- no other live CodePro session owns the path.

The selected project may be a subdirectory of a repository. The host stores the Git root and the selected relative subdirectory separately, then executes in the equivalent subdirectory inside the worktree.

## 6. Persisted State

`CodeProRunState` gains an additive, versioned workspace descriptor while retaining existing fields for migration:

```rust
struct CodeProWorkspaceDescriptor {
    schema_version: u16,
    mode: CodeProWorkspaceMode,
    lifecycle: CodeProWorkspaceLifecycle,
    source_path: PathBuf,
    execution_dir: PathBuf,
    git: Option<CodeProGitWorktreeMetadata>,
    revision: u64,
    pending_operation: Option<CodeProWorkspaceOperation>,
}

struct CodeProGitWorktreeMetadata {
    source_root: PathBuf,
    source_subdir: PathBuf,
    worktree_root: PathBuf,
    common_git_dir: PathBuf,
    branch: String,
    base_commit: String,
    source_status_sha256: String,
}
```

`git` is required exactly when mode is `git_worktree`; boundary validation rejects every other combination. Direct read-only and legacy projections therefore do not invent a branch, base commit, or common Git directory.

Modes:

- `git_worktree`
- `direct_read_only`
- `direct_legacy`

Lifecycle values:

- `preparing`
- `active`
- `ready`
- `applying`
- `applied`
- `discarding`
- `discarded`
- `conflict`
- `missing`
- `error`

Every state transition is persisted atomically before the next externally visible side effect. Apply and discard requests include the expected workspace revision so stale UI actions fail rather than replaying against newer state.

`pending_operation` is a bounded crash-recovery journal. For apply it records an operation ID, patch hash, source fingerprint, affected-path before hashes, expected target Git object IDs and modes, and phase. For discard it records the exact verified worktree and branch identities. It never contains file contents or credentials.

## 7. Creation and Reopen

Creation is a bounded transaction:

1. Resolve and canonicalize the selected path, Git root, common Git directory, local `HEAD`, selected subdirectory, and source status fingerprint.
2. Reserve the session workspace identity in persisted state as `preparing`.
3. Create a new branch and worktree from the exact base commit using argument-safe Git process invocation.
4. Re-read `git worktree list --porcelain` and verify path, branch, commit, and common Git directory.
5. Persist `active` and expose only the worktree execution directory to the Agent.
6. On partial failure, clean only paths proven to be owned by the reservation; otherwise preserve them and mark `error` for inspection.

Reopen never runs `git worktree add`. It validates the persisted descriptor and registered worktree. A missing path, changed branch association, or unexpected Git directory produces `missing` or `conflict` and blocks execution.

## 8. Execution Routing

Workspace selection occurs after intent classification and before any tool-capable executor is created:

- conversation: direct, no workspace allocation;
- read-only analysis: direct with read-only tool contract;
- simple change: worktree;
- change/DAG: worktree;
- test: worktree because tests and build tools can create or rewrite files;
- resume/continue: persisted worktree only.

For unified single-Agent routes, the host clones the session execution context with `working_dir` set to the worktree subdirectory. It does not rewrite the durable user-selected project path in session history.

For multi-Agent routes, every Worker receives the same session worktree and the existing control plane continues to permit at most one writing Worker. Separate Worker worktrees remain a post-Beta optimization.

The evidence layer records both logical paths and their authority:

- user-facing paths are relative to the source Git root;
- execution evidence includes the isolated worktree root;
- no worktree absolute path is misreported as a change to the user's checkout.

## 9. Apply

Apply is an explicit host command, never an Agent tool call.

Preconditions:

- the run has no live Worker or managed process;
- lifecycle is `ready`;
- the expected revision matches;
- source and worktree identities still validate;
- the worktree contains no merge, rebase, cherry-pick, or bisect in progress;
- changed paths pass the existing sensitive-path and permission policy again;
- `.git` internals are never included.
- submodule/gitlink changes are rejected in the first version rather than being applied with ambiguous nested-repository side effects.

The host produces one binary patch from the persisted base commit to the complete worktree state. Before generating it, Git intent-to-add is used inside the isolated worktree so untracked files are represented. This may alter only the isolated index. The patch therefore includes committed, staged, unstaged, renamed, deleted, binary, and newly created files.

Application is fail-closed:

1. Acquire a repository-scoped apply lock.
2. Capture source `HEAD` and status fingerprint.
3. Generate the patch and changed-path manifest in the worktree.
4. Run `git apply --check --binary` in the selected source checkout.
5. Revalidate the source fingerprint under the same lock.
6. Persist lifecycle `applying` with a prepared apply journal containing the patch and path hashes.
7. Run `git apply --binary` without `--index`, leaving changes unstaged and uncommitted.
8. Verify every affected source path against the expected Git object ID and mode, then advance the journal to `applied_verified`.
9. Persist `applied`, clear the journal, then remove the registered worktree and internal branch.

Plain `git apply` is atomic unless reject mode is requested; CodeBuddy never uses reject mode. If preflight or apply fails, the source is left unchanged and lifecycle becomes `conflict`. The UI reports the conflicting paths and offers continue/retry after the user resolves their checkout. CodeBuddy does not stash, reset, commit, or overwrite user changes automatically.

After a crash in `applying`, recovery compares the source against the journal. If all affected paths still match their before hashes, the operation returns to `ready`. If all match the expected target objects and modes, it finalizes `applied`. Any mixed or third-party state becomes `conflict`. Recovery never sends the patch a second time automatically.

## 10. Discard

Discard is allowed only with an explicit desktop action and no live managed process. The host:

1. validates expected revision and workspace ownership;
2. records a bounded final diff summary for audit;
3. marks `discarding` durably;
4. calls `git worktree remove --force` for the exact verified path;
5. verifies the registration is gone;
6. deletes only the expected internal branch;
7. persists `discarded`.

After a crash in `discarding`, recovery only inspects the persisted registration and path. If both are gone it finalizes `discarded`; otherwise it preserves the workspace and requires another explicit discard action.

If ownership cannot be proven, no recursive deletion occurs. The workspace remains on disk and the state becomes `error` with manual recovery instructions.

## 11. Backend Interface

Workspace lifecycle is separate from execution control. Pause, resume, cancel, and emergency stop remain run-control commands. Apply and discard use a new versioned ACP custom request:

```text
session/codepro_workspace
```

Request:

```json
{
  "schemaVersion": 1,
  "sessionId": "...",
  "runId": "...",
  "expectedRevision": 4,
  "command": { "type": "preview" }
}
```

Command variants are `preview`, `apply`, and `discard`. The response always returns a complete workspace projection with lifecycle, revision, paths safe for display, changed-file summary, conflict details, and allowed next actions.

Errors use stable machine codes: `INVALID_REQUEST`, `STALE_REVISION`, `RUN_ACTIVE`, `WORKSPACE_MISSING`, `OWNERSHIP_MISMATCH`, `SOURCE_CHANGED`, `PATCH_CONFLICT`, `POLICY_DENIED`, and `IO_FAILURE`.

The frontend never infers that apply or discard succeeded from button completion. It refreshes the authoritative projection returned by the host.

## 12. Desktop Experience

The task panel replaces the current “changes written directly” text with one of these states:

- “在隔离工作区处理中”
- “修改已完成，等待你检查”
- “应用到当前项目”
- “继续修改”
- “放弃任务”
- “当前项目已变化，暂时无法安全应用”
- “隔离工作区缺失，需要处理”

Apply and discard are unavailable while a run is active. Apply shows the changed-file count and warns that the result will be written as unstaged local changes. Discard requires a concise confirmation because it destroys uncommitted worktree changes. Technical details expose the source path, isolated path, branch, base commit, current lifecycle, and conflict evidence.

Historical direct runs show “历史任务：曾直接修改当前项目” and no workspace actions.

## 13. Recovery and Retention

Startup reconciliation scans persisted nonterminal and ready workspaces, then compares them with `git worktree list --porcelain`:

- valid registration: reattach;
- missing directory and registration: mark `missing`;
- directory exists but registration differs: mark `conflict`;
- orphan CodeBuddy-owned registration with matching ownership metadata: retain and surface for recovery;
- unknown directory: never delete automatically.

Completed but unapplied worktrees are user data and are excluded from automatic byte/age cleanup. Only applied, discarded, or unchanged abandoned reservations can be pruned. Storage pressure is surfaced to the user instead of silently deleting reviewable work.

## 14. Security Boundaries

- Git is invoked without a shell and with an explicit argument vector.
- Repository paths, refs, and session identifiers are treated as untrusted input.
- Branch names are generated by the host and validated with `git check-ref-format --branch`.
- No Git hook from an untrusted worktree is used as an authority signal.
- Apply reruns path and permission policy against the final patch.
- Credential and sensitive-path rules remain identical inside the worktree.
- Worktree creation performs no network access.
- CodeBuddy never copies ignored secrets by default.
- Recursive removal is permitted only after path-root, reparse-point, persisted-owner, and Git-registration checks all agree.

## 15. Verification

Deterministic Rust integration tests use temporary repositories and cover:

- clean repository creation and selected-subdirectory mapping;
- dirty source checkout remains byte-for-byte unchanged during execution;
- two sessions receive distinct branches, indexes, and directories;
- simple-change, test, and DAG routes all use the isolated execution path;
- conversation and read-only routes do not allocate a worktree;
- restart reattaches a valid worktree;
- missing, moved, or re-registered worktrees fail closed;
- patch preview includes committed, staged, unstaged, renamed, deleted, binary, and untracked files;
- apply leaves changes unstaged and does not alter unrelated source changes;
- overlapping source changes return `PATCH_CONFLICT` without partial application;
- stale revisions cannot apply or discard;
- discard removes only the owned worktree and branch;
- direct legacy state migrates without destructive actions;
- Windows canonical paths, spaces, Unicode, and reparse-point defenses.

Desktop tests cover projection parsing, button availability, stale-response handling, conflict copy, direct-legacy copy, and accessibility. A packaged Windows lifecycle test must create a fixture Git repository, complete a safe isolated modification, verify the source is unchanged before apply, apply the result, verify exact source content, create a second task, discard it, and verify the source remains unchanged.

## 16. Delivery Slices

1. Workspace descriptor, Git discovery, creation, validation, and recovery.
2. Route all write-capable and test execution through the worktree.
3. Preview and authoritative workspace projection.
4. Apply transaction and conflict evidence.
5. Discard and bounded cleanup.
6. ACP workspace request and desktop result actions.
7. Packaged Windows complete/apply/discard lifecycle gate.
8. Separate non-Git snapshot-protection design and implementation.

The Windows Beta release gate remains blocked until slices 1–7 pass in a disposable Windows environment. Provider qualification, 24-hour soak, signing, and upgrade/rollback validation follow; they cannot substitute for workspace isolation.
