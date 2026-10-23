# CodeBuddy: what changed in each commit and why

[简体中文](2026-10-23-commit-rationale.zh-CN.md) · [繁體中文](2026-10-23-commit-rationale.zh-TW.md)

This document explains the four commits on `main` between `d43fcbb` and `78bc5ba`. See the [merge handoff](2026-10-23-merge-handoff.en.md) for build and validation details.

## `6491d44` — Installer and native-tool corrections

**What changed:** Updated Windows installation/uninstallation progress, details and layout. Set `UsePreviousAppDir=no` so the default remains `%LOCALAPPDATA%\Programs\CodeBuddy`, while retaining manual selection. Improved macOS DMG layout, signing and architecture checks, replacement of previously executed tools, Keychain self-tests, and computer-control window-position and keyboard handling.

**Why:** The Windows configuration did not hardcode D:; the installer inherited a previous installation directory. The fix changes inheritance, not source locations, build staging or user-data placement. On Mac, older mounted volumes with the same name could break Finder layout, so packaging now operates on an explicitly created Finder window. Other native changes check actual signing, architecture and credential access, and make window movement observable while keeping screen position separate from window-local input coordinates.

## `11e8c28` — Harness, browser, model presets and desktop interaction

**What changed:**

- Connected `/goal`, `/plan`, goal editing and plan review to official Harness execution, compaction and completion ownership.
- Added session-bound embedded browser control, Playwright entries and a computer-operation skill. Allowed write, edit and browser tools are available on the first turn.
- Admitted screenshots through official attachment storage with durable references; observation failures preserve completed action receipts.
- Added LAN and Ollama Cloud presets for new installations with one default-configuration source, preserving existing settings and user-deleted presets.
- Improved long-code streaming, tool-argument status and file cards; added pet chat input, attachments and task notifications; simplified settings while retaining existing data-location compatibility and uninstall preservation boundaries.

**Why:** Actual acceptance runs sometimes produced code without writing files, or asked users to save code already written. First-turn tools and receipt-based reporting address that behavior. The model still interprets requests for examples; the host neither forces writes through keyword rules nor bypasses permission filtering.

Screenshots previously bypassed attachment admission, causing the next model request to fail on a missing `attachmentId`. The attachment and durable-reference path must remain intact. Executing an action and interpreting its resulting image are different facts: observation failure must not erase a completed action receipt and encourage duplicate clicks or input.

Repeated long-code highlighting was a reproduced rendering cost. Streaming code and historical code over 8,000 characters now use complete plain text, retaining copying and scrolling; layout writes are batched into animation frames. Separate argument-generation status prevents users from mistaking unfinished arguments for an executing tool.

Two presets let new users choose LAN or Cloud immediately. Applying defaults only during initialization protects existing preferences. Verified `kimi-k2.6` moved to the top of the cloud list because empty `kimi-k3` answers were independently reproduced through the API, rather than established as a frontend rendering defect. The shared-key distribution file is Git-ignored; fetching source does not retrieve the key.

Goals, plans, pet notifications and completion consume Harness or conversation facts to prevent inconsistent decisions across views. Saving a goal does not execute it, restart does not resume long-term goals automatically, and navigation alone does not establish that a conversation was viewed. Removing migration controls must retain existing-location reads so migrated users do not reopen the wrong data directory.

## `7ebdfcc` — Trilingual merge handoff and acceptance scope

**What changed:** Added Simplified Chinese, Traditional Chinese and English handoff documents covering scope, related files, dependency versions, build steps, credential delivery and validation limits. Added current-status notes to earlier development records.

**Why:** Changes span runtime, desktop and installers, making dependencies easy to miss in isolated file review. Earlier “rebuild pending” and “Mac LAN pending” notes were superseded by subsequent acceptance; chronology must be clear to avoid redundant fixes or incorrect conclusions. The documents distinguish automated tests, installed-product acceptance and untested scenarios, and clarify that real keys, installers and local evidence are excluded from Git.

## `78bc5ba` — Go validation follow-up

**What changed:** Updated all three handoff documents with validation using existing Go 1.27.2. `go test -count=1 -json ./...` passed all 31 tests with no failures or skips; `go vet ./...` reported no diagnostics. Both exited 0. No Go product source changed and no installer was rebuilt.

**Why:** Go was previously absent from PATH, so the commands never started. Locating the existing toolchain allowed the unvalidated status to be replaced with recorded commands and results. No defect required an implementation change. These tests do not establish real desktop-input E2E or macOS Swift-helper acceptance.
