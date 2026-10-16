# Harness 11–15 source merge handoff

2026-10-16. [简体中文 (default)](2026-10-16-merge-handoff.zh-CN.md) · [繁體中文](2026-10-16-merge-handoff.zh-TW.md).

## Delivery and baseline

Repository: `https://github.com/erjinyi-bool/CodeBuddy-v1.git`, existing `main`. Parent baseline: `01610d03764570282eee439cd2bfb49fcd373e98`. This delivery includes the previously uncommitted Harness 11–14 changes and Harness 15. Use `git log --oneline -- docs/reconstruction/2026-10-16-merge-handoff.en.md` to identify the delivery and subsequent handoff revisions.

The user changed delivery to local validation followed by source commit/push; new installer generation was stopped. Source, locks, tests and documentation are included. Credentials, sessions, raw acceptance evidence, Python payloads, dependencies, binaries and build caches are excluded. Earlier reports saying “not committed” describe their historical state.

## Changes and ownership

| Area | Change and merge implications |
| --- | --- |
| Agent core | Eleven legacy Rust crates and their CLI/provider/native-SDK entry points removed. Cargo retains `goose-mcp`. Harness owns execution, scheduling, completion, context metering and compaction. Do not restore the old Agent fallback. |
| Independent tools | `codebuddy-tools.rs` retains MCP desktop control, PDF, charts, cache, weather and other tools without an equivalent upstream replacement. Office/public web fetch prefer upstream. The product is not entirely Rust-free. |
| Deferred tools | `runtime/harness/tool-discovery.mjs` defers full native/MCP schemas while retaining discovery, permission checks and dynamic refresh. Repeated task/memory instructions were shortened. |
| Model capacity | Model catalog, provider metadata and explicit configuration supply capacity. `useModelCapacity` removes the temporary 128K guess and rejects stale responses after switching models. Unknown capacity is distinguished from confirmed capacity; 33K is not a universal model limit. |
| Context | Harness triggers compaction; adapters forward live usage/capacity/compaction events to ACP and the indicator. The documented upstream single-checkpoint compatibility patch remains; there is no second summarizer. |
| Startup | Capacity discovery and connection warmup overlap; MCP scopes are reused. Warmup neither creates sessions nor generates answers nor calls tools. Reduced repeated decryption/history serialization; desktop/Forge reject legacy Agent fallback. |
| MCP tasks | Official SDK task capability negotiation, polling and cancellation in `mcp-tasks.mjs`; default request timeout 300 seconds. Accepted calls are not blindly replayed, task handles are not completion. External asynchronous tasks still have cross-process recovery limitations. |
| Office | Direct `dsh-skill-office` and workspace-dependency plugins; official pinned Python 3.12.14 and 13 libraries. Unmodified upstream builder, lock and license in `scripts/office-builder/upstream`. Model invokes skills and Harness shell; no new Office engine. |
| Toolbox | `library.mjs` projects the winning official definitions into both source and actual managed-skill lists; builtin details are readable and edits rejected. Fixes skills available internally but absent from the UI. No layout redesign. |
| Web | Official public `web_fetch` with permissions and public URL/address boundaries. No unconfigured `web_search`; not private-network access or binary download. |
| SDK/build | Unchanged ACP schemas relocated to `ui/sdk/schema`; generator reads them without the removed Rust SDK. CI, Justfile, desktop boot, Forge and architecture docs updated. |
| Windows paths | Real Squirrel install reproduced a 268-character extraction failure. Payload paths shortened to `runtime/py` and `runtime/office`; preflight/regression added. Installation of the shortened candidate was not rerun after the user cancelled installer delivery. |

See [H11](2026-10-15-harness11.en.md), [H12](2026-10-15-harness12.en.md), [H13](2026-10-15-harness13.en.md), [H14](2026-10-16-harness14.en.md), [H15](2026-10-16-harness15.en.md), [tool reuse audit](2026-10-16-rust-tool-reuse-audit.en.md), and the authority map at `documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md`.

## Merge procedure

1. Preserve the colleague's uncommitted work; inspect divergence from the parent baseline. No colleague branch has been merged automatically.
2. Fetch `origin main` and review `git diff --stat 01610d03764570282eee439cd2bfb49fcd373e98..origin/main` plus file diffs.
3. Merge the delivery into the colleague's selected integration branch as a complete migration, not isolated Office/UI or partial Rust deletion hunks.
4. Resolve conflicts especially in Cargo manifest/lock, Harness index/profile, library/server, desktop main/Forge, ACP context events and SDK schemas. Preserve independent features while keeping Harness as the sole execution/context owner.
5. Change authoritative schemas before SDK generation. Do not restore generation from deleted Rust crates. Historical import mappings and `_goose/unstable` names intentionally remain compatibility interfaces.
6. Prepare local dependencies using README, Harness lock and tool provenance; binaries are not supplied by Git. Revalidate the merged source rather than reusing an older executable as proof.

## Preparation and commands

Use Node 24, the repository's pnpm and Rust toolchain. Do not reinstall existing dependencies or clear caches just for verification.

```powershell
# First-time official Office preparation; separately approved network dependency step
npm ci --prefix scripts/office-builder --ignore-scripts --no-audit --no-fund
node scripts/prepare-harness-office.mjs

# Repository root
node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/*.test.cjs
cargo fmt --check
cargo test --offline -p goose-mcp --features rustls-tls --jobs 1
cargo clippy --offline -p goose-mcp --all-targets --features rustls-tls --jobs 1 -- -D warnings

# ui/desktop
node ../node_modules/typescript/bin/tsc --noEmit
node ../node_modules/vitest/vitest.mjs run --maxWorkers=1

# Back at repository root: source startup, not installer generation
.\start-preview.ps1
```

Office preparation preserves an existing payload instead of overwriting it. Git-ignored `runtime/py`, `runtime/office` and native tools must be prepared locally. Missing Office payload causes the relevant test to skip: check skipped counts too. See [builder provenance and instructions](../../scripts/office-builder/README.md).

## Verification and limits

- Current source: 422 backend/Harness/build-script tests passed, zero skipped; Rust 85 passed, one network test ignored; format, Clippy and TypeScript checks exited 0. All 262 frontend files and 2320 tests passed, exit 0.
- Current local application: `1.43.3-harness15`, `ui/desktop/out/CodeBuddy Harness-win32-x64/CodeBuddy.exe`; runtime digest `826f35f499126abbe1f8fa4e84f94f8249e48dfab2c64b224955b31eeb31012f`. Built from this worktree, not an old installed application.
- Real Kimi K3: session visible in 691 ms, first answer in 5514 ms (one sample, not an SLA). Ordinary DOCX/XLSX creation/public fetch, then targeted edits completed in 64.5/50.9 seconds. Two completed Harness turns, no tool errors, official skills/dependency/shell/web tools and no legacy MCP document calls.
- Independent inspection confirms originals, image bytes, bold formatting, formula text and unrelated worksheet preservation. Real toolbox lists all three Office skills and opens details. All 661 original user sessions and provider/preference hashes unchanged; model tests used an isolated profile.
- Reused H14 evidence: eight-module project and post-restart correction, 21 automatic compactions, 70/73 project tests plus 64 independent checks each round; live usage, stop/resume and repository read-only analysis passed. Not rerun end to end on H15.
- Local raw logs: `.preview-evidence/h15-final-*`, `h15-local-final-*`, `h15-user-preservation-after.json`; raw sessions/configurations are not published.

This is not full-platform or all-feature certification. macOS, every desktop-control action, hours-long production tasks, real-model PPTX and Office visual layout remain separate acceptance items. Excel validation checks formulas as text/format, not recalculated caches; LibreOffice visual rendering was not tested. The ignored Rust network test is not a pass.

The failed earlier install may leave `%LOCALAPPDATA%/CodeBuddyHarness` incomplete. User data is preserved. Use source startup or the local executable above; an old Start Menu shortcut is not an H15 acceptance entry point. Short-path regressions and the local application passed, but no corrected installer was installed after cancellation. Do not distribute the rejected H15 installer.

Rollback source through reviewed Git changes without deleting user profiles/workspaces. Restore an older installation only from the previously accepted H14 package after inspecting current state. When upgrading Harness, reassess model metadata, MCP Apps/tasks and compaction compatibility patches against upstream interfaces.
