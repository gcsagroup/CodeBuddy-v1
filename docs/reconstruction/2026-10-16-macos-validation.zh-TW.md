# 2026-10-16 Mac 統一測試記錄

[简体中文](2026-10-16-macos-validation.zh-CN.md) · [English](2026-10-16-macos-validation.en.md)

來源為 Windows `D:\CodeBuddy-v1`、`main`、revision `732113504de3601ab087a609ce20827b814db2c2` 加未提交 Mac 適配。使用既有 Node 24.21.0 和依賴，未切換分支、安裝依賴、提交或推送。

| 已執行目標 | 退出碼 | 結果 |
| --- | --- | --- |
| Mac 封裝合同、載荷身份、啟動器、依賴及獨立 MCP 回歸 | 0 | 32 通過 |
| `node --test runtime/tests/*.test.mjs` | 0 | 363 通過 |
| `node ui/node_modules/typescript/bin/tsc --noEmit --project ui/desktop/tsconfig.json` | 0 | 通過 |
| `cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1` | 0 | 69 通過，1 忽略 |
| `cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings` | 0 | 通過 |

完整命令見簡體版本。首次類型檢查誤用未提升的依賴路徑，退出 1；改用既有 UI 根目錄依賴後通過，未修改產品。忽略項為原有公網 Open-Meteo 測試。首批與全套有重疊，不相加宣稱獨立案例數。真實 MCP 進程在 Windows 執行，Mach-O/簽名雜湊用例為夾具，不證明 Mac 原生執行。已執行檢查尚未發現產品缺陷。

RustDesk 顯示「正在接入 RustDesk 網路」，連線後未出現遠端桌面；尚未取得 Mac 即時畫面或專案目錄，已請使用者手動連線並保持解鎖。此為環境阻塞，不是專案測試失敗。

Mac Go/Swift 合同、原生工具與安裝包建置、簽名/安裝、電腦控制及獨立 MCP 實機驗收均尚未執行，沒有本批 Mac 安裝包或產品 PASS。後續先核對來源和未提交差異，再用獨立 profile 驗收 TCC、截圖、中文輸入、視窗切換與四組 MCP；驗證實際回執及後置結果。歷史產物與畫面不作本輪證據，密碼/系統授權由使用者處理。

本機 `.preview-evidence/mac-acceptance-20261016/` 保存結果、來源雜湊及待同步差異；尚未傳至 Mac，不納入提交。

## 後續恢復

RustDesk 已出現 `159817412@erjinyidemacbook-air.local` 遠端視窗，Mac 桌面時間由 19:03 更新至 19:06；此前未連線狀態已失效。但開啟 `work` 與還原視窗均沒有可見變化，輸入尚未確認。輔助 SSH 已到達主機，現有憑據驗證失敗，退出 1；主機記錄只寫入本機驗收目錄，沒有讀取/輸入密碼或執行 Mac 命令。已請使用者把 RustDesk 移至 Windows 主屏並置前、手動開啟 `work` 並提供專案路徑。原生建置與驗收仍待通道恢復。21 個實作檔案與先前自動化時雜湊相同，僅重用既有證據，未重跑或宣稱 Mac 通過；詳情保存於 `rustdesk-resume.json`。

## 輸入通道診斷

RustDesk 已在 Windows 主屏，但目錄雙擊與標題列操作仍無可見後置變化。唯讀權杖檢查退出 0：目前執行程序 `elevated=0, uiAccess=0`，RustDesk 兩個介面程序（PID 27456、57876）均為 `elevated=1, uiAccess=0`，版本 `1.5.0+68`。日誌未發現鍵鼠權限關閉記錄，仍未證明 Mac 輔助使用授權有效。

此權限差異是本機輸入阻塞的明確線索；[微軟 SendInput 文件](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)說明 UIPI 對完整性級別的限制。經正常應用入口重開仍回傳原視窗，已請使用者退出 Windows RustDesk、以普通權限重開並連回原 Mac。未變更 UAC、應用權限、Mac TCC 或憑據，也未執行 Mac 命令。

修復尚待驗證。恢復後先核對權限與可見點擊/輸入結果，再同步本批來源、建置安裝包及驗收電腦控制和獨立 MCP。既有 Windows 自動化未重跑，Mac 項目仍為 `NOT_RUN`。本機診斷保存於 `rustdesk-input-diagnostic.json`。

## 已恢復遠控輸入

使用者普通啟動 RustDesk 後，已實際雙擊開啟 Mac `work`，觀察普通按鍵，並透過原生「編輯 → 貼上」執行 `uname -m`，得到 `arm64`。批量文字快捷鍵有跨平台映射差異；翻譯模式未解決，已還原傳統模式。帶引號的「新命令」須勾選在 Shell 中執行；先前未勾選造成的引號錯誤不記為產品失敗。文稿存取授權由使用者手動允許。

環境輸出為 macOS `27.0.1`、Node `v26.3.0 arm64`、Go `go1.26.5 darwin/arm64`；Rust `1.96.1-aarch64-apple-darwin` 與 Xcode Swift 已存在。在 Desktop、Documents、work 深度 4 範圍未找到 CodeBuddy，非全盤結論。已準備並驗證 `main@7321135` 加未提交差異的同步包，尚未傳輸；等待在 `/Users/erjinyi/Desktop/work/CodeBuddy-v1` 準備來源與鎖定依賴/Office 載荷的授權。Mac 原生建置、安裝包和產品電腦控制/獨立 MCP 仍為 `NOT_RUN`。詳見本機 `rustdesk-input-recovery.json`。

## 原生準備進展：同批原始碼已校驗，Office 準備待修復

使用者已授權在 `/Users/erjinyi/Desktop/work/CodeBuddy-v1` 建立本批原始碼、準備鎖定相依套件及 Office 載荷並繼續建置驗收。RustDesk 內建檔案傳輸完成 1/1 檔案、77.34 MB；遠端通過外層 SHA256 門檻後進入腳本，內層 `source.zip` 雜湊檢查回傳 `OK`。`source-verify` 結束碼為 0，36 個變更/新增檔案的 LF 正規化雜湊與清單一致；基線為 `732113504de3601ab087a609ce20827b814db2c2`、`main`、dirty。既有 `/Users/erjinyi/CodeBuddy` 保留。

首次準備在安裝前以結束碼 2 停止：根目錄選中的 pnpm 為 12.8.1，專案指定 11.9.0。續跑明確使用 `corepack pnpm@11.9.0`，保留原始碼與系統套件管理器。相依套件階段已推進至 Office 準備；現場明確觀察到 `harness-dependencies`、`office-builder-dependencies` 均以 0 結束。npm 官方來源出現慢請求及重試，未變更鎖檔或鏡像。

Office 準備在系統 Node `v26.3.0` 下以 13 結束，報 `Detected unsettled top-level await`，位置為 `scripts/prepare-harness-office.mjs:30`。`runtime/office-assets` 為空，下載快取已有 Python 及首個 NumPy 歸檔；根因尚未確認。兩處常規 Homebrew Node 24 路徑未發現執行檔。目前依上游鎖檔下載專案內 Node `24.21.0`、`darwin-arm64`，預期 SHA256 為 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`，校驗後重試；保留系統 Node 26。先前 Windows 檢查為沿用證據，不算本輪 Mac 原生測試。

原始碼準備紀錄：`/Users/erjinyi/Desktop/work/.codebuddy-source-20261016.kbeXOp/prepare-build.log`。相依套件及失敗紀錄：`/Users/erjinyi/Desktop/work/.codebuddy-source-20261016.KJbc8Z/prepare-build.log`。原生測試、安裝包、真實電腦控制及獨立 MCP 產品驗收尚未執行。未提交或推送。

## Keychain 適配與重測（本輪續作）

使用者已批准 Keychain 主金鑰 + AES-GCM 方案。獨立 Swift helper、版本化密文、固定產物驗證及建置接線已實作。Windows 完整 runtime 365/365 通過（退出碼 0；日誌 `.preview-evidence/mac-acceptance-20261016/windows-runtime-keychain.log`），相關兩組回歸 21/21、38/38 通過（覆蓋重疊）。Mac 首輪為 311 通過、46 失敗、6 跳過。增量包已傳輸但尚未套用：RustDesk 重連後確認 Mac 位於登入鎖定畫面，等待使用者解鎖。Mac Keychain 編譯與執行、重測、原生安裝包及產品電腦控制/獨立 MCP 驗收仍待執行。

## 2026-10-17：原生工具通過，安裝包前回歸仍待完成

上述增量已在 Mac 套用並校驗。Swift Keychain 原生合同測試結束碼 0，涵蓋真實 Keychain 主金鑰讀取/重開、Unicode、空值、缺失金鑰不建立及竄改拒絕。Rust 原生編譯發現 `ProcessSession` 所需 feature 未啟用，已在 `crates/goose-mcp/Cargo.toml` 啟用既有 `process-session` feature，未新增相依套件。修復後 `native-tools` 結束碼 0，原生工具產物已生成；`package-tests` 18/18 通過、結束碼 0。證據為本機忽略目錄的 `mac-native-v3.log`。

同次 Mac `npm --prefix runtime test` 為 360 通過、4 失敗、1 跳過，結束碼 1。失敗涉及 XDG 快取斷言、`/var` 與 `/private/var` 別名、隔離 HOME 下憑據存取及壓縮中斷後冷啟動恢復。已修正測試夾具/斷言、將 Mac 憑據子程序 HOME 綁定到登入使用者主目錄，並準備 Harness 持久化根目錄 canonicalization；最後一項仍為待原生驗證的修復假設，工作區符號連結拒絕策略不變。

最新 Windows 完整回歸 365 通過、0 失敗、1 項 Mac 專用跳過，結束碼 0（`windows-runtime-v4.log`）；不作為 Mac 通過證據。六檔案 `mac-native-v4.zip` 已傳到 Mac，SHA256 為 `99fb3a55938f498ecdd971da3692c755b36e7efd8cfc90f5bcccacfb60638d66`，尚未套用：再次重連確認 Mac 自動鎖定，等待本人解鎖。續跑命令已準備獨立且限時的 `caffeinate`，避免測試退出後保活隨之結束。

原始碼仍為 `main@7321135` 加本批未提交修改，未提交/推送。Rust 函式庫測試及 Clippy、原生 DMG 建置、安裝後冒煙、安裝應用內電腦控制與獨立 MCP 實際操作均待執行。最終驗收對象為本批 Mac 原生安裝包安裝後的應用；原生工具編譯及工具清單不等於產品驗收。

## 2026-10-17：Mac 回歸通過，進入安裝包驗收

解鎖後已套用 v4b、v5。v4b 為 364 通過、1 失敗、1 跳過；正規化持久化路徑未修復冷恢復，已撤回。官方 JSONL 插件有 200ms 寫入緩衝；現在使用既有 sessions.flush，在完成回執前等待原生佇列落盤，並加強崩潰回歸，未新增持久化 owner 或格式。

Mac v5 執行 npm --prefix runtime test：365 通過、0 失敗、1 跳過；cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1：69 通過、0 失敗、1 忽略；cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings 通過。三階段退出碼皆為 0，證據 mac-native-v5.log。跳過 Windows 憑據用例，忽略公網 Open-Meteo。Windows 壓縮與恢復 7/7 通過、退出 0。

打包首次在預打包檢查退出 1：verify-harness-stage.mjs 的直接會話遺漏 commonqueries 設定中繼資料。現以 openStore/commonQueryMetadata 接入 mcpRequestMetadata，相關真實 MCP 回歸通過、退出 0。v6 已套用並續跑打包；DMG 與安裝後產品驗收仍待結果。main@7321135 加未提交修改，無提交或推送。

### v6：應用已產生，簽名後 Keychain 授權待本人處理

v6 預打包服務檢查通過，sourceDigest 為 532c35c9c7a0169135d387ff398fdb929af6a0bfc63675e53ce5ff9da6ab1d95；實測 Shell、Office、MCP 發現及時間/快取呼叫、憑據保護。Electron Forge 已產生 ui/desktop/out/CodeBuddy-darwin-arm64/CodeBuddy.app，完成 ad-hoc 簽名及首次 codesign 驗證。簽名後憑據複測觸發 codebuddy-credentials 存取 local.codebuddy.credentials.v1 的系統鑰匙圈認證，30 秒逾時，native-package 退出 1。已請使用者本人處理；未讀取或輸入密碼、未修改 ACL。簽名後憑據檢查待完成，DMG 未產生，安裝後冒煙及電腦控制/獨立 MCP 產品驗收未執行。證據 mac-native-v6.log。


## 2026-10-19：原生安裝包通過，電腦輸入仍在定位

本節更新上述歷史阻塞。Keychain 授權處理後，v6 的 native-package、package-smoke、install-smoke 皆退出 0。已回傳核對 mac-native-v6.log、macos-install-2VVt43/result.json 和 artifacts.json：Apple Silicon 1.43.5 DMG/ZIP 已產生；DMG 驗證、唯讀掛載、複製安裝、codesign 與安裝副本 smoke 通過。來源為 main@732113504de3601ab087a609ce20827b814db2c2 + dirty，sourceDigest=532c35c9c7a0169135d387ff398fdb929af6a0bfc63675e53ce5ff9da6ab1d95，ad-hoc 簽名，未公證。

安裝副本為 ui/desktop/out/macos-install-2VVt43/installed/CodeBuddy.app。隔離夾具使用 LaunchServices open -n -W，依使用者授權加入錄屏、輔助功能與桌面存取。installed-mcp-YMIJp8 回執確認應用內 ACP 時間、快取清單、真實 PDF 擷取與圖表結構化結果通過；視窗列舉、PNG 截圖及 AXTextArea 觀察成功。click 在原生前台檢查遭拒，未派發輸入；中文/emoji 輸入及儲存尚未執行。未使用真實模型對話，圖表顯示與完整產品 E2E 尚未驗收。

本地證據為 .preview-evidence/mac-acceptance-20261016/received-20261019/；遠端包為 /Users/erjinyi/Desktop/work/mac-evidence-20261019.zip。v6 DMG SHA256=5259849878c0b794e7ab02854f6b5185d87d2c7678e617122477ccb67771777e；後續重建須重新驗證。

唯讀 Swift 探針的非同步入口與 AppKit run loop 入口皆讀到實際前台進程；單獨隔離 HOME 亦正常，兩項命令退出 0。AX 查詢因終端未授權回傳 -25204，額外授權提示已關閉，未擴大權限。runtime.swift 已加入期望/實際 PID 與視窗診斷，未放寬輸入保護。v8 增量已通過來源前置雜湊檢查並套用，正在原生回歸與重建，尚無新版安裝包驗收結果。無提交或推送。
