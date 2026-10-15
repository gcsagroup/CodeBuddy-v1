# Windows → Mac 功能對齊追蹤（2026-10-07）

## Mac 唯讀審核與取消（stage28，2026-10-07）

已依使用者批准的方案接通 audit/cancel。Mac 回傳 executionAvailable=false，只顯示摘要與取消；Windows 為 true，舊回應保持相容。既有 root/session/run/sourceMessage/nonce 與生命週期仍為權限依據。回執只在記憶體保存；提交／取消／撤銷採同一鎖順序。取消不延長原有效期，過期後提示新請求並停用舊提示的重試。

Windows Rust 85/85、原生 Mac Rust 35/35、兩端前端各 17/17 通過。兩端 Clippy、TypeScript、相關 ESLint 與格式檢查退出 0；Mac 保留既有平台告警。真實 Chrome 的正式元件通過摘要／取消／過期互動，選取視窗與 ACP 為隔離替身。截圖兩次逾時，不算產品失敗；原生回歸使用真實暫存檔案。

bundle28 已重建後端並通過 DMG 校驗、掛載／複製／卸載、簽章及雜湊檢查。安裝後 ACP 11/11，模型呼叫 0；包含缺權限 audit/cancel 拒絕與五個只讀限制入口。成功審核由原生回歸覆蓋，完整 Electron 正向流程尚未驗收。

其餘五個清理入口仍停用，另待 Mac 可見完整流程、Intel／最低 macOS 實機及 Developer ID 公證。本包是 ARM64 ad-hoc 內部測試版。沒有新增分支、提交或推送。舊階段保留當時狀態，目前以本節和功能表為準。

Local: `target/macos-release-20261007-bundle28/`

Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261007-bundle28/`

Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261007-bundle28/CodeBuddy.app`

- CodeBuddy.zip: SHA-256 `4be0986bd58408b0fc85891dcab3bfac01486023a8e79979ac7ede2cd76d273d`
- CodeBuddy-arm64.dmg: SHA-256 `b0257855e26ae08ef822699c681c08278ca262d54acd5c5221f3c754c44778a2`

Source: `00a6656df` + dirty. Build manifest: `0b148acbead0021a0d803c5121cfc4fca1f306e9343d111d04565cb0f6d40ec5`. Evidence: `target/macos-parity-20261007/cleanup28-state.json`; commands: `cleanup28-commands.json`.


## 桌面驗收調度對齊（stage26）

已移除 Mac 一律無桌面的硬編碼。既有 Swift 助手的只讀 doctor 現在回傳版本 1 結構化桌面與權限事實；Scheduler 直接呼叫同一原生助手，以 3 秒與 64 KiB 限制讀取，只消費 desktopAvailable / permissionAvailable。Windows 原 OpenInputDesktop 偵測保留；Linux 仍不宣稱支援。舊助手、缺欄位、版本不符、非零退出、逾時及過大輸出均保持等待；不解析說明文字。

原生判定使用 Quartz console/login/UID 與 AX／螢幕錄製預檢。另採 Chromium 使用的 CGSSessionScreenIsLocked 拒絕鎖屏；此鍵不是 Apple 公開常數，缺鍵明確記為 notReported，不聲稱已證明解鎖。這是當下先決條件，非驗收回執；每次實際操作仍核對原有權限、視窗與前景狀態。SSH 的 TCC 結果只代表該啟動脈絡。未要求授權、未輸入、未啟動 Electron。

bundle26 已交付並安裝至遠端獨立測試目錄。

Windows Rust 回歸 58/58、Mac Rust 回歸 60/60 通過（含 1 項真實原生助手整合）；兩端 Clippy 退出碼 0。Swift 新增 9 項環境檢查及 Go 助手測試通過。DMG 掛載／複製、簽章、安裝副本雜湊，以及安裝後 ACP 4 項檢查通過；模型呼叫為 0。完整 Electron 驗收為 NOT_RUN。

Local: `target/macos-release-20261005-bundle26/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle26/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle26/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9b043631a3b789990b4c2b803149c93b0acc0189fac1483d50e1e50a82573449`
- CodeBuddy-arm64.dmg: SHA-256 `a171966fac61525f012548da5b106897316d5a0d722d7b5266468260340fb586`

清理的七項產品路由及完整 Electron／TCC／Intel 驗收仍未完成。

References: [Apple Quartz session API](https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary%28%29), [Apple session properties](https://developer.apple.com/documentation/coregraphics/window-server-session-properties), [Chromium lock detection evidence](https://issues.chromium.org/issues/40594056).


## 工作任務強制停止接線（stage25）

使用者在具體方案後回覆「繼續」，批准既有 owner 接線。PID 與 `SessionProcessOwner` 在 `WorkerRegistry` 同一鎖內註冊；tracker 與 lifecycle 消費同一引用。OS 操作仍由 `SystemProcessGroupOwner` 負責。強制停止取快照時關閉新註冊；終止、runner 取消與退出確認在鎖外執行。已確認退出的紀錄逐筆移除；未確認的紀錄保留供重試，避免 runner drop 後再次停止時誤報完成；過期 generation 與衝突 owner 被拒絕。

Windows 本輪 18/18、Mac 本輪 19/19 通過；兩端 Clippy 退出碼為 0。bundle25 已重新建置後端，包含 stage24 的 shell 取消／逾時與埠歸屬修復，以及 stage25 的強制停止接線。DMG 掛載／複製／卸載、簽章、安裝副本雜湊與 ACP 啟動交握 4 項通過（模型呼叫 0）。這是 arm64 ad-hoc 內部測試包，尚未公證。

Local: `target/macos-release-20261005-bundle25/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle25/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle25/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9aa02168c6fb4260a480074e5e724e7d6c464e424b0db9bd8669085e536bf1bd`
- CodeBuddy-arm64.dmg: SHA-256 `1c1aa6357374559eb695e379ecdde5a9057dfcd35deacb2555a78a20cfaefccc`

新增覆蓋 owner 失敗與重試、協作取消期間註冊、舊 generation，以及 Mac 真實後代退出／父程序先退出／無關程序存活。完整 Electron 流程維持 NOT_RUN。清理寫入、桌面驗收調度、TCC／Keychain 和 Intel 驗收仍有缺口，不能據此宣稱完整對齊。


以本機 Windows 工作目錄的實際程式為基準：`main` `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`，包含既有待提交合併與 dirty 修改。本表是本輪已追蹤的入口清單，並非完整驗收證明；共用程式、原生適配、自動測試、安裝後 ACP 和可見桌面流程分開判定。


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

## stage24 修復背景與剩餘門檻

先修 Mac 前台 shell 的取消／逾時：在啟動前使用既有 `SystemProcessGroupOwner` 建立獨立程序群組，向既有 tracker 註冊 owner，取消時終止群組並等待父程序與群組退出。Windows 原路徑保留。正常前台命令結束時 owner 釋放；持續服務使用既有 `process_action=start`。新增原生回歸同時檢查後代程序退出、無關兄弟程序仍存活、輸出管線關閉與結構化回執。

工作任務強制停止已按 stage25 接線，現有 owner 送達 lifecycle，驗證進度見上方。監聽埠歸屬已新增 Mac 原生唯讀查詢，仍由既有 owner 判定，原生回歸 2/2 通過。

清理仍受已批准設計第 2 項約束：確認後目標遭替換時不得移動另一個物件。Apple 的 renameatx_np 接收父目錄 fd 與名稱，並未接收預期 inode；額外 rename flags 不能直接證明物件身分相符。維持原門檻，未將缺口標為完成。參見 [既有設計](MACOS_CLEANUP_DESIGN_ZH_TW.md) 與 [Apple 原始碼](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/vfs/vfs_syscalls.c)。

本輪不重新觸發先前暫緩的 Keychain／TCC 認證。Intel、最低支援系統及完整 Electron 驗收仍待完成。沒有建立分支、提交或推送。

## 工作任務強制停止接線方案（已核准，歷史方案）

現象：`LifecycleController` 只取得 PID，而 `RuntimeWorkerProcessTracker` 保留既有 `SessionProcessOwner`；Mac 的裸 PID terminator 回報不支援。方案 A 依 PID 掃描並殺死程序樹，身分與後代關係會隨時間改變，且重複既有 owner，故不採用。方案 B（建議）把既有 owner 的引用和 PID 一起註冊到 `WorkerRegistry`，lifecycle 取得同一 owner，先終止，再等待可驗證的群組退出回執；缺少 owner 的 Mac 舊紀錄保持明確未確認，Windows 保留既有 fallback。

範圍：`session/session_manager.rs` 的既有 owner trait 補退出確認、`workers/registry.rs` 原註冊表保留 owner 引用、`control_plane/runtime.rs` 轉送、`task_scheduler.rs` 的 tracker 委派、`control_plane/lifecycle.rs` 消費及測試。原 OS owner 仍唯一操作程序群組；不建立第二套 PID 權威，不更改 ACP、持久化格式或重啟恢復權限。owner 註冊與 PID 註冊須同一鎖內完成，終止與等待在鎖外；過期 worker generation 不接納新註冊。

驗收：原生 Mac shell／測試程序的停止、取消前後註冊競態、父程序已退出但後代仍存活、重複停止、owner 失敗時不得標完成、無關程序存活，以及 Windows 回歸。先通過自動與原生測試，再驗收安裝後 ACP；可見 Electron 流程維持独立待辦。根目錄 AGENTS.md 要求跨模組事實註冊與核心介面修訂先給出比較與邊界並取得核准，使用者已回覆繼續並批准本方案；現況見 stage25。

## 2026-10-06 stage27：Finder／Dock 開啟專案的啟動時序

- 修正 `open-file` 在應用程式就緒前直接建立視窗的缺口。主程序同步接收事件，待儲存初始化與視窗服務完成後依序開啟；啟動途中到達的事件也會排入處理。
- 成功開啟外部檔案／目錄時略過多餘的預設視窗；全部失敗時仍保留預設入口。Dock 啟用事件在開啟尚未完成時不另建空視窗。失敗不阻塞後續檔案，成功後才加入最近目錄。
- 使用 Electron 官方 `open-file` 單檔事件處理多檔，移除未受支援的 `open-files` 事件。一般符號連結依目標類型開啟，特殊檔案不作為專案目錄。
- 本地生命週期與啟動目錄回歸 8/8、TypeScript 與相關 ESLint 通過。遠端回歸與 bundle27 交付結果記於 `target/macos-parity-20261006`；可見 Finder／Dock 操作仍待實機驗收，測試不代表該項通過。
- 本次僅修改桌面主程序，重用 bundle26 的已驗證 release 後端；未改動清理功能門檻。清理 7 個產品入口、真實 Electron 權限流程、Intel 與正式公證仍未完成。
- 依據：[Electron app open-file 官方文件](https://www.electronjs.org/docs/latest/api/app#event-open-file-macos)。此事件可早於 ready，應提早註冊並延後建立視窗；本次無新增依賴、公開協議或持久化格式。

### bundle27

Windows 與 Mac 回歸各 8/8、TypeScript、相關 ESLint 與打包命令退出碼均為 0。DMG 校驗、唯讀掛載／複製／卸載、簽章和安裝副本雜湊通過；ACP 4/4，模型呼叫 0。Electron 可見操作 NOT_RUN。

Local: `target/macos-release-20261006-bundle27/`

Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261006-bundle27/`

Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261006-bundle27/CodeBuddy.app`

- CodeBuddy.zip: SHA-256 `b9aa4cf6b823153c8b220cbe2d142a4dd24bfcad46888a86a1523fdcebbdd9cb`
- CodeBuddy-arm64.dmg: SHA-256 `d4f4ff59b4f95b5fa4ce5164805e9b59c3c7470806ccdb70808322d269695e3f`

Source: `00a6656df` + dirty; build manifest `a5ad96dff6f262b88173fd680b20d12d3f4b18d94020fbc04e6fd5a17d5eaa75`. Evidence: `target/macos-parity-20261006/desktop27-state.json`. arm64 ad-hoc.
