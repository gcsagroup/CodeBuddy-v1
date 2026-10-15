# CodePro U-75 Versioned Protocol Validation

Date: 2026-08-05

Baseline: `9f324989b`

Validated implementation: `dfb650d1d542dccfab3d933582844a38a0bf45eb`

## Outcome

U-75 is complete. CodePro now has a fail-closed, versioned v1 protocol boundary for run, task, agent, command, worker outcome, evidence, and event identities. The protocol is defined and tested but is not wired into the production event store in U-75.

**G1: NOT YET — requires U-76.**

U-76 must add durable persistence, ordered replay, projections, migration handling, and crash recovery before the protocol can qualify as the authoritative production control plane.

## Delivered commits

- `0b59d3ec8` — plan CodePro U-75 versioned protocol
- `6879b2040` — add protocol version, typed identifiers, and evidence ownership
- `efdaed55c` — define independent run, task, agent, and command state machines
- `014d48a8d` — add worker outcome and coordinator command contracts
- `46e375117` — freeze the v1 `RunEvent` envelope and fixture
- `dfb650d1d` — add the read-only legacy `ActivityEvent` adapter

## Verification evidence

All commands ran from `D:\CodeBuddy` unless another directory is stated.

| Gate | Command | Result |
| --- | --- | --- |
| Rust formatting | `cargo fmt --all -- --check` | PASS |
| Protocol contract | `cargo test --config profile.test.package.goose.debug=0 -p goose --test codepro_protocol_contract --jobs 1 -- --nocapture` | PASS — 5 passed, 0 failed |
| CodePro Rust regression | `cargo test --config profile.test.package.goose.debug=0 -p goose codepro_ --lib --jobs 1 -- --nocapture` | PASS — 161 passed, 0 failed |
| Full Rust library | `cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1 --no-fail-fast` | PASS — 2004 passed, 0 failed |
| Desktop typecheck | `pnpm run typecheck` | PASS |
| Desktop tests | `pnpm run test:run` | PASS — 124 files, 941 passed, 4 skipped |
| Desktop lint and locale validation | `pnpm run lint:check` | PASS — zero lint warnings; 15 locale catalogs validated |
| Distribution contract | `pnpm run test:distribution` | PASS — 31 passed, 0 failed |

Rust test commands used `CARGO_INCREMENTAL=0` and one job to avoid Windows linker memory pressure.

The build emitted eight inherited `dead_code` warnings from `crates/goose/src/github_auth/credential_store.rs`. They predate U-75 and did not cause any gate failure.

## Gate correction

The original U-75 plan included:

`cargo test --config profile.test.package.goose.debug=0 -p goose activity_event --lib --jobs 1 -- --nocapture`

That command exits successfully but matches zero tests (`2004 filtered out`) because `activity_event.rs` and `codepro_event_log.rs` contain no unit tests with that name. It is therefore not counted as verification evidence. Coverage for the adapter is supplied by the public `codepro_protocol_contract` integration suite, which executes the conversion and validates the resulting v1 envelope.

## Scope audit

`git diff --name-only 9f324989b..dfb650d1d` contains only:

- `crates/goose/src/agents/protocol/` protocol modules
- the protocol export in `crates/goose/src/agents/mod.rs`
- `crates/goose/tests/codepro_protocol_contract.rs`
- `crates/goose/tests/fixtures/protocol/v1/run_started.json`
- the U-75 implementation plan

No production event-store wiring, scheduler replacement, desktop behavior change, or legacy storage mutation was introduced. `crates/`, `ui/`, and `docs/superpowers/` were clean after the implementation commits. Existing user-owned changes under `documentation/` were not staged or modified by U-75.

The plan placeholder scan for `TBD`, `TODO`, `implement later`, `fill in`, and `appropriate error` returned no matches.

## U-76 entry criteria

U-76 may begin from this commit only if it preserves these boundaries:

1. `RunEvent` remains the immutable versioned wire contract.
2. Storage assigns and enforces per-run monotonic sequence numbers.
3. Replay and projections reject unsupported versions and invalid transitions.
4. Legacy data is adapted read-only; migration never silently invents stable agent identity.
5. The existing production event log remains available until replay equivalence and rollback are proven.
