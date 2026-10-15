# CodePro Authoritative Task Topology and Branch Cancellation Plan

> **Execution rule:** implement every behavior with RED -> GREEN -> REFACTOR, commit each task atomically, and preserve all user-owned `documentation/` changes.

**Goal:** Add an additive v2 protocol event for an atomic, replayable task-graph snapshot, derive branch membership from the authoritative projection, and complete exact `CancelBranch` reduction before any production effect dispatcher exists.

**Architecture:** v1 remains readable and semantically frozen. Protocol v2 adds one plan-scoped `TaskGraphDeclared` snapshot rather than altering v1 `TaskCreated`. A snapshot names every task in the current plan and all of its direct prerequisites; the projection accepts it only when the whole graph matches the current plan revision, references known tasks, and is acyclic. `CancelBranch` reads the replayed reverse dependency graph, emits exact Worker-stopping and non-terminal task-cancellation events, and leaves unrelated branches untouched. Graph authoring from Planner/Scheduler adapters remains part of the rest of U-77d; no production runtime is cut over in this slice.

**Tech stack:** Rust, Serde, existing CodePro protocol/event store/projection/reducer/RunEngine, Cargo integration tests. No new dependency.

## Why an atomic v2 graph snapshot

The existing v1 `TaskCreated { task_id, name }` event has no dependency information. Mutating its meaning or adding defaulted fields would make a supposedly frozen v1 stream depend on reader version. A second non-event-store graph would create split authority and could disagree after restart.

The selected v2 event is plan-scoped and atomic:

```rust
pub struct TaskDependency {
    pub task_id: TaskId,
    pub depends_on: Vec<TaskId>,
}

RunEventPayload::TaskGraphDeclared {
    plan_revision: u32,
    dependencies: Vec<TaskDependency>,
}
```

Every task in the current `PlanProposed`/`PlanRevised` task set must appear exactly once, including roots with an empty `depends_on` list. This completeness rule prevents a missing declaration from hiding a descendant during branch cancellation.

## Non-negotiable invariants

- Protocol v1 fixtures continue to deserialize, validate, replay, and round-trip unchanged.
- Protocol v2 is additive; readers accept v1 and v2, reject unknown versions, and projections reject version downgrade within a stream.
- `TaskGraphDeclared` is invalid under v1.
- A graph snapshot is accepted only for the current non-zero plan revision and exact current plan task set.
- Duplicate task entries, duplicate prerequisites, self-dependencies, unknown tasks, missing tasks, extra tasks, and cycles fail closed.
- Total tasks and dependency edges are bounded before projection traversal.
- A plan event invalidates the previous graph until a complete snapshot for the new revision commits.
- Descendants are derived solely from the replayed graph; callers cannot supply a descendant list.
- `CancelBranch` stops only active Workers assigned to the root or transitive descendants and cancels only non-terminal tasks in that set.
- Terminal tasks remain terminal; an already-terminal root may still have active descendants that must be cancelled.
- Unrelated tasks and Workers are byte-for-byte absent from the reduction.
- All cancellation state events commit before any lifecycle effect can execute.
- No new production `RunEngine`, topology, Worker, or lifecycle call site is added.

## File map

| File | Responsibility |
|---|---|
| `crates/goose/src/agents/protocol/versioning.rs` | Read-compatible v1/v2 support and current-version constant |
| `crates/goose/src/agents/protocol/events.rs` | `TaskDependency`, v2 graph event, static limits and validation |
| `crates/goose/src/agents/protocol/mod.rs` | Public protocol exports |
| `crates/goose/src/agents/reporting/projection.rs` | Atomic graph replay, revision invalidation, cycle checks, branch query |
| `crates/goose/src/agents/reporting/mod.rs` | Topology query/error exports |
| `crates/goose/src/agents/control_plane/reducer.rs` | Exact topology-backed `CancelBranch` reduction |
| `crates/goose/src/agents/control_plane/run_engine.rs` | Materialize new commands with current protocol version |
| `crates/goose/tests/codepro_protocol_contract.rs` | v1 compatibility, v2 round trip, and version rejection |
| `crates/goose/tests/codepro_task_topology.rs` | Complete/incomplete/cyclic graph replay and deterministic descendants |
| `crates/goose/tests/codepro_cancellation_reducer.rs` | Exact branch cancellation and unrelated-branch isolation |
| `crates/goose/tests/codepro_run_engine.rs` | Branch batch commit-before-effect and v1-to-v2 continuation |
| `docs/superpowers/reports/2026-08-05-codepro-u77b-validation.md` | Full U-77b evidence and remaining graph-authoring boundary |

## Task 1: Add read-compatible protocol v2 and graph contracts

### RED contracts

- Numeric protocol versions 1 and 2 deserialize; 3 and larger fail closed.
- The existing v1 JSON fixture round-trips unchanged.
- A v2 `TaskGraphDeclared` fixture round-trips with stable snake-case names.
- The graph event under v1 is rejected.
- Empty current revision, oversized graph/edge count, duplicate entries, duplicate dependencies, and self-dependency are rejected before replay.

### Implementation

- Keep `ProtocolVersion::V1`; add `V2` and `CURRENT` with `CURRENT_PROTOCOL_VERSION = 2`.
- Add ordering so replay can enforce non-decreasing versions.
- Add `TaskDependency` and `TaskGraphDeclared` without changing v1 payload shapes.
- Bound graph entries with the existing protocol list limit and introduce a bounded total-edge limit.
- Keep legacy activity conversion explicitly on v1.

### Verification and commit

Run protocol contracts and legacy migration/store tests. Commit:

```text
feat: add CodePro v2 task graph protocol
```

## Task 2: Replay and query authoritative topology

### RED contracts

- A v1-only stream still rebuilds with topology unavailable.
- A complete v2 snapshot for the current plan revision produces deterministic direct dependencies and transitive branch membership.
- A new plan revision clears the previous graph until its own snapshot arrives.
- Plan/task-set mismatch, unknown references, cross-run-by-absence references, and cycles reject the event without mutating the prior projection.
- A v2-to-v1 event downgrade rejects replay.
- Branch traversal order is stable regardless of input edge order.

### Implementation

- Persist current plan task IDs, graph revision, dependency map, and highest stream protocol version in `RunProjection`; add Serde defaults for compatibility with older serialized projections.
- Apply graph changes transactionally: validate a candidate clone before assigning it.
- Detect cycles deterministically with a bounded Kahn traversal.
- Expose a read-only `branch_task_ids(root)` query returning a sorted root-plus-descendants set and a typed topology error.

### Verification and commit

Run topology, projection replay, reconciliation, and event-store suites. Commit:

```text
feat: replay authoritative CodePro task topology
```

## Task 3: Reduce branch cancellation exactly

### RED contracts

For a graph `root -> child -> grandchild` plus independent `other`:

- cancelling `root` emits `Stopping` only for active Workers assigned inside that branch;
- it emits `Cancelled` only for non-terminal tasks in that branch;
- it does not emit any event or effect for `other`;
- each Worker stop effect is authorized by its own committed `AgentStateChanged -> Stopping` event;
- terminal branch tasks are preserved while their live descendants are still cancelled;
- missing topology, unknown root, terminal run, and a branch with no cancellable task or stoppable Worker fail closed;
- a forged effect or caller-supplied unrelated Agent cannot pass reduction validation.

### Implementation

- Replace unconditional `BranchTopologyUnavailable` with `cancel_branch` using `RunProjection::branch_task_ids`.
- Emit Agent stopping intents first in deterministic Agent ID order, then task cancellation intents in deterministic Task ID order.
- Bind one cooperative `StopWorkers` effect per active Agent to that Agent's committed stopping event. This also safely handles an inconsistent live Worker attached to an already-terminal task.
- Keep task transitions effect-free when no Worker is active.
- Extend RunEngine integration coverage to prove the complete multi-event batch commits before any effect is returned and that a v1 stream continues with v2 events.

### Verification and commit

Run cancellation reducer, RunEngine, projection, protocol, registry, and lifecycle suites. Commit:

```text
feat: cancel CodePro task branches from replayed topology
```

## Task 4: Validate and close full U-77b control-plane acceptance

Run fresh gates:

```powershell
cargo fmt --all -- --check
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_task_topology --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_projection_replay --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_cancellation_reducer --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_run_engine --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_worker_registry --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_worker_lifecycle --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose codepro_ --lib --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1 --no-fail-fast
```

Run all four desktop non-regression gates. Audit production call sites, dependency/lockfile changes, file sizes, new warnings, and preserved `documentation/` changes.

The report may mark full U-77b control-plane behavior as passing only if exact branch cancellation and mixed v1/v2 replay pass. It must still state that Planner/Scheduler graph authoring and production cutover remain U-77d/U-78 work.

Commit:

```text
docs: record full CodePro U-77b validation
```

## Deferred intentionally

- U-77c: Worker outcome reduction, failure classification, bounded infrastructure retry, ready-task scheduling, and committed-effect dispatch.
- Remaining U-77d: plan/task graph authoring commands, readiness convergence, write ownership, and legacy Scheduler/Worker adapters.
- U-78+: Coordinator decisions, shadow/advisory/authoritative rollout, desktop controls, recovery UX, evaluation, and Windows RC qualification.
