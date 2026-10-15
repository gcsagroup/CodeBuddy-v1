# CodeBuddy Git Worktree Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Git-backed CodePro change or test session execute in a persistent isolated worktree, then let the desktop safely preview, apply, or discard the result.

**Architecture:** A focused Rust workspace manager owns Git discovery and worktree transactions. `CodeProRunState` persists a versioned workspace descriptor; Agent routing consumes only its validated execution directory. A separate ACP workspace API projects lifecycle state to the desktop and executes revision-checked apply/discard commands.

**Tech Stack:** Rust, Tokio process execution, Serde, SHA-256, Git CLI, ACP custom requests, generated TypeScript SDK, React/Vitest, PowerShell packaged-runtime probes.

## Global Constraints

- Use the selected checkout's local `HEAD`; never fetch from the network.
- Worktrees live below `%LOCALAPPDATA%\CodeBuddy\worktrees\<repository-id>\<session-id>`.
- Do not copy uncommitted, untracked, or ignored source files.
- Change, simple-change, and test routes use a worktree; conversation and strict read-only analysis do not.
- Apply/discard are host commands, never Agent tools.
- Apply leaves changes unstaged and uncommitted; never use reject mode, stash, reset, or checkout.
- Reject submodule/gitlink changes in schema version 1.
- Never age-delete a completed unapplied worktree.
- Recursive deletion requires persisted ownership, bounded path, reparse-point, and Git-registration agreement.
- Preserve unrelated dirty ACP and `documentation/codebuddy` files.
- On this Windows machine use `CARGO_INCREMENTAL=0`, disabled test debug symbols, and `--jobs 1`.

---

### Task 1: Persisted Workspace Contract and Legacy Migration

**Files:**
- Modify: `crates/goose/src/agents/codepro_workspace.rs`
- Modify: `crates/goose/src/agents/codepro_state_store.rs`
- Modify: `crates/goose/src/agents/mod.rs`
- Modify: `crates/goose/src/agents/agent.rs`

**Interfaces:**
- Produces `CodeProWorkspaceDescriptor`, mode/lifecycle enums, `CodeProGitWorktreeMetadata`, operation journal, and projection.
- Produces `CodeProRunState.workspace: Option<CodeProWorkspaceDescriptor>`.

- [ ] **Step 1: Write failing serialization and migration tests**

```rust
#[test]
fn legacy_direct_state_migrates_without_git_authority() {
    let mut value = serde_json::to_value(run_state()).unwrap();
    value.as_object_mut().unwrap().remove("workspace");
    let migrated = normalize_loaded_state(serde_json::from_value(value).unwrap()).unwrap();
    let workspace = migrated.workspace.unwrap();
    assert_eq!(workspace.mode, CodeProWorkspaceMode::Direct);
    assert!(workspace.git.is_none());
}
```

Also assert that `git_worktree` without Git metadata and direct or unresolved modes with Git metadata are rejected.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 --config profile.test.package.goose.codegen-units=256 -p goose codepro_state_store::tests::legacy_direct_state_migrates_without_git_authority --jobs 1
```

Expected: compilation fails because the workspace contract does not exist.

- [ ] **Step 3: Implement the additive contract**

```rust
pub const CODEPRO_WORKSPACE_SCHEMA_VERSION: u16 = 1;

impl CodeProWorkspaceDescriptor {
    pub fn validate(&self) -> Result<()>;
    pub fn direct(source_path: PathBuf) -> Self;
    pub fn projection(&self) -> CodeProWorkspaceProjection;
}
```

Use snake-case Serde enum values and `#[serde(default)]` on the new state field. During load, migrate only missing descriptors; preserve existing paths.

- [ ] **Step 4: Run the full state-store tests and verify GREEN**

Run the Task 1 command with filter `codepro_state_store::tests`.

- [ ] **Step 5: Commit**

```powershell
git add -- crates/goose/src/agents/codepro_workspace.rs crates/goose/src/agents/codepro_state_store.rs crates/goose/src/agents/mod.rs
git commit -m "feat: persist CodePro workspace authority"
```

#### Task 1 compatibility amendment

Task 1 also modifies `crates/goose/src/agents/agent.rs`. Persisting the descriptor
without blocking unsafe resume paths would leave a legacy state executable, so the
consumer guard is part of this task rather than Task 3.

Use explicit modes instead of a mode plus an ambiguous boolean:

- `direct`: preserves the current direct-workspace behavior. The descriptor does
  not grant Git authority; the existing session/workspace binding remains required.
- `legacy_unresolved`: represents a descriptor-less historical state whose
  `source_repo` and `worktree_path` differ. Preserve both paths for inspection,
  but expose no executable directory and never infer Git-worktree ownership.
- `git_worktree`: requires complete, validated Git metadata. Task 1 defines and
  validates this representation but does not create, reopen, or route into it.

During load, migrate a descriptor-less state with equivalent source and worktree
paths to `direct`. Migrate a descriptor-less state with different paths to
`legacy_unresolved`; do not reject or silently hide the historical task. During
save, normalize a cloned state before serialization so newly persisted states
always contain a descriptor. Preserve the legacy path fields temporarily and
require their projection to agree with the descriptor.

Checkpoint resume must detect `legacy_unresolved` before baseline capture,
evidence collection, or tool execution, keep the task available for inspection,
and return a specific needs-attention result. Do not turn a load/validation error
into the existing generic "no resumable task" response. A linked replay is a new
run in the currently bound directory, not a checkpoint resume, and needs an
explicit regression test documenting that distinction.

Path equivalence must reuse the existing trusted canonical-path handling. Do not
invent string-only authorization. Git object IDs accept the repository formats
Git supports here: exactly 40 or 64 hexadecimal characters; ownership is not
established by an object ID or path string alone.

Add RED tests for:

1. Missing descriptor with equivalent paths migrates to `direct`, with no Git metadata.
2. Missing descriptor with different paths remains readable as `legacy_unresolved`
   and preserves both paths.
3. `legacy_unresolved` exposes no validated execution directory.
4. Checkpoint resume of `legacy_unresolved` returns needs-attention before baseline
   capture and before any tool call, while normal `direct` resume remains unchanged.
5. State listing includes unresolved historical tasks instead of dropping them.
6. Saving a legacy-shaped state persists a non-null normalized descriptor.
7. Direct or unresolved modes with Git metadata, `git_worktree` without metadata,
   unsupported schema versions, empty paths, invalid object IDs, and descriptor/
   legacy-field projection mismatches fail closed.
8. Snake-case serialization, 40/64-character object IDs, canonical Windows path
   equivalence, and linked-replay-versus-resume behavior remain stable.

Task 1 acceptance proves only the persisted contract, safe legacy migration,
consumer blocking, and projections. It does not prove worktree discovery,
creation, isolation, reopen, apply, or discard.

### Task 2: Git Discovery, Creation, Ownership, and Reopen

**Files:**
- Create: `crates/goose/src/agents/codepro_workspace_git.rs`
- Modify: `crates/goose/src/agents/codepro_workspace.rs`
- Modify: `crates/goose/src/agents/mod.rs`

**Interfaces:**

```rust
pub struct PrepareCodeProWorkspace<'a> {
    pub session_id: &'a str,
    pub selected_path: &'a Path,
}
pub struct PreparedCodeProWorkspace {
    pub descriptor: CodeProWorkspaceDescriptor,
    pub execution_dir: PathBuf,
}
impl CodeProWorkspaceManager {
    pub fn new(root: PathBuf) -> Result<Self>;
    pub fn try_default() -> Result<Self>;
    pub async fn prepare(&self, input: PrepareCodeProWorkspace<'_>) -> Result<PreparedCodeProWorkspace>;
    pub async fn reopen(&self, descriptor: &CodeProWorkspaceDescriptor) -> Result<PreparedCodeProWorkspace>;
}
```

- [ ] **Step 1: Add temporary-repository integration tests**

Cover repository root, selected subdirectory, dirty source, two sessions, unborn repository, missing worktree, and re-registered worktree. Hash the source before/after creation.

- [ ] **Step 2: Run `cargo test ... -p goose codepro_workspace_git::tests --jobs 1` and verify RED**

- [ ] **Step 3: Implement a bounded argument-vector Git runner**

Use `tokio::process::Command::new("git")`, null stdin, bounded stdout/stderr, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `kill_on_drop(true)`, and a 60-second timeout. Never invoke a shell or log inherited environment.

- [ ] **Step 4: Implement discovery and stable identity**

Resolve Git root/common-dir/HEAD/status/subdirectory. Hash length-prefixed canonical fields. Generate the internal branch and validate it with `git check-ref-format --branch`.

- [ ] **Step 5: Implement reservation, creation, and post-verification**

Verify the CodeBuddy root is not a reparse point, run `git worktree add -b <branch> -- <path> <base>`, then parse `git worktree list --porcelain -z` and require matching path, branch, commit, and common Git directory.

- [ ] **Step 6: Implement reopen without recreation**

Return typed missing/ownership errors. Never call add, repair, prune, or recursive deletion during reopen.

- [ ] **Step 7: Run tests and commit**

Commit as `feat: create isolated CodePro worktrees`.

### Task 3: Route Write-Capable Execution into the Worktree

**Files:**
- Modify: `crates/goose/src/agents/agent.rs`
- Modify: `crates/goose/src/agents/codepro_state_store.rs`

**Interfaces:**
- Consumes `CodeProWorkspaceManager::prepare/reopen`.
- Produces `resolve_codepro_execution_workspace(...)` returning descriptor plus authoritative execution directory.

- [ ] **Step 1: Add route tests**

Prove conversation/read-only retain the selected path and simple-change/test/change use the worktree. Add a source scan asserting production paths no longer call `CodeProWorkspace::direct` for write-capable routes.

- [ ] **Step 2: Run the focused route test and verify RED**

- [ ] **Step 3: Move workspace selection before executor creation**

Clone `Session` for unified simple-change and replace only the clone's `working_dir`. Feed the same execution directory to evidence, scheduler, Workers, and state for test/change routes. Keep the durable session project path unchanged.

- [ ] **Step 4: Make resume consume persisted authority**

A missing or conflicting persisted worktree returns needs-attention without running tools.

- [ ] **Step 5: Run Agent, scheduler, and state-store regressions**

- [ ] **Step 6: Commit as `feat: execute CodePro tasks in session worktrees`**

### Task 4: Preview, Crash-Safe Apply, and Discard

**Files:**
- Modify: `crates/goose/src/agents/codepro_workspace_git.rs`
- Modify: `crates/goose/src/agents/codepro_workspace.rs`
- Modify: `crates/goose/src/agents/codepro_state_store.rs`

**Interfaces:**

```rust
pub async fn preview(&self, descriptor: &CodeProWorkspaceDescriptor) -> Result<CodeProWorkspaceProjection>;
pub async fn apply(&self, store: &CodeProStateStore, run_id: &str, expected_revision: u64) -> Result<CodeProWorkspaceProjection>;
pub async fn discard(&self, store: &CodeProStateStore, run_id: &str, expected_revision: u64) -> Result<CodeProWorkspaceProjection>;
pub async fn reconcile_pending(&self, state: &mut CodeProRunState) -> Result<()>;
```

- [ ] **Step 1: Add patch-shape and conflict tests**

Include committed, staged, unstaged, renamed, deleted, binary, and untracked files; ignored files must be absent and gitlinks rejected. Add non-overlap apply success and overlap conflict.

- [ ] **Step 2: Run operation tests and verify RED**

- [ ] **Step 3: Implement preview**

Run intent-to-add only in the worktree, then `git diff --binary --full-index <base> --` and `--name-status -z`. Revalidate sensitive paths and reject `.git` or mode `160000`.

- [ ] **Step 4: Implement locked journaled apply**

Under a repository lock: fingerprint source, run `git apply --check --binary`, persist `applying/prepared` with patch/before/target hashes, revalidate, and pipe the exact patch bytes to `git apply --binary`. Do not expose patch bytes in arguments or logs.

- [ ] **Step 5: Verify and recover**

Verify Git object IDs/modes, persist `applied_verified`, then `applied`. Recovery maps all-before to ready, all-target to applied, and mixed state to conflict; it never reapplies.

- [ ] **Step 6: Implement ownership-checked discard**

Persist discarding, require no managed process, remove the exact registered worktree, verify removal, delete only the internal branch, and persist discarded. No recursive fallback.

- [ ] **Step 7: Run tests and commit as `feat: apply and discard CodePro worktrees safely`**

### Task 5: Versioned ACP Workspace API and Generated SDK

**Files:**
- Create: `crates/goose-sdk-types/src/custom_requests/codepro_workspace.rs`
- Modify: `crates/goose-sdk-types/src/custom_requests.rs`
- Create: `crates/goose/src/acp/server/codepro_workspace.rs`
- Modify: `crates/goose/src/acp/server/custom_dispatch.rs`
- Modify: `crates/goose/src/acp/server.rs`
- Regenerate: `crates/goose/acp-schema.json`, `crates/goose/acp-meta.json`, `ui/sdk/src/generated/*`

**Interfaces:** Custom method `session/codepro_workspace`; actions `preview|apply|discard`; response always contains a full projection.

- [ ] **Step 1: Add strict schema tests**

Reject unknown fields/actions, empty IDs, stale revisions, and invalid mode/metadata combinations.

- [ ] **Step 2: Run `cargo test ... -p goose-sdk-types codepro_workspace --jobs 1` and verify RED**

- [ ] **Step 3: Define types and server dispatch**

Use deny-unknown-fields, camel-case JSON, schema version 1, and stable codes `INVALID_REQUEST`, `STALE_REVISION`, `RUN_ACTIVE`, `WORKSPACE_MISSING`, `OWNERSHIP_MISMATCH`, `SOURCE_CHANGED`, `PATCH_CONFLICT`, `POLICY_DENIED`, `IO_FAILURE`.

- [ ] **Step 4: Regenerate schema and TypeScript SDK**

Generate the Rust ACP schema, then run `pnpm --dir ui/sdk generate`; never hand-edit generated files.

- [ ] **Step 5: Run SDK-type, ACP, SDK test, and SDK lint gates**

- [ ] **Step 6: Commit as `feat: expose CodePro workspace lifecycle over ACP`**

### Task 6: Desktop Projection and Apply/Discard Experience

**Files:**
- Create: `ui/desktop/src/codepro/workspaceCommands.ts`
- Create: `ui/desktop/src/codepro/workspaceCommands.test.ts`
- Modify: `ui/desktop/src/components/codepro/codeProTaskPanelModel.ts`
- Modify: `ui/desktop/src/components/codepro/CodeProTaskPanel.tsx`
- Modify: `ui/desktop/src/components/codepro/CodeProTaskPanel.test.ts`
- Modify/regenerate: desktop locale catalogs

**Interfaces:** Produces `createCodeProWorkspaceCommands().preview/apply/discard` and a revision-monotonic workspace projection store.

- [ ] **Step 1: Add command and rendering tests**

Assert expected revision, stale-response rejection, action disablement while active, ready actions, conflict/missing copy, legacy copy, confirmation accessibility, and no optimistic success.

- [ ] **Step 2: Run focused Vitest files and verify RED**

- [ ] **Step 3: Implement the generated ACP client wrapper and projection store**

Key projections by session/run and reject revision regression or same-revision conflicting payloads.

- [ ] **Step 4: Replace direct-write copy and add controls**

Show source-relative changes, expandable technical paths, Apply/Continue/Discard. Apply says changes are unstaged. Discard requires confirmation.

- [ ] **Step 5: Run focused tests, full `test:run`, `lint:check`, and `test:distribution`**

- [ ] **Step 6: Commit as `feat: review and apply isolated CodePro changes`**

### Task 7: Real Windows Complete/Apply/Discard Gate

**Files:**
- Create: `ui/desktop/scripts/worktree-lifecycle-probe.cjs`
- Modify: `ui/desktop/scripts/installed-lifecycle-probe.cjs`
- Modify: `scripts/test-codebuddy-windows-packaged-runtime.ps1`
- Modify: `scripts/test-codebuddy-windows-lifecycle.ps1`
- Modify: `ui/desktop/scripts/codebuddy-distribution.test.cjs`
- Modify: `.github/workflows/codebuddy-windows.yml`

**Interfaces:** Adds evidence gates `ISOLATED_CHANGE`, `SOURCE_UNCHANGED_BEFORE_APPLY`, `APPLY_EXACT`, `DISCARD_EXACT`, `WORKTREE_CLEANUP`.

- [ ] **Step 1: Add failing distribution contracts for all five gates**

- [ ] **Step 2: Run `pnpm --dir ui/desktop test:distribution` and verify RED**

- [ ] **Step 3: Extend Playwright lifecycle probing**

Create a fixture Git repo, execute a fixed isolated change, verify the source before apply, invoke ACP apply and verify exact unstaged content. Execute a second fixed change, discard, and verify source hash plus registration removal.

- [ ] **Step 4: Extend PowerShell evidence safely**

Keep protocol-handler and real-user-data gates; bound logs and cleanup to verified direct children.

- [ ] **Step 5: Repackage and run local packaged gate plus all desktop gates**

Installed lifecycle remains environment-unavailable on a non-disposable real account and must fail closed.

- [ ] **Step 6: Commit as `test: verify isolated CodePro task lifecycle on Windows`**

### Task 8: Cross-Layer Review

**Files:** Modify only files with concrete review findings; never touch dirty user-owned roadmap files.

- [ ] **Step 1: Review every Git invocation, deletion, transition, stale revision check, and completion claim**

- [ ] **Step 2: Run Rust fmt, relevant Rust tests serially, strict clippy with inherited allowances, schema generation checks, SDK tests, desktop tests/lint/distribution, PowerShell parse, and `git diff --check`**

- [ ] **Step 3: Confirm no test worktree/branch remains and only planned files were committed**

- [ ] **Step 4: Commit concrete fixes as `fix: harden CodePro worktree lifecycle`; create no empty commit**

## Out of Scope for This Plan

Non-Git snapshot protection needs its own rollback/conflict spec. Provider qualification, 24-hour soak, Authenticode signing, and previous-version upgrade/rollback remain later release gates and cannot be reported complete from deterministic tests.
