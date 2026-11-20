# CodeBuddy documentation index

[简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md)

DeepSeek Harness owns execution, Electron/TypeScript provides the desktop, and Rust provides independent MCP tools. Read the version from the desktop package.json. Test results apply to a specific source revision and artifact.

## Current update and collaboration

- [2026-11-20 source changes and validation scope](updates-20261120.en.md)
- [Security and vulnerability reporting](security.en.md)
- [Contributing](contributing.en.md)

## Development

- [Installation, dependencies, launch, builds and tests](../documentation/codebuddy/GITHUB_OVERVIEW_EN.md)
- [Module responsibilities and fact authority](../documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md)
- [Harness adapter](../runtime/harness/README.en.md)
- [Script entry points](../scripts/README.md)
- [Third-party provenance and licenses](../documentation/codebuddy/THIRD_PARTY_NOTICE.md)

## Features and platforms

- [Storage layout](storage-layout.en.md)
- [Installation model defaults](installation-model-defaults.en.md)
- [Windows installer](windows-installer-ui.en.md)
- [macOS builds](macos.en.md)
- [macOS installation and removal](macos-installation.en.md)
- [Browser control](browser-control.en.md)
- [Computer control routing](computer-use-routing.en.md)
- [Conversation files](conversation-files.en.md)
- [Desktop pets](desktop-pets.en.md)
- [Long-term goals](long-term-goals.en.md)
- [Image generation](image-generation.en.md)
- [Video generation](video-generation.en.md)

## Handoff and history

- [2026-10-23 Merge handoff](reconstruction/2026-10-23-merge-handoff.en.md)
- [Reasons for individual commits](reconstruction/2026-10-23-commit-rationale.en.md)
- [Desktop delivery record for that batch](reconstruction/2026-10-23-desktop-delivery.en.md)

Retired Rust Agent plans, early reconstruction reports and the upstream documentation website have been removed from the current tree. They remain in Git history and do not describe the current implementation. Use `git log --all -- <path>` and `git show <commit>:<path>` to inspect a historical file.

Uncommitted local drafts, acceptance data, dependencies and build artifacts are outside this cleanup. Historical test reports do not establish acceptance of the current version.
