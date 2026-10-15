# Mac main integration repair and acceptance record（2026-10-11）

## Conclusion

The table separates automated checks, native installation, and actual UI acceptance. It covers current main plus this repair; unexecuted scope remains NOT_RUN.

**PARTIAL_ACCEPTANCE — Kimi/native gates PASS; DeepSeek completion BLOCKED**

The Mac tool contract and native fixture defects are repaired. Final Windows/Mac automated regressions, the final arm64 DMG, and its installed copy passed. Kimi passed all ten actual UI checks. Overall acceptance remains partial: original DeepSeek still omitted completion coverage in the final copy. Correct file creation and read-back are proven, while the host remains paused. The new recovery guidance did not resolve this model behavior; it remains an open model compatibility/completion issue. Completion criteria and the default model were not changed.

## Changes

- Completed the Unix tester tool and command contract: use declared tools, run one test command per turn, and report the actual exit code. Plain text tasks use read_document; dynamic tests that were not run remain NOT_RUN. Existing permission and completion evidence requirements are retained.

- Fixed Windows path, CMD, and Python executable assumptions in test fixtures. Unix hook fixtures execute regular files through sh. The canonical host verification fixture runs an actual Python test and checks it executed once. Added Unix activity presentation and native Python execution coverage.

- Added durable_execution_bound to the Mac ActivePromptRun test initializer. Reviewed the Unix prompt snapshot against current main tool registration before updating it.

- Added recovery guidance after a main Agent completion rejection: inspect current requirements and real receipts, propose coverage using those receipts, or report a concrete blocker while preserving confirmed work. Guidance is separate from structured completion facts; permissions, requirements, and host completion criteria are unchanged.

## Results

| Check | Exit | Result | Evidence |
| --- | --- | --- | --- |
| Mac SDK/locale build + TypeScript | 0 | PASS | sdk-build.log / locale-build.log / typecheck.log |
| Mac frontend | 0 | 60 passed | frontend-native.log |
| Mac package contracts | 0 | 41 passed, 8 skipped | mac-package-contract.log |
| Mac Git MCP | 0 | 3 passed, 1 Windows-only skipped | git-mcp-native.log |
| Mac backend regression | 0 | 2130 passed, 0 failed, 5 ignored | backend-final-recovery.log |
| Mac context | 0 | 18 passed | context-repaired.log |
| Mac Clippy | 0 | PASS, 6 retained platform warnings | clippy-final-recovery.log |
| Windows backend regression | 0 | 2213 passed, 0 failed, 3 ignored | windows-final-recovery-regression.log |
| Windows final fixture | 0 | 1 passed | windows-final-fixture.log |
| Windows final strict Clippy | 0 | PASS | windows-final-recovery-clippy.log |
| Format + diff checks | 0 | PASS | cargo fmt --all -- --check / git diff --check |
| Mac runtime integration | 0 | 18 passed | runtime-repaired.log |
| Mac native package/install | 0 | PASS; final-source arm64 DMG + copied installed application | cli-repaired.log / package-repaired.log / installed-final-result.json |
| Mac actual UI / original DeepSeek | 1 | FAIL: correct file; host completion_blocked; 2/10 checks | deepseek-final-result.json / deepseek-final-authority.json |
| Mac actual UI / Kimi | 0 | PASS: 10/10, committed completion + persisted terminal | kimi-final-result.json / kimi-final-authority.json |
| Mac native ACP workspace/restart | 0 | PASS: 8 lifecycle/boundary checks | workspace-restart.log |
| Private test credential cleanup | 0 | PASS: removed after both tests; formal profile/Keychain untouched | credential-cleanup.json |

## Platform scope

Unix skill import and held-object cleanup mutation remain disabled by the existing design. Windows mutation/rollback tests run on Windows; Unix tests verify rejection and preservation of exact settings bytes and run data. Passing rejection tests does not establish full Mac feature parity. Intel Mac, cross-application computer input/TCC, Developer ID notarization, and Gatekeeper/Finder installation acceptance were not run.

## Environment, backups, and failure history

macOS 26.6.2 arm64, 16 GB RAM; native Rust 1.96.1 and Node 24.10.0. The old dirty Mac checkout was preserved as binary patches, untracked archives, native launcher archives, and a stash. A Git bundle fast-forwarded it to 21b5582f9b0cc645ba096d560eb6291d15f7e7b2, followed by hash-checked repair sources. Existing installed copies were preserved.

Initial run: 2086 passed, 48 failed. Native PATH, TMPDIR=/private/tmp, and serial execution reduced this to 2106 passed, 28 failed. The first repaired run had 2128 passed, 1 failed: directory observation is not dynamic verification evidence. The final fixture runs a real test. Interrupted compilations and one fixture import compilation error were retained and never counted as passes. Windows default test-thread stack overflow was resolved by using the existing CI RUST_MIN_STACK=8388608 configuration for the full regression.

## Credentials and source

The user approved transferring the necessary Windows main model settings and one credential into isolated Mac acceptance storage. Preflight returned HTTP 200 and a real model reply. The credential is used only in test child environments, without modifying the formal Mac profile or global Keychain, and is excluded from Git. The prior temporary Windows shell permission override was already restored.

## Native acceptance and evidence

```text

Source base: 21b5582f9b0cc645ba096d560eb6291d15f7e7b2 + tested repair-source-manifest.json (8 files)
CLI SHA-256: 337ec245bbaa267596eb41d09b00acb8f565f8fd92dc78d83131043411286ec6
DMG SHA-256: a92dc22bb0c655808cecfb5ce5f8f9b626911c87e1182d8369da4afa937d4305
App version: 1.43.2; arm64; deployment 14.0; signing: ad-hoc
CLI release build: 20m 32s; exit 0
Manifest records dirty=true because repair commits followed acceptance.
Raw source hashes are provenance, not canonical Git blob hashes.

/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/ui/desktop/out/macos-install-XDZwnT/installed/CodeBuddy.app

/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/ui/desktop/out/CodeBuddy-darwin-arm64/CodeBuddy-arm64.dmg

```

Kimi passed 10/10: ordinary new-task UI, actual model write and exact disk bytes, run_completed, persisted completed turnTerminal, reload continuity, file tree/preview/Unicode editing/save, unsaved-close cancellation, real PTY keyboard input and workspace cwd, and real WebContentsView local/public HTTPS navigation. DeepSeek passed only task entry and correct file bytes; its actual receipt is run_paused/completion_blocked. Kimi does not establish compatibility for every model. Runs used isolated profiles and did not replay completed actions. The private credential payload was removed.

```text

Local: D:\Users\jiangrui\Desktop\CodeBuddy\target\macos-merge-acceptance-20261011

Remote: /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/macos-merge-acceptance-20261011

Source: repair-source-manifest.json

Windows backup stash: 442a5495f

Mac backup stash: ad5c457ee

```

## Commands

```sh

cargo test --locked --offline -p goose --lib --release --jobs 1 -- agents:: acp:: context:: permission:: --test-threads=1

cargo test --locked --offline -p goose --lib --release --jobs 1 -- context_mgmt:: --test-threads=1

cargo test --locked --offline -p goose --test codepro_runtime --release --jobs 1 -- --test-threads=1

cargo clippy --locked --offline -p goose --lib --release --jobs 1

cargo build --release -p goose-cli --bin goose --target aarch64-apple-darwin --jobs 1 --locked --offline

node scripts/bundle-macos.cjs --arch arm64 --backend /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/aarch64-apple-darwin/release/goose

node scripts/macos-install-smoke.cjs

cargo test --locked --offline -p goose --lib --release --jobs 1 -- main_agent_ rejected_completion_feedback --test-threads=1

```

Two actual DeepSeek runs wrote and read the correct file but did not submit completion coverage, so the host retained completion_blocked. A prose success claim was not accepted. Recovery guidance now points to existing receipts. A regression caught the first guidance placement breaking legacy JSON parsing; it was corrected before the final Windows 2213/Mac 2130 passing runs. Kimi passed ten actual UI checks in an earlier installed copy; final delivery results below use the rebuilt final-source copy.

## Source SHA-256 (raw tested files)

```json
{
  "crates/goose/src/acp/server/custom_dispatch.rs": "67afe08e70b5af8b16ba41b4f7b56c8a9f5a33ad88df6f15d5aa779ac0ce56f1",
  "crates/goose/src/acp/server/onboarding.rs": "f13eaacae6a193ea49a86d6500f64d56995c45e2145aa08fd9d6ddda680cb3ec",
  "crates/goose/src/agents/agent.rs": "20195ea3113e638910f1540651ba286b38b18ecbbb3a10005baff015e85daf2f",
  "crates/goose/src/agents/codepro_state_store.rs": "beb7b8a67be790d5f6f01bea0bebc3ebf4ee5fe3203270b49960f602be31b28c",
  "crates/goose/src/agents/snapshots/goose__agents__prompt_manager__tests__all_platform_extensions.snap": "0699a5bb55721b17f5575e4b8f66c0da2e39ed13313c8400a4d69f1c7b56cb23",
  "crates/goose/src/agents/task_scheduler.rs": "ec58622c0735782b0f8dc5e4cb668b97628593e3131fd825f7faaec26e1500ca",
  "crates/goose/src/agents/tester_runtime.rs": "b3b972639f0d3004fec59fbb8fa5bdbefaa557c170a1d6ae7ab0964f773220e0",
  "crates/goose/src/agents/tool_execution.rs": "7d9743feff5f0dc2b0a596dc8070664e2464e66013cb8e0b3e890d84ff98fb56"
}
```

## Windows final verification commands

```powershell
$env:CARGO_PROFILE_DEV_DEBUG = "0"
$env:CARGO_INCREMENTAL = "0"
$env:RUST_MIN_STACK = "8388608"
cargo test -p goose --lib --jobs 1 --offline -- agents:: acp:: context:: permission:: --test-threads=1
cargo clippy -p goose -p goose-providers -p goose-provider-types -p goose-sdk-types --lib --jobs 1 --offline -- -D warnings
cargo fmt --all -- --check
git diff --check
```
