# CodePro U-81 Desktop Control Surface Validation

## Outcome

U-81 is complete at the protocol, durable command boundary, desktop projection, and desktop control-surface boundary. The desktop can consume backend-authored CodePro run snapshots, reject stale or cross-session state, issue sequence-guarded controls, display Coordinator qualification capping, and require explicit user classification before an uncertain external effect can be retried or marked complete.

U-81 does **not** claim that ordinary desktop CodePro runs are already owned by the new durable runtime. The existing production chat/scheduler path is still the fallback. The control panel renders only when a real durable run projection exists; it does not synthesize state for legacy runs.

## Delivered

- Strict ACP schema version 1 for:
  - run snapshot reads;
  - run controls: stop worker, cancel task, cancel branch, pause, resume, and emergency stop;
  - explicit uncertain-effect resolution;
  - backend-authored run update notifications.
- File-backed ACP control service:
  - immutable run-to-session binding;
  - per-run serialization;
  - expected-sequence concurrency checks before event append;
  - recovery reads that do not append events;
  - durable effect intents through `RunEngine` and `FileEffectLedger`;
  - exact-session access control;
  - notifications only after a successful backend command receipt.
- Generated TypeScript SDK methods and callback types from the Rust schema.
- Desktop projection store and command client:
  - schema validation;
  - same-sequence conflict and regressing-sequence rejection;
  - idempotent replay;
  - session/run isolation;
  - reconnect hydration with read-only requests;
  - no optimistic mutation.
- Accessible desktop control surface:
  - requested-to-effective Coordinator mode and qualification reason;
  - run, task, Agent, event, evidence, and uncertain-effect state;
  - fine-grained controls disabled while awaiting backend receipts;
  - inline backend failures;
  - localized labels using the existing 15-locale catalog;
  - keyboard-operable native buttons, details disclosure, alert roles, and accessible names.

## Fresh verification

- `goose-sdk-types`: 20 passed, 0 failed.
- Focused ACP control service: 5 passed, 0 failed, 2004 filtered out.
- Goose library: 2009 passed, 0 failed.
- Generated SDK lint: passed.
- Generated SDK tests: 5 passed, 0 failed.
- Desktop TypeScript, ESLint, and i18n: passed for 15 locales and 1935 messages.
- Focused desktop control/projection tests: 11 passed, 0 failed.
- Desktop Vitest: 127 files passed; 952 passed, 4 skipped.
- Distribution contract: 32 passed, 0 failed.
- `cargo fmt --all -- --check`: passed.
- `git diff --check`: passed.
- No dependency manifest or lockfile changed.

The Rust build has no new warning introduced by U-81. The repository still has the inherited dead-code warnings in `github_auth/credential_store.rs` documented by earlier packages.

## Real renderer evidence and limitation

The Chrome DevTools connector is not available in the current tool environment. The repository's isolated Electron + Playwright user journey was attempted three times. Electron Forge built both the preload and main targets and Electron reported a DevTools WebSocket, but the fixed CDP bootstrap did not produce a connectable page before its bounded startup windows (120, 180, and 300 seconds in diagnostic runs). No product-page assertion ran, so these attempts are not counted as passed browser evidence.

The temporary timeout/probe experiments were fully reverted. The verified fallback is the real DOM component suite plus the complete desktop regression suite. U-82 must obtain installed-build renderer evidence and must not treat this U-81 limitation as a release pass.

## Independent architecture review

The U-81 surface is intentionally fail-closed, but two production boundaries remain:

1. `CodeProControlService::create_run` is not called by the legacy production scheduler. This prevents the desktop from presenting a fake durable control plane for runs that the new runtime does not own.
2. The service durably commits effect intents, but it does not dispatch those effects to the actual worker/lifecycle implementation. Therefore a persisted pause or stop intent is not yet proof that a worker process paused or stopped.

Those are not presentation defects; they are the central U-82 cutover work. Shipping the panel for all legacy runs before those bindings exist would be actively misleading and unsafe.

## Commits

- `69f494f4a` — plan: define CodePro U-81 desktop controls
- `aa4b3a064` — feat: define CodePro ACP control protocol
- `43466b807` — feat: serve CodePro run controls over ACP
- `53f445c61` — feat: generate CodePro control SDK
- `6ea13d0a4` — feat: project CodePro runs in desktop
- `199e1d774` — feat: add CodePro desktop control surface
- `bd8486a79` — fix: localize CodePro desktop controls

## Workspace hygiene

Pre-existing user-owned changes under `documentation/` were neither modified, staged, nor committed. Windows line-ending status noise in unrelated ACP files has no content diff and was not staged.

## Next package

U-82 must make the durable runtime the staged production owner, wire effect dispatch to real lifecycle/worker actions, serialize startup recovery before new work, prove legacy fallback and rollback, run exact live Coordinator qualifications without fabricating credentials or observations, and validate the packaged Windows installer, upgrade, rollback, and uninstall paths.
