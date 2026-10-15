# Skill Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. User explicitly approved development, testing, and acceptance in the existing checkout; preserve its dirty state, without branch creation or automatic commits.

**Goal:** Deliver localized skill management with shared UI/AI operations and real desktop acceptance.

**Architecture:** Keep filesystem skill discovery and Rust/ACP ownership. Separate presentation from identifiers. Add guarded management operations shared by UI and AI, without broadening read-only tool permissions.

**Tech Stack:** Rust, ACP SDK, React, react-intl, Vitest, Electron, Windows mouse/keyboard automation.

## Global constraints / 全域限制 / 全局限制

- Follow the approved [spec](../specs/2026-09-05-skill-management-design.md), including source provenance, scopes, staged download, confirmed recoverable deletion, and refresh semantics.
- 繁體：依序完成本地化、本地管理、下載、AI 代辦與桌面驗收；每階段先紅燈測試再修復，新增回歸未解決不得前進。
- 简体：依次完成本地化、本地管理、下载、AI 代办与桌面验收；每阶段先失败测试再修复，新增回归未解决不得前进。
- English: Complete localization, local management, downloads, AI operations, and desktop acceptance in order. Run failing regression tests first and resolve new regressions before advancing.
- Run heavyweight builds serially. Check free space and active build processes first. Never overwrite unrelated changes or user configuration.

## Task 1: Localized toolbox presentation / 工具箱本地化

Files: `ui/desktop/src/components/toolbox/toolboxModel.ts`, `ToolboxView.tsx`, their tests, `src/types/toolbox.ts`, existing skill/extension presentation helpers and locale catalogs.

Contract: retain `ToolboxItem.name`, `id`, and `reference` as source identities; add optional source metadata and `localizeToolboxItem(item: ToolboxItem, intl: IntlShape): ToolboxItem`. The localized copy is display-only and search includes original identifiers.

- [x] Add regression tests using `createIntl` for en, zh-CN, zh-TW and an actual `buildToolboxModel` result: `expect(localized.name).toBe('CodeBuddy 文档指南'); expect(raw.methods[0].name).toBe('goose-doc-guide')`.
- [x] Run `pnpm exec vitest run src/components/toolbox --maxWorkers=1` from `ui/desktop`; record the expected failure.
- [x] Retain source metadata in the model, reuse existing localizers, and apply localization in a memo dependent on `intl`, before filtering and rendering. Cover platform entries and unchanged third-party metadata.
- [x] Add component coverage for Chinese search and switching locale without refetching. Run focused tests, `pnpm run lint:check`, `pnpm run format:check`, `pnpm run test:run`, and the desktop build.
- [x] Inspect the rebuilt application with real mouse/keyboard input, checking built-in capabilities, skills, language switch and reload. Record evidence before Task 2.

## Task 2: Guarded local management / 本地管理

Files: create `crates/goose/src/skills/management.rs` and focused tests; extend ACP custom request types/dispatch; create `ui/desktop/src/acp/skillManagement.ts` and `components/skills/SkillManager.tsx` with tests. Register the module in existing skills code.

Contract: typed list/read, preview/apply, recovery-list/restore operations. Preview identifies a resolved source, expected fingerprint, operation and destination. Apply rejects expired, mismatched, or unconfirmed destructive previews. Reads return original and display metadata plus scope/read-only/version. Recovery returns a unique restore reference.

- [ ] Add tests creating isolated temporary skills: create, read, update preserving extra resources, conflict, read-only source, stale preview, cancellation, same-name different scopes, traversal rejection, recover and restore conflict. Example assertion: `assert_eq!(std::fs::read(&original).unwrap(), before)` after a stale preview fails.
- [ ] Run `cargo test -p goose --lib skills::management`; record red evidence, implement the service using existing source resolvers and atomic staging, then rerun.
- [ ] Expose typed ACP calls through the existing custom dispatch and regenerate using `just generate-acp-types`; add request contract tests.
- [ ] Implement forms and details using the shared client; carry the source reference instead of resolving by display name. Show exact-target confirmation before recovery and refresh discovery after success.
- [ ] Run Rust and component gates, rebuild backend/Electron and verify create/import/edit/cancel/reload. Pause for action-time user confirmation immediately before UI deletion, then verify recovery and restore.

## Task 3: Validated download / 下載 / 下载

Files: create `crates/goose/src/skills/download.rs`, its focused tests, and add download-preview inputs to the Task 2 service/client/form.

Contract: URL plus destination scope produces a staged preview, never an installed skill directly. GitHub directory URLs resolve to a commit; direct HTTPS SKILL.md downloads are single-file. Apply consumes the same guarded preview contract as local import.

- [ ] Test invalid schemes, private/local destinations and redirects, traversal, symlinks, invalid frontmatter, limits, timeouts, companion resource preservation, collision, partial failure, and unchanged existing installation after failure.
- [ ] Run `cargo test -p goose --lib skills::download`; implement bounded HTTPS fetching with address validation, provenance, temporary staging and no script execution; rerun.
- [ ] Connect the download form and display provenance, files, single-file limitation, conflicts and cancellation. Test translated errors and successful refresh.
- [ ] Run full relevant gates and perform one real public download in an isolated destination, then invoke that installed skill through conversation and inspect actual tool records.

## Task 4: AI management parity / AI 代辦 / AI 代办

Files: extend `skills/client.rs` or the existing platform-management tool surface with the same service; extend permission/routing tests and `goose-self-test.yaml`.

Contract: AI can list/read and request previews; mutation uses host-authorized execution. A model-supplied `confirmed: true` is never sufficient. Confirmation must bind the exact preview and current target fingerprint. Mutation tools are not read-only.

- [ ] Test tool annotations, registration, intent routing, denial of forged confirmation, user cancel, changed target, and result metadata identifying the actual source/version.
- [ ] Run focused failing tests; connect the shared service to existing host confirmation plumbing and rerun. Do not add external tools to unrelated worker roles.
- [ ] Test natural-language create/download/edit/delete/restore in the application with synthetic data, checking persistent state and usage rather than assistant prose alone.
- [ ] Run complete relevant Rust/desktop suites, typecheck, lint, format and build; rebuild backend and launch Electron from changed source. Execute `goose run --recipe goose-self-test.yaml` with the appropriate built binary and preserve exact outcomes.

## Evidence and handoff / 驗收與交付 / 验收与交付

- [ ] Save exact commands, cwd, exit codes, counts and desktop observations under `.cargo/evidence/skill-management-20260905/`.
- [ ] Verify language persistence, next-turn discovery, deletion preventing new loads, restoration, unchanged unrelated MCP configuration and user skill files.
- [ ] Report passed checks separately from environment blockers and incomplete items. No automatic Git commit or push.
