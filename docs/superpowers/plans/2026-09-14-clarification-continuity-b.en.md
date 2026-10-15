# Ordinary clarification goal continuity: batch B

## Current status: v40, automated tests passed, release acceptance incomplete

2026-09-14 13:37: All 55 ACP tests, 3 + 11 control integration tests, and formatting passed. The complete core library suite passed 3286 tests with 0 failures and 2 ignored. Plain-continuation coverage includes paused/cancelled recovery, the same run ID and full goal, retained consumed budget, no replay after completion, and rejection of foreign workspace/session bindings. Earlier pauses came from a fixture that added historical runs after the server started, bypassing its scheduling-gate initialization. Actual startup recovery followed by LoadSession resolved that fixture problem without relaxing production permissions.

Resources have returned to the supervisor for the gateway model-connection fix. Clippy started automatically after the preceding stage and was interrupted; it is neither a pass nor a failure. This batch's backend build, independent native desktop acceptance, and installer remain incomplete. Passed results refer to the frozen source before the gateway fix and do not establish subsequent integrated acceptance. Evidence: `.cargo/evidence/clarification-continuity-b-20260914/gates-v40-summary.json`, `source-v40.json`, and `handoff-v40-paused-for-gateway.json`. Original B completion evidence remains untouched.

## Historical v33 status

2026-09-14: Source is frozen. The supervisor has the shared build and desktop window for priority Git integration acceptance. v26 passed relevant focused tests, formatting, full all-targets clippy, and CLI build. Exact commands and results are in the evidence directory's `gates-v26-summary.json` and `control-integration-v26.json`.

In original B session 20260914_6, a real desktop input of “继续” reran the original Node test command with exit 0 and completed the original DAG. Original Coder outputs, contracts, budgets, and three project files remained unchanged. A verified cold restart retained one new completed report without repeating execution. However, ACP incorrectly registered a new execution ID with only “继续” as its control goal, while clarification retained the old ID. Full acceptance remains incomplete; original B completion evidence is sealed.

The v29 regression through the real ACP request path reproduced duplicate registration: expected 1, actual 2. With the v30 fix, assertions for the original execution ID, full goal, and registration count passed. The entire v33 test still exited 101 (0 passed, 1 failed): subsequent execution paused instead of satisfying Completed. Read-only inspection found the fixture lacks an explicit dynamic-verification description and a discoverable project test entry point. This does not yet explain every pause condition. Correct the fixture and inspect durable events without weakening completion assertions or production permissions.

After resources return, finish regression, ACP/control gates, clippy, build, and real desktop acceptance with an independent controlled interruption, including no action replay on continuation after completion. The current backend remains v26 and does not contain the v30 fix; the installer is unchanged. This batch does not establish individual live acceptance of every toolbox tool.

Current evidence: `.cargo/evidence/clarification-continuity-b-20260914/source-v33-frozen-for-git.json`, `handoff-v33-paused-for-git.json`, and `native-v8/b-v26-acceptance-incomplete.json`. Earlier A/C evidence remains preserved.

## Historical status and original plan (not current acceptance conclusions)

Date: 2026-09-14. Acceptance is ongoing; this batch is not complete. v19 passed 80 DAG, 37 repair, and 19 continuity tests (overlapping filters, not additive), fmt, full all-targets clippy, and CLI build. Actual qwen3.5:397b / v19 desktop evidence: A session 20260914_1 retained the original goal after only “邮箱”, changed source and test, and obtained a real host test exit 0. A separate frontend task is fixing its duplicate visible report; overall acceptance is not complete. B session 20260914_6 survived a real cold reopen; only “继续” repeated the original channel question, and “短信” resumed the original goal. The real failed-test repair inherited both originally authorized source and test paths and filled the omitted source edit, but retesting rejected its own saved absolute Windows Node path and remains paused. C session 20260914_13 replaced the edit goal with a read-only package.json question: old clarification closed, replacement read_only/finished, one actual read_document call, zero test executions, all three baseline hashes unchanged. Electron/backend were then closed and the renderer released. A valid command replay RED reproduced the exact error (0 passed, 1 failed); the minimal v21 fix and related gates are in progress, preserving the original paused B session for resume acceptance. Evidence is under `.cargo/evidence/clarification-continuity-b-20260914/`. Earlier v9 results (3274 library tests passed, 2 ignored; 123 ACP/control passed) are historical gates, not full v21 acceptance. The plan and line references below are historical.

[繁體中文 (default)](2026-09-14-clarification-continuity-b.md) · [简体中文](2026-09-14-clarification-continuity-b.zh-CN.md)

## Objective and scope

A user supplies a goal, the agent asks for a consequential choice, and a short answer resumes that goal with the additional constraint. For example: “Add verification codes to the current login flow; ask me which kind first” → “SMS or email?” → “Email.” The executor and Planner must receive the original login requirement and the email constraint, rather than treating “Email” as a standalone project goal.

This batch covers only ordinary `CodeProExecutionRoute::Clarify` continuity. It does not reopen accepted A checkpoint input, test-command authorization, or UI replay. Cancellation versus legacy run-state projection synchronization is a separate immediately following batch. In B, `cancel` invalidates a pending clarification link; it must not silently redesign existing run cancellation. Toolbox, streaming display, and other modules are out of scope.

## Verified current behavior

Line numbers refer to this read-only snapshot and must be refreshed before implementation.

| Location | Fact and implication |
|---|---|
| `crates/goose/src/agents/agent.rs:8444` | Clarify saves the assistant question text and returns, without a structured question-to-source-goal link. |
| `crates/goose/src/agents/agent.rs:8668` | Intent routing receives the last 6 messages, each limited to its final 2000 characters. History context is not durable pending-goal state. |
| `crates/goose/src/agents/agent.rs:8117` | Execution takes its goal from the current user message; a new DAG and run state also use that goal. |
| `crates/goose/src/agents/agent.rs:2409` | Source-message restoration handles `ResumeAfterWorkspace`, not ordinary clarification answers. |
| `crates/goose/src/agents/agent.rs:13702` | Existing coverage checks history sent to intent routing, not the goal delivered to the actual Planner/DAG. |
| `crates/goose/src/agents/codepro_intent.rs:678` | The decision contains intent, clarification, and public_summary, but no answer-to-question relationship. |

Batch B RED has not run. These are source findings, not a new native reproduction result.

## Minimal implementation direction

1. Persist a typed, versioned pending clarification record bound to the session, source user message ID, assistant question message ID, workspace, and current state. Retrieve the source goal from the verified real user message, preserving attachments and visibility semantics. A model's rewritten “original goal” is not an authoritative source.
2. Resolve the next input's relationship before execution routing: `answer`, `new_task`, `cancel`, or `clarify`. Only a validated question binding and answer may create the internal execution context. Ask again if ambiguity remains. New tasks and cancellation invalidate the old link instead of silently carrying old work forward.
3. Preserve the original user goal and answer as separate messages, once each. Do not rewrite visible history. Build internal context from the original goal, question, and original answer; carry it through intent routing, the actual Planner, DAG, control-plane goal, and reporting. A routing-prompt-only change is insufficient.
4. Persist the question/answer binding and recoverable consumption state before permitting execution. Persistence failure must report that execution did not start and retain recovery information. Never execute first and backfill storage. Retransmitting the same message ID must not consume it twice; identical text with a different ID is not a duplicate merely because its text matches. A crash after recording consumption but before startup must not lose the goal.
5. Reuse existing session storage where possible. If using extension data, strictly parse typed state and use a partial update guarded by the expected version/question ID; do not overwrite other modules' extension data. Validate the source role, workspace, question state, and answer identity. Do not create a general goal-management subsystem.

Expected touchpoints: Clarify and execution entry in `agent.rs`, relationship classification in `codepro_intent.rs`, a dedicated clarification data module only if needed, atomic partial persistence in `session/session_manager.rs`, and control-goal consistency in `acp/server.rs`. Change a location only when RED demonstrates the need. Do not expand the public SDK protocol preemptively.

## Establish meaningful failing tests first

The following test names are proposals, not existing or passing tests. Use `clarification_continuity` as the focused filter prefix.

| Test | Input and required assertion |
|---|---|
| `clarification_continuity_answer_reaches_planner_and_dag` | A controlled Provider supplies Clarify followed by Change decisions through the production reply entry across two turns. Capture the actual Planner request and read real temporary run storage. Both the original goal/question and “Email” must reach execution; the DAG must not use the answer alone as its goal. Each original user message appears once. Do not feed a manually composed goal directly into Planner and call that end-to-end coverage. |
| `clarification_continuity_reload_preserves_pending_source` | Recreate Agent/SessionManager after persisting the question, then answer. Include longer history to prove independence from the last-6-message window. |
| `clarification_continuity_new_task_and_cancel_do_not_resume` | “Never mind, just analyze README first” and explicit cancellation must not resume the original write goal; cancellation executes no tools. |
| `clarification_continuity_rejects_stale_or_foreign_bindings` | Different session/workspace, invalidated question, non-user source, and malformed data must not inherit or execute the wrong goal. |
| `clarification_continuity_duplicate_and_commit_failure` | Retransmit the same answer ID; inject failures before persistence and after persistence but before startup. Execution count must not increase twice; failed persistence permits zero executions, and reload still identifies an unprocessed answer. |
| `clarification_continuity_ambiguous_answer_stays_pending` | A bare “Continue” that does not answer the consequential choice must not invent the choice or report completion. |
| ACP path | In `crates/goose/tests/acp_server_test.rs`, verify consistency among control-plane goal, original user text, and Planner/DAG source, including reload without redispatch. |

Prefer `crates/goose/tests/codepro_clarification_continuity.rs`. If integration tests cannot intercept the private production route, add minimal Provider support in the existing `agent.rs` test section, without bypassing the real entry point. Valid RED must fail on a wrong-goal or missing-link assertion. Compilation failures, environmental blockers, and model action limits are not valid RED.

## Gates and native acceptance

After handoff, verify dirty-diff ownership, disk space, and active builds. Run Cargo serially. All commands below are planned for `D:\CodeBuddy` and are currently NOT_RUN.

```powershell
cargo test -p goose --features code-mode --jobs 1 clarification_continuity -- --test-threads=1
cargo test -p goose --lib --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --test acp_server_test --features code-mode --jobs 1 -- --test-threads=1
cargo fmt --all --check
cargo clippy --all-targets --features code-mode --jobs 1 -- -D warnings
cargo build -p goose-cli --features code-mode --jobs 1
```

Complete additional relevant integration and workspace build gates based on the final diff. If frontend changes become necessary, run the affected component, type, lint, full frontend, and build gates. If feature rules require updating `goose-self-test.yaml`, rebuild and run `goose run --recipe goose-self-test.yaml`; unfinished checks must not be reported as passed.

Native Electron acceptance uses an isolated project and a real model: submit a small, locally verifiable change goal that asks one consequential question first; answer using the real keyboard, then inspect actual changes, test output, goal, and report. In a separate case, close normally after the question, reopen, and answer. After completion, reload and reopen history to verify retained content and no repeated side effects. Verify disk artifacts and execution records rather than trusting a completion card. If the real model does not take the Clarify path, record that path as uncovered rather than substituting another successful workflow.

## Comparison with published Codex behavior

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes thread/resume, turn/interrupt, and requestUserInput/resolved: conversations reopen, interrupted turns terminate as interrupted, and input requests resolve by identity. Adopt separate conversation/turn/question identities and retained history. Do not infer private Codex storage, copy the entire protocol, or introduce a global goal API. The specific B types and transaction design are this project's proposal, not claims about Codex internals.

## Definition of completion

Report B complete only after meaningful RED, the minimal fix, all required gates, native two-turn/reopen acceptance, and supervisor independent review. Record source identity, commands/cwd/exit codes, pass/fail/skip counts, actual interaction, and artifact locations. Keep cancellation versus legacy raw-state projection synchronization explicitly separate from B completion.
