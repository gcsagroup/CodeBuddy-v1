# Local writes in the Git panel

Date: 2026-10-14. Working directory: `D:\CodeBuddy-v1`, copied from revision `964bbeb1587f1c5551ee17907e0b26632c4163ce` plus original uncommitted files recorded in `source-baseline.json`. The destination has no Git metadata. This work creates no development branch, commit or push. All test repositories, branches and commits belong to isolated OS temporary fixtures.

## Implementation and contract

The existing `ui/desktop/src/acp/git.ts` and `GitRepositoryPanel.tsx` remain unchanged. `runtime/git-extension.mjs` adapts the installed Git CLI into Harness host tools. `gitTools()` exposes seven reads plus five writes; `createGitReader()` continues to expose only seven reads for Review. The existing host/Harness permission path owns authorization.

| Existing UI tool    | Input       | Existing UI receipt                       |
| ------------------- | ----------- | ----------------------------------------- |
| `git_stage`         | `{paths}`   | `{staged_paths}`                          |
| `git_unstage`       | `{paths}`   | `{unstaged_paths}`                        |
| `git_commit`        | `{message}` | `{commit,branch,subject,committed_paths}` |
| `git_branch_create` | `{name}`    | `{branch,created:true}`                   |
| `git_branch_switch` | `{name}`    | `{branch,created:false}`                  |

Staging accepts explicit changed files found in actual status. Unstaging uses `git restore --staged`, requires an existing HEAD and preserves working files. Commit uses only the existing index and returns the actual Git commit. Creating a branch also switches to it; switching requires an existing local branch and never forces away local changes. Reads and writes share a queue keyed by the canonical repository. This is process-local coordination: external Git/editor activity still exists, with Git's own locks and refusal behavior retained.

Commands use fixed argument arrays and `execFile` without a shell. Literal pathspecs, `--`, repository-relative validation and actual status reject empty selections, traversal, metadata paths, broad directory selections and linked ancestors. Child processes inherit only Git runtime directories/system values, excluding model/MCP credentials and inherited Git repository overrides. Errors do not echo potentially sensitive raw CLI output.

The original Rust `run_git_with_env` already disables hooks and fsmonitor; this adapter retains that behavior. Reads disable external diff, textconv and external clean/smudge/process filters. Writes that actually use an external filter, including target-branch attributes, report that the repository's configured Git workflow is required. Merely having LFS installed globally does not block an ordinary repository. `commit.gpgsign=true` reports the unconnected signing workflow instead of silently making an unsigned commit. Branch attribute inspection uses `git check-attr --source`, verified with Windows Git `2.55.0.windows.2`; older Git versions and macOS remain unaccepted.

## Verification and remaining scope

`git-write.test.mjs` uses real temporary Git repositories, the original renderer parser and SDK `zGooseToolCallResponse_unstable`. It covers all five receipts, staged/unstaged isolation, unborn HEAD, dirty checkout rejection, paths, hooks/filters/signing, concurrency, cancellation and observed child-process environment. `git-write-acp.test.mjs` uses the real server, WebSocket and official Harness for bare tool names, SDK responses, seven panel reads without repeated prompts, five writes obeying `ask_before`, and rejection under `never_allow` or a removed Git extension. GitHub CLI receives an empty isolated profile. No user login configuration or remote Git write is used. A loopback model fixture only validates provider configuration; tool execution adds no model requests.

Node 24 `--test runtime/tests/git-write.test.mjs runtime/tests/git-extension.test.mjs runtime/tests/codepro-review.test.mjs runtime/tests/review-harness-integration.test.mjs`: 19 passed, exit 0. A separate `--test runtime/tests/git-write-acp.test.mjs` run passed 1 test, exit 0, including tool lists and preserved permissions after extension removal/re-addition. Automated/protocol checks do not establish acceptance of the Electron user flow or macOS.

This batch does not connect `git_restore_preview/restore`, `git_conflict_abort_preview/abort/continue`, `git_pull`, or `git_push_preview/push`. Their original snapshot binding, expiry and confirmation contracts must be retained; no fabricated preflight or generic-shell replacement is used. GitHub issues/PR/CI/OAuth are tracked separately.

## References

The existing system Git executable is reused without adding dependencies or copying Git implementation code. See the official [git-add](https://git-scm.com/docs/git-add), [git-switch](https://git-scm.com/docs/git-switch), [git-commit](https://git-scm.com/docs/git-commit), and [githooks](https://git-scm.com/docs/githooks) documentation, alongside the repository's original Rust/TypeScript contracts.
