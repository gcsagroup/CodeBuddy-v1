# Analysis Report Evidence Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ordinary project analysis reports from showing the unresolved `【详见技术证据】` placeholder while keeping full host evidence in the folded technical section.

**Architecture:** Keep the fix inside `codepro_report.rs`, where analysis text is already sanitized. Replace exact evidence values with a natural reference selected from the host evidence kind, then normalize any placeholder already present in model text. Continue rendering the original evidence objects in the existing `<details>` block.

**Tech Stack:** Rust, existing `goose` unit-test framework, Cargo.

## Global Constraints

- Do not modify the LLM-assisted terminal report pipeline, `ResultAggregator`, or other report families.
- Full paths and commands must remain absent from the beginner-facing body and present in folded host evidence.
- Use observable Codex UX only as a wording reference; do not infer private Codex internals.
- Add no dependency and no new LLM call.

---

### Task 1: Render natural host-evidence references

**Files:**
- Modify: `crates/goose/src/agents/codepro_report.rs:199`
- Test: `crates/goose/src/agents/codepro_report.rs:397`

**Interfaces:**
- Consumes: `AnalysisReportEvidence { kind: String, value: String, failed: bool }` and `sanitize_analysis_text(value: &str, evidence: &[AnalysisReportEvidence]) -> String`.
- Produces: `analysis_evidence_reference(kind: &str) -> &'static str`, returning `相关文件`, `相应检查`, or `相关证据`.

- [ ] **Step 1: Strengthen the existing analysis-report regression test**

Add these assertions to `analysis_report_normalizes_sections_and_folds_technical_evidence` after the existing body/technical split:

```rust
assert!(beginner.contains("认证入口缺少重试保护：相关文件。"));
assert!(beginner.contains("执行相应检查。"));
assert!(!beginner.contains("【详见技术证据】"));
```

Change the raw command sentence from `执行 rg --files D:/project。` to `执行rg --files D:/project。` so the replacement has deterministic Chinese spacing.

- [ ] **Step 2: Add a regression test for a model-supplied placeholder**

```rust
#[test]
fn analysis_report_normalizes_model_supplied_evidence_placeholder() {
    let report = render_analysis_report(
        "## 一句话结论\n已检查项目。\n\
         ## 项目用途和结构\n桌面代码代理。\n\
         ## 关键发现\n认证逻辑【详见技术证据】需要复核。\n\
         ## 风险和建议\n补充验证。",
        &[],
    );

    assert!(!report.contains("【详见技术证据】"), "{report}");
    assert!(report.contains("认证逻辑相关证据需要复核。"), "{report}");
}
```

- [ ] **Step 3: Run the focused tests to verify RED**

Run:

```powershell
cargo test -p goose --lib agents::codepro_report::tests::analysis_report_normalizes --jobs 1
```

Expected: the new natural-reference assertions fail because the current implementation emits `【详见技术证据】`.

- [ ] **Step 4: Implement the minimal kind-aware replacement**

Update the evidence loop in `sanitize_analysis_text` so it retains each item’s kind and value, sorts by value length, deduplicates by value, and replaces with:

```rust
fn analysis_evidence_reference(kind: &str) -> &'static str {
    match kind.trim() {
        "路径" => "相关文件",
        "命令" => "相应检查",
        _ => "相关证据",
    }
}
```

After evidence replacement, normalize model-supplied placeholders before existing claim and Markdown sanitization:

```rust
sanitized = sanitized.replace("【详见技术证据】", "相关证据");
```

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```powershell
cargo test -p goose --lib agents::codepro_report::tests::analysis_report_normalizes --jobs 1
```

Expected: both matching tests pass.

- [ ] **Step 6: Format and run the report-module tests**

Run:

```powershell
cargo fmt --all -- --check
cargo test -p goose --lib agents::codepro_report::tests --jobs 1
```

Expected: formatting check exits 0 and all `codepro_report` tests pass.

- [ ] **Step 7: Run full Rust verification**

Run:

```powershell
cargo test -p goose --lib --jobs 1
cargo clippy -p goose --lib -- -D warnings
```

Expected: 0 test failures and 0 Clippy errors.

- [ ] **Step 8: Verify the desktop workflow**

Rebuild and launch the Electron desktop from the changed source. Submit a normal read-only project-analysis request containing evidence-backed paths and commands. Verify the visible four-section report contains natural references, contains no `【详见技术证据】`, and the folded evidence retains the full original values.

- [ ] **Step 9: Commit the isolated fix**

Stage only `crates/goose/src/agents/codepro_report.rs`, inspect the staged diff and commit:

```powershell
git add -- crates/goose/src/agents/codepro_report.rs
git diff --cached --check
git commit -m "fix: render natural analysis evidence references"
```
