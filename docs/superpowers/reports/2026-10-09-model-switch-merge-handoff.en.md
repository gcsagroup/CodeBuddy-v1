# Model switching fix: merge handoff (2026-10-09)

[繁體中文 (default)](2026-10-09-model-switch-merge-handoff.md) · [简体中文](2026-10-09-model-switch-merge-handoff.zh-CN.md)

## Source and scope

Repository: `https://github.com/erjinyi-bool/CodeBuddy`, branch `main`. Code commit: `6d63cb6fa672918796bf527439d326bb46ad284c`. Parent: `eadb7cf9852eab5b76ee629d1db0dabf216b7cb3`. This report is a subsequent documentation commit; query it with `git log -1 -- docs/superpowers/reports/2026-10-09-model-switch-merge-handoff.en.md`.

Only the current fix across nine files and three handoff documents are included. Existing staged and unstaged work remains separate. This is not a complete snapshot of all macOS development. No new dependencies, public protocols, configuration formats, or database migrations.

## Confirmed root cause

The selector used live model IDs, but existing-session selection validated against the provider's saved inventory. The saved Windows model was `qwen3.8-flash-next`; the service now advertised `Qwen3.8-27B-direct-A-best15-FP4`. The UI offered it, then the backend rejected it with `Invalid params / Model ... is not available`.

The earlier regression tested provider creation and default selection, but omitted existing-session `provider_model` selection. Defaults already used live validation; the session path did not. The UI discarded the specific error and displayed a generic retry message.

## Changes and conflict hotspots

| File | Incremental change |
| --- | --- |
| `crates/goose/src/acp/server.rs` | `validate_provider_model_selection` reuses `validate_saved_custom_provider_models` for custom providers before mutation. Removed models and unavailable endpoints reject; built-in behavior stays as before. |
| `crates/goose/tests/acp_unauthenticated_custom_provider_test.rs` | Extend the existing ACP test with live replacement absent from saved inventory, defaults agreement, removed model, HTTP 503, and persistence after rejection. |
| `ui/desktop/src/components/ModelAndProviderContext.tsx` | Keep the boolean result; add optional `onError(message)`. Translate known structured codes only; preserve rollback and generic handling of unknown errors. |
| `ui/desktop/src/components/ModelAndProviderContext.test.tsx` | Cover model/network/credential errors without exposing private paths or raw error bodies, and no defaults mutation on rejection. |
| `ui/desktop/src/components/settings/models/subcomponents/SwitchModelModal.tsx` | Preserve the specific error in the dialog; retain current-session guards, default transactions, and failure behavior. |
| `ui/desktop/src/components/settings/models/subcomponents/SwitchModelModal.test.tsx` | Specific Chinese error, dialog remains open, successful retry, callback argument assertions. |
| `ui/desktop/src/i18n/messages/{en,zh-CN,zh-TW}.json` | Add four keys under `modelAndProviderContext`: `modelUnavailable`, `endpointUnreachable`, `credentialsRejected`, `invalidResponse`. Preserve `{defaultMessage: ...}` objects. |

The existing validator in `server/providers.rs` fetches live models and performs a minimal nonstreaming completion. No second validation implementation or manual repair of saved user models/credentials was added. Selection requires a working endpoint and may consume a small model request.

## Integration instructions

1. Preserve your work under your team's workflow; inspect `git status --short`, then `git fetch origin`.
2. If fast-forward is appropriate, `git merge --ff-only origin/main`. If your branch diverges, inspect commits and integrate deliberately; do not reset or overwrite your changes.
3. For just this fix, confirm the existing live validator, `acpErrorCode`, and default-model transaction APIs are present, then `git cherry-pick 6d63cb6fa672918796bf527439d326bb46ad284c`. Evaluate prerequisite commits if they are absent.
4. Merge overlapping selection changes semantically: validation precedes mutation, live availability wins over saved inventory, and `updateDefaults`, `onError`, `superseded`, and current-session guards remain intact.
5. Merge translations by key; retain unrelated messages and their object shape. Do not replace entire files with either side.
6. Rebuild both backend and desktop UI and repeat the targeted tests and real application flow.

Earlier memory/latency changes: `7b34092cf`, `803f9431b`, `bc4ff081d`; docs `eadb7cf98`. See the [previous handoff](2026-10-09-memory-fixes-merge-handoff.en.md). These changes were not recommitted here.

## Verified results

- Windows ACP integration: one extended test passed, exit 0; real ACP transport with controlled HTTP fixtures.
- macOS release ACP integration: same test passed, exit 0.
- Component tests: two files, 26 tests passed on each platform, exit 0.
- Final Windows typecheck, ESLint, i18n checks and Clippy passed, exit 0. Intermediate assertion/translation-shape errors were corrected and affected checks rerun.
- Rust formatting, Windows backend build, macOS arm64 release backend and bundle completed.
- Windows real Electron: original session `20261009_24` switched LAN → Ollama → LAN in approximately 0.888 / 4.520 / 0.942 seconds. Footer, persistence and defaults agreed. Rejected removed model retained selection. New session `20261009_26` actually replied `模型切换正常` using the new LAN model.
- Installed macOS bundle43: session `20261009_21` switched LAN → Ollama → LAN in approximately 0.412 / 4.041 / 0.435 seconds and actually replied `模型切换正常`.

The existing LAN endpoints differed: Windows `192.168.9.120:8001`, Mac `192.168.9.101:8001`; Mac served `Qwen3-VL-30B-A3B-Instruct-FP8`. Neither configuration was rewritten for this test. Timings are observations, not guarantees.

### Reproduction commands and evidence

Use the existing environment prescribed by README. Mac ACP tests additionally use `--release`. macOS bundling uses `node ui/desktop/scripts/bundle-macos.cjs --arch arm64 --backend target/aarch64-apple-darwin/release/goose`.

```powershell
# 仓库根目录 / repository root
cargo test --locked --offline -p goose --test acp_unauthenticated_custom_provider_test --jobs 1 -- --test-threads=1
cargo clippy --locked --offline -p goose --lib --test acp_unauthenticated_custom_provider_test --jobs 1 -- -D warnings
cargo fmt --all --check
# ui/desktop
pnpm exec vitest run src/components/ModelAndProviderContext.test.tsx src/components/settings/models/subcomponents/SwitchModelModal.test.tsx
pnpm exec tsc --noEmit
```

Local evidence: `target/model-switch43-20261009/`. Mac: `target/macos-acceptance43/`. Logs, exports and fixtures remain local and uncommitted; this report summarizes results without credentials. Application acceptance used builds from the existing dirty workspace, not a clean snapshot of this commit alone. Revalidate the combined result after integration.

## Installer

Mac desktop: `~/Desktop/CodeBuddy-Mac-Test-20261009-bundle43/`. Installed app: `~/Applications/CodeBuddy-Test-20261009-bundle43/CodeBuddy.app`.

`CodeBuddy-arm64.dmg` SHA-256: `805d3207527b351d6ff9213110a08c6684c885c5ed65c8cd009a3cfbd5f9a6f1`.

DMG verification, installation structure, signature integrity and packaged backend identity passed. Apple Silicon internal test package with ad-hoc signing. Intel, Developer ID notarization, Gatekeeper interactions and Finder drag installation were not accepted. Packages, profiles and credentials are not committed.

## Separate observations

After successful switching, a follow-up in the old memory-clearing session hit the existing recovery-classification timeout and left the original task unchanged. A new session with the same model replied successfully. This change does not alter recovery classification or extend its timeout, so that observation is not claimed fixed. Later the Windows 120 endpoint refused connections, after the successful reply. Endpoint availability requires the upstream service to remain running. Both observations are distinct from the confirmed stale-inventory rejection.
