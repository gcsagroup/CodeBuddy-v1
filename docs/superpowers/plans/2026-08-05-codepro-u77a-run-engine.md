# CodePro U-77a Reducer and RunEngine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the deterministic Rust command/reducer/commit skeleton that turns validated `ControlCommand` values into committed v1 events and returns effects only after durable append.

**Architecture:** `ControlCommand` is the only input boundary. A pure reducer converts the current `RunProjection` plus a command into event intents and effect intents; it never writes disk or runs tools. `RunEngine` loads the authoritative stream, rebuilds the projection, materializes and preview-applies events, appends them with optimistic sequencing, then binds and returns effects. U-77a does not execute effects or change the current Scheduler production path.

**Tech Stack:** Rust, Tokio, `async_trait`, `chrono`, existing CodePro v1 protocol, `RunEventStore`, `RunProjection`, `thiserror`, `tempfile`, Cargo integration tests.

## Global Constraints

- The Coordinator, Worker, LLM, UI, and legacy Scheduler never receive an event-store append handle.
- A command failure, projection failure, or append conflict returns no executable effects.
- Events are preview-applied to a disposable projection before the first append byte.
- Effects are ordered and reference the committed event that authorized them.
- U-77a supports only `StartRun`, `StartTask`, `PauseRun`, and `ResumeRun`; every other command returns a typed deferred-command error and appends nothing.
- Event IDs are host-derived, deterministic, valid protocol identifiers, and collision-checked against the loaded stream.
- One command batch uses one timestamp and one correlation ID; event sequences remain contiguous.
- `StartTask` requires a `Running` run and a known `Ready` task.
- `PauseRun` and `ResumeRun` obey the frozen v1 state machine; no fallback silently changes an invalid transition.
- U-77a does not spawn/stop Workers, execute tools, adapt `TaskScheduler`, or change desktop behavior.
- No new dependency is added.
- All behavior changes follow RED -> GREEN -> REFACTOR and end in an atomic commit.
- Preserve every user-owned change under `documentation/`; never stage that directory.

---

## File map

| File | Responsibility |
|---|---|
| `crates/goose/src/agents/protocol/commands.rs` | Boundary validation, stable command kind, and authoritative run-ID access |
| `crates/goose/src/agents/control_plane/effects.rs` | Typed effect intents and committed effects; no effect execution |
| `crates/goose/src/agents/control_plane/reducer.rs` | Pure command + projection -> event/effect intent reduction |
| `crates/goose/src/agents/control_plane/run_engine.rs` | Load, rebuild, reduce, materialize, preview, append, and receipt ordering |
| `crates/goose/src/agents/control_plane/mod.rs` | Export only the host-facing U-77a interfaces |
| `crates/goose/tests/codepro_control_command.rs` | Command boundary contract tests |
| `crates/goose/tests/codepro_control_reducer.rs` | Pure reducer behavior and rejection tests |
| `crates/goose/tests/codepro_run_engine.rs` | File-store integration, conflict, restart, and commit-before-effect tests |
| `docs/superpowers/reports/2026-08-05-codepro-u77a-validation.md` | Exact evidence and deferred-risk record |

## Task 1: Validate every control-command boundary

**Files:**

- Modify: `crates/goose/src/agents/protocol/commands.rs`
- Create: `crates/goose/tests/codepro_control_command.rs`

**Interfaces:**

```rust
impl ControlCommand {
    pub fn run_id(&self) -> &RunId;
    pub const fn kind(&self) -> &'static str;
    pub fn validate(&self) -> Result<(), ProtocolError>;
}
```

- [ ] **Step 1: Write RED tests for run identity and required text**

Create commands for every variant and assert `run_id()` returns the command's authoritative run. Assert empty/whitespace `goal` or `reason` fields fail with `ProtocolError::InvalidEnvelope`.

```rust
assert_eq!(
    ControlCommand::StartRun {
        run_id: run_id.clone(),
        goal: "build the control plane".into(),
    }
    .run_id(),
    &run_id
);

assert!(ControlCommand::PauseRun {
    run_id: run_id.clone(),
    reason: "   ".into(),
}
.validate()
.is_err());
```

- [ ] **Step 2: Write RED tests for nested protocol validation**

Assert zero plan revision fails, foreign-run `WorkerOutcome` evidence fails, invalid `CoordinatorDecisionCandidate` fields fail, and a budget request that adds neither turns nor tokens fails.

- [ ] **Step 3: Run the RED suite**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_control_command --jobs 1 --no-run
```

Expected: compile failure because `ControlCommand::{run_id,kind,validate}` do not exist.

- [ ] **Step 4: Implement the minimal boundary methods**

`validate()` must call the existing protocol helpers instead of duplicating length rules. Validation mapping:

| Command | Validation |
|---|---|
| `StartRun` | required `goal` |
| `RevisePlan` | `plan_revision > 0` |
| `StartTask`, `ResumeRun` | typed IDs already validated |
| `StopWorker`, `CancelTask`, `CancelBranch`, `PauseRun`, `EmergencyStop` | required `reason` |
| `SubmitWorkerOutcome` | `outcome.validate_for_run(run_id)` |
| `ApplyCoordinatorDecision` | `candidate.validate_for_run(&candidate.run_id)` |

- [ ] **Step 5: Run formatting, protocol, and command tests**

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_control_command --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture
```

- [ ] **Step 6: Review and commit**

Stage only `commands.rs` and `codepro_control_command.rs`.

```powershell
git commit -m "feat: validate CodePro control commands"
```

## Task 2: Add the pure reducer and effect intent model

**Files:**

- Create: `crates/goose/src/agents/control_plane/effects.rs`
- Create: `crates/goose/src/agents/control_plane/reducer.rs`
- Modify: `crates/goose/src/agents/control_plane/mod.rs`
- Create: `crates/goose/tests/codepro_control_reducer.rs`

**Interfaces:**

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ControlEffect {
    DispatchTask { run_id: RunId, task_id: TaskId },
    PauseScheduling { run_id: RunId },
    RecoverRun { run_id: RunId },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventIntent {
    pub task_id: Option<TaskId>,
    pub agent_id: Option<AgentId>,
    pub payload: RunEventPayload,
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectIntent {
    pub trigger_event_index: usize,
    pub effect: ControlEffect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reduction {
    pub events: Vec<EventIntent>,
    pub effects: Vec<EffectIntent>,
}

pub fn reduce(
    projection: Option<&RunProjection>,
    command: &ControlCommand,
) -> Result<Reduction, ReducerError>;
```

- [ ] **Step 1: Write RED tests for supported reductions**

Test these exact mappings:

| Current state | Command | Event payload | Effect |
|---|---|---|---|
| no stream | `StartRun` | `RunStarted` | none |
| running run + ready task | `StartTask` | `TaskStateChanged Ready -> Running` | `DispatchTask` |
| running run | `PauseRun` | `RunPaused` | `PauseScheduling` |
| paused run | `ResumeRun` | `RunStateChanged Paused -> Recovering` | `RecoverRun` |

The test projection must be rebuilt from real `RunEvent` fixtures, not manually constructed private state.

- [ ] **Step 2: Write RED rejection tests**

Assert typed errors and empty append intent for:

- `StartRun` when a stream exists;
- non-start command when no stream exists;
- command run ID different from the projection run ID;
- `StartTask` while the run is not `Running`;
- unknown task or task not `Ready`;
- invalid pause/resume transition;
- every U-77b/U-77c/U-78 command variant, using `ReducerError::DeferredCommand { kind }`.

- [ ] **Step 3: Run the RED suite**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_control_reducer --jobs 1 --no-run
```

Expected: unresolved reducer/effect imports.

- [ ] **Step 4: Implement minimal pure reductions**

The reducer must not read the clock, generate IDs, access the event store, or execute an effect. It may inspect only the command and immutable projection. `EffectIntent::trigger_event_index` is zero-based into the returned `events` vector.

- [ ] **Step 5: Add reducer invariant checks**

Before returning a reduction, reject:

- zero events;
- an effect index outside the event-intent vector;
- a task effect whose task ID differs from the authorizing event scope.

Return typed `ReducerError` variants; do not use string matching in tests.

- [ ] **Step 6: Run formatting and reducer/projection regressions**

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_control_reducer --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_projection_replay --jobs 1 -- --nocapture
```

- [ ] **Step 7: Review and commit**

```powershell
git commit -m "feat: reduce CodePro control commands deterministically"
```

## Task 3: Commit events before exposing effects

**Files:**

- Create: `crates/goose/src/agents/control_plane/run_engine.rs`
- Modify: `crates/goose/src/agents/control_plane/effects.rs`
- Modify: `crates/goose/src/agents/control_plane/mod.rs`
- Create: `crates/goose/tests/codepro_run_engine.rs`

**Interfaces:**

```rust
pub trait RunClock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

pub struct SystemRunClock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommittedControlEffect {
    pub effect_id: String,
    pub trigger_event_id: EventId,
    pub effect: ControlEffect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandReceipt {
    pub append: AppendReceipt,
    pub committed_events: Vec<RunEvent>,
    pub projection: RunProjection,
    pub effects: Vec<CommittedControlEffect>,
}

pub struct RunEngine<S, C> {
    store: S,
    clock: C,
}

impl<S: RunEventStore, C: RunClock> RunEngine<S, C> {
    pub fn new(store: S, clock: C) -> Self;
    pub async fn apply(
        &self,
        command: ControlCommand,
    ) -> Result<CommandReceipt, RunEngineError>;
}
```

- [ ] **Step 1: Write RED happy-path integration tests with `FileRunEventStore`**

Use a fixed clock. Prove:

1. `StartRun` commits sequence 1 and returns no effect.
2. A host-seeded running/ready-task stream plus `StartTask` commits the task transition before returning one `DispatchTask` effect.
3. A new `RunEngine` instance can load the same directory and continue from the committed sequence.
4. The returned projection equals a fresh `RunProjection::rebuild(store.load(...))`.

- [ ] **Step 2: Write RED ordering and collision tests**

Seed an earlier event whose ID equals the default next candidate such as `event:5`. Assert the engine deterministically selects `event:5:1`, keeps contiguous sequence 5, and binds the effect to that committed ID. All events emitted by one command must share the first emitted event ID as `correlation_id` and the fixed clock timestamp.

- [ ] **Step 3: Write RED fail-closed tests**

Implement a test-only `RunEventStore` that loads a valid stream but returns `EventStoreError::SequenceConflict` from `append`. Assert `RunEngine::apply` returns `RunEngineError::Store`, no `CommandReceipt` exists, and the store records no committed batch. Also prove reducer/projection rejection never invokes `append`.

- [ ] **Step 4: Run the RED suite**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_engine --jobs 1 --no-run
```

Expected: unresolved `RunEngine`, clock, receipt, and committed-effect types.

- [ ] **Step 5: Implement the engine pipeline in this exact order**

```text
command.validate
  -> command.run_id
  -> store.load
  -> rebuild current projection (or None for an empty stream)
  -> reducer.reduce
  -> materialize contiguous RunEvent batch
  -> RunEvent::validate for every event
  -> preview rebuild/apply on a disposable projection
  -> store.append(expected_sequence, events)
  -> verify AppendReceipt matches the proposed batch
  -> bind effect IDs and trigger event IDs
  -> return CommandReceipt
```

If any step before append fails, do not call append. If append or receipt verification fails, return no effects.

- [ ] **Step 6: Implement deterministic materialization**

- Candidate event ID: `event:<sequence>`.
- On collision: append `:<attempt>` beginning at `1` until the ID is unused.
- Effect ID: `effect:<trigger_sequence>:<effect_index>`.
- All candidates must pass `EventId::new`; an impossible internal formatting failure is a typed `RunEngineError::Invariant`, not a panic.
- Call `clock.now()` once per command and use that timestamp for the entire event batch.
- Use the first event's ID as the batch correlation ID.

- [ ] **Step 7: Run engine, store, projection, and protocol tests**

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_engine --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_event_store --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_projection_replay --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture
```

- [ ] **Step 8: Five-axis review and commit**

Confirm the engine executes no effect, has no production call site, exposes no raw store accessor, adds no dependency, and leaves every file below 800 lines.

```powershell
git commit -m "feat: commit CodePro commands before effects"
```

## Task 4: Freeze U-77a evidence and hand off to lifecycle work

**Files:**

- Create: `docs/superpowers/reports/2026-08-05-codepro-u77a-validation.md`
- Extend only if a missing invariant is found: the three U-77a integration suites

- [ ] **Step 1: Add restart and no-production-wiring audit assertions**

Use repository search evidence to prove `RunEngine::new`/`apply` are referenced only by U-77a tests. Do not add a runtime feature flag in U-77a because nothing is wired yet.

- [ ] **Step 2: Run fresh Rust gates**

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_control_command --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_control_reducer --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_engine --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_event_store --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_projection_replay --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose codepro_ --lib --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1 --no-fail-fast
```

- [ ] **Step 3: Run desktop non-regression gates**

From `ui/desktop`:

```powershell
pnpm run typecheck
pnpm run test:run
pnpm run lint:check
pnpm run test:distribution
```

- [ ] **Step 4: Perform scope and warning audit**

Record:

- exact commits and test counts;
- command support/deferred matrix;
- append-conflict and preview-projection semantics;
- restart evidence;
- absence of production call sites;
- inherited warnings;
- preserved `documentation/` changes;
- U-77b responsibilities: Worker handles, cancellation tokens, process-tree cleanup, and late-result suppression.

- [ ] **Step 5: Write, review, and commit the validation report**

Mark `U-77a: PASS` only if every gate above passes and production behavior remains unchanged.

```powershell
git commit -m "docs: record CodePro U-77a validation"
```

## Deferred intentionally

- U-77b owns `StopWorker`, `CancelTask`, `CancelBranch`, `EmergencyStop`, Worker handles, cancellation tokens, process-tree cleanup, and late-result suppression.
- U-77c owns `SubmitWorkerOutcome`, typed failure policy, bounded infrastructure retries, and dispatcher execution.
- U-77d owns task creation/revision, dependency validation, write ownership, convergence, and legacy Scheduler adapters.
- U-78 owns Coordinator decisions and shadow-mode production wiring.
- U-81 owns ACP/desktop control commands and views.
