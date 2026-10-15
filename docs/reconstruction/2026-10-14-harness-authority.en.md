# Harness execution and goal authority migration

Date: 2026-10-14. Directory: `D:\CodeBuddy-v1`; no Git repository, branches, commits, or pushes. The source inventory is [source-baseline.json](source-baseline.json). This record covers current local source changes. Earlier preview tests and older desktop processes do not establish acceptance of this revision.

[简体中文](2026-10-14-harness-authority.zh-CN.md) · [繁體中文](2026-10-14-harness-authority.zh-TW.md)

## Evidence and authorized boundary

The user reported slow conversation creation, burst output, and interrupted greetings, then authorized official Harness execution and scheduling with necessary CodeBuddy adapters. Session `c4117cd6-e198-4d7a-8ada-6ffdbd15ea85` recorded native `turn/end: completed` at 19:07:30 and 19:09:27 Asia/Shanghai. The old adapter nevertheless reported interruption because the model omitted `codebuddy_task(answer)`. The 19:13:26 `TRANSPORT / Connection error.` was a separate actual model transport failure.

New sessions no longer require the custom `submit_plan/start_task/task_result/propose_finish/answer` protocol. They use installed official `0.2.1-alpha.2` plugins. The user subsequently allowed frontend adaptation where required by backend authority. This slice adds no second scheduler.

## Ownership and implementation

| Fact | Authoritative execution or record | CodeBuddy responsibility |
|---|---|---|
| Message acceptance, model loop, tools and child scheduling | Harness Session Controller, AgentLoop, subagent | ACP/UI translation, model routes and permission integration |
| Long goals and automatic rounds | Official goal, tool-goal and goal-round-driver | Consume `goal/change` and native outcomes; never schedule another round itself |
| Current-round checklist | Whole-list `todo/write`, cleared on `turn/start` | Render existing UI; snapshot IDs do not imply DAG dependencies |
| Tool effects | Actual native structured receipts | Display and recovery references; no task-registration dispatch gate |
| Pause, resume and restart | Native lifecycle and process-local activation | Connect existing controls, preserve product session IDs and history |

New runs record `executionOwner: harness`. Explicit adoption through `beginAttempt` preserves the entire earlier event prefix. Uncertain effects remain visible; inspection may precede continuation, and old calls are never automatically replayed. Legacy gates remain only for historical contracts and compatibility regression tests, outside the new session tool surface.

`finishHarnessAttempt` distinguishes a normal response without a goal (`harness_turn`) from a completed native goal (`harness_goal`). Active goals, cancellation and action/output limits remain paused; actual transport errors retain failure and error codes. Neither completion kind means `verified_task` or proves that tests passed. Verification comes from real command receipts and independent tests.

Native durable goal phase is separate from process-local `armed/disarmed` activation. Restart does not automatically restore execution authority; human input and native tools resume it. The official round driver waits for idle and durability checkpoints and owns continuation race handling. Ending one turn is not completing the entire goal. Concurrency uses the official total child limit, with role model selection retained as routing rather than a separate coder scheduler.

Legacy UI `cancel_task/cancel_branch` commands have no execution equivalent for native todo snapshots and now return an explicit protocol error. The legacy single-worker control also returns an error until connected to official control; it neither stops the root nor fabricates a stopped worker. Whole-run pause, resume and emergency stop remain available. A new run does not claim completion of a previous completed goal retained by the session.

## Reuse decision

The implementation reuses [official goal plugins](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/goal), [todo](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/todo/tool-todo), and [Session Controller](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/api/session-controller): existing events, CAS revisions, cancellation and persistence. The [license is MIT](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/LICENSE). Upstream remains a developer preview; this change pins the installed version without upgrading it. See [PROVENANCE.json](../../runtime/harness/PROVENANCE.json) for the npm/reference-source correspondence boundary.

The adapter does not equate every answer ending with project completion and adds no greeting-keyword exceptions. Ordinary conversation answers directly; long work uses the upstream goal lifecycle.

## Slice validation

Executed in the current directory using installed Node 24:

```powershell
node --test --test-concurrency=1 runtime/tests/codepro.test.mjs runtime/tests/codepro-harness-projection.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/tests/roles-harness-integration.test.mjs runtime/tests/harness-authority-acp.test.mjs
```

31/31 passed, exit code 0, approximately 9.86 seconds. This overlapping subset must not be added to other suite counts. Coverage includes historical contracts, native outcome projection, official Harness with loopback HTTP model fixtures, real cross-module files and PowerShell, autonomous continuation, cancellation, restart, same-run recovery, unchanged completed-file contents/mtime, real Node tests, native total child capacity, and role model routes. This slice did not call external models or manipulate the user's profile or desktop windows.

Follow-up regressions cover legacy control authority and goal scope: `node --test runtime/tests/codepro-harness-projection.test.mjs` passed 10/10, exit 0; after the control fix, the legacy plus projection subset passed 26/26, exit 0. These are individual recorded runs rather than cumulative acceptance of all subsequent changes.

The parent integration run encountered Windows `EPERM` while atomically replacing `state.json`. The role fixture opened the file every 10ms to observe child completion, creating confirmed overlap with product writes; the exact lock holder remains unproven. A transparent observer now counts real Harness events after the compatibility consumer persists them, with final independent disk verification of lifecycle and receipts. The single targeted rerun passed 1/1, exit 0, approximately 2.94 seconds. Native concurrency and actual file assertions remain intact; no external scanner attribution is claimed.

This is not acceptance of the changed product with a real cloud model, desktop end-to-end flows, hours-long work, or large production repositories. Remaining first-version integration and validation gaps stay in the [functionality matrix](v1-functionality.en.md); a separate acceptance report will record the full batch and subsequent changes.
