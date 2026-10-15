# CodePro U-76 Authoritative Event Store and Projection Plan

> Execute sequentially with test-driven development. Each task must finish with its focused tests and an atomic commit before the next task begins.

**Goal:** Build the durable, replayable v1 event foundation required by G1 without changing the current user-visible Scheduler path.

**Architecture:** Add a host-owned file event store under `agents/control_plane` and deterministic read models under `agents/reporting`. The v1 JSONL stream is the future source of truth; projections are disposable and rebuildable. Legacy `CodeProEventRecord` data is converted through an explicit, deterministic migration adapter. Existing production scheduling and legacy persistence remain active and unchanged until U-78 shadow integration proves equivalence.

**Storage contract:** One run per directory, one `events.v1.jsonl` stream per run. A writer obtains an exclusive file lock, reloads the committed stream, compares the caller's expected last sequence, validates the whole batch, appends newline-delimited canonical JSON, flushes, and calls `sync_data`. Reads are strict and never repair silently. A separate recovery operation may truncate only an incomplete final line and returns an auditable recovery report; corruption in any committed line blocks the stream.

**Technology:** Rust, `serde_json`, `async_trait`, `fs2`, `chrono`, `tempfile`, existing CodePro protocol types.

**Baseline:** `b8df41b88`

## Non-negotiable boundaries

- LLMs, Workers, and UI do not receive a raw append handle.
- `expected_sequence` is the caller's last observed committed sequence (`0` for a new stream).
- Every appended event must be for the requested run and use contiguous sequences beginning at `expected_sequence + 1`.
- Duplicate event IDs are rejected both within the batch and against committed history.
- Unsupported protocol versions, invalid transitions, cross-run evidence, sequence gaps, and non-final corruption fail closed.
- No read operation mutates disk.
- Legacy migration may derive deterministic event IDs but must report the mapping and must never invent an `AgentId`.
- Projection files and reconciliation reports are caches/audit artifacts, never a second source of truth.
- U-76 does not route production execution through the new store and does not change desktop behavior.

## Task 1: Define the event-store interface and optimistic append

**Files:**

- Create `crates/goose/src/agents/control_plane/mod.rs`
- Create `crates/goose/src/agents/control_plane/event_store.rs`
- Modify `crates/goose/src/agents/mod.rs`
- Create `crates/goose/tests/codepro_run_event_store.rs`

**Interfaces:**

```rust
#[async_trait]
pub trait RunEventStore {
    async fn append(
        &self,
        run_id: &RunId,
        expected_sequence: u64,
        events: &[RunEvent],
    ) -> Result<AppendReceipt, EventStoreError>;

    async fn load(&self, run_id: &RunId) -> Result<Vec<RunEvent>, EventStoreError>;
}

pub struct FileRunEventStore;
pub struct AppendReceipt;
pub enum EventStoreError;
```

- [ ] Add RED tests for an empty-stream append and reload, stale expected sequence, cross-run batch, a sequence gap, duplicate event ID, and an empty batch.
- [ ] Implement a run-scoped path derived only from validated `RunId`.
- [ ] Lock before reload/check/append. Validate the complete batch before the first byte is written.
- [ ] Keep the API asynchronous while isolating blocking filesystem work behind the implementation boundary.
- [ ] Run:

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_event_store --jobs 1 -- --nocapture
```

- [ ] Commit: `feat: add CodePro v1 run event store`

## Task 2: Add strict reads and explicit tail recovery

**Files:** Modify `event_store.rs` and `codepro_run_event_store.rs`.

**Interfaces:**

```rust
pub struct RecoveryReport {
    pub truncated_bytes: u64,
    pub last_sequence: u64,
}

impl FileRunEventStore {
    pub async fn recover_incomplete_tail(
        &self,
        run_id: &RunId,
    ) -> Result<RecoveryReport, EventStoreError>;
}
```

- [ ] Add RED tests proving strict load rejects: incomplete final JSON, malformed committed JSON, unknown protocol version, wrong run ID, duplicate sequence/event ID, and a valid final line missing its newline.
- [ ] Treat a complete valid final line without `\n` as detectable incomplete commit, not committed data.
- [ ] Recovery may truncate only the incomplete final segment. It must refuse malformed newline-terminated records and preserve every committed byte.
- [ ] Reopen and append after recovery; prove the next sequence is correct.
- [ ] Run the focused store suite and commit: `feat: recover CodePro event log tails explicitly`.

## Task 3: Build deterministic run, task, and agent projections

**Files:**

- Create `crates/goose/src/agents/reporting/mod.rs`
- Create `crates/goose/src/agents/reporting/projection.rs`
- Modify `crates/goose/src/agents/mod.rs`
- Create `crates/goose/tests/codepro_projection_replay.rs`

**Interfaces:**

```rust
pub struct RunProjection {
    pub run_id: RunId,
    pub state: RunState,
    pub goal: String,
    pub plan_revision: u32,
    pub tasks: BTreeMap<TaskId, TaskProjection>,
    pub agents: BTreeMap<AgentId, AgentProjection>,
    pub last_sequence: u64,
}

impl RunProjection {
    pub fn rebuild(events: &[RunEvent]) -> Result<Self, ProjectionError>;
    pub fn apply(&mut self, event: &RunEvent) -> Result<(), ProjectionError>;
}
```

- [ ] RED: same stream produces equal projections repeatedly; task and agent states evolve independently.
- [ ] RED: reject missing `RunStarted`, multiple starts, unknown task/agent, invalid transition, wrong run, gap, duplicate event, and any event after terminal run.
- [ ] Map lifecycle payloads deterministically. Observation-only events do not mutate state.
- [ ] RED: deleting any serialized projection and rebuilding from events produces the same value.
- [ ] Run the projection suite and commit: `feat: project CodePro run state from events`.

## Task 4: Add deterministic legacy migration

**Files:**

- Modify `crates/goose/src/agents/codepro_event_log.rs`
- Create `crates/goose/src/agents/control_plane/migration.rs`
- Modify `control_plane/mod.rs`
- Create `crates/goose/tests/codepro_event_migration.rs`

**Interfaces:**

```rust
pub struct LegacyMigrationResult {
    pub events: Vec<RunEvent>,
    pub mappings: Vec<LegacyEventMapping>,
    pub warnings: Vec<MigrationWarning>,
}

pub fn migrate_legacy_records(
    records: &[CodeProEventRecord],
) -> Result<LegacyMigrationResult, MigrationError>;
```

- [ ] Add a lossless `CodeProEventRecord -> ActivityEvent` conversion for fields represented by the old schema.
- [ ] RED: duplicate legacy lifecycle IDs become deterministic unique v1 IDs while retaining a shared correlation ID and an auditable mapping.
- [ ] RED: migration is byte-for-byte deterministic, preserves sequence/time/task scope, rejects mixed runs/gaps/unknown versions, and never creates an agent identity from `agent_role`.
- [ ] Legacy-only observations remain `LegacyActivityObserved` and do not assert state transitions that the old record cannot prove.
- [ ] Run migration, protocol, and legacy event-log regression suites; commit: `feat: migrate legacy CodePro events deterministically`.

## Task 5: Add dual-read reconciliation without changing production reads

**Files:**

- Modify `crates/goose/src/agents/codepro_state_store.rs`
- Create `crates/goose/src/agents/reporting/reconciliation.rs`
- Modify `reporting/mod.rs`
- Extend `codepro_projection_replay.rs`

**Interfaces:**

```rust
pub struct ProjectionReconciliation {
    pub run_id: String,
    pub legacy_status: CodeProRunStatus,
    pub projected_status: RunState,
    pub differences: Vec<ProjectionDifference>,
}

impl CodeProStateStore {
    pub fn record_projection_reconciliation(
        &self,
        report: &ProjectionReconciliation,
    ) -> anyhow::Result<()>;
}
```

- [ ] RED: matching terminal status yields no status difference; mismatches are explicit and stable.
- [ ] RED: report writes atomically into the run directory, is bounded, contains no goal, model prompt, command output, or secret-bearing details, and does not modify the legacy snapshot.
- [ ] Do not call this method from the current production path in U-76.
- [ ] Run state-store and projection tests; commit: `feat: reconcile CodePro legacy and event projections`.

## Task 6: Replay scale, migration fixtures, and G1 freeze

**Files:**

- Add fixtures under `crates/goose/tests/fixtures/protocol/legacy/`
- Extend all U-76 integration suites
- Create `docs/superpowers/reports/2026-08-05-codepro-u76-validation.md`

- [ ] Generate and replay 10,000 valid events. Record wall time and assert the local gate stays below 5 seconds; if the environment cannot measure product logic, mark `NOT_MEASURED` with evidence rather than claiming pass.
- [ ] Prove a projection can be rebuilt solely from the event stream after its cache is removed.
- [ ] Prove legacy fixture migration is deterministic and unknown future versions block.
- [ ] Run final gates:

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_event_store --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_projection_replay --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_event_migration --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose codepro_ --lib --jobs 1 -- --nocapture
cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1 --no-fail-fast
```

From `ui/desktop`:

```powershell
pnpm run typecheck
pnpm run test:run
pnpm run lint:check
pnpm run test:distribution
```

- [ ] Scope audit from `b8df41b88`; preserve all user-owned `documentation/` changes.
- [ ] Report exact commits, test counts, recovery semantics, 10,000-event timing, inherited warnings, and remaining risk.
- [ ] Mark `G1: PASS` only if protocol, store, projection, migration, corruption, and full regression gates all pass while production behavior remains unchanged.
- [ ] Commit: `docs: record CodePro U-76 G1 validation`.

## Deferred intentionally

- U-77 owns command validation, reducers, `RunEngine`, Worker lifecycle, cancellation, failure policy, and effect execution.
- U-78 owns production shadow wiring and live reconciliation telemetry.
- U-81 owns ACP/UI projections and desktop controls.
- U-82 owns old-session bulk migration, interrupted side-effect recovery, real-provider qualification, and Windows RC lifecycle.
