# Unified toolbox and capability controls

Date: 2026-09-09. Status: approved by the user for implementation, automated testing, and real desktop acceptance.

[繁體中文 (default)](2026-09-09-unified-toolbox-design.md) · [简体中文](2026-09-09-unified-toolbox-design.zh-CN.md)

## Goal and interface

Place CodeBuddy platform tools, skills, and external MCP servers in one Toolbox. Provide All, Built-in tools, Skills, and MCP categories with unified search and consistent icons, names, summaries, type/status labels, usage, details, and toggles while preserving each capability type's configuration and permission semantics.

Present `ComputerClient` as one built-in “Computer control” provider rather than many top-level mouse, keyboard, and screenshot functions. Its details list window and UIA observation, screenshots, mouse and keyboard actions, waits, result verification, allowed roles, platform limits, permissions, and recent evidence.

Open a common detail dialog when an item is selected. Toolbox toggles persist global defaults for subsequent tasks; the existing session selector remains available for one-task overrides. Do not interrupt a physical-input transaction halfway through. Enabling a capability never bypasses login, UAC, delete, send, or other high-risk approvals.

## Mutation rules

- Required system tools are locked on and may be inspected but not disabled or deleted.
- Optional built-in tools such as `ComputerClient` may be toggled and inspected but not deleted.
- Built-in skills may be toggled and inspected but not edited or deleted.
- User-installed skills may be toggled, inspected, edited, and deleted.
- External MCP servers may be toggled, inspected, tested, configured, and deleted.
- Both the UI and ACP/backend reject built-in deletion; internal product migrations use a separate controlled path.

## Data and failures

Reuse existing skill management and extension configuration sources. Map `builtin`, `platform`, skills, and MCP into one presentation model without creating another capability store. Each item carries a stable ID, kind, provenance, enabled state, allowed actions, tool list, usage, and availability reason.

Show a pending state while a toggle is saved, then reload the persisted configuration. Restore the prior display and explain the error on failure. Distinguish unsupported platform, role restriction, setup required, connection failure, and user-disabled states. Search localized text as well as raw IDs, descriptions, and provenance.

## Cleanup and acceptance

Remove the misleading `goose-doc-guide`: it reads upstream Goose online documentation while being presented as a CodeBuddy guide. Update the built-in content, registration/presentation mapping, snapshots, self-test, and tests. A future replacement must use CodeBuddy-owned documentation.

Add regression tests before each implementation increment, then integrate platform tools, unified cards, details, and controls. Run relevant Rust and desktop tests, typecheck, lint, format, build, and `goose-self-test.yaml`. Launch Electron from changed source and use real mouse/keyboard interaction to inspect details, toggle capabilities, and verify restart persistence. Create real conversations proving that an agent cannot discover or call `ComputerClient` while disabled and can discover it and complete a safe desktop action after re-enabling it. Record command, cwd, exit code, test counts, and evidence path for each phase; do not continue past an unexplained failure.

Preserve all existing main-checkout changes. Do not create a branch or worktree, commit, reset, overwrite with checkout, or clean.
