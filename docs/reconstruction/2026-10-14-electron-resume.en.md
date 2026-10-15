# Electron stop and restart continuation acceptance

Date: 2026-10-14. Source: current `D:\CodeBuddy-v1`; see [source-baseline.json](source-baseline.json). Uses the existing start-harness-preview.cjs entry point, Node 24, unchanged Electron renderer, official Harness 0.2.1-alpha.2, and a controlled loopback HTTP model. No renderer, user Kimi profile, dependency, branch, or commit changes.

`node scripts/accept-controlled-codepro-resume-ui.cjs` exited 0; actual 10:40:14–10:41:45 UTC. Isolated profile: `.preview-evidence/controlled-ui-resume-RnxtKT`. [Receipt](../../.preview-evidence/controlled-ui-resume-RnxtKT/receipt.json), [independent tests](../../.preview-evidence/controlled-ui-resume-RnxtKT/independent-tests.log).

## Actual existing UI path

1. Click New Task and send the isolated development goal using the original composer.
2. Controlled model uses official tools to plan three tasks, write the math module, submit its real receipt, then wait for another model response.
3. Click the composer Stop button. The owner ends the attempt and preserves paused state, with no active attempt or pending/uncertain effect.
4. Close the actual Electron window; the existing launcher reaps runtime and Electron descendants.
5. Relaunch the same profile through the existing launcher, open the task from History, and click the existing Confirm and Start workspace control.
6. Send a continuation message through the original composer, preserving run identity. The model consumes saved structured facts, writes invoice/tests, executes native PowerShell/Node tests, and submits verification/completion.
7. The page shows Completed, Tests passed and 3/3. Independent tests pass 3/3, exit 0. Close the fixture window and verify process cleanup.

Current AppLayout mounts WorkspacePanel rather than the old CodeProControlPlanePanel, so its Pause/Resume buttons are not visible. This acceptance covers the existing Stop-and-next-message path. It never substitutes hidden ACP control requests for UI actions. Playwright/CDP uses native locators; page JavaScript inspection is read-only.

## Identity and lifecycle

| Object | Evidence |
|---|---|
| Session | `cb7d8ea7-7e64-47c5-b3b5-825783de2aa3` |
| Run | `3620b8c7-2a82-4342-b8dc-11d57d8de84e`, unchanged across restart |
| Route | `http://localhost:5173/#/codepro/pair?resumeSessionId=cb7d8ea7-7e64-47c5-b3b5-825783de2aa3` |
| Event sequence | run_created 1 → attempt_started 2 → first write receipt 6 / task success 7 → stop attempt_finished 8 → continued attempt_started 9 → verification receipt 18 / exit 0 → run_completed 20 → attempt_finished 21 |
| First launch | Runtime 34068, Forge 36152, Electron main 34128; all owned descendants exited |
| Second launch | Runtime 36404, Forge 33268, Electron main 9676; all owned descendants exited |
| Test orchestrator | PID 23968, final exit 0; port 9389 no longer listening |
| Continuity | Exact original event prefix; unchanged first-file hash/mtime; unique original write receipt; no final pending/uncertain effects |
| Page errors | pageErrors=[], consoleErrors=[] |

Screenshots: [running](../../.preview-evidence/controlled-ui-resume-RnxtKT/01-running-before-pause.png), [stopped](../../.preview-evidence/controlled-ui-resume-RnxtKT/02-paused.png), [workspace confirmation](../../.preview-evidence/controlled-ui-resume-RnxtKT/03-reopened-workspace-confirmation.png), [replayed](../../.preview-evidence/controlled-ui-resume-RnxtKT/04-replayed-paused-run.png), [completed](../../.preview-evidence/controlled-ui-resume-RnxtKT/05-completed.png). Stopped and completed screenshots were visually inspected.

## Earlier incomplete attempts and limits

- controlled-ui-resume-QOEUSE searched for the old Pause button, established that it is absent, and exited 1; owned processes were reaped.
- controlled-ui-resume-mosbb9 reached actual completion through Stop/restart/continue, but its finite model sequence lacked the extra response after official automatic compaction and exited 1. Native JSONL establishes compact-checkpoint as the cause; this was a fixture gap, and its evidence remains.
- The fixture now provides a bounded number of terminal text responses after owner completion. A complete new run passed. It also recorded one official compaction; cloud summary quality is not established.

This is Windows real-Electron interaction with a controlled model, real files, and native tests. It is separate from [real Kimi ACP recovery with 15 tests](2026-10-14-real-codepro-resume.en.md); combining the two does not prove real-Kimi Electron restart. Hours-long load, complex repositories, forced termination, and macOS remain outside this result.
