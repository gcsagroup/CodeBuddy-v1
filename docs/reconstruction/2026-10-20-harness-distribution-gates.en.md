# Harness distribution gates and locale catalogs

[简体中文](2026-10-20-harness-distribution-gates.zh-CN.md) · [繁體中文](2026-10-20-harness-distribution-gates.zh-TW.md)

Starting from `6eb8f7e` on the existing `main`, this change replaces the ten obsolete checks left from integration. It does not restore the old Rust Agent, Provider, Coordinator, TLS service or PowerShell build entry point, or change product execution logic.

The checks now cover Harness loopback IPC readiness and secret handling, distribution telemetry controls, empty initial model configuration, accessible model selection, build verification order, exact x64 application/manifest matching, Squirrel archive validation and protection of existing installers, build-only behavior, rejection of unverified Forge stages, and idempotent service shutdown with a bounded termination fallback.

The full distribution command exposed one more check referencing the removed Coordinator fixture. It now executes the existing `runtime/tests/harness-authority-acp.test.mjs`, covering native completion, actual failures and the distinction between completion and verified results. Core authority remains in its existing module. The new test helper uses temporary directories and intercepts external processes; it never installs software or modifies user profiles.

Thirteen non-Chinese locale catalogs each receive 97 missing keys and lose 23 obsolete keys, preserving 2,771 existing descriptors/translations. New entries use English source text, preserving the existing `defaultMessage` fallback behavior; this is not a claim of completed native-language translation. English and both Chinese catalogs need no changes in this batch. Extraction, descriptor shape, key-set and ICU validation remain intact.

Using the existing Node 24.21.0, the full distribution gate passes 51 tests, including an invocation of 13 existing Harness authority cases. Entry-point/macOS packaging scripts pass 42 tests. Locale/model-selection component tests pass 29 tests. English extraction and all 15 translated catalogs validate at 2,868 messages each; all 16 catalogs compile. All these commands exit 0; exact commands are in the Simplified Chinese companion.

This is test and catalog maintenance, not live-model, desktop or installer acceptance. No dependencies were installed, no installer was built and no Rust source was changed. Local evidence remains under `.preview-evidence/distribution-gates-20261020/` and is excluded from commits. Continue using the README Harness build entry point. The delivery message and remote Git state establish the final commit and push result.

Another task began editing media previews and the English/Chinese catalogs during verification. Those uncommitted changes are excluded. Before committing, the unchanged locale validator was executed against the Git index: all 15 translated catalogs passed at 2,868 keys. This establishes the submitted tree, not acceptance of the other task's evolving combined working tree.
