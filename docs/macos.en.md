# macOS development and packaging

[简体中文](macos.zh-CN.md) · [繁體中文](macos.zh-TW.md)

Target: macOS 14+, native Apple Silicon arm64. The scripts also retain native Intel x64 builds. As of 2026-10-19, development-signed v10 produced DMG/ZIP artifacts; native packaging, package smoke and DMG installation smoke exited 0. Complete computer input and permission continuity across replacement upgrades remain under acceptance. v10 excludes the later v11 signing performance fix and latest virtual-pet changes. See the [initial validation record](reconstruction/2026-10-16-macos-validation.en.md) and the signing section below.

## Architecture and scope

Electron starts bundled standalone Node running Harness through the existing ACP adapter. Harness retains execution, scheduling, completion and compaction ownership. Mac uses the existing official Bash plugins. The retired Rust Agent/CLI is not a build input.

Resources include Node and its license, matching Python/Office payloads and runtime dependencies. Electron and Harness have separate node-pty payloads; staged spawn helpers receive executable permissions. Runtime verification runs before and after signing, with post-sign evidence outside the `.app`.

Source integration now covers four existing configuration keys: `qwen_computer` uses the Go front end and Swift helper for nine computer-control tools; `computercontroller` provides PDF/web-file/cache tools; `autovisualiser` provides charts; `commonqueries` provides time/location/weather. The latter three use tool-only Rust `codebuddy-tools`. Availability requires matching local artifacts to pass identity checks; it does not imply enablement, connection or TCC authorization. The Mac document service exposes no second desktop/script route and does not auto-install Peekaboo. External MCP, conversations, editing, Office and history keep their existing flows and still require native acceptance.

## Native prerequisites

Use this source revision and its lockfiles with native Node 24+, the project's pinned pnpm, Git, Go 1.22+, Xcode Command Line Tools, and Rust/native Apple target specified by `rust-toolchain.toml`. Prepare dependencies on Mac; do not reuse Windows `node_modules` or Python payloads. Cargo builds offline; Go disables automatic toolchain/module downloads. Prepare locked Rust dependencies beforehand. `CODEBUDDY_GO_EXECUTABLE` can select existing Go. Downloads and installation are separate preparation steps; this batch completed them with approval.

With download approval, run from the repository root:

```bash
corepack pnpm --dir ui install --frozen-lockfile
npm ci --prefix runtime --ignore-scripts --no-audit --no-fund
npm ci --prefix runtime/harness --ignore-scripts --no-audit --no-fund
npm ci --prefix scripts/office-builder --ignore-scripts --no-audit --no-fund
node scripts/prepare-harness-office.mjs
```

The pinned upstream Office builder selects `mac-arm64` or `mac-x64` from the native process. Existing `runtime/py` and `runtime/office` directories are preserved and reported; inspect their provenance before any replacement. Packaging copies prepared Office resources and builds standalone native tools from the current source without downloading dependencies.

## Launch and package

```bash
bash ./start-preview.sh
node scripts/build-harness-macos.cjs --arch arm64 --node-license /absolute/path/to/Node/LICENSE
```

`CODEBUDDY_NODE` can select an existing Node executable for preview. Run packaging with native Node of the selected architecture. `--node-license` identifies that Node distribution's license. Desktop `bundle:mac`, `bundle:default` and `bundle:intel` share this Harness implementation; the retired `--backend` argument is removed.

Preview first runs `scripts/prepare-harness-macos-tools.cjs` to build/synchronize native Rust/Go/Swift tools and stops on failure. Standalone preparation: `node scripts/prepare-harness-macos-tools.cjs --arch arm64`. No tests run by default. Generated local manifests/binaries remain untracked; Windows provenance and artifacts are preserved. Packaging always uses a fresh tool stage.

`runtime/tools/artifacts.json` identifies four fixed filenames, architectures, sizes and SHA256 values. Runtime verifies ordinary files and executable permissions, checking both the computer front end and Swift helper. Following the [osx-sign implementation](https://github.com/electron/osx-sign/blob/main/src/sign.ts) and [Apple nested-signing rules](https://developer.apple.com/library/archive/technotes/tn2206/), final hashes are refreshed after child signing but before the outer application seal, retaining source identities. Startup never rewrites signed resources.

Users must grant Screen Recording/Accessibility for the actual application; tools do not grant permissions themselves. `doctor` reports state without prompting. Locked or mismatched desktop sessions reject observation/input. `cmd`/`super` mean Command and `ctrl` means Control. Actions bind to the latest observation; uncertain outcomes require reobservation rather than replay. Preview helpers and installed applications can have different TCC identities.

Apple Silicon outputs under `ui/desktop/out/CodeBuddy-darwin-arm64/`: `CodeBuddy.app`, `CodeBuddy-arm64.dmg`, `CodeBuddy.zip`, `artifacts.json` and `SHA256SUMS`. Intel uses `--arch x64` and `CodeBuddy_intel_mac.zip`. Records include revision, dirty state and the pre-sign payload digest; installer hashes identify final artifacts.

Local builds default to ad-hoc signing. Select an existing certificate explicitly with `CODEBUDDY_MAC_SIGN_IDENTITY`; Developer ID notarization additionally requires `APPLE_TEAM_ID`, `APPLE_ID` and `APPLE_ID_PASSWORD`. An approved development certificate has been used locally; notarization and public distribution acceptance remain unverified. This reuses the [official Forge signing flow](https://www.electronforge.io/guides/code-signing/code-signing-macos) without adding a packaging framework.

## Deferred verification

The validation commands follow. Record source identity, exit codes and artifacts separately for each batch; historical passes do not replace current verification:

```bash
corepack pnpm --dir ui/desktop run test:macos-package
corepack pnpm --dir ui/desktop run test:macos-native
corepack pnpm --dir ui/desktop run typecheck
npm --prefix runtime test
cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1
corepack pnpm --dir ui/desktop run test:macos-smoke
corepack pnpm --dir ui/desktop run test:macos-install
```

The last two require matching native artifacts. `test:macos-native` runs Go/Swift contracts on the native host. Regressions cover identities, rejected architectures/paths, missing helpers, post-sign hashes and document inventories. Earlier Mac batches ran native contracts; current signed-update and TCC checks are in progress. Packaging checks actual discovery of all four MCP services without claiming desktop-input acceptance.

API smoke exercises startup, workspace, PTY and embedded-browser paths; it does not establish real-model or complete user-flow acceptance. Subsequent RustDesk acceptance should cover Finder launch, Unicode projects, model/tool execution, exit/restart and durable history. Computer control separately needs TCC, screenshots, Unicode input, window transitions and action postconditions, recording source identity and artifact hashes.

Preview data/logs live in `.preview-data`; installed builds retain `~/.CodeBuddy-Harness`, with service logs in `logs/harness`. Use isolated test profiles and preserve existing user data.

## Mac credential protection (2026-10-16)

The standalone Swift `codebuddy-credentials` helper stores a random 256-bit master key in the current user Keychain. Configuration stores only a `macos-keychain-aesgcm-v1` AES-GCM envelope. Decryption never creates a key; missing or locked keys, damaged ciphertext and foreign-platform records fail explicitly. Windows retains DPAPI. The helper is built, verified and signed with native tools; installed applications do not require a Swift compiler. Users handle system permission prompts.

Before runtime tests, run `node scripts/prepare-harness-macos-tools.cjs --arch arm64` to prepare all four fixed native artifacts. `test:macos-native` also runs isolated Keychain tests using a random test service and synthetic values, removing only that test item afterward.

Historical status: Mac dependencies, Office payload, native Go/Swift components and typecheck are ready. The initial 311 passed, 46 failed and 6 skipped runtime result predates repairs. Subsequent v6 package verification covered credential protection; native packaging, package smoke and DMG installation smoke exited 0. Installed time, cache, PDF extraction and chart receipts were verified; computer input after screenshot capture still awaits repair and acceptance. These results do not establish current signed-batch or complete product E2E acceptance.

## Signing identity and upgrade permissions (2026-10-19)

Signed builds require CODEBUDDY_MAC_SIGN_IDENTITY with the full certificate name. Apple Development is for local acceptance; Developer ID Application is for external distribution. APPLE_TEAM_ID additionally requires a matching Developer ID identity and existing notarization credentials. Builds without an explicit identity remain ad-hoc and do not guarantee permission continuity between builds.

Packaging inspects the actual signatures of the app and four native tools, verifies the certificate, Team ID and app identifier, and records designated requirements in artifacts.json. Environment variables are no longer treated as proof of signing. Do not routinely reset TCC or remove permission entries on upgrade. Preserve app identity, signing identity and installation location, then test screen recording, accessibility and Keychain after an actual replacement upgrade. Live permission checks already exist but do not replace system consent.

References: [Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements), [Electron osx-sign](https://github.com/electron/osx-sign). Local development-certificate upgrade acceptance is in progress; Developer ID distribution and notarization remain unverified.

Local v10 acceptance uses `Apple Development: YuanHong Lin (U3ZPY586Q2)` with actual signing Team ID `R3JK7R29AC`. The personal identifier in the certificate name differs from its Team ID; inspect the signature. Synthetic credential encryption/decryption passed for the same installed copy. The next build must decrypt that original ciphertext before cross-version continuity is established.

Screen Recording and Accessibility entries have been added for the newly signed app at the fixed installation path. Installed time, cache, PDF extraction and chart-receipt checks have run; computer control still fails at foreground-window validation. Use actual tool receipts to repair the failure, then verify screenshots, Unicode input and saving. Enabled permission switches and successful tool discovery do not establish input acceptance.
