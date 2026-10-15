# CodePro U-77a RunEngine Validation Report

**Date:** 2026-08-05
**Baseline:** `ac95dd397` (`docs: record CodePro U-76 G1 validation`)
**Validated HEAD:** `abed711b7`
**Gate:** `U-77a: PASS`

## Decision

U-77a passes its validation gate. CodePro now has a typed control-command boundary, a deterministic pure reducer, and a Rust `RunEngine` that durably commits validated v1 events before it exposes any effect to a caller.

This is an additive control-plane foundation, not a production cutover. No production code constructs or invokes `RunEngine`, no effect executor exists, and the legacy Scheduler remains the active runtime path. U-77b and later slices must complete Worker lifecycle, cancellation, failure policy, dispatch, task-graph convergence, and controlled rollout before the new control plane can own live work.

## Delivered commits

| Commit | Scope |
|---|---|
| `d23560807` | Detailed U-77a reducer/RunEngine plan and non-negotiable ordering constraints |
| `155e47457` | Stable command kind/run identity and fail-closed boundary validation |
| `ae8a3a1ad` | Pure command reducer, typed event/effect intents, and reducer invariants |
| `abed711b7` | Durable RunEngine pipeline, deterministic identity materialization, preview replay, and commit-bound effects |

No Cargo dependency or lockfile changed between the U-77a plan and validated HEAD.

## Command support matrix

| Command | U-77a behavior | Next owner |
|---|---|---|
| `StartRun` | Supported; an empty stream emits `RunStarted` and no effect | U-77a |
| `StartTask` | Supported only for a known `Ready` task in a `Running` run; emits `Ready -> Running` plus `DispatchTask` | U-77a |
| `PauseRun` | Supported when the frozen v1 state machine permits transition to `Paused`; emits `RunPaused` plus `PauseScheduling` | U-77a |
| `ResumeRun` | Supported only from `Paused`; emits `Paused -> Recovering` plus `RecoverRun` | U-77a |
| `RevisePlan` | Typed `DeferredCommand` rejection; no append | U-77d |
| `StopWorker` | Typed `DeferredCommand` rejection; no append | U-77b |
| `CancelTask` | Typed `DeferredCommand` rejection; no append | U-77b |
| `CancelBranch` | Typed `DeferredCommand` rejection; no append | U-77b |
| `EmergencyStop` | Typed `DeferredCommand` rejection; no append | U-77b |
| `SubmitWorkerOutcome` | Typed `DeferredCommand` rejection; no append | U-77c |
| `ApplyCoordinatorDecision` | Typed `DeferredCommand` rejection; no append | U-78 |

The reducer rejects duplicate starts, missing streams, cross-run commands, unknown tasks, non-ready tasks, non-running task starts, illegal pause/resume transitions, empty reductions, invalid effect indices, and effect/event scope mismatches. It reads no clock, store, process, tool, or network state.

## Commit-before-effect evidence

`RunEngine::apply` performs these operations in order:

1. Validate the command and obtain its authoritative `RunId`.
2. Load the committed stream and rebuild the current projection.
3. Run the pure reducer.
4. Materialize contiguous, versioned `RunEvent` values using one clock reading.
5. Validate every event and preview-apply the complete batch to a disposable projection.
6. Append with the previously observed sequence as the optimistic concurrency boundary.
7. Verify that `AppendReceipt` describes exactly the proposed batch.
8. Bind effect IDs and trigger event IDs, then return the receipt.

Tests prove reducer and projection rejection never call `append`. An append sequence conflict returns `RunEngineError::Store`, leaves the test store unchanged, and returns no `CommandReceipt`. A store that commits but returns an inconsistent receipt is rejected with `RunEngineError::Invariant` before effect binding; the next host action must recover from the authoritative stream rather than assume success.

## Identity, restart, and replay evidence

- Event sequences are contiguous from the loaded projection's `last_sequence`.
- The default event ID is `event:<sequence>`.
- If that ID already exists, collision resolution deterministically tries `event:<sequence>:1`, then increasing suffixes.
- All events in one command batch share the first event ID as `correlation_id` and one timestamp from a single clock read.
- Within a multi-event batch, each event after the first is caused by the preceding event; the first references the previously committed event when one exists.
- Effect IDs are `effect:<trigger_sequence>:<effect_index>` and carry the exact committed trigger `EventId`.
- A new `RunEngine` instance continues from a file store written by an earlier instance.
- The returned projection equals a fresh `RunProjection::rebuild` from reloaded committed events.

The collision fixture deliberately stores `event:5` at sequence 4. `StartTask` then commits sequence 5 as `event:5:1`, and its `DispatchTask` effect is bound to that committed ID.

## Fresh validation evidence

### Rust focused gates

| Gate | Result |
|---|---:|
| `cargo fmt --all -- --check` | PASS |
| `codepro_control_command` | 3 passed |
| `codepro_control_reducer` | 4 passed |
| `codepro_run_engine` | 5 passed |
| `codepro_run_event_store` | 13 passed |
| `codepro_projection_replay` | 8 passed |
| `codepro_protocol_contract` | 6 passed |
| CodePro-filtered lib tests | 161 passed |
| Full `goose --lib` | 2004 passed |

### Desktop gates

| Gate | Result |
|---|---:|
| `pnpm run typecheck` | PASS |
| `pnpm run test:run` | 941 passed, 4 skipped |
| `pnpm run lint:check` | PASS; 15 locales, 1935 messages validated |
| `pnpm run test:distribution` | 31 passed |

### Warnings

Eight pre-existing dead-code warnings remain in `crates/goose/src/github_auth/credential_store.rs`. U-77a introduced no new compiler warning and no test failure.

## Scope and safety audit

- Repository search found no production `RunEngine::new` or `.apply(ControlCommand...)` call site under `crates/goose/src`.
- `RunEngine` exposes no raw event-store accessor and executes no `ControlEffect`.
- The Coordinator, Worker, desktop UI, and legacy Scheduler do not receive an append handle.
- All new implementation and test files are below the 800-line project limit.
- No dependency was added.
- At validation time, `git status --porcelain` contained 99 entries, all under `documentation/`. These are pre-existing user-owned changes and were neither staged nor modified by U-77a.

## Remaining risks and next slice

- `DispatchTask`, `PauseScheduling`, and `RecoverRun` are durable effect descriptions only; nothing executes them yet.
- U-77b must add host-owned Worker handles, cooperative cancellation tokens, bounded stop escalation, Windows process-tree cleanup, cancellation event semantics, and late-result suppression.
- U-77c must add Worker outcome reduction, typed failure classification, bounded infrastructure retries, and an effect dispatcher that remains subordinate to committed events.
- U-77d must add task creation/revision, dependency and write-ownership validation, convergence rules, and legacy Scheduler adapters.
- U-78 must add Coordinator decisions and shadow-mode production wiring before any source-of-truth cutover.
- Desktop pause/cancel/emergency controls and recovery views remain deferred to U-81.

## Conclusion

`U-77a: PASS`. The next authorized implementation slice is U-77b Worker lifecycle and cancellation. Production routing through the new RunEngine remains prohibited until later shadow-equivalence and rollout gates pass.
