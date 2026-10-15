# CodeBuddy Task-Oriented Capabilities Implementation Plan

Date: 2026-09-04
Based on: `docs/superpowers/specs/2026-09-04-task-oriented-capabilities-redesign-en.md`
Status: Ready for implementation
Language: English

## Execution rules

- `main` currently has extensive uncommitted changes and is two commits ahead. Check overlap before each phase; touch only listed files. Do not reset, checkout, clean, create a branch, commit, or push.
- Add a failing regression test before the smallest implementation. Do not continue while a new regression is unexplained.
- Run Rust/Cargo and full UI gates serially. Record command, working directory, exit code, and pass/fail/ignored counts.
- The raw configuration editor files are already deleted in the worktree. Verify and preserve that result; do not recreate them.
- Skills, Apps, MCP, Recipes, and Scheduler continue to own their data. Toolbox adds an aggregation read model and source-specific action dispatch only.

## Phase 0: baseline and edit boundary

**Files:** update `NavigationPanel.test.tsx`, `App.test.tsx`, `SettingsView.test.tsx`, `settingsNavigation.test.ts`, `SkillsView.test.ts`, `ExtensionItem.test.tsx`, and `CronPicker.test.tsx`.

1. Record branch/dirty status, scoped diffs, free space on C/D, and active cargo/rustc/node/electron processes. Stop and coordinate if another active change overlaps a target file.
2. Add characterization coverage for legacy routes, the five existing source views, absence of the raw config editor, and the actual read/write behavior of the Behavior and Responses controls.
3. Run the existing Provider tests so navigation work cannot overwrite the earlier provider-add, provider-update, and default-endpoint fixes.

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/App.test.tsx src/components/Layout/NavigationPanel.test.tsx src/components/settings/SettingsView.test.tsx src/components/settings/settingsNavigation.test.ts src/components/settings/providers/ProviderGrid.customLifecycle.test.tsx src/components/settings/providers/ProviderSettingsPage.test.tsx src/components/settings/providers/modal/subcomponents/forms/CustomProviderForm.localConnection.test.tsx --maxWorkers=1
```

## Phase 1: primary navigation and compatible routes

**Files:** update `useNavigationItems.ts`, `navigationUtils.ts`, `NavigationPanel.tsx`, `App.tsx`, and their tests; add `toolboxRouting.ts` and its test.

1. Tests first expect New Task, Common Tasks, Automatic Tasks, Toolbox, History, and Settings, with Skills/Apps/Extensions removed as separate primary items.
2. Add `/toolbox` and `/codepro/toolbox`. Redirect legacy `/skills`, `/apps`, and `/extensions` routes to `methods`, `apps`, and `external` Toolbox sections while preserving query, workspace mode, and source state.
3. Add `toolbox` to `View`; retain compatibility for old callers. Recipes, Schedules, and Sessions retain backend routes and receive user-facing labels only.
4. Keep legacy Chinese and English terms as search aliases, not primary headings.

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/utils/toolboxRouting.test.ts src/components/Layout/NavigationPanel.test.tsx src/App.test.tsx --maxWorkers=1
```

## Phase 2: Toolbox aggregation read model

**Files:** add `src/types/toolbox.ts`, `src/acp/toolbox.ts`, `src/components/toolbox/toolboxModel.ts`, `ToolboxView.tsx`, and tests; update `App.tsx`.

1. Define a UI-only `builtin | skill | app | external` discriminated union with stable ID, source, state, allowed actions, usage, and structured references.
2. Load `listSkillSources`, `listMcpApps`, and `getConfiguredExtensions` in parallel with `Promise.allSettled` so one failure cannot erase successful sources.
3. Accept only ACP `skill` and `builtinSkill` results. Never scan `C:\Users\jiangrui\.codex\skills`.
4. Render Available capabilities, Working methods, My tools, and External tools, plus explicit loading, empty, setup, permission, failure, and partial-failure states.
5. Dispatch actions to existing source APIs without copying their configuration.

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/acp/toolbox.test.ts src/components/toolbox/toolboxModel.test.ts src/components/toolbox/ToolboxView.test.tsx --maxWorkers=1
```

## Phase 3: external-tool connect, test, and atomic update

**Files:** update `goose-sdk-types/src/custom_requests.rs`, ACP `server/extensions.rs`, `custom_dispatch.rs`, `server.rs`, and `acp_custom_requests_test.rs`; regenerate ACP schema/SDK; update desktop `acp/extensions.ts`, `ExtensionsSection.tsx`, `ExtensionModal.tsx`, `ExtensionConfigFields.tsx`, and tests.

1. Tests first prove that Update is enabled for valid edits, failure preserves the old entry, and Test connection neither persists configuration nor increments usage.
2. Add `configExtensionsTest`: initialize candidate STDIO/HTTP configuration in a temporary session/agent, discover tools/resources, release resources, and return latency, capability summary, and sanitized errors.
3. Add an atomic update request keyed by `configKey`; validate the complete candidate before one replacement. Remove the frontend's current delete-then-add update.
4. Keep name and URL/command in the simple form; move env, headers, timeout, and tool allowlist under Advanced. SSE becomes migration guidance only.
5. Show structured dependants before disable/remove.
6. Use `just generate-acp-types`; never hand-edit generated files.

```powershell
cd D:\CodeBuddy
cargo test -p goose --test acp_custom_requests_test config_extensions --jobs 1
just generate-acp-types
just check-acp-schema
cd ui\desktop
pnpm exec vitest run src/components/settings/extensions/modal/ExtensionModal.test.tsx src/components/settings/extensions/extension-manager.test.ts src/components/settings/extensions/subcomponents/ExtensionItem.test.tsx src/acp/toolbox.test.ts --maxWorkers=1
```

## Phase 4: local actual-use records

**Files:** add `crates/goose/src/capability_usage.rs`, `acp/server/capability_usage.rs`, `tests/capability_usage.rs`, desktop `acp/capabilityUsage.ts`, and tests; update `lib.rs`, custom request/dispatch files, `extension_manager.rs`, `skills/client.rs`, `scheduler.rs`, `AppsView.tsx`, and `RecipesView.tsx`.

1. Add a versioned, atomic local store containing only kind/ID, last successful time, success count, latest outcome, and structured references. Never store prompts, arguments, file content, or credentials.
2. Record only successful skill load, external MCP tool call, App initialization, Common Task session creation, and actual scheduler trigger.
3. Backend execution points write directly. UI success points use an ACP record request. Event IDs are idempotent.
4. The ACP list response exposes aggregates only, not tool-audit argument digests or private paths.
5. Corrupt usage data produces a recoverable status and never empties the capability list.

```powershell
cd D:\CodeBuddy
cargo test -p goose --test capability_usage --jobs 1
cargo test -p goose skills:: --jobs 1
cd ui\desktop
pnpm exec vitest run src/acp/capabilityUsage.test.ts src/components/toolbox/toolboxModel.test.ts src/components/apps/AppsView.test.tsx src/components/recipes/RecipesView.workspace.test.ts --maxWorkers=1
```

## Phase 5: Common Tasks

**Files:** add `components/recipes/commonTaskModel.ts` and test; update `RecipesView.tsx`, `CreateEditRecipeModal.tsx`, `RecipeFormFields.tsx`, `RecipesView.workspace.test.ts`, and `recipe_management.ts`.

1. Preserve Recipe YAML, deep links, and ACP methods; change the user model to Common Task.
2. Derive purpose, model, extensions, known files, permissions, last run, and result from structured data only. Do not infer dependencies from prompt prose.
3. Make Run, Edit, and Make automatic primary. Move import/export/YAML/deep link actions to an advanced menu.
4. Offer Describe what I need and Manual setup. Description mode opens New Task with an explicit Common Task creation intent; manual mode reuses the current form.
5. Show dependencies and risk before execution without bypassing existing permission confirmation.

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/components/recipes/commonTaskModel.test.ts src/components/recipes/RecipesView.workspace.test.ts src/components/recipes/shared/__tests__/RecipeFormFields.test.tsx src/recipe/validation.test.ts --maxWorkers=1
```

## Phase 6: Automatic Tasks

**Files:** add `FriendlySchedulePicker.tsx` and test plus `cronSchedule.test.ts`; update `ScheduleModal.tsx`, `SchedulesView.tsx`, `ScheduleDetailView.tsx`, `cronSchedule.ts`, `acp/schedules.ts`, schedule ACP/SDK/Rust files, and `scheduler_test_support.rs`.

1. The normal UI builds a readable schedule from frequency/day/date/local time; raw cron is Advanced only.
2. Show the Common Task, dependencies, next run, notification behavior, and the app-running/no-default-catch-up warning.
3. Add Test before enable. A failed test cannot enable a schedule, and cancel cannot leave an active schedule. Persist `paused/tested` while preserving legacy defaults.
4. Count cron triggers separately from Run now; only a scheduler trigger counts as Automatic Task usage.
5. Preserve pause/unpause/kill/inspect/history/workspace behavior.

```powershell
cd D:\CodeBuddy
cargo test -p goose scheduler --jobs 1
cargo test -p goose --test schedule_tool_security --jobs 1
cd ui\desktop
pnpm exec vitest run src/components/schedule/__tests__/FriendlySchedulePicker.test.tsx src/components/schedule/__tests__/CronPicker.test.tsx src/utils/cronSchedule.test.ts src/utils/scheduleWorkspace.test.ts --maxWorkers=1
```

## Phase 7: reorganize Settings by real effect

**Files:** update settings navigation/view/chat/mode/goosehints/response styles and tests; add `input/InputSettingsSection.tsx`, `security/SecurityAndPermissionsSection.tsx`, and `advanced/AdvancedBehaviorSection.tsx`; update `settings-behavior.spec.ts`.

1. Prove moved components still read/write the same keys and an existing session is not changed by the new-session default mode.
2. Keep default mode and answer-related controls under Behavior and Responses; rename Reply Style to Tool Process Display.
3. Move dictation/spellcheck to Input, prompt injection/permissions to Security, maximum turns to Advanced, and present Goosehints as Project Rules.
4. Keep prompt templates in Advanced. Do not restore the raw key/value editor.
5. Search recognizes new labels and legacy aliases and navigates to the new location.

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/components/settings/settingsNavigation.test.ts src/components/settings/SettingsView.test.tsx src/components/settings/mode/ModeSection.test.tsx src/components/settings/models/ModelsAndRuntimeSettings.test.tsx --maxWorkers=1
pnpm exec playwright test tests/e2e/settings-behavior.spec.ts --workers=1
```

## Phase 8: i18n and compatibility cleanup

Run extraction, fully translate English, Simplified Chinese, and Traditional Chinese, preserve validated fallbacks for other locales, and retain legacy route/search/API/YAML identifiers.

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm run i18n:extract
pnpm run i18n:check
pnpm exec vitest run src/i18n/i18n.test.ts --maxWorkers=1
```

## Phase 9: real MCP single-file knowledge acceptance

**Files:** update `ui/desktop/package.json`, `pnpm-lock.yaml`, `tests/e2e/fixtures.ts`, and `goose-self-test.yaml`; add `tests/e2e/toolbox-mcp-filesystem.spec.ts` and `mcp-filesystem-evidence.ts`; write redacted evidence under `.cargo/evidence/toolbox-mcp-acceptance/`.

1. Run `pnpm add -D -E @modelcontextprotocol/server-filesystem@2026.8.31`; never use `latest`.
2. Use an isolated profile. Record SHA-256, size, and modified time for `D:\xwechat_files\wxid_5mloegbbcbl222_d3a5\msg\file\2026-09\obsidian README.md`.
3. In the visible UI connect command=`cmd`, args=`/c`, `npx`, `-y`, `@modelcontextprotocol/server-filesystem@2026.8.31`, and the parent directory.
4. Normalize and assert `list_allowed_directories` contains only that parent. Usage remains zero after connection testing.
5. Use the file's first non-empty line as the oracle. Ask the model to return only that line and execute nothing in the file. Require an exact answer, a successful MCP read audit, and usage increment to one.
6. Reading outside scope at `D:\CodeBuddy\Cargo.toml` must be denied.
7. After disabling, repeat the question and require no MCP call. Re-enable and restart Electron; configuration must recover.
8. Require unchanged hash/size/modified time and no write/move/delete audit. Evidence stores no private body content.

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec playwright test tests/e2e/toolbox-mcp-filesystem.spec.ts --workers=1 --retries=0
```

Then run `pnpm run start-gui` from changed source and repeat connect, question, disable, restart, and recovery with a visible Electron window and real mouse/keyboard input. Re-observe before each action and capture connection, successful read, scope denial, and restart evidence.

## Phase 10: full gates

```powershell
cd D:\CodeBuddy
cargo fmt --all -- --check
cargo test -p goose-sdk-types --jobs 1
cargo test -p goose --jobs 1
cargo build --workspace --jobs 1
cargo clippy --all-targets --jobs 1 -- -D warnings
just check-acp-schema
cd ui\desktop
pnpm run test:run
pnpm run typecheck
pnpm run lint:check
pnpm run format:check
pnpm run test-e2e -- --workers=1
cd ..\..
.\target\debug\goose.exe run --recipe goose-self-test.yaml
```

Finally rebuild and launch Electron from changed source and accept all six entries, legacy routes, four Toolbox sections, Common/Automatic Tasks, settings persistence, and the real MCP flow. Report each gate as PASS, FAIL, or NOT RUN. Preserve state and report environment, download, account, or model blockers rather than claiming completion.
