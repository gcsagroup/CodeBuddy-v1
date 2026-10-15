# CodePro Analysis Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render CodePro technical evidence as a safe native fold and prevent zero-evidence analysis from being reported as successfully completed.

**Architecture:** Keep the existing backend report format for compatibility, but omit the technical block when it has no evidence. Add a bounded host-side correction for the first zero-evidence final answer and a deterministic incomplete result after the second. On the frontend, parse only the exact CodePro technical block and render it with native React elements; all inner text remains under the existing safe Markdown renderer.

**Tech Stack:** Rust, Tokio, React, TypeScript, Vitest, React Testing Library, `react-markdown`.

## Global Constraints

- Do not enable arbitrary raw HTML or add `rehype-raw`.
- A read-only analysis may retry at most once when it has no host evidence.
- A zero-evidence terminal result must say that analysis is incomplete and must not include a technical evidence block.
- Preserve existing CodePro task-panel report parsing and historical report compatibility.
- Do not modify unrelated dirty-worktree files.

---

### Task 1: Backend report omits empty technical evidence

**Files:**
- Modify: `crates/goose/src/agents/codepro_report.rs:86-156`
- Test: `crates/goose/src/agents/codepro_report.rs`

**Interfaces:**
- Consumes: `render_analysis_report(raw: &str, evidence: &[AnalysisReportEvidence]) -> String`
- Produces: the same report renderer, with a technical block only when at least one valid evidence item exists.

- [ ] **Step 1: Write a failing Rust unit test**

Add a test that calls `render_analysis_report` with an empty evidence slice and asserts that the result contains neither `<details>`, `<summary>`, nor `- 无。`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test -p goose codepro_report::tests::analysis_report_omits_empty_technical_evidence -- --exact`

Expected: FAIL because the current renderer always appends the block.

- [ ] **Step 3: Implement the minimal conditional block**

Build and append the technical section only after collecting at least one unique, non-empty evidence item. Preserve the current limit, escaping, and failure label.

- [ ] **Step 4: Run focused report tests and verify GREEN**

Run: `cargo test -p goose codepro_report::tests --lib`

Expected: all report tests pass.

- [ ] **Step 5: Commit the backend report slice**

Stage only `crates/goose/src/agents/codepro_report.rs` and commit with `fix: omit empty CodePro evidence block`.

### Task 2: Bound zero-evidence analysis correction

**Files:**
- Modify: `crates/goose/src/agents/agent.rs` in the read-only analysis completion branch
- Test: `crates/goose/src/agents/agent.rs`

**Interfaces:**
- Consumes: `CodeProAnalysisActivityTracker::report_evidence()` and the existing read-only executor loop.
- Produces: one corrective continuation when evidence is empty, followed by a deterministic incomplete terminal report if the next final answer is still empty.

- [ ] **Step 1: Write failing executor tests**

Add deterministic-provider tests covering:

1. First final answer has no tools, the host asks the provider to inspect the current project, the second turn uses a read-only tool, and the final report contains evidence.
2. Both attempts use no tools, the executor terminates with `CodePro 分析未完成`, contains no `<details>`, and makes exactly two provider turns.

- [ ] **Step 2: Run the two focused tests and verify RED**

Run the two exact `cargo test -p goose agents::agent::tests::<name> -- --exact` commands.

Expected: the current executor terminates after the first zero-tool answer.

- [ ] **Step 3: Implement a single retry state**

Track a boolean local to the unified executor. On the first zero-evidence final answer, append a host instruction requiring one or more read-only project inspections and continue. On the second, publish a deterministic incomplete report without passing the model text through `render_analysis_report`.

- [ ] **Step 4: Run focused executor tests and verify GREEN**

Run the new tests plus the existing read-only analysis executor tests.

- [ ] **Step 5: Commit the executor slice**

Stage only `crates/goose/src/agents/agent.rs` and commit with `fix: require evidence for CodePro analysis`.

### Task 3: Safe native technical evidence fold

**Files:**
- Modify: `ui/desktop/src/components/MarkdownContent.tsx`
- Test: `ui/desktop/src/components/MarkdownContent.test.tsx`

**Interfaces:**
- Produces: `splitCodeProTechnicalEvidence(content: string)` returning ordered Markdown and technical-evidence segments.
- Consumes: the existing safe `ReactMarkdown` configuration for every segment body.

- [ ] **Step 1: Write failing component tests**

Add tests asserting that:

1. The exact CodePro `<details>/<summary>` block becomes one native `details` element with the expected summary and evidence text.
2. Literal strings `<details>` and `</details>` are not visible for the recognized block.
3. An unrelated raw HTML string is still not executed or treated as a trusted CodePro fold.

- [ ] **Step 2: Run the focused frontend test and verify RED**

Run: `pnpm.cmd --dir ui/desktop exec vitest run src/components/MarkdownContent.test.tsx`

Expected: the native-fold assertion fails.

- [ ] **Step 3: Implement controlled segmentation and rendering**

Create a small parser that accepts only a complete block whose summary begins with `查看技术证据`. Render recognized blocks with a styled native `details` and `summary`; recursively render body Markdown through a shared safe Markdown component. Do not add raw-HTML plugins.

- [ ] **Step 4: Run frontend tests and type checking**

Run:

- `pnpm.cmd --dir ui/desktop exec vitest run src/components/MarkdownContent.test.tsx src/components/codepro/CodeProTaskPanel.test.ts`
- `pnpm.cmd --dir ui/desktop run typecheck`

Expected: all tests and type checking pass.

- [ ] **Step 5: Commit the frontend slice**

Stage only the Markdown component and its test, then commit with `fix: render CodePro evidence as safe fold`.

### Task 4: Final verification and review

**Files:**
- Verify only; no planned production edits.

**Interfaces:**
- Consumes all three completed slices.
- Produces verification evidence and a scoped change summary.

- [ ] **Step 1: Run Rust formatting checks on touched Rust files**

Run: `cargo fmt --all -- --check`

- [ ] **Step 2: Run focused Rust and frontend regression suites**

Run the report tests, read-only executor tests, Markdown tests, and task-panel parser tests.

- [ ] **Step 3: Run frontend type checking**

Run: `pnpm.cmd --dir ui/desktop run typecheck`

- [ ] **Step 4: Inspect the scoped diff and secrets**

Run `git diff --check` and inspect only files changed by this plan. Confirm no credentials, unrelated formatting, or user-owned changes are staged.

- [ ] **Step 5: Perform code-quality review**

Review security, state termination, retry bounds, accessibility, and compatibility. Fix only findings caused by this change and rerun the affected tests.
