# Harness Git and code review adapter

## Scope

The existing frontend uses ACP and official deepseek-harness for Git inspection and independent code review. Git CLI owns repository facts, `CodeProReviews` owns review state, and Harness executes the model. A completed review does not establish project completion or passing tests.

`runtime/git-extension.mjs` provides seven read-only tools: Git runtime status, GitHub CLI status, repository snapshot, status, conflicts, branches, and diff. Both `git__` names and the frontend's bare names are supported, with the original JSON fields and text content. Git is an enabled builtin by default, avoiding the old frontend's duplicate platform-Git cleanup rule. Disabled extensions do not supply tools to the session.

Git inspection uses fixed arguments, porcelain NUL records, output bounds, and cancellation. Inherited Git routing variables are removed. Optional index writes, fsmonitor, external diff, textconv, lazy fetch, and configured clean/smudge/process filters are disabled. Unknown or failed states remain errors instead of appearing as an empty repository.

## Review behavior

`runtime/codepro-review.mjs` implements the existing snapshot/start/get/cancel RPCs. Working-tree scope compares the index with current files and includes untracked files. Staged scope compares HEAD with the index. Branch scope compares merge-base with HEAD. Two consecutive matching fingerprints are required before accepting a snapshot; content and model selection are checked again before execution.

Snapshots allow 64 KiB per file, 200 files, and 256 KiB of total content. Sensitive paths, links, non-regular files, binary content, invalid UTF-8, and excess content are explicitly excluded. Existing jsdiff 5.0.0 computes differences in a cancellable Worker. The model receives the fixed snapshot and can only invoke `codebuddy_review_result`. The host validates that findings refer to actual snapshot hunks. Empty findings do not constitute success when coverage is partial.

A valid structured proposal and normal Harness completion are both required to commit completed. Plain text does not establish review success. Cancellation waits for actual execution to exit. Timeouts become failed; running records left by a process restart become interrupted while history is retained. Reads recompute current/stale/unknown freshness and never automatically rerun the model.

## Validation and remaining boundaries

Node tests run against the current source: `runtime/tests/git-extension.test.mjs`, `runtime/tests/codepro-review.test.mjs`, and `runtime/tests/review-harness-integration.test.mjs`. They exercise the original UI parsers and SDK Zod, real temporary Git data, unchanged indexes, snapshot/location/freshness checks, cancellation/restart, and ACP → official Harness → a local HTTP model → actual host receipts. They use neither user repositories nor real cloud models.

Git staging, restore, commits, branch changes, pull, and push still require adapters preserving their original preview contracts. Read-only tests do not establish support for these mutations. Real Electron review interaction, real model quality, and macOS product acceptance must be checked separately. This record is not installer or complete-release acceptance.

References: [Git status](https://git-scm.com/docs/git-status), [Git diff](https://git-scm.com/docs/git-diff), and [jsdiff](https://github.com/kpdecker/jsdiff). The existing cyanheads Git MCP adapter has a different Windows runner and output contract; its old Agent execution path is not used to replace Harness.
