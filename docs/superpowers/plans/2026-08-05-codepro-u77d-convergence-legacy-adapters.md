# CodePro U-77d Convergence and Legacy Adapters Implementation Plan

**Date:** 2026-08-05
**Status:** Complete
**Depends on:** U-77a, U-77b, U-77c

## Objective

Move task readiness and run-completion judgment out of the legacy scheduler without breaking the existing CodePro production path. The Rust host remains the semantic safety boundary: task dependency readiness is deterministic, completion requires evidence and absence of unresolved risk, and an action/budget limit can only pause or block a run.

## Non-goals

- Do not enable an LLM Coordinator in production; that is U-78.
- Do not delete `TaskScheduler`, `TaskDAG`, or the existing result pipeline.
- Do not claim crash-durable effect execution; that is U-79.
- Do not let the compatibility adapter become a second source of truth after authoritative rollout.

## Decisions

1. Introduce a small `task_graph` domain layer with graph validation, revision validation, and write-ownership conflict detection.
2. Readiness is a two-step contract: convergence discovers dependency-satisfied task IDs; an authority adapter explicitly promotes them to `Ready`. `TaskScheduler` may execute only tasks already in `Ready`.
3. During the compatibility phase, `LegacyReadyAdapter` is the only component allowed to promote legacy DAG tasks. It is called at the production boundary and after each committed legacy batch. U-78 will replace this adapter with event-backed commands.
4. Run completion is conservative. All required tasks must be successful; required task results and goal coverage must have evidence; reviewer blockers, high-risk writes, and uncertain effects must be empty; and the final report must explicitly cover completed, discovered, incomplete, and unverified work.
5. Paused/action-limited tasks, elapsed time, token exhaustion, and retry exhaustion never count as success.
6. Existing reporting remains available, but receives a convergence assessment so it cannot label an evidence-incomplete run as passed.

## Work packages

### 1. Task graph domain

Create:

- `crates/goose/src/agents/task_graph/mod.rs`
- `graph.rs`: immutable task/dependency view and deterministic ready/branch queries.
- `validation.rs`: duplicate ID, unknown dependency, self-dependency, cycle, and size checks.
- `ownership.rs`: normalize write scopes and reject concurrently runnable overlapping writers.
- `revision.rs`: enforce initial revision 1 and monotonic one-step revisions.

Tests must cover roots, joins, deterministic ordering, cycles, missing dependencies, revision gaps, and overlapping ownership with and without dependency ordering.

### 2. Host convergence engine

Create `control_plane/convergence.rs` with:

- deterministic ready-task discovery from the authoritative projection;
- explicit completion requirements and typed blockers;
- conservative `InProgress`, `Blocked`, and `Eligible` assessments;
- no inference of success from action limits or resource ceilings.

Tests must prove that missing evidence, unresolved reviewer findings, high-risk writes, uncertain effects, paused tasks, and incomplete report sections all prevent completion.

### 3. Legacy DAG compatibility boundary

Adapt `task_dag.rs` so:

- dependency-satisfied `Pending` tasks are discoverable but are not returned as scheduler-ready;
- only `Ready` tasks are returned to the scheduler;
- state promotion is an explicit checked operation.

Add a legacy adapter that validates the DAG through `task_graph`, promotes only dependency-satisfied tasks, and rejects invalid topology or write ownership.

### 4. Scheduler restriction

Adapt `task_scheduler.rs` so `begin_next_batch` rejects or ignores every state except `Ready`. Remove its direct dependency calculation. Use the legacy adapter between batches while the old production path is active.

### 5. Result boundary

Adapt `result_aggregator.rs`/run result classification to accept a convergence verdict. A legacy `Done` count or action-budget exhaustion must not produce a successful final classification without evidence coverage and cleared risks.

### 6. Verification and review

Run focused graph/convergence/adapter/scheduler/report tests, the CodePro Rust suite, full Goose library tests, formatting, desktop typecheck/Vitest/lint/i18n, and distribution tests. Record findings and rollback notes in a U-77d validation report.

## Rollback

The new graph and convergence modules are additive. Compatibility behavior can be rolled back by restoring the old `TaskDAG::ready_tasks` implementation and removing the boundary adapter call. No event schema or persisted session format is removed in this slice.

## Exit criteria

- Invalid topology and unsafe concurrent write ownership fail closed before dispatch.
- Scheduler inputs contain only explicitly `Ready` tasks.
- Dependency joins become Ready only after every prerequisite succeeds.
- Evidence/risk convergence is deterministic and tested.
- Paused/action-limited work never converges to success.
- Existing CodePro behavior remains available through the isolated compatibility adapter.
