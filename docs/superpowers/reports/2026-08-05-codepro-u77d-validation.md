# CodePro U-77d Validation Report

**Date:** 2026-08-05
**Verdict:** PASS for U-77d convergence and legacy-adapter scope. Coordinator authority rollout remains prohibited until U-78.

## Delivered

- A bounded `task_graph` domain layer with deterministic dependency ordering, size limits, duplicate/self/unknown dependency rejection, cycle detection, and monotonic plan-revision validation.
- Conservative write-ownership validation for concurrently runnable tasks, including Windows separator/case normalization and fail-closed wildcard prefix handling.
- A host-owned convergence engine that discovers dependency-ready tasks without dispatching them and distinguishes `InProgress`, `Blocked`, and `Eligible` outcomes.
- Completion gates for goal evidence, required task evidence, Reviewer blockers, unresolved high-risk writes, uncertain effects, task terminal state, and explicit final-report coverage.
- A compatibility adapter that validates legacy topology and explicit write ownership, rejects premature `Ready`, and is the only new component allowed to promote legacy `Pending` tasks.
- A restricted `TaskScheduler` that consumes only explicit `Ready` tasks. Tasks waiting only for a concurrency slot remain `Ready`; dependency-incomplete tasks remain `Pending`.
- A convergence-aware report entry point that marks non-eligible output as an execution snapshot rather than successful completion.

## Safety invariants verified

| Invariant | Evidence |
|---|---|
| Dependency readiness is deterministic | root, chain, join, stable-order, missing-state, and legacy promotion tests |
| Invalid task topology cannot dispatch | duplicate task/edge, unknown dependency, self-edge, cycle, and premature-Ready rejection |
| Concurrent writers cannot silently overlap | exact, nested, Windows case/separator, root wildcard, and middle-wildcard tests |
| Ordered tasks may reuse a write area | ownership test with an explicit dependency order |
| Scheduler does not infer readiness | pending-only batch is empty until `LegacyReadyAdapter` promotes tasks |
| Action limits never mean success | paused-task convergence test returns `Blocked` |
| Done tasks alone do not mean success | missing goal/task evidence and open-risk tests remain `Blocked` |
| Report cannot override the host verdict | blocked report is explicitly labeled a snapshot, not a successful run |

## Verification

All Rust verification used `CARGO_INCREMENTAL=0`, disabled test-package debug info, and one job to remain within the Windows memory envelope.

| Gate | Result |
|---|---:|
| 15 focused control-plane test binaries | PASS; 75 tests |
| Task-graph adversarial suite (included above) | PASS; 5 tests |
| Legacy `TaskDAG` unit suite | PASS; 35 tests |
| Scheduler Ready/parallelism regression tests | PASS; 2 tests |
| CodePro Goose library filter | PASS; 161 tests |
| Full Goose library | PASS; 2004 tests |
| `cargo fmt --all -- --check` | PASS |
| Desktop TypeScript | PASS |
| Desktop Vitest | PASS; 941 passed, 4 skipped |
| Desktop lint and i18n | PASS; 15 locales, 1935 messages |
| Desktop distribution | PASS; 31 tests |

The only Rust warnings were the eight inherited dead-code warnings in `github_auth/credential_store.rs`. No dependency or lockfile changed. New production source files remain below 800 lines.

## Review findings resolved

1. The pre-U-77d audit found that U-77c allowed three infrastructure retries while both the design and roadmap require at most two. The policy, regression test, and U-77c report were corrected in commit `9c2c1113d` before adapter work continued.
2. The first compatibility adapter called the entire legacy DAG semantic validator. That made readiness promotion responsible for unrelated task-deduplication policy and broke valid scheduler fixtures. The adapter was narrowed to topology, readiness, and ownership only; the planning boundary retains full semantic validation.
3. Unselected tasks were initially expected to return to `Pending`. The tests were corrected to preserve `Ready`, accurately distinguishing dependency blocking from concurrency queuing.
4. The first ownership normalizer handled `src/**` but underestimated `**` and middle wildcards. Wildcards now conservatively own their static prefix, with root wildcard owning the whole workspace.
5. The task-graph layer initially deduplicated repeated edges even though protocol v2 rejects them. Both layers now reject duplicate dependencies consistently.

## Rollout boundary

U-77d does not make the LLM Coordinator authoritative. The existing production scheduler calls a deterministic compatibility adapter between batches; it still does not consume event-backed Coordinator plan commands. The convergence-aware report API is available but is not the default legacy report path. U-78 must add validated Coordinator decisions, bounded context, event-backed plan/readiness commands, and shadow/advisory/authoritative rollout before these APIs can control production semantics.

The effect ledger remains process-local and in-memory; crash-durable recovery belongs to U-79.

## Workspace hygiene

Pre-existing user-owned changes under `documentation/` were not modified, staged, or committed. U-77d changed only Goose source/tests and `docs/superpowers` planning/report files.

## Next step

Proceed to U-78: bounded Coordinator context and decision schema first, followed by shadow-mode comparison against the compatibility path. No authoritative Coordinator execution should be enabled until capability and rollback gates pass.
