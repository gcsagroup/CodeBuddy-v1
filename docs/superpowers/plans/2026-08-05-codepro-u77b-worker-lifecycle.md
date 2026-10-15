# CodePro U-77b Worker Lifecycle and Cancellation Implementation Plan

> **Execution rule:** implement each task with RED -> GREEN -> REFACTOR, commit atomically, and preserve every user-owned file under `documentation/`.

**Goal:** Add host-owned Worker identities, cancellation admission, deterministic stop/cancel/emergency reductions, bounded cooperative-to-forceful shutdown, and Windows process-tree cleanup without wiring the new control plane into production yet.

**Architecture:** The v1 event stream remains the authority for run/task/agent state. A pure reducer commits cancellation intent before a lifecycle effect can run. `WorkerRegistry` owns cancellation tokens and generation-scoped handles; it never writes events. `LifecycleController` applies a committed stop effect through a bounded runtime interface and returns a typed stop receipt. U-77c will own the effect dispatcher that connects committed effects to this controller, and U-77d will own Scheduler/task-graph adapters.

**Tech stack:** Rust, Tokio, `tokio_util::sync::CancellationToken`, `async_trait`, existing v1 protocol/event store/projection, existing Windows `taskkill /T /F` behavior, Cargo integration tests. No new dependency.

## Architectural correction: `CancelBranch` cannot be truthful yet

The roadmap assigns `CancelBranch` to U-77b, but the frozen v1 `TaskCreated` event and `RunProjection` contain no dependency edges. Therefore the authoritative event stream cannot currently prove which tasks are descendants of a root task.

Unsafe alternatives are rejected:

- cancelling only the root silently leaves downstream work alive;
- cancelling every task expands the user's requested scope;
- trusting a caller-supplied descendant list makes the command boundary non-authoritative;
- adding dependency semantics to frozen v1 without versioning violates the U-76 G1 decision.

U-77b1 will keep `CancelBranch` fail-closed with a typed `BranchTopologyUnavailable` error and append nothing. Immediately after U-77b1, the task-topology portion of U-77d will be implemented before U-77c dispatch rollout. Full U-77b acceptance remains open until that topology-backed reduction passes. No report may label branch cancellation supported before then.

## Non-negotiable invariants

- A cancellation command commits state events before any token cancellation, async-task abort, or process-tree termination.
- LLMs, Workers, and UI callers never receive cancellation tokens, abort handles, process IDs, or event-store append handles.
- Worker handles are generation-scoped; a stale handle cannot stop or complete a replacement Worker.
- A late success from a stopping/stopped Worker or a terminal task is suppressed and cannot produce an append candidate.
- Cooperative cancellation is attempted first for normal stop/task cancellation; forceful abort is bounded and explicit.
- Emergency stop does not wait for an LLM and uses immediate host enforcement after its cancellation event commits.
- Windows force-stop covers the descendant process tree, not only the direct child.
- The host never promises rollback of an external side effect already accepted by another system.
- U-77b adds no production call site and executes no control effect from `RunEngine`.

## File map

| File | Responsibility |
|---|---|
| `crates/goose/src/agents/control_plane/effects.rs` | Stop modes and committed lifecycle effect descriptions |
| `crates/goose/src/agents/control_plane/reducer.rs` | Pure `StopWorker`, `CancelTask`, and `EmergencyStop` reductions |
| `crates/goose/src/agents/control_plane/lifecycle.rs` | Bounded cooperative/forceful stop orchestration |
| `crates/goose/src/agents/workers/mod.rs` | Host-facing Worker lifecycle exports |
| `crates/goose/src/agents/workers/handle.rs` | Opaque generation-scoped Worker handle |
| `crates/goose/src/agents/workers/registry.rs` | Token/process ownership and late-outcome admission |
| `crates/goose/src/agents/workers/process_tree.rs` | Typed, bounded process-tree termination interface and Windows implementation |
| `crates/goose/tests/codepro_cancellation_reducer.rs` | Command-to-event/effect and fail-closed contracts |
| `crates/goose/tests/codepro_worker_registry.rs` | Handle generation, stop ownership, and late-result suppression |
| `crates/goose/tests/codepro_worker_lifecycle.rs` | Cooperative stop, escalation, idempotence, and process-tree behavior |
| `docs/superpowers/reports/2026-08-05-codepro-u77b1-validation.md` | Evidence plus the still-open branch-topology gate |

## Task 1: Extend committed effect and reducer semantics

**Files:** modify `effects.rs`, `reducer.rs`, `mod.rs`; create `codepro_cancellation_reducer.rs`.

### RED contracts

- `StopWorker` requires a known non-terminal Agent. It emits `AgentStateChanged -> Stopping`; when the Agent owns a `Running` task it also emits `TaskStateChanged Running -> WaitingForCoordinator`. It returns one cooperative stop effect bound to the Agent transition.
- `CancelTask` requires a known non-terminal task. It emits `Stopping` transitions for all active Agents assigned to the task, then `TaskStateChanged -> Cancelled`. It returns one cooperative stop effect when active Agents exist.
- `EmergencyStop` emits `Stopping` for every active Agent, `Cancelled` for every non-terminal task, then `RunCancelled`. It returns one immediate emergency effect bound to `RunCancelled`, including when no Agent is active so the future dispatcher can block new writes.
- `PauseRun` remains a scheduling pause and does not claim that already accepted external writes were rolled back.
- `CancelBranch` returns `ReducerError::BranchTopologyUnavailable` and an empty append intent.

### Rejections

- unknown Agent/task;
- stopped or crashed Agent;
- terminal task/run;
- illegal source transitions;
- cross-run command;
- effect Agent IDs without matching committed `Stopping` events;
- cancellation effect bound outside its task/run scope.

### Verification and commit

Run cancellation reducer, original reducer, projection, and protocol suites. Commit:

```text
feat: reduce CodePro lifecycle cancellations safely
```

## Task 2: Add opaque Worker handles and registry admission

**Files:** create `workers/{mod.rs,handle.rs,registry.rs}`; modify `agents/mod.rs`; create `codepro_worker_registry.rs`.

### Interfaces

```rust
pub struct WorkerHandle { /* private identity and generation */ }

pub enum OutcomeAdmission {
    Accepted,
    Suppressed(OutcomeSuppression),
}

pub enum OutcomeSuppression {
    UnknownWorker,
    StaleGeneration,
    WorkerStopping,
    WorkerTerminal,
    TaskTerminal,
    RunMismatch,
}

pub struct WorkerRegistry { /* host-owned map */ }
```

Registry operations must:

- register one active generation for `(run_id, agent_id)` and return an opaque handle plus a child cancellation token intended only for the runner adapter;
- reject duplicate live registration;
- replace only a terminal generation and increment the generation counter;
- cancel only the exact current generation;
- register/unregister process IDs against the exact handle;
- mark normal completion or crash with a typed terminal state;
- admit outcomes only when run, generation, Agent state, and projected task state are still current;
- make repeated stop/finish operations idempotent without converting a stale success into acceptance.

Tests must prove a cancelled generation's late success is suppressed after a replacement is registered.

Commit:

```text
feat: own CodePro worker handles in the host
```

## Task 3: Add bounded process-tree termination

**Files:** create `workers/process_tree.rs`; create/extend `codepro_worker_lifecycle.rs`.

### Interfaces

```rust
#[async_trait]
pub trait ProcessTreeTerminator: Send + Sync {
    async fn terminate_tree(&self, process_id: u32) -> Result<ProcessTreeStop, ProcessTreeError>;
}

pub struct SystemProcessTreeTerminator;
```

Windows behavior:

- validate a non-zero PID;
- run `taskkill /PID <pid> /T /F` without a visible console window;
- bound the command to 3 seconds;
- distinguish already-exited from failed termination;
- return only bounded diagnostic text and never interpolate a shell command;
- verify with a test-owned parent/child process fixture that both descendants disappear.

Non-Windows behavior must be explicit and tested/compiled; it must not claim Windows tree semantics.

Do not refactor the existing shell terminator in this task. Production unification belongs to the later Worker adapter so U-77b cannot regress current shell execution.

Commit:

```text
feat: terminate CodePro worker process trees safely
```

## Task 4: Orchestrate cooperative and forceful Worker stop

**Files:** create `control_plane/lifecycle.rs`; modify exports; extend `codepro_worker_lifecycle.rs`.

### Interfaces

```rust
pub enum WorkerStopMode {
    CooperativeThenForce,
    Immediate,
}

pub struct WorkerStopReceipt {
    pub agent_id: AgentId,
    pub generation: u64,
    pub cooperative: bool,
    pub forced: bool,
    pub process_trees: Vec<ProcessTreeStop>,
}

pub struct LifecycleController<R, P> { /* registry + process terminator */ }
```

The controller must:

1. verify the committed effect matches the current handle;
2. mark the Worker stopping and cancel its token immediately;
3. wait a configurable bounded grace period for runner completion;
4. if still active, terminate every registered process tree and abort the runner task through a host-only control interface;
5. mark the exact generation stopped and return a receipt;
6. return typed partial-cleanup evidence if any process tree cannot be confirmed stopped.

Use paused Tokio time for deterministic grace/escalation tests. Do not use real multi-second sleeps.

Commit:

```text
feat: stop CodePro workers with bounded escalation
```

## Task 5: Validate U-77b1 and hand off topology

Run fresh gates:

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_cancellation_reducer --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_worker_registry --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_worker_lifecycle --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_engine --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose codepro_ --lib --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1 --no-fail-fast
```

Run the four desktop non-regression gates. Audit production call sites, dependencies, file sizes, inherited warnings, and preserved `documentation/` changes.

The report may mark `U-77b1: PASS` for direct lifecycle/cancellation only. It must list `CancelBranch` as blocked on authoritative topology and must not mark full U-77b complete.

Commit:

```text
docs: record CodePro U-77b1 validation
```

## Immediate follow-on: topology before dispatch

Before U-77c effect dispatch, implement the task-topology portion of U-77d with a versioned, replayable dependency contract. Then:

- derive descendants from authoritative replayed topology;
- reduce `CancelBranch` into exact Agent/task transitions;
- prove unrelated branches are untouched;
- prove cycles/cross-run IDs/unknown roots fail closed;
- re-run U-77b and mark full branch-cancellation acceptance only after those tests pass.

## Deferred intentionally

- U-77c: `SubmitWorkerOutcome`, failure policy, infrastructure retry, ready-task dispatcher, and actual committed-effect dispatch.
- U-77d remainder: task creation/revision, dependency convergence, write ownership, and legacy Scheduler/Worker adapters.
- U-78+: Coordinator decisions, shadow/advisory/authoritative rollout, ACP/UI controls, uncertain-side-effect recovery, and RC qualification.
