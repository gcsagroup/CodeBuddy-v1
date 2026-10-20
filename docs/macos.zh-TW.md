# macOS 開發與封裝

[简体中文](macos.zh-CN.md) · [English](macos.en.md)

目標為 macOS 14+、Apple Silicon 原生 arm64，保留 Intel x64 的同架構建置路徑。2026-10-20 的開發憑證簽名 v14 已完成原生封裝、DMG 安裝、九個電腦控制工具及獨立 MCP 關鍵呼叫的本機驗收，並驗證覆蓋升級後的權限和 Keychain 密文連續性。本批建置來源與未驗收範圍見末節；不包含其他對話最新的桌面寵物改動。

## 架構與功能邊界

Electron 啟動套件內獨立 Node 執行 Harness，透過既有 ACP 適配連接介面。執行、排程、完成及壓縮的 owner 保持不變；Mac 使用官方 Bash 插件。舊 Rust Agent/CLI 不參與建置。

套件包含 Node 及授權文件、同架構 Python/Office 載荷及執行依賴。Electron 與 Harness 各自的 node-pty 分別處理，保留 helper 執行權限。簽名前後執行載荷驗證，簽名後的驗證資料寫在 `.app` 外。

本批原始碼已接入四個既有設定鍵：`qwen_computer` 使用 Go 前端及 Swift helper 提供九工具電腦控制；`computercontroller` 提供 PDF、網頁檔案、快取；`autovisualiser` 提供圖表；`commonqueries` 提供時間、位置及天氣。後三者共用 Rust `codebuddy-tools`。工具目錄在本機產物通過身份校驗後才顯示可用，可用不代表已啟用、已連線或 TCC 已授權。Mac 文檔服務不另公開桌面/腳本路由，不自動安裝 Peekaboo。外部 MCP、模型對話、專案編輯、Office 與歷史恢復沿用既有鏈路，仍待實機驗收。

## 本機準備

使用本批原始碼及鎖檔，準備原生 Node 24+、專案指定 pnpm、Git、Go 1.22+、Xcode Command Line Tools，以及 `rust-toolchain.toml` 指定的 Rust/原生 Apple target。依賴須在 Mac 準備，不共用 Windows `node_modules` 或 Python。Rust 依賴需預先備妥；工具建置使用離線 Cargo，Go 不自動下載工具鏈或模組。`CODEBUDDY_GO_EXECUTABLE` 可指定既有 Go。下載及安裝屬獨立準備步驟，本批已依授權完成。

取得下載授權後，從倉庫根目錄執行：

```bash
corepack pnpm --dir ui install --frozen-lockfile
npm ci --prefix runtime --ignore-scripts --no-audit --no-fund
npm ci --prefix runtime/harness --ignore-scripts --no-audit --no-fund
npm ci --prefix scripts/office-builder --ignore-scripts --no-audit --no-fund
node scripts/prepare-harness-office.mjs
```

Office 使用鎖定官方建置器，自動選擇 `mac-arm64` 或 `mac-x64`。既有 `runtime/py`、`runtime/office` 會保留並回報錯誤；先核對來源，不直接覆蓋或刪除。封裝複製既有 Office 載荷，並從當批原始碼建置獨立工具，不下載依賴。

## 啟動與封裝

```bash
bash ./start-preview.sh
node scripts/build-harness-macos.cjs --arch arm64 --node-license /absolute/path/to/Node/LICENSE
```

啟動可透過 `CODEBUDDY_NODE` 選擇既有 Node。封裝須由目標架構 Node 執行，`--node-license` 指向該 Node 分發包的授權文件。`bundle:mac`、`bundle:default`、`bundle:intel` 使用相同 Harness 實作；舊 `--backend` 參數已退出。

開發啟動先執行 `scripts/prepare-harness-macos-tools.cjs` 建置及同步本機 Rust/Go/Swift 工具，失敗即停止。可獨立執行 `node scripts/prepare-harness-macos-tools.cjs --arch arm64`。預設不執行測試；本機清單/產物不提交，原 Windows 來源與產物保留。封裝每次使用新的工具暫存目錄。

`runtime/tools/artifacts.json` 記錄固定三個工具檔案的大小、SHA256、架構。執行時校驗普通檔案及執行權限，電腦控制前端和 Swift helper 同時檢查。依 [osx-sign 原始碼](https://github.com/electron/osx-sign/blob/main/src/sign.ts) 及 [Apple 嵌套簽名規則](https://developer.apple.com/library/archive/technotes/tn2206/)，內部簽名後、外層封裝前更新最終雜湊並保留來源，不在已簽名應用啟動時改資源。

使用者須授予目前應用螢幕錄製/輔助使用權限，工具不自行授權；`doctor` 唯讀回報實際狀態。鎖屏或錯誤登入會話拒絕觀察/輸入。`cmd`/`super` 為 Command，`ctrl` 為 Control；動作綁定最新觀察，未知結果先重觀，不重播。開發 helper 與安裝版的 TCC 身份可能不同。

Apple Silicon 產物位於 `ui/desktop/out/CodeBuddy-darwin-arm64/`，包括 `.app`、`CodeBuddy-arm64.dmg`、`CodeBuddy.zip`、`artifacts.json`、`SHA256SUMS`。Intel 使用 `--arch x64`，ZIP 為 `CodeBuddy_intel_mac.zip`。記錄 revision、dirty 狀態及簽名前載荷摘要；安裝介質雜湊對應最終產物。

預設 ad-hoc 簽名；使用 `CODEBUDDY_MAC_SIGN_IDENTITY` 明確選擇既有憑證。Developer ID 公證另需 `APPLE_TEAM_ID`、`APPLE_ID`、`APPLE_ID_PASSWORD`。本機已依授權使用開發憑證簽名，尚未執行公證或公開分發驗收。參考 [Forge 官方文件](https://www.electronforge.io/guides/code-signing/code-signing-macos)，不新增封裝框架。

## 後續測試

統一測試命令如下；各批次須分別記錄原始碼身份、退出碼與產物，歷史通過項不替代目前批次重測：

```bash
corepack pnpm --dir ui/desktop run test:macos-package
corepack pnpm --dir ui/desktop run test:macos-native
corepack pnpm --dir ui/desktop run typecheck
npm --prefix runtime test
cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1
corepack pnpm --dir ui/desktop run test:macos-smoke
corepack pnpm --dir ui/desktop run test:macos-install
```

後兩項需使用同批 Mac 產物。`test:macos-native` 在本機執行 Go/Swift 合同測試。回歸涵蓋工具身份、架構/路徑拒絕、helper 缺失、簽名後雜湊及文檔清單。本批原生合同、簽名升級與 TCC 實際呼叫結果見末節。封裝檢查四個 MCP 的真實發現，不代表桌面輸入通過。

介面 smoke 不代表真實模型或完整使用流程通過。後續透過 RustDesk 驗收 Finder 啟動、中文專案、模型與工具呼叫、退出重啟及歷史持久化；電腦控制另驗 TCC、截圖、中文輸入、視窗切換及動作後置結果，記錄原始碼身份與產物雜湊。

開發資料/日誌位於 `.preview-data`；安裝版沿用 `~/.CodeBuddy-Harness`，執行日誌位於 `logs/harness`。使用獨立測試 profile，保留既有使用者資料。

## Mac 憑證保護（2026-10-16）

Mac 使用獨立 `codebuddy-credentials` Swift helper，將隨機 256 位元主金鑰保存在目前使用者 Keychain，設定僅儲存 `macos-keychain-aesgcm-v1` AES-GCM 密文。解密不建立金鑰；金鑰遺失、鎖定、密文損壞及跨平台記錄均回報錯誤。Windows 繼續使用 DPAPI。helper 隨原生工具建置、驗證和簽署，執行時不需要 Swift 編譯器。系統授權提示由使用者處理。

執行 runtime 測試前先執行 `node scripts/prepare-harness-macos-tools.cjs --arch arm64`，準備本批四個固定原生產物。`test:macos-native` 同時執行獨立 Keychain 測試，使用隨機測試服務名稱和虛構值，結束時僅清理該測試項目。

歷史狀態：Mac 相依套件及 Office 載荷準備、Go/Swift 原生元件與型別檢查已完成。首輪 runtime 的 311 通過、46 失敗、6 跳過屬於修復前記錄。後續 v6 套件驗證已涵蓋憑證保護，原生封裝、套件 smoke 與 DMG 安裝 smoke 均退出 0；安裝版時間、快取、PDF 擷取及圖表回執已驗證，電腦控制截圖後輸入仍待修復驗收。這些結果不代表目前簽名批次或完整產品 E2E 通過。

## 簽名身分與升級權限（2026-10-19）

以下為 10 月 19 日歷史狀態；最新結果見 v14 驗收節。

簽名建置必須明確設定 CODEBUDDY_MAC_SIGN_IDENTITY 為憑證完整名稱。Apple Development 用於本機開發驗收；Developer ID Application 用於站外散布。設定 APPLE_TEAM_ID 時還須提供相符的 Developer ID 身分及既有公證憑據。未選擇身分的建置仍為 ad-hoc，不保證跨建置保留隱私授權。

建置後讀取主程式與四個原生工具的實際簽名，核對憑證、Team ID 和應用程式識別碼，並在 artifacts.json 記錄 designated requirement；環境變數不再作為簽名成功證據。升級不應慣例重設 TCC 或刪除權限項目。保持應用程式識別碼、簽名身分與安裝位置連續，於實際覆蓋升級後檢查錄影、輔助使用和 Keychain。即時權限查詢已存在，但不取代系統授權。

參考：[Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Electron osx-sign](https://github.com/electron/osx-sign)。本機開發憑證的升級保留驗收正在執行；Developer ID 散布與公證尚未驗收。

v10 本機驗收使用 `Apple Development: YuanHong Lin (U3ZPY586Q2)`，實際簽名 Team ID 為 `R3JK7R29AC`。憑證名稱末尾的個人識別碼與 Team ID 不同，以實際簽名為準。同一安裝副本的虛構憑據加密/解密基線已通過；仍須用下一次建置解密原密文，基線通過不代表跨版本連續性通過。

錄影與輔助使用已為固定安裝位置的新簽名副本重新加入。安裝版已執行時間、快取、PDF 擷取及圖表回執檢查，電腦控制仍在前景視窗校驗處失敗。後續須依真實工具回執修復，再驗證截圖、中文輸入與儲存；權限開關啟用和工具探索成功均不代替輸入驗收。

## 安裝版電腦控制修復（2026-10-20）

在實際安裝版子程序重現兩項獨立問題：`NSWorkspace.frontmostApplication` 的程序編號為 `-1`，而系統輔助使用介面回報正確的輸入應用程式；Dock 的全螢幕透明追蹤視窗又被幾何遮擋判斷誤認為會攔截所有點擊。

原生執行程式現在讀取系統級 `AXFocusedApplication`，拒絕未知身分或有效身分衝突；視窗矩形不足以可靠代表輸入目標時，使用系統級 `AXUIElementCopyElementAtPosition` 確認實際命中的應用程式及視窗。保留目標 PID、視窗、元素、幾何、焦點及真實遮擋校驗，不依應用程式名稱忽略視窗。原生回歸涵蓋無效 AppKit PID、身分衝突及全螢幕追蹤視窗。

依據：[Apple 焦點應用程式屬性](https://developer.apple.com/documentation/applicationservices/kaxfocusedapplicationattribute)、[Apple 座標命中介面](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)。採用系統既有 API，未新增相依套件。

另一次輸入失敗由遠控工作階段殘留的 Command 修飾鍵引起：原生事件預設繼承系統修飾鍵，導致一般文字被解讀為快捷鍵。一般滑鼠、捲動和文字事件現在明確使用空修飾鍵；`press_key` 繼續使用請求中明確指定的修飾鍵。修復前後在相同殘留 Command 狀態下執行了中文、Emoji 輸入與儲存對比。

## v14 本機驗收結果（2026-10-20）

建置來源為遠端 `732113504de3601ab087a609ce20827b814db2c2` 的既有 dirty Mac 批次，加 v11–v14 簽名與電腦控制增量；不是目前本機 main 的完整快照。產物版本 `1.43.5`，Apple Silicon arm64，簽名身分和安裝位置保持連續。

| 驗證 | 結果 |
| --- | --- |
| `test:macos-package` | 20 通過、0 失敗，退出 0 |
| `buildMacComputer(..., {test:true})` | Swift 合同測試與編譯退出 0；Go 測試重用有效快取 |
| `build-harness-macos.cjs --arch arm64` | 原生 DMG/ZIP 建置退出 0 |
| `test:macos-smoke`、`test:macos-install` | 均退出 0 |
| 安裝版 MCP 核心與擴充驗收腳本 | 均退出 0 |
| 安裝版憑據連續性腳本 | 退出 0，v10 密文在 v14 中解密成功 |

真實 TextEdit 流程涵蓋 `list_apps`、`get_app_state`、`click`、`type_text`、`press_key`、`perform_secondary_action`、`scroll`、`set_value`、`drag`。核對截圖、中文/Emoji 儲存檔案、捲動條數值及視窗實際幾何；真實遮擋視窗下的點擊在傳送輸入前被拒絕。獨立 MCP 驗證時間查詢、快取清單、真實 PDF 文字擷取及圖表回執。核心工作階段為 `f1b59a6b-dcb8-4e02-b2f0-ccf0b65af0aa`，擴充工作階段為 `249d9332-9d9a-43c6-bef5-5078053e4507`。

本輪覆蓋升級沒有重設 TCC、刪除權限或重新新增項目；實際截圖和輸入繼續可用。舊 Keychain 虛構密文跨 v10、v12、v13、v14 驗證通過。SSH 工作階段中的鑰匙圈鎖定經正常解鎖後複測通過，鎖定與升級遺失授權應分別判斷。

本機記錄與安裝包位於 `.preview-evidence/mac-acceptance-20261020/v14/`。DMG SHA256：`9438f4584282d19730f78add458f7807568633f783e98663857b6e83596f099a`；簽名前載荷摘要：`9236280515eea0bd4f50678cd18c2d17bdb8193edc100c6d8002d58b92eb4a51`。

尚未執行真實模型驅動的完整對話、Finder 手動拖放、Intel 驗收、Developer ID 公證與公開分發驗收。測試使用獨立 profile 和虛構值；以上結果不證明其他對話最新功能通過。macOS 14 的 `activateIgnoringOtherApps` 棄用警告仍存在，未影響本批驗收。
