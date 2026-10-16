# CodeBuddy 1.43.4 branding and delivery

## Scope

Workspace `D:\CodeBuddy-v1`, branch `main`, baseline `743bb5fbffd8592b900a93478df8b56f984957be` plus this batch. No branch change.

The application display name is CodeBuddy, installer name is `CodeBuddy-Setup.exe`, and version is `1.43.4`. The existing system-prompt configuration supplies the CodeBuddy identity, verified in an actual HTTP request regression. Execution, scheduling, completion and compaction remain with the existing runtime. Context-source labels, connection descriptions and task status text use the product name without changing their values or semantics.

Simplified Chinese, Traditional Chinese and English product guides describe current launch and build paths. The desktop guide removes obsolete commands. Installation ID `CodeBuddyHarness`, data directory `.CodeBuddy-Harness`, protocol engine values, dependency identifiers and provenance remain compatible. Licenses, copyrights and historical acceptance evidence remain intact. No independent tool changes or dependency downloads.

## Verification

Existing Node 24.21.0; all targeted commands exited 0: driver/projection/installer tests 22, provider/runtime integration tests 20, package identity/stage tests 2, context UI tests 3, total 47. TypeScript and affected-component ESLint passed. Local guide links passed. The original 661 sessions, providers and preferences remain intact. Exact commands are in the [Simplified Chinese record](2026-10-16-codebuddy-branding.zh-CN.md).

An initial broader historical branding/distribution suite had 42 passes and 10 failures. The package-description mismatch introduced here was fixed and re-tested. Nine remaining failures concern old TLS/telemetry/default-model assertions, build scripts and deleted migration code; that suite is not reported as passing. Local evidence: `.preview-evidence/h19-brand-tests.log`.

Staged runtime validation passed native session creation, PowerShell subprocesses, Office payload and compatibility service startup. Maximum installation path length is 246 characters. Desktop packaging was interrupted, then restarted as a full application build using the same verified runtime payload, without skipping changed source.

## Integration

Merge the changed source and all three language documents. Exclude `.preview-evidence`, `target`, profiles and credentials. Preserve installation and data identities. Do not globally replace dependency names or license contents.

## Package acceptance

The packaged application's real UI passed: CodeBuddy title; Kimi K3 conversation ended with native `end_turn`; conversation visible at 701 ms, assistant content at 6809 ms, stable UI at 10285 ms. These are one-sample observations, not latency guarantees. GitHub account connection, disabled MCP state and absence of the old error passed.

The first attempt was blocked by an enabled GitHub MCP connection missing `CODEBUDDY_GITHUB_MCP_TOKEN` in the isolated test profile. It was disabled using the real toolbox switch, then the test passed. Default user data was not modified. GitHub MCP tool execution remains untested.

Local evidence: `.preview-evidence/h19-ui-receipt.json`, `h19-ui.png`, `h19-hello.json`. Launching the packaged application does not constitute an installed upgrade test. No install/upgrade, full skill set, long project or macOS re-test was performed in this batch.

Packaging exited 0. Full NuGet app.asar and manifest match the tested application. Preserved at `target/codebuddy-1.43.4-before-merge/CodeBuddy-Setup.exe`, 363784192 bytes, SHA256 `865f58c2631dc4bf0c740e42f199d8bbf4a3d4482ac8f0af96d6bb977a3fcdc1`. This package predates the colleague frontend merge and is not the merged candidate.
