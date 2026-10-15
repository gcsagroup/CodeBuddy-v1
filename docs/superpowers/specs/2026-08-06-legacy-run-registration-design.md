# Legacy Run Registration Boundary Fix Design

## Problem

CodePro prompt runs are registered with the durable control plane only when the effective runtime mode is `shadow` or `durable`. In `legacy` mode, prompt execution intentionally bypasses durable registration. Normal prompt completion still calls `send_latest_codepro_update`, which reaches `snapshot_if_available`. That method currently checks the on-disk run binding before asking whether a runtime snapshot exists, so an intentionally unregistered legacy run fails with `CodePro run <id> is not registered for this session`.

This turns a successful or otherwise valid legacy prompt lifecycle into an ACP submission error and makes the UI report a misleading session-load failure.

## Goal

Legacy CodePro prompts must complete, fail, and cancel without requiring a durable run binding. Shadow and durable modes must retain strict binding validation and continue surfacing genuinely unknown runs.

## Non-goals

- Do not register legacy prompts in the durable store.
- Do not suppress `UnknownRun` errors for shadow or durable control-plane requests.
- Do not change Coordinator authority, runtime defaults, UI copy, retry policy, or session restoration behavior.
- Do not refactor unrelated ACP lifecycle code.

## Considered approaches

### 1. Mode-aware control-plane availability (selected)

Expose one control-plane predicate that reports whether the effective runtime mode participates in durable run tracking. Use it at the optional lifecycle boundary so legacy snapshot, failure, and cancellation bookkeeping return `None` before binding validation. Keep public durable control operations strict.

This preserves current legacy semantics and fixes all optional lifecycle paths without hiding durable data-integrity errors.

### 2. Register runs in legacy mode

This would make the immediate error disappear, but it changes the meaning of legacy mode, creates new durable artifacts, and risks partially activating the control plane. Rejected.

### 3. Catch `UnknownRun` only in `send_latest_codepro_update`

This is smaller but incomplete: failure and cancellation paths can still fail, and genuine shadow/durable registration defects would be silently hidden. Rejected.

## Design

`CodeProControlPlane` will expose a small internal predicate equivalent to:

```rust
fn tracks_prompt_runs(&self) -> bool {
    self.runtime.mode_policy().effective() != CodeProRuntimeMode::Legacy
}
```

Optional prompt-lifecycle methods will short-circuit in legacy mode before parsing or binding lookup:

- `snapshot_if_available` returns `Ok(None)`.
- `cancel_prompt_run` returns `Ok(None)`.
- `fail_prompt_run` returns `Ok(None)`.

The ACP prompt entry point will use the same predicate when deciding whether to call `register_prompt_run`, removing duplicated mode logic.

Public explicit control-plane APIs such as `get`, `control`, and effect resolution remain strict. Calling those APIs for an unregistered run must continue to return `UnknownRun` because they represent explicit durable-control requests rather than optional legacy bookkeeping.

## Tests

Add regression coverage at the `CodeProControlPlane` boundary using real temporary storage:

1. In legacy mode, an unregistered prompt run returns `None` for snapshot, cancellation, and failure bookkeeping.
2. In shadow mode, an unregistered prompt run still returns `UnknownRun`.
3. Existing registered shadow/durable lifecycle tests continue to pass.

The regression test must fail on the pre-fix implementation with the same `UnknownRun` behavior observed in the application.

## Acceptance criteria

- A legacy CodePro prompt does not fail solely because no durable binding exists.
- Legacy completion, failure, and cancellation bookkeeping are no-ops rather than errors.
- Shadow and durable modes retain strict unknown-run detection.
- Targeted CodePro control-plane tests pass.
- The Goose crate compiles with the change.

## Risk and rollback

The main risk is accidentally weakening durable run validation. Mode-specific negative coverage prevents that regression. The change is localized and can be reverted as one commit without data migration.
