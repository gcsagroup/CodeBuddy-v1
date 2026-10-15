# CodePro U-77c Worker Outcomes and Committed-Effect Dispatch Plan

> **Execution rule:** implement every behavior with RED -> GREEN -> REFACTOR, commit each task atomically, and preserve all user-owned `documentation/` changes.

**Goal:** Make the Control Plane the sole authority that accepts Worker outcomes, classifies failures, schedules bounded infrastructure retries, and exposes external work only after its authorizing events commit.

**Architecture:** A Worker may report evidence but may not mutate task truth. A generation-bound outcome ingress claims the current `WorkerHandle`, reloads the authoritative projection, and submits `SubmitWorkerOutcome` through `RunEngine`. The pure reducer converts the outcome to events. Mechanical transient failures use a deterministic host policy; semantic failures wake the Coordinator. A committed-effect dispatcher accepts only `CommandReceipt`, claims each effect ID in an idempotency ledger, and delegates execution. Actual legacy Scheduler/Worker cutover remains U-77d.

## Non-negotiable invariants

- A stale, stopping, terminal, unknown, cross-run, or wrong-task Worker cannot commit an outcome.
- An accepted outcome is durably recorded before task/Agent state derived from it.
- Worker success is evidence, not direct authority; only reducer-emitted `TaskSucceeded` makes success authoritative.
- Validation, implementation, permission, policy, context, budget, no-progress, environment, and unknown failures are never blindly retried.
- Only `TransientInfrastructure` receives deterministic exponential backoff, with an authoritative attempt count and a fixed safety cap.
- Retry exhaustion moves the task to `WaitingForCoordinator`; it does not forge terminal failure.
- Cancellation and outcome submission are ordered by the event store; a losing command fails closed.
- No external effect is executable from an uncommitted `EffectIntent` or caller-forged batch.
- Effect execution is idempotent within the configured ledger. Crash-durable effect recovery is explicitly deferred to U-79.
- No production cutover to the new engine occurs in U-77c.

## Task 1: Persist Worker outcome and retry facts

- Add protocol-v2 `WorkerOutcomeAccepted` and `TaskRetryScheduled` events with strict scope and numeric validation.
- Extend projections with latest accepted outcomes and per-task retry attempts.
- Prove replay, round trip, ordering, and malformed event rejection.
- Commit: `feat: persist CodePro worker outcomes and retries`.

## Task 2: Reduce outcomes with deterministic failure policy

- Add a pure `FailurePolicy` with a bounded transient retry cap and exponential delays.
- Implement `SubmitWorkerOutcome` preconditions for exact task/Agent scope and active states.
- Map success, retry, semantic failure, assistance, pause, block, and cancellation to valid event sequences and effects.
- Prove semantic failures wait for Coordinator while transient failures alone return to `Ready`.
- Commit: `feat: adjudicate CodePro worker outcomes`.

## Task 3: Make outcome ingress generation-safe

- Add an atomic `CommittingOutcome` Worker runtime state and claim/release/finalize operations.
- Add read-only projection loading to `RunEngine`.
- Build an ingress that claims the exact Worker generation, applies the command, releases on pre-commit failure, and terminalizes only after commit.
- Prove stale generations, duplicate outcomes, stop races, and post-commit runtime-finalization behavior.
- Commit: `feat: guard CodePro outcome ingress by worker generation`.

## Task 4: Dispatch committed effects idempotently

- Make `CommandReceipt` expose read-only accessors and remain the only dispatcher input.
- Add an effect executor trait, claim/complete/release ledger contract, and in-memory reference ledger.
- Prove forged intents cannot enter the dispatcher, successful effects deduplicate, and failed effects can retry.
- Keep actual Worker spawning, ready-DAG convergence, and legacy adapters deferred to U-77d.
- Commit: `feat: dispatch committed CodePro effects idempotently`.

## Task 5: Validate and close U-77c

- Run focused protocol/projection/reducer/engine/registry/ingress/dispatcher tests.
- Run full Goose library and desktop non-regression gates with the low-memory Rust profile.
- Audit production call sites, dependency changes, warnings, file sizes, and preserved user changes.
- Record evidence in `docs/superpowers/reports/2026-08-05-codepro-u77c-validation.md`.
- Commit: `docs: record CodePro U-77c validation`.

