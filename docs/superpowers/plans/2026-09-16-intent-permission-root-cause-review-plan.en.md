# Intent, Validation Boundary, and Reporting Repair Plan

2026-09-16 · English

[繁體中文 (default)](2026-09-16-intent-permission-root-cause-review-plan.md) · [简体中文](2026-09-16-intent-permission-root-cause-review-plan.zh-CN.md)

Status: Phase A is implemented and has passed its core desktop checks, and the routing-evidence increment has completed its core desktop verification. Phase B is now authorized from the L03/L04/L05 minimal-difference evidence to repair current-request single-file scope on branch `fix/simple-change-scope-roles`. C–E remain outside this implementation.

This file and the other two language variants are one authoritative plan. The valid evidence, calibrated conclusions, and future phases from the earlier repair plan and review archive have been merged here; separate legacy plans are no longer maintained. Evidence reports under `reports/` remain single-copy documents rather than being replicated by language.

## 1. Scope and confidence

### Current prerequisite: routing evidence

Branch: `fix/intent-routing-evidence`. Maintain the user's current goal, boundaries and changes. This item supplies evidence to locate interpretation drift; it does not implement a new task contract or classifier.

- Reuse existing `intent_completed` activities and session/run/event IDs with optional, versioned `routing_evidence`; no new log directory.
- Pass provenance from the branch actually taken: conversation shortcut, workspace constraint, postprocessed semantic classification, checkpoint or textual continuation. Never rerun keyword checks to infer provenance after the fact.
- Record classified intent, semantic degradation warning, effective intent and override reason, bound-execution-message versus clarification-context goal, single-file check not evaluated/matched/unmatched, and selected entry route. The execution message may refer to a historical request; it is not necessarily the raw text just submitted.
- The first increment covers existing intent-completion events. Early workspace gates, clarification returns and resumptions that suppress preambles may still lack this event. Missing evidence does not prove a stage ran or passed. Planner, permission audits and execution receipts remain separate existing evidence; this does not claim end-to-end instrumentation of every layer.
- New fields stay outside model context and contain no prompts, full user text, code or credentials. Missing legacy fields remain unknown. Technical details must be readable and export/log round trips must preserve evidence.
- Demonstrate the missing-field regression first, then check new/legacy records, true branch provenance, event correlation and desktop behavior. Mark unperformed verification NOT_RUN.

Design comparison: [OpenAI sandbox documentation](https://learn.chatgpt.com/zh-Hans/docs/sandboxing) separates technical boundaries from approval policy. Adopt the separation of classification, permission and execution facts, not its permission configuration or any inferred private Codex intent implementation. Observable approval requests and command exit codes in the current product are also distinct facts. Log fields never grant execution authority.

This plan covers CodePro intent recognition, task scheduling, tool-execution boundaries, and result reporting. It does not change Computer Use, Git, Mac, or search modules, and it does not widen Shell, interpreter, or path permissions.

Confirmed facts:

- In P04, the coding task changed `app.js`, while the Tester's requested `node -e` command was skipped by the host bounded-validation contract. The user did not request the skip, and no real approval request was pending.
- G03 and session `20260916_24` show that an explicit edit request can retain the previous turn's `read_only` intent and be routed to Planner. This belongs to Phase B, not Phase A.
- P01 shows that a simple edit can finish without running required validation. This belongs to Phase C1.
- Failure evidence from older revisions remains on disk. Cross-revision aggregation and retry belong to Phase E and are not solved by Phase A's single-task reporting change.

Similar symptoms are not forced into one root cause. Host policy denial, user denial, pending approval, incorrect routing, and omitted validation remain separate facts.

## 2. Entry points and call chain

The relevant desktop path is:

```text
user message
→ agent.rs identifies the current request and constraints
→ execution strategy selects simple change or an L2 DAG
→ task_scheduler.rs dispatches Coder / Tester and handles tool results
→ TaskOutput persists task facts
→ result_aggregator.rs aggregates run results
→ codepro_terminal_report.rs builds the user report
→ codepro_run_result.rs / desktop renders the terminal state
```

Permission evaluation and intent routing are separate layers. Correctly recognizing an edit request does not widen command permissions, and a policy denial does not imply that the user requested a skip.

## 3. External design comparison

As required by the repository, this design compares published behavior without inferring private implementations:

- [OpenAI Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security): adopt the separation of technical boundaries, approval policy, and execution receipts.
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model): adopt the guidance to infer user intent and task scope from instructions and prior context while making scope discipline explicit. This phase only separates edit targets, protection boundaries, and validation commands in the current message; it does not infer a private Codex parser or treat model prompting as path authorization.
- [OpenCode permission lifecycle](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/permission/index.ts): adopt explicit allow / ask / deny states and require a real pending request for approval UI.
- [Cline command guard](https://github.com/cline/cline/blob/82b8e1fa0471f728e3d9540fd19aa063e2049497/sdk/packages/core/src/extensions/tools/command-guard-extension.ts): adopt the principle that skipping one action need not terminate the whole task.

Rejected approaches: substituting model changes for deterministic rules, opening all interpreters, copying a simplistic blacklist, mechanically changing lifecycle `completed` to `failed`, or deleting old failure evidence.

## 4. Invariants for every phase

1. Write scope comes from the current request and a verifiable contract; paths in commands, examples, or quotations do not grant edit permission.
2. Routing does not grant new Shell permissions. Existing boundaries around `node -e`, compound commands, and arbitrary interpreters remain unchanged.
3. Not run, failed, and succeeded are distinct facts. A command that did not run keeps `exit_code = null`.
4. User-requested skip, host boundary, real pending approval, and user rejection are recorded separately.
5. File changes are labeled by subtask, turn, and whole-run scope.
6. A completed edit does not prove tests passed, and historical success does not prove the current file generation.
7. Missing fields in legacy state render as unknown; model text cannot manufacture user authorization.
8. Logging reuses session, run, task, and tool-call IDs and adds structured facts only for necessary error or security events.

## 5. Implementation order

### Phase A: trustworthy NOT_RUN provenance and report scope — implemented

- Add optional, versioned `ValidationNotRunEvidenceV1` to `TaskOutput`.
- Limit reasons to `user_requested`, `host_boundary`, and `unknown`.
- Only the scheduler can create this evidence from an observed branch; model prose cannot populate or override it.
- New reports prefer structured evidence. Legacy records without the field remain readable and render an unknown reason.
- Preserve the Coder's global file changes alongside the Tester's local “no changes”; static headings identify task, role, and subtask-only scope.
- Do not change routing, allowlists, approval policy, or cross-revision aggregation in this phase.

### Phase B: current-request intent and constraint scope — single-file scope repair in progress

L03/L04/L05 provide minimal-difference evidence: one real edit target qualifies for `simple_change`; naming an additional protected file incorrectly downgrades the route; two real edit targets must remain on ordinary `change`. Source review confirms that `classify_simple_change()` previously collected every path in the message without representing its semantic role.

This increment changes only the deterministic eligibility gate for the single-file fast path. It segments the current message by clause and scope marker into edit, protected, and command fragments; only paths in edit fragments count as targets. Longer, more specific protection markers win overlaps, while uncertain input still falls back to the ordinary route. This is not a new general intent classifier and does not modify semantic routing, Planner, permissions, allowlists, or approval policy.

Regression coverage includes L03's protected file, protection before the edit request, Chinese “do not modify test files,” English `modify/leave unchanged`, paths inside validation commands, and L05's real multi-file rejection. The pre-change focused run produced 39 passed and 2 failed; the minimal implementation produces 41 passed and 0 failed. Rebuilding the desktop backend and rerunning L03/L04/L05 remain completion gates.

### Phase C1: validation requirements for simple changes — awaiting authorization

Make the current turn's dynamic-validation requirement and explicit command exclusions part of the simple-change contract. “Edited and intentionally not validated” must remain distinct from omitted required validation.

### Phase C2: freshness of executed validation evidence — awaiting authorization

Record execution facts first, then decide whether later writes make them stale. Later writes cannot erase that a command ran, while old success cannot validate a new generation.

### Phase D: user-visible terminal state — awaiting authorization

Keep wire-protocol lifecycle semantics and correct only the UI meaning of PASS, NOT_RUN, pending approval, and recovery actions.

### Phase E: cross-revision history and retry — requires further design

Use stable acceptance identifiers to relate old failures, new edits, and new validation. Do not infer inheritance from task names or command strings, and never restore revoked permissions.

## 6. Phase A change scope

```text
crates/goose/src/agents/agent.rs
crates/goose/src/agents/codepro_run_result.rs
crates/goose/src/agents/codepro_terminal_report.rs
crates/goose/src/agents/result_aggregator.rs
crates/goose/src/agents/task_dag.rs
crates/goose/src/agents/task_scheduler.rs
crates/goose/tests/codepro_result_convergence.rs
crates/goose/tests/finding_candidate_contract.rs
```

No lockfile, Computer Use, Git, Mac, or search-module files were changed.

## 7. Phase A verification record

Focused tests:

- `task_dag::tests`: 82/82 passed.
- `result_aggregator::tests`: 40/40 passed.
- `codepro_terminal_report::tests`: 49/49 passed.
- `codepro_run_result::tests`: 17/17 passed.
- New scheduler provenance, redaction, mixed-reason, and scope tests passed.
- `task_scheduler::tests`: 185/187 passed. The two existing failures concern a Python dependency and an older host Node-test receipt outside the Phase A path.

Gate record:

- `cargo fmt --check` and `git diff --check` passed.
- `cargo clippy --all-targets -- -D warnings` reported only three existing `needless_borrows` findings in `load_hints.rs`.
- Full `cargo test -p goose --lib --jobs 1` did not go green on Windows because of existing PermissionDenied failures and one stack overflow.
- Desktop `typecheck` and `lint:check` passed. Vitest did not complete, and `format:check` found many existing formatting differences.
- The backend was rebuilt and the desktop launched according to README; the rebuilt binary hashes matched.

Real desktop sample `20260916_25` / `run_332218f4-8794-4fb7-8ce5-a3e5886fc6c2`:

- Coder changed `app.js` from `hello` to `hi`.
- The Tester's validation command was skipped at the host boundary and had no exit code.
- Persisted state recorded `reason=host_boundary`, the tool-call ID, and the original command.
- The final report preserved the `app.js` change, rendered NOT_RUN, and did not invent PASS or pending approval.
- After restarting the desktop and reopening the session, the report and file state remained intact.

## 8. Known low-priority items

- `validation_not_run.cwd` was `null` in the desktop sample, although the event and final report retained the correct project path.
- The visible report said there was no environment problem, while structured counts classified the host boundary as `environment_problem: 1`.
- Model-generated static advice guessed at a Node version without evidence and started a numbered list at 2.

These items do not currently prevent users from understanding what actually ran. Phase A will not be widened for them unless they cause concrete UI, analytics, or debugging impact.

## 9. Acceptance gates for later phases

- Add a reproducing regression before each minimal change.
- Run relevant Rust and desktop tests, format, lint, and build gates; record existing failures separately.
- Rebuild the backend, launch Electron, and verify visible behavior and restart persistence in a real window.
- Mark every unexecuted check explicitly; skips, zero-match filters, and static inspection are not passes.
- Require independent review and authorization for each phase. Phase B does not start automatically because Phase A is complete.
