# CodePro U-78 Coordinator Rollout Validation

**Validation date:** 2026-08-06 (Asia/Shanghai)

**Branch:** `fix/codepro-analysis-evidence`

**Status:** U-78 implementation complete; desktop cutover remains gated

## Outcome

U-78 adds a semantic Coordinator above the Rust event control plane without granting raw model output execution authority.

The implemented safety chain is:

1. The host builds a bounded context and explicit trust zones.
2. A fixed provider/model adapter requests one strict JSON decision.
3. One bounded format-repair attempt is permitted.
4. The host validates Run identity, evidence provenance, plan revision, targets, state, topology, permissions, budget, write ownership, retry limits, and convergence.
5. Shadow always returns the legacy action.
6. Advisory exposes only the documented low-risk allowlist.
7. Authoritative requires an exact, unexpired six-part qualification key.
8. A Coordinator capability is created only after its audit event commits.
9. Rollback invalidates unconsumed Authoritative authorization stamps and can prevent or discard model calls.

## Delivered packages

- U-78a: bounded context, deterministic trimming, mandatory safety fields, trust-zone prompt rendering, and a concrete output contract.
- U-78b: versioned decision schema, strict unknown-field rejection, host validation, replay prevention, 64 KiB response limit, and one-repair safe pause.
- U-78c: versioned secret-safe audit records, match/divergence classification, bounded Shadow timeout, and legacy-only Shadow execution.
- U-78d: commit-before-capability Advisory mode with Continue, first evidence-backed Retry, idle-Worker instruction, PauseTask, and PauseRun allowlisting.
- U-78e: exact provider/model/reasoning/protocol/prompt/evaluator qualification, expiry/failure handling, read-only file registry, Authoritative controller, and monotonic rollback.
- U-78f: fixed Provider adapter, projection/event-derived validation snapshots, RunEngine audit committer, and post-commit semantic hooks on Worker outcomes.

## Deterministic rollout evidence

The checked-in scenarios cover:

- exact Shadow match while executing the legacy action;
- divergent Shadow advice while executing the legacy action;
- malformed and oversized responses followed by one repair and typed safe pause;
- provider error and timeout without effects;
- valid but non-allowlisted Advisory actions falling back to legacy;
- Advisory audit failure producing no Coordinator capability;
- exact qualification success and one-field qualification mismatches;
- missing, failed, and expired qualification falling back to Shadow;
- fabricated completion rejected by the host convergence gate;
- rollback before a call producing zero model calls;
- rollback during a call preserving the historical candidate but discarding it;
- rollback after audit commit revoking the unconsumed authorization stamp.

Audit records capture bounded `latency_ms`, estimated prompt tokens, and completion bytes. These deterministic fake-provider scenarios prove accounting and classification behavior; they are not live-provider latency benchmarks. No provider/model combination is shipped as qualified by this package, so Authoritative requests default to Shadow until a real qualification record is installed.

## Validation results

### Rust

- All 34 `codepro_*` integration binaries: **204 passed, 0 failed, 1 ignored**.
- Ignored test: explicit real visible Windows Notepad acceptance test.
- Goose library: **2004 passed, 0 failed**.
- `cargo fmt --all -- --check`: passed.
- `git diff --check`: passed.
- No dependency or lockfile changes.
- Eight existing dead-code warnings remain in `github_auth/credential_store.rs`; U-78 introduced no new warning class.

### Desktop and distribution

- TypeScript typecheck: passed.
- ESLint: passed with zero warnings.
- i18n validation: passed for 15 locales and 1935 messages.
- Vitest: **941 passed, 4 skipped** across 124 files.
- Distribution/branding/qualification/Windows shim tests: **31 passed, 0 failed**.

## Rollback contract

- Run-start mode is immutable upward.
- Runtime mode may only move to `shadow` or `off`.
- Unqualified Authoritative requests start in Shadow.
- `off` prevents new model calls.
- A rollback during an in-flight call records that the call occurred but forces legacy execution.
- A rollback after audit commit invalidates the outstanding Authoritative authorization stamp.
- Existing event and audit records are never rewritten or deleted.

## Remaining boundary

The new Coordinator is connected to the event control plane through committed Worker-outcome semantic hooks. The existing desktop CodePro entry in `Agent::run_codepro` still uses the legacy `TaskScheduler` compatibility path. Therefore U-78 does **not** claim that ordinary desktop runs have already switched to Authoritative control.

The planned sequence remains:

- U-79: durable effect ledger and crash recovery for Coordinator-selected effects;
- U-80: evaluator fixtures and real provider/model qualification production;
- U-81: ACP and desktop controls, status, audit views, and user rollback;
- U-82: staged Windows cutover, installer/upgrade/rollback acceptance, and release candidate.
