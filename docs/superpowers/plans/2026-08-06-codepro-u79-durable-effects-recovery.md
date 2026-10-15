# CodePro U-79 Durable Effects and Crash Recovery Plan

## Goal

Make every control-plane effect recoverable across process termination without claiming impossible exactly-once semantics. A committed event must never lose its effect, and an effect whose external outcome is unknown must never be retried automatically.

This package intentionally brings the old roadmap's U-82 recovery work forward to U-79. U-78 already enabled Coordinator-selected actions, so durable effect safety is a prerequisite for desktop cutover rather than a release-candidate cleanup.

## Safety invariants

1. The event log remains the authoritative semantic history.
2. An effect descriptor is durably prepared before its triggering event batch is appended.
3. A prepared effect becomes dispatchable only after its exact trigger event is durably present.
4. A crash before event commit leaves an abandoned prepared effect; it is never executed.
5. A crash after event commit but before outbox commit is recovered as pending.
6. A durable claim is written before executor entry.
7. Executor success is durably completed before a replay can be suppressed as successful.
8. An executor error explicitly classified as definitely-not-applied may return to pending. An unknown outcome becomes `Uncertain` and blocks automatic replay.
9. A claim left by a terminated process becomes `Uncertain` during exclusive startup recovery; elapsed time alone never authorizes takeover.
10. Corrupt, oversized, cross-Run, identity-conflicting, or unsupported ledger data fails closed.

## Non-goals

- Do not promise exactly-once execution for arbitrary operating-system or network effects.
- Do not infer success from projected task state.
- Do not automatically resolve `Uncertain` effects.
- Do not add desktop recovery controls in this package; U-81 owns that UI.
- Do not delete the in-memory ledger used by isolated unit tests.

## Design

### Durable effect journal

Add a versioned append-only `effects.v1.jsonl` journal. The first record for an effect stores both the complete committed effect and its exact trigger event. Later records store validated state transitions:

```text
Prepared -> Pending -> Claimed -> Completed
                         |  |
                         |  +-> Pending      (definitely not applied)
                         +----> Uncertain    (unknown outcome or crash)
Prepared --------------------> Abandoned    (trigger event absent)
```

Every mutation takes an exclusive file lock, replays and validates the journal, appends one newline-terminated record, flushes, and calls `sync_data`. Records are bounded and all identity fields are compared on replay.

### Transactional boundary

Extend `RunEngine` with an optional effect outbox:

1. reduce and materialize events;
2. bind effects to exact trigger events;
3. durably prepare the effect batch;
4. append and sync the event batch;
5. mark prepared effects pending;
6. return the command receipt.

The existing constructor retains a no-op outbox for compatibility. Production recovery uses the durable constructor. Any error after preparation leaves evidence for reconciliation instead of deleting ambiguous state.

### Recovery

Add `control_plane/recovery.rs` to:

- repair only an incomplete final event-log record using the existing store rule;
- load and validate the committed event stream;
- reconcile prepared effects against exact trigger events;
- turn stale claimed effects into `Uncertain` under an exclusive startup recovery operation;
- return typed `pending`, `completed`, `uncertain`, and `abandoned` collections;
- rebuild the run projection without executing effects.

Recovery is analysis and state repair only. A caller must separately dispatch returned pending effects.

## Implementation slices

### Slice 1 — Define the durable ledger contract

- Add typed effect states, execution-outcome classification, inspection, and transition APIs.
- Change dispatcher failure handling so only definitely-not-applied failures are retryable.
- Add tests proving unknown failures become uncertain and cannot replay.
- Commit: `feat: make CodePro effect outcomes fail closed`.

### Slice 2 — Persist the effect journal

- Add `effect_ledger.rs` with strict JSONL parsing, file locking, durable appends, size/count bounds, identity checks, and incomplete-tail recovery.
- Add restart, corruption, duplicate-process, and transition tests.
- Commit: `feat: persist CodePro effect ledger`.

### Slice 3 — Add the event/outbox commit boundary

- Add the optional outbox to `RunEngine` and prepare effects before appending events.
- Prove crash windows before event append, after event append, and after executor entry.
- Commit: `feat: prepare CodePro effects before event commit`.

### Slice 4 — Recover incomplete runs

- Add the recovery coordinator and typed report.
- Reconcile exact trigger events, abandon non-committed preparations, and mark stale claims uncertain.
- Feed unresolved effect IDs into the existing convergence/Coordinator context boundary.
- Commit: `feat: recover CodePro runs and uncertain effects`.

### Slice 5 — Validate and close U-79

- Run focused crash/replay suites, all `codepro_*` integration tests, Goose library tests, formatting, desktop checks, and distribution tests.
- Record actual evidence, residual limits, and the production wiring boundary.
- Commit: `docs: record CodePro U-79 validation`.

## Acceptance criteria

- No committed effect is missing after any simulated crash boundary.
- No uncommitted prepared effect can execute.
- Completed effects deduplicate after reopening the journal.
- Unknown and crash-interrupted effects are visible as `Uncertain` and cannot execute without an explicit resolution path.
- Definitely-not-applied failures remain safely retryable.
- Corrupt or identity-conflicting journals fail closed without truncating valid committed records.
- Existing event replay, cancellation, Coordinator rollout, desktop, and distribution gates remain green.

