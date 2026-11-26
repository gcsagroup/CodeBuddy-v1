# Multi-project workspaces

New chats can create a reusable workspace through a centered dialog with multiple local folders. The first folder is primary; users can change it before creation, name the workspace, and attach notes and write/reference access to other folders. Unlinking never deletes files.

The sidebar hover card lists every folder, primary/reference badges, and an edit action. Edits apply to new chats. Existing chats retain their folder snapshot. The primary path remains the existing project identity; the editor does not relocate folders after saving.

`WorkspaceService` owns membership, versions and directory identity. Compat persists `projectFoldersSnapshot`; legacy chats are frozen before configuration changes or on first use. File tools and terminals consume the same policy. Delegated agents resolve the root snapshot through verified native ownership. Changed directory identities fail explicitly.

Reference folders disable full access in the UI, Compat and execution boundary. Approval cannot override this restriction. Windows uses the pinned Harness ACL/token/Job/control-pipe implementation with a capability SID scoped to the directory combination. Native partial-enforcement limitations remain; this is not a claim of network or external MCP isolation. Seatbelt and Bubblewrap express linked permissions; unsupported runners fail closed instead of launching without confinement.

References: [Codex Projects](https://learn.chatgpt.com/docs/projects) and [Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/shared_options.rs). Public interaction patterns were consulted; no source was copied and no dependency added. Regressions cover snapshots, real native writes/denials, creation, hover/edit interactions and permissions. Desktop and model acceptance must be run separately on each platform.
