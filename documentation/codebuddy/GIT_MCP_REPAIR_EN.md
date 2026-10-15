# Git MCP repair and merge handoff

Baseline: CodeBuddy main / 00a6656 plus uncommitted repairs. Pre-existing installer changes and ACP formatting are excluded.

## Changes

1. MCP still performs writes. ExtensionManager strips untrusted metadata and observes working-tree and Git index/ref changes; MainAgentActionFacts consumes host evidence. Existing permission and completion owners remain authoritative.
2. Missing/relative paths bind to the task workspace, preventing mutable server directory state from disagreeing with audited scope.
3. Normal branch pushes receive external-effect evidence only after a host ls-remote query to the actual push URL matches the intended SHA. Dry runs, deletion, tags, multiple push URLs and linked-worktree metadata outside the task workspace do not receive this evidence.
4. Windows Git descendants use the existing Job Object owner. MCP timeout/cancellation terminates the supervisor and its descendants; see actual acceptance results.
5. Status uses NUL-delimited porcelain v2 records. Merge checks the unmerged index, reports conflicts as errors while preserving state, and checks abort exit codes.
6. Signing follows repository configuration without forcing upstream -S by default; explicit GIT_SIGN_COMMITS remains respected. Authentication is noninteractive.

## Merge behavior

Git merges independent edits. For content conflicts, the Agent inspects both requirements, edits, tests, stages and commits. Ambiguous product intent requires a specific question, preserving conflict state. No blanket ours/theirs replacement. Tests use isolated repositories and the designated GitHub test branch; product main is not merged or pushed.

## Files / 檔案 / 文件

- crates/goose/src/agents/git_mcp.rs
- crates/goose/src/agents/extension_manager.rs
- crates/goose/src/agents/tool_execution.rs
- crates/goose/src/agents/tool_task.rs
- crates/goose/src/agents/mod.rs
- crates/goose-cli/src/main.rs
- scripts/git-mcp-adapter.cjs
- scripts/git-mcp-adapter.test.cjs

## Runtime

`@cyanheads/git-mcp-server@2.15.3` (Apache-2.0). Keep its original bundle unchanged; the adapter generates `dist/index.codebuddy.js` alongside it. A version/anchor mismatch stops configuration.

`node scripts/git-mcp-adapter.cjs RUNTIME_ROOT GOOSE_EXECUTABLE`

The executable must contain this patch. Enable `git_merge` in the existing `local_git` tool allowlist. The launcher uses the existing Node runtime and credentials; do not commit profile data, credentials, bundles or test repositories.

## Checks

- `node --test scripts/git-mcp-adapter.test.cjs`
- `cargo test -p goose --lib git_mcp --jobs 4`
- `cargo clippy -p goose-cli --bin goose --jobs 4`
- `cargo build -p goose-cli --bin goose --jobs 4`

Use the repository's Windows development build environment. See the final acceptance report for actual results; commands here are not a pass claim.

## References

- [Upstream Git MCP](https://github.com/cyanheads/git-mcp-server)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

## Known conflicts versus uncertain effects

The adapter classifies a conflict only after Git returns exit code 1 and the index contains unresolved entries. The host independently checks MERGE_HEAD and the unmerged index before recording a known conflict. The result remains a failed tool call, never a successful merge, but does not permanently poison subsequent completion. Timeouts, cancellations, generic failures and spoofed markers remain subject to uncertainty checks. Old sessions without the new receipt are not retroactively cleared.

The adapter converts Windows verbatim path prefixes to their equivalent ordinary spelling before upstream workspace validation; out-of-root paths remain rejected.

When expected_effect is absent, the coverage error now directs the model to revise requirement semantics first and submit evidence against the new revision. External effects must reference host receipt resource IDs. This improves repair guidance without relaxing evidence requirements.

## Acceptance 2026-09-30 — Kimi scenarios passed with limitations

Development backend SHA256: 10385E8681E4461B36EBE3B7BBC6EF5D8BD9B46360D105445D126D6CB6D52D11. Base main / 00a6656 plus pending repairs; no backend source changes in this continuation.

- Automated checks: Git regressions 6/6, completion regressions 50/50, adapter 4/4. Rust sets overlap. Clippy/build exit 0; 25 existing warnings.
- Real MCP: 24 basic/rejection calls (5 expected rejections), 6 merge/conflict/abort calls, path boundaries, cancellation and 60-second timeout descendant cleanup passed.
- Fresh conflict chat 20260930_28 passed: the agent triggered and edited a real conflict, retained both behaviors, passed both unchanged original tests, and pushed verified two-parent merge d5e8d68 to the local fixture remote. Draft preserved; host finished without a pause reason.
- GitHub push chat 20260930_29 passed: only the new test file was committed; 2c791c8 independently verified on the designated branch, draft preserved, host finished.
- GitHub pull chat 20260930_30 passed: actual fast-forward to colleague commit 54c4c3d, contents/remote SHA/draft verified independently, host finished.

Limitations: previous local Qwen chat acceptance remains unsuccessful. These Kimi runs do not establish universal stability. Completion coverage still required repair of wrong receipt IDs and unchanged files mistakenly listed as modification targets. Internal verification jargon also leaked into final replies. Session 20260930_27 resumed previously edited content and was stopped while waiting for the final model response; it is not independent conflict-resolution acceptance.

After user approval, minimal kimi-k3 tool probes returned HTTP 200 on both /api/chat and /v1/chat/completions. The earlier DeepSeek HTTP 410 does not prove the compatibility endpoint is globally unavailable. The product Ollama engine still uses /v1/chat/completions for chat; no native chat protocol migration occurred. Creating a temporary provider hit the Windows credential record limit of 2560 characters. Testing reused the original provider; the credential capacity issue remains unresolved.

Restored shell never_allow, original custom_1 provider file and default deepseek-v4.1-flash. Kimi acceptance does not validate that original default. No credentials in repository; source uncommitted; only the designated GitHub fixture branch received commits.

Evidence: D:/CodeBuddy/.cargo/codebuddy-git-mcp/acceptance-summary.json and fresh-kimi-conflict-chat.json, conflict-independent-result.json, kimi-push-chat.json, kimi-pull-chat.json, kimi-*-independent-result.json.
