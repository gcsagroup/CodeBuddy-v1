# Contributing to CodeBuddy

[简体中文](../CONTRIBUTING.md) · [繁體中文](contributing.zh-TW.md) · [English](contributing.en.md)

Updated: 2026-11-20.

## Before starting

Read the [README](../documentation/codebuddy/GITHUB_OVERVIEW_EN.md), [AGENTS.md](../AGENTS.md) and component rules. DeepSeek Harness owns execution, Electron/TypeScript supplies the desktop, and Rust supplies independent MCP tools. Do not restore the retired Rust Agent, Provider or generated API client.

Use this repository's [Issues](https://github.com/erjinyi-bool/CodeBuddy-v1/issues) for reproducible bugs. Include the version or commit, OS, steps, expected and actual behavior, and redacted logs. Follow the [security policy](security.en.md) for sensitive reports.

## Changes and verification

- Use matching lockfiles and documented launch commands. Dependency preparation, tool payloads and installer builds are separate steps; old artifacts cannot validate new source.
- Preserve existing uncommitted changes. Keep commits focused and exclude personal sessions, credentials, profiles, caches, screenshots and build outputs.
- Reuse existing authoritative facts and protocols. Explain the design and migration scope before changing shared interfaces or permission semantics.
- Add meaningful backend regressions. Run component tests before real UI interaction checks; verify cross-module flows in the application.
- Documentation-only changes need content, link and format checks, not product builds. Rust changes require formatting, relevant tests and applicable Clippy checks.
- Keep user documentation synchronized in Simplified Chinese, Traditional Chinese and English. Follow existing extraction and validation for UI messages.

See the root [README](../README.md) for commands and prerequisites. Automation must use isolated data directories, not personal conversations or model settings.

## Submission and review

Describe the problem, final behavior, scope, actual commands and exit results in the PR. Separate automated checks, real interactions and unverified workflows. Screenshots do not establish functionality; builds do not establish installer acceptance. Check the target branch, dependencies and provenance before merging.

Preserve the [Apache-2.0 license](../LICENSE), upstream copyright and [third-party notices](../documentation/codebuddy/THIRD_PARTY_NOTICE.md). Record the version, source and license of imported code. Documentation refreshes do not change the original licenses.
