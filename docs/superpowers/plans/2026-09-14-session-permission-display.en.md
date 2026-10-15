# Session mode and permission descriptions

Date: 2026-09-14. [Traditional Chinese](2026-09-14-session-permission-display.md) is the default document; [Simplified Chinese](2026-09-14-session-permission-display.zh-CN.md) is also available.

## Problem and change

The Autonomous description promised unrestricted file changes, while Manual claimed that every tool required approval. Both overstated existing behavior. Autonomous now describes automatic execution within current permissions, with possible confirmation for restricted or out-of-scope actions. Manual describes asking for actions not already allowed by permission rules or read-only policies. Backend decisions, deny rules, and authorization reuse are unchanged.

The default applies to new sessions. `new_session.rs` reads that default on creation; `load_session.rs` and `execution/manager.rs` restore the persisted session mode. Saving preferences does not update existing sessions. The English settings explanation was already correct, but native acceptance exposed stale translations. The title and explanation are now synchronized across all 16 catalogs.

For an unset preference, real ACP returns `value: null, isMutable: true`. The frontend only recognized an empty list, leaving all four choices disabled. A regression test reproduced this failure. Only this mutable null now uses the same Autonomous default as the backend, without writing settings automatically. Managed values remain disabled; unknown values leave every choice unselected and show “Not synchronized.” Saving an explicit selection still uses the existing revision checks.

The frontend previously discarded standard ACP `modes.currentModeId`. New and load responses now populate `Session.goose_mode`. Mode notifications update the session identified by the notification, including after cancellation; existing late-content suppression remains. Missing or unrecognized modes display “Not synchronized” instead of borrowing the global default.

The conversation displays its current mode above the input. Expanding it reveals scope information from the actual session binding. Bound projects remain subject to tool rules; a root folder does not authorize project writes; unbound sessions have no project write grant. An ordinary working directory describes execution location, not permission for every action. Existing confirmation reasons, source, and authorization scope are reused.

## Public Codex comparison

OpenAI distinguishes execution boundaries from approval policy. We adopt accurate, separate descriptions of mode, scope, and reasons. Autonomous does not mean blanket approval, and this change makes no claim that CodeBuddy shares Codex sandboxing or private implementation. No external code or dependencies were introduced. [OpenAI: Running Codex safely](https://openai.com/index/running-codex-safely/)

## Validation and limits

Latest focused tests passed: 106 tests across 5 files. Coverage includes new/load responses for all four modes and unknown modes, notification isolation, mode updates after cancellation, binding descriptions, default-mode settings, and existing confirmation rendering. The preference matrix covers null, empty lists, valid values, unknown values, and managed values. Evidence: `.cargo/evidence/audit-fixes-20260914/mode-focused-final.log`; the pre-fix null regression remains in `mode-null-before.log`.

Final full desktop tests: 229 files, 2042 passed, 4 skipped, no failures. `pnpm run lint:check` (including types and all locales), formatting, catalog compilation, and renderer build passed. All 27 source hashes remained stable. `cargo build -p goose-cli --features code-mode --jobs 1` passed; backend SHA256 is `41709ABD6B42B800EEA57B7102CFFE7288912914FA6938ECC68E66E07F4D7051`. Exact commands, times, and exit codes are recorded in `mode-gates.json` and `mode-backend-build-final.json`.

Isolated native Electron acceptance passed. All four choices were available for an unset default. Saving Manual produced authoritative ACP `approve`, revision 1. A real ACP new session, `20260914_2`, inherited Manual without an explicit mode argument; existing sessions retained Autonomous. Switching, reloading, and restarting the application preserved these differences. One labeled fixture message was added solely to make the new session visible in history; its mode was not modified and no model prompt was sent. Ordinary-directory and unbound-CodePro descriptions were checked natively; project and root-folder distinctions also have component coverage. See `mode-native-acceptance.json`, `mode-new-session-acp.json`, and the corresponding text and screenshot evidence.

The real-model permission matrix remains unverified because the user stopped 120:8001; this work neither probes nor substitutes another service. Direct ACP tools and model-session approval paths differ and cannot substitute for each other. This completes the description and mode-state fixes, not acceptance of every real-model permission decision.
