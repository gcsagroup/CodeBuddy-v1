# CodePro U-78 Coordinator Rollout Implementation Plan

**Date:** 2026-08-05
**Status:** In progress
**Depends on:** U-76 and U-77a through U-77d

## Objective

Add the semantic Coordinator above the Rust control plane and roll it out without allowing model output to bypass host state, permissions, budgets, task topology, evidence requirements, or rollback controls.

U-78 is complete only when shadow mode can compare Coordinator decisions with the legacy path without changing production behavior, advisory mode can execute a deliberately small low-risk subset, and authoritative mode is present but refuses every provider/model/reasoning combination that has not passed a versioned capability gate.

## Non-goals

- Do not make ordinary tool calls wake the Coordinator.
- Do not allow Worker nesting in the first release.
- Do not silently change provider or model after failure.
- Do not claim crash-safe effect execution; U-79 owns the durable ledger and recovery.
- Do not expose desktop controls in this slice; U-81 owns the ACP/UI surface.

## Decisions

1. `CoordinatorContext` is a host-built snapshot, not a transcript dump. Goal, hard constraints, open permissions, unresolved high-risk writes, and uncertain effects are mandatory and cannot be trimmed.
2. Context budgets use `min(16_000, model_context_limit * 20%)`. A pluggable token estimator is used when available; the fallback is conservative and reserves 20 percent headroom.
3. Prompt sections are physically separated into `SYSTEM POLICY`, `HOST STATE`, `USER GOAL`, and `UNTRUSTED EVIDENCE`. Worker, code, web, and tool text never enters a trusted section.
4. Coordinator JSON is a candidate only. The host validates protocol version, run scope, evidence provenance, task/Agent targets, topology, write ownership, permission scope, budget ceilings, and mode capability before committing an audit event or effect.
5. One schema-format repair is allowed. A second invalid response produces a typed safe-pause recommendation; it never falls back to free-form execution.
6. Rollout modes are `off`, `shadow`, `advisory`, and `authoritative`. Mode is host configuration snapshotted at Run start and cannot be raised by the model.
7. Shadow records a bounded audit comparison and emits no execution effect. Advisory permits only evidence-backed low-risk continuation/retry/instruction actions that do not expand write or permission scope. Plan revision, Worker replacement, completion, failure, user questions, cancellation, or new permissions remain shadow-only until authoritative.
8. Authoritative requires an exact qualification key: provider, model, reasoning level, protocol version, prompt version, and evaluator version. Missing, expired, or failing qualification denies execution and falls back to shadow.
9. `off` and `shadow` preserve legacy behavior byte-for-byte at the execution boundary. A single host switch returns advisory/authoritative runs to shadow or off without data migration.

## Work packages

### U-78a — Bounded context and prompt

Create `crates/goose/src/agents/coordinator/{mod.rs,context.rs,prompt.rs}`.

Implement:

- typed goal, constraint, plan, event, outcome, Agent, blocker, evidence, permission, budget, workspace, and steering summaries;
- configurable per-section and total token budgets;
- deterministic trim order and an auditable `ContextTrimReport`;
- mandatory-field overflow failure rather than silent deletion;
- prompt rendering with explicit trust boundaries and version.

Tests cover the 16k/20-percent ceiling, conservative fallback estimation, mandatory-field preservation, deterministic trimming, untrusted marker escaping, and audit reproducibility.

### U-78b — Decision schema and host validation

Create `coordinator/{decision.rs,validation.rs,coordinator.rs}` and extend protocol commands/events only additively.

Implement:

- versioned structured decision envelope;
- exact per-decision required/forbidden fields;
- current-Run evidence lookup and stale-plan rejection;
- task/Agent target and dependency checks;
- budget/permission/write-scope non-expansion;
- one bounded format-repair attempt and typed safe pause;
- a `ValidatedCoordinatorDecision` capability token that is required before reducer application.

Tests prove cross-Run/stale/unknown evidence, unknown targets, permission escalation, write expansion, invalid budget, repeated repair failure, and fabricated completion all produce no effect.

### U-78c — Audit protocol and shadow comparison

Add versioned audit events for requested mode, effective mode, qualification result, candidate validity, legacy action, Coordinator action, comparison class, and rejection reason. Keep payloads bounded and free of secrets/full prompts.

Implement a shadow controller that:

- builds context only at semantic decision points;
- calls the configured Coordinator model without changing provider;
- validates the candidate;
- records comparison after the legacy action is known;
- never returns executable effects;
- cannot delay emergency stop and has a bounded timeout.

### U-78d — Advisory mode

Implement a host allowlist for low-risk actions. Require current evidence and unchanged task/permission/write scopes. Commit the decision audit event before any effect. Any ambiguity, unsupported decision, validation error, timeout, or missing qualification falls back to shadow while legacy execution continues.

### U-78e — Authoritative gate and rollback

Create a qualification registry interface and a file-backed/read-only initial registry. Enforce exact qualification keys and expiry. Authoritative mode may apply dynamic plan, Worker replacement, Reviewer rework, and completion only after full validation and convergence approval. Add immediate rollback to shadow/off using the Run-start mode snapshot and preserve all audit events.

### U-78f — Production boundary and validation

Integrate the controller at existing CodePro semantic decision points without moving control logic into `agent.rs` or `task_scheduler.rs`. Keep entry changes thin. Run deterministic scenario fixtures comparing legacy and shadow decisions, then all Rust/UI/distribution gates. Publish a validation report with mismatch classes, latency, token use, and rollback evidence.

## Initial advisory allowlist

- Continue a `WaitingForCoordinator` task without changing its contract.
- Retry a semantic task once when the candidate cites current failure evidence and stays within the host rework limit.
- Send a bounded instruction to an existing idle Worker when it adds no permission, write scope, provider, or budget.
- Pause a task or Run.

Everything else remains audit-only until authoritative qualification.

## Rollback

`CODEPRO_COORDINATOR_MODE=off` (or the equivalent typed configuration value) disables model calls and uses the legacy compatibility path. `shadow` retains audits but executes legacy decisions. Rollback never rewrites the event stream and never deletes Coordinator evidence.

## Exit criteria

- Context always obeys the total/section budgets or fails closed before a model call.
- Invalid or unqualified decisions produce zero execution effects.
- Shadow mode demonstrably preserves legacy behavior.
- Advisory executes only the documented allowlist after commit-before-effect.
- Authoritative rejects unqualified combinations and can be rolled back immediately.
- Full CodePro, Goose, desktop, distribution, and scenario gates pass.
