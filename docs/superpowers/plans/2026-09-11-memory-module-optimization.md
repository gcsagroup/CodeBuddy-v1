# Memory Module Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate authoritative rules from generated memory, remove aggregate memory-capacity rejection, expose explicit memory controls, and preserve bounded, explainable per-turn recall.

**Architecture:** Keep sessions, project memory, user memory, and `AGENTS.md` as separate stores. For the first delivery, reuse the existing lossless active/archive layout and current on-disk paths, treating active limits only as internal hot-cache integrity bounds. Add a focused rules service around the existing AGENTS loading and editor flows, and keep per-record and per-response safety bounds.

**Tech Stack:** Rust, Tokio/ACP, serde, filesystem atomic writes, React, TypeScript, Vitest, Electron.

## Global Constraints

- Preserve the dirty `D:\CodeBuddy` checkout; do not reset, clean, overwrite unrelated files, or create another branch.
- The AI never writes inferred habits directly to `AGENTS.md`; only explicit user saves or approved promotion may mutate rule files.
- Remove aggregate entry-count and total-file-size write rejection, but retain per-record, prompt-context, pagination, response-size, path, secret, and reparse-point safety limits.
- `use_memory` and `generate_memory` are independent; disabling either never deletes stored data.
- Serialize Cargo builds, generated SDK work, backend restarts, and physical desktop input with the toolbox task.
- Do not modify `agent.rs`, prompt-manager files, platform registration/config, or toolbox UI in this workstream; send exact integration requirements to their owner.
- Add Simplified Chinese, Traditional Chinese, and English user-facing documentation, with Traditional Chinese as the default documentation file.

---

### Task 1: Remove Aggregate Capacity Rejection

**Files:**
- Modify: `crates/goose/src/agents/platform_extensions/project_memory.rs`
- Modify: `crates/goose/tests/codepro_project_memory_tools.rs`
- Modify: `ui/desktop/src/components/settings/memory/MemorySettingsSection.tsx`
- Test: `ui/desktop/src/components/settings/memory/MemorySettingsSection.test.tsx`

**Interfaces:**
- Consumes: existing `persist_active_and_archived`, `load_store`, `save_store`, and admin-list APIs.
- Produces: lossless total storage with a bounded hot file, plus aggregate active/archive usage that is informational rather than a quota.

- [ ] **Step 1: Add failing backend regressions**

Add tests that create more than 500 records and more than 2 MiB of aggregate active plus archive data, restart the client, and assert every record remains searchable and manageable:

```rust
assert!(managed.len() > 500);
assert_eq!(search_result["matched_count"], 1);
assert!(client.remember(&context, next_memory).await.is_ok());
```

- [ ] **Step 2: Verify the regressions fail before implementation**

Run only after the shared Cargo owner grants the build slot:

```powershell
cargo test -p goose agents::platform_extensions::project_memory::tests:: --lib --jobs 1 -- --test-threads=1
cargo test -p goose --test codepro_project_memory_tools --jobs 1 -- --test-threads=1
```

Expected: at least one new assertion fails because the old quota or active-entry semantics are still exposed.

- [ ] **Step 3: Make hot-storage bounds internal and lossless**

Remove the configurable soft/hard quota model and retain fixed internal hot-cache targets. Always spill overflow entries to archive before writing the hot file, and never reject a valid memory because aggregate storage crossed a fixed threshold. Keep these checks:

```rust
validate_memory_content(&content)?;
validate_memory_subject(&subject)?;
save_archived_entry(directory, entry)?;
write_verified_file(path, &bytes, "项目记忆")?;
```

Preserve the 500-entry/2 MiB hot-file integrity checks, per-archive-record byte limit, and prompt/search response limits. These bounds apply only to the internal hot file; archived history has no aggregate entry or byte quota.

- [ ] **Step 4: Make storage UI informational**

Replace soft/hard-limit warnings with total stored-record count and measured storage usage. Do not render "limit reached" or "available before limit" language.

- [ ] **Step 5: Run focused formatting and UI tests**

```powershell
rustfmt --edition 2021 --check crates/goose/src/agents/platform_extensions/project_memory.rs crates/goose/tests/codepro_project_memory_tools.rs
cd ui/desktop
pnpm exec vitest run src/components/settings/memory/MemorySettingsSection.test.tsx --maxWorkers=1
```

Expected: all selected tests pass and no capacity-limit wording remains.

---

### Task 2: Add Explicit Memory Lifecycle Status

**Files:**
- Modify: `crates/goose/src/agents/platform_extensions/project_memory.rs`
- Modify: `crates/goose/src/acp/server/memory.rs`
- Modify: `crates/goose/tests/codepro_project_memory_tools.rs`
- Modify: `ui/desktop/src/acp/memory.ts`
- Modify: `ui/desktop/src/components/settings/memory/MemorySettingsSection.tsx`
- Test: `ui/desktop/src/acp/memory.test.ts`
- Test: `ui/desktop/src/components/settings/memory/MemorySettingsSection.test.tsx`

**Interfaces:**
- Produces: `MemoryStatus::{Candidate, Active, Disabled}` persisted with a serde default of `Active` for existing records.
- Produces: admin operations that approve, disable, or reject an inferred preference without changing other memory kinds.

- [ ] **Step 1: Add migration and recall tests**

```rust
assert_eq!(legacy_entry.status, MemoryStatus::Active);
assert!(!is_recallable(&candidate_entry, &workspace));
assert!(!is_recallable(&disabled_entry, &workspace));
assert!(is_recallable(&active_entry, &workspace));
```

- [ ] **Step 2: Add the status model and enforce it in recall**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectMemoryStatus {
    Candidate,
    Active,
    Disabled,
}
```

Use `#[serde(default = "default_active_status")]` so existing files remain compatible. Automatic `user_inferred` writes become `Candidate`; explicit or host-confirmed writes are `Active`.

- [ ] **Step 3: Add auditable state transitions**

Approve changes `Candidate → Active`; disable changes `Active → Disabled`; reject deletes only the selected candidate. Reject every invalid transition and every non-user/inferred target.

- [ ] **Step 4: Expose state in ACP and Settings**

Include status in record mapping. Render pending habits separately with Approve, Reject, and Disable/Enable actions; retain edit and delete for active records.

- [ ] **Step 5: Run focused Rust and UI tests**

Use the Task 1 Rust commands after receiving the Cargo slot, then:

```powershell
cd ui/desktop
pnpm exec vitest run src/acp/memory.test.ts src/components/settings/memory/MemorySettingsSection.test.tsx --maxWorkers=1
```

Expected: legacy migration, non-recallable candidates, valid transitions, and UI state recovery all pass.

---

### Task 3: Add a Safe Rules Store Around the Existing AGENTS Loader

**Files:**
- Create: `crates/goose/src/hints/agents_rules.rs`
- Test: `crates/goose/src/hints/agents_rules.rs`
- Modify: `crates/goose/src/hints/mod.rs` only through the shared-file owner when required

**Interfaces:**
- Produces: `RulesDocument { path: PathBuf, content: String, revision: String, exists: bool }`.
- Produces: `read_global_rules`, `write_global_rules`, `read_project_rules`, and `write_project_rules` with revision-based conflict detection.

- [ ] **Step 1: Add failing path, conflict, and atomic-write tests**

Cover missing files, normal read/write, external modification between read and save, project-root containment, symlink/reparse rejection, UTF-8 validation, and write-failure recovery.

- [ ] **Step 2: Implement explicit rule locations**

Reuse the locations already consumed by `load_hints.rs`: `profiles/<profile>/AGENTS.md` for global user rules, and the selected project root's effective `AGENTS.override.md` or `AGENTS.md` for project rules. Never introduce a second physical rules format, infer another path, or follow a link or reparse point.

- [ ] **Step 3: Implement optimistic concurrency**

```rust
pub(crate) fn write_rules(
    target: &Path,
    expected_revision: Option<&str>,
    content: &str,
) -> Result<RulesDocument, String>;
```

Hash current bytes with BLAKE3. If `expected_revision` differs, return a conflict without writing. Use verified temporary-file replacement and preserve prior content on failure.

- [ ] **Step 4: Ask the shared owner to register the module**

Send only this integration request:

```text
Add `pub(crate) mod agents_rules;` beside load_hints in hints/mod.rs.
Reuse load_hints.rs for prompt loading; do not add a second agent.rs injection branch.
```

- [ ] **Step 5: Run the focused unit module after the Cargo slot is granted**

```powershell
cargo test -p goose hints::agents_rules::tests:: --lib --jobs 1 -- --test-threads=1
```

Expected: all rules-store tests pass.

---

### Task 4: Expose Rules and Independent Controls in Settings

**Files:**
- Modify: `crates/goose-sdk-types/src/custom_requests/memory.rs` only after confirming no parallel writer
- Modify: `crates/goose/src/acp/server/memory.rs`
- Modify: `crates/goose/src/acp/server/custom_dispatch.rs` only through the shared-file owner
- Modify: `ui/desktop/src/acp/memory.ts`
- Create: `ui/desktop/src/components/settings/instructions/InstructionFileEditor.tsx`
- Modify: `ui/desktop/src/components/settings/chat/GoosehintsModal.tsx`
- Modify: `ui/desktop/src/components/settings/memory/MemorySettingsSection.tsx`
- Test: `ui/desktop/src/acp/memory.test.ts`
- Test: `ui/desktop/src/components/settings/memory/MemorySettingsSection.test.tsx`

**Interfaces:**
- Produces: ACP read/write requests for global and project rule documents using `workingDir`, `content`, and `expectedRevision`.
- Produces: independent `useMemory` and `generateMemory` preferences.

- [ ] **Step 1: Add request-schema and Settings tests**

Test loading both editors, saving explicit content, preserving text after a conflict, refusing silent project-file overwrite, and all four use/generate toggle combinations.

- [ ] **Step 2: Add rule document ACP methods**

Return exact path, content, existence, and revision. A write requires an explicit Settings action and a matching revision. Draft generation returns content only and cannot write a file.

- [ ] **Step 3: Add the two editors and controls**

Extract the existing `GoosehintsModal.tsx` editor behavior into `InstructionFileEditor.tsx` instead of building a second project editor. The global editor applies to all projects. The project editor shows the exact effective AGENTS path. The initial basic release may provide a deterministic template draft; model-generated drafts remain a later enhancement unless the current task explicitly invokes them.

- [ ] **Step 4: Split memory controls**

Map `useMemory` to recall/injection and `generateMemory` to new inferred-memory generation. Keep existing stored data when either is off. If the shared config file must change, send the exact key and behavior to its owner rather than editing concurrently.

- [ ] **Step 5: Generate SDK artifacts and test only in the shared build slot**

Run the repository's existing ACP generation command, then focused TypeScript tests, typecheck, Rust tests, and Clippy. Record generated-file hashes and do not hand-edit generated UI SDK output.

---

### Task 5: Integration and Acceptance

**Files:**
- Modify: `goose-self-test.yaml` only through the shared-file owner
- Test: `ui/desktop/tests/e2e/project-memory-provider-process.ts`
- Test: `ui/desktop/tests/e2e/codebuddy-user-journey.spec.ts`
- Create: `D:\CodeBuddy\.cargo\evidence\project-memory-optimization-20260911\README.zh-CN.md`
- Create: matching default Traditional Chinese and English evidence files

**Interfaces:**
- Consumes: completed storage, ACP, Settings, and shared prompt integration.
- Produces: automated and real-desktop evidence with explicit PASS/FAIL/NOT_RUN gates.

- [ ] **Step 1: Add deterministic end-to-end scenarios**

Cover explicit global rule, project rule, candidate habit, approval, rejection, restart persistence, project A/B isolation, and storage beyond old thresholds.

- [ ] **Step 2: Run all relevant automated gates serially**

Run formatting, focused and full relevant Rust tests, ACP generation, desktop tests, typecheck, lint, build, and the memory phase of `goose-self-test.yaml`. Record cwd, command, exit code, duration, and pass/fail/ignored counts.

- [ ] **Step 3: Rebuild and launch Electron from changed source**

Coordinate backend replacement and Electron restart with the shared owner. Verify the running process uses the new binary hash.

- [ ] **Step 4: Perform real user interaction**

Use a visible Electron window with real mouse and keyboard. Verify rule editing, draft preview, new-chat effect, candidate approval/rejection, cross-project use, project isolation, and restart persistence. Validate actual files/database and logs in addition to visible answers.

- [ ] **Step 5: Publish evidence without overstating results**

Separate API/component success from real-model semantic recall. Any unavailable desktop or credential-dependent gate remains `NOT_RUN`, not PASS.
