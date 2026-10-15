# MCP discovery investigation — 2026-10-13

[简体中文](MCP_DISCOVERY_20261013_ZH_CN.md) · [繁體中文](MCP_DISCOVERY_20261013_ZH_TW.md)

## Reproduction

The configured HTTP endpoint `http://192.168.9.120:8889/mcp` successfully initializes and reports 150 tools. Every reported tool lacks `readOnlyHint`. A real `server_health` call through the application backend returned `healthy`.

Using an isolated application profile and the actual desktop ACP backend:

| Step | HexStrike tools in the session |
| --- | ---: |
| Create a chat, then add the enabled global extension | 0 |
| Create a new chat after adding the extension | 150 |
| Explicitly enable it in the original chat | 150 |

The original `search_available_extensions` additionally omits globally enabled extensions absent from the current session. After activation it lists extension names but no tool inventory. This independently reproduces the reported symptom; the exact conversation in the screenshots was not identified.

## Changes

Discovery now compares configuration with the current session, including enabled defaults not loaded there. The same read-only discovery tool returns discovered tool names from loaded extensions, independently of the current turn’s executable subset. Unannotated tools are not relabeled read-only or granted execution permission. Removed extensions disappear from the tool inventory.

The analysis tool loader explains the difference between its filtered execution catalog and MCP inventory. The extension dialog explains new-chat defaults, current-chat activation, and the scope of connection testing. The previous error-layout fix remains included in the working tree.

## Validation

- Automated checks: 1 MCP discovery regression, 11 read-only analysis tests and 16 extension modal tests passed. TypeScript, ESLint and i18n compile/check exited 0.
- Actual service and desktop ACP backend: the rebuilt `target/debug/goose.exe` passed extension registration, existing/new chat loading, comparison of all 150 tool names and `server_health`.
- Actual Gemma model: a chat bound to an isolated workspace called `load_analysis_tools` and `extensionmanager__search_available_extensions` successfully, then identified `hexstrike__server_health` and `hexstrike__execute_command`. No scanning or command tool was executed.
- Evidence: `target/mcp-discovery-acp-i0gDma/result.json` and `responses.jsonl`; the result records the binary SHA256.
- Browser component fixtures passed layout, visible error handling and footer reachability at 1280×900, 800×700 and 390×844.
- Full Electron interaction, Mac hardware acceptance and updated installers remain untested. Early unbound-workspace fixture results are not acceptance passes.

Baseline evidence: `target/mcp-discovery-acp-DSeWKQ/result.json`; frontend evidence: `target/mcp-error-ui-20261013/browser-results.json`; build and test logs: `target/mcp-discovery-20261013/`.

Current installed Windows/Mac applications are not automatically updated by source changes. Browser fixture checks are not complete Electron acceptance or Mac hardware acceptance.

## Source and scope

- `main`, base `964bbeb1587f1c5551ee17907e0b26632c4163ce`, with uncommitted changes.
- Backend: `crates/goose/src/agents/extension_manager.rs`, `platform_extensions/ext_manager.rs`, `analysis_tools.rs`.
- UI: `ui/desktop/src/components/settings/extensions/modal/ExtensionModal.tsx` and locale catalogs.
- No configuration migration, automatic activation of existing chats, or permission changes.
- No commit, push or new installer in this change.

Additional UI files: new `ExtensionError.tsx`; changes to `ExtensionModal.tsx`, `ExtensionModal.test.tsx`, `EnvVarsSection.tsx`, `HeadersSection.tsx` and 16 locale catalogs. Errors have prominent summaries and expandable wrapping details; the body scrolls while footer controls stay visible. Raw HTML is rendered as text.

## Final combined-build validation

The final backend including the [Gemma and contract fixes](GEMMA_CONTRACT_20261013_EN.md) passed another live ACP probe; that document records the command and binary hash. Evidence: `target/mcp-discovery-acp-DuSQFu/`. HexStrike returned 150 tool definitions: 0 in the existing chat before explicit loading, 150 afterward, and 150 in a new chat. The `server_health` call succeeded. Gemma actually called `load_analysis_tools` and `extensionmanager: search available extensions`, both with completed receipts, then correctly reported `server_health` and `execute_command`. No command execution or scanning tools were invoked. Discovering 150 definitions does not validate every underlying operation.
