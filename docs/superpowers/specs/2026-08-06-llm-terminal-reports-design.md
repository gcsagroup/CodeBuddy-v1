# LLM-Assisted Terminal Reports Design

## Context

CodePro currently has readable templates for successful analysis, test, and fix runs, but terminal paths are inconsistent. Normal runs use `ResultAggregator`; Planner and scheduler failures return raw internal errors; Reviewer failures are appended to otherwise unrelated sections. Verification is grouped by command text, so equivalent attempts may surface as both passed and failed. The displayed project path is also derived from the session working directory even when an operation targets another directory.

Codex's public product guidance emphasizes concise task results backed by inspectable changes, terminal logs, and test evidence. CodePro will adopt that interaction principle without copying a private or undocumented Codex report schema.

## Goal

Every terminal CodePro outcome must produce a concise natural-language report whose factual claims are derived from host evidence. An LLM may improve wording, but it must not decide completion, invent evidence, alter counts, or hide limitations.

## Scope

The design covers:

- successful analysis, test, and change runs;
- partially completed, paused, and cancelled runs;
- Planner, scheduler, and Reviewer failures;
- file, path, verification, review, and diagnostic evidence;
- deterministic fallback when report rewriting is unavailable or invalid.

It does not redesign task cards, activity streaming, the model settings UI, Coordinator authority, or the underlying execution scheduler.

## Approaches considered

### Free-form LLM rewrite

The LLM reads logs and Worker summaries and writes Markdown. This produces natural prose but can change numbers, promote unverified claims, omit limitations, or contradict host evidence. Rejected.

### Deterministic templates only

The host renders all wording directly from structured state. This is stable and testable but remains visibly mechanical. Retained as the mandatory fallback, not the primary user experience.

### Evidence-constrained LLM renderer (selected)

The host first computes immutable report facts and an evidence registry. The LLM returns a small JSON draft containing prose plus evidence references. The host validates every claim, renders Markdown itself, and falls back to deterministic wording on any error.

## Architecture

The terminal reporting pipeline becomes:

```text
runtime state + host evidence
        |
        v
CodeProReportFacts
        |
        +--> deterministic fallback draft
        |
        v
ReportWriterAgent (one bounded LLM call, no tools)
        |
        v
ReportDraftV1 JSON
        |
        v
host validator
        |
        +--> invalid / timeout / no final text --> fallback draft
        |
        v
deterministic Markdown renderer
```

### `CodeProReportFacts`

The host-owned fact model contains:

- terminal outcome: `completed`, `partial`, `paused`, `cancelled`, `planning_failed`, `scheduling_failed`, `review_failed`, or `failed`;
- task kind and a host-authored completion policy result;
- trusted project root from the run location/evidence root;
- current changed files from run-scoped filesystem evidence;
- one final verification verdict per acceptance task;
- bounded prior verification attempts for technical details only;
- Reviewer verdict;
- limitations, environment problems, and recommended recovery action;
- a registry of opaque evidence IDs to exact host facts;
- a typed recovery action: `none`, `retry_planning`, `continue_checkpoint`, `retry_validation`, `retry_review`, `select_project_directory`, or `manual_review`;
- the application report locale, initially `zh-CN` by default.

Worker prose is not a source for completion, file, command, count, path, or review facts. It may supply a candidate user-visible change description only when it does not conflict with host evidence.

### Verification convergence

User-visible verification is aggregated by acceptance task, not command string. Each task has one terminal verdict selected from its current run state and latest host-recorded verification sequence. Older or syntactically different commands remain in technical evidence.

If a task has both passing and failing current verification records and the host cannot establish ordering, its visible verdict is `unverified`, never both passed and failed.

### Control-plane authority

When a control-plane convergence assessment is available, it is authoritative over legacy DAG inference:

```text
durable or shadow: convergence assessment -> run state -> DAG fallback
legacy:            run state -> DAG fallback
```

An `InProgress` or `Blocked` convergence verdict can never be rendered as completed. Legacy inference remains available only when the control plane has no authoritative assessment.

### Trusted paths

The displayed project root comes from the run's trusted location and must match the evidence root. File claims are relative to that root. Commands may retain their actual host-recorded working directories in technical evidence.

Operations outside the trusted root are not reported as trusted project changes. The visible report instead adds a limitation stating that an out-of-workspace operation was detected or could not be included in verified changes. Drive-root scopes such as `E:\**` are never presented as normal project roots.

## LLM contract

The report writer receives only bounded structured facts and allowed evidence IDs. It has no tools and makes at most one model call. The default route reuses the configured Reviewer model so the Beta does not add a fifth required model setting.

The response must be one `ReportDraftV1` JSON object:

```json
{
  "schema_version": 1,
  "summary": "已修复减法计算错误，并完成回归验证。",
  "changes": [
    {
      "text": "修正 calculator.js 中的减法逻辑。",
      "evidence_refs": ["file-1"]
    }
  ],
  "verification": [
    {
      "text": "3 项测试全部通过。",
      "evidence_refs": ["verify-1"]
    }
  ],
  "limitations": [],
  "next_step": null
}
```

The provider must return final text. Reasoning-only output, the sentinel `No text content in last message`, Markdown fences that cannot be safely removed, malformed JSON, or action-limit text invalidates the rewrite and immediately selects the fallback. Reasoning content is never exposed or treated as the final report.

## Host validation

Validation is fail-closed:

1. Every item must reference at least one allowed evidence ID.
2. Every referenced ID must exist and be compatible with the section.
3. Evidence type compatibility is strict: file evidence cannot substantiate verification, and command evidence cannot substantiate review approval.
4. Structured counts, statuses, paths, and identifiers are validated exactly at the JSON boundary; prose is not required to repeat host facts word-for-word.
5. Completion language is allowed only when the host completion policy says the run is complete.
6. Passing language is forbidden for failed, unavailable, missing, or ambiguous verification.
7. A non-approved or missing Reviewer verdict cannot be described as approved.
8. Limitations present in host facts cannot be omitted or weakened into success language.
9. The draft is bounded by section, item, line, and character limits.
10. Markdown headings, HTML, code fences, and diagnostic internals in LLM fields are escaped by the renderer.

Natural-language validation is intentionally prohibition-based rather than a general fact-extraction engine. It rejects forbidden completion, passing, approval, and omission patterns, while typed fields and evidence references carry exact facts.

Validation failure is a report-rendering event, not a task failure. It cannot change the already established run status.

## User-visible rendering

The host renders the validated or fallback draft. The first paragraph answers the outcome in natural language. Only non-empty sections appear.

The first release uses the application locale, defaulting to `zh-CN`; it does not switch the whole report because one user message happens to use another language. The visible body is limited to 1,500 Chinese characters, the summary to two sentences, and each visible section to five items. Technical evidence has a separate bounded limit.

Typical report:

```markdown
已修复 subtract 的计算错误，并补充了回归验证。修改已经写入当前项目，现有测试全部通过。

### 改动

- 修正 `src/calculator.js` 中的减法逻辑。

### 验证

- `npm test` 最终通过，共运行 3 项测试，没有失败。

<details>
<summary>技术证据</summary>

- 项目：`D:\project`
- 文件：`src/calculator.js`
- 命令：`npm test`
- 退出码：0
- Reviewer：通过

</details>
```

The renderer keeps a `# CodePro ...` title in message metadata or Markdown where required by existing UI detection, but avoids a dense checklist in the visible body.

## Failure reports

All early returns build facts and pass through the same renderer.

### Planning failure

The visible summary states that no project modification began, the planning stage could not produce a safe plan, and files remain unchanged when the baseline confirms that fact. Planner schema errors, model names, previews, and run IDs remain in technical diagnostics.

The typed recovery action is normally `retry_planning`, or `select_project_directory` when a trusted project root is missing or unsafe.

### Scheduling failure

The summary distinguishes completed changes from unfinished tasks. It never announces completion while tasks remain failed, paused, or without evidence.

The recovery action is `continue_checkpoint` when a valid checkpoint exists, otherwise `retry_validation` or `manual_review` according to host state.

### Reviewer failure

The summary states that changes and verification may exist but independent review is incomplete. The run cannot use completion wording until an approved verdict exists.

The recovery action is `retry_review` when the review is safely replayable, otherwise `manual_review`.

### Report-writer failure

The run keeps its original terminal status and uses deterministic wording. A diagnostic event records why LLM rewriting was skipped or rejected.

The first release records rewrite attempts, success, failure class, and latency. It does not add a persisted health score, circuit breaker, or user-facing “template mode” indicator until observed failure data justifies those mechanisms.

## Structured terminal payload

Markdown is presentation, not the report protocol. `TurnTerminal` gains an additive, optional structured report summary so existing consumers remain compatible while the desktop can render badges and actions without parsing Markdown:

```json
{
  "outcome": "planning_failed",
  "classification_counts": {
    "confirmed_bug": 0,
    "test_failure": 0,
    "environment_problem": 0,
    "codepro_incomplete": 1,
    "unverified": 0
  },
  "changed_files": [],
  "verification_summary": [],
  "limitations": ["planning_unavailable"],
  "recovery_action": "retry_planning"
}
```

The field is optional during migration. Its Rust and TypeScript schemas use the same names and closed enum values. Unknown future fields are tolerated, while invalid known fields reject only the structured report extension rather than hiding the visible terminal message.

## Compatibility and rollout

- Existing `ResultAggregator` evidence extraction remains initially and is adapted into `CodeProReportFacts`.
- Existing report headings accepted by `MarkdownContent` remain compatible during rollout.
- The LLM rewrite is enabled by default for CodePro terminal reports, with deterministic fallback always active.
- An advanced setting may disable natural-language rewriting later; it is not required for the first implementation.
- No new model configuration is required in the Beta.

## Testing

### Unit tests

- fact construction for every terminal outcome;
- acceptance-task verification convergence;
- ambiguous pass/fail becomes unverified;
- path/evidence-root validation;
- draft schema and evidence-reference validation;
- forbidden completion, passing, review, path, and numeric claims;
- limitation preservation;
- deterministic fallback rendering;
- Markdown/HTML injection escaping.

### Integration tests

- successful fix with changed files, passing tests, and approved review;
- Planner failure before execution;
- scheduler failure after partial file changes;
- Reviewer failure after passing tests;
- reasoning-only, empty, malformed, timed-out, and contradictory LLM responses;
- equivalent commands with an old failure and final success produce one visible verdict;
- out-of-workspace target does not produce a false trusted path or file claim;
- authoritative convergence `Blocked` or `InProgress` cannot render completion;
- a schema-valid draft with sarcastic, excessively apologetic, or success-weakening language is rejected or sanitized;
- an existing but section-incompatible evidence ID is rejected;
- repeated evidence references are deduplicated without losing required limitations;
- the Rust and TypeScript `TurnTerminal.report` contracts accept the same valid fixture and reject the same invalid known fields.

### Desktop acceptance

After automated tests pass, run one real Windows flow for a successful bug fix and one forced Planner/report-writer failure. Confirm that the active conversation shows a natural summary, inspectable evidence, no contradictory verdicts, and the correct trusted project path.

## Acceptance criteria

- Every terminal outcome produces a user-readable report.
- No raw Planner, scheduler, Reviewer, provider, or Rust error appears in the visible summary.
- LLM wording cannot alter host outcome, counts, paths, files, or verification status.
- A report-writer failure never changes task success or prevents report delivery.
- Each acceptance task has at most one user-visible verification verdict.
- Trusted project paths and changed files come from run-scoped host evidence.
- Technical evidence remains available in a collapsed section.
- `TurnTerminal` carries an optional structured report summary for downstream UI rendering.
- Existing report and CodePro lifecycle tests remain passing.

## Risks and mitigations

- **Latency:** one bounded terminal call only; deterministic timeout fallback.
- **Provider incompatibility:** strict final-text requirement and no reasoning extraction.
- **Hallucination:** evidence references, lexical fact checks, and fail-closed fallback.
- **Prompt injection from logs:** raw logs are not placed in narrative fields; diagnostic strings are data and are not instructions.
- **Migration complexity:** introduce the fact model and renderer behind existing report entry points before removing old templates.

## Reference

- OpenAI, “Introducing Codex”: https://openai.com/index/introducing-codex/
