# LLM-Assisted Terminal Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inconsistent CodePro terminal output with a host-authoritative, natural-language report that carries a structured `TurnTerminal.report` payload and always falls back to a deterministic renderer.

**Architecture:** Runtime state is first normalized into `CodeProReportFacts`, including one visible verification verdict per acceptance task and a typed evidence registry. A no-tools `ReportWriterAgent` may return a bounded `ReportDraftV1`; the host validates evidence references and forbidden claims, then renders Markdown itself. Invalid, empty, timed-out, or unavailable model output uses the same deterministic fallback draft without changing the run outcome.

**Tech Stack:** Rust, Tokio, Serde/serde_json, existing Goose subagent routing, TypeScript, Zod-like manual validators, Vitest, Tauri/React desktop UI.

## Global Constraints

- Work only in `D:\CodeBuddy\.worktrees\llm-terminal-reports` on branch `feature/llm-terminal-reports`.
- Keep all existing user work in the main worktree untouched.
- Default report locale is `zh-CN`.
- The report writer gets one bounded model call, no tools, and no provider fallback chain.
- Host facts alone determine outcome, counts, paths, files, verification, review, and limitations.
- Visible report body is at most 1,500 Chinese characters; summary is at most two sentences; each visible section has at most five items.
- Existing terminal consumers must remain compatible; `TurnTerminal.report` is additive and optional.
- Use test-driven development for every behavior change and commit each independently testable slice.

---

## File Structure

- Create `crates/goose/src/agents/codepro_terminal_report.rs`: fact types, evidence registry, verification convergence, fallback draft, validation, Markdown rendering, and structured payload.
- Create `crates/goose/src/agents/report_writer_agent.rs`: one-call LLM adapter and strict final-text/JSON parsing.
- Modify `crates/goose/src/agents/mod.rs`: register the two focused modules.
- Modify `crates/goose/src/agents/codepro_run_result.rs`: expose ordered per-task verification evidence needed by the fact builder.
- Modify `crates/goose/src/agents/agent.rs`: route every CodePro terminal path through the new pipeline and attach `TurnTerminal.report`.
- Modify `ui/desktop/src/types/turnTerminal.ts`: add the optional structured report contract and tolerant validation.
- Create `ui/desktop/src/types/turnTerminal.test.ts`: shared valid/invalid payload fixtures and backwards-compatibility coverage.

### Task 1: Host-Owned Report Contracts

**Files:**
- Create: `crates/goose/src/agents/codepro_terminal_report.rs`
- Modify: `crates/goose/src/agents/mod.rs`

**Interfaces:**
- Produces: `CodeProTerminalOutcome`, `ReportRecoveryAction`, `ReportEvidenceKind`, `ReportEvidence`, `VerificationVerdict`, `VerificationSummary`, `ClassificationCounts`, `CodeProTerminalReportPayload`, `CodeProReportFacts`, `ReportDraftItem`, and `ReportDraftV1`.
- All wire enums serialize with `#[serde(rename_all = "snake_case")]`; `ReportDraftV1.schema_version` must equal `1`.

- [ ] **Step 1: Write failing serialization and invariant tests**

Add module tests that assert exact JSON values for all outcome/recovery enums, reject draft schema versions other than `1`, and serialize a payload with these exact keys: `outcome`, `classification_counts`, `changed_files`, `verification_summary`, `limitations`, `recovery_action`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cargo test -p goose codepro_terminal_report::tests --lib -- --nocapture`

Expected: compilation fails because `codepro_terminal_report` and its types do not exist.

- [ ] **Step 3: Implement the minimal typed contracts**

Use owned strings in wire payloads, `PathBuf` only inside host facts, and an ordered `BTreeMap<String, ReportEvidence>` registry so rendering and tests are deterministic. Keep diagnostic text out of `CodeProTerminalReportPayload`.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `cargo test -p goose codepro_terminal_report::tests --lib -- --nocapture`

Expected: all contract tests pass.

- [ ] **Step 5: Commit the slice**

Run: `git add crates/goose/src/agents/mod.rs crates/goose/src/agents/codepro_terminal_report.rs && git commit -m "feat: define terminal report contracts"`

### Task 2: Fact Construction and Verification Convergence

**Files:**
- Modify: `crates/goose/src/agents/codepro_terminal_report.rs`
- Modify: `crates/goose/src/agents/codepro_run_result.rs`

**Interfaces:**
- Consumes: `CodeProRunResult`, `CodeProRunStatus`, optional `ConvergenceAssessment`, trusted evidence root, task kind, and checkpoint availability.
- Produces: `build_report_facts(input: ReportFactsInput<'_>) -> CodeProReportFacts` and `final_verification_by_task(run: &CodeProRunResult) -> Vec<VerificationSummary>`.

- [ ] **Step 1: Write failing fact-policy tests**

Cover: latest ordered success supersedes an older failure; unordered conflicting current records become `unverified`; missing evidence is `unverified`; authoritative `Blocked`/`InProgress` convergence cannot produce `completed`; a path outside the canonical evidence root is omitted and adds `out_of_workspace_operation`; planning failure with no writes selects `retry_planning` and zero changed files.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cargo test -p goose codepro_terminal_report::tests --lib -- --nocapture`

Expected: failures identify missing fact builder and convergence logic.

- [ ] **Step 3: Implement host policy and task-level convergence**

Determine outcome in this order: authoritative convergence assessment, persisted run status, then legacy DAG fallback. Collapse verification by acceptance task ID, retaining command-level history only as evidence. Canonicalize the trusted root once; include only relative changed paths proven beneath it.

- [ ] **Step 4: Run affected Rust tests and confirm GREEN**

Run: `cargo test -p goose codepro_terminal_report::tests --lib -- --nocapture`

Run: `cargo test -p goose codepro_run_result --lib -- --nocapture`

Expected: new policy tests and existing run-result tests pass.

- [ ] **Step 5: Commit the slice**

Run: `git add crates/goose/src/agents/codepro_terminal_report.rs crates/goose/src/agents/codepro_run_result.rs && git commit -m "feat: build host-authoritative report facts"`

### Task 3: Deterministic Draft, Validation, and Markdown Rendering

**Files:**
- Modify: `crates/goose/src/agents/codepro_terminal_report.rs`

**Interfaces:**
- Produces: `fallback_draft(facts: &CodeProReportFacts) -> ReportDraftV1`, `validate_draft(facts: &CodeProReportFacts, draft: &ReportDraftV1) -> Result<(), ReportValidationError>`, `render_report(facts: &CodeProReportFacts, draft: &ReportDraftV1) -> String`, and `terminal_payload(facts: &CodeProReportFacts) -> CodeProTerminalReportPayload`.

- [ ] **Step 1: Write failing fallback and adversarial tests**

Assert that all eight outcomes render readable Chinese summaries; every host limitation survives; incompatible or unknown evidence IDs fail; completed/passed/approved wording fails when host state forbids it; headings, HTML, code fences, raw provider errors, and diagnostics are escaped or excluded; duplicate evidence refs deduplicate; body/item/sentence limits are enforced.

- [ ] **Step 2: Run tests and confirm RED**

Run: `cargo test -p goose codepro_terminal_report::tests --lib -- --nocapture`

Expected: failures identify the missing fallback, validator, and renderer.

- [ ] **Step 3: Implement the deterministic pipeline**

Build every fallback item from typed facts and attach compatible evidence refs. Validate section compatibility and required limitation coverage structurally; use a small explicit Chinese/English forbidden-claim vocabulary only for completion, pass, and approval claims. Escape model text before Markdown assembly, and keep diagnostics inside a bounded collapsed `<details>` block built from host evidence only.

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `cargo test -p goose codepro_terminal_report::tests --lib -- --nocapture`

Expected: all rendering and adversarial tests pass.

- [ ] **Step 5: Commit the slice**

Run: `git add crates/goose/src/agents/codepro_terminal_report.rs && git commit -m "feat: render validated terminal reports"`

### Task 4: Cross-Platform `TurnTerminal.report` Contract

**Files:**
- Modify: `ui/desktop/src/types/turnTerminal.ts`
- Create: `ui/desktop/src/types/turnTerminal.test.ts`
- Modify: `crates/goose/src/agents/agent.rs`

**Interfaces:**
- Consumes: `CodeProTerminalReportPayload` from Task 1.
- Produces: optional TypeScript `TurnTerminal.report?: TurnTerminalReport`; Rust terminal message JSON with the same field names and enum values.

- [ ] **Step 1: Write failing TypeScript compatibility tests**

Cover a valid structured report, legacy terminal payload with no report, unknown future fields, invalid known outcome/recovery/verification enum values, and an invalid report extension that is dropped while the visible terminal message remains valid.

- [ ] **Step 2: Run the TypeScript test and confirm RED**

Run from `ui/desktop`: `pnpm test:run src/types/turnTerminal.test.ts`

Expected: compile/test failure because `report` is not defined.

- [ ] **Step 3: Implement tolerant TypeScript parsing and Rust attachment**

Parse the base terminal message first. Parse `report` separately; when its known fields are invalid, return the valid base terminal object without `report`. Extend `build_codepro_report_message` to accept an optional payload and map completed/failed/interrupted states without changing existing paused checkpoint behavior.

- [ ] **Step 4: Run cross-side tests and type checking**

Run from `ui/desktop`: `pnpm test:run src/types/turnTerminal.test.ts`

Run from `ui/desktop`: `pnpm typecheck`

Run: `cargo test -p goose build_codepro_report_message --lib -- --nocapture`

Expected: compatibility, type checking, and Rust message tests pass.

- [ ] **Step 5: Commit the slice**

Run: `git add ui/desktop/src/types/turnTerminal.ts ui/desktop/src/types/turnTerminal.test.ts crates/goose/src/agents/agent.rs && git commit -m "feat: attach structured terminal report payloads"`

### Task 5: Bounded `ReportWriterAgent`

**Files:**
- Create: `crates/goose/src/agents/report_writer_agent.rs`
- Modify: `crates/goose/src/agents/mod.rs`

**Interfaces:**
- Consumes: serialized bounded `CodeProReportFacts`, allowed evidence IDs, and the configured `AgentRole::Reviewer` route.
- Produces: `ReportWriterAgent::rewrite(&self, facts: &CodeProReportFacts) -> Result<ReportDraftV1, ReportWriterError>`.

- [ ] **Step 1: Write failing parser and boundary tests**

Cover exact JSON, a single removable JSON fence, malformed JSON, schema mismatch, empty final text, `No text content in last message`, reasoning/action-limit sentinel text, and oversized output. Assert that parsing never reads reasoning fields as final text.

- [ ] **Step 2: Run tests and confirm RED**

Run: `cargo test -p goose report_writer_agent::tests --lib -- --nocapture`

Expected: compilation fails because the writer does not exist.

- [ ] **Step 3: Implement one-call no-tools rewriting**

Resolve only `AgentRole::Reviewer`, create an isolated subagent session with no extensions/tools, request `return_last_only`, cap turns at 8, wrap execution in a 30-second Tokio timeout, and make no secondary provider/model call. Return typed failure classes for unavailable route, timeout, empty text, malformed JSON, and validation-ready parse failures. Record attempt, success/failure class, and latency through tracing without logging full facts or model prose.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `cargo test -p goose report_writer_agent::tests --lib -- --nocapture`

Expected: all parser and boundary tests pass.

- [ ] **Step 5: Commit the slice**

Run: `git add crates/goose/src/agents/mod.rs crates/goose/src/agents/report_writer_agent.rs && git commit -m "feat: add bounded terminal report writer"`

### Task 6: Integrate Every CodePro Terminal Path

**Files:**
- Modify: `crates/goose/src/agents/agent.rs`
- Modify: `crates/goose/src/agents/result_aggregator.rs`

**Interfaces:**
- Consumes: Tasks 1-5 through a single async helper `build_terminal_report_message(TerminalReportRequest<'_>) -> Message`.
- Produces: uniform reports for completed, partial, paused, planning failure, scheduling failure, review failure, and generic failure paths.

- [ ] **Step 1: Write failing integration tests for terminal outcomes**

Add tests for: successful fix with files/pass/review; Planner failure before writes; scheduler failure after partial writes; Reviewer failure after passing tests; report-writer timeout/invalid output using fallback; authoritative blocked convergence; and old-fail/new-pass verification appearing once. Assert that visible summaries contain no raw Rust/provider/schema errors and terminal JSON carries the structured payload.

- [ ] **Step 2: Run focused integration tests and confirm RED**

Run: `cargo test -p goose terminal_report --lib -- --nocapture`

Expected: current early-return paths bypass the unified renderer and fail assertions.

- [ ] **Step 3: Route normal and early-return paths through one helper**

Build facts before composing visible text. Attempt one rewrite, validate it, and use `fallback_draft` on every writer/validation error. Preserve the already-established run status. Keep legacy `ResultAggregator` extraction available during migration, but remove it as the source of visible terminal wording once all covered paths use the helper.

- [ ] **Step 4: Run related Rust tests and confirm GREEN**

Run: `cargo test -p goose terminal_report --lib -- --nocapture`

Run: `cargo test -p goose result_aggregator --lib -- --nocapture`

Run: `cargo test -p goose codepro_run_result --lib -- --nocapture`

Expected: new integrations and existing lifecycle/report tests pass.

- [ ] **Step 5: Commit the slice**

Run: `git add crates/goose/src/agents/agent.rs crates/goose/src/agents/result_aggregator.rs && git commit -m "feat: unify CodePro terminal reporting"`

### Task 7: Full Verification and Windows Desktop Acceptance

**Files:**
- Modify only files required to fix issues found during verification.

**Interfaces:**
- Produces: evidence that Rust, desktop contracts, fallback behavior, and two real Windows terminal flows satisfy the acceptance criteria.

- [ ] **Step 1: Run formatting, compilation, and automated suites**

Run: `cargo fmt --all -- --check`

Run: `cargo check -p goose`

Run: `cargo test -p goose codepro_terminal_report --lib -- --nocapture`

Run: `cargo test -p goose report_writer_agent --lib -- --nocapture`

Run: `cargo test -p goose result_aggregator --lib -- --nocapture`

Run from `ui/desktop`: `pnpm test:run src/types/turnTerminal.test.ts`

Run from `ui/desktop`: `pnpm typecheck`

Run from `ui/desktop`: `pnpm format:check`

Expected: every command exits with code 0.

- [ ] **Step 2: Perform real Windows desktop acceptance**

Launch the desktop build from this worktree. Run one small bug-fix flow that changes a file and passes verification, then force one report-writer failure or Planner failure. Confirm natural Chinese summary, one final verification verdict per task, correct trusted path, inspectable technical evidence, no raw internal error in the visible summary, and deterministic fallback delivery.

- [ ] **Step 3: Review the diff for correctness and scope**

Inspect: `git diff --check` and `git diff 0128a6b6d...HEAD`.

Apply the `code-review-and-quality` and `verification-before-completion` skills. Fix only concrete issues, rerun the affected verification, and record any deferred non-blocking limitation in the design document.

- [ ] **Step 4: Commit verification fixes if needed**

Run: `git add <only-files-changed-by-verification> && git commit -m "fix: harden terminal report integration"`

If no files changed, do not create an empty commit.

