# CodeBuddy Git Module Parity Design (English)

**Status:** In phased implementation
**Date:** 2026-09-07

[繁體中文（預設）](2026-09-07-codebuddy-git-module-parity-zh-tw.md) · [简体中文](2026-09-07-codebuddy-git-module-parity-zh-cn.md) · [English](2026-09-07-codebuddy-git-module-parity-en.md)

## Goal

Complete everyday source-control workflows quickly by reusing system Git, the existing credential manager, and CodeBuddy's ACP permission layer. CodeBuddy does not reimplement Git transport, authentication, or object storage.

## Comparison with public Codex behavior

OpenAI's public documentation describes Code review scopes for working-tree, staged, commit, and branch changes, together with stage, revert, commit, and push actions. Local tasks can also use Git worktree isolation. These are observable product contracts, not assumptions about private implementation.

- Adopt: explicit diff scopes, branch operations, path-scoped stage/unstage, push preview, and the worktree-isolation direction.
- Keep CodeBuddy-specific: the Rust host invokes Git with shell-free argument vectors, while the ACP registry classifies read-only, workspace-write, external-write, and high-risk permissions.
- Reject: guessed remote branches, silent stash/reset, destructive restore without a preview, and commit or pull from detached HEAD.

References:

- <https://learn.chatgpt.com/docs/code-review>
- <https://learn.chatgpt.com/docs/environments/git-worktrees>
- <https://git-scm.com/docs/git-restore>
- <https://git-scm.com/docs/git-merge>
- <https://git-scm.com/docs/git-rebase>
- <https://git-scm.com/docs/git-cherry-pick>
- <https://git-scm.com/docs/git-revert>

## First vertical slice

- `git_branch_create`: create and switch to a Git-validated local branch at the current `HEAD`, including detached-HEAD recovery.
- `git_branch_switch`: switch only to an exact existing local branch without remote guessing.
- `git_unstage`: unstage only explicit repository-relative paths without changing working-tree content.
- The desktop Git panel exposes local branch selection, new-branch entry, and per-file unstage, then reloads repository state after each operation.

## Second vertical slice

- `git_restore_preview`: accepts only explicit repository-relative paths, rejects untracked or conflicted paths, and binds the canonical workspace plus the complete binary diff to a SHA-256 receipt before display truncation.
- `git_restore`: recomputes that receipt immediately before running `git restore --worktree -- <paths>`, so a stale preview cannot discard newer edits and staged content remains untouched.
- The desktop Git panel shows the exact paths and diff, warns that the action is destructive, and requires both an in-panel confirmation and ACP high-risk permission approval.

## Third vertical slice

- `git_repository_snapshot`: reads status, conflicts, branches, working-tree diff, and staged diff concurrently through one read-only ACP call, avoiding five serialized tool initializations and session lifecycle acquisitions.
- `git_conflicts`: reports in-progress merge, rebase, cherry-pick, or revert state and unresolved paths; only merge mutations are enabled in this phase.
- `git_conflict_continue`: runs non-interactive `git merge --continue` only after no unresolved conflicts remain; users must still stage resolved files explicitly.
- `git_conflict_abort_preview` and `git_conflict_abort`: show affected paths and complete working/staged diffs, then bind the workspace, HEAD, merge markers, status, and full diffs to a SHA-256 receipt; any state change invalidates the old preview.
- During a conflict the desktop Git panel disables branch, sync, ordinary commit, and ordinary restore actions while preserving stage/unstage for resolution; aborting a merge requires both an in-panel confirmation and ACP high-risk permission approval.

## Fourth vertical slice

- `git_conflict_continue` now accepts the exact active merge, rebase, cherry-pick, or revert operation and invokes Git's native non-interactive `--continue` only after all unmerged entries are resolved and staged.
- `git_conflict_abort_preview` hashes the complete working/staged evidence together with the operation-specific Git state (`MERGE_HEAD`, rebase directories, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, and sequencer data). A plan-only state change invalidates the receipt even when the working tree is unchanged.
- `git_conflict_abort` invokes the matching native `--abort` only after the receipt is recomputed, preserving unrelated untracked files. The desktop panel enables the same four operations with operation-specific confirmation text; unknown conflict states remain read-only.
- Continue and abort remain protected ACP writes. Abort still requires both the panel confirmation and the host's high-risk permission approval.

## Fifth vertical slice

- `CodeProRunState.workspace` now persists a schema-versioned workspace authority descriptor with explicit mode, lifecycle, source and execution paths, revision, optional Git identity, and typed apply/discard recovery journal.
- Missing descriptors in historical JSON migrate conservatively to `direct_legacy` without Git metadata. Mode/metadata mismatches, empty paths, zero revisions, invalid hashes, and state-path inconsistencies fail validation.
- Saving state and checkpoint snapshots normalizes the descriptor before serialization, while the projection exposes only bounded lifecycle and identity fields rather than journal contents.
- This slice does not create a worktree or reroute execution. Existing direct runs remain visibly legacy until discovery, creation, ownership verification, and reopen are implemented and tested.

## Sixth vertical slice

- `git_runtime_status` now runs a bounded, cancellable `git --version` probe before the desktop loads repository state. It reports availability, a validated version string, and a platform-specific official `git-scm.com` installation page.
- When Git is missing, the repository panel stops before any repository command, asks whether the user wants Git, and requires a second explicit action before opening the validated official download page. The user restarts CodePro after installation so the new process receives the updated system PATH and probes again on startup.
- This slice does not silently download or execute an installer and does not invoke a package manager. System installation remains a user-controlled action.
- The published OpenAI Codex guidance does not specify automatic Git installation. It does describe progressing autonomously within the user's scope while preserving approval for destructive or irreversible actions. CodeBuddy adopts that confirmation boundary and does not infer private Codex installation behavior: https://developers.openai.com/api/docs/guides/latest-model

## Seventh vertical slice

- `github_runtime_status` detects the GitHub CLI separately from Git, then runs the official non-interactive `gh auth status --active --hostname github.com` check with bounded execution and no token output.
- The repository panel distinguishes GitHub CLI missing, installed but unauthenticated, and connected states. Missing `gh` does not block ordinary Git fetch, pull, push, or clone operations; it only marks future PR and Issue features as not ready.
- The bridge accepts only the fixed `github.com` host, `https://cli.github.com/` installation URL, and `gh auth login --hostname github.com --web` login command. It rejects backend-provided command or URL substitution.
- This follows the observable Codex contract: the published code-review documentation says PR context requires GitHub CLI and `gh auth login`. GitHub's CLI manual documents `gh auth status` as the supported authentication-state check.

References:

- <https://learn.chatgpt.com/docs/code-review>
- <https://cli.github.com/manual/gh_auth_status>
- <https://cli.github.com/manual/gh_auth_login>

## Eighth vertical slice

- The existing GitHub delivery path already provides Pull Request status, required checks, a bounded local preflight, and explicitly confirmed Pull Request creation. This slice reuses that path instead of introducing a second GitHub backend.
- The repository and Pull Request panels now share recovery actions. Missing `gh` offers the fixed official download page only after an in-app confirmation; unauthenticated `gh` copies the fixed login command and tells the user to finish authorization in a terminal before refreshing.
- CodeBuddy does not silently install GitHub CLI, start an interactive authentication process in the background, or capture credentials. Clipboard and browser failures remain visible and retryable.
- The public Codex code-review contract requires GitHub CLI plus `gh auth login` for Pull Request context. CodeBuddy adopts that observable prerequisite while retaining explicit user control at the installation and credential boundary.

## Ninth vertical slice

- The delivery panel now offers close only for an open Pull Request and reopen only for a closed Pull Request; merged Pull Requests remain read-only.
- A fresh preview binds the canonical GitHub repository, current branch, Pull Request number, title, URL, base branch, current state, and requested target state to a SHA-256 receipt. Execution repeats the inspection under the shared delivery-write lock and rejects stale or substituted receipts.
- The backend invokes only the fixed `gh pr close <number>` or `gh pr reopen <number>` argument vectors. Closing never passes `--delete-branch`, and timeout, cancellation, oversized output, or a non-zero exit is reported as an uncertain remote effect that requires inspection before retry.
- The desktop requires a deliberate action to open the dialog, a state preflight, and a second confirmation before the remote write. Automated and desktop acceptance never changes a real Pull Request.
- This adopts the observable Codex pattern of keeping Pull Request context in the review workflow while relying on the public GitHub CLI contract for mutations; it does not infer private Codex implementation details.

References:

- <https://learn.chatgpt.com/docs/code-review>
- <https://cli.github.com/manual/gh_pr_close>
- <https://cli.github.com/manual/gh_pr_reopen>

## Tenth vertical slice

- Open or closed Pull Requests can edit their title and body; merged Pull Requests remain read-only.
- The update flow requires the user to open the edit dialog, change the content, run a fresh preflight, and confirm a second time. The preflight binds the working directory, canonical GitHub repository, current branch, Pull Request number, old and new title and body, state, URL, and base branch into a SHA-256 receipt.
- Execution re-reads the Pull Request under the shared delivery write lock and rejects invalid, unchanged, substituted, or stale receipts. The backend invokes only the fixed `gh pr edit <number> --title <title> --body-file -` argument vector; the body is sent only through stdin and never through a shell or command-line argument.
- Timeout, cancellation, oversized output, or non-zero exit is reported as an uncertain remote effect that requires GitHub inspection before retry. Automated tests do not mutate a real Pull Request.
- This implementation continues the publicly observable Codex Pull Request context and confirmation-oriented workflow without inferring private Codex internals.

References:

- <https://learn.chatgpt.com/docs/code-review>
- <https://cli.github.com/manual/gh_pr_edit>

## Eleventh vertical slice

- The Issue panel uses fixed, bounded GitHub CLI arguments to list at most 20 open or closed Issues and binds every returned URL to the current canonical GitHub repository.
- Create, edit, close, and reopen all require a fresh SHA-256 preflight and a second confirmation. Execution re-reads the repository and Issue under the same remote-write lock as Pull Requests and rejects invalid, unchanged, substituted, or stale preflights.
- Titles are passed only as fixed `gh` arguments, while bodies are sent only through stdin with `--body-file -`. Timeout, cancellation, oversized output, or non-zero exit is always an uncertain remote effect; the UI stops further writes until the user inspects GitHub.
- This completes the GitHub Issue scope for this merge candidate. Published Codex documentation promises review, stage, revert, commit, push, and PR context; it does not list PR comments, reviewer management, or draft toggling as core Git workflow capabilities. Those three remain post-merge enhancements rather than gates for this candidate.

References:

- <https://learn.chatgpt.com/docs/code-review>
- <https://cli.github.com/manual/gh_issue_list>
- <https://cli.github.com/manual/gh_issue_create>
- <https://cli.github.com/manual/gh_issue_edit>
- <https://cli.github.com/manual/gh_issue_close>
- <https://cli.github.com/manual/gh_issue_reopen>

## Merge-candidate scope

1. Ordinary Git transport remains on system Git; GitHub CLI is limited to authentication, Pull Requests, and Issues.
2. Every GitHub mutation requires a fresh preflight, explicit confirmation, and fail-closed handling for uncertain effects.
3. Pull Request comments, review requests, and draft-state toggling are post-merge enhancements and do not block this candidate.
