# 2026-10-16 Mac validation record

[简体中文](2026-10-16-macos-validation.zh-CN.md) · [繁體中文](2026-10-16-macos-validation.zh-TW.md)

Source: Windows `D:\CodeBuddy-v1`, branch `main`, revision `732113504de3601ab087a609ce20827b814db2c2` plus uncommitted Mac adaptations. Existing Node 24.21.0 and dependencies were used. No dependency installation, branch switch, commit or push occurred.

| Executed target | Exit code | Result |
| --- | --- | --- |
| Mac packaging contracts, artifact identities, launcher, dependencies and standalone MCP regressions | 0 | 32 passed |
| `node --test runtime/tests/*.test.mjs` | 0 | 363 passed |
| `node ui/node_modules/typescript/bin/tsc --noEmit --project ui/desktop/tsconfig.json` | 0 | Passed |
| `cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1` | 0 | 69 passed, 1 ignored |
| `cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings` | 0 | Passed |

The Simplified Chinese record lists the complete focused command. The first typecheck used a nonexistent non-hoisted dependency path and exited 1 before loading TypeScript. Using the existing hoisted UI dependency passed; no product fix or installation was made. The ignored case is the existing public Open-Meteo test. Focused and full suites overlap; counts do not represent additive unique coverage. Actual MCP processes ran on Windows. Mach-O/signing-hash cases use fixtures and do not establish native Mac execution or signing. No product defect was observed in the executed checks.

RustDesk displayed “connecting to the RustDesk network.” No remote desktop window appeared after the connection action. No current Mac frame or project directory was obtained; the user was asked to connect manually and keep the Mac unlocked. This is an environment blocker, not a project-test failure.

Native Go/Swift contracts, native tool/installer builds, signing/install checks, computer-control E2E and standalone MCP execution on Mac remain unrun. No current Mac installer or product PASS exists. Resume by verifying revision and working changes, then use an isolated profile for TCC, observation, Unicode input, window transitions and the four MCP groups. Retain command exits, real receipts and visible postconditions. Historical packages/screenshots are not current evidence; users handle passwords and OS grants.

Local `.preview-evidence/mac-acceptance-20261016/` holds results, source hashes and pending source differences. These materials have not been transferred to Mac and remain excluded from commits.

## Subsequent resume

RustDesk now exposes the `159817412@erjinyidemacbook-air.local` remote window, showing the Mac desktop clock advancing from 19:03 to 19:06. The earlier disconnected status is superseded. Opening `work` and restoring the RustDesk window produced no observed transition, so input delivery remains unconfirmed. An auxiliary SSH probe reached the host but existing credentials were rejected (exit 1). Host records were scoped to the local evidence directory; no password was read/entered and no Mac command ran. The user was asked to move RustDesk onto the primary Windows display, activate it, manually open `work`, and provide the project path. Native builds and acceptance still await a working input/execution channel. Hashes of 21 implementation/configuration files match the previously tested state; this reuses evidence rather than rerunning tests or establishing Mac acceptance. Details are in local `rustdesk-resume.json`.

## Input-channel diagnosis

RustDesk is now on the primary Windows display, but folder and title-bar actions still produced no observed transition. Read-only token inspection exited 0: the current execution process has `elevated=0, uiAccess=0`, while both RustDesk GUI processes (PIDs 27456 and 57876) have `elevated=1, uiAccess=0`. RustDesk is version `1.5.0+68`. The session log contains no observed keyboard/mouse permission-disable record; this does not establish Mac Accessibility authorization.

The privilege mismatch is a concrete local input-blocking lead. [Microsoft's SendInput documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) describes the UIPI integrity-level restriction. Launching through the supported normal application entry still returned the existing windows. The user was asked to exit Windows RustDesk, reopen it normally, and reconnect to the same Mac. No UAC, application permissions, Mac TCC, or credentials were changed, and no Mac command ran.

Recovery remains unverified. Recheck privileges and visible click/text postconditions before synchronizing current sources, building/installing, and accepting computer control and standalone MCP. Previous Windows automation was not rerun; all native Mac stages remain `NOT_RUN`. Local evidence is in `rustdesk-input-diagnostic.json`.

## Remote input recovered

After the user reopened RustDesk normally, a real double-click opened the Mac `work` folder. An ordinary key was observed, and native Edit > Paste followed by execution of `uname -m` returned `arm64`. Bulk typing shortcuts have a Windows/Mac mapping mismatch; translation mode did not resolve it and was restored to legacy mode. Commands use verified native paste. A quoted New Command query initially failed with an unmatched quote when Run command inside shell was unchecked; enabling it produced environment output. This invocation error is not a product-test failure. The user handled the Documents privacy grant.

Observed environment: macOS `27.0.1`, Node `v26.3.0 arm64`, Go `go1.26.5 darwin/arm64`, installed Rust `1.96.1-aarch64-apple-darwin`, and Xcode Swift. No CodeBuddy directory was found within depth 4 under Desktop, Documents, and work; this was not an exhaustive disk search. A verified `main@7321135` source bundle plus working changes, additions, and hashes is prepared locally and has not been transferred. Authorization was requested to provision `/Users/erjinyi/Desktop/work/CodeBuddy-v1` and locked native dependencies/Office payload. Native builds, installer acceptance, and product computer-control/standalone MCP remain `NOT_RUN`. RustDesk recovery does not establish product acceptance. See local `rustdesk-input-recovery.json`.

## Native preparation: source verified; Office preparation under investigation

The user authorized provisioning this batch at `/Users/erjinyi/Desktop/work/CodeBuddy-v1`, locked native dependencies, Office payload preparation, build and acceptance. RustDesk file transfer completed 1/1 files, 77.34 MB. The remote outer SHA256 gate succeeded and the inner `source.zip` checksum returned `OK`. Source application and verification completed: `source-verify` exited 0 and all 36 changed/new files matched the manifest after LF normalization. Source identity is `main@732113504de3601ab087a609ce20827b814db2c2` plus the batch's dirty changes. The existing `/Users/erjinyi/CodeBuddy` was preserved.

The first preparation stopped before dependency installation with exit 2 because the root selected pnpm 12.8.1 while the project pins 11.9.0. Resume explicitly used `corepack pnpm@11.9.0`, preserving the checkout and system package manager. Dependency preparation advanced to Office; `harness-dependencies` and `office-builder-dependencies` were directly observed exiting 0. Slow requests and retries occurred against the official npm registry. Locks and registry configuration were unchanged.

Office preparation exited 13 under system Node `v26.3.0`, reporting `Detected unsettled top-level await` at `scripts/prepare-harness-office.mjs:30`. The output directory `runtime/office-assets` was empty; the download cache contained Python and the first NumPy archive. Root cause remains unconfirmed. No executable was found at the two conventional Homebrew Node 24 paths checked. A project-local Node `24.21.0` `darwin-arm64` archive is downloading according to the upstream lock, with expected SHA256 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`. It must pass verification before retrying Office. System Node 26 remains intact. Previous Windows checks are reused evidence, not fresh Mac native tests.

Source log: `/Users/erjinyi/Desktop/work/.codebuddy-source-20261016.kbeXOp/prepare-build.log`. Dependency/failure log: `/Users/erjinyi/Desktop/work/.codebuddy-source-20261016.KJbc8Z/prepare-build.log`. Native tests, installer creation, real computer control and standalone MCP product acceptance remain unexecuted. No commit or push was made.

## Keychain implementation and retest (current continuation)

The user approved the Keychain master key + AES-GCM design. The standalone Swift helper, versioned envelope, fixed artifact verification and build wiring are implemented. Windows runtime: 365/365 passed, exit 0 (`.preview-evidence/mac-acceptance-20261016/windows-runtime-keychain.log`). Related regression groups passed 21/21 and 38/38, with overlapping coverage. The initial Mac run remains 311 passed, 46 failed and 6 skipped. The delta archive transferred but is not applied: reconnecting RustDesk restored live frames and revealed the Mac login screen. Awaiting user unlock. Native Keychain compilation/execution, Mac retest, installer build and actual computer-control/standalone-MCP product acceptance remain pending.

## 2026-10-17: native tools pass; pre-package regression remains pending

The preceding delta was applied and verified on the Mac. Native Swift Keychain contract tests exited 0, exercising real key retrieval/reopening, Unicode, empty values, missing-key rejection without creation, and tamper rejection. Native Rust compilation exposed a missing `process-session` feature for `ProcessSession`; enabling that existing feature in `crates/goose-mcp/Cargo.toml` added no dependency. The subsequent `native-tools` stage exited 0 and produced native tools; `package-tests` passed 18/18, exit 0. Evidence is the ignored local `mac-native-v3.log`.

Mac `npm --prefix runtime test` then reported 360 passed, 4 failed and 1 skipped, exit 1. Failures concern an XDG cache assertion, `/var` versus `/private/var` aliases, credential access under an isolated HOME, and cold recovery after interrupted compaction. Updated fixtures/assertions and binding only the Mac credential subprocess HOME to the logged-in account are prepared. Canonicalizing the Harness persistence root is a candidate compaction fix awaiting native verification; workspace symlink rejection remains intact.

The latest Windows full runtime run passed 365, failed 0 and skipped one Mac-only case, exit 0 (`windows-runtime-v4.log`); this does not establish Mac success. The six-file `mac-native-v4.zip` transferred to the Mac with SHA256 `99fb3a55938f498ecdd971da3692c755b36e7efd8cfc90f5bcccacfb60638d66`, but has not been applied. A fresh reconnect confirmed another automatic lock; user unlock is pending. The prepared resume command starts independent, time-limited `caffeinate` so a test failure will not end wake protection.

Source remains `main@7321135` plus this uncommitted batch, with no commit or push. Rust library tests/Clippy, native DMG creation, installed-app smoke and real installed-product computer-control/standalone-MCP operations remain pending. Final acceptance targets the application installed from this native Mac installer; native compilation and tool inventory do not establish product acceptance.

## 2026-10-17: native regression passed; installer acceptance in progress

Applied v4b and v5 after unlock. v4b reported 364 passed, one failure and one skip. Canonicalizing persistence paths did not fix cold recovery and was reverted. The upstream JSONL plugin batches writes for 200ms. The adapter now awaits existing sessions.flush before acknowledging a completed response. The crash regression also asserts original facts are on disk before starting compaction; persistence ownership and format are unchanged.

Mac v5: npm --prefix runtime test reported 365 passed, zero failures, one skip. cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1 reported 69 passed, zero failures and one ignored test. cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings passed. All three exit codes were 0; evidence: mac-native-v5.log. The skip is Windows credential integration; the ignored Rust case calls public Open-Meteo. Windows compaction/recovery checks passed 7/7, exit 0.

Packaging first stopped with exit 1 during pre-package verification: the directly created session in verify-harness-stage.mjs omitted required commonqueries metadata. It now uses openStore/commonQueryMetadata through mcpRequestMetadata. The related real MCP regression passed, exit 0. v6 was applied and packaging resumed. DMG and installed-product acceptance have not yet passed. Source remains main@7321135 plus uncommitted changes; no commit or push.

### v6: application generated; post-sign Keychain authentication pending

The pre-package service check passed with sourceDigest 532c35c9c7a0169135d387ff398fdb929af6a0bfc63675e53ce5ff9da6ab1d95, exercising native Shell, Office, MCP inventory and time/cache calls, and credential protection. Electron Forge generated ui/desktop/out/CodeBuddy-darwin-arm64/CodeBuddy.app; ad-hoc signing and initial codesign verification completed. Credential verification from the signed app triggered macOS Keychain authentication for codebuddy-credentials accessing local.codebuddy.credentials.v1. The 30-second timeout expired and native-package exited 1. User action was requested; passwords and ACLs were untouched. This does not establish an encryption-algorithm failure. Post-sign credential verification is pending; no DMG, installed smoke, or installed-product computer-control/MCP acceptance has completed. Evidence: mac-native-v6.log.


## 2026-10-19: native installer passed; desktop input under investigation

This section supersedes the historical blockers above. After Keychain authorization, v6 native-package, package-smoke and install-smoke each exited 0. Retrieved mac-native-v6.log, macos-install-2VVt43/result.json and artifacts.json confirm Apple Silicon 1.43.5 DMG/ZIP creation, DMG verification, read-only mounting, copy installation, codesign verification and installed-copy smoke. Source: main@732113504de3601ab087a609ce20827b814db2c2 plus dirty changes; sourceDigest=532c35c9c7a0169135d387ff398fdb929af6a0bfc63675e53ce5ff9da6ab1d95. Signing is ad-hoc; notarization has not run.

The installed copy is ui/desktop/out/macos-install-2VVt43/installed/CodeBuddy.app. The isolated fixture now launches through LaunchServices open -n -W. Screen Recording, Accessibility and Desktop access were granted for this batch with explicit user approval. installed-mcp-YMIJp8 receipts confirm actual ACP calls for time, cache inventory, PDF extraction and structured chart output. Window inventory, PNG capture and AXTextArea observation succeeded. Native foreground validation rejected click before dispatch; Unicode/emoji input and saving did not run. Real-model conversation, chart rendering and complete product E2E remain unverified.

Local evidence: .preview-evidence/mac-acceptance-20261016/received-20261019/. Remote archive: /Users/erjinyi/Desktop/work/mac-evidence-20261019.zip. The v6 DMG SHA256 is 5259849878c0b794e7ab02854f6b5185d87d2c7678e617122477ccb67771777e; this evidence does not validate a later rebuild.

Read-only Swift probes returned the actual foreground process using both async main and an AppKit run loop; isolating HOME alone also worked. Both commands exited 0. AX queries returned -25204 because Terminal lacks permission; its additional permission prompt was dismissed without granting access. runtime.swift now includes expected/actual PID and window details in foreground rejection errors, preserving input guards. The v8 diagnostic delta passed source precondition hashes and was applied on Mac. Native regression and rebuilding are in progress; the new installer has no acceptance result yet. No commit or push.
