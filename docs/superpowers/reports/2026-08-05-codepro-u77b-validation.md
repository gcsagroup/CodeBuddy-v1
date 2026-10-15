# CodePro U-77b Full Validation Report

**Date:** 2026-08-05  
**Baseline:** `b679ad8f1` (`docs: plan CodePro task topology and branch cancellation`)  
**Validated HEAD:** `10571bc0f`  
**Gate:** `U-77b control-plane behavior: PASS`

## Decision

Full U-77b control-plane behavior passes. Direct Worker stop, task cancellation, topology-backed branch cancellation, emergency stop, generation-safe runtime ownership, late-result suppression, bounded cooperative-to-forceful shutdown, and real Windows process-tree cleanup now have deterministic contracts and fresh evidence.

The earlier branch blocker is resolved by an additive protocol v2 task-graph snapshot. v1 is still readable and unchanged. A v1 stream without authoritative graph data rejects `CancelBranch` with `BranchTopologyUnavailable`; it never guesses descendants. A complete v2 graph derives the exact root-plus-transitive-descendant set and leaves unrelated branches untouched.

This is not a production rollout. No production code constructs or invokes the new `RunEngine`, `WorkerRegistry`, or `LifecycleController`, and the legacy Scheduler does not yet author v2 graph snapshots. Planner/Scheduler graph authoring remains U-77d work, while live effect dispatch remains U-77c work.

## Delivered topology commits

| Commit | Scope |
|---|---|
| `4fced79ca` | Read-compatible protocol v2 and bounded atomic task-graph contract |
| `f8a04da5d` | Transactional graph replay, revision invalidation, cycle rejection, and branch query |
| `10571bc0f` | Exact graph-derived branch cancellation and mixed v1/v2 RunEngine evidence |

The direct lifecycle implementation and its four commits were previously validated in `2026-08-05-codepro-u77b1-validation.md`.

## Protocol and compatibility evidence

- `ProtocolVersion` accepts versions 1 and 2 and rejects unknown versions.
- Existing v1 JSON fixtures round-trip unchanged, and legacy activity conversion remains explicitly v1.
- New RunEngine events use the current v2 envelope; existing v1 streams continue by appending non-decreasing v2 events.
- A stream rejects protocol downgrade from v2 to v1.
- `TaskGraphDeclared` is valid only under v2 and is plan-scoped rather than attached to v1 `TaskCreated`.
- Graph input is bounded to 128 task entries, 128 prerequisites per task, and 512 total edges.
- Duplicate task entries, duplicate edges, self-dependencies, and zero revisions fail during protocol validation.

No dependency or lockfile changed for the topology slice.

## Authoritative graph evidence

Each graph snapshot names every task in the current plan exactly once, including roots with an empty prerequisite list. Projection acceptance requires:

- the graph revision equals the current non-zero plan revision;
- its task set exactly equals the current plan task set;
- every graph task and prerequisite exists in the current run projection;
- the graph is acyclic;
- the plan revision has not already accepted another graph snapshot.

Validation occurs against a candidate graph before assignment. An incomplete, foreign-by-absence, cyclic, repeated, or otherwise invalid snapshot leaves sequence, version, revision, and the previous graph unchanged. A new `PlanRevised` event invalidates the old graph until one complete snapshot for the new revision commits.

Branch traversal reverses the replayed `depends_on` edges and returns a stable, sorted root-plus-descendant set. Input edge order does not affect the projected graph or result.

## Exact branch cancellation evidence

The acceptance fixture contains:

```text
completed root -> running child -> ready grandchild
independent running task
```

Cancelling the root:

- preserves the completed root;
- emits `AgentStateChanged -> Stopping` only for the child Worker;
- emits `TaskStateChanged -> Cancelled` only for the running child and ready grandchild;
- emits no event or effect for the independent task or Worker;
- binds each Worker stop effect to that exact Worker's committed stopping event;
- rejects an unknown root, missing topology, a terminal run, and a branch with no active Worker or non-terminal task.

The RunEngine integration starts from a v1 stream, replays a v2 graph, commits the complete three-event branch cancellation batch at sequences 12–14, and only then returns the effect bound to committed sequence 12. Reloaded persisted events rebuild the same projection.

## Lifecycle and enforcement evidence

The U-77b1 guarantees remain in force:

- host-owned, generation-scoped Worker handles and cancellation tokens;
- stale generation and late-outcome suppression;
- cooperative cancellation followed by bounded escalation;
- fresh process-ID re-read after the grace period;
- emergency coverage of every actually registered live Worker in the run;
- direct `taskkill.exe /PID <pid> /T /F` execution without a shell;
- one held Windows process handle across probe, termination, and confirmation;
- partial cleanup receipts remain `confirmed_stopped = false` and registry state remains `Stopping`.

## Fresh validation evidence

### Rust focused gates

| Gate | Result |
|---|---:|
| `cargo fmt --all -- --check` | PASS |
| `codepro_protocol_contract` | 7 passed |
| `codepro_task_topology` | 6 passed |
| `codepro_projection_replay` | 8 passed |
| `codepro_cancellation_reducer` | 6 passed |
| `codepro_run_engine` | 7 passed |
| `codepro_worker_registry` | 4 passed |
| `codepro_worker_lifecycle` | 7 passed |
| CodePro-filtered lib tests | 161 passed |
| Full `goose --lib` | 2004 passed |

### Desktop non-regression gates

| Gate | Result |
|---|---:|
| `pnpm run typecheck` | PASS |
| `pnpm run test:run` | 941 passed, 4 skipped |
| `pnpm run lint:check` | PASS; 15 locales, 1935 messages validated |
| `pnpm run test:distribution` | 31 passed |

### Warnings

Eight pre-existing dead-code warnings remain in `crates/goose/src/github_auth/credential_store.rs`. The topology and branch-cancellation slice introduced no new compiler warning or test failure.

## Scope and safety audit

- Repository search found no production construction or invocation of `RunEngine`, `WorkerRegistry`, or `LifecycleController`.
- The only source references to `TaskGraphDeclared` and `branch_task_ids` are inside protocol, projection, and reducer modules.
- No new crate was added and `Cargo.lock` did not change.
- Every touched implementation and test file remains below 800 lines; the largest is `codepro_cancellation_reducer.rs` at 785 lines.
- At validation time, `git status --porcelain` contained 99 entries, all under `documentation/`. They are user-owned and were neither staged nor modified by this slice.

## Remaining production boundary

U-77b now proves the control-plane semantics, but a real user cannot trigger this path yet. Before rollout:

1. U-77c must reduce Worker outcomes and dispatch only effects returned by a successful `RunEngine::apply` receipt.
2. U-77d must provide validated plan/task graph authoring, readiness convergence, write ownership, and legacy Scheduler/Worker adapters.
3. U-78 must run the new path in shadow mode and compare it with the existing runtime before any authoritative cutover.

The public `CommittedControlEffect` Rust type is still forgeable by trusted host code; provenance becomes an enforceable runtime boundary only when the U-77c dispatcher accepts effects directly from `CommandReceipt` rather than arbitrary callers.

## Conclusion

`U-77b control-plane behavior: PASS`. Exact branch cancellation is no longer blocked. The next implementation slice is U-77c Worker outcomes, failure policy, retries, and commit-bound effect dispatch; production availability remains explicitly false.
