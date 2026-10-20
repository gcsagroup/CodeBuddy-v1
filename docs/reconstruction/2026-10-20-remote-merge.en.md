# Remote and local integration, 2026-10-20

[简体中文](2026-10-20-remote-merge.zh-CN.md) · [繁體中文](2026-10-20-remote-merge.zh-TW.md)

## Changes retained

Integration used the existing `main` in `D:\CodeBuddy-v1`. The original local revision `732113504de3601ab087a609ce20827b814db2c2` fast-forwarded through 24 remote commits to `a95fcda661c1bdafbb6b0f81180ea116c72f6eec`, then the local uncommitted changes were reapplied. No branch or worktree was created.

Remote native subagents, model capabilities/thinking controls, approval state, workspace layout, conversation presentation and installer changes coexist with local MCP recovery, image/video tools, desktop pets, branding, macOS tools, credential adapters and packaging. Harness retains ownership of execution, scheduling, completion and compaction.

Twelve conflict files were resolved: authority map, built-in tool inventory, compatibility server, Harness adapter, MCP bridge, tool discovery, staging script, desktop layout, model settings and three locale catalogs. Both MCP configuration invalidation and approval reset survive; both model settings panels survive; generation and native subagent tools remain discoverable on demand.

Regression fixtures now declare capabilities and output budgets, use durable assistant facts to exercise summarization after native tool pruning, and explicitly deny a skill when testing rejection. UI fixtures support ResizeObserver and model display names. The ComfyUI address accessibility label was localized.

## Verification

The tested source is `a95fcda` plus the integrated working tree, using existing Node 24.21.0 and Rust. No dependencies were installed and no installer was produced. Exact commands are listed in the Simplified Chinese companion.

- Backend initial run: 518 passed, 11 failed, 1 skipped. Affected cases passed targeted reruns after repairs: 529 distinct cases have passing evidence across the batch, with the Mac Keychain case skipped on Windows. This was not a single all-green suite run.
- Frontend: 48 affected files initially produced 536 passes and 2 failures; a repaired four-file rerun passed 49 tests, exit 0. All 538 affected cases have passing evidence.
- Entry point and macOS packaging scripts: 42 passed, exit 0. Rust unit tests: 69 passed, 1 public weather service test ignored, exit 0.
- Rust formatting, Clippy, offline tool build, SDK compilation, desktop type checking, changed-file ESLint and diff checks exited 0.
- English extraction and Simplified/Traditional Chinese catalog validation passed for 2,868 messages, exit 0. The repaired accessibility-label test also passed, exit 0.

The rebuilt Windows tool is 21,777,920 bytes, SHA-256 `c04d51c3d42b6fa75c5ef0523d9a69dbba568bc015c3275aa4322f5ff9d740f2`. See `runtime/tools/provenance.json`. The local binary is excluded from source commits; other machines should build following README instructions.

Real Electron was started through the existing `startPreview` entry point with an isolated profile, a controlled local model and an MCP fixture. Actual UI interaction verified coexistence of both settings panels, persistence of the ComfyUI URL, pet show/hide, and a chat invoking health once. The visible reply contained `MCP_HEALTH_OK | desktop-session-2 | execution=1`; native session `314e7281-8bb6-426f-abd6-c0219ff653bf` persisted `turn/end: completed`. The final screenshot was inspected. Closing the test window let the launcher exit 0.

## Limits and handoff

This desktop flow does not establish live cloud-model, GPU generation, macOS hardware or installer acceptance. The fixture disabled built-in development tools: initial discovery was denied and a subsequent direct MCP call succeeded. It is not desktop discovery acceptance; backend tests cover discovery separately.

Additional legacy branding/distribution checks initially had 11 failures. The newly introduced accessibility-label issue was repaired; 10 remain around legacy TLS, telemetry, default-model and static accessibility assumptions, and removed build/migration scripts. The full legacy gate is not passing. Full-locale validation also remains failing: the remote German/Spanish catalogs already lacked 96 keys and had 23 extra keys; the local pet page adds one untranslated key. This batch synchronized English and both Chinese catalogs only. An initial full frontend run produced no result and was stopped; the completed scope is the 48 affected files.

Original file archive, binary patch, hashes, logs and screenshots remain locally under `.preview-evidence/merge-20261020-091416/`. The `pre-merge-20261020-preserve-local` stash is retained. `tool-source-manifest.json` identifies merged tool sources and is separate from the pre-merge backup. These local artifacts are excluded from commits.

This record accompanies the integration commit on `main`; the delivery message and remote Git state establish the final commit and push result. Colleagues should update a clean `main`, without reapplying the backup stash. User production profiles and credentials were not modified; acceptance profiles, caches, logs and installers are excluded from the source delivery.
