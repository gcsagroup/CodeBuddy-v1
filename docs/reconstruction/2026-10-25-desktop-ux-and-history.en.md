# Desktop UX and history loading — 2026-10-25

[简体中文](2026-10-25-desktop-ux-and-history.zh-CN.md) · [繁體中文](2026-10-25-desktop-ux-and-history.zh-TW.md)

## Scope and ownership

This batch extends the October 23 integration: image actions, workspace-relative file links, history loading, reading position, waiting feedback, browser approvals, queued follow-ups and the Windows tool CRT. Existing Harness execution, persistence, permission and cancellation owners remain unchanged. No dependency lockfile, upstream core or persistence protocol changes.

- `runtime/compat.mjs`: load a consistent snapshot after existing workspace checks. During historical replay only, coalesce adjacent assistant text/thought updates with identical message IDs, types and envelope metadata. Newly assembled frames are bounded to 64 Ki characters; already-large originals remain unchanged. Users, tools, images and metadata changes remain boundaries. Live delivery and stored journals are untouched. Session info selects metadata fields.
- `ui/desktop/src/acp/adapter/{messages,shared}.ts`: keep mutable input private; clone the known changed/inserted message while retaining isolated snapshots of unchanged messages. Other changes use the full publication path.
- `chatSessionStore.ts`: apply every historical event, but publish the first loading state and final snapshot to the chat React subscription. Permission/control consumers are not skipped.
- `ChatInput.tsx`: own draft/queue presentation and acceptance handling. Reuse the native cancellation and request-release barriers; never overlap prompts.
- `ToolCallExpandable.tsx`, `ui/scroll-area.tsx`, `BaseChat.tsx`: preserve reading/explicit expansion, observe natural content height, and follow a confirmed explicit send in the same conversation.
- `runtime/work-status.mjs` and `ToolCallConfirmation.tsx`: consume actual diagnostics and display received browser operations/targets; do not authorize or repair invalid model arguments.
- `ImagePreview.tsx` and Electron `main.ts`: accessible modal preview, native copy-image/save-original actions. `workspaceFilePanel.ts` sends relative targets through existing main-process workspace guards.

## Interaction contracts

Ordinary queued inputs run one at a time after the current turn and transport settle. Send now freezes known-unsent queue items at the click and combines their text/images in order. It excludes the composer draft, later arrivals and uncertain deliveries. Remove inputs only after acceptance; retain rejected inputs. Stop cancels the pending send-now intent and keeps the queue. Existing storage, reconciliation and recovery remain intact.

Expand only multiple ordinary waiting items; uncertain deliveries retain visible reconciliation controls. A frontend dequeue gate is not an Agent pause. Reading position survives settlement folding. Only accepted explicit sends in the same conversation return to latest; rejected, cross-session and automatic queue events do not.

HTTP headers remain waiting. Actual text, reasoning or tool arguments start receiving, without restarting the waiting timer. Approval targets are plain text; missing targets are explicit and never inferred or auto-approved.

## Diagnostics and measurements

Backend `[Session load timing]` separates snapshot read, workspace validation, projection, dispatch, recovery, questions, permissions, options and extensions. `updateCount` includes usage records; `dispatchedUpdates` counts historical session notifications only.

Frontend `session_load_timing` follows open, initial metadata, replay response, final metadata, store ready, DOM commit and visible commit, plus cache/error outcomes. At most 16 observations are retained; only IDs, counts and timing are logged. Logging cannot block a load. Visible commit is a rendering/paint-opportunity observation, not compositor presentation. Frontend/backend stages overlap and cannot simply be added.

| Controlled first-load sample; one observation per cell | Before | After |
| --- | ---: | ---: |
| 1000 messages, 400000 characters | 5164 ms | 2124 ms |
| 300 messages, 28800 fragments | 9469 ms | 3306 ms |
| 300 complex Markdown messages | 4810 ms | 4211 ms |

These fixtures exclude generation and do not establish universal improvements; short histories showed no stable gain. In a renderer-only probe, the median of three repeats for replaying 1000 messages changed from 935.7 ms to 45.3 ms, which is not whole-application loading time. First-load means no renderer session cache, not a cleared OS file cache.

## Windows runtime and validation

`stage-harness-distribution.cjs` copies release `vcruntime140.dll` and upstream license from the already-prepared Python payload beside the native tools. Missing payload fails the build; no System32 borrowing, download or installation. `verify-harness-stage.mjs` verifies identity/license and `windows-tool-runtime.test.cjs` covers staging and missing payload.

Integration checks: 64 desktop files / 842 tests, 45 runtime/history/question/default-model/packaging tests, and 24 controlled-browser tests in actual Edge passed; TypeScript, targeted ESLint and locale checks passed. Initial sandbox temp-file rename EPERM failures are retained and not counted as passes; the same commands passed against host-side isolated fixtures. Two initial commands with incorrect log paths did not start checks and are excluded.

Use README test entry points. Focused runtime tests: history-replay-compaction, history-list-latency, harness-integration, work-status, questions, distribution-model; packaging tests: windows-tool-runtime, distribution-credentials and windows-wizard-installer. Desktop scope includes ACP, BaseChat, queued/accepted sends, images, Markdown, approvals and scrolling. Browser fixture: `tests/e2e/scroll-area.browser.spec.ts`.

Existing Windows product checks cover image copy/save, explicit sends after reading, stop/continue, three sequential queued turns and explicit combined send-now. The same 36-case scrolling matrix changed from six blank viewports to none. Automated, controlled-browser and real-product evidence remain separate. This batch does not establish Win10 or Mac acceptance, all-model compatibility, or a completed compaction-model A/B. Raw model protocol markers and invalid arguments remain separate work; compaction code was not changed.

## Credentials and publication

Commit only source, focused regressions and development notes. Exclude weekly reports, profiles, conversations, local diagnostics, screenshots, builds and installation records. Never restore shared cloud credentials or legacy distribution credentials; users configure their own keys without overwriting existing settings.

Inspect current files, added diff and every new historical blob before publishing. Known historical credential comparisons stay in memory and never print values. Neither pattern scans nor a shallow clone prove all remote history, other branches or past packages are clean. Previously distributed credentials require rotation/revocation by their owner, outside this batch.
