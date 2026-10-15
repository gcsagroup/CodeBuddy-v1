# CodePro Automation and User Experience Closure Plan

[繁體中文（預設）](CODEPRO_AUTOMATION_UX_CLOSURE_SOLUTION_ZH_TW.md) · [简体中文](CODEPRO_AUTOMATION_UX_CLOSURE_SOLUTION_ZH_CN.md) · [English](CODEPRO_AUTOMATION_UX_CLOSURE_SOLUTION_EN.md)

## Executive summary

The visible stops, failures, root-directory errors, delayed model settings, missing progress, and inconsistent reports are not independent defects. Execution state, recovery policy, public progress, and final reports do not yet share one authoritative contract. The solution is not to hide error text, but to build a durable, resumable, observable execution loop driven by host-owned facts.

## Scope and boundary

This plan addresses four problem groups:

1. Ordinary verification failures, missing tools, and insufficient permissions are presented as terminal failure or stop states.
2. A new project requested from a filesystem root is not always created and bound to a safe child directory.
3. Advanced model-routing options appear incomplete and then change after asynchronous discovery finishes.
4. Planner, Coder, Tester, and Reviewer do not expose consistent public progress or use one report format.

This plan does not promise that errors can never occur. Irrecoverable crashes, corrupt state, and exhausted retry budgets must still be reported honestly. The goal is to stop misclassifying recoverable conditions and to prevent long periods with no visible progress.

## Verified current behavior

- `task_scheduler.rs` distinguishes outcomes such as `VerificationFailed`, `WaitingForUser`, and `InfrastructureFailed`, but some paths still converge infrastructure problems into generic failure or non-resumable review.
- `worker_activity_callback` forwards confirmation and elicitation messages while public activity summaries are generated separately; coverage is not uniform across every role and phase.
- `codeProActivityModel.ts` retains a legacy path that infers status from localized words such as `stopped`, which can disagree with backend state.
- A filesystem root is intentionally treated as a project container and default cwd, but child-project allocation and binding are only completed through some `NeedsWorkspace` paths.
- `CodeProModelModal.tsx` loads provider/config/default data and then discovers models across providers; slow providers delay the complete presentation.
- Analysis, simple-change, DAG aggregation, terminal reporting, and Report Writer still expose multiple report entry points.

## Target contract

```text
User request
  -> Intent + WorkspaceDecision
  -> RunState + RecoveryAction
  -> PublicProgressEvent
  -> UserReport
```

### 1. Separate state from recovery

Canonical states: `Running`, `VerificationFailed`, `Repairing`, `Retesting`, `WaitingForUser`, `WaitingForEnvironment`, `Succeeded`, `Cancelled`, `Exhausted`, and `Fatal`.

Canonical recovery actions: `RetrySameStep`, `RepairThenRetest`, `AskUserThenResume`, `DiagnoseEnvironment`, `Replan`, and `Finish`.

Rules:

- A command launch failure first diagnoses the executable, PATH, runtime, and permissions; it is not a project test failure.
- A non-zero test exit stores command, cwd, output references, and failed tests, invokes Coder, and reruns the identical command.
- Permission, login, download, and scope expansion create a checkpoint and ask the user; approval resumes the original step.
- Only explicit cancellation, exhausted budget, or an unsafe-to-resume fault becomes terminal.

### 2. Allocate a project atomically from a root container

A root such as `D:\` is a project container, not the write root of a newly requested project.

For a request to create a project, CodePro should derive a safe child name, atomically create the directory and workspace lease, persist the binding and checkpoint, then resume the original message inside that directory. It should not ask for a second workspace confirmation. It should ask only when materially different destinations remain plausible. Permission problems become `WaitingForUser`, with the exact path and required action.

Read-only intent must remain read-only. A request for analysis and improvement directions must not be upgraded to a modification request.

### 3. Publish progress for every role

Planner, Coder, Tester, and Reviewer publish the same `PublicProgressEvent` fields: role, phase, task and attempt IDs, a safe one-line summary, current command or file, start and last-activity times, elapsed time, known completion counts, next action, and wait reason.

The UI shows summary, elapsed time, and heartbeat by default. Expanding a card shows public steps, command progress, bounded incremental output, and understandable wait reasons. Ten seconds without output means “still running,” not “stuck.” Legacy text events may be displayed for compatibility but must not determine current state.

Private chain of thought, system prompts, secrets, and raw model drafts are never displayed. Official OpenAI documentation describes user-visible preambles before tool calls and supports reasoning summaries. CodePro adopts public rationale plus tool progress, not hidden reasoning text. See [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model#preambles).

### 4. Load advanced model settings progressively

- Render the four roles and persisted selections immediately from a snapshot.
- Load provider inventory, defaults, and per-provider models independently.
- Update each provider as soon as it finishes; do not wait for the slowest provider.
- Give every selector its own `loading / ready / unavailable / retrying` state.
- A persisted combination may appear while the provider catalog is pending; once discovery finishes, any missing provider, connection, or model clears the stale combination and returns every role to the current model.
- Use request generations to discard stale discovery results.
- A new unsaved advanced combination retains independent provider retry. A persisted combination is no longer presented as valid when any role becomes unavailable.

### 5. One model authority and a revisioned switch transaction

- The default surface shows one current model. An ordinary switch disables advanced routing so every role follows the same provider/model.
- Advanced routing is explicit. Role cards show only the actual model and a separate-setting marker, never competing default, recommended, or current values.
- Ordinary switches are serialized with a monotonic revision. Superseded submissions cannot determine final state. If session mutation succeeds but default persistence fails, compensating rollback restores the session and prior advanced routing.
- Each CodePro task creates its routing snapshot at task start, so a running task keeps its model and the next task receives the new configuration.
- `ActivityEvent.effective_model` is the execution-audit authority and is rendered directly in activity details.
- Provider deletion or model-list updates clear advanced routes that reference unavailable identities; UI discovery applies the same fallback for an unavailable connection.

### 6. Use one user-report contract

Create one `UserReportV1` rendered in this order:

1. One-sentence result.
2. What changed or was inspected, limited to five plain-language items.
3. Verification results.
4. What the user needs to do, omitted when empty.
5. Collapsed technical details: command, cwd, exit code, evidence references, and run identifiers.

A failed test, missing tool, or permission wait is not a “limitation.” Internal codes must not appear in the main report. Agent narration cannot override host verification, and unexecuted tests cannot be reported as passing.

## Delivery order

- **P0 — Repair loop:** failure evidence → Coder edit → identical Tester rerun; distinguish missing tools, permissions, and cancellation.
- **P1 — Structured UI state:** share one state and progress event across ACP, SDK, and UI; remove text inference for new runs.
- **P2 — Atomic root allocation:** unify RootContainer, NeedsWorkspace, lease, binding, and resume behavior.
- **P3 — Progressive model discovery:** independent provider loading, retry, cache, and stale-request cancellation.
- **P4 — Report convergence:** make `UserReportV1` the only user-visible renderer; legacy paths become fact providers or adapters.

## Required acceptance scenarios

1. A test exits 1, the UI says repair is in progress, Coder edits, and the identical command exits 0.
2. Missing Node.js is explained as a dependency/PATH condition with a recovery action, not a project bug.
3. Access outside the workspace saves a checkpoint, asks the user, and resumes the same step after approval.
4. A project requested from `D:\` is created in a safe child directory without a second workspace confirmation.
5. “Analyze and suggest improvements” performs no writes.
6. Every role and step has expandable progress; long commands show heartbeat and recent output.
7. A slow or failed provider does not block usable model choices from other providers.
8. Analysis, repair, and test reports use the same order and plain status language.
9. “Could not repair automatically” appears only after the explicit repair budget is exhausted, with evidence and a resume path preserved.
10. API, persisted events, SDK, UI, and final report interpret the same run state identically.

## Definition of done

- Focused backend state-machine and real repair-loop tests pass.
- ACP schema and SDK are regenerated and pass compatibility checks.
- UI component tests cover progress, waits, model discovery, and reports.
- All acceptance scenarios pass in the real Windows desktop application.
- Restart restores wait state, repair attempts, model selections, and public progress.
- No new run derives authoritative state from localized display text.
