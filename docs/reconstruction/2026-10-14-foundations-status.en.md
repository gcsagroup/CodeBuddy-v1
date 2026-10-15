# First-version foundations: current delivery record

This record supersedes the early ordinary-chat preview report. The working directory is `D:\CodeBuddy-v1`, copied from the original project including its uncommitted files; see [source-baseline.json](source-baseline.json). The destination has no Git repository. No development branch, commit, or push was created. The original project remains intact.

## Launch and workspace

Open [start-preview.cmd](../../start-preview.cmd) for the latest CodePro workbench. The saved Ollama cloud `kimi-k3` configuration is retained; providers can be changed in the existing settings UI. This is a Windows development preview, without an installer release yet.

The final instance started at 18:57 Asia/Shanghai. At 18:59 the `CodeBuddy` title, original new-task route, and default directory were verified: Electron browser process 29836 and backend 29100. The window remains on New Task. See the [launch/source receipt](../../.preview-evidence/foundations-preview.json) and [screenshot](../../.preview-evidence/foundations-preview.png). These PIDs are a snapshot; later launches use `launch.json`.

Enter a task directly. The default container is `D:\CodeBuddy-Workspace`, with a separate child directory for each new task. Explicitly selected existing projects retain their directories. Reopening an ongoing task after restarting requires the existing workspace binding confirmation.

Renderer components, styles, copy, interactions, and SDK sources retain the baseline. Changes are in Electron startup/communication and the Harness, tools, and persistence adapters. The current UI uses the composer Stop button, followed by a continuation message in the same chat.

## Connected foundation paths

- Official Harness executes conversations, file edits, search, PowerShell, background jobs, and subagents. The host owns plans, dependencies, approval, receipts, and recovery facts.
- Existing settings cover custom/default models, role routing, reasoning effort, compaction, prompt templates, AGENTS.md, MCP, and permissions. Auxiliary vision runs in a read-only session.
- The toolbox connects file/command tools, project memory, Git, independent MCP extensions, and the original computer/document/visualization MCP binaries. Disabled tools and denied approvals restrict actual execution.
- Memory reuses Harness `storage-domain/storage-json`, with viewing, editing, candidate review, expiry, and export. Only approved project records enter recall.
- Common tasks support basic parameters, templates, models, and extensions. Automatic tasks support persistence, run-now, and pause; imported schedules remain paused.
- History, export/import, edit/retry/fork, workspace switching, and MCP resources are connected. Imported history is read-only and does not resume the former agent execution.
- Git exposes seven read tools plus stage, unstage, commit, create-and-switch branch, and switch existing branch. Review uses an independent Harness session.

See the [functionality matrix](v1-functionality.en.md) for exact coverage. Implementation, automated tests, controlled UI tests, and real-model acceptance are separate claims.

## Acceptance evidence

| Scenario | Result and evidence |
|---|---|
| Current full backend/launcher regression | Node.js 24 serial execution of runtime/tests, runtime/harness/test, and scripts tests; 286/286, zero failed/cancelled/skipped, exit 0; [final log](../../.preview-evidence/foundations-all-tests-final.log) |
| Kimi + original Electron + default workspace | Real file/test tools; independent 3/3, exit 0; [receipt](../../.preview-evidence/real-codepro-ui.json) |
| Kimi multi-module development | money/invoice modules; independent 8/8; [receipt](../../.preview-evidence/real-codepro-latest.json) |
| Kimi pause, server restart, same-run continuation | About 233 seconds, independent 15/15; completed file hashes/mtimes retained and original receipts unique; [record](2026-10-14-real-codepro-resume.en.md) |
| Original Electron stop, close, restart, history, continue | Controlled loopback model, official Harness and real tools; visible completion/test pass, independent 3/3, zero page/console errors; [receipt](../../.preview-evidence/controlled-ui-resume-RnxtKT/receipt.json) |
| Actual bundled MCP calls | Five list_apps, DOCX create/extract, cache and Mermaid calls; [receipt](../../.preview-evidence/builtin-execution-latest.json) |
| Original settings UI | Nine pages opened; memory/personalization switches and global AGENTS.md persisted and reopened; [receipt](../../.preview-evidence/first-version-I9je8k/settings-ui-receipt.json) |
| Original frontend tests | Ten files, 80 tests passed; [log](../../.preview-evidence/frontend-foundations-tests.log) |

These establish the named paths, not hour-scale workloads, large production repositories, every desktop tool, or all frontend entry points.

## Migration and data

The old profile `C:\Users\jiangrui\.CodeAgentPro\profiles\local` was read-only imported into the preview. It retains 616 user/CodePro histories and a full SQLite archive. Existing Kimi settings are preserved, missing providers added, imported extensions disabled, and one schedule paused. Of 14 old memory records, three map to existing projects in Harness storage. Eleven belong to missing historical directories and remain archived; no project directories were fabricated.

After the final restart, the original Electron UI reopened a 51-message historical chat. All 616 imports remained, Kimi settings matched field-for-field, and page errors were empty. See the [history UI receipt](../../.preview-evidence/migrated-history-ui.json).

- Data: `.preview-data/backend`; Electron profile: `.preview-data/state/electron-app`.
- Current process/port receipt: `.preview-data/logs/preview/launch.json`; logs: `runtime.log` and `electron.log` alongside it.
- Archive: `.preview-data/backend/legacy`; mapping: `.preview-data/validation/legacy-memory-mapping-report.json`.
- Frozen-source verification: `node scripts/create-source-baseline.mjs --verify`; this does not recopy the baseline.

The original project's current HEAD is `dfdc47fb1a8d483fc02293b85d977e87a8969f10`. All 1,074 source UI files still match the captured baseline, and all 1,069 frozen destination files match. See the [source check](../../.preview-evidence/source-ui-current.json) and [frozen-file check](../../.preview-evidence/frontend-baseline-final.log).

## Outstanding work

All frontend functionality remains the target. Remote Git, restore/conflict workflows, GitHub login/PR/issues/CI, provider OAuth, Nostr, local ASR, and advanced recipes still have integration work. Cloud speech, real vision quality, full computer actions, hour-scale and large-project workloads, the Windows installer, and macOS require separate acceptance. This is a runnable, reviewable foundation preview, not a declaration that the full first version is complete.
