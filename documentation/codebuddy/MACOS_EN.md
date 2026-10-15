# macOS development and verification

## Mac read-only audit and cancellation (stage28, 2026-10-07)

Implemented the approved audit/cancel stage. Mac returns executionAvailable=false; UI offers summary and cancellation. Windows returns true and legacy responses remain compatible. Existing root/session/run/sourceMessage/nonce and lifecycle checks retain authority. Receipts stay in memory; commit/cancel/revoke share lock ordering. Cancellation preserves the original deadline; expiry requests a new message and disables retries on the old prompt.

Windows Rust 85/85, native Mac Rust 35/35, UI on each platform 17/17 passed. Both Clippy commands, TypeScript, scoped ESLint and format checks exit 0; existing Mac warnings remain. Real Chrome production-component interactions passed for summary/cancel/expiry with isolated picker/ACP doubles. Two screenshot timeouts are not product failures. Native regressions used real temporary files.

Bundle28 rebuilds the backend and passes DMG validation, mount/copy/unmount, signatures and hashes. Installed ACP 11/11, model calls 0, including missing-authority audit/cancel rejection and five read-only route rejections. Successful audit is covered by native regressions; full visible Electron positive acceptance remains pending.

Five remaining cleanup routes stay disabled. Visible Mac flows, Intel/minimum macOS hardware and Developer ID notarization remain pending. ARM64 ad-hoc internal build. No new branch, commit or push. Historical sections retain their original status; this section and the table describe current status.

Local: `target/macos-release-20261007-bundle28/`

Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261007-bundle28/`

Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261007-bundle28/CodeBuddy.app`

- CodeBuddy.zip: SHA-256 `4be0986bd58408b0fc85891dcab3bfac01486023a8e79979ac7ede2cd76d273d`
- CodeBuddy-arm64.dmg: SHA-256 `b0257855e26ae08ef822699c681c08278ca262d54acd5c5221f3c754c44778a2`

Source: `00a6656df` + dirty. Build manifest: `0b148acbead0021a0d803c5121cfc4fca1f306e9343d111d04565cb0f6d40ec5`. Evidence: `target/macos-parity-20261007/cleanup28-state.json`; commands: `cleanup28-commands.json`.

[Details](MACOS_PARITY_EN.md)

## Worker force-stop wiring (stage25)

The user approved the concrete existing-owner proposal by replying “continue.” PID and `SessionProcessOwner` are registered atomically in `WorkerRegistry`; tracker and lifecycle consume the same reference. `SystemProcessGroupOwner` remains the OS owner. The force-stop snapshot closes new registrations; termination, runner cancellation and exit confirmation happen outside the lock. Confirmed records are removed individually; unconfirmed records survive runner drop for retries; stale generations and conflicting owners are rejected.

Windows 18/18 and Mac 19/19 checks passed; Clippy exited 0 on both platforms. bundle25 rebuilds the backend with stage24 shell cancellation/timeout and listener ownership fixes plus stage25 force-stop wiring. Actual DMG mount/copy/unmount, signature, installed-file hashes and 4 ACP startup handshake checks passed (zero model calls). This is an arm64 ad-hoc internal test package without notarization.

Local: `target/macos-release-20261005-bundle25/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle25/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle25/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9aa02168c6fb4260a480074e5e724e7d6c464e424b0db9bd8669085e536bf1bd`
- CodeBuddy-arm64.dmg: SHA-256 `1c1aa6357374559eb695e379ecdde5a9057dfcd35deacb2555a78a20cfaefccc`

 Coverage includes owner failure/retry, registration during cooperative grace, stale generations, and native Mac descendant exit, early parent exit and unrelated process survival. Full Electron acceptance remains NOT_RUN. Cleanup mutation, desktop acceptance scheduling, TCC/Keychain and Intel acceptance remain gaps; full parity is not established.


[繁體中文 (default)](MACOS_ZH_TW.md) · [简体中文](MACOS_ZH_CN.md)

## Stage 24: Windows entry-point audit and two repairs (2026-10-05)

The baseline is the current local Windows main worktree including dirty changes. See the [feature matrix and next proposal](MACOS_PARITY_EN.md).

- Mac foreground shell now uses the existing group owner and confirms same-group descendants stop on cancellation/timeout. Windows shell regressions **16/16** and native Mac shell regressions **24/24** passed. Two new native cases verify descendant exit, unrelated sibling survival, closed pipes and structured receipts.
- Mac managed services now use system lsof plus the retained owner to establish listener ownership. Native regressions **2/2** passed; one subprocess-only fixture is ignored by the outer runner and excluded from the pass count. A real temporary TCP listener validates matching/unrelated owners and post-stop state. Invalid output stays unknown; port ownership is not application readiness.
- Final Windows strict Clippy and Mac Clippy exited 0; final Mac Clippy retains 6 existing platform warnings. fmt and diff whitespace checks passed. A native probe exposed lsof's automatic f records; parsing was corrected before the formal tests passed. One accidentally overlapping Windows Clippy run was interrupted, retained and rerun serially.

**Full parity remains incomplete.** Worker force-stop owner wiring awaits proposal approval; Mac desktop acceptance scheduling is still disabled by platform logic; cleanup quarantine/restore/permanent deletion and visible Electron journeys remain pending. Deferred Keychain/TCC authentication was not retriggered.

These two source repairs are not packaged yet. Bundle23 remains the latest delivery and does not contain them. No branch, commit or push created. Commands, cwd, exits, counts and hashes: `target/macos-parity-20261005/parity24-state.json`.

## Stage 23: extension command argument repair (2026-10-05)

Fixed Mac/POSIX extension editing changing executable names and argv. Quoting spaces alone discarded empty arguments, interpreted dollar signs/quotes/backslashes, and split tabs/newlines. Literal arguments now match the existing parser while simple commands stay readable. Existing Windows path handling retains its regression coverage. No dependency, protocol or configuration format was added.

- Before repair: 4 new regressions failed and 39 tests passed. Final conversion/production edit-dialog tests passed **57/57** on Windows and native arm64 Mac. Both TypeScript checks exited 0.
- Real Chrome production edit dialog: edit description, save, reopen and cancel preserved the command and all six arguments. Storage and ACP config methods were isolated fixtures; no user extensions changed. Console errors: 0; existing missing DialogContent description warnings: 2.
- Native Mac subprocess checks **2/2**: executable/script paths containing Chinese, apostrophes, dollar signs and backslashes started successfully, and child argv preserved empty strings, quotes, wildcards, tabs and newlines. This is not actual MCP extension or full Electron acceptance.
- The initial quoting helper/parser wildcard mismatch, incomplete test doubles/timeouts and unsupported test query type were corrected. Failure logs remain available; final checks passed.

bundle23 was generated and passed actual DMG mount/copy/unmount, signature, installed-file hash and ACP startup handshake checks (4 checks, zero model calls). The backend was rebuilt from current source. Full Electron acceptance remains NOT_RUN. This is an arm64 ad-hoc internal test package without notarization.

Local: `target/macos-release-20261005-bundle23/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle23/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle23/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `542b79a2cdfc0e852d9b9ebfe13854acf71b7651430d6077f7ca64a74ff04233`
- CodeBuddy-arm64.dmg: SHA-256 `14356dc2d423613de3c7402f2e638681741204e94a4bd3077429959d4dd326d3`

 Full parity remains incomplete: cleanup quarantine/restore/permanent deletion, full Electron/keychain/TCC, Intel and minimum-OS hardware acceptance are outstanding. Source is main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` plus the existing merge and dirty changes. No branch, commit or push was created.

Files: `ui/desktop/src/components/settings/extensions/utils.ts`, adjacent `utils.test.ts`, and `modal/ExtensionModal.test.tsx`. Commands, working directories, exits and evidence: `target/macos-parity-20261005/extension23-state.json`.

## Latest development: 2026-10-05 stage 22 (not packaged)

Mac cleanup work now shares the existing Windows allowlist, project boundaries and summary structure. New internal Mac read-only inspection covers regular files/empty directories, content hashes, link rejection, file/parent replacement, project overlap and denied reads. See the [cleanup adaptation design](MACOS_CLEANUP_DESIGN_EN.md) for files and remaining gates.

- Relevant Windows Rust regressions **72/72**; native arm64 Mac regressions **22/22**, including **8 new cleanup cases**. All exited 0.
- Windows strict Clippy, Mac release Clippy and Mac fmt exited 0. The 7 Mac Clippy warnings are in shell/state store/process tree/secure_fs modules unchanged in this stage.
- Existing isolated UI/ACP baseline **9/9** is not Mac product cleanup acceptance. The first Mac test command accidentally selected debug; it was interrupted and rerun with the established release profile. That interruption is preserved and is not a test result. No dependencies were added or caches cleared.
- The read-only module is not connected to Mac cleanup RPC/UI. Quarantine, restore and permanent deletion remain unfinished; full Electron/permissions/keychain, Intel and minimum-OS acceptance remain NOT_RUN. Full feature parity has not been achieved.
- The pathname replacement experiment confirmed that ordinary rename can move a substituted file. Bounded FSRef experiments do not establish the exact-object safety contract. Establish the native object-operation design before implementing cleanup mutations and durable recovery; the contract remains unchanged.

No new installer was created in this stage; bundle21 below remains the latest delivered package. Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` plus the existing pending merge and dirty changes. No branch, commit or push was created. Commands, working directories, exit codes, source hashes and outstanding work: `target/macos-parity-20261005/cleanup22-state.json`.

## Historical delivery: 2026-10-05 bundle21 (Apple Silicon internal test build)

Fixed the Mac computer-control `set_value` mismatch: when Go omits an empty text field, the native layer now treats it as an empty string so text controls can be cleared. Numeric controls still require finite numbers; empty values do not become zero. Existing window/element binding, writable-attribute checks and TCC gates remain in place.

- Local packaging/development-entry regression: **27/27**, exit 0.
- Native Go/Swift helper builds, existing contracts and **11 new** set_value checks passed on the arm64 Mac, exit 0. Go tests used a valid cache. Added checks cover omitted/explicit empty text, Unicode/whitespace, finite numbers/zero and invalid-number rejection.
- DMG/ZIP packaging, actual mount/copy into a separate installation/unmount, signature and installed backend/helper hash verification passed. The new Swift helper differs from bundle20; installed app.asar matches package output. Local and remote artifact sizes and SHA-256 digests match.
- Reuses the verified bundle18 backend; Rust and frontend were unchanged. Historical ACP/UI results are not counted again. The existing macOS 14 activation deprecation warning remains and did not block compilation.
- Source upload was initially rejected by automatic approval review. The user replied “continue” to the exact host/directory/three-file authorization question; the transfer then completed.

**Clearing an actual text control and full Electron acceptance remain NOT_RUN.** The installed helper's read-only doctor reports Accessibility=false and ScreenRecording=false under SSH; this does not establish permission state when launched by Electron. New Electron was not launched, preserving deferred keychain authentication. Cleanup quarantine/restore/permanent deletion, complete desktop flows, Intel and minimum-supported macOS hardware acceptance remain pending. Full parity is incomplete. This is an ad-hoc internal test build without notarization.

Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` + existing pending merge and dirty changes; 3,251 build-source entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands, cwd, exits and logs: `evidence/commands.json`.

Local: `target/macos-release-20261005-bundle21/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle21/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle21/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `26aca3ac3c406c50784afbec290f159113ead598ed3c88f3fe63a515c9f654b4`
- CodeBuddy-arm64.dmg: SHA-256 `b1902fa408316c403489d81ba5b27f1a914edeca9997896046ba6f6179b59900`

## Historical delivery: 2026-10-04 bundle20 (Apple Silicon internal candidate)

Fixed Mac shortcut recording mapping Control to Command and dropping Control when both are pressed. ShortcutRecorder now records the modifiers separately while retaining the existing settings format and Windows behavior, preventing false conflicts with Command shortcuts.

- Before: **5 failed / 5 passed**. After: **29/29** related component tests on Windows and a real Mac; TypeScript exited 0 on both. Regression coverage includes separate/combined modifiers, Option characters, Windows behavior, cancel and preservation of other shortcuts through the production settings page. An initial type check caught an unsupported query option in the new test; corrected checks passed and original logs are retained.
- Real Chrome keyboard interactions passed: Control+K and Control+Command+K save independently while Command+K remains enabled; real Command conflicts still warn, and cancelling reassignment/editing preserves settings. Zero console errors/warnings. Production components used a darwin platform marker and isolated settings/dialog boundaries; **native Mac global shortcut activation was not tested**.
- DMG/ZIP copied to Windows and the remote desktop. Actual DMG verification, mount/copy/unmount, installed signature/backend version, matching app.asar and package SHA-256 checks passed.
- Frontend-only change reuses the verified bundle18 backend with identical raw/signed hashes. Rust/model ACP were not rerun or counted. Existing settings are not migrated; previously misrecorded combinations need to be recorded again.

Reference: [Electron keyboard shortcut documentation](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts): CommandOrControl maps to Command on Mac; Control remains distinct.

**Full parity remains incomplete.** Deferred keychain authentication, visible Electron/system shortcut acceptance, cleanup quarantine/restore/permanent deletion, computer-control permissions, Intel and minimum-supported macOS hardware remain pending. This arm64 ad-hoc internal build is not notarized.

Source: main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53 + pending merge and dirty changes; 3,251 entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: evidence/commands.json.

Local: target/macos-release-20261004-bundle20/. Remote: /Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle20/. Installed: /Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle20/CodeBuddy.app.

- CodeBuddy.zip: SHA-256 2aacb636df7d57cfcf95c67c00408cafa25cc3d7ae141ad9c1cc84d0885d76d5
- CodeBuddy-arm64.dmg: SHA-256 0bb3f9341124b4c91f11ed1523ae682cf429630d3ed4e0510bdb8b24ff76fb87

## Historical delivery: 2026-10-04 bundle19 (Apple Silicon internal candidate)

Fixed legacy workspace reconfirmation rejecting valid Mac directories. CodeProWorkspaceReconfirmation converted all paths to lowercase Windows separators; it now uses the existing normalizeWorkspaceIdentity, matching the file inspector. POSIX case, Chinese names, spaces and parentheses are retained. Different identities and missing directories remain rejected; confirmation requires an explicit action.

- Before: 2 Mac regressions failed, 6 passed. After: Windows **102/102** relevant tests and **8/8** final component tests; Mac **99 passed, 3 Windows-only cases skipped**. TypeScript exited 0 on both platforms.
- Manual API verification in a real Mac temporary directory: **5/5**, covering canonical identity, existing directory confirmation, case-distinct identity rejection, missing inspection without creation and unchanged files. Component tests also invoke the production file inspector.
- Controlled Chrome interactions passed: original path, explicit confirmation, mismatch/missing rejection, retry and cancel; zero console errors/warnings. Production components consumed captured native Mac inspections with a fixture callback, not the full ACP/Electron flow.
- New DMG/ZIP copied to Windows and the remote desktop. Actual DMG verification, mount/install/unmount, signature, installed backend version and matching app.asar hashes passed.
- This frontend-only slice reuses the bundle18 backend with identical raw/signed hashes. Rust and the prior 17 model ACP checks were not rerun or counted as current tests.

**Full Windows parity remains incomplete.** Deferred keychain authentication and visible Electron acceptance remain NOT_RUN. Cleanup quarantine/restore/permanent deletion, computer-control permissions, Intel and minimum-supported macOS hardware remain pending. This arm64 internal build uses ad-hoc signing without Developer ID notarization.

Source: main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53 + pending merge and dirty changes; 3,250 entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: evidence/commands.json.

Local: target/macos-release-20261004-bundle19/. Remote: /Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle19/. Installed: /Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle19/CodeBuddy.app.

- CodeBuddy.zip: SHA-256 70ffd920a8a2238f20380a0e24aa3ba6eaee564c49dc87f5c0fb75038b93dad1
- CodeBuddy-arm64.dmg: SHA-256 22b30331f300f8cf50a1257a30f6a5f817570e9ab90dbba01d4846f769305228

## Historical delivery: 2026-10-04 bundle18 (Apple Silicon internal test candidate)

Added Refresh project confirmation and the approved ACP method `_goose/unstable/workspace/confirmation/v1/refresh`, negotiated with `workspaceConfirmationRefresh: 1`. The host validates the original session/run/source message, durable control plane and persisted waiting notification. Duplicate refreshes reuse a valid token. Allocated leases, bound/closed/archived sessions, terminal runs and mismatched identities are rejected. Refresh makes no provider call, creates no directory, binds no lease and executes no task. Explicit path confirmation is still required before allocation, binding and structured continuation of the original task. Completed Traditional/Simplified Chinese labels for this card.

- Windows Rust **114/114**, strict Clippy exit 0; native Mac Rust **39/39**, Clippy exit 0. Frontend tests **43/43** on each platform; TypeScript exit 0.
- Real Chrome controlled component acceptance passed: expired failure, refresh, wait for explicit confirmation, allocate/bind with fresh token and continue the original task; old backends show an upgrade notice without RPC. Directory selection and ACP transport are fixtures, not Mac desktop E2E. Console is clear after fixing the fixture favicon 404.
- New Release and actual DMG installed backends each passed native ACP **17/17**, including restart refresh through the new method, original run/message identity, concurrent idempotency, no project writes during refresh, forged/bound rejection, permission retry, exact child allocation, real model file writes and restart recovery.
- DMG/ZIP generation, actual DMG verification/mount/copy/unmount, installed signature and backend hashes passed. **The new Electron app was not launched; deferred keychain authentication and full visible desktop acceptance remain outstanding.**

Full parity remains incomplete: cleanup quarantine/restore/permanent deletion, computer-control permissions, Intel and minimum supported OS hardware remain outstanding. This arm64 package is ad-hoc signed, without Developer ID notarization.

Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` + pending merge and dirty changes; 3,250 source entries verified. No branch/commit/push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: `evidence/commands.json`.

Local: `target/macos-release-20261004-bundle18/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle18/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle18/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `c0df12aa750de29c7f35184ae6fada3183e072b0c3ad57cddfdfafd29c319dfe`
- CodeBuddy-arm64.dmg: SHA-256 `9dc13110a59716dc14fccf610020818048a6e41ad249c157b2c61ab0e22c9512`

## Historical delivery: 2026-10-04 bundle17 (Apple Silicon internal test candidate)

Fixed Mac project creation consuming its confirmation after a directory permission denial. A confirmed failure before creation now retains the token and returns the existing `workspace_permission_denied / retryable / capabilityPreserved` contract. Failures after creation still trigger rollback and token consumption. ACP retains authorization and lifecycle ownership; the UI reuses its existing confirmation card.

- Reproduced on the real Mac before the fix: a read-only fixture returned `OSErr -5000`; restoring permissions and retrying the same confirmation then failed because its token had been consumed. See `evidence/baseline-permission-error.json`.
- Windows Rust **112/112** and strict Clippy (`-D warnings`, exit 0); native Mac Rust **37/37** and Clippy (exit 0). Related frontend tests **39/39** on each platform; both TypeScript checks exit 0. Regressions cover read/write denial, forged tokens, retry with the original confirmation, rollback after creation, and continuation only after successful binding. The first frontend test fixture lacked persisted message identity; its failure log is retained and the corrected fixture passes.
- New Release native ACP **12/12**: permission denial and same-token retry, exact child allocation, restricted parent, idempotency, empty-child rollback, prebinding restart and stale-token rejection, renewed confirmation through the existing structured control request with original run/message identity asserted, same-session binding, real model file writing using the original control request, bound restart, and file preservation after session deletion. See `evidence/project-container-permission-acp-result.json`.
- The older bundle16 script passed its 10 directory-flow assertions, but a subsequent identity audit found that resending the natural-language request created a different run. That result is **not acceptance of original-run recovery**. The new probe asserts original run/message identity using the existing structured continuation protocol; the visible UI entry for refreshing an expired confirmation card still needs implementation/acceptance. Previous parsed model logs contain thinking-only responses without final text and a separate timeout. The original raw HTTP streams were not saved, so their root cause remains unresolved; the raw endpoint returned JSON in this run. Parsing and timeout limits were not relaxed, and reasoning was not treated as a decision. Historical model reliability failures remain recorded.
- The installed backend also passed the same ACP **12/12** (`evidence/installed-project-container-permission-acp-result.json`). Backend build, DMG/ZIP packaging, actual DMG mount/copy/unmount, installed signature and backend hash verification passed. **The new Electron app was not launched. Deferred keychain authentication and full visible desktop acceptance remain outstanding.**

Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` + pending merge and dirty changes; 3,249 source entries verified. No branch, commit or push was created. UI 1.43.2 / backend 1.43.0. Commands, cwd, exits and logs: `evidence/commands.json`.

Backend SHA-256: `eeb898a355dc95f367834a0c811bb9bc1b52a34e72baef9bfd6d289f8283f02d`; packaged backend: `212bb77059800a308bd62a5783bd924f6f7011f67504bb809ce452bad91f347b`.

Local: `target/macos-release-20261004-bundle17/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle17/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle17/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `e2f7fbbb5ed64b2b7aa446724de1096483286589abc1beb3ca0ec85d568eb6ed`
- CodeBuddy-arm64.dmg: SHA-256 `29f6de32a30930bd8152a43e581c5011cd6c77e6bb29d4830edfef992c8d4cb9`

**Full parity is still incomplete**: cleanup quarantine/restore/permanent deletion, visible desktop flows, computer-control permissions, Intel and minimum supported OS hardware remain outstanding. This arm64 package is ad-hoc signed and has no Developer ID notarization.

## Historical delivery: 2026-10-03 bundle16 (Apple Silicon internal test candidate)

The Mac project-parent flow is implemented. The existing directory picker selects a parent; the card displays the exact child path and creates it only after explicit confirmation. The original session then binds to that child. The parent grants no generic project-tool write access. Name collisions fail without automatic renaming.

- Backend: added persisted `project_container`, `projectContainers: 1` negotiation and a versioned allocation endpoint. Mac creates a direct child relative to a held parent fd, reusing tokens, leases, ownership checks and rollback. Restart preserves the parent record but invalidates creation tokens, requiring fresh confirmation. The Windows container flow is preserved.
- UI: connected the confirmation card, upgrade notice, session metadata, permission summary and workspace panel. The parent is not opened as a writable workspace before child binding. Success resumes the original message and run.
- Windows Rust **112/112**, including activation boundaries, empty workspace-resume control prompts and original-message restoration; strict Clippy (`-D warnings`) exit 0. Native Mac Rust **34/34**, including concurrent confirmation and workspace continuation; Clippy exit 0 with 9 existing platform warnings. Frontend **89/89 on each platform**, TypeScript exit 0 on both.
- Controlled Chrome interaction passed: selection without creation, explicit confirmation/original-task continuation, older-backend upgrade notice and cancellation without creation. Production components and flow functions were used with mocked Electron picker and ACP transport; this is not native Electron E2E. The browser check exposed a generic error masking the upgrade notice; a typed error and regression now preserve it.
- Fresh Release backend first-confirmation native ACP **8/8**: token validation, exact child allocation, parent tool denial, idempotent confirmation, same-session binding, original empty-control-prompt continuation with a real model write to `acceptance.txt`, bound-project restart restoration, and session deletion preserving files. Evidence: `evidence/project-container-fresh-acp-result.json`; fixture outside the repository with a Chinese path.
- The first native ACP run found idle maintenance incorrectly treated as an active prompt, rejecting confirmation. Allocation now drains the existing session access barrier before reading current state. Regression coverage checks waiting and preservation of concurrent metadata. Tests, Clippy, build and strict ACP acceptance were rerun; downstream diagnosis also found the shared ACP converter rejected the existing empty workspace-resume control prompt. Only that validated CodePro control request may be empty; the Agent still restores the source message. An intermediate 33-pass/1-fail run exposed missing access initialization in the isolated fixture; matching session/new initialization restored a full 34/34 pass. Initial failures, interrupted compilation and pre-fix diagnostic results remain separate evidence.
- **Prebinding restart/reconfirmation: full acceptance NOT PASSED.** Both strict runs completed 6/10 checks, including empty-child rollback and stale-token rejection. Shared recovery-relation handling then encountered invalid model JSON and, on the next run, a model timeout; no subsequent task ran. Evidence: `project-container-acp-16-model-relation-error.log`, `project-container-acp-16-model-timeout.log`, and `project-container-acp-result.json`. The first-confirmation test above is a separate scenario and does not close this gate.
- bundle16 packaging exit 0. Actual DMG mount/copy/unmount, installed signature, backend version and hash verification passed. The existing keychain authentication state was preserved at the user's request. **bundle16 Electron was not launched; complete visible desktop E2E is NOT_RUN.**
- Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`, existing merge content and dirty changes; 3,249 source entries verified. No new branch, commit or push; the merge commit remains pending. Product UI 1.43.2/backend 1.43.0. Source backend SHA-256 `3bcf7d4de4aafb52ab1ec9239a901df3fa165b0efee54241d9a03a759fb38366`; signed packaged backend SHA-256 `c107d1f7cde1fda925f5e176b944726008d7ccec251720a66d3859399b947399`.

Delivery: local `target/macos-release-20261003-bundle16/`; remote desktop `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle16/`; installed `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle16/CodeBuddy.app`. Exact commands, working directories, exit codes and logs are indexed in `evidence/commands.json`. `BUILD_SOURCE_STATE.json` is the build snapshot; subsequent documentation synchronization is verified separately.

- DMG SHA-256: `8e78723df49b0b225b42575a223dfe54b3e775481c2c14ff46cd33e5d0ea1815`
- ZIP SHA-256: `dc517f76537b13cfe1e1c84f95af992430b006c179f43db52b70de893bd4874f`

Pending visible desktop acceptance: after resolving the existing authentication prompt, launch bundle16. In an unbound session request a new project and `acceptance.txt`, choose a test parent with Chinese characters and spaces, and verify the exact child path. Cancel first and verify no directory was created; submit again and confirm, then check the original session completes the file write. Restart should restore the child workspace and file, without granting the parent project write authority. This procedure has not been executed.

**Full parity is not complete:** cleanup quarantine/restore/permanent deletion, full desktop workflow, computer-control permission acceptance, Intel hardware and minimum-supported macOS hardware remain pending. This arm64 build is ad-hoc signed and not Developer ID notarized.

## Historical delivery: 2026-10-03 bundle15 (Apple Silicon internal test build)

Added read-only disk capacity queries for Mac root containers, reusing the existing `codepro.root_disk_usage` host result and session persistence. The query grants no workspace write access. Mac validates the filesystem root and directory identity before reading OS statistics through the existing fs2 dependency. Windows implementation and public protocol are unchanged.

- Files: `workspace_lease.rs` and `workspace_lease/lifecycle.rs` share the capacity type; `workspace_lease_macos.rs` adds native reads; `agent.rs` enables the Mac branch and persistence regression; `workspace_lease/macos_tests.rs` checks real capacity and rejects non-roots, relative paths and symlinks.
- Windows: **100/100** relevant backend tests; strict Clippy (`-D warnings`) exit 0. Mac: **16/16** native Rust tests; Clippy exit 0 with 9 existing platform warnings. Formatting passed. The first Mac test compile hit E0603 from a new test accessing a private function; removing that cross-module assertion fixed the test without widening API visibility.
- Fresh native backend ACP acceptance: **3/3** checks passed, covering a root session without a write lease, host capacity matching native filesystem statistics, and replay of the same structured result after restart. Capacity: `494384795648` bytes; available at query time: `254468087808` bytes, which varies with system use. Evidence: `evidence/root-disk-acp-result.json`. This tests the desktop-mode backend, not visible Electron E2E.
- Release backend and bundle15 packaging exited 0. The actual DMG was mounted, copied into a separate installation, then unmounted. Installed signature, backend `--version` and binary hash checks passed. bundle15 Electron was not launched; the existing keychain prompt remains intact at the user's request. Full desktop acceptance remains pending.
- Source: existing main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`, existing merge content and dirty changes; 3,248 build source entries verified. No new branch, commit or push in this phase; the merge commit remains unfinished. Product UI 1.43.2 / backend 1.43.0. New source backend SHA-256: `412e8f1ef395c9fafb3f21b948cad6288b6bd7efddffc4a4cbaba79b5e2c1068`; signed packaged backend: `a84b4e82ebb4d9e774f8a109dfcfd46dcf40c3b80e26ed8793b3305f30d47e08`. Frontend source is unchanged; bundle14 frontend tests remain evidence from the previous phase.

Delivery: local `target/macos-release-20261003-bundle15/`; remote desktop `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle15/`; installed app `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle15/CodeBuddy.app`. Commands, exit codes, raw logs and installation results are in `evidence/`. `BUILD_SOURCE_STATE.json` preserves the build snapshot; later documentation synchronization has a separate source verification record.

- DMG SHA-256: `386a3f9d5cfdc11ae270557141f9a90ae36fe57397ff581a44fa4335157a32b5`
- ZIP SHA-256: `2e09a01a64afe9cd764c70c7374bae47f3ea7d0b2e2af24ddd6e034d0f57149d`

**Full parity is unfinished**: the new project-container design awaits approval; cleanup quarantine/restore/permanent deletion, full desktop flows and Intel hardware remain implementation or acceptance gaps. This arm64 internal build uses ad-hoc signing without notarization. A read-only computer diagnostic reported Accessibility/ScreenRecording=false in the SSH context using the unchanged bundle14 helper; this does not establish Electron permissions or desktop-control acceptance.

## Approved design: Mac project containers (2026-10-03)

The test Mac mounts `/` as `apfs, sealed, read-only`. `NeedsWorkspaceInline` currently accepts only filesystem roots, and `load_session` permits a root container to bind only a direct child. Porting the Windows allocation handler alone would therefore not enable project creation on the usual Mac system volume. [Apple signed system volume documentation](https://support.apple.com/guide/security/signed-system-volume-security-secd698747c9/web).

Proposed behavior: introduce a distinct `project_container` binding. The user selects a writable local parent through the existing directory picker and confirms the proposed child before creation. The parent never gains project-tool write authority. On success, the existing session binds only the newly created direct child, preserving the original message, run and continuation.

Reuse host-owned leases, nonces, single consumption, ownership checks and rollback. The frontend submits confirmation data; the host validates canonical paths, held directory objects and direct-child relationships. After restart, the stored container alone grants no creation authority: a new confirmation and token are required. Cleanup authority remains separate.

Keep existing `root_container` and `writable_project` records unchanged. Negotiate the new capability; older clients/backends retain their existing flow, and unsupported new states require an upgrade instead of silently granting writable-project access. Do not silently select the home directory or change system-volume settings.

Acceptance covers existing Windows/Mac workspace regressions and real Mac temporary-directory cases: Unicode names, collisions, replacements/symlinks, token reuse, rollback, confirmation after restart and continuation in the same session. The final gate is the visible picker/confirmation flow. The user requested continuation after the proposal required by root AGENTS.md. Implementation and verification are now in progress; see the current status above.

## Historical delivery: 2026-10-03 bundle14 (Apple Silicon internal test build)

With keychain authentication deferred by the user, this round fixed workspace path handling and completed checks that do not require desktop authentication.

- POSIX absolute paths in prompts now enter the existing workspace confirmation flow. Quoted Unicode names, spaces and trailing punctuation are preserved, along with case and multiple-candidate selection. URLs and relative paths are not mistaken for Windows drive paths. Extracting a candidate does not authorize writes.
- Selected and confirmed paths retain legal trailing punctuation. Real-directory tests on both platforms verify that inspection and confirmation preserve the original files.
- Windows: 77/77 workspace tests and 24/24 file-panel, terminal configuration and confirmation-card tests. Mac: 74 passed with 3 existing Windows-only cases skipped, plus 24/24 panel tests. TypeScript exited 0 on both platforms.
- The new DMG was copied to a separate installation. After detaching the image, signature verification and backend `--version` exited 0. This verifies installation structure; bundle14 Electron installation smoke and full visible desktop E2E are **NOT_RUN**. Bundle13 remains at the Safe Storage keychain prompt, as requested by the user.
- Source: existing main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`, merge contents and uncommitted changes. No branch, commit or push was created this round. All 3,248 source entries matched before packaging. Only the frontend changed; the previously verified bundle13 backend 1.43.0 is reused, with UI version 1.43.2.
- The initial local pnpm wrapper unexpectedly reconfigured dependencies and regenerated the SDK; those commands were stopped. Logs show zero downloads, and lockfile, workspace configuration and generated SDK hashes match the prior manifest. Subsequent checks invoked existing Node 24, Vitest and TypeScript directly. No dependencies were added. The first regression exposed URL misclassification; the results above are from the corrected run.

Delivery: local `target/macos-release-20261003-bundle14/`; remote Desktop `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle14/`; remote installation `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle14/CodeBuddy.app`. Commands, exit codes and results are in delivery `evidence/`; original Mac logs are in `target/macos-parity-20261003/`.

- DMG SHA-256: `8ca5870bf771aaea497b02f4ff34a3491ebb6de1426f374732cde6865b6628ec`
- ZIP SHA-256: `d3f877818a966b3affe2d2d03f9ceaf20a8353826404827dcd2730df6e45d9e7`

Outstanding: root-container allocation, cleanup quarantine/restore/permanent deletion, full desktop acceptance and Intel hardware. This build uses ad-hoc signing and is not notarized. Earlier results follow as history.

## Historical delivery: 2026-10-02 bundle13 (Apple Silicon internal test build)

Product 1.43.2 now includes a newly compiled backend 1.43.0. Both DMG and ZIP hashes match on the Windows host and remote Mac. Development changes and the existing merge remain uncommitted and unpushed.

- Source: local main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`, merged content and dirty changes. The remote build copy retains its original detached HEAD. All 3,248 manifest files/links passed verification before building.
- Windows: 100 backend and 65 frontend tests passed; TypeScript and strict Clippy exited 0.
- Mac: 14 native Rust tests passed; 62 frontend tests passed, with 3 existing Windows-only cases skipped. TypeScript exited 0. Mac Clippy exited 0 with 9 existing platform warnings.
- Native desktop backend: 9 checks passed using the actual `serve --platform desktop` entry point and a temporary workspace outside the source repository. They cover model file creation, normal task completion, binding recovery after process restart, rejection of replaced directories, and preservation of project files after session deletion. Evidence: `evidence/desktop-acp-result.json`.
- Installation: DMG verification, installation followed by unmounting, signature verification, and installed-copy file/PTY/embedded-browser smoke tests passed. These are controlled installation/API checks. The remote screen remains locked; complete visible desktop E2E is NOT_RUN.
- Probe correction: the initial CLI stdio probe lacked the desktop evidence-persistence configuration and timed out. During its second attempt, the model unexpectedly created a branch/commit for the fixture inside the source repository. The probe was stopped, only its Git changes were reverted, and all source files were verified again. The 9 passing checks were obtained after correcting both entry point and fixture isolation. The first two attempts are not desktop product passes.

Local delivery: `target/macos-release-20261002-bundle13/`. Remote desktop: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261002-bundle13/`. A separate copy is installed at `/Users/erjinyi/Applications/CodeBuddy-Test-20261002-bundle13/CodeBuddy.app`, ready for visible acceptance after unlocking.

- DMG SHA-256: `82ddd98f70e8684e0e41780300e185de25c998901647d65755dd83ddfd9d2058`
- ZIP SHA-256: `d07b65d7341daefe28d3ae5a46d39bb182a5d1f578fbd1c3b90d493a0c3c856a`

**Full parity remains incomplete:** root-container allocation and cleanup quarantine/restore/permanent deletion still need implementation. Intel, minimum-supported-macOS hardware, and full visible desktop acceptance remain unverified. This build is ad-hoc signed without Developer ID notarization. Implementation details and older checkpoints follow.

## Current core adaptation: 2026-10-02 (implementation and verification in progress)

The user approved the proposed Mac descriptor adapter. Source remains main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`, the existing merge and uncommitted changes. Windows NT filesystem operations retain their implementation.

- Lease tokens, pending/session registries, access barriers and recovery share `acp/server/workspace_lease/lifecycle.rs`. Authority ownership and persistence protocols are unchanged.
- The Mac adapter uses existing libc APIs: descriptor-relative `openat/O_NOFOLLOW`, device/inode checks with `fstatat`, and `F_GETPATH`. Every directory binding is validated on acquisition and use. POSIX descriptors do not prevent other processes renaming entries; this is not equivalent to Windows exclusive handles.
- ACP acquire/release, creation, resume, close, delete, archive and context maintenance use the shared lifecycle on Mac. Resource attachments reject symlinks, multiple hard links, workspace escapes and contents exceeding 2 MiB.
- Session creation previously requested leases only on Windows and always validated returned paths using Windows normalization. It now includes darwin and shares case-preserving POSIX identity normalization.
- Related frontend regressions: Windows 65 passed; Mac 62 passed and 3 existing Windows-only cases skipped. Both TypeScript checks exited 0. Mac native Rust regressions: 14 passed, exit 0, including ACP dispatch, archive/delete and persisted-binding resume.

Empty-directory rollback retains the FSRef returned atomically by FSCreateDirectoryUnicode and passes that reference to FSDeleteObject. It does not reconstruct the reference from a stale descriptor path during rollback. Native test round 4 passed 12 cases and failed 1: APFS retained the old path and a nonzero link count on an unlinked directory descriptor, invalidating the original deletion check. The fix adds an empty-replacement preservation case; round 5 passed all 14 cases (exit 0). Nonempty directories are preserved, and failed rollback retains the pending lease. FSRef is deprecated and carries documented APFS 32/64-bit inode compatibility overhead. No dependencies were added. Root-container allocation and cleanup quarantine/restore/permanent deletion remain incomplete. The remote desktop is locked, and desktop E2E has not run. Bundle12 lacks the core changes; see the latest delivery section above for the subsequent bundle13 build.

Windows backend regressions: 100 passed; strict Clippy (`-D warnings`) passed. Both exited 0. References: [Apple FSRef](https://developer.apple.com/documentation/coreservices/fsref), [node-pty thread directory API usage](https://github.com/microsoft/node-pty/blob/main/src/unix/pty.cc).

Exact commands are in the [Traditional Chinese record](MACOS_ZH_TW.md). Remote evidence: `target/macos-parity-20261002/lease-tests-*.log`, `workspace-ui-tests.log`, `workspace-typecheck.log`.

## Earlier bundle12: 2026-10-02 (before core adaptation)

bundle-arm64-12 was built and passed DMG installation smoke. Product version is 1.43.2; the same verified Release backend retains version 1.43.0. Source remains main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53, the existing merged content and dirty changes. No branch, commit or push was created.

- Fixed the browser shortcut when macOS Option+B changes the key character: physical KeyB is recognized while retaining Windows behavior.
- File search, browser and save hints now show Mac Command/Option, reusing the settings shortcut formatter. Ctrl+backquote remains the terminal entry.
- Added Command+S draft-save coverage and prevented modified shortcuts or IME composition from being claimed as ordinary save actions. English, Simplified Chinese and Traditional Chinese hints are synchronized.
- Panel component tests passed 11/11 on each platform; TypeScript exited 0 on both, and translation compilation exited 0. Native Mac packaging and installation smoke exited 0. Evidence: target/macos-parity-20261002/ and ui/desktop/out/macos-install-XFuq3q/.

| User flow | Current evidence and remaining gap |
| --- | --- |
| Model initialization | qwen3.8-flash-next remains configured in the bundle11 main UI |
| Panel controls and directory menu | Actual bundle11 Electron renderer clicks passed; the remote desktop is locked, so the complete visible flow awaits unlocking |
| Create CodePro workspace | Packaged backend lease/acquire returned -32601 Method not found; the existing lease handler is not registered on Mac |
| CodePro writes, cleanup and recovery | Core workspace adaptation awaits design approval and remains incomplete |
| Files, PTY and embedded browser | bundle12 installation smoke passed; use within a complete task awaits the workspace path |
| New Mac shortcuts | Component regressions passed; actual desktop acceptance of the new package awaits unlocking |

Root AGENTS.md requires separate approval for core permission abstractions. A proposal to retain existing protocols/state machines and add Mac fd operations was sent to the user; implementation awaits approval. Full Windows/Mac parity remains incomplete. bundle12 is an ad-hoc internal test build, without notarization. The user-facing installed app still runs bundle11; it has not been replaced while the desktop is locked.

Artifacts / 安装包：`target/macos-release-20261002/`；remote / 遠端：`/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261002/`。

- DMG SHA-256: `105fc338c9477ef9374e7922805f24d706831d0c2a2048f267a3f5ed6e3f0835`
- ZIP SHA-256: `5ed9203ecfcca5c55464bb47d6ce3bfd8ec2f9746ab887c082de47909df339fc`


## Previous delivery: 2026-10-01 19:14

CodeBuddy 1.43.2 Apple Silicon internal test installers are built; the backend retains source version 1.43.0. Native Release compilation, bundle-arm64-11, DMG installation and installed-app smoke exited 0. Full Windows/Mac feature parity is not accepted. Earlier dated entries below are historical snapshots.

Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`, integrated `b8c6eb06c77281aa0a7ed1633b40cc861f2389af` and dirty changes. Zero merge conflicts remain. The merge commit awaits valid author details; nothing was pushed.

- Local delivery: `target/macos-release-20261001/CodeBuddy-arm64.dmg`, `CodeBuddy.zip`, hash manifests and acceptance evidence.
- Remote desktop: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261001/`.
- Remote installation: `/Users/erjinyi/Applications/CodeBuddy-Test-20261001-4nejwg57/CodeBuddy.app`.
- DMG SHA-256: `3f9156719a552bab618aeda7ef7d79a7ee9a39aefae00ce21b94363812fdde60`.
- ZIP SHA-256: `c2f698f005990391f8b6147f3702ea06c77b0fd768df3ca4a77223c05bea100e`.

Packaging fixes stage native node-pty and compilation headers, sign after Forge finishes, and declare local-network usage. Existing @electron/osx-sign is reused. Packaged hashes are updated after signing while pre-signing hashes remain recorded. `codesign --verify --deep --strict` and `hdiutil verify` exited 0. Signing is ad-hoc; Developer ID signing, notarization, Intel packaging and the Gatekeeper user flow remain unverified.

After copying from the DMG and detaching it, the installed Electron app passed Chinese file listing/read/write/search, native PTY cwd and actual 32×110 size, Unicode output and a WebContentsView local HTTP page. Packaging regressions passed 27/27 and workspace/layout regressions passed 27/27 in separate batches. Remote evidence: `out/macos-install-Bh86fE/` and `out/macos-smoke-arm64-GTNFNJ/`, relative to ui/desktop. Local evidence: `target/macos-release-20261001/evidence/`.

The installed app was launched through macOS LaunchServices. Desktop-folder and local-network access were allowed as requested by the user; the network prompt displayed “Electron”. Retrying bundle-arm64-10 reached the main UI with qwen3.8-flash-next: model initialization passed and OS error 65 cleared. Evidence: `target/macos-ui-final-uHcPDk/after-local-network-permission.png`.

Actual UI testing exposed the titlebar drag region covering workspace-panel controls. The expanded panel and collapsed entry now sit below the 32px drag region. Panel component tests passed 8/8 on Windows and 8/8 on Mac; TypeScript checks exited 0 on both. bundle-arm64-11 reuses the same verified Release backend; packaging and DMG installation smoke exited 0 (`out/macos-install-2bsGs8/`). The new app currently awaits personal authentication in the “CodeBuddy Safe Storage” login-keychain dialog. Real panel clicks, complete UI chat and restart/resume acceptance remain pending. The core workspace lease design still awaits approval under root AGENTS.md. Full Windows/Mac parity remains incomplete.

### Local-network model troubleshooting

Follow-up verification on 2026-10-01: the same packaged goose executable, launched via SSH using ACP, passed live discovery, provider creation and default selection with real completion validation. A new ordinary ACP conversation returned `Mac native model acceptance OK.` with `stopReason=end_turn`. Evidence: `target/macos-release-20261001/evidence/network-comparison/`. This does not establish Electron UI or CodePro writable-task acceptance.

Apple documents an exception for command-line tools launched from SSH/Terminal, while helpers launched by an app are attributed to that app. SSH success therefore does not prove app permission. After unlocking, inspect CodeBuddy under System Settings → Privacy & Security → Local Network, then retry from the app. Any authentication is performed personally by the user. Ad-hoc signing also has identity-tracking limitations; production distribution should use an Apple-issued signing identity. Reference: [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

Discovery and completion validation retain the existing ACP error codes and add URL-stripped underlying connection diagnostics. Do not infer a permission denial solely from `custom_provider_endpoint_unreachable`.

### Historical implementation record

2026-09-30: macOS packaging and terminal adaptations are implemented. **No macOS package has been built or run; Mac acceptance remains pending.** Source: the CodeBuddy repository, main at `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` plus existing dirty changes. Product metadata still names the app CodeBuddy. No branches, commits, pushes, or new dependencies were introduced.

## 2026-10-01 native compilation gap and lease adaptation proposal

The new cleanup-preview regression passed on Windows: 1/1, exit 0 (`target/macos-parity-20261001/cleanup-preview-regression.log`). Native Mac PTY checks passed with a Chinese working directory, Unicode output and actual stty dimensions of 32×110, exit 0 (`target/macos-native-evidence/native-pty-check-3.log`). The development entrypoint reuses packaging preparePty to restore spawn-helper execution permission. Installed-package smoke now also asserts actual dimensions and Unicode; that smoke has not yet run.

The first Release compilation exited 101 in goose: four calls referenced the Windows-only workspace_lease module, and cleanup preview called a helper excluded by a Windows cfg. Compilation boundaries are corrected. Unimplemented allocation/cleanup operations return errors without issuing fake capabilities or bypassing workspace protection. Cleanup preview still excludes pending/recovering/recovery directories, with a real-directory regression added. Earlier component tests do not establish that CodePro writable sessions work.

Proposed adaptation, pending review: preserve ACP acquire/consume/bind/release and session/run/message/nonce ownership. Extract the platform filesystem operations, keep the existing Windows NT handle implementation, and use the existing libc dependency on macOS for component-wise openat/O_NOFOLLOW, fstat device/inode identity, F_GETPATH and fd-relative operations. Reject canonicalize-then-path-write as insufficient against replacement between inspection and use. POSIX descriptors do not provide equivalent Windows share-delete exclusion; rename/deletion races and recovery need a separate contract and must not be declared equivalent without evidence.

Affected areas: acp/server/workspace_lease.rs, secure_fs, ACP new_session/custom_dispatch/dispatch gates, agents/agent.rs and necessary workspace frontend contracts. Keep one permission authority. First validate one-time lease consumption, identity replacement, symbolic/hard links, session closure and restart. Then validate root cleanup audit/quarantine/restore/deletion races. Finish with real Mac UI creation and resumption of CodePro tasks. Root AGENTS.md requires approval before introducing this core filesystem permission abstraction and state contract.

References: [Apple F_GETPATH](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html), [openat directory-relative operations and O_NOFOLLOW](https://man.freebsd.org/cgi/man.cgi?query=openat). Use system APIs and the existing libc dependency; no external implementation source is copied.

## Dependencies and cross-platform regressions, 2026-10-01

The user authorized build dependency installation. The Mac now uses Rust 1.96.1, Node 24.10.0, pnpm 11.9.0, CMake 4.2.3, protoc 31.1 and existing Go/Command Line Tools. `scripts/prepare-hermit.py` restores serialized Hermit links and executable permissions from Windows checkouts; Mac CI runs it before first activation. Its preservation and idempotency checks passed. The existing build allowlist now includes `node-pty`. Local dependency caches were reused over LAN after checking locked identities and file hashes. The final `pnpm --dir ui install --frozen-lockfile --offline` exited 0.

Native Mac packaging/development checks passed 26/26, TypeScript exited 0, and workspace/layout tests passed 27/27. The Mac tests exposed mixed lexical/canonical roots when listing linked workspaces such as macOS `/var`, causing a false traversal rejection during search. Returned relative paths now use one canonical root while retaining traversal rejection. The same Windows regression reproduced the defect before the fix and passed 8/8 afterward. Swift contract checks also cover modifier aliases, Command mapping, symbols and keypad distinctions. Remote evidence is under `target/macos-native-evidence/`; Windows regression logs are `target/macos-parity-20261001/linked-root-*.log`.

The native Rust Release build is running. No `.app`, DMG/ZIP, installation or full UI acceptance has completed yet. These checks do not establish complete Windows/Mac feature parity.

## Native Mac validation update, 2026-10-01

Remote Login and the task public key were configured through RustDesk; SSH is now connected. The previous refused-connection blocker is resolved. Remote directory: `/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001`. All 3,242 transferred source files passed SHA-256 verification. UTF-8 CRLF text was normalized to LF; binary bytes were preserved. HEAD and dirty integration provenance are recorded.

On arm64 / macOS 26.6.2, the existing Command Line Tools were selected per build process using `DEVELOPER_DIR=/Library/Developer/CommandLineTools`, without changing the system Xcode selection. Go tests, Swift contract checks and both native helper builds exited 0. The initial native compile exposed missing CoreGraphics imports in the contract and its tests; explicit imports fixed it. MCP initialization, nine-tool registration and missing-Screen-Recording error handling also passed on Mac. Evidence: `target/macos-remote/computer-build-2.log` and `native-probe.json`.

Doctor reports Accessibility=false and ScreenRecording=false. Real input, Retina coordinates and visible postconditions remain unverified. Compilation retains the warning that `activateIgnoringOtherApps` is deprecated and has no effect since macOS 14. Full Rust/Electron builds, `.app`, DMG/ZIP generation, installation and full UI acceptance remain NOT_RUN. The Mac has Node 26 and Rust 1.97.1, differing from the required versions, and lacks CMake/protoc. The user has authorized downloading and installing build dependencies through the existing Hermit/pnpm entrypoints with pinned versions. This environment gap is not counted as a product test failure.

## Local checks before native compilation, 2026-10-01

Source remains the existing `main` checkout at `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`, integrating `work/codebuddy-next` / `b8c6eb06c` plus dirty changes. Conflicts are resolved and the backup/stash of the original 50 dirty files is retained. The merge commit awaits a valid author name/email. Nothing was pushed.

The Mac native computer execution layer is now connected in source and packaging. It reuses the Go MCP nine-tool interface, snapshot indexing, exact window binding and `desktop_observation` receipts, with Swift / AppKit / Accessibility / ScreenCaptureKit for native execution. It does not replace the shared MCP state machine with the upstream Swift MCP. Failed or cancelled input invalidates all cached windows; uncertain actions require fresh observation. Local Mac extension routing and development synchronization now include both helpers. Packaging verifies architecture, execute permissions and SHA-256.

The previous eight failures were addressed: negative ACP usage clamps to zero; non-Tester roles cannot consume host verification as passing evidence; report assertions follow the existing visible-summary/technical-detail split; DAG fixtures use explicit verification contracts and the latest failure receipt without guessing priority from command text. Affected Rust regression: **191/191**. Go: **29/29**, plus vet. Mac packaging/development tests: **26/26**. TypeScript and strict Clippy: **exit 0**. Evidence: `target/macos-parity-20261001/`. Earlier distribution 34/34, UI 12/12, provider 14/14 and SDK 8/8 results remain in `target/integration-20261001/`; these separate runs are not presented as one full-suite run.

The Go MCP component cross-compiles to arm64/x64 Mach-O. **These components are not installers.** Swift native compilation/contract checks, Mac Rust/Electron builds, DMG/ZIP generation, installation, TCC and full UI acceptance are **NOT_RUN**. SSH still refuses connections; Remote Login/public-key setup is pending. Windows/Mac feature parity has not been accepted.


```powershell
# Repository root
cargo test --offline -p goose --lib --jobs 1 -- --test-threads=1 agents::codepro_terminal_report::tests agents::task_dag::tests acp::server::tests::test_build_ agents::tool_task::tests
cargo clippy --offline -p goose -p goose-providers -p goose-provider-types -p goose-sdk-types --lib --tests --jobs 1 -- -D warnings
# ui/desktop
node --test scripts/macos-package.test.cjs scripts/ensure-dev-backend.test.cjs
node ../node_modules/typescript/bin/tsc --noEmit
# tools/qwen-computer-use; use CODEBUDDY_GO_EXECUTABLE if Go is outside PATH
go test -json ./...
go vet ./...
```

## Build

Prepare Node 24.10+ (24.x), the workspace pnpm version, Rust 1.96.1, Go 1.22+, Xcode Command Line Tools (including Swift), Python 3, CMake, protoc, and the matching Rust target. Existing Hermit scripts provide the toolchain; initial setup uses the network. Install locked dependencies with `pnpm --dir ui install --frozen-lockfile` at the repository root, then:

```bash
# Repository root; dependencies must already be prepared.
python3 scripts/prepare-hermit.py
source ./bin/activate-hermit
cd ui/desktop
pnpm run bundle:mac --arch arm64
# Run on an Intel Mac for x64:
# pnpm run bundle:mac --arch x64
pnpm run test:macos-smoke
pnpm run test:macos-install
```

Build arm64 on Apple Silicon and x64 on Intel. `bundle:default` selects arm64, `bundle:intel` selects x64. Universal builds are excluded. The default entry builds the Release Rust backend first. CI can supply `--backend /absolute/path/to/release/goose`; this is recorded as a provided Release artifact, not proof of an external binary's provenance.

Outputs live under `ui/desktop/out/CodeBuddy-darwin-ARCH/`: the app, `CodeBuddy.zip` (arm64) or `CodeBuddy_intel_mac.zip` (x64), and `backend-manifest.json`. The manifest records revision, dirty state, target, staged SHA256 and packaged SHA256. Each stage is a fresh `target/codebuddy-package/macos-ARCH-*/bin` directory containing the matching backend, POSIX shims and both computer helpers. Development resources remain in place.

Forge rebuilds native addons, validates backend/pty.node/spawn-helper Mach-O architecture, and fixes the staged helper's execute bit before signing. The complete node-pty tree is unpacked. Unix JS loads from ASAR so node-pty performs its own path conversion once; Windows keeps its existing unpacked loading. macOS terminals use a login shell, defaulting to zsh.

The existing macOS workflow uses native architecture runners and product metadata paths, tests source, packages, then smoke-tests before uploading the desktop artifact. It has not been pushed or dispatched.

The package includes `qwen-computer-use` and `qwen-computer-runtime` beside goose. The build runs Go tests and Swift contract checks first. Manifests include `computerHashes` and `packagedComputerHashes`; missing, wrong-architecture or substituted helpers fail packaging verification.

### DMG installation acceptance

Packaging also produces `CodeBuddy-ARCH.dmg`, `artifacts.json`, and `SHA256SUMS`. Native `hdiutil` creates a read-only UDZO image with the app and an Applications symlink. The manifest records version, source, architecture, size, and SHA-256; hashing reads bounded chunks.

`pnpm run test:macos-install -- /absolute/path/CodeBuddy-arm64.dmg` requires `artifacts.json` beside the image. It checks the manifest, host architecture, and image integrity, mounts the image, copies the app with `ditto` into an isolated acceptance directory, detaches the image, then runs the smoke test against that installed copy. The app and installation receipt remain in `out/macos-install-*/`; smoke evidence remains in `out/macos-smoke-ARCH-*/`. CI runs this gate before uploading installers. Finder interaction, Gatekeeper, and notarization acceptance remain separate checks.

Remote preflight on 2026-09-30: RustDesk showed a MacBook Air M2 with 16 GB RAM and macOS Tahoe 26.6.2. SSH port 22 refused connections. Native builds, DMG generation, transfer, and remote installation acceptance remain pending user setup of Remote Login and the public key.

## Dependencies and limits

| Capability | Requirements and pending acceptance |
| --- | --- |
| Workspace files | Existing Node filesystem API; automated tests pass, Mac editing/saving pending |
| Terminal | node-pty and user shell/zsh; real Mac PTY, tabs and cleanup pending |
| Embedded browser | WebContentsView, network/proxy/site credentials; Mac HTTP/HTTPS/navigation/zoom pending |
| General Computer Controller | Existing computercontroller/Peekaboo; macOS 15+, Homebrew, Screen Recording and Accessibility; not installed/run |
| Dedicated computer acceptance agent | Shared qwen_computer + native Swift helper; macOS 14+, Screen Recording and Accessibility; source connected, native build and acceptance pending |
| Search MCP | Existing node/npx/uvx Hermit bootstrap, service API keys/network; live Mac call pending |
| Git/GitHub MCP | Git, Node MCP runtime/service configuration, GitHub credentials; replace Windows absolute paths in Mac configuration; live calls pending |
| Memory | Existing user storage/SQLite; external Hindsight needs its own service; restart persistence pending |

The desktop baseline is now macOS 14 because the native executor uses ScreenCaptureKit SCScreenshotManager. The separate Peekaboo Controller still needs 15+. The dedicated acceptance agent uses the packaged Go/Swift pair. Users must grant TCC access in System Settings; Finder startup and permission attribution need native acceptance.

## Signing and acceptance

Unsigned local builds need no Apple credentials. Distribution needs a Developer ID Application certificate/private key plus APPLE_TEAM_ID, APPLE_ID and APPLE_ID_PASSWORD (app-specific password); KEYCHAIN_PATH is optional. Existing Forge/osx-sign/notarization is reused with the current optionsForFile entitlements API. Signing, notarization and Gatekeeper checks remain unverified.

The executable smoke script starts the real packaged app with an isolated profile and a Chinese workspace path. Through the preload IPC it verifies file read/write/search, real PTY output/cwd/resize, and local HTTP WebContentsView navigation. It uses Chromium CDP and preserves the disabled Node inspector fuse. Logs, screenshot and result JSON go to `out/macos-smoke-ARCH-*/`. This is a controlled package smoke, not a completed user UI workflow.

On each architecture, still verify Finder launch, visible edit/save, multiple terminals, public HTTPS/navigation/zoom, TCC observe/action/re-observe, search/Git/GitHub MCP calls, memory across restart, codesign verification and signed-release spctl/stapler assessment. CI cannot substitute for user-granted OS permissions.

## Local verification

Host: Windows x64, Node 22.23.2 (below the package's Node 24 engine requirement). Commands use already installed tools from ui/desktop.

- Workspace/terminal/AppLayout Vitest: exit 0, 26/26.
- TypeScript: exit 0.
- macos-package unit tests: exit 0, 12/12 (`target/macos-package-tests.log`); includes artifact checksums, missing/altered manifests and architecture rejection. Mach-O data fixtures do not execute Mac binaries.
- Existing distribution suite: exit 1, 31/34. Evidence: `target/macos-distribution-tests.log`. Failures concern existing model/provider technical-name translations, tokens/URL/Terminal JSX assertions and the Windows fixed-jobs command assertion; those sources were not changed here.
- The first pnpm tool invocation unexpectedly synchronized cached dependencies (0 downloads, +21/-80), ran SDK postinstall and cleared .vite. It was interrupted; generated SDK source has no additional Git diff. It is not counted as a pass.
- ESLint for the three changed terminal TypeScript files: exit 0.
- Mac Rust/Electron builds, package smoke, full UI, TCC and signing/notarization: NOT_RUN.

Exact commands are in the [Traditional Chinese record](MACOS_ZH_TW.md).

## References

- [Electron Forge signing](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [node-pty ASAR helper issue](https://github.com/microsoft/node-pty/issues/923)
- [node-pty helper execute permission issue](https://github.com/microsoft/node-pty/issues/850)
- [Peekaboo upstream](https://github.com/steipete/Peekaboo)

- [Apple ScreenCaptureKit capture API, macOS 14+](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager/captureimage(contentfilter:configuration:completionhandler:))
- [Pinned Qwen upstream, MIT](https://github.com/QwenLM/open-computer-use/tree/24b7cae4d449a5a8ea58c583e5151096b26de03c)
