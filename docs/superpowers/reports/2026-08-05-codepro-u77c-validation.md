# CodePro U-77c Worker Outcomes and Committed-Effect Dispatch Validation

**Date:** 2026-08-05  
**Verdict:** PASS for the isolated U-77c control-plane slice. Production cutover remains prohibited until U-77d adapters and convergence are complete.

## Delivered

- Protocol-v2 `WorkerOutcomeAccepted` and `TaskRetryScheduled` facts with strict scope, evidence, failure-class, attempt, and delay validation.
- Replayable latest Worker outcome and authoritative per-task retry count.
- Pure outcome adjudication: success, semantic failure, permission/policy block, assistance, checkpoint pause, cancellation, and transient infrastructure retry.
- Fixed host retry policy: only `TransientInfrastructure`, at most two retries, with 250/500 ms backoff.
- Generation-bound outcome claim, release, and finalize lifecycle using `CommittingOutcome`.
- `OutcomeIngress` that loads authoritative state, claims the exact Worker generation, commits through `RunEngine`, releases on pre-commit failure, and synchronizes runtime state only after commit.
- Read-only `CommandReceipt` fields and a dispatcher that accepts only a genuine RunEngine receipt.
- Idempotent effect claims with explicit completed/in-flight states and retryable release after executor failure.
- Run-scoped ledger identity (`run_id + effect_id`) so equal event sequences in different Runs never collide.

## Architecture invariants proved

| Invariant | Evidence |
|---|---|
| A Worker result cannot directly mutate task truth | Reducer first records `WorkerOutcomeAccepted`; only later reducer events change task/Agent state |
| Stale or replaced Workers cannot commit | generation claim and stale-generation ingress tests |
| Cancellation can beat an uncommitted outcome | `CommittingOutcome -> Stopping` race test; finalize then fails closed |
| Semantic failures are not blindly retried | validation/implementation and all non-transient classes route to Coordinator or approval |
| Retry count survives restart | `TaskRetryScheduled` replay requires monotonic attempt numbers |
| Events commit before effects become visible | RunEngine transient-outcome integration test commits the complete six-event batch before returning `RetryTask` |
| Uncommitted or mutated effect lists cannot enter dispatcher | `CommandReceipt` fields are private and dispatcher accepts only `&CommandReceipt` |
| Same effect replay is idempotent | completed-ledger replay test invokes executor once |
| Executor failure remains retryable | failure releases its claim; the next dispatch executes once |
| Concurrent dispatch does not duplicate work | in-flight claim test rejects the second dispatch |
| Different Runs cannot suppress each other | shared-ledger cross-Run regression test |

## Fresh verification

| Gate | Result |
|---|---:|
| `cargo fmt --all -- --check` | PASS |
| 11 focused protocol/control/Worker integration binaries | 61 passed |
| `cargo test ... -p goose codepro_ --lib --jobs 1` | 161 passed |
| `cargo test ... -p goose --lib --jobs 1 --no-fail-fast` after final cross-Run fix | 2004 passed |
| Desktop `pnpm run typecheck` | PASS |
| Desktop `pnpm run test:run` | 941 passed, 4 skipped |
| Desktop `pnpm run lint:check` | PASS; 15 locales and 1935 messages validated |
| Desktop `pnpm run test:distribution` | 31 passed |

All Rust verification used `CARGO_INCREMENTAL=0`, disabled test-package debug info, and one job to stay within the Windows memory envelope.

## Review findings resolved during validation

The first dispatcher implementation used the local effect string (`effect:<sequence>:<index>`) directly as its ledger key. Two Runs can have the same sequence, so a global ledger could suppress valid work in a second Run. A RED cross-Run test reproduced this. Commit `b62b8b978` scopes the ledger key by Run and the final 61 focused plus 2004 library tests were rerun after the fix.

## Audit

- No Cargo, pnpm lockfile, manifest, or package dependency changed in U-77c.
- No U-77c source or test file exceeds 700 lines; outcome reduction remains split from the 629-line main reducer.
- The only compiler output is the same eight inherited dead-code warnings in `github_auth/credential_store.rs`; U-77c adds no warning.
- Production-call-site search finds only protocol/reducer/ingress definitions. No desktop or legacy Agent path constructs `RunEngine`, `OutcomeIngress`, or `EffectDispatcher` yet.
- The worktree contains 99 pre-existing, user-owned changes, all under `documentation/`; none were staged or modified by this slice.

## Intentionally deferred

- U-77d: plan authoring, ready-task convergence, real Worker spawn/retry/stop executor adapters, legacy Scheduler/Worker write-ownership migration, and production call-site cutover.
- U-78: Coordinator semantic decisions and controlled shadow/advisory/authoritative rollout.
- U-79: crash-durable effect ledger/recovery. The U-77c in-memory ledger proves process-local idempotency only and is not presented as crash-safe exactly-once execution.
- U-80+: desktop control/recovery UX, evaluations, and Windows RC qualification.
