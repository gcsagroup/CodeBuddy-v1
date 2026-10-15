# 第一版基礎能力：目前交付記錄

本記錄取代早期一般聊天預覽說明。工作目錄為 `D:\CodeBuddy-v1`；來源包含原專案當時檔案及未提交修改，逐檔基線見 [source-baseline.json](source-baseline.json)。目標目錄尚未初始化 Git，本批未建立開發分支、提交或推送，原專案保留。

## 啟動與工作區

雙擊 [start-preview.cmd](../../start-preview.cmd) 開啟最新 CodePro 工作台。已儲存的 Ollama 雲端 `kimi-k3` 設定繼續使用，也可在原設定頁切換服務。目前為 Windows 開發預覽，尚未交付安裝包。

最終實例於 18:57（Asia/Shanghai）啟動，18:59 核驗標題 `CodeBuddy`、原新任務路由及預設目錄；Electron 主程序 29836、後端 29100，視窗留在新任務頁。[啟動與原始碼回執](../../.preview-evidence/foundations-preview.json)、[截圖](../../.preview-evidence/foundations-preview.png)。程序編號為當次快照，之後以 `launch.json` 為準。

新任務直接輸入需求即可。預設容器為 `D:\CodeBuddy-Workspace`，每個新任務分配獨立子目錄；主動選擇既有專案時使用所選目錄。重新啟動後開啟開發中的歷史任務，原介面會要求重新確認專案綁定。

介面、元件、樣式、文字及原 SDK 原始碼保持基線。修改集中在 Electron 啟動與通訊、Harness 適配、工具與持久化。最新版使用輸入框的「停止」按鈕，之後在原對話輸入「繼續」續作。

## 已接通的基礎流程

- 官方 Harness 執行對話、檔案編輯、搜尋、PowerShell、背景任務及子 Agent；宿主保存計畫、依賴、工具回執、審批與恢復事實。
- 原設定頁支援自訂模型、預設模型、角色路由、思考強度、壓縮、提示模板、AGENTS.md、MCP 與權限；輔助視覺使用唯讀會話。
- 工具箱接入檔案/命令、專案記憶、Git 及獨立 MCP；原電腦控制、文件與視覺化 MCP 已連接。停用及拒絕審批實際限制呼叫。
- 記憶復用 Harness `storage-domain/storage-json`，支援查看、編輯、候選審核、到期與匯出；核准的專案記錄才進入召回。
- 常用任務支援基礎參數、模板、模型與擴充；自動任務支援儲存、立即執行及暫停，匯入的舊排程保持暫停。
- 歷史、匯出/匯入、編輯/重試/分叉、目錄切換與 MCP 資源已接；舊歷史唯讀，不恢復舊 Agent 的未完成執行。
- Git 面板接通 7 個讀取工具，以及暫存、取消暫存、提交、建立並切換分支、切換既有分支；Review 使用獨立 Harness 會話。

詳細邊界見 [功能矩陣](v1-functionality.zh-TW.md)。實作、自動測試、受控介面與真實模型驗收分開記錄。

## 驗收證據

| 場景 | 結果與證據 |
|---|---|
| 目前完整後端與啟動器回歸 | Node.js 24 序列執行 runtime/tests、runtime/harness/test 及 scripts 測試；286/286，0 失敗/取消/跳過，退出碼 0；[最終日誌](../../.preview-evidence/foundations-all-tests-final.log) |
| Kimi + 原 Electron + 預設目錄 | 真實檔案與測試工具，獨立 3/3，退出碼 0；[回執](../../.preview-evidence/real-codepro-ui.json) |
| Kimi 多模組開發 | money/invoice，獨立 8/8；[回執](../../.preview-evidence/real-codepro-latest.json) |
| Kimi 暫停、伺服器重啟、同 run 續作 | 約 233 秒，獨立 15/15；既有檔案雜湊與修改時間不變、原回執唯一；[說明](2026-10-14-real-codepro-resume.zh-TW.md) |
| 原 Electron 停止、關窗、重啟、歷史恢復及繼續 | 受控本機模型、官方 Harness、真實工具；畫面完成與測試通過，獨立 3/3，頁面及控制台錯誤為 0；[回執](../../.preview-evidence/controlled-ui-resume-RnxtKT/receipt.json) |
| 實際內建 MCP | 5 次 list_apps、DOCX 建立/擷取、快取與 Mermaid；[回執](../../.preview-evidence/builtin-execution-latest.json) |
| 原設定頁 | 9 頁開啟，記憶/個人化開關及全域 AGENTS.md 真實儲存與重開；[回執](../../.preview-evidence/first-version-I9je8k/settings-ui-receipt.json) |
| 原前端測試 | 10 檔案、80 測試通過；[日誌](../../.preview-evidence/frontend-foundations-tests.log) |

這些證據僅覆蓋對應路徑，不代表小時級任務、大型正式專案、所有桌面工具或全部入口已驗收。

## 遷移與資料

舊 profile `C:\Users\jiangrui\.CodeAgentPro\profiles\local` 唯讀匯入新版。616 條使用者/CodePro 歷史及完整 SQLite 快照保留；Kimi 設定保持，其他服務補缺，匯入擴充預設停用；1 條排程暫停。14 條舊記憶中，3 條映射至仍存在的專案並進入 Harness 儲存，另 11 條對應已消失的目錄，保留於遷移檔案，不虛構專案。

最終重啟後，原 Electron 再次開啟 51 則訊息的舊對話；616 條歷史保留、Kimi 設定逐欄一致、頁面錯誤為零。見[歷史介面回執](../../.preview-evidence/migrated-history-ui.json)。

- 資料：`.preview-data/backend`；Electron profile：`.preview-data/state/electron-app`。
- 程序與連接埠：`.preview-data/logs/preview/launch.json`；同目錄含 `runtime.log`、`electron.log`。
- 遷移檔案：`.preview-data/backend/legacy`；映射明細：`.preview-data/validation/legacy-memory-mapping-report.json`。
- 凍結檢查：`node scripts/create-source-baseline.mjs --verify`，只核驗，不重建基線。

原專案目前 HEAD 為 `dfdc47fb1a8d483fc02293b85d977e87a8969f10`，1074 個 UI 檔案仍與捕獲基線完全一致；新版 1069 個凍結檔案亦全部匹配。見[來源核對](../../.preview-evidence/source-ui-current.json)與[凍結檢查](../../.preview-evidence/frontend-baseline-final.log)。

## 待完成

全部前端功能仍為目標。Git 遠端、還原及衝突處理、GitHub 登入/PR/Issue/CI、Provider OAuth、Nostr、本機 ASR、複雜配方仍有接入項。雲端語音、實際視覺品質、完整電腦操作、小時級任務、大型專案、Windows 安裝包及 macOS 各自待驗。此版是可執行、可檢查的基礎預覽，尚未標記全功能首版完成。
