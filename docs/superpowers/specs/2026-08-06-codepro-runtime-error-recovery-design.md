# CodePro Runtime Error Recovery Design

## Context

Two production failures currently collapse a usable CodePro conversation into the same fatal "failed to load session" screen:

1. Legacy runtime prompts intentionally skip durable run registration, but completion, cancellation, and stream-failure bookkeeping still query the durable control plane and can return `UnknownRun`.
2. Evidence capture treats every workspace without a direct `.git` child as a native workspace. A session rooted at a Windows drive such as `D:\` therefore recursively reads the drive until the 64 MiB native baseline limit aborts the prompt.

The second failure message recommends installing Git even when Git is already installed. Both failures are prompt-execution failures, not session-load failures.

This design extends the focused legacy boundary design in `2026-08-06-legacy-run-registration-design.md` with workspace safety and recoverable desktop error presentation.

## Goals

- Legacy CodePro prompts complete, fail, and cancel without requiring durable run registration.
- CodePro never scans a filesystem root as a project evidence baseline.
- A non-Git project uses the temporary Git evidence engine whenever Git is available.
- A prompt submission failure leaves the current conversation usable and visible.
- Retrying remains in the same conversation.
- Automated tests and a real Windows desktop walkthrough are required before completion.

## Non-goals

- Automatically invent or rename a project directory from a natural-language prompt.
- Raise the 64 MiB native fallback limit.
- Enable durable runtime authority in legacy mode.
- Weaken explicit Shadow/Durable `run/get`, control, or effect-resolution validation.
- Redesign the complete chat error system.

## Considered approaches

### A. Raise the native baseline limit

Rejected. It increases memory, latency, and privacy exposure while leaving a drive-root scan possible.

### B. Register every Legacy run in the durable control plane

Rejected. It changes Legacy semantics and partially activates a control plane that is intentionally disabled.

### C. Enforce mode and workspace boundaries, then recover in place (selected)

Use one predicate for optional durable lifecycle bookkeeping, reject filesystem roots before traversal, prefer the temporary Git evidence engine for ordinary directories, and separate prompt errors from session-load errors in desktop state.

This fixes each error at its source without changing runtime authority or hiding durable integrity failures.

## Backend design

### Optional control-plane lifecycle

`CodeProControlService::tracks_prompt_runs()` reports whether the effective runtime mode is not Legacy. It is the single predicate used by prompt registration and optional lifecycle methods.

In Legacy mode:

- `snapshot_if_available` returns `Ok(None)`.
- `cancel_prompt_run` returns `Ok(None)`.
- `fail_prompt_run` returns `Ok(None)`.

Explicit control-plane APIs remain strict and continue returning `UnknownRun` for unregistered Shadow/Durable runs.

### Evidence workspace preflight

After canonicalizing the evidence root and before creating a walker or reading a file, `CodeProEvidence::capture` rejects any path with no parent. This covers Windows drive roots and the platform filesystem root.

The user-facing error includes the rejected path and instructs the user to select or create a specific project folder. It does not recommend installing Git for this case.

For a normal directory, evidence capture attempts to initialize its private temporary Git repository regardless of whether the user's directory contains `.git`. If the Git executable is missing, the existing bounded native fallback remains available for small workspaces. The user's repository and index are not modified.

## Desktop design

`AcpChatSessionSnapshot` gains `promptError`, distinct from `sessionLoadError`.

- `failSessionLoad` remains the only path that enters the fatal session-load screen.
- `finishPromptAttemptIfCurrent` stores prompt failures in `promptError`, returns the chat to `Idle`, and preserves session metadata and messages.
- Starting another prompt clears the prior prompt error.
- A compact dismissible error banner appears above the composer while the normal conversation remains rendered.
- Dismissing the banner clears only `promptError`.

No new conversation is created by this recovery path. Existing in-place retry behavior remains authoritative.

## Error flow

```text
prompt starts
  -> workspace/control preflight
  -> failure
  -> promptError set, chat returns to Idle
  -> current messages and composer stay visible
  -> user dismisses or retries in the same session
```

Only a failure while loading session metadata or history sets `sessionLoadError` and renders the fatal load screen.

## Test strategy

### Rust regression tests

- Legacy unregistered snapshot, cancellation, and failure lifecycle calls return `None`.
- Shadow unregistered lifecycle calls still return `UnknownRun`.
- Filesystem roots are rejected before evidence scanning.
- A non-Git temporary project uses the temporary Git evidence engine when Git is available.
- The missing-Git native fallback still works for a small project.

### Desktop regression tests

- A prompt failure sets `promptError` and does not set `sessionLoadError`.
- Starting the next prompt clears `promptError`.
- A real session-load failure still sets `sessionLoadError`.
- The prompt error banner renders the message and dismisses it without leaving the conversation.

### Required Windows acceptance walkthrough

After automated verification and packaging/development build:

1. Launch CodeBuddy.
2. Open or create a CodePro conversation for a concrete small project folder.
3. Submit a simple development task and verify it does not end in `UnknownRun` under Legacy mode.
4. Exercise a drive-root session or the deterministic test-error equivalent and verify the error is shown inside the current conversation, not as "failed to load session".
5. Dismiss the error and verify the same composer remains usable.
6. Retry from the same conversation and verify no duplicate conversation appears in the sidebar.

## Acceptance criteria

- Neither reported error produces the fatal session-load screen.
- Legacy normal completion does not return `UnknownRun`.
- Drive-root evidence capture performs no recursive baseline scan.
- Prompt errors preserve the current session and composer.
- Targeted and full Rust/frontend gates pass.
- The desktop user walkthrough is completed with screenshots or equivalent observed UI evidence.

## Risk and rollback

The main backend risk is weakening durable validation; Shadow negative tests prevent it. The main frontend risk is stale errors crossing attempts; start-attempt clearing tests prevent it. The work is split into backend and desktop commits so either layer can be reverted independently.
