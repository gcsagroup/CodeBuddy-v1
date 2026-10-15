# CodePro U-74F Baseline Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Coordinator 架构迁移前，形成可恢复的当前产品基线，并修复非 Git 间接写入证据盲区与影子项目路径不一致。

**Architecture:** `CodeProEvidence` 在运行开始时对 Git 和非 Git 项目都建立权威全工作区基线；文件工具登记只保留为优化和敏感路径保护，不再是正确性的前提。`CodeProWorkspace` 只规范化会话选中的用户项目，不复制或创建影子仓库；同一个规范化路径贯穿执行、状态、恢复与报告。

**Tech Stack:** Rust、Tokio、ignore::WalkBuilder、临时 Git repository、Serde、Cargo test、React/Vitest、PowerShell、Windows 路径 API。

## Global Constraints

- 不改动或提交当前 `documentation/` 目录中的既有用户变化。
- 不执行 `git reset --hard`、`git checkout --` 或递归删除。
- Git 和非 Git 证据都不得修改用户 Git index。
- 非 Git 全量基线维持 `50,000` 文件与 `64 MiB` 硬上限，并继续排除依赖、构建和缓存目录。
- `.env`、`.env.*`、`*.pem`、`*.key` 等敏感文件只比较哈希和报告路径，不进入 patch。
- 简单修改模式仍禁止 Shell 写入；本修复不扩大其权限，只保证其他允许 Shell/MCP 的工作流能检测实际副作用。
- Windows 显示路径移除 `\\?\`，但 UNC 路径保留 `\\server\share` 语义。
- 每个行为变更先出现失败测试，再写最小实现；每个任务通过后独立提交。

---

### Task 1: Create a recoverable checkpoint for inherited product changes

**Files:**

- Stage: `crates/**`
- Stage: `ui/**`
- Exclude: `documentation/**`
- Exclude: `docs/superpowers/**`（本计划和设计修订单独提交）

**Interfaces:**

- Consumes: 当前 `fix/codepro-analysis-evidence` 工作树中的 Rust/UI 产品改动。
- Produces: 一个可构建、可测试、可单独定位的 pre-control-plane checkpoint commit。

- [ ] **Step 1: Record exact scope before staging**

Run:

```powershell
git status --porcelain=v1 -uall
git diff --stat -- crates ui
git diff --numstat -- crates ui
```

Expected: 只读命令成功；输出包含当前 Rust/UI 改动，不改变 index。

- [ ] **Step 2: Run the inherited Rust gates**

Run:

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose codepro_ --lib --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test activity_event_contract --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_event_log --jobs 1 -- --nocapture
```

Expected: 所有命令退出码为 `0`。任何失败先按 `systematic-debugging` 定位，不得通过跳过测试形成 checkpoint。

- [ ] **Step 3: Run the inherited desktop gates**

Run from `ui/desktop`:

```powershell
pnpm run typecheck
pnpm run test:run
pnpm run lint:check
pnpm run test:distribution
```

Expected: typecheck、Vitest、lint/i18n 和 distribution tests 全部退出码为 `0`。

- [ ] **Step 4: Stage only product code and inspect it**

Run:

```powershell
git add -- crates ui
git diff --cached --name-status
git diff --cached --check
git diff --cached --unified=0 | Select-String -Pattern '(api[_-]?key|password|passwd|private[_-]?key|access[_-]?token)\s*[:=]\s*[A-Za-z0-9_./+\-=]{8,}' -CaseSensitive:$false
git diff --cached --name-only | Select-String -Pattern '^documentation/|^docs/superpowers/'
```

Expected: `git diff --cached --check` 无错误；凭据扫描无真实凭据；最后一条命令无输出。

- [ ] **Step 5: Commit the recovery checkpoint**

Run:

```powershell
git commit -m "chore: checkpoint CodePro before control-plane migration"
git show --stat --oneline HEAD
```

Expected: commit 仅包含 `crates/` 和 `ui/`，这是继承的大型工作树的显式恢复点；后续提交恢复为小型原子切片。

### Task 2: Detect unregistered writes in non-Git workspaces

**Files:**

- Modify: `crates/goose/src/agents/codepro_evidence.rs:97-180`
- Test: `crates/goose/src/agents/codepro_evidence.rs:873-938`
- Modify call site: `crates/goose/src/agents/agent.rs:4628-4634`

**Interfaces:**

- Consumes: `CodeProEvidence::capture(&Path)`.
- Produces: 对 Git 与非 Git 都具有全工作区正确性的 `capture`; `capture_complete` 被删除，调用方统一使用 `capture`。

- [ ] **Step 1: Replace the old declared-path-only test with a failing indirect-write test**

Add to the existing `codepro_evidence` test module:

```rust
#[tokio::test]
async fn non_git_evidence_detects_an_unregistered_indirect_write() {
    let project = tempfile::tempdir().unwrap();
    tokio::fs::write(project.path().join("app.txt"), "before\n")
        .await
        .unwrap();
    let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

    tokio::fs::write(project.path().join("app.txt"), "after\n")
        .await
        .unwrap();
    tokio::fs::write(project.path().join("created-by-shell.txt"), "new\n")
        .await
        .unwrap();

    let result = evidence.collect().await.unwrap();
    assert_eq!(
        result.files_changed,
        vec!["app.txt", "created-by-shell.txt"]
    );
    assert!(result.patch.contains("after"));
    assert!(result.patch.contains("created-by-shell.txt"));
    assert!(!project.path().join(".git").exists());
}
```

- [ ] **Step 2: Verify the test fails for the correct reason**

Run:

```powershell
cargo test -p goose agents::codepro_evidence::tests::non_git_evidence_detects_an_unregistered_indirect_write --lib -- --exact --nocapture
```

Expected: FAIL because the current non-Git `capture` has an empty declared-path tracker and returns no changed files.

- [ ] **Step 3: Make non-Git capture authoritative**

First verify the deletion scope:

```powershell
rg -n "capture_complete" crates --glob '*.rs'
```

Expected: only the method definition in `codepro_evidence.rs` and the simple-change call in `agent.rs`. Any additional production caller must be migrated explicitly before deletion.

In the `!working_dir.join(".git").exists()` branch of `capture_with_git_program`, replace the empty `TrackedBaseline` construction with:

```rust
let native_baseline = capture_regular_files(&working_dir)?;
let sensitive_baseline = capture_sensitive_files(&working_dir)?;
return Ok(Self {
    working_dir,
    git_program,
    git_dir: None,
    native_initial_baseline: Some(native_baseline.clone()),
    native_task_baseline: Mutex::new(Some(native_baseline)),
    tracked_initial_baseline: None,
    tracked_task_baseline: None,
    sensitive_baseline: sensitive_baseline.clone(),
    task_sensitive_baseline: Mutex::new(sensitive_baseline),
    _temporary_repository: None,
    lock: Mutex::new(()),
});
```

Delete `capture_complete`; change its only production call in `agent.rs` to `CodeProEvidence::capture(...)`. Keep `record_before_path` as a no-op when the authoritative native baseline is present.

- [ ] **Step 4: Run evidence tests**

Run:

```powershell
cargo test -p goose agents::codepro_evidence::tests --lib -- --nocapture
```

Expected: PASS, including Git index preservation, sensitive hashing, undo and the new indirect-write test.

- [ ] **Step 5: Commit**

```powershell
git add crates/goose/src/agents/codepro_evidence.rs crates/goose/src/agents/agent.rs
git diff --cached --check
git commit -m "fix: capture indirect writes in non-git projects"
```

### Task 3: Preserve per-task deltas and host-authoritative reporting

**Files:**

- Modify: `crates/goose/src/agents/codepro_evidence.rs:245-283`
- Test: `crates/goose/src/agents/codepro_evidence.rs:1128-1156`
- Test: `crates/goose/src/agents/result_aggregator.rs:2325-2425`

**Interfaces:**

- Consumes: `collect_task_delta()` and `TaskOutput.files_changed`.
- Produces: 每个 Worker 的独立实际差异；用户报告优先采用宿主证据而非 Worker 自述。

- [ ] **Step 1: Add a per-task unregistered-write regression test**

```rust
#[tokio::test]
async fn non_git_task_delta_detects_each_unregistered_write_once() {
    let project = tempfile::tempdir().unwrap();
    tokio::fs::write(project.path().join("app.txt"), "zero\n")
        .await
        .unwrap();
    let evidence = CodeProEvidence::capture(project.path()).await.unwrap();

    tokio::fs::write(project.path().join("app.txt"), "one\n")
        .await
        .unwrap();
    let first = evidence.collect_task_delta().await.unwrap();
    assert_eq!(first.files_changed, vec!["app.txt"]);

    tokio::fs::write(project.path().join("second.txt"), "two\n")
        .await
        .unwrap();
    let second = evidence.collect_task_delta().await.unwrap();
    assert_eq!(second.files_changed, vec!["second.txt"]);

    let third = evidence.collect_task_delta().await.unwrap();
    assert!(third.files_changed.is_empty());
}
```

- [ ] **Step 2: Run and verify the task-delta test**

```powershell
cargo test -p goose agents::codepro_evidence::tests::non_git_task_delta_detects_each_unregistered_write_once --lib -- --exact --nocapture
```

Expected: PASS after Task 2; if it fails, update only the native task snapshot after a successful `build_native_evidence` result.

- [ ] **Step 3: Add a contradictory Worker narrative report test**

In the `result_aggregator` test module, construct a Coder `TaskOutput` with `files_changed = vec!["src/lib.rs"]` and `change_report = "没有修改任何文件"`, then assert:

```rust
assert!(report.contains("src/lib.rs"));
assert!(!report.contains("没有修改任何文件"));
```

Use the same DAG and `ResultAggregator` fixture as `fix_report_uses_current_files_changes_and_verification_in_order`; change only the Coder narrative and expected assertions.

- [ ] **Step 4: Run evidence and report suites**

```powershell
cargo test -p goose codepro_evidence --lib -- --nocapture
cargo test -p goose result_aggregator --lib -- --nocapture
```

Expected: PASS; the beginner summary is derived from `files_changed` and structured verification, not hostile or contradictory Worker prose.

- [ ] **Step 5: Commit**

```powershell
git add crates/goose/src/agents/codepro_evidence.rs crates/goose/src/agents/result_aggregator.rs
git commit -m "test: enforce host-owned CodePro change reports"
```

### Task 4: Qualify and harden direct workspace path semantics

**Files:**

- Modify: `crates/goose/src/agents/codepro_workspace.rs`
- Test: `crates/goose/src/agents/codepro_workspace.rs`
- Modify: `crates/goose/src/agents/agent.rs:3809-3835`

**Interfaces:**

- Consumes: checkpoint 中已有的 `CodeProWorkspace::direct(source: &Path) -> Result<CodeProWorkspace>`。
- Produces: 该构造器作为唯一生产入口的可执行合同，以及可单测的 Windows verbatim-prefix 规范化函数。

- [ ] **Step 1: Verify the inherited production-surface contract**

```powershell
cargo test -p goose agents::codepro_workspace::tests::production_workspace_has_no_copy_or_shadow_repository_entry_points --lib -- --exact --nocapture
rg -n "open_or_create|create_shadow_workspace|CODEBUDDY_WORKSPACE_ROOT|CodePro-Workspaces" crates/goose/src --glob '*.rs'
```

Expected: checkpoint 中的生产入口合同测试 PASS；`rg` 无输出。若不满足，checkpoint 不合格，返回 Task 1 修复，而不是继续叠加新实现。

- [ ] **Step 2: Add failing pure Windows prefix-normalization tests**

Refactor target interface and tests:

```rust
#[cfg(target_os = "windows")]
fn normalize_windows_canonical_path(path: PathBuf) -> PathBuf;

#[cfg(target_os = "windows")]
#[test]
fn normalizes_windows_drive_and_unc_verbatim_paths() {
    assert_eq!(
        normalize_windows_canonical_path(PathBuf::from(r"\\?\C:\projects\app")),
        PathBuf::from(r"C:\projects\app")
    );
    assert_eq!(
        normalize_windows_canonical_path(PathBuf::from(r"\\?\UNC\server\share\app")),
        PathBuf::from(r"\\server\share\app")
    );
}
```

Run the exact test and expect a compile failure because the helper is not defined yet.

- [ ] **Step 3: Extract the minimal Windows normalization helper**

Move the existing prefix logic out of `canonical_workspace_path`:

```rust
#[cfg(target_os = "windows")]
fn normalize_windows_canonical_path(path: PathBuf) -> PathBuf {
    let display = path.to_string_lossy();
    if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(drive_path) = display.strip_prefix(r"\\?\") {
        return PathBuf::from(drive_path);
    }
    path
}
```

Call it from `canonical_workspace_path` after `canonicalize()`. Do not otherwise rewrite the path.

- [ ] **Step 4: Run workspace and compile gates**

```powershell
cargo test -p goose agents::codepro_workspace::tests --lib -- --nocapture
cargo check -p goose
```

Expected: PASS with no obsolete constructor references.

- [ ] **Step 5: Commit**

```powershell
git add crates/goose/src/agents/codepro_workspace.rs
git diff --cached --check
git commit -m "test: harden CodePro Windows project paths"
```

### Task 5: Bind run state, resume, and report to one canonical path

**Files:**

- Modify: `crates/goose/src/agents/codepro_workspace.rs`
- Modify: `crates/goose/src/agents/agent.rs:4080-4140`
- Modify: `crates/goose/src/agents/agent.rs:4500-4535`
- Test: `crates/goose/src/agents/agent.rs:11180-11320`
- Test: `ui/desktop/src/components/codepro/CodeProTaskPanel.test.ts`

**Interfaces:**

- Consumes: canonical `working_dir` from `CodeProWorkspace::direct`.
- Produces: `source_repo == worktree_path == report_path == canonical session working_dir`.

- [ ] **Step 1: Add a pure run-location contract helper and tests**

Add `CodeProRunLocation` beside `CodeProWorkspace` in `codepro_workspace.rs` and export it as `pub(crate)`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodeProRunLocation {
    pub(crate) source_repo: PathBuf,
    pub(crate) worktree_path: PathBuf,
}

impl CodeProRunLocation {
    pub(crate) fn direct(working_dir: &Path) -> Self {
        Self {
            source_repo: working_dir.to_path_buf(),
            worktree_path: working_dir.to_path_buf(),
        }
    }
}
```

Test that both fields equal the canonical workspace path and that `is_matching_codepro_linked_replay` rejects a different project.

- [ ] **Step 2: Use the contract for new run state**

At run creation, construct `let location = CodeProRunLocation::direct(working_dir);` and assign its two fields into `CodeProRunState`. Continue using the same `working_dir` for evidence, Planner, Scheduler and report formatting.

- [ ] **Step 3: Add a Unicode Windows report regression**

Extend the existing UI report parsing fixture with:

```ts
const report = parseCodeProRunReport(
  '# CodePro 修复结果：完成\n\n项目路径：`E:\\简历\\项目`',
);
expect(report.workspacePath).toBe('E:\\简历\\项目');
```

The test must assert no `CodeBuddy-Workspaces` or `\\?\` prefix appears.

- [ ] **Step 4: Run backend and UI path tests**

```powershell
cargo test -p goose agents::agent::tests::linked_replay_requires_the_original_active_run_and_project --lib -- --exact --nocapture
cargo test -p goose codepro_workspace --lib -- --nocapture
```

Run from `ui/desktop`:

```powershell
pnpm exec vitest run src/components/codepro/CodeProTaskPanel.test.ts src/components/codepro/codeProTaskPanelModel.test.ts
```

Expected: all path, replay and Unicode display cases pass.

- [ ] **Step 5: Commit**

```powershell
git add crates/goose/src/agents/agent.rs ui/desktop/src/components/codepro/CodeProTaskPanel.test.ts ui/desktop/src/components/codepro/codeProTaskPanelModel.test.ts
git commit -m "fix: keep CodePro run paths consistent"
```

### Task 6: Run G0 and freeze the repaired baseline

**Files:**

- Verify only; no production edits expected.

**Interfaces:**

- Produces: G0 commit hash and fresh verification evidence for starting U-75.

- [ ] **Step 1: Run focused Rust gates**

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose codepro_evidence --lib --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose codepro_workspace --lib --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose result_aggregator --lib --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose task_scheduler --lib --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test activity_event_contract --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_event_log --jobs 1 -- --nocapture
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run the full Rust library gate**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1 --no-fail-fast
```

Expected: exit `0`; do not substitute a focused test run for this gate.

- [ ] **Step 3: Run desktop gates**

From `ui/desktop`:

```powershell
pnpm run typecheck
pnpm run test:run
pnpm run lint:check
pnpm run test:distribution
```

Expected: all commands exit `0`.

- [ ] **Step 4: Verify scope and cleanliness**

```powershell
git diff --check
git status --short
git log -6 --oneline
```

Expected: no unstaged/staged product-code changes under `crates/` or `ui/`; any remaining `documentation/` changes are explicitly reported as pre-existing and out of scope. The U-74F commits are visible and individually reversible.

- [ ] **Step 5: Mark G0 achieved in the active goal only after evidence exists**

Do not create an empty “gate passed” commit. Record the exact commands, pass counts, commit hashes and remaining out-of-scope paths in the implementation handoff. If any required command is unavailable, mark G0 `NOT_MEASURED` and stop before U-75.
