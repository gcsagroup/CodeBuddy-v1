# CodePro U-76 G1 Validation Report

**Date:** 2026-08-05
**Baseline:** `b8df41b88` (`docs: record CodePro U-75 protocol validation`)
**Validated HEAD:** `2862e0b53`
**Gate:** `G1: PASS`

## Decision

U-76 passes G1. CodePro now has a versioned, strict, replayable v1 event foundation without routing the current Scheduler production path through it. The v1 protocol, event store, recovery behavior, deterministic projections, legacy migration, bounded reconciliation artifact, corruption handling, scale gate, Rust regressions, and desktop regressions all passed.

G1 freezes the current v1 wire contract, including `RunStateChanged`. Future breaking wire changes require a new protocol version; U-77 and later work may add behavior around the contract but must not silently reinterpret committed v1 events.

## Delivered commits

| Commit | Scope |
|---|---|
| `3c5886cf9` | U-76 implementation plan and non-negotiable boundaries |
| `d115996ad` | Async `RunEventStore` and host-owned file append implementation |
| `f6b656a28` | Strict reads and explicit incomplete-tail recovery |
| `c31ada971` | Deterministic run/task/agent projections and `RunStateChanged` contract |
| `cd0b5a47f` | Deterministic legacy migration and auditable ID mappings |
| `420778faf` | Bounded status-only legacy/v1 projection reconciliation |
| `2862e0b53` | Checked-in legacy fixtures, future-version rejection, and 10,000-event gate |

Commit `98f2f2de9` (`docs: define CodeBuddy Windows beta direction`) is present between these commits but is an independent direction document produced outside U-76. It is not counted as U-76 implementation evidence and does not change runtime behavior.

## Contract and durability evidence

### Event store

- One run-scoped `events.v1.jsonl` stream per validated `RunId`.
- The host obtains a file lock before reload, optimistic sequence comparison, validation, and append.
- `expected_sequence` is the caller's last observed committed sequence; a new stream starts at `0`.
- Empty batches, stale writers, sequence gaps, cross-run events, duplicate event IDs, invalid envelopes, and unknown protocol versions fail closed before append.
- Blocking filesystem operations remain behind the async store boundary.
- A successful append flushes and calls `sync_data` before returning its receipt.

### Read and recovery semantics

- Reads are strict and never repair or truncate disk state.
- A valid final JSON record without a newline is treated as an incomplete commit, not as committed data.
- `recover_incomplete_tail` may remove only the incomplete final segment.
- Recovery refuses malformed newline-terminated records and preserves every committed byte.
- After explicit recovery, the next contiguous append succeeds from the last committed sequence.

### Projections

- `RunProjection::rebuild` deterministically derives run, task, and agent state from the stream.
- Run, task, and agent lifecycles evolve independently.
- Missing/multiple starts, wrong run, gaps, duplicate IDs, unknown task/agent references, invalid transitions, and events after a terminal run are rejected.
- Observation events advance event identity and sequence but do not mutate business state.
- A serialized projection cache can be deleted and rebuilt solely from the event stream with an identical result.

### Legacy migration

- `CodeProEventRecord -> ActivityEvent` round-trips every field represented by both schemas.
- Migration preserves run ID, task scope, sequence, and occurrence time.
- Duplicate legacy lifecycle IDs receive deterministic collision-free v1 IDs, retain the legacy ID as their shared correlation ID, and emit stable audit mappings and warnings.
- `agent_role` is never promoted into an invented `AgentId`.
- Legacy-only activity remains `LegacyActivityObserved` rather than asserting an unsupported state transition.
- Mixed runs, sequence gaps, invalid identifiers, unknown activity values, and future schema versions fail closed.

### Reconciliation

- Reconciliation contains only run ID, legacy status, projected status, and typed status differences.
- Matching `Completed`, `Failed`, and `Discarded <-> Cancelled` terminal states produce no difference.
- The report is capped at 4 KiB and atomically published as `projection-reconciliation.v1.json`.
- Tests prove the report does not read or modify `state.json` and does not contain goal, model-prompt, or command-output sentinel content.
- The method is dormant in U-76: call-site audit found only its definition and tests.

## Fresh G1 verification

### Rust focused gates

| Gate | Result |
|---|---:|
| `cargo fmt --all -- --check` | PASS |
| `codepro_protocol_contract` | 6 passed |
| `codepro_run_event_store` | 13 passed |
| `codepro_projection_replay` | 8 passed |
| `codepro_event_migration` | 5 passed |
| CodePro-filtered lib tests | 161 passed |
| Full `goose --lib` | 2004 passed |

The final 10,000-event projection measurement was `25.4788 ms` for `RunProjection::rebuild` itself. Event construction and Rust compile/link time were outside the measurement. The local gate is `< 5 seconds`.

Task-level regression evidence gathered before the final gate also passed the legacy event-log suite (8/8) and the CodePro state-store suite (5/5).

### Desktop gates

| Gate | Result |
|---|---:|
| `pnpm run typecheck` | PASS |
| `pnpm run test:run` | 941 passed, 4 skipped |
| `pnpm run lint:check` | PASS; 15 locales, 1935 messages validated |
| `pnpm run test:distribution` | 31 passed |

### Warnings

Eight existing dead-code warnings remain in `crates/goose/src/github_auth/credential_store.rs`. They were present before U-76 and are not caused by the event foundation. There were no new U-76 warnings or failures.

## Scope audit

- Runtime changes are limited to the v1 protocol event variant, event-store/migration modules, projection/reconciliation modules, and additive conversion/writer methods.
- Search found no production construction or invocation of `FileRunEventStore`, `migrate_legacy_records`, `RunProjection::rebuild`, or `record_projection_reconciliation` outside their definitions; U-76 does not change current Scheduler behavior or desktop behavior.
- At validation time, `git status --porcelain` contained 99 entries, all under `documentation/`. These are pre-existing user-owned changes and were neither staged nor modified by U-76.

## Remaining risks and deferred work

- U-77 must add command validation, reducers, the Rust `RunEngine`, worker lifecycle, cancellation, failure policy, and effect execution.
- U-78 must shadow the current Scheduler with live event writes and reconciliation before any source-of-truth cutover.
- Reconciliation currently records status parity only; task/agent/evidence parity belongs to the shadow rollout after live data exists.
- Existing user sessions are not bulk-migrated in U-76; U-82 owns migration, interrupted-side-effect recovery, and rollback qualification.
- U-76 does not perform a real Windows installer install/uninstall or update test. Those are RC gates, not G1 event-foundation gates.
- Automatic updates remain disabled until signing, trusted-feed verification, migration, and rollback requirements are satisfied.

## G1 conclusion

`G1: PASS`. U-77 may build the authoritative Rust control plane on this frozen v1 event foundation. Production cutover remains prohibited until U-78 shadow equivalence and later rollout gates pass.
