# CodePro U-77b1 Worker Lifecycle Validation Report

**Date:** 2026-08-05  
**Baseline:** `8623c0722` (`docs: plan CodePro U-77b worker lifecycle`)  
**Validated HEAD:** `16751d477`  
**Direct lifecycle gate:** `U-77b1: PASS`  
**Full U-77b gate:** `OPEN — CancelBranch requires authoritative task topology`

## Decision

U-77b1 passes for direct Worker stop, task cancellation, emergency stop, generation-safe host ownership, late-result suppression, bounded shutdown escalation, and Windows descendant-process cleanup.

Full U-77b does not pass yet. The frozen v1 task event stream contains no dependency edges, so `CancelBranch` cannot derive descendants authoritatively. It remains a typed `BranchTopologyUnavailable` rejection that appends nothing. The task-topology portion of U-77d must land before U-77c dispatch wiring, after which branch cancellation will be completed and revalidated.

This is still an additive control-plane implementation. The legacy Scheduler remains the production runtime, and repository search found no production construction or invocation of `RunEngine`, `WorkerRegistry`, or `LifecycleController`.

## Delivered commits

| Commit | Scope |
|---|---|
| `4e8aa9917` | Deterministic stop-worker, cancel-task, and emergency-stop event/effect reductions |
| `a5962d7f9` | Opaque generation-scoped Worker handles, host registry, and outcome admission |
| `43cf6fe0f` | Bounded Windows process-tree termination with real parent/child fixture |
| `16751d477` | Cooperative cancellation, timeout escalation, forced cleanup, and typed receipts |

## Control and ordering evidence

- `StopWorker` commits the Agent `Stopping` transition and, for a running owned task, `WaitingForCoordinator` before returning a cooperative stop effect.
- `CancelTask` commits every assigned active Agent to `Stopping`, then commits the task as `Cancelled`, before returning a stop effect.
- `EmergencyStop` commits all transitionable Agents to `Stopping`, all non-terminal tasks to `Cancelled`, and finally `RunCancelled`; only then can an immediate emergency effect be returned.
- Reducer invariants reject an effect whose Agent set does not match committed `Stopping` events.
- `RunEngine` integration proves a multi-event cancellation batch is durably appended before effects are bound or exposed.
- `CancelBranch` fails closed because no replayable dependency graph exists yet.

The lifecycle controller accepts only a `CommittedControlEffect` value. The type is not cryptographic proof of provenance; U-77c's dispatcher must consume effects directly from a successful `RunEngine::apply` receipt and must not accept caller-forged effects.

## Worker ownership and race evidence

- The host registry owns cancellation tokens, async runner abort handles, process IDs, and the current `(run, Agent, generation)` identity.
- A live generation cannot be replaced. A terminal generation can be replaced only with an incremented generation, and stale handles lose stop and outcome authority.
- Outcomes are suppressed for unknown workers, stale generations, stopping/terminal workers, terminal tasks, and run mismatches.
- Process IDs may still register while a Worker is `Stopping`, covering the spawn-before-cancel/register-after-cancel race; force escalation re-reads the process set after the grace period.
- Natural completion racing with forced abort is idempotent. A terminal state is preserved rather than overwritten.
- Emergency enforcement enumerates every live Worker currently registered for the run instead of trusting a possibly stale Agent list in the effect snapshot.

## Shutdown behavior

Normal stop first cancels the exact generation's token and waits a configurable bounded grace period. If the runner does not become terminal, the controller re-reads and terminates every registered process tree, aborts the host-owned runner, and records a typed receipt.

On Windows, process-tree cleanup:

- passes PID arguments directly to `taskkill.exe /PID <pid> /T /F` without a shell;
- hides the command window and applies a three-second timeout;
- holds one Windows process handle across status probe, termination, and confirmation to prevent PID-reuse ambiguity;
- distinguishes already-exited processes from confirmed termination;
- bounds diagnostic text to 1024 characters;
- is verified against a test-owned PowerShell parent with a child process.

If any process tree cannot be confirmed stopped, the receipt contains per-PID failure evidence and `confirmed_stopped` remains false. The registry deliberately remains `Stopping`; it does not report a false terminal success.

## Fresh validation evidence

### Rust gates

| Gate | Result |
|---|---:|
| `cargo fmt --all -- --check` | PASS |
| `codepro_cancellation_reducer` | 4 passed |
| `codepro_worker_registry` | 4 passed |
| `codepro_worker_lifecycle` | 7 passed |
| `codepro_run_engine` | 6 passed |
| CodePro-filtered lib tests | 161 passed |
| Full `goose --lib` | 2004 passed |

The lifecycle suite includes cooperative completion, virtual-time timeout escalation, fresh process snapshot use, partial cleanup evidence, emergency coverage of all registered run Workers, invalid PID handling, already-exited handling, and real Windows parent/descendant termination.

### Desktop non-regression gates

| Gate | Result |
|---|---:|
| `pnpm run typecheck` | PASS |
| `pnpm run test:run` | 941 passed, 4 skipped |
| `pnpm run lint:check` | PASS; 15 locales, 1935 messages validated |
| `pnpm run test:distribution` | 31 passed |

### Warnings and dependency audit

Eight pre-existing dead-code warnings remain in `crates/goose/src/github_auth/credential_store.rs`. U-77b1 introduced no compiler warning or test failure.

No crate was added and `Cargo.lock` did not change. The existing Windows `winapi` dependency gained only the API feature flags required for safe process-handle probing, and the existing Tokio dev-dependency gained `test-util` for deterministic paused-time tests.

## Scope and safety audit

- No production call site constructs or invokes `RunEngine`, `WorkerRegistry`, or `LifecycleController`.
- Workers and UI callers receive no event-store append handle, process-tree terminator, or runner abort handle.
- The lifecycle controller writes no protocol event; it acts only after a committed effect is supplied.
- Every touched implementation and test file remains below the 800-line project limit.
- At validation time, `git status --porcelain` contained 99 entries, all under `documentation/`. They are pre-existing user-owned changes and were neither staged nor modified by U-77b1.

## Required next slice

Before any U-77c effect dispatcher can execute live work:

1. Add a versioned, replayable task dependency contract without mutating frozen v1 semantics in place.
2. Rebuild authoritative topology from committed events and reject cycles, unknown tasks, and cross-run edges.
3. Derive exact descendants for `CancelBranch`, cancel only that branch, and prove unrelated branches remain untouched.
4. Re-run the U-77b gates and close the full branch-cancellation acceptance gate.

Only after that may U-77c bind successful `RunEngine` receipts to Worker dispatch and lifecycle effects.

## Conclusion

`U-77b1: PASS` for direct lifecycle and cancellation. `Full U-77b: OPEN` until topology-backed `CancelBranch` passes. The next authorized implementation slice is the task-topology foundation, not production dispatch.
