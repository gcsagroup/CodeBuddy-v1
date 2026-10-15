# Ordinary chat working-directory changes

Date: 2026-10-14. Source: current files in `D:\CodeBuddy-v1`, without a Git revision. This batch contains no commits, pushes, or renderer changes.

## Contract and implementation

The original ACP `_goose/unstable/session/working-dir/update` accepts `{sessionId, workingDir}` and returns `{}` on success. The destination must be an existing absolute directory; the operation creates no directory. Active sessions, imported read-only histories, and CodePro sessions reject the change. CodePro remains bound to its task workspace lease.

The official `workingDirectory.set` changes the effective directory while explicitly retaining permissions. `sandboxPolicy.resolve` derives the workspace-write root from immutable `session.header.cwd`. Updating only a product field or invoking that setter would therefore leave directory and write boundary inconsistent.

`runtime/harness/working-directory.mjs` reuses public official `buildForkSeed`, `agents.create`, `workingDirectory.set`, and `sessions.flush` APIs. It retains the complete old log, creates a new native session header for the destination, reconciles any inherited directory projection, and flushes it. It adds no model loop, rewrites no old log, and never escalates the sandbox to full access. Special agent-preset compositions are explicitly rejected; current ordinary product sessions do not use them.

`conversation-driver.mjs` keeps the product session ID stable. Compat atomically saves the new native pointer, directory, and `directoryChanges` under the conversation lock. A failed save leaves an unpublished native fork while the old product pointer/session remains valid. Success releases the retired capability scope; the next ensure rebuilds Git, project memory, and MCP against the new directory. Retired native IDs disappear from the session-list projection while their logs remain. A failed scope release is explicitly logged and final cleanup occurs at service shutdown.

AGENTS and native file tools use the official directory mechanism; the new header also defines the new write boundary. Tool approval remains enforced, with no transfer of one-time grants. Historical messages and tool results remain, so old project information in conversation history does not imply leakage from the current project-memory scope. Active memory retrieval and injection use the new directory only.

## Verification and boundaries

Command: `node --test runtime/tests/working-directory-harness.test.mjs runtime/tests/working-directory-acp.test.mjs runtime/tests/conversation-editing.test.mjs runtime/harness/test/mcp-apps.test.mjs`. All 14 tests passed with exit code 0: 4 directory tests, 6 conversation-editing regressions, and 4 MCP driver regressions.

The isolated `.preview-evidence/codebuddy-directory-harness-*` fixture lies outside system Temp. It verifies A→B→restart→C, relative file writes/reads in the new directory, and actual file-sandbox denial when the B session attempts an absolute write into old A. Both model working-directory and write-root contexts identify B exactly. Other temporary fixtures verify history, AGENTS, approval, invalid destinations, active/CodePro/read-only rejection, project-memory isolation, and actual stdio MCP PID termination and replacement cwd.

Tests use the official Harness, ACP, original SDK Zod, controlled local model HTTP, and stdio MCP. They create no branches or commits in user projects. These results do not establish actual Electron directory-picker interaction or macOS acceptance. File-sandbox checks do not establish equivalent operating-system isolation for PowerShell processes.

## References

Uses the locally pinned MIT-licensed DeepSeek Harness `0.2.1-alpha.2`. Public types and implementations of `dsh-working-directory`, `dsh-sandbox-policy`, `dsh-agent`, and `dsh-session` were inspected. The official [tool catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md) describes directory and backend responsibilities; the pinned local version determines the actual integration. No new dependencies or vendored changes.
