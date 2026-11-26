# SDK adaptation for tool and skill discovery

This adaptation reduces resident context for unused capabilities without removing user instructions, project rules, permission boundaries, or loaded skill bodies.

## Design and compatibility

The SDK is pinned to `0.2.1-alpha.2`. Source hashes for the skill plugin and registry are checked before applying an in-memory adaptation; `node_modules` is never edited. The main agent receives a skill-summary index with a 640-character line budget, prioritizing project/user-installed skills over bundled defaults. Guidance is retained separately. The native durable `source.entries` remains complete and is not sent as model content. Subagents and scopes without compatible discovery retain native full rendering.

`search_mcp_tools({kind:"skills",query,offset})` returns at most five currently invocable summaries per page. Alternative keywords or empty-query pagination recover from missing matches. The native `skill({name})` tool still loads instructions and enforces permissions. MCP service-name indexes are bounded to 320 characters; tool definitions load on demand. Discovery receipts explicitly carry `discoveryOnly` and a stage, distinguishing schema loading from actual execution.

Filesystem skills reuse their existing document-version hash. The registry adaptation forwards revisions from native winning candidates so body-only edits republish the native catalog with reload guidance. No second registry, authorization state, or catalog cache is introduced. Other providers without content revisions retain existing invalidation semantics. Diagnostics contain character/byte counts, not content or credentials; actual usage remains provider-reported.

Removing `catalogIndexMaxCharacters` from `profile.mjs` restores full native rendering while retaining content-revision support. Optional `source.presentation` and entry `revision` fields tolerate older history and trigger republication when needed. Existing user messages are not rewritten, deleted, or migrated. Previously saved long catalogs are not retroactively removed; Harness still owns compaction.

## Validation and limitations

Regression coverage includes final HTTP request size with 10/100/1,000 skills, complete pagination, scope and invocation policy, live additions/removals, body updates, rollback, cold restoration, native loading, and denied tool execution. Native contract tests cover driver, model-metadata, and real server imports.

Earlier greeting samples recorded 1,368 → 948, but diagnostics did not retain all cache counters, so complete input cannot be reconstructed retrospectively. Corrected measurements supersede those figures. The isolated fixture is not the screenshot configuration, not a matched comparison against 2,277 tokens, and not evidence that the proposed 40% goal was reached.

Correction: early tool/skill measurements summed native `inputTokens` but omitted `cacheReadTokens` and `cacheWriteTokens`. The earlier 6,692 → 3,223 and 13,386 → 4,367 figures represent uncached input, not total input or billing savings. Diagnostics now retain cache read/write and total counters. Complete input is uncached input plus cache reads plus cache writes. Old evidence remains available but is no longer accepted as evidence of whole-turn reduction.

Testing exposed stale skill-body reuse and one fabricated answer after schema discovery without execution. These were addressed and retested; original failure evidence is retained. Structured discovery receipts and guidance cannot guarantee that a model never fabricates results. Acceptance checks actual calls and returned values, not assistant prose alone.

This round validates the Windows source SDK and real-model calls, not complete Windows/macOS desktop E2E or new installers. Using the existing Node 24, run `node --test` on skill-discovery, tool-discovery, computer-skill, capabilities, transport-observation, and request-fit-contract under `runtime/harness/test/`, plus toolbox-hot-update and shared-skills under `runtime/tests/` (all `.test.mjs`). Local request-level evidence lives in `.local/context-budget-plan-20261124/` and is not committed. Restart previews via the README entry point before assessing these changes in the application.

Design references: [tool context management](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context), [MCP code-execution discussion](https://www.anthropic.com/research/code-execution-with-mcp), and the [Agent Skills specification](https://agentskills.io/specification). No external implementation was copied, no dependency added, and no semantic routing model introduced.

## Deep validation, 2026-11-24

All 36 real-model tasks with corrected accounting passed functional checks (baseline/aggressive/conservative, three per category). Median complete input, including cache reads/writes and retransmitted history, was: greeting 945/851/905; skill 5,808/5,576/8,482; follow-up file write/read-back 18,365/18,893/24,667; MCP 6,957/9,142/7,987. Neither candidate established stable whole-turn savings. Both were reverted to the pre-turn loading policy and 640-character index. Small samples and varying reasoning/tool trajectories do not establish causality for individual wording or universal regression magnitudes. Only native cache/total diagnostic accounting is retained; desktop billing counters and execution protocols are unchanged.

The related 89-test suite passed; all 35 affected tests passed again after accounting correction and restoration (exit 0). Earlier functional evidence additionally covers changing service data across turns, denied skill approval, body hot update and cold restoration. One initial harness false negative required the write tool and rejected a correct PowerShell write/read-back; raw evidence is retained. The corrected 36-task suite passed independently.

Source: main / 3a28db09 plus uncommitted changes. No commit, push, desktop restart, installer or Windows/macOS desktop E2E. Evidence: .local/context-depth-20261124/acceptance.json. Live runners closed and cleaned their own fixtures; previously policy-blocked legacy-directory cleanup was not retried.
