# CodePro Runtime Error Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Legacy control-plane and unsafe workspace-baseline failures from replacing the active CodePro conversation with a fatal session-load screen.

**Architecture:** Keep Legacy runtime bookkeeping optional while preserving strict Shadow/Durable validation. Reject filesystem roots before evidence traversal, prefer the existing temporary Git evidence engine for normal directories, and represent prompt failures as recoverable desktop state distinct from session loading.

**Tech Stack:** Rust, Tokio, ACP, React, TypeScript, Zustand-style external session store, Vitest, Electron on Windows.

## Global Constraints

- Do not register Legacy prompts in durable storage.
- Do not weaken explicit Shadow/Durable unknown-run validation.
- Do not raise the 64 MiB native baseline limit.
- Do not scan a filesystem root.
- Keep retry in the current conversation.
- Add no dependency.
- Run automated verification and a real Windows desktop mouse walkthrough before completion.

---

### Task 1: Make optional prompt lifecycle mode-aware

**Files:**
- Modify: `crates/goose/src/acp/server/codepro_control.rs`
- Modify: `crates/goose/src/acp/server.rs`
- Test: `crates/goose/src/acp/server/codepro_control.rs`

**Interfaces:**
- Produces: `CodeProControlService::tracks_prompt_runs(&self) -> bool`
- Consumes: `RuntimeModePolicy::effective()` and `CodeProRuntimeMode`

- [ ] **Step 1: Write failing Legacy and Shadow regression tests**

Add a Legacy test that calls `snapshot_if_available`, `cancel_prompt_run`, and `fail_prompt_run` for an unregistered run and expects `Ok(None)`. Add a Shadow test that calls the same snapshot boundary and expects `CodeProControlError::UnknownRun`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
$env:CARGO_TARGET_DIR='D:\CodeBuddy\target'
cargo test -p goose --lib acp::server::codepro_control::tests -- --nocapture
```

Expected: Legacy unregistered lifecycle test fails with `UnknownRun`; existing tests remain green.

- [ ] **Step 3: Implement the minimal mode boundary**

Add:

```rust
pub(super) fn tracks_prompt_runs(&self) -> bool {
    self.runtime.mode_policy().effective() != CodeProRuntimeMode::Legacy
}
```

Return `Ok(None)` at the beginning of the three optional lifecycle methods when the predicate is false. Replace the duplicated registration-mode comparison in `server.rs` with the predicate.

- [ ] **Step 4: Run focused Rust tests and format**

Run the focused test command from Step 2, then:

```powershell
cargo fmt --all -- --check
```

Expected: all focused tests pass and formatting is clean.

- [ ] **Step 5: Commit the backend lifecycle slice**

```powershell
git add crates/goose/src/acp/server.rs crates/goose/src/acp/server/codepro_control.rs
git commit -m "fix: keep Legacy prompt lifecycle outside durable control"
```

### Task 2: Reject filesystem roots and prefer temporary Git evidence

**Files:**
- Modify: `crates/goose/src/agents/codepro_evidence.rs`
- Test: `crates/goose/src/agents/codepro_evidence.rs`

**Interfaces:**
- Produces: `ensure_scannable_evidence_root(&Path) -> Result<()>`
- Consumes: existing `capture_with_git_program`, native fallback, and temporary Git evidence implementation

- [ ] **Step 1: Write failing evidence regression tests**

Add a platform-neutral test that finds the last ancestor of `current_dir`, passes it to `ensure_scannable_evidence_root`, and expects an error containing `项目文件夹`. Add a non-Git temporary-directory test that calls `CodeProEvidence::capture` and expects `git_dir.is_some()` when Git is available.

- [ ] **Step 2: Confirm RED without scanning a real drive root**

Run:

```powershell
$env:CARGO_TARGET_DIR='D:\CodeBuddy\target'
cargo test -p goose --lib agents::codepro_evidence::tests -- --nocapture
```

Expected: compilation/test failure because the root guard is absent and non-Git workspaces choose the native baseline.

- [ ] **Step 3: Add preflight and change Git selection**

Immediately after canonicalization, call:

```rust
ensure_scannable_evidence_root(&working_dir)?;
```

The helper rejects `path.parent().is_none()` with an error containing the path and a request to select or create a specific project folder. Remove the direct `.git` early return so temporary `git init` is attempted for every safe directory. Retain the existing `ErrorKind::NotFound` native fallback.

- [ ] **Step 4: Run evidence tests and formatting**

Run the Task 2 focused test, then `cargo fmt --all -- --check`.

Expected: root guard, temporary Git, missing-Git fallback, and existing evidence tests pass.

- [ ] **Step 5: Commit the workspace safety slice**

```powershell
git add crates/goose/src/agents/codepro_evidence.rs
git commit -m "fix: preflight CodePro evidence workspaces"
```

### Task 3: Separate prompt failures from session-load failures

**Files:**
- Modify: `ui/desktop/src/acp/chatSessionStore.ts`
- Modify: `ui/desktop/src/hooks/useChatSession.ts`
- Modify: `ui/desktop/src/hooks/useChatSessionTypes.ts`
- Test: `ui/desktop/src/acp/__tests__/chatSessionStore.test.ts`
- Test: `ui/desktop/src/acp/__tests__/chatSessionController.test.ts`

**Interfaces:**
- Produces: `AcpChatSessionSnapshot.promptError: string | undefined`
- Produces: `AcpChatSessionActions.clearPromptError(sessionId): AcpChatSessionSnapshot`
- Consumes: `finishPromptAttemptIfCurrent(..., error?)`

- [ ] **Step 1: Write failing store and controller tests**

Assert that a failed current prompt stores the error in `promptError`, leaves `sessionLoadError` undefined, returns to `Idle`, and preserves the session. Assert that `startPromptAttempt` and `clearPromptError` clear only the prompt error. Update controller snapshot fixtures with `promptError: undefined` and verify rejected ACP prompts finish with the submitted error without calling `failSessionLoad`.

- [ ] **Step 2: Confirm frontend RED**

Run:

```powershell
pnpm test:run -- src/acp/__tests__/chatSessionStore.test.ts src/acp/__tests__/chatSessionController.test.ts
```

Expected: type/test failures because `promptError` and `clearPromptError` do not exist.

- [ ] **Step 3: Implement recoverable prompt state**

Add `promptError` to snapshot and entry initialization. Store prompt errors in `finishPromptAttemptIfCurrent`; do not write them to `sessionLoadError`. Clear `promptError` at prompt start and expose it through `useChatSession`.

- [ ] **Step 4: Run focused frontend tests and typecheck**

Run the focused test command and:

```powershell
pnpm typecheck
```

Expected: focused tests and TypeScript compile pass.

- [ ] **Step 5: Commit the desktop state slice**

```powershell
git add ui/desktop/src/acp/chatSessionStore.ts ui/desktop/src/acp/__tests__/chatSessionStore.test.ts ui/desktop/src/acp/__tests__/chatSessionController.test.ts ui/desktop/src/hooks/useChatSession.ts ui/desktop/src/hooks/useChatSessionTypes.ts
git commit -m "fix: preserve chats after prompt submission errors"
```

### Task 4: Render a dismissible prompt error in the active conversation

**Files:**
- Create: `ui/desktop/src/components/PromptErrorBanner.tsx`
- Create: `ui/desktop/src/components/PromptErrorBanner.test.tsx`
- Modify: `ui/desktop/src/components/BaseChat.tsx`

**Interfaces:**
- Consumes: `message: string`, `onDismiss(): void`
- Produces: accessible alert with dismiss button

- [ ] **Step 1: Write the failing component test**

Render `PromptErrorBanner`, assert `role="alert"`, the supplied message, and a dismiss button. Click dismiss and assert the callback fires once.

- [ ] **Step 2: Confirm component RED**

Run:

```powershell
pnpm test:run -- src/components/PromptErrorBanner.test.tsx
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement and integrate the banner**

Create a compact red bordered banner with `AlertCircle` and `X` icons, visible text, `role="alert"`, and an accessible dismiss label. Render it above `ChatInput` when `promptError` exists and dismiss through `clearPromptError(sessionId)`. Do not alter the fatal `sessionLoadError` branch.

- [ ] **Step 4: Run component, store, type, and lint checks**

Run the component test, the Task 3 focused tests, `pnpm typecheck`, and `pnpm lint:check`.

Expected: all commands pass with zero warnings.

- [ ] **Step 5: Commit the desktop presentation slice**

```powershell
git add ui/desktop/src/components/PromptErrorBanner.tsx ui/desktop/src/components/PromptErrorBanner.test.tsx ui/desktop/src/components/BaseChat.tsx
git commit -m "fix: show prompt errors inside the active chat"
```

### Task 5: Full verification and Windows user acceptance

**Files:**
- Verify only; do not modify production files unless a test exposes a defect.

- [ ] **Step 1: Run full automated gates**

Run:

```powershell
$env:CARGO_TARGET_DIR='D:\CodeBuddy\target'
cargo test -p goose --lib
cargo clippy -p goose --all-targets -- -D warnings
pnpm --dir ui/desktop test:run
pnpm --dir ui/desktop typecheck
pnpm --dir ui/desktop lint:check
```

Expected: every command exits 0. Record counts and any pre-existing skips.

- [ ] **Step 2: Build the development desktop application**

Run the repository's Windows development backend preparation and Electron startup commands. Confirm the new backend binary is the one launched by the UI.

- [ ] **Step 3: Perform mouse-driven acceptance walkthrough**

Using Windows Computer Use, launch CodeBuddy and execute all six steps from the design's required walkthrough. Capture screenshots of the recoverable error state and the unchanged sidebar after same-session retry.

- [ ] **Step 4: Review the complete diff**

Review tests first, then implementation for correctness, architecture, security, performance, and accidental generated-file changes. Run `git diff --check` and confirm only intended files are changed.

- [ ] **Step 5: Integrate only after verification**

Follow the finishing-development-branch workflow. Preserve all unrelated dirty files in the primary checkout and merge only the verified commits.
