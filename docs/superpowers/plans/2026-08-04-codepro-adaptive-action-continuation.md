# CodePro Adaptive Action Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CodePro's low hard-stop action limits with host-controlled soft checkpoints, evidence-based automatic lease renewal, bounded recovery, durable continuation epochs, and a clear pause/resume experience.

**Architecture:** Extend the existing shared Agent loop, `TaskDAG`, `TaskScheduler`, CodePro state store, event log, and desktop activity components; do not create a second executor. A pure progress ledger classifies host events, an adaptive budget tracker grants leases, the scheduler persists every lease transition, and the frontend renders structured lifecycle events without parsing model prose.

**Tech Stack:** Rust, Tokio, Serde JSON, existing Goose/CodePro Agent runtime, TypeScript, React, React Intl, Vitest, Testing Library, pnpm, Cargo.

## Global Constraints

- Normal long-running tasks automatically continue while host-verified progress exists; no user confirmation is required at soft checkpoints.
- Conversation tasks use a soft limit of 4 and an emergency limit of 8; ReadOnly and FocusedTest use 30/20/150; ProjectTest uses 60/30/300; SimpleChange uses 45/20/150; BugFix uses 60/30/300; ComplexChange uses 80/40/500.
- Non-conversation tasks reserve 10 finalization turns; Conversation reserves 1.
- Planner/model output may shrink a task budget but may never expand host policy, role ceilings, permissions, cost caps, or the emergency limit.
- Waiting for an already-started command, streamed output, a live subagent, persistence, or deterministic aggregation does not consume a model action.
- A recovery lease is granted at most once per task per continuation epoch and is capped at 10 model actions.
- Repeated identical failed tool fingerprints still pause the current worker after two consecutive failures.
- True non-zero test exits remain completed test evidence; they are never converted into Agent execution failure.
- No new third-party dependencies, no permission expansion, no raw chain-of-thought persistence, and no unbounded tool output in state or logs.
- Every task follows RED -> GREEN, runs its own targeted checks immediately, and commits only its files.

---

## File Responsibility Map

- `crates/goose/src/agents/action_progress.rs`: pure structured progress signals, window aggregation, waiting classification, and deterministic lease recommendation inputs.
- `crates/goose/src/agents/action_budget.rs`: task-kind lease policy and `ActionBudgetTracker`; no scheduler, UI, or natural-language parsing.
- `crates/goose/src/agents/task_dag.rs`: serialized per-task budget state, continuation-worker lineage, recovery epochs, and backward-compatible defaults.
- `crates/goose/src/agents/codepro_state_store.rs`: serialized root-run continuation epoch and persisted checkpoint/reconciliation metadata.
- `crates/goose/src/agents/task_scheduler.rs`: records progress signals, grants leases, creates continuation workers, pauses deterministically, and saves state through existing callbacks.
- `crates/goose/src/agents/agent.rs`: shared model loop action accounting, finalization grace, resume reconciliation, and root-run lifecycle.
- `crates/goose/src/agents/activity_event.rs`: backend structured lifecycle event enum and event payload fields.
- `crates/goose/src/agents/codepro_event_log.rs`: durable ordered event records and schema migration.
- `crates/goose/src/agents/codepro_report.rs` and `result_aggregator.rs`: user-facing terminal classification and wording.
- `ui/desktop/src/types/activityEvent.ts`: frontend contract for new budget/progress/checkpoint events.
- `ui/desktop/src/components/codepro/codeProActivityModel.ts`: merge and presentation state for lease and checkpoint events.
- `ui/desktop/src/components/codepro/CodeProActivity.tsx`: chat-body progress, stall, pause, and continuation cards.
- `ui/desktop/src/components/codepro/codeProTaskPanelModel.ts` and `CodeProTaskPanel.tsx`: right-panel status and resume action.
- `ui/desktop/src/acp/adapter/gooseSessionNotifications.ts`: ordered event upsert and reconnect replay.
- `ui/desktop/src/acp/prompt.ts`: existing retry/continue-checkpoint request path; no second resume API.

### Task 1: Structured Progress Ledger

**Files:**
- Create: `crates/goose/src/agents/action_progress.rs`
- Modify: `crates/goose/src/agents/mod.rs`
- Test: `crates/goose/src/agents/action_progress.rs`

**Interfaces:**
- Produces: `ProgressSignal`, `ProgressSignalKind`, `ProgressWindow`, `ProgressAssessment`, `ActionFingerprint`.
- Consumes later: `TaskScheduler` records host events through `ProgressWindow::observe` and passes `ProgressAssessment` to `ActionBudgetTracker::review_lease`.

- [ ] **Step 1: Write the failing pure-function tests**

Add tests proving that new evidence is meaningful, active waiting is neither progress nor failure, repeated evidence is deduplicated, and two identical failed actions trigger a loop result:

```rust
#[test]
fn new_evidence_is_progress_but_duplicate_evidence_is_not() {
    let mut window = ProgressWindow::default();
    assert_eq!(window.observe(ProgressSignal::evidence("read:src/lib.rs")), true);
    assert_eq!(window.observe(ProgressSignal::evidence("read:src/lib.rs")), false);
    assert_eq!(window.assess(), ProgressAssessment::MeaningfulProgress);
}

#[test]
fn live_waiting_defers_the_lease_review_without_spending_an_action() {
    let mut window = ProgressWindow::default();
    window.observe(ProgressSignal::waiting("command:test-1"));
    assert_eq!(window.assess(), ProgressAssessment::Waiting);
}

#[test]
fn two_identical_failed_actions_are_a_deterministic_loop() {
    let mut window = ProgressWindow::default();
    window.observe(ProgressSignal::failed_action("shell", r#"{"command":"pnpm test"}"#));
    window.observe(ProgressSignal::failed_action("shell", r#"{"command":"pnpm test"}"#));
    assert_eq!(window.assess(), ProgressAssessment::RepeatedFailure);
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
cargo test -p goose action_progress --lib -- --nocapture
```

Expected: compilation fails because `action_progress` and its types do not exist.

- [ ] **Step 3: Implement the minimal progress model**

Create these exact public types:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ActionFingerprint {
    pub tool_name: String,
    pub normalized_arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgressSignalKind {
    TaskTransition,
    Evidence,
    FileChange,
    TestResult,
    Finding,
    WorkerResult,
    Waiting,
    FailedAction(ActionFingerprint),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressSignal {
    pub key: String,
    pub kind: ProgressSignalKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressAssessment {
    MeaningfulProgress,
    Waiting,
    NoProgress,
    RepeatedFailure,
}

#[derive(Debug, Default, Clone)]
pub struct ProgressWindow {
    seen_keys: std::collections::HashSet<String>,
    meaningful_count: usize,
    waiting_count: usize,
    consecutive_failed_action: Option<(ActionFingerprint, usize)>,
}
```

`observe` returns `true` only for a new meaningful key. A success or different action clears the consecutive failure counter. `assess` prioritizes `RepeatedFailure`, then `MeaningfulProgress`, then `Waiting`, then `NoProgress`. Add `reset_for_next_lease()` that clears window-local counts while retaining the last failed fingerprint only when its second failure has not yet occurred.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
cargo test -p goose action_progress --lib -- --nocapture
cargo fmt --all -- --check
```

Expected: all `action_progress` tests pass and formatting is clean.

- [ ] **Step 5: Commit Task 1**

```powershell
git add crates/goose/src/agents/action_progress.rs crates/goose/src/agents/mod.rs
git commit -m "feat: add CodePro progress ledger"
```

### Task 2: Adaptive Lease Policy and Tracker

**Files:**
- Modify: `crates/goose/src/agents/action_budget.rs`
- Test: `crates/goose/src/agents/action_budget.rs`

**Interfaces:**
- Consumes: `ProgressAssessment` from Task 1.
- Produces: `CodeProActionBudgetPolicy::{soft_limit_turns, lease_turns, emergency_limit_turns, finalization_grace_turns}`, `LeaseDecision`, and a backward-compatible `ActionBudgetConfig`.

- [ ] **Step 1: Replace old policy assertions with failing adaptive-policy tests**

Add exact table coverage and renewal behavior:

```rust
#[test]
fn task_kinds_receive_adaptive_lease_policies() {
    let cases = [
        (CodeProTaskKind::Conversation, 4, 0, 8, 1),
        (CodeProTaskKind::ReadOnly, 30, 20, 150, 10),
        (CodeProTaskKind::FocusedTest, 30, 20, 150, 10),
        (CodeProTaskKind::ProjectTest, 60, 30, 300, 10),
        (CodeProTaskKind::SimpleChange, 45, 20, 150, 10),
        (CodeProTaskKind::BugFix, 60, 30, 300, 10),
        (CodeProTaskKind::ComplexChange, 80, 40, 500, 10),
    ];
    for (kind, soft, lease, emergency, grace) in cases {
        let policy = CodeProActionBudgetPolicy::for_task_kind(kind);
        assert_eq!((policy.soft_limit_turns(), policy.lease_turns(), policy.emergency_limit_turns(), policy.finalization_grace_turns()), (soft, lease, emergency, grace));
    }
}

#[test]
fn meaningful_progress_can_renew_more_than_once_until_the_emergency_limit() {
    let mut tracker = ActionBudgetTracker::from_policy(
        CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ReadOnly),
        usize::MAX,
    );
    assert_eq!(tracker.review_lease(30, ProgressAssessment::MeaningfulProgress), LeaseDecision::Extended { new_limit: 50 });
    assert_eq!(tracker.review_lease(50, ProgressAssessment::MeaningfulProgress), LeaseDecision::Extended { new_limit: 70 });
}

#[test]
fn no_progress_gets_one_ten_turn_recovery_lease_then_pauses() {
    let mut tracker = ActionBudgetTracker::from_policy(
        CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::BugFix),
        usize::MAX,
    );
    assert_eq!(tracker.review_lease(60, ProgressAssessment::NoProgress), LeaseDecision::Recovery { new_limit: 70 });
    assert_eq!(tracker.review_lease(70, ProgressAssessment::NoProgress), LeaseDecision::PauseNoProgress);
}
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
cargo test -p goose action_budget --lib -- --nocapture
```

Expected: old one-extension fields and decisions do not satisfy the new tests.

- [ ] **Step 3: Implement adaptive fields with old-state migration**

Use these exact decisions:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseDecision {
    Continue,
    Extended { new_limit: usize },
    Waiting,
    Recovery { new_limit: usize },
    PauseNoProgress,
    PauseRepeatedFailure,
    Finalize,
    Exhausted,
}
```

Extend `ActionBudgetConfig` without breaking the current `agent.rs`, `task_dag.rs`, and `subagent_task_config.rs` callers. During this task, keep the existing field names as compatibility projections (`extension_turns` means lease size, `hard_limit_turns` means emergency limit, and `finalization_reserve_turns` means finalization grace). Add the new counters now; Task 3 migrates the serialized DAG shape:

```rust
pub struct ActionBudgetConfig {
    pub current_limit_turns: usize,
    pub extension_turns: usize,
    pub hard_limit_turns: usize,
    pub finalization_reserve_turns: usize,
    pub extension_used: bool,
    pub successful_action_seen: bool,
    pub renewals_used: u32,
    pub recovery_used: bool,
}
```

Expose `lease_turns()`, `emergency_limit_turns()`, and `finalization_grace_turns()` accessors so all new logic uses the new terminology. Keep a temporary `from_legacy(initial, extension, hard, reserve, extension_used)` constructor for Task 3 migration tests. `review_lease` must never exceed the emergency limit; `Waiting` does not change limits; `RepeatedFailure` always pauses; Conversation never receives automatic recovery or renewal.

- [ ] **Step 4: Run focused and compatibility tests**

```powershell
cargo test -p goose action_budget --lib -- --nocapture
cargo test -p goose task_dag --lib -- --nocapture
cargo fmt --all -- --check
```

Expected: adaptive and existing TaskDAG tests compile and pass. Task 2 is not complete while any existing caller is broken.

- [ ] **Step 5: Commit Task 2**

```powershell
git add crates/goose/src/agents/action_budget.rs
git commit -m "feat: make CodePro action budgets lease based"
```

### Task 3: Durable Continuation Epochs and Backward-Compatible State

**Files:**
- Modify: `crates/goose/src/agents/task_dag.rs`
- Modify: `crates/goose/src/agents/codepro_state_store.rs`
- Test: `crates/goose/src/agents/task_dag.rs`
- Test: `crates/goose/src/agents/codepro_state_store.rs`

**Interfaces:**
- Consumes: adaptive policy/config from Task 2.
- Produces: serialized `TaskActionBudgetState`, `ContinuationLineage`, `CodeProRunState.continuation_epoch`, and `CodeProRunState::begin_continuation_epoch`.

- [ ] **Step 1: Add failing migration and epoch tests**

```rust
#[test]
fn legacy_one_extension_state_migrates_without_resetting_consumption() {
    let restored: TaskDAG = serde_json::from_str(include_str!("fixtures/legacy_action_budget_state.json")).unwrap();
    let state = restored.action_budget_states.get("task-1").unwrap();
    assert_eq!(state.renewals_used, 1);
    assert!(!state.recovery_used);
    assert!(state.current_limit_turns >= state.initial_turns);
}

#[test]
fn beginning_a_continuation_epoch_preserves_done_nodes_and_evidence() {
    let mut state = paused_run_state();
    let prior_report = state.dag.tasks[0].output.as_ref().unwrap().change_report.clone();
    state.begin_continuation_epoch("run-2").unwrap();
    assert_eq!(state.continuation_epoch, 2);
    assert_eq!(state.dag.tasks[0].status, TaskStatus::Done);
    assert_eq!(state.dag.tasks[0].output.as_ref().unwrap().change_report, prior_report);
    assert_eq!(state.dag.tasks[1].status, TaskStatus::Pending);
}
```

Create `crates/goose/src/agents/fixtures/legacy_action_budget_state.json` containing one paused task with the old `extension_used` and `successful_action_seen` fields.

- [ ] **Step 2: Run tests and verify RED**

```powershell
cargo test -p goose task_dag --lib -- --nocapture
cargo test -p goose codepro_state_store --lib -- --nocapture
```

Expected: new fields and epoch method are missing.

- [ ] **Step 3: Implement serialized state and migration defaults**

Use these exact state shapes:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContinuationLineage {
    #[serde(default = "default_continuation_epoch")]
    pub epoch: u32,
    pub parent_worker_id: Option<String>,
    pub continuation_index: u32,
}

impl Default for ContinuationLineage {
    fn default() -> Self {
        Self { epoch: 1, parent_worker_id: None, continuation_index: 0 }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskActionBudgetState {
    pub initial_turns: usize,
    pub current_limit_turns: usize,
    pub lease_turns: usize,
    pub emergency_limit_turns: usize,
    pub finalization_grace_turns: usize,
    #[serde(default)] pub renewals_used: u32,
    #[serde(default)] pub recovery_used: bool,
    #[serde(default)] pub turns_taken: usize,
    #[serde(default)] pub lineage: ContinuationLineage,
}
```

Add to `CodeProRunState` with Serde defaults:

```rust
#[serde(default = "default_continuation_epoch")]
pub continuation_epoch: u32,
#[serde(default)]
pub previous_run_ids: Vec<String>,
```

`begin_continuation_epoch` accepts only paused states, appends the old active run ID once, increments the epoch with checked arithmetic, resets only Paused/Cancelled tasks to Pending, preserves Done/Skipped tasks and all outputs, and clears the final report without clearing evidence.

- [ ] **Step 4: Run persistence and DAG tests**

```powershell
cargo test -p goose task_dag --lib -- --nocapture
cargo test -p goose codepro_state_store --lib -- --nocapture
cargo test -p goose codepro_ --lib -- --nocapture
cargo fmt --all -- --check
```

Expected: old fixtures load; new state round-trips; continuation preserves completed work.

- [ ] **Step 5: Commit Task 3**

```powershell
git add crates/goose/src/agents/task_dag.rs crates/goose/src/agents/codepro_state_store.rs crates/goose/src/agents/fixtures/legacy_action_budget_state.json
git commit -m "feat: persist CodePro continuation epochs"
```

### Task 4: Scheduler Lease Renewal and Continuation Workers

**Files:**
- Modify: `crates/goose/src/agents/task_scheduler.rs`
- Modify: `crates/goose/src/agents/subagent_task_config.rs`
- Modify: `crates/goose/src/agents/subagent_handler.rs`
- Test: `crates/goose/src/agents/task_scheduler.rs`

**Interfaces:**
- Consumes: `ProgressWindow`, `ProgressAssessment`, adaptive `TaskActionBudgetState`.
- Produces: `TaskScheduler::record_progress`, `TaskScheduler::review_action_lease`, and continuation-worker scheduling that keeps one logical DAG node.

- [ ] **Step 1: Add failing scheduler tests**

Cover automatic renewal, waiting, continuation workers, recovery exhaustion, and test-failure classification:

```rust
#[test]
fn scheduler_renews_a_project_test_after_verified_progress() {
    let mut fixture = scheduler_fixture(CodeProTaskKind::ProjectTest);
    fixture.record_file_evidence("task-1", "tests/output.xml");
    let decision = fixture.review_lease("task-1", 60).unwrap();
    assert_eq!(decision, LeaseDecision::Extended { new_limit: 90 });
}

#[test]
fn waiting_for_a_live_command_does_not_increment_turns() {
    let mut fixture = scheduler_fixture(CodeProTaskKind::ProjectTest);
    fixture.mark_command_waiting("task-1", "command-1");
    fixture.tick_waiting("task-1").unwrap();
    assert_eq!(fixture.budget("task-1").turns_taken, 0);
}

#[test]
fn role_ceiling_creates_a_continuation_worker_without_reopening_done_tasks() {
    let mut fixture = scheduler_fixture(CodeProTaskKind::ComplexChange);
    fixture.exhaust_current_worker("task-1", AgentRole::Planner);
    let worker = fixture.next_worker("task-1").unwrap();
    assert_eq!(worker.lineage.continuation_index, 1);
    assert_eq!(fixture.task("done-task").status, TaskStatus::Done);
}

#[test]
fn nonzero_test_exit_is_done_evidence_not_agent_failure() {
    let task = completed_test_task_with_exit_code(1);
    assert_eq!(task.status, TaskStatus::Done);
    assert!(task.output.unwrap().test_results.unwrap().contains("exit code: 1"));
}
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
cargo test -p goose task_scheduler --lib -- --nocapture
```

Expected: the scheduler still permits one extension only and lacks waiting/continuation state.

- [ ] **Step 3: Integrate progress recording and lease review**

Add one `ProgressWindow` per running task. Record signals only from existing structured callbacks:

- task status transitions;
- `ActivityEvent` file, command, test, review, and tool completion;
- TaskOutput patch/file/test evidence;
- live command/subagent heartbeats;
- normalized failed action fingerprints.

At the current limit, call `ActionBudgetTracker::review_lease`. On `Extended`, update the DAG state and continue the same worker. On `Recovery`, append a host instruction requiring a different method or environment check. On `PauseNoProgress` or `PauseRepeatedFailure`, keep the existing checkpoint output and pause only the affected worker.

- [ ] **Step 4: Add continuation-worker creation**

When `turns_taken == role.max_turns()` but the root task lease remains valid, create a new `SubagentTaskConfig` with:

```rust
SubagentTaskConfig {
    task_id: original.task_id.clone(),
    parent_worker_id: Some(original.worker_id.clone()),
    continuation_index: original.continuation_index + 1,
    checkpoint_context: Some(checkpoint_summary),
    max_turns: Some(remaining_role_bounded_lease),
    ..original.for_continuation()
}
```

The checkpoint context contains structured completed/remaining steps and evidence references, not the full prior transcript. Charge every new worker turn to the same root task `turns_taken` ledger.

- [ ] **Step 5: Run scheduler tests and regression gates**

```powershell
cargo test -p goose task_scheduler --lib -- --nocapture
cargo test -p goose task_dag --lib -- --nocapture
cargo test -p goose result_aggregator --lib -- --nocapture
cargo fmt --all -- --check
```

Expected: all renewal and continuation tests pass; true project failures remain distinct.

- [ ] **Step 6: Commit Task 4**

```powershell
git add crates/goose/src/agents/task_scheduler.rs crates/goose/src/agents/subagent_task_config.rs crates/goose/src/agents/subagent_handler.rs
git commit -m "feat: renew progressing CodePro tasks"
```

### Task 5: Shared Agent Loop, Finalization Grace, and Resume Reconciliation

**Files:**
- Modify: `crates/goose/src/agents/agent.rs`
- Modify: `crates/goose/src/agents/subagent_handler.rs`
- Test: `crates/goose/src/agents/agent.rs`

**Interfaces:**
- Consumes: scheduler lease decisions and persisted continuation epoch.
- Produces: one no-tool finalization call, host fallback report, and reconciled `CodeProResumeRequest` handling.

- [ ] **Step 1: Add failing Agent-loop tests**

```rust
#[tokio::test]
async fn soft_checkpoint_does_not_inject_budget_pressure_into_model_context() {
    let messages = run_until_first_lease_extension().await;
    assert!(!messages.iter().any(|message| message.as_text().contains("remaining turns")));
    assert!(!messages.iter().any(|message| message.as_text().contains("action-budget finalization")));
}

#[tokio::test]
async fn emergency_limit_gets_one_no_tool_finalization_then_host_fallback() {
    let result = run_emergency_limit_fixture_without_final_text().await;
    assert_eq!(result.finalization_calls, 1);
    assert_eq!(result.finalization_tool_count, 0);
    assert!(result.visible_report.contains("已保存进度"));
}

#[test]
fn checkpoint_resume_starts_a_new_epoch_and_keeps_completed_nodes() {
    let resumed = prepare_codepro_resume_state(paused_state(), workspace(), Some(&resume_request())).unwrap();
    assert_eq!(resumed.continuation_epoch, 2);
    assert_eq!(resumed.dag.tasks[0].status, TaskStatus::Done);
}

#[tokio::test]
async fn compaction_keeps_budget_epoch_and_progress_ledger() {
    let before = long_running_fixture_ready_for_compaction().await;
    let after = compact_and_continue(before.clone()).await;
    assert_eq!(after.continuation_epoch, before.continuation_epoch);
    assert_eq!(after.action_budget.snapshot(), before.action_budget.snapshot());
    assert_eq!(
        after.progress_ledger.last_meaningful_progress,
        before.progress_ledger.last_meaningful_progress
    );
}

#[tokio::test]
async fn repeated_compaction_recovery_failure_pauses_with_checkpoint() {
    let result = run_fixture_with_two_failed_recovery_compactions().await;
    assert_eq!(result.state, CodeProRunState::Paused);
    assert!(result.checkpoint_path.is_some());
    assert!(!result.restarted_from_scratch);
}
```

- [ ] **Step 2: Run Agent tests and verify RED**

```powershell
cargo test -p goose agent::tests::soft_checkpoint --lib -- --nocapture
cargo test -p goose agent::tests::emergency_limit --lib -- --nocapture
cargo test -p goose agent::tests::checkpoint_resume --lib -- --nocapture
```

Expected: old finalization starts at the low hard limit, resume does not create an epoch, and compaction is not yet covered by continuation-state assertions.

- [ ] **Step 3: Move finalization to the emergency boundary**

Do not expose finalization instructions at soft checkpoints. At the emergency limit:

1. stop accepting new model tool requests;
2. allow one provider call with an empty execution-tool list;
3. request completed work, concrete evidence, incomplete work, and exact continuation step;
4. if the model returns no visible text, build the same four sections deterministically from DAG/state evidence;
5. persist before broadcasting the terminal message.

Remove any 70%, 90%, remaining-turn, or “hurry and summarize” prompt injection. Keep technical budget details in host events only.

- [ ] **Step 4: Reconcile state before resume**

Update `prepare_codepro_resume_state` to call `begin_continuation_epoch`, verify workspace path and source run ID, preserve Done/Skipped nodes, and reset only Paused/Cancelled nodes. If file hashes conflict, pause with a conflict reason instead of overwriting user changes.

- [ ] **Step 5: Keep existing automatic compaction compatible with continuation state**

Reuse the existing `check_if_compaction_needed` / `compact_messages` paths in `agent.rs`; do not build a second compaction subsystem. Treat compaction as context maintenance, not as a new task run:

1. preserve the current action lease, continuation epoch, completed DAG nodes, progress ledger, and checkpoint lineage across compaction;
2. do not count a successful compaction itself as meaningful project progress;
3. after at most the existing two failed recovery-compaction attempts, persist a checkpoint and pause instead of restarting the task or entering another retry loop;
4. emit the existing compaction activity plus the new checkpoint/pause lifecycle events so the UI can explain why execution stopped.

- [ ] **Step 6: Run Agent and full CodePro library tests**

```powershell
cargo test -p goose agent::tests --lib -- --nocapture
cargo test -p goose agent::tests::compaction_keeps_budget_epoch --lib -- --nocapture
cargo test -p goose agent::tests::repeated_compaction_recovery_failure --lib -- --nocapture
cargo test -p goose codepro_ --lib -- --nocapture
cargo fmt --all -- --check
```

Expected: finalization occurs only at emergency limit; resume is lossless; compaction neither resets progress nor causes an unbounded retry loop.

- [ ] **Step 7: Commit Task 5**

```powershell
git add crates/goose/src/agents/agent.rs crates/goose/src/agents/subagent_handler.rs
git commit -m "feat: finalize and resume CodePro runs safely"
```

### Task 6: Durable Budget, Progress, and Checkpoint Events

**Files:**
- Modify: `crates/goose/src/agents/activity_event.rs`
- Modify: `crates/goose/src/agents/codepro_event_log.rs`
- Modify: `crates/goose/src/agents/task_scheduler.rs`
- Test: `crates/goose/tests/activity_event_contract.rs`
- Test: `crates/goose/tests/codepro_event_log.rs`
- Test: `crates/goose/src/agents/task_scheduler.rs`

**Interfaces:**
- Produces exact event kinds: `budget_lease_started`, `budget_lease_extended`, `budget_recovery_started`, `budget_finalization_started`, `budget_paused`, `progress_meaningful`, `progress_stall_warning`, `checkpoint_saved`, `checkpoint_reconciled`, `task_resumed`.
- Every event carries existing `session_id`, `run_id`, `task_id`, ordered `sequence`, plus `continuation_epoch` in the structured payload.

- [ ] **Step 1: Write failing schema and replay tests**

```rust
#[test]
fn lease_extension_round_trips_through_the_event_log() {
    let mut event = sample_event("lease-1", ActivityEventStatus::Completed);
    event.event_type = ActivityEventKind::BudgetLeaseExtended;
    event.task_id = Some("task-1".to_string());
    event.continuation_epoch = 2;
    event.technical_details = Some("limit: 90".to_string());
    let record = append_and_reload(event);
    assert_eq!(record.event_type, ActivityEventKind::BudgetLeaseExtended);
    assert_eq!(record.continuation_epoch, 2);
}

#[test]
fn v1_records_migrate_to_epoch_one_and_keep_sequence_order() {
    let records = recover_v1_fixture();
    assert!(records.iter().all(|record| record.continuation_epoch == 1));
    assert!(records.windows(2).all(|pair| pair[0].sequence < pair[1].sequence));
}
```

- [ ] **Step 2: Run contract tests and verify RED**

```powershell
cargo test -p goose --test activity_event_contract -- --nocapture
cargo test -p goose --test codepro_event_log -- --nocapture
```

Expected: new event variants/epoch fields do not exist.

- [ ] **Step 3: Extend the event schema without parsing prose**

Add the ten enum variants to `ActivityEventKind`. Add `#[serde(default = "default_continuation_epoch")] pub continuation_epoch: u32` to `ActivityEvent` and `CodeProEventRecord`. Increment `ACTIVITY_EVENT_SCHEMA_VERSION` from 1 to 2 and let the event log migrate version 1 records by assigning epoch 1; reject unknown versions above 2. Preserve the existing event lifecycle contract: a running and completed record may share one `event_id`; deduplication applies only to an exact duplicate replay at the frontend, not to legitimate lifecycle transitions.

Emit events only after the corresponding state mutation is saved. `checkpoint_saved` must precede terminal `budget_paused`; `task_resumed` must follow `checkpoint_reconciled`.

- [ ] **Step 4: Run event, scheduler, and persistence tests**

```powershell
cargo test -p goose --test activity_event_contract -- --nocapture
cargo test -p goose --test codepro_event_log -- --nocapture
cargo test -p goose task_scheduler --lib -- --nocapture
cargo test -p goose codepro_state_store --lib -- --nocapture
cargo fmt --all -- --check
```

Expected: v1 and v2 logs load; event order is deterministic.

- [ ] **Step 5: Commit Task 6**

```powershell
git add crates/goose/src/agents/activity_event.rs crates/goose/src/agents/codepro_event_log.rs crates/goose/src/agents/task_scheduler.rs crates/goose/tests/activity_event_contract.rs crates/goose/tests/codepro_event_log.rs
git commit -m "feat: stream CodePro lease lifecycle events"
```

### Task 7: Desktop Progress, Stall, Pause, and Continue UI

**Files:**
- Modify: `ui/desktop/src/types/activityEvent.ts`
- Modify: `ui/desktop/src/types/activityEvent.test.ts`
- Modify: `ui/desktop/src/acp/adapter/gooseSessionNotifications.ts`
- Modify: `ui/desktop/src/acp/__tests__/gooseSessionNotifications.test.ts`
- Modify: `ui/desktop/src/components/codepro/codeProActivityModel.ts`
- Modify: `ui/desktop/src/components/codepro/codeProActivityModel.test.ts`
- Modify: `ui/desktop/src/components/codepro/CodeProActivity.tsx`
- Modify: `ui/desktop/src/components/codepro/CodeProActivity.test.tsx`
- Modify: `ui/desktop/src/components/codepro/codeProTaskPanelModel.ts`
- Modify: `ui/desktop/src/components/codepro/codeProTaskPanelModel.test.ts`
- Modify: `ui/desktop/src/components/codepro/CodeProTaskPanel.tsx`
- Modify: `ui/desktop/src/acp/prompt.ts`
- Modify: `ui/desktop/src/acp/__tests__/prompt.test.ts`
- Modify: `ui/desktop/src/i18n/messages/en.json`
- Modify: `ui/desktop/src/i18n/messages/zh-CN.json`

**Interfaces:**
- Consumes: schema v2 lifecycle events from Task 6.
- Produces: merged lifecycle UI and existing `continue_checkpoint` retry payload; does not add a second backend endpoint.

- [ ] **Step 1: Add failing frontend contract tests**

Update `ActivityEvent` fixtures to schema 2 and assert all new event types parse with `continuation_epoch`. Add an explicit raw-event normalization step in the ACP adapter: inspect `schema_version` before calling the strict typed parser, upgrade schema 1 payloads to schema 2 with `continuation_epoch: 1`, then parse. Assert legacy events are upgraded rather than rejected at the UI boundary, while unknown future schema versions remain visible as a recoverable compatibility warning.

Run:

```powershell
Set-Location ui/desktop
pnpm exec vitest run src/types/activityEvent.test.ts src/acp/__tests__/gooseSessionNotifications.test.ts
```

Expected: FAIL because schema 2 and event names are unknown.

- [ ] **Step 2: Extend and normalize the frontend event contract**

Add the ten backend event names to `KNOWN_ACTIVITY_EVENT_TYPES`, set `ACTIVITY_EVENT_SCHEMA_VERSION = 2`, add `continuation_epoch: number`, and validate it as a positive integer. In `gooseSessionNotifications.ts`, upsert by `event_id`, order by backend `sequence`, and ignore a duplicate or older lifecycle update without dropping later events.

- [ ] **Step 3: Add failing presentation tests**

```tsx
it('shows automatic renewal as progress instead of an error', () => {
  renderActivity(event({ event_type: 'budget_lease_extended', status: 'completed' }));
  expect(screen.getByText('系统已根据有效进展自动延长执行时间')).toBeVisible();
  expect(screen.queryByText(/执行失败/)).not.toBeInTheDocument();
});

it('shows a resumable pause with the existing checkpoint action', async () => {
  renderActivity(event({ event_type: 'budget_paused', status: 'interrupted' }));
  await user.click(screen.getByRole('button', { name: '继续剩余任务' }));
  expect(submitPrompt).toHaveBeenCalledWith(expect.objectContaining({ retry_strategy: 'continue_checkpoint' }));
});
```

- [ ] **Step 4: Implement the compact user-facing states**

In chat body and right panel:

- collapse lease events into one current progress row rather than one card per renewal;
- show renewal as neutral progress, not a red error;
- show stall as a warning with “继续等待” and “停止任务” choices;
- show `budget_paused` with completed count, unfinished step, saved-state confirmation, and “继续剩余任务”;
- keep action counts hidden in the ordinary view and available only in technical details;
- stop every spinner when a terminal paused/interrupted/completed/failed event arrives.

Use the existing retry source IDs and `continue_checkpoint` payload in `prompt.ts`; include `checkpoint_id`, `source_run_id`, `source_user_message_id`, and terminal message ID exactly as existing resume validation expects.

- [ ] **Step 5: Run focused frontend tests**

```powershell
Set-Location ui/desktop
pnpm exec vitest run src/types/activityEvent.test.ts src/acp/__tests__/gooseSessionNotifications.test.ts src/components/codepro/codeProActivityModel.test.ts src/components/codepro/CodeProActivity.test.tsx src/components/codepro/codeProTaskPanelModel.test.ts src/acp/__tests__/prompt.test.ts
```

Expected: all lifecycle, dedupe, terminal spinner, and continue-action tests pass.

- [ ] **Step 6: Run the full desktop regression suite**

```powershell
Set-Location ui/desktop
pnpm exec vitest run
pnpm run lint:check
```

Expected: all tests pass with no new accessibility or localization errors.

- [ ] **Step 7: Commit Task 7**

```powershell
git add ui/desktop/src/types/activityEvent.ts ui/desktop/src/types/activityEvent.test.ts ui/desktop/src/acp/adapter/gooseSessionNotifications.ts ui/desktop/src/acp/__tests__/gooseSessionNotifications.test.ts ui/desktop/src/components/codepro/codeProActivityModel.ts ui/desktop/src/components/codepro/codeProActivityModel.test.ts ui/desktop/src/components/codepro/CodeProActivity.tsx ui/desktop/src/components/codepro/CodeProActivity.test.tsx ui/desktop/src/components/codepro/codeProTaskPanelModel.ts ui/desktop/src/components/codepro/codeProTaskPanelModel.test.ts ui/desktop/src/components/codepro/CodeProTaskPanel.tsx ui/desktop/src/acp/prompt.ts ui/desktop/src/acp/__tests__/prompt.test.ts ui/desktop/src/i18n/messages/en.json ui/desktop/src/i18n/messages/zh-CN.json
git commit -m "feat: show resumable CodePro progress"
```

### Task 8: Report Contract, Migration Gates, and Real Desktop Acceptance

**Files:**
- Modify: `crates/goose/src/agents/codepro_report.rs`
- Modify: `crates/goose/src/agents/result_aggregator.rs`
- Modify: `documentation/codebuddy/U-36-阶段3动态行动预算与死循环保护设计.md`
- Modify: `documentation/codebuddy/U-36-阶段3动态行动预算与死循环保护实施计划.md`
- Modify: `documentation/codebuddy/最新开发规划.md`
- Modify: `documentation/codebuddy/BASELINE_2026-07-30_ZH_CN.md`
- Test: `crates/goose/src/agents/codepro_report.rs`
- Test: `crates/goose/src/agents/result_aggregator.rs`
- Test: `ui/desktop/scripts/codebuddy-distribution.test.cjs`

**Interfaces:**
- Consumes: terminal pause/environment/test/finding states from Tasks 3-7.
- Produces: mutually exclusive user report categories and a documented migration baseline.

- [ ] **Step 1: Add failing report-classification tests**

```rust
#[test]
fn budget_pause_is_codepro_incomplete_not_a_project_bug() {
    let report = render_report(run_with_budget_pause());
    assert!(report.contains("CodePro 已保存进度，等待继续"));
    assert!(!report.contains("项目可能有 Bug"));
    assert!(!report.contains("自动测试失败：1"));
}

#[test]
fn a_real_nonzero_test_exit_remains_a_project_test_failure() {
    let report = render_report(run_with_test_exit(1));
    assert!(report.contains("自动测试失败：1"));
    assert!(!report.contains("Agent 执行失败"));
}
```

- [ ] **Step 2: Run report tests and verify RED**

```powershell
cargo test -p goose codepro_report --lib -- --nocapture
cargo test -p goose result_aggregator --lib -- --nocapture
```

Expected: legacy action-limit wording or classification violates at least one assertion.

- [ ] **Step 3: Implement mutually exclusive terminal wording**

Map host reason codes exactly:

- `PausedBudget`, `PausedNoProgress`, `PausedUser` -> `CodePro 未完成`;
- `BlockedEnvironment` -> `环境问题`;
- executed test with non-zero exit -> `自动测试失败`;
- independently verified finding -> `确认业务 Bug`;
- unexecuted scenario -> `未验证`.

Never emit “项目可能有 Bug”. Never infer a category from Agent prose. Put internal turn counts, lease history, full commands, and event IDs only in technical evidence.

- [ ] **Step 4: Update design history and roadmap**

In U-36, add a top-level supersession note linking to the adaptive design and mark the one-extension/low-hard-limit sections historical. In `最新开发规划.md`, add one implementation item for each of Tasks 1-8 and leave them unchecked until their commits and tests exist. In the baseline, record the new policy only after the full gates below pass.

- [ ] **Step 5: Run all deterministic backend gates**

```powershell
Set-Location D:\CodeBuddy
cargo test -p goose action_progress --lib -- --nocapture
cargo test -p goose action_budget --lib -- --nocapture
cargo test -p goose task_dag --lib -- --nocapture
cargo test -p goose task_scheduler --lib -- --nocapture
cargo test -p goose codepro_state_store --lib -- --nocapture
cargo test -p goose codepro_report --lib -- --nocapture
cargo test -p goose result_aggregator --lib -- --nocapture
cargo test -p goose --test activity_event_contract -- --nocapture
cargo test -p goose --test codepro_event_log -- --nocapture
cargo test -p goose --lib --jobs 1 --no-fail-fast
cargo fmt --all -- --check
cargo clippy -p goose --all-targets -- -D warnings
```

Expected: every command exits 0; no test is silently skipped because of the feature flag.

- [ ] **Step 6: Run all desktop gates**

```powershell
Set-Location D:\CodeBuddy\ui\desktop
pnpm exec vitest run
pnpm run lint:check
pnpm run test:distribution
```

Expected: all commands exit 0.

- [ ] **Step 7: Perform eight real desktop scenarios one at a time**

Use non-Git temporary fixtures outside the repository and record event log, final report, files changed, test output, page errors, and console errors for each:

1. large read-only project analysis crosses the old 30-turn boundary and completes;
2. full-project test crosses the old 60-turn boundary and completes;
3. complex Bug fix crosses 90 turns and produces verified changes;
4. long-running compile emits heartbeats and is not charged as repeated model actions;
5. transient Provider 5xx retries/falls back without resetting task progress;
6. user stops during a tool action and resumes only remaining work;
7. app restart restores steps, evidence, and terminal controls;
8. deterministic repeated failure pauses after two identical fingerprints and does not loop.

Expected for every scenario: no lost steps, no endless spinner, no duplicate completed node, no “项目可能有 Bug”, and zero unexplained page/console errors.

- [ ] **Step 8: Commit Task 8**

```powershell
git add crates/goose/src/agents/codepro_report.rs crates/goose/src/agents/result_aggregator.rs documentation/codebuddy/U-36-阶段3动态行动预算与死循环保护设计.md documentation/codebuddy/U-36-阶段3动态行动预算与死循环保护实施计划.md documentation/codebuddy/最新开发规划.md documentation/codebuddy/BASELINE_2026-07-30_ZH_CN.md
git commit -m "docs: complete adaptive CodePro continuation rollout"
```

## Final Verification

- [ ] Confirm `git diff --check` exits 0.
- [ ] Confirm `git status --short` contains only known pre-existing user changes or is clean.
- [ ] Confirm no source contains the legacy ordinary-user error text:

```powershell
rg -n "子 Agent 达到行动次数上限|项目可能有 Bug|remaining turns|70%|90%" crates/goose/src ui/desktop/src
```

Expected: no user-facing source matches; test fixtures may match only when asserting absence.

- [ ] Confirm every adaptive event is documented and parsed on both sides:

```powershell
rg -n "budget_lease_started|budget_lease_extended|budget_recovery_started|budget_finalization_started|budget_paused|progress_meaningful|progress_stall_warning|checkpoint_saved|checkpoint_reconciled|task_resumed" crates/goose/src/agents ui/desktop/src
```

Expected: each event appears in the Rust contract, TypeScript contract, producer, consumer, and tests.

- [ ] Review all commits and verify each task's tests ran immediately before its commit.
