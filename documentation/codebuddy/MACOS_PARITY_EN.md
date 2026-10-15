# Windows → Mac feature tracking (2026-10-07)

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


## Desktop acceptance scheduling alignment (stage26)

Mac is no longer unconditionally classified as having no desktop. The existing Swift helper's read-only doctor returns version 1 structured desktop and permission facts. Scheduler calls that same native helper directly, bounds the probe to 3 seconds and 64 KiB, and consumes desktopAvailable / permissionAvailable. Windows retains OpenInputDesktop; Linux stays unsupported. Old helpers, missing fields, incompatible versions, nonzero exits, timeouts and oversized output retain the waiting state. Human-readable text is not parsed.

Native checks use Quartz console/login/UID and AX/Screen Recording preflight. CGSSessionScreenIsLocked, also used by Chromium, provides an additional lock rejection. This key is not an Apple public constant; absence is recorded as notReported, not proof of unlock. These are fresh prerequisites, not acceptance receipts. Existing permission, window and foreground checks still apply to every action. SSH TCC results describe only that launch context. No permission request, input or Electron launch occurred.

bundle26 has been delivered and installed in a separate remote test directory.

Windows Rust: 4 probe + 54 Reviewer tests; Mac Rust: 5 probe + 54 Reviewer + 1 real-helper integration. All passed; both Clippy commands exited 0. Swift: 9 new environment checks passed; Go helper tests passed. DMG mount/copy/signature/hash checks and 4 installed ACP checks passed; model calls 0.

Local: `target/macos-release-20261005-bundle26/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle26/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle26/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9b043631a3b789990b4c2b803149c93b0acc0189fac1483d50e1e50a82573449`
- CodeBuddy-arm64.dmg: SHA-256 `a171966fac61525f012548da5b106897316d5a0d722d7b5266468260340fb586`

 All seven cleanup product routes and full Electron/TCC/Intel acceptance remain incomplete.

References: [Apple Quartz session API](https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary%28%29), [Apple session properties](https://developer.apple.com/documentation/coregraphics/window-server-session-properties), [Chromium lock detection evidence](https://issues.chromium.org/issues/40594056).


## Worker force-stop wiring (stage25)

The user approved the concrete existing-owner proposal by replying “continue.” PID and `SessionProcessOwner` are registered atomically in `WorkerRegistry`; tracker and lifecycle consume the same reference. `SystemProcessGroupOwner` remains the OS owner. The force-stop snapshot closes new registrations; termination, runner cancellation and exit confirmation happen outside the lock. Confirmed records are removed individually; unconfirmed records survive runner drop for retries; stale generations and conflicting owners are rejected.

Windows 18/18 and Mac 19/19 checks passed; Clippy exited 0 on both platforms. bundle25 rebuilds the backend with stage24 shell cancellation/timeout and listener ownership fixes plus stage25 force-stop wiring. Actual DMG mount/copy/unmount, signature, installed-file hashes and 4 ACP startup handshake checks passed (zero model calls). This is an arm64 ad-hoc internal test package without notarization.

Local: `target/macos-release-20261005-bundle25/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle25/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle25/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9aa02168c6fb4260a480074e5e724e7d6c464e424b0db9bd8669085e536bf1bd`
- CodeBuddy-arm64.dmg: SHA-256 `1c1aa6357374559eb695e379ecdde5a9057dfcd35deacb2555a78a20cfaefccc`

 Coverage includes owner failure/retry, registration during cooperative grace, stale generations, and native Mac descendant exit, early parent exit and unrelated process survival. Full Electron acceptance remains NOT_RUN. Cleanup mutation, desktop acceptance scheduling, TCC/Keychain and Intel acceptance remain gaps; full parity is not established.


Baseline: the actual local Windows worktree, `main` `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` plus existing pending merge and dirty changes. This is the set of traced entry points, not an exhaustive acceptance certificate. Shared source, native implementation, automated tests, installed ACP and visible desktop journeys are distinct evidence levels.


| Feature / 功能 | Windows baseline / 基準 | Mac status / 狀態 | Source / 源碼 |
| --- | --- | --- | --- |
| Model routing, sessions, history / 模型、會話、歷史 | Shared implementation | Shared code; current visible Electron acceptance pending | `acp/server/{providers,new_session,load_session}.rs`, `agents/model_router.rs` |
| Planning, workers, task reports / 計畫、工作任務、報告 | Shared control plane | Shared code; native force-stop gap repaired in bundle25 | `agents/{task_scheduler,control_plane}` |
| Project selection and creation / 專案選擇與建立 | Workspace leases and root allocation | Native Mac leases + writable project-container flow; installed ACP evidence in bundle18/23, visible flow pending | `acp/server/workspace_lease{,_macos}.rs`, `custom_dispatch.rs` |
| Root disk usage / 磁碟容量 | Structured read-only result | Native implementation; earlier installed ACP evidence, not fresh desktop acceptance | `agents/agent.rs`, `workspace_lease_macos.rs` |
| Cleanup: audit, quarantine, restore, delete, cancel, recovery list/retry / 清理 | Seven live Windows routes | Read-only audit and cancellation implemented in bundle28; five mutation/recovery routes remain unavailable | `custom_dispatch.rs`, `workspace_lease/{cleanup_macos,cleanup_api_macos}.rs` |
| Foreground shell cancel/timeout / 前台命令取消與逾時 | Stops tree using taskkill | Implemented with existing process-group owner; Windows 16/16 and native Mac 24/24 passed; included in bundle25 | `developer/shell.rs` |
| Worker forced stop / 工作任務強制停止 | Lifecycle controller invokes native tree terminator | Existing owner reaches lifecycle; native force-stop/retry checks passed; included in bundle25 | `control_plane/lifecycle.rs:140`, `workers/process_tree.rs:496`, `task_scheduler.rs:1035` |
| Background process start/status/stop / 背景程序 | Owned process handles | Shared process API and Unix groups; native listener ownership included in bundle25 | `developer/managed_process.rs`, `workers/process_tree.rs` |
| Listener belongs to launched process / 監聽埠歸屬 | Windows listener PID + owned Job check | Native lsof + existing owner implemented this turn; native 2/2 passed (one subprocess fixture ignored); included in bundle25 | `developer/managed_process.rs:237` |
| File tree, Git review and embedded terminal / 檔案樹、Git、內建終端 | Shared workspace panel | Shared UI with Mac PTY/login-shell adapter; current Electron journey pending | `ui/desktop/src/workspace-panel/` |
| MCP extensions / MCP 擴充 | Shared manager and editor | Shared manager; POSIX argument preservation repaired in bundle23; real extension journey pending | `agents/extension_manager.rs`, `settings/extensions/utils.ts` |
| Computer control / 電腦控制 | Nine tool entries via Windows native runtime | Same nine tool entries via Swift runtime; TCC and visible input acceptance pending | `tools/qwen-computer-use/{main.go,native_runtime.go,macos/runtime.swift}` |
| Desktop acceptance scheduling / 桌面驗收調度 | Checks Windows input-desktop access | Native structured environment probe wired in stage26; real unlocked Electron journey pending | `agents/task_scheduler.rs:95`, `:5422`, `:5459` |
| Keyboard, tray, notifications / 快捷鍵、選單列、通知 | Windows desktop integration | Mac branches and shortcut recorder exist; OS interaction acceptance pending | `ui/desktop/src/main.ts`, `settings/keyboard/` |
| Installer / 安裝包 | Existing Windows build | bundle26 arm64 internal ad-hoc DMG/ZIP delivered; full visible acceptance pending | `target/macos-release-20261005-bundle26/` |

## stage24 background and remaining gates

First repair Mac foreground shell cancellation/timeouts using the existing `SystemProcessGroupOwner`: configure the group before spawn, register its owner with the existing tracker, terminate the group and confirm parent/group exit. Windows keeps its previous path. Foreground scope releases the owner on return; persistent services use the existing `process_action=start`. Native regressions check descendant exit, an unrelated sibling remaining alive, closed output pipes and structured receipts.

Worker force-stop now routes existing owners to lifecycle under stage25; see the current validation status above. Listener ownership now has a native Mac read-only probe whose PIDs are evaluated by the existing owner; native regressions passed 2/2.

Cleanup keeps gate 2 of the approved design: substituting the target after confirmation must not move a different object. Apple's renameatx_np takes parent directory descriptors and names, not an expected inode; extra rename flags do not establish exact identity. See the [approved design](MACOS_CLEANUP_DESIGN_EN.md) and [Apple source](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/vfs/vfs_syscalls.c). The gap remains open.

Previously deferred Keychain/TCC authentication is not retriggered. Intel, minimum macOS and full visible Electron acceptance remain pending. No branch, commit or push created.

## Worker force-stop wiring proposal (approved; historical proposal)

`LifecycleController` sees PIDs while `RuntimeWorkerProcessTracker` retains existing `SessionProcessOwner` references; the raw-PID Mac terminator is unsupported. Option A enumerates and kills descendants by PID, duplicating ownership and racing changing identities. Option B (recommended) registers the existing owner reference with the PID in `WorkerRegistry`; lifecycle consumes that same owner and confirms group exit after termination. Mac legacy records without an owner remain unconfirmed; Windows retains its current fallback.

Scope: extend the existing owner trait in `session/session_manager.rs` with exit confirmation; retain owner references in `workers/registry.rs`; forward registration through `control_plane/runtime.rs`; delegate tracker calls in `task_scheduler.rs`; consume owners in `control_plane/lifecycle.rs`. The OS group owner remains the sole actor. No new PID authority, ACP change, persistence migration or restart authority. Register PID and owner atomically under the registry lock; terminate/wait outside locks; reject stale worker generations.

Acceptance covers native Mac shell/test processes, registration around cancellation, parent exit with live descendants, repeated stop, owner failures never reporting completion, unaffected sibling processes and Windows regressions. Installed ACP follows automated/native tests; visible Electron remains a separate gate. Root AGENTS.md requires concrete comparison and approval before this cross-module registration/core-interface change, the user has since approved this proposal by replying continue, and stage25 implements it.

## 2026-10-06 stage27: Finder / Dock project opening during startup

- Queue `open-file` events synchronously before readiness; open them serially after storage bootstrap and window services initialize. Include events arriving while a startup window is still opening.
- Skip the default startup window only after a file opens successfully. Preserve the default entry if all opens fail. Dock activation avoids a competing empty window while file opening is pending. Failed opens do not block subsequent files; add recent directories only after a window opens.
- Handle multiple files through the documented per-file event and remove the unsupported `open-files` event. Resolve ordinary symbolic links by target type; reject special files as project directories.
- Local lifecycle and startup-directory tests: 8/8; TypeScript and scoped ESLint pass. Remote checks and bundle27 delivery results are recorded under `target/macos-parity-20261006`. Visible Finder / Dock acceptance remains pending and is not established by these tests.
- Desktop main-process changes only; reuse the verified bundle26 release backend. The seven cleanup product routes, real Electron permission flows, Intel hardware acceptance and Developer ID notarization remain incomplete.
- Reference: [Electron app open-file documentation](https://www.electronjs.org/docs/latest/api/app#event-open-file-macos). Events can precede ready; register early and defer window creation. No new dependencies, public protocol or persistent format.

### bundle27

Windows and Mac regressions each pass 8/8. TypeScript, scoped ESLint and packaging exit 0. DMG validation, read-only mount/copy/unmount, signature and installed-file hashes pass; ACP 4/4, model calls 0. Visible Electron acceptance: NOT_RUN.

Local: `target/macos-release-20261006-bundle27/`

Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261006-bundle27/`

Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261006-bundle27/CodeBuddy.app`

- CodeBuddy.zip: SHA-256 `b9aa4cf6b823153c8b220cbe2d142a4dd24bfcad46888a86a1523fdcebbdd9cb`
- CodeBuddy-arm64.dmg: SHA-256 `d4f4ff59b4f95b5fa4ce5164805e9b59c3c7470806ccdb70808322d269695e3f`

Source: `00a6656df` + dirty; build manifest `a5ad96dff6f262b88173fd680b20d12d3f4b18d94020fbc04e6fd5a17d5eaa75`. Evidence: `target/macos-parity-20261006/desktop27-state.json`. arm64 ad-hoc.
