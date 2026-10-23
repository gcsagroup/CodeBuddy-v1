# 2026-10-23 merge handoff

[简体中文](2026-10-23-merge-handoff.zh-CN.md) · [繁體中文](2026-10-23-merge-handoff.zh-TW.md)

## Scope and source

Repository: `https://github.com/erjinyi-bool/CodeBuddy-v1.git`; branch: `main`; baseline: `d43fcbbd0ec85afcb073cb74b14e835752a26e20`. This batch includes accumulated runtime, desktop, installer and documentation changes from `D:\CodeBuddy-v1`. No new branch or checkout was created and no colleague's remote branch was modified. See the commit list below. Changes are interdependent; merge the complete batch. Older “baseline + dirty” references describe the source snapshot used at build time.

## Changes

| Area | Behavior and main files |
| --- | --- |
| Goals and planning | `/goal`, `/plan`, `/compact`, goal status/editing, pause/resume and plan review use official Harness controllers. Restart does not automatically resume goals; saving a goal does not execute it. `runtime/goal-request.mjs`, `compat.mjs`, desktop `acp/goals.ts`, `ComposerGoalBar`, `ComposerPlanMode`, `PlanReviewForm`, `WorkspaceGoalEditor`. |
| Browser and computer control | Session-bound `browser_control` provides workspace HTML previews, observation, input, clicks and screenshots. Stale nodes, obstruction and uncertain action outcomes use structured receipts. Added isolated Playwright and existing-user-browser extension entries. The model selects computer skills; the host enforces permissions. `runtime/browser-tool.mjs`, `harness/{computer-skill,playwright-entry,tool-discovery}.mjs`, `harness/skills/`, desktop `workspace-panel/`. |
| Images and tools | Host screenshots pass through existing vision routing and official attachment admission, producing durable references and fixing missing `attachmentId` on the next request. Observation errors preserve completed action receipts; cancellation propagates. Allowed `write`, `edit` and `browser_control` are available on the first turn; remaining tools use discovery. `runtime/harness/index.mjs` and regression tests. |
| Model presets | New installs expose LAN and Ollama Cloud, with LAN initially selected and verified `kimi-k2.6` first in the cloud list. `runtime/default-model.json` is the shared preset authority; duplicate desktop defaults were removed. First-run initialization imports optional distribution credentials without overwriting existing settings or restoring user-deleted presets. `store.mjs`, `providers.mjs`, `model-settings.mjs` and desktop model settings. |
| Streaming and files | Streaming code and historical code over 8,000 characters render as complete plain text to reduce highlighting cost. Scroll layout writes are batched into animation frames. Tool argument generation is distinguished from execution. Actual changes and validated workspace references share deduplicated file cards while preserving per-turn modifications. Settings navigation, toolbox groups and model capabilities were updated. `MarkdownContent`, `ProgressiveMessageList`, `scroll-area`, `WorkspaceFileReferences`, `CodeProConversationFiles`, `runtime/work-status.mjs`. |
| Desktop pet | New-chat input, file/image attachments, hide/settings context menu, pending-question summaries and task navigation. Completion notifications share conversation read state and retain explicit user enablement. Multi-monitor bounds and click-through behavior were adjusted. `ui/desktop/src/pets/`. |
| Storage and uninstall | Removed settings-page migration, size inspection and manual cleanup controls while retaining existing data-location and legacy journal compatibility. Added macOS uninstall plans with explicit data-preservation boundaries. `runtime/storage-management.cjs`, `macos-uninstall.cjs`, desktop `storage/macosUninstall.ts`. |
| Windows installer | Inno progress/details/layout updates. `UsePreviousAppDir=no` keeps the default at `%LOCALAPPDATA%\Programs\CodeBuddy` instead of inheriting a prior D: installation; manual directory selection remains. `scripts/installer/*.iss` and native fixture tests. |
| macOS and native helpers | DMG background/Finder layout, signing/architecture/payload validation, replacement of previously executed tools, Keychain verification, AX and keyboard handling. `ui/desktop/scripts/`, `scripts/*macos*`, `tools/macos-credentials/`, `tools/qwen-computer-use/`. |
| Documentation and locales | Feature, authority and delivery documentation in three languages. Sixteen UI locale files include content and formatting changes; resolve conflicts by key and retain colleagues' translations. |

Official DeepSeek Harness still owns execution, planning, goals, compaction and completion. Rust remains limited to independent MCP tools; no legacy execution core was restored.

## Integration notes

1. Save changes on the colleague's target branch, run `git fetch origin`, verify the baseline and commit list, then merge the final batch commit using the team's process, for example `git merge <final-batch-commit>`. Do not overwrite files or reset the target branch.
2. Likely conflict areas: `runtime/harness/index.mjs`, `runtime/compat.mjs`, `runtime/store.mjs`, `ChatInput.tsx`, `main.ts`, `workspace-panel/`, `pets/`, i18n JSON, Forge and installer scripts. Keep related ACP, UI and runtime changes together.
3. Merge the Harness manifest and lockfile together. New dependency: pinned `@playwright/mcp@0.0.83`; DeepSeek packages remain at `0.2.1-alpha.2`. Follow the README toolchain and dependency preparation process without incidental upgrades.
4. `runtime/tools/provenance.json` records local artifacts; Git does not supply the native executables. Prepare target-specific tools and regenerate/verify provenance as documented. The Windows Qwen entry explicitly describes an existing pinned artifact, not proof of a rebuild from this batch's Go sources.
5. Windows packaging: `node scripts/build-harness-windows.cjs <stage-directory> --installer=inno`. For Mac, follow `docs/macos-installation.en.md` and `build-harness-macos.cjs` with matching architecture and signing prerequisites. `start-preview.ps1` is the development entry, not installer acceptance.

### Shared cloud credentials

Git excludes `runtime/distribution-credentials.json`, real keys, user profiles, installers and raw acceptance evidence. Local delivered installers include the shared key with the user's authorization. Building from Git does not retrieve that key. To reproduce this first-run behavior, the owner must provide the local distribution file through a separate channel:

```json
{"version":1,"providers":[{"providerId":"custom_codebuddy_ollama","baseUrl":"https://ollama.com","apiKey":"<provided-separately-by-owner>"}]}
```

This is a schema example, not usable credentials. First launch imports the key into DPAPI/Keychain; recipients can still extract a shared key from a client package. Local encryption does not make distributed credentials confidential. The LAN endpoint is `http://192.168.9.101:8001` and requires that network. The 22 cloud names are a catalog snapshot, not 22 accepted models.

## Validation and limits

Pre-commit results are recorded below; raw logs stay in local `.preview-evidence/commit-handoff-20261023/`.

Same-batch installed Windows and Mac arm64 applications were tested with isolated profiles: both connections appeared; LAN chat, cloud HTML creation, embedded-browser opening, screenshot continuation and image-history recovery after restart had real receipts. The Mac button changed 0 to 1. The Windows game task entered prolonged reasoning; the operator stopped it and supplied observed facts before completion, so this was not an autonomous single-turn pass. Empty `kimi-k3` answers were reproduced through the raw API; it remains selectable but unaccepted.

The preceding Windows installer completed actual install/uninstall and data preservation. After the final default-directory change, eight native fixture tests and the complete build exited 0; a screenshot confirmed the C: default and application/runtime hashes stayed unchanged. The final new EXE still needs the user's complete installation retest. Mac DMG verification, mounting, copying, signature verification and startup passed. LAN succeeded through normal LaunchServices startup; direct SSH startup previously returned `EHOSTUNREACH`, retained as an environment difference rather than a pending permission request.

| Local artifact, repository-relative | SHA256 |
| --- | --- |
| `.preview-evidence/installer-default-path-20261023/CodeBuddy-1.43.6-windows-x64-default-path.exe` | `7255b4467173808d58968084582dde9e3d3b45fdcea0f78e4cf392b9c2b01eba` |
| `.preview-evidence/desktop-fixes-20261023/deliverables/final/CodeBuddy-1.43.6-macos-arm64.dmg` | `c34a54fe15c4af7ee79e181384e6707894aa0ca02a65dec1a446222a26915030` |

These packages came from the baseline plus this batch's source snapshots and predate the Git commits; committing does not rebuild them. Windows is unsigned; Mac uses development signing and is not notarized. Public-download SmartScreen/Gatekeeper behavior, Mac uninstall/Finder drag-and-drop/Intel, prolonged memory stress and every model combination remain unaccepted. Earlier local cleanup left user data behind, so an ordinary restart is not a clean-install test.

## Commits and pre-commit checks

1. `6491d44` — Windows/macOS packaging, native helpers and default installation directory (45 files).
2. `11e8c28` — Harness goals/browser integration, model presets, chat/pet interaction, feature documentation and tests (250 files).
3. The commit containing this document, `docs: add trilingual merge handoff and acceptance boundaries` — trilingual handoff and status notes for earlier development records (6 files).

Merge all three together. After fetching, locate this document's commit with `git log -1 --format=%H origin/main -- docs/reconstruction/2026-10-23-merge-handoff.en.md`; the delivery message also provides its hash. Inspect the complete change with `git diff d43fcbbd0ec85afcb073cb74b14e835752a26e20 <final-commit>`.

Checks used existing Node 24.18.0, with repository-root cwd unless stated otherwise.

| Command / check | Result and scope |
| --- | --- |
| `node --test runtime/tests/*.test.mjs runtime/tests/*.test.cjs runtime/harness/test/*.test.mjs` | Initial 622 tests: 617 passed, 4 failed, 1 skipped; exit 1. Old fixtures omitted `tools` capability and an assertion still expected first-turn `write` to be hidden. An early assertion failure left an HTTP fixture open; that child was stopped to finish the summary. This was not a complete suite pass. |
| `node --test runtime/harness/test/driver.test.mjs`; `node --test runtime/tests/model-thinking-preferences.test.mjs runtime/tests/roles-harness-integration.test.mjs runtime/harness/test/driver.test.mjs`; finally `node --test runtime/tests/model-thinking-preferences.test.mjs` | Updated three test files and registered HTTP cleanup earlier. Driver: 9 passed. Combined retry: driver/roles 10 passed. After correcting the remaining `/api/show` fixture, thinking: all 6 passed, exit 0. The entire 622-test suite was not repeated; these fixture corrections did not alter product implementation. |
| `node --test scripts/harness-macos.test.cjs scripts/start-harness-preview.test.cjs ui/desktop/scripts/macos-package.test.cjs ui/desktop/scripts/codebuddy-branding.test.cjs` | 32 passed, exit 0. These cross-platform fixtures are not native Mac E2E. |
| Desktop cwd: `node ../node_modules/typescript/bin/tsc --noEmit` | Exit 0. |
| Desktop cwd: `node scripts/i18n-check.js` and `node scripts/i18n-validate-locale.js` | Exit 0; 2,982 messages, English source check and 15 translated locales. |
| Desktop cwd: `node ../node_modules/vitest/vitest.mjs run --maxWorkers=1` | All 306 files and 2,709 tests passed; exit 0, 857.94 seconds. Uses existing `ui/node_modules`; dependencies were neither installed nor rebuilt. Component tests are not complete desktop product E2E. |
| `go test ./...` / `go vet ./...` | Go was absent from the current PATH, so commands did not start and were not revalidated. Swift native tests were not run on Windows. No Rust source changed; no full Rust suite was run. |
| Git and candidate checks | `git diff --cached --check` exited 0. No local shared key, installer, large binary or raw profile was found in candidates. A stale index lock was backed up locally after verifying that no Git process was active. |
