# CodePro U-81 Desktop Control Surface Implementation Plan

> **Execution rule:** land each numbered slice only after its focused tests pass. The event store and Rust `RunEngine` remain authoritative; ACP and the desktop are projections and command clients, not a second state machine.

**Goal:** Expose versioned CodePro run state, durable recovery state, coordinator qualification, and fine-grained controls through ACP and a desktop panel without weakening the existing permission/lifecycle boundaries or pretending that the legacy scheduler is already migrated.

**Architecture:** Add strict wire DTOs to `goose-sdk-types`, a file-backed ACP control service over `RunEngine<FileRunEventStore, SystemRunClock, FileEffectLedger>`, generated TypeScript bindings, and a pure desktop projection store. ACP command responses and notifications carry the same backend-authored snapshot. Read operations only load/recover state and never call the coordinator or append events. Legacy CodePro chat progress remains a fallback until U-82 performs the staged production cutover.

**Non-goals:** deleting the legacy scheduler, enabling unqualified authoritative Coordinator mode, optimistic UI state transitions, resolving uncertain effects automatically, or claiming installed-build recovery before U-82.

## Slice 1 — Freeze the versioned ACP contract

**Files:**

- Modify `crates/goose-sdk-types/src/custom_notifications.rs`
- Modify `crates/goose-sdk-types/src/custom_requests.rs`
- Add focused serialization/schema tests

Define:

- `_goose/unstable/codepro/run/update` notification, `schemaVersion: 1`;
- `_goose/unstable/codepro/run/get` read request;
- `_goose/unstable/codepro/run/control` mutation request;
- `_goose/unstable/codepro/effects/resolve` explicit uncertainty-resolution request;
- typed run/task/agent/effect/coordinator projections and command receipts;
- discriminated control actions for stop worker, cancel task, cancel branch, pause, resume, and emergency stop;
- strict identifiers, required reasons for destructive controls, and optional `expectedSequence` concurrency guards.

Tests must first prove exact camelCase wire shapes, schema version rejection, unknown-field rejection, and discriminated action generation.

**Verification:**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose-sdk-types --jobs 1
```

**Commit:** `feat: define CodePro ACP control protocol`

## Slice 2 — Add the backend ACP control service

**Files:**

- Create `crates/goose/src/acp/server/codepro_control.rs`
- Modify `crates/goose/src/acp/server.rs`
- Modify `crates/goose/src/acp/server/custom_dispatch.rs`

The service owns a dedicated `<data_dir>/codepro-control` root and serializes operations per run. `get` performs recovery and returns a snapshot without appending events. `control` checks `expectedSequence`, maps only user-authorized actions to `ControlCommand`, applies through a durable-outbox `RunEngine`, then returns the committed receipt. `resolve` accepts only `confirmed_applied` or `confirmed_not_applied` and returns the reread snapshot. ACP emits the same snapshot through the versioned run-update notification when the client advertises custom notifications.

Coordinator presentation must be honest: requested mode comes from configuration; effective mode is capped by the exact qualification assessment. Missing live qualification is reported as Shadow/`missing`, never inferred as passed.

Tests must cover read-only non-mutation, stale sequence rejection, target scoping, reason validation, durable event/effect writes, explicit uncertainty resolution, and notification shape.

**Verification:**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --lib acp::server::codepro_control --jobs 1
```

**Commit:** `feat: serve CodePro run controls over ACP`

## Slice 3 — Generate and verify the SDK

**Files:**

- Regenerate `ui/sdk/src/generated/*`
- Add/modify SDK compatibility tests as required

Generate bindings from the Rust schema; do not hand-edit generated files. Verify request methods and the notification callback are exported with strict projection types.

**Verification:**

```powershell
pnpm --dir ui/sdk generate
pnpm --dir ui/sdk lint
pnpm --dir ui/sdk test
```

**Commit:** `feat: generate CodePro control SDK`

## Slice 4 — Add the desktop projection and command client

**Files:**

- Create `ui/desktop/src/codepro/runProjection.ts`
- Create `ui/desktop/src/codepro/runCommands.ts`
- Modify `ui/desktop/src/acp/acpConnection.ts`
- Add Vitest files beside the modules

The pure projection store accepts only schema v1 snapshots, rejects run/session mismatches and regressing sequences, exposes subscribe/get/clear operations, and derives user-facing status without parsing text. The command client sends exact run/target IDs and the last observed sequence; it applies only the backend response. ACP notifications feed the same store. Reconnect triggers a read-only refresh for observed runs.

Tests must cover replay/idempotence, stale update rejection, cross-session isolation, no optimistic mutation, backend rejection, and reconnect hydration.

**Commit:** `feat: project CodePro runs in desktop`

## Slice 5 — Add accessible run status, evidence, audit, and controls

**Files:**

- Create focused components under `ui/desktop/src/components/codepro/`
- Integrate with `CodeProTaskPanel.tsx`
- Add component/model tests and localized messages

Add a compact control-plane section to the existing CodePro task panel. It shows requested/effective Coordinator mode and qualification reason; run/task/Agent states; event/evidence audit; uncertain effects with explicit, risk-labeled resolution; and controls allowed by the current projection. Destructive actions require confirmation and a reason. Buttons remain pending until a backend receipt arrives, expose errors inline, and are fully keyboard accessible. The read-only refresh action must not affect the active chat turn.

**Verification:**

```powershell
pnpm --dir ui/desktop lint
pnpm --dir ui/desktop typecheck
pnpm --dir ui/desktop test -- --run
pnpm --dir ui/desktop i18n:check
```

**Commit:** `feat: add CodePro desktop control surface`

## Slice 6 — Browser, integration, and regression gates

Exercise normal, empty, stale, rejected, paused, stopped, and uncertain states in a real browser/Electron-compatible renderer. Verify keyboard traversal, accessible names, error handling, and narrow/wide layouts. Then run the affected Rust/SDK/desktop/distribution suites and record exact evidence.

**Verification:**

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1
pnpm --dir ui/sdk lint
pnpm --dir ui/sdk test
pnpm --dir ui/desktop lint
pnpm --dir ui/desktop typecheck
pnpm --dir ui/desktop test -- --run
pnpm --dir ui/desktop i18n:check
```

Create `docs/superpowers/reports/2026-08-06-codepro-u81-validation.md` with pass counts, known warnings, browser evidence, and the explicit boundary that U-82 still owns installed Windows cutover and RC proof.

**Commit:** `docs: record CodePro U-81 validation`

## Stop conditions

- Any read-only request appends a run event, dispatches an effect, wakes a coordinator, or interrupts a prompt.
- The desktop can display a state not returned by the backend.
- Unknown schema versions or stale expected sequences are accepted.
- An uncertain effect can be retried or resolved without explicit user classification.
- Authoritative mode is displayed as effective without an exact, live qualification record.
- Existing ACP clients without the custom notification capability regress.
