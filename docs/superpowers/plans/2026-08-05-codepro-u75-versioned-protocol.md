# CodePro U-75 Versioned Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提取 CodePro v1 控制协议的类型化 ID、三层状态、Worker 结果、Coordinator 命令候选和事件 envelope，在不改变现有执行行为的前提下，为 U-76 权威事件存储建立稳定合同。

**Architecture:** 新协议位于独立的 `agents/protocol` 模块，当前 `ActivityEvent`、DAG 和 Scheduler 仍是生产路径。反序列化先验证协议版本，状态迁移和证据归属由纯函数验证；旧活动事件仅通过未接线的只读适配器转换，U-75 不创建事件存储、不切换事实源。

**Tech Stack:** Rust 1.96.1、Serde、Chrono、thiserror、现有 `goose` crate；Windows 低内存 Cargo 门禁。

## Global Constraints

- 当前协议版本固定为 `1`；任何未知版本必须拒绝反序列化，不能静默降级。
- `RunId`、`TaskId`、`AgentId`、`EventId` 非空、最多 128 字节，只允许 ASCII 字母数字及 `- _ . :`。
- 每个 `EvidenceRef` 必须属于当前 `run_id`；制品路径必须相对且不得包含 `..`、根目录或 Windows 盘符前缀。
- Run、Task、Agent 状态独立；Agent 崩溃不自动失败 Task，Task 失败不自动失败 Run。
- JSON 字段使用 `snake_case`，payload 使用相邻的 `event_type`/`payload` 标签；v1 fixture 必须稳定往返。
- U-75 不修改 Scheduler、DAG、桌面行为或持久化写路径，只增加类型、验证和只读适配。
- 不增加依赖；保留用户现有 `documentation/` 草稿，不暂存、不重写。
- Rust 测试设置 `CARGO_INCREMENTAL=0`、测试 debug info 为 `0`、`--jobs 1`。

---

## File Structure

- `protocol/mod.rs`：公共导出和统一 `ProtocolError`。
- `protocol/versioning.rs`：`ProtocolVersion` 和只接受 v1 的 Serde 合同。
- `protocol/identifiers.rs`：四类 ID、`EvidenceRef` 和路径/Run 归属验证。
- `protocol/states.rs`：三层状态与显式迁移矩阵。
- `protocol/outcomes.rs`：Worker 结果、失败分类、阻塞、检查点和取消。
- `protocol/commands.rs`：Control Plane 命令和 Coordinator 决策候选。
- `protocol/events.rs`：v1 `RunEvent`、payload、envelope 验证和旧事件适配。
- `tests/codepro_protocol_contract.rs`：公共协议合同。
- `tests/fixtures/protocol/v1/run_started.json`：冻结的 v1 fixture。
- `docs/superpowers/reports/2026-08-05-codepro-u75-validation.md`：固定验证证据。

### Task 1: Version, Typed IDs, and Evidence Ownership

**Files:** Create `crates/goose/src/agents/protocol/{mod.rs,versioning.rs,identifiers.rs}`; modify `crates/goose/src/agents/mod.rs`; create `crates/goose/tests/codepro_protocol_contract.rs`.

**Interfaces:** Produces `ProtocolVersion::V1`, `RunId`, `TaskId`, `AgentId`, `EventId`, `EvidenceRef`, `ProtocolError`. Later tasks consume `EvidenceRef::validate_for_run(&RunId)`.

- [ ] **Step 1: Write the failing public contract**

```rust
#[test]
fn ids_versions_and_evidence_ownership_are_fail_closed() {
    use goose::agents::protocol::{EventId, EvidenceRef, ProtocolVersion, RunId};
    assert!(RunId::new("run-1").is_ok());
    assert!(RunId::new("").is_err());
    assert!(RunId::new("run/escape").is_err());
    assert!(serde_json::from_str::<ProtocolVersion>("1").is_ok());
    assert!(serde_json::from_str::<ProtocolVersion>("2").is_err());
    let current = RunId::new("run-1").unwrap();
    let foreign = EvidenceRef::new(
        RunId::new("run-2").unwrap(),
        EventId::new("event-1").unwrap(),
        "artifacts/stdout.txt",
    ).unwrap();
    assert!(foreign.validate_for_run(&current).is_err());
    assert!(EvidenceRef::new(current, EventId::new("event-2").unwrap(), "../secret").is_err());
}
```

- [ ] **Step 2: Run RED**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract ids_versions_and_evidence_ownership_are_fail_closed --jobs 1 -- --exact --nocapture
```

Expected: compile failure because `agents::protocol` is absent.

- [ ] **Step 3: Implement the minimal boundary**

`ProtocolVersion` is a transparent `u16` newtype with custom `Deserialize` accepting only `1`. Each ID has validating `new`, `as_str`, `Display`, `Serialize`, and custom `Deserialize`. `EvidenceRef` is:

```rust
pub struct EvidenceRef {
    pub run_id: RunId,
    pub event_id: EventId,
    pub artifact_ref: PathBuf,
}
```

Reject empty/absolute/prefix/root/parent paths and both slash styles of traversal. Use typed `ProtocolError::{InvalidIdentifier, UnsupportedVersion, InvalidArtifactRef, CrossRunEvidence}`.

- [ ] **Step 4: Run GREEN and commit**

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture
git add crates/goose/src/agents/protocol crates/goose/src/agents/mod.rs crates/goose/tests/codepro_protocol_contract.rs
git diff --cached --check
git commit -m "feat: add CodePro protocol identity boundary"
```

### Task 2: Independent State Machines

**Files:** Create `protocol/states.rs`; modify `protocol/mod.rs` and `codepro_protocol_contract.rs`.

**Interfaces:** Produces `RunState`, `TaskState`, `AgentState`, each with `validate_transition(self, next) -> Result<(), ProtocolError>`.

- [ ] **Step 1: Add RED tests** for Planning→Running, Running Task→Succeeded, Running Agent→Crashed, and rejection of transitions out of all terminal states.
- [ ] **Step 2: Implement these exact matrices:**

```text
Run: Planning -> Running|WaitingForUser|Paused|Failed|Cancelled
Run: Running -> WaitingForUser|Paused|Recovering|Completing|Failed|Cancelled
Run: WaitingForUser -> Running|Paused|Failed|Cancelled
Run: Paused -> Recovering|Cancelled
Run: Recovering -> Running|Paused|Failed|Cancelled
Run: Completing -> Completed|Failed|Cancelled
Task: Proposed -> Ready|Cancelled|Skipped
Task: Ready -> Running|Paused|Cancelled|Skipped
Task: Running -> WaitingForCoordinator|WaitingForApproval|Paused|Succeeded|Failed|Cancelled
Task: WaitingForCoordinator|WaitingForApproval -> Ready|Running|Paused|Failed|Cancelled
Task: Paused -> Ready|Cancelled
Agent: Starting -> Running|Stopping|Stopped|Crashed
Agent: Running -> Idle|Stopping|Crashed
Agent: Idle -> Running|Stopping|Crashed
Agent: Stopping -> Stopped|Crashed
```

No same-state transition and no outgoing terminal transition is legal.

- [ ] **Step 3: Run GREEN and commit**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract state_machines_reject_impossible_transitions --jobs 1 -- --exact --nocapture
git add crates/goose/src/agents/protocol/states.rs crates/goose/src/agents/protocol/mod.rs crates/goose/tests/codepro_protocol_contract.rs
git commit -m "feat: define CodePro protocol state machines"
```

### Task 3: Worker Outcomes and Coordinator Candidates

**Files:** Create `protocol/{outcomes.rs,commands.rs}`; modify `protocol/mod.rs` and the contract test.

**Interfaces:** Produces `WorkerOutcome`, `FailureClass`, `TaskResult`, `TaskFailure`, `BlockReason`, `AssistanceRequest`, `Checkpoint`, `CancellationReport`, `ControlCommand`, `CoordinatorDecision`, `CoordinatorDecisionCandidate`. Outcomes and candidates expose `validate_for_run(&RunId)`.

- [ ] **Step 1: Add RED tests** where a succeeded outcome with current evidence passes and a decision candidate with foreign evidence returns `CrossRunEvidence`.
- [ ] **Step 2: Implement the exact outcome enum:**

```rust
pub enum WorkerOutcome {
    Succeeded(TaskResult),
    Failed(TaskFailure),
    Blocked(BlockReason),
    NeedsHelp(AssistanceRequest),
    Paused(Checkpoint),
    Cancelled(CancellationReport),
}
```

`FailureClass` uses the ten design variants. Bound every summary/reason to 4,096 UTF-8 bytes, capability/permission names to 128 bytes, and lists to 128 items; reject with `LimitExceeded`, never truncate silently.

- [ ] **Step 3: Implement commands and decision candidate**

`ControlCommand` variants: `StartRun`, `RevisePlan`, `StartTask`, `StopWorker`, `CancelTask`, `CancelBranch`, `PauseRun`, `ResumeRun`, `EmergencyStop`, `SubmitWorkerOutcome`, `ApplyCoordinatorDecision`.

`CoordinatorDecision` variants: `ContinueTask`, `SendInstruction`, `SpawnTask`, `RetryTask`, `ReplaceWorker`, `RevisePlan`, `PauseTask`, `CancelTask`, `CancelBranch`, `AskUser`, `CompleteRun`, `FailRun`.

Candidate fields: version, Run/decision IDs, decision, reason, optional target Task/Agent, evidence refs, optional budget, permissions, expected completion and superseded plan revision.

- [ ] **Step 4: Run GREEN and commit**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture
git add crates/goose/src/agents/protocol crates/goose/tests/codepro_protocol_contract.rs
git commit -m "feat: add CodePro worker and command contracts"
```

### Task 4: Versioned Run Events and Frozen v1 Fixture

**Files:** Create `protocol/events.rs` and `tests/fixtures/protocol/v1/run_started.json`; modify `protocol/mod.rs` and contract tests.

**Interfaces:** Produces `RunEvent`, `RunEventPayload`, `RunEvent::{validate,from_json,to_json}` for U-76. No U-75 production writer uses them.

- [ ] **Step 1: Add RED tests** for fixture semantic roundtrip, sequence `0`, task/agent envelope mismatch, foreign evidence and version `2` rejection.
- [ ] **Step 2: Add this fixture:**

```json
{
  "protocol_version": 1,
  "run_id": "run-1",
  "event_id": "event-1",
  "sequence": 1,
  "task_id": null,
  "agent_id": null,
  "causation_id": null,
  "correlation_id": "event-1",
  "occurred_at": "2026-08-05T00:00:00Z",
  "event_type": "run_started",
  "payload": { "goal": "build the project" },
  "evidence_refs": []
}
```

- [ ] **Step 3: Implement every core payload** named in design section 6: RunStarted, PlanProposed, PlanRevised, TaskCreated, TaskStateChanged, AgentSpawned, AgentStateChanged, ToolCallStarted, ToolCallCompleted, CheckpointSaved, TaskSucceeded, TaskFailed, AssistanceRequested, PermissionRequested, CoordinatorDecisionMade, RunPaused, RunCompleted, RunFailed, RunCancelled.

Task/Agent payload IDs must equal envelope IDs. `from_json` deserializes then validates; `to_json` validates before serialization. Sequence starts at `1`, timestamps are UTC, all evidence refs validate against envelope Run.

- [ ] **Step 4: Run GREEN and commit**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture
git add crates/goose/src/agents/protocol crates/goose/tests/codepro_protocol_contract.rs crates/goose/tests/fixtures/protocol/v1/run_started.json
git commit -m "feat: freeze CodePro v1 run events"
```

### Task 5: Read-Only Legacy Activity Adapter

**Files:** Modify `protocol/events.rs` and the contract test.

**Interfaces:** Produces `RunEvent::from_activity_event(sequence: u64, event: &ActivityEvent) -> Result<RunEvent, ProtocolError>`. It is not wired into `CodeProEventLog` in U-75.

- [ ] **Step 1: Add RED test** converting an `ActivityEventKind::RunCompleted` event at sequence `7`; assert identity, timestamp, correlation ID, safe summary, payload and validation.
- [ ] **Step 2: Implement exhaustive mapping.** Map authoritative equivalents to typed payloads. Map legacy-only observations to `LegacyActivityObserved { kind, status, title }`. Reject `Unknown`, wrong legacy schema version, invalid IDs and sequence `0`.
- [ ] **Step 3: Run GREEN and commit**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose activity_event --lib --jobs 1 -- --nocapture
git add crates/goose/src/agents/protocol/events.rs crates/goose/tests/codepro_protocol_contract.rs
git commit -m "feat: adapt legacy CodePro activity events"
```

### Task 6: Freeze U-75 Validation

**Files:** Create `docs/superpowers/reports/2026-08-05-codepro-u75-validation.md`.

**Interfaces:** Produces a reproducible U-75 baseline for U-76. It must state `G1: NOT YET — requires U-76`.

- [ ] **Step 1: Run final gates**

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose codepro_ --lib --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1 --no-fail-fast
```

From `ui/desktop`: `pnpm run typecheck`, `pnpm run test:run`, `pnpm run lint:check`, `pnpm run test:distribution`.

- [ ] **Step 2: Self-review and scope scan**

```powershell
Get-Content docs/superpowers/plans/2026-08-05-codepro-u75-versioned-protocol.md | Select-String -Pattern ('T'+'BD'), ('T'+'ODO'), ('implement'+' later'), ('fill'+' in'), ('appropriate'+' error')
git diff --name-only 9f324989b..HEAD
git status --porcelain=v1 -- crates ui docs/superpowers
```

Expected: no placeholders; only approved protocol/export/tests/fixture/report changes; `crates/` and `ui/` clean after commits.

- [ ] **Step 3: Record and commit evidence**

Record exact hashes, exit codes, test counts, inherited warnings, and `G1: NOT YET — requires U-76`, then commit:

```powershell
git add docs/superpowers/reports/2026-08-05-codepro-u75-validation.md
git commit -m "docs: record CodePro U-75 protocol validation"
```

## Plan Self-Review

- Covered: version rejection, typed identities, three independent states, all core events, Worker outcomes, Coordinator candidates, cross-Run evidence rejection, stable fixture, legacy adapter and no-behavior-change gates.
- Deliberately deferred to U-76: optimistic sequence writes, JSONL corruption recovery, 10,000-event replay, projection, dual-read reconciliation and migration.
- Type consistency: all later tasks consume `ProtocolVersion`, typed IDs, `EvidenceRef` and `ProtocolError` from Task 1.
- No placeholders: exact matrices, limits, variants, fixture, commands, tests, gates and commit scopes are specified.
