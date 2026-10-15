# CodePro U-79 Durable Effects and Crash Recovery Validation

## Outcome

U-79 is complete at the control-plane boundary. CodePro now has a crash-durable, versioned effect journal and a startup recovery API. It does not claim impossible exactly-once execution: any effect whose external outcome cannot be proven becomes `Uncertain` and is blocked from automatic replay.

The earlier roadmap placed recovery in U-82. It was deliberately brought forward because U-78 introduced Coordinator-selected actions; desktop cutover must not precede durable effect accounting.

## Delivered

- Fail-closed executor outcomes:
  - `EffectExecutionError::new` means the outcome is unknown.
  - only `definitely_not_applied` may return a claimed effect to pending.
  - unknown failures durably become `Uncertain` and a replay is rejected.
- A strict `effects.v1.jsonl` journal with:
  - schema and sequence validation;
  - Run/effect/trigger-event identity binding;
  - exclusive file locking;
  - bounded file, record-count, and record-size limits;
  - newline commit markers, `flush`, and `sync_data`;
  - top-level and nested unknown-field rejection;
  - incomplete-tail repair without accepting corrupt committed records.
- A durable state machine:

  ```text
  Prepared -> Pending -> Claimed -> Completed
                           |  |
                           |  +-> Pending      (proved not applied)
                           +----> Uncertain    (unknown outcome or crash)
  Prepared --------------------> Abandoned    (trigger event absent)
  ```

- A transactional outbox boundary in `RunEngine`:
  - exact effect descriptors are prepared before event append;
  - event batches are appended and synced before effects become pending;
  - post-event outbox failure leaves recoverable prepared evidence instead of losing the effect.
- `RunRecovery` startup reconciliation:
  - repairs incomplete event and effect tails;
  - compares the complete stored trigger event, not only its ID;
  - promotes committed preparations to pending;
  - abandons preparations without a committed trigger;
  - converts interrupted claims to uncertain;
  - rebuilds the authoritative projection without executing anything.
- An explicit uncertain-effect resolution API for a later desktop approval flow:
  - `ConfirmedApplied -> Completed`;
  - `ConfirmedNotApplied -> Pending`.

## Crash-window evidence

| Boundary | Verified result |
|---|---|
| Before event append | prepared effect remains non-dispatchable and recovery abandons it |
| After event append, before outbox commit | exact committed trigger promotes the effect to pending |
| During concurrent claim | one file-locked winner; the other observes in-flight |
| Executor returns definitely-not-applied | effect safely returns to pending |
| Executor returns unknown | effect becomes uncertain and cannot replay |
| Process terminates with claimed effect | startup recovery marks it uncertain |
| After executor success, before completed record is durable | incomplete completion is truncated; claimed state becomes uncertain |
| After completed record | reopening the ledger deduplicates execution |
| Trigger ID matches but event contents differ | recovery fails closed with identity conflict |
| Journal has an incomplete tail | only incomplete bytes are truncated; committed records remain |

## Fresh verification

- `cargo fmt --all -- --check`: passed.
- 36 `codepro_*` integration targets: 217 passed, 0 failed, 1 ignored. The ignored test is the explicit visible Windows Notepad test.
- `cargo test ... -p goose --lib --jobs 1`: 2004 passed, 0 failed.
- Desktop TypeScript, ESLint, and i18n gate: passed for 15 locales and 1935 messages.
- Desktop Vitest: 124 files passed; 941 tests passed and 4 skipped.
- Distribution contract tests: 31 passed, 0 failed.
- Final strict nested-field change received a fresh focused durable-ledger test after the full gate.
- `git diff --check`: passed.
- No dependency manifest or lockfile changed.
- All new implementation files remain below the 800-line project limit.

The Rust build still reports the same eight pre-existing dead-code warnings in `github_auth/credential_store.rs`; U-79 introduced no new warning class.

## Honest production boundary

`RunEngine::new` intentionally retains the no-op outbox for compatibility with existing tests and the legacy scheduler path. Crash durability applies to the new `RunEngine::with_effect_outbox(..., FileEffectLedger)` production boundary. The current desktop `Agent::run_codepro` entry still follows the legacy `TaskScheduler` compatibility route, as already recorded by U-78.

Therefore this report does **not** claim that ordinary desktop runs are already recovered by `RunRecovery`. U-81 must connect ACP/desktop startup and controls to the durable engine, serialize startup recovery against dispatch, surface `Uncertain` items, and expose explicit resolution. U-82 must prove that behavior in installed Windows builds.

Journal mutations currently use synchronous locked file I/O at the control boundary. This keeps transition ordering simple and correct; latency must be measured under the U-82 soak workload before default rollout.

## Workspace hygiene

Pre-existing user-owned changes under `documentation/` were neither modified, staged, nor committed. U-79 changed only Goose control-plane source/tests and `docs/superpowers` plan/report files.

## Next package

U-80: versioned evaluator fixtures, provider/model qualification runs, safety/cost/latency scoring, and automatic mode restriction from signed qualification evidence. This must be completed before authoritative desktop rollout is enabled by default.

