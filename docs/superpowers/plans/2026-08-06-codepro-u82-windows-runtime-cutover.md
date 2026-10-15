# CodePro U-82 Windows Runtime Cutover and RC Plan

> **Execution rule:** every slice starts with a failing deterministic test, lands as a separate commit, and preserves an immediate legacy rollback. An installed package, a real Provider result, and a 24-hour soak are evidence requirements; they must never be replaced by development-mode or synthetic results.

## Goal

Make the durable CodePro Control Plane the staged production owner of CodePro runs on Windows, connect committed effects to real scheduler/Worker lifecycle actions, recover safely after restart, preserve legacy sessions and rollback, and produce an auditable Windows RC decision.

## Corrected starting facts

- U-81 exposes a strict ACP contract and durable outbox, but ordinary CodePro prompt runs are not registered with that service.
- `TaskScheduler` does not currently register workers in `WorkerRegistry`; therefore fine-grained stop cannot affect a real worker.
- `ControlCommand` cannot yet install a task graph or register a worker, so a production projection cannot truthfully show scheduler tasks/Agents.
- Persisting `PauseScheduling`, `StopWorkers`, or `EmergencyStop` is not equivalent to executing it.
- Current Coordinator qualification is `NOT_MEASURED`; all current combinations remain capped to Shadow.
- Development Electron tests cannot substitute for installed Windows lifecycle evidence. The current isolated Electron CDP bootstrap also failed before page assertions in U-81 validation.

## Architecture

Introduce one shared `CodeProRuntime` under `agents/control_plane`. It owns the event store, durable effect ledger, `WorkerRegistry`, run locks, and scheduler gates. ACP, the production Agent, and `TaskScheduler` all receive the same clone. The runtime is the only place allowed to append production control events or dispatch committed control effects.

The scheduler remains as a bounded Ready-task executor during U-82. It must ask the runtime to install plans, authorize task starts, register worker generations, submit outcomes, and honor pause/cancel. The legacy path remains available behind an independent runtime flag until two release candidates pass; Coordinator mode remains separately capped by U-80 qualification.

## Runtime modes and rollback

Add a strict independent switch:

```text
CODEPRO_RUNTIME_MODE=legacy
CODEPRO_RUNTIME_MODE=shadow
CODEPRO_RUNTIME_MODE=durable
```

- `legacy`: existing production behavior; durable runtime may only recover/read old data.
- `shadow`: mirror and compare; no durable effect may alter production work.
- `durable`: Control Plane authorizes scheduling and executes lifecycle controls.
- unknown or malformed values fail closed to `legacy` with a bounded warning.
- `CODEPRO_COORDINATOR_MODE` remains independent and cannot exceed exact qualification.

## Slice 1 — Freeze production plan and Worker protocol

Extend the protocol with host-only commands for installing a versioned plan and registering a Worker generation. Commands carry exact task IDs, names, roles, and dependency topology; reject duplicates, unknown dependencies, cycles, non-monotonic revisions, cross-run IDs, and unknown fields. Reducer output must create tasks/graph/Agents through validated events and no physical effect before commit.

**Focused gates:** protocol serialization, reducer transitions, topology replay, malformed input, and backward replay.

**Commit:** `feat: define CodePro production runtime protocol`

## Slice 2 — Build the shared durable runtime facade

Create a cloneable `CodeProRuntime` that owns per-run locks, `RunEngine`, recovery, ledger, registry, and runtime-mode policy. Move binding ownership out of the ACP-only service. Provide host-only operations for create-or-verify run, install plan, start task, register Worker, submit outcome, control, resolve uncertainty, and read snapshot data. Startup recovery completes before any new dispatch claim.

It must prove:

- one run/session binding is immutable;
- every state change precedes its physical effect;
- pending effects are dispatched once;
- in-flight effects after restart become uncertain, not retried;
- read-only calls append nothing and dispatch nothing;
- mode downgrade requires no data rewrite.

**Commit:** `feat: add CodePro production runtime facade`

## Slice 3 — Connect real effect execution

Add a production `ControlEffectExecutor` over scheduler gates and `LifecycleController<SystemProcessTreeTerminator>`:

- `PauseScheduling` closes the run gate without cancelling active workers;
- `RecoverRun` reopens scheduling only after recovery;
- `StopWorkers` cancels exact registered Worker tokens, waits cooperatively, then terminates registered process trees and aborts the runner if required;
- `EmergencyStop` closes scheduling, cancels the prompt/root token, and stops every live Worker;
- dispatch/retry effects grant one scheduler lease and never themselves run arbitrary code.

Unknown targets, partial process-tree cleanup, or lost outcomes fail closed and remain visible as uncertain/failed evidence.

**Commit:** `feat: execute CodePro controls against live workers`

## Slice 4 — Make TaskScheduler a runtime-controlled executor

Before a multi-Agent run executes, install its DAG in the durable runtime. For each Ready task:

1. obtain a committed start authorization;
2. register a deterministic Worker ID and generation;
3. use the registry cancellation token;
4. attach the spawned runner abort handle;
5. register/unregister child process IDs through the existing shell execution boundary;
6. submit a structured outcome through `OutcomeIngress`;
7. suppress late outcomes after stop or replacement.

Pause prevents new batches. Cancel task/branch stops only scoped workers. Emergency stop also cancels the active prompt. Legacy and shadow modes retain current behavior and record comparison evidence without executing durable controls.

**Commit:** `feat: run CodePro tasks through the control plane`

## Slice 5 — Cut ACP and desktop over without a second state machine

Register the prompt run before CodePro execution and notify the desktop with the initial backend snapshot. ACP commands call the shared runtime and return only after physical effect dispatch has reached a known outcome. Terminal prompt handling commits a terminal run event before clearing `activeRunId`. Reconnect inventories recoverable runs and exposes an explicit unavailable/recovery state instead of silently hiding a durable-run error.

Migration is idempotent and fail closed:

- legacy conversation/state records remain readable;
- valid legacy events may be imported once with an immutable mapping manifest;
- incomplete legacy data opens read-only with warnings;
- rollback continues the legacy session without deleting durable files.

**Commit:** `feat: cut CodePro desktop runs over to durable control`

## Slice 6 — Deterministic crash, cancellation, migration, and performance gates

Add real repository fixtures for clean/dirty Git, task/branch stop, pause/resume, process-tree cleanup, late outcomes, torn event/ledger tails, restart with pending/in-flight/uncertain effects, and legacy rollback. Measure rather than estimate:

- user stop to cancellation signal;
- process-tree stop duration;
- event-to-projection notification latency;
- 10,000-event recovery;
- bounded memory/event/context growth.

Any unmeasured metric is `NOT_MEASURED`; a missed stop, duplicate effect, unauthorized write, or data loss is blocking.

**Commit:** `test: qualify CodePro durable runtime recovery`

## Slice 7 — Harden Windows packaging and lifecycle validation

Extend the existing Windows build/smoke scripts into two layers:

- non-destructive package inspection usable in CI;
- explicit live lifecycle test using isolated application data and a generated fixture project.

Validate install, first launch, project open, safe local task, stop, crash/restart recovery, upgrade with data retention, rollback to the prior installer, uninstall, and documented retained-data cleanup. Record hashes, signatures, versions, paths, exit codes, and bounded logs without credentials. Never uninstall or overwrite a user's existing installation during automated development tests.

**Commit:** `test: verify CodeBuddy Windows lifecycle`

## Slice 8 — Real qualification, soak, security review, and RC manifest

Run the frozen U-80 suite against explicitly configured Provider/model/reasoning combinations. No credential means `environment_unavailable`, not a pass. Archive structured observations and install only exact qualification records. Run Git, MCP, cancel, network failure, and long-task scenarios in the installed build.

Create an append-only RC manifest containing:

- candidate commit and artifact SHA-256;
- installer/upgrade/rollback/uninstall evidence;
- deterministic gate counts;
- Provider qualification records or `NOT_MEASURED`;
- recovery and performance measurements;
- security/code-review findings;
- 24-hour soak start/end, heartbeat gaps, memory growth, failures, and verdict;
- rollback instructions and retained-data policy.

G5 is `passed` only after all required installed and 24-hour evidence exists. Otherwise the product may be a development candidate, but not a Windows RC.

**Commit:** `docs: record CodeBuddy Windows RC evidence`

## Mandatory verification

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --config profile.test.package.goose.debug=0 -p goose-sdk-types --jobs 1
cargo test --config profile.test.package.goose.debug=0 -p goose --lib --jobs 1
pnpm --dir ui/sdk lint
pnpm --dir ui/sdk test
pnpm --dir ui/desktop lint:check
pnpm --dir ui/desktop test:run
pnpm --dir ui/desktop test:distribution
cargo fmt --all -- --check
git diff --check
```

Installed lifecycle, real Provider qualification, and the 24-hour soak are additional gates and cannot be waived by these deterministic tests.

## Stop conditions

- a control is acknowledged before its effect reaches a durable known state;
- stop/pause UI state differs from the live scheduler or Worker state;
- recovery resends an uncertain external effect;
- durable mode can start work before startup recovery finishes;
- an unknown feature-flag value enables a newer path;
- rollback cannot read the session or preserve user data;
- real credentials, prompts, model output, or sensitive repository content enter logs/artifacts;
- installed-build evidence is replaced by development-mode evidence;
- `NOT_MEASURED` is reported as a pass.
