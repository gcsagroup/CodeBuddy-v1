# CodeBuddy security

[简体中文](../SECURITY.md) · [繁體中文](security.zh-TW.md) · [English](security.en.md)

Updated: 2026-11-20. This describes the current Harness desktop architecture. The retired Code / CodePro four-role workflow is not a security boundary.

## Capabilities and data boundaries

CodeBuddy can read projects, edit files, execute commands and use enabled browser, desktop, Office, media and external MCP tools. The agent runtime owns Agent execution, subagents, permissions and context compaction. Electron/TypeScript provides the desktop; Rust supplies independent MCP tools. See the [Harness documentation](../runtime/harness/README.en.md).

Tasks may modify the selected workspace directly. Chats, the main conversation and custom agents are not separate operating-system sandboxes. Do not assume every task has a project copy, automatic rollback or independent review. Check the directory and Git diff and keep backups.

## Permissions and approvals

- The desktop exposes read-only, workspace-write and full-access native presets. Confirmed Harness permission state and tool policy determine execution.
- Full access may execute without asking each time. No approval dialog does not imply safety. Subagents capture permissions when created; changing the parent session does not retroactively update running subagents.
- Native sandboxing constrains files and commands. Windows has upstream compatibility limitations; this does not guarantee complete isolation of every tool or external service.
- MCP services, user browsers and desktop control also depend on connections, accounts and server permissions. Enable only needed capabilities; a tool switch is not OS isolation.
- An accepted cancellation request does not prove a remote job has stopped. Check final receipts before retrying generation, upload or publication.

## Data and third-party content

The default data root is `~/.CodeBuddy`, including model configuration, sessions, workspaces, logs and caches. `CODEBUDDY_HOME` can override it; see [storage and migration](storage-layout.en.md). Pulling source does not synchronize this local data.

Model requests may contain selected files, images, tool results and history. Network tools may send queries or content to third parties. Check the provider, endpoint and data policy before use. Documentation queries and media services need their own network access, credentials or runtime payload. Saved configuration does not prove successful connection or invocation.

Web pages, repositories, images, documents, tool results and skills can contain prompt injection. Treat their instructions as untrusted input, especially requests to delete, overwrite, write outside the workspace, access credentials or send content externally. Do not commit real secrets, personal conversations or unredacted logs to Git, issues or fixtures.

## Verification and reporting

Check actual file differences, command exit codes, tool receipts and application results. Model completion claims, builds and component tests do not establish complete user-flow acceptance. Verify installers, source previews, Windows and macOS separately. See the [current update scope](updates-20261120.en.md).

The maintainer is [@erjinyi-bool](https://github.com/erjinyi-bool); the repository is [CodeBuddy-v1](https://github.com/erjinyi-bool/CodeBuddy-v1). GitHub private vulnerability reporting was not confirmed available for this private repository during this review. Ordinary issues are not confidential channels.

Use a private reporting entry if the [Security page](https://github.com/erjinyi-bool/CodeBuddy-v1/security) offers one. Otherwise use an existing private channel with the maintainer. If none is available, request a contact channel without disclosing vulnerability details, then send evidence privately.

Include the commit or installer version, OS, permission preset, minimal reproduction, expected and actual behavior, and redacted logs. Do not attach live credentials or other people's files. No fixed remediation deadline or old-version support period is published; coordinate urgent issues with the maintainer.
