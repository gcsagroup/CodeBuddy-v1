# 2026-10-23 合併交接

[简体中文](2026-10-23-merge-handoff.zh-CN.md) · [English](2026-10-23-merge-handoff.en.md)

## 範圍與來源

儲存庫：`https://github.com/erjinyi-bool/CodeBuddy-v1.git`；分支：`main`；基線：`d43fcbbd0ec85afcb073cb74b14e835752a26e20`。收錄 `D:\CodeBuddy-v1` 已累積的執行期、桌面、安裝與文件變更，未新增分支或修改同事的遠端分支。提交清單見文末；實作彼此有依賴，建議整批合併。舊文件的「基線 + dirty」是當時的建置來源。

## 變更內容

| 模組 | 行為與關鍵檔案 |
| --- | --- |
| 長期目標與計畫 | `/goal`、`/plan`、`/compact`、目標狀態與編輯、暫停/恢復及計畫審核接入官方 Harness；重啟不自行恢復目標，儲存不等於執行。`runtime/goal-request.mjs`、`compat.mjs`、桌面 `acp/goals.ts`、`ComposerGoalBar`、`ComposerPlanMode`、`PlanReviewForm`、`WorkspaceGoalEditor`。 |
| 瀏覽器與電腦控制 | 新增會話綁定的 `browser_control`、工作區 HTML 預覽、觀察、輸入、點擊與截圖；過期節點、遮擋和未知結果依結構化回執處理。增加獨立 Playwright 與使用者瀏覽器擴充入口；模型選擇電腦技能，宿主管理權限。`runtime/browser-tool.mjs`、`harness/{computer-skill,playwright-entry,tool-discovery}.mjs`、`harness/skills/`、桌面 `workspace-panel/`。 |
| 圖片與工具 | 截圖經視覺路由及官方附件入庫，保存持久參照，修正續步缺少 `attachmentId`；觀察失敗仍保留已執行動作回執，取消繼續傳播。首輪提供獲准的 `write`、`edit`、`browser_control`，其他工具按需探索。`runtime/harness/index.mjs` 與測試。 |
| 預設模型 | 新安裝提供 LAN 與 Ollama Cloud；LAN 初始選中，雲端清單首項為 `kimi-k2.6`。`runtime/default-model.json` 成為共同預設來源，移除桌面重複配置。首次初始化匯入選用的分發憑據，不覆蓋既有設定或重新加入使用者刪除的預設。`store.mjs`、`providers.mjs`、`model-settings.mjs` 與桌面設定。 |
| 串流與檔案 | 串流程式碼與超過 8000 字元的歷史程式碼使用完整純文字，減少高亮成本；捲動布局寫入合併到動畫幀。區分工具參數生成與實際執行。合併真實變更和有效工作區引用、去重並保留每輪變更；調整設定導覽、工具箱分類與模型能力顯示。`MarkdownContent`、`ProgressiveMessageList`、`scroll-area`、`WorkspaceFileReferences`、`CodeProConversationFiles`、`runtime/work-status.mjs`。 |
| 桌面寵物 | 新對話輸入、檔案/圖片附件、右鍵隱藏/設定、等待問題摘要和任務跳轉；完成提醒與會話已讀事實一致，保留使用者啟用選擇；調整多螢幕與滑鼠穿透。`ui/desktop/src/pets/`。 |
| 儲存與卸載 | 移除設定頁遷移、空間統計與手動清理入口，保留既有資料位置及遷移日誌相容性；新增 macOS 卸載計畫與資料保留邊界。`runtime/storage-management.cjs`、`macos-uninstall.cjs`、桌面 `storage/macosUninstall.ts`。 |
| Windows 安裝 | 調整 Inno 進度、詳情與排版；`UsePreviousAppDir=no`，預設 `%LOCALAPPDATA%\Programs\CodeBuddy`，避免帶回舊 D 槽路徑，仍允許手動選擇。`scripts/installer/*.iss` 與原生測試。 |
| macOS 與原生助手 | DMG 背景/Finder 布局、簽名/架構/載荷檢查、執行中工具檔案替換、Keychain 驗證、AX 和按鍵處理。`ui/desktop/scripts/`、`scripts/*macos*`、`tools/macos-credentials/`、`tools/qwen-computer-use/`。 |
| 文件與語系 | 補齊功能、所有權與三語交付文件；16 個介面語系有條目及格式差異，衝突應按鍵合併，保留同事譯文。 |

執行、計畫、目標、壓縮與完成仍由官方 DeepSeek Harness 判定；Rust 僅保留獨立 MCP 工具，沒有恢復舊核心。

## 合併注意事項

1. 同事先保存目標分支的本地修改，`git fetch origin` 後核對基線及文末提交，再依團隊流程 `git merge <本批最終提交>`；不要覆蓋檔案或重設分支。
2. 重點衝突：`runtime/harness/index.mjs`、`runtime/compat.mjs`、`runtime/store.mjs`、`ChatInput.tsx`、`main.ts`、`workspace-panel/`、`pets/`、i18n、Forge 和安裝腳本。ACP、UI 與執行期關聯變更須一起保留。
3. Harness manifest 與鎖檔一起合併；新增固定 `@playwright/mcp@0.0.83`，DeepSeek 仍為 `0.2.1-alpha.2`。依 README 使用既有工具鏈，不順便升級。
4. `runtime/tools/provenance.json` 是本地產物紀錄，Git 不含原生二進位檔；依目標平台 README 準備並更新來源。Windows Qwen 是既有鎖定產物，不是本次 Go 原始碼重建的證明。
5. Windows：`node scripts/build-harness-windows.cjs <暫存目錄> --installer=inno`。Mac 依 `docs/macos-installation.zh-TW.md` 使用 `build-harness-macos.cjs` 及對應架構/簽名環境。開發入口 `start-preview.ps1` 不等於安裝版。

### 共享雲端憑據

Git 不含 `runtime/distribution-credentials.json`、真實 Key、使用者 profile、安裝包或原始驗收資料。本地交付包依使用者授權含共享 Key；從 Git 建置不會自動取得它。同樣的開箱即用行為需要擁有者透過獨立管道提供本地分發檔：

```json
{"version":1,"providers":[{"providerId":"custom_codebuddy_ollama","baseUrl":"https://ollama.com","apiKey":"<由擁有者單獨提供>"}]}
```

這是結構範例，佔位文字不是可用憑據。首次啟動匯入 DPAPI/Keychain；接收者仍可從客戶端包提取 Key，本機加密不等於分發保密。LAN 為 `http://192.168.9.101:8001`，需相應網路。22 個雲端名稱是目錄快照，並非全部驗收。

## 驗證與限制

本次提交前結果見文末，日誌保留於本機 `.preview-evidence/commit-handoff-20261023/`。

同批 Windows/Mac arm64 安裝版以隔離 profile 驗證兩個連線、LAN 對話、Cloud 寫 HTML/開啟內建瀏覽器/截圖續步和重啟後圖片歷史恢復。Mac 按鈕實測 0 → 1。Windows 遊戲流程曾長時間推理，驗收者停止並補充事實後完成，不算全自動單輪通過。`kimi-k3` 空正文已直接 API 重現，仍可選但未通過。

Windows 舊同批安裝器完成安裝/卸載及資料保留；最後預設路徑修正後，8 項原生夾具與完整建置退出 0，截圖顯示 C 槽預設，應用和執行期摘要未變。最終新 EXE 完整安裝留待使用者複測。Mac DMG 驗證、掛載、複製、簽名和啟動通過；正常 LaunchServices 啟動的 LAN 通過。SSH 直接啟動曾 `EHOSTUNREACH`，記為環境差異，不再列為等待使用者權限確認。

| 本地產物（儲存庫相對路徑） | SHA256 |
| --- | --- |
| `.preview-evidence/installer-default-path-20261023/CodeBuddy-1.43.6-windows-x64-default-path.exe` | `7255b4467173808d58968084582dde9e3d3b45fdcea0f78e4cf392b9c2b01eba` |
| `.preview-evidence/desktop-fixes-20261023/deliverables/final/CodeBuddy-1.43.6-macos-arm64.dmg` | `c34a54fe15c4af7ee79e181384e6707894aa0ca02a65dec1a446222a26915030` |

產物來自基線加本批原始碼快照，早於 Git 提交；提交不會重新產生安裝包。Windows 未簽名，Mac 開發簽名、未公證；公開下載的 SmartScreen/Gatekeeper、Mac 卸載/Finder 拖放/Intel、長期記憶體壓力和所有模型組合未驗收。本機仍有先前清理未完成的資料，普通重啟不算乾淨安裝。

## 提交及提交前複核

1. `6491d44` — Windows/macOS 打包、原生助手與預設安裝路徑（45 個檔案）。
2. `11e8c28` — Harness 目標/瀏覽器、模型預設、聊天與寵物、功能文件及測試（250 個檔案）。
3. 包含本文的 `docs: add trilingual merge handoff and acceptance boundaries` 提交 — 三語交接與舊階段紀錄狀態說明（6 個檔案）。

請整批合併。拉取後可用 `git log -1 --format=%H origin/main -- docs/reconstruction/2026-10-23-merge-handoff.zh-TW.md` 取得本文提交；交付訊息也提供最終雜湊。完整差異：`git diff d43fcbbd0ec85afcb073cb74b14e835752a26e20 <最終提交>`。

本次使用既有 Node 24.18.0，預設於儲存庫根目錄執行。

| 命令 / 檢查 | 結果及邊界 |
| --- | --- |
| `node --test runtime/tests/*.test.mjs runtime/tests/*.test.cjs runtime/harness/test/*.test.mjs` | 首跑 622 項：617 通過、4 失敗、1 跳過，退出 1。舊夾具未宣告 `tools`，首輪 `write` 斷言過期；服務因斷言提前失敗未清理而掛起，終止該測試子程序後完成彙總，不算全套通過。 |
| `node --test runtime/harness/test/driver.test.mjs`；`node --test runtime/tests/model-thinking-preferences.test.mjs runtime/tests/roles-harness-integration.test.mjs runtime/harness/test/driver.test.mjs`；最後 `node --test runtime/tests/model-thinking-preferences.test.mjs` | 修正三個測試檔案與 HTTP 清理註冊時機。driver 9 項通過；組合重跑 driver/roles 10 項通過；補齊最後 `/api/show` 夾具後 thinking 6 項通過、退出 0。未再重跑全部 622 項；產品實作沒有因此改動。 |
| `node --test scripts/harness-macos.test.cjs scripts/start-harness-preview.test.cjs ui/desktop/scripts/macos-package.test.cjs ui/desktop/scripts/codebuddy-branding.test.cjs` | 32 通過、退出 0；不代表 Mac 原生 E2E。 |
| 桌面目錄：`node ../node_modules/typescript/bin/tsc --noEmit` | 退出 0。 |
| 桌面目錄：`node scripts/i18n-check.js`、`node scripts/i18n-validate-locale.js` | 退出 0；2982 條訊息，英文來源與 15 個翻譯語系。 |
| 桌面目錄：`node ../node_modules/vitest/vitest.mjs run --maxWorkers=1` | 306 個檔案、2709 項全部通過，退出 0，857.94 秒；使用既有 `ui/node_modules`，沒有安裝或重建依賴。元件測試不等於全部桌面產品 E2E。 |
| `go test ./...` / `go vet ./...` | 目前 PATH 沒有 Go，命令未啟動，本次未重跑；Windows 未執行 Swift 原生測試。沒有 Rust 原始碼改動，未跑 Rust 全套。 |
| Git 與候選檢查 | `git diff --cached --check` 退出 0；未發現共享 Key、安裝包、大型二進位或 profile 混入。確認無 Git 程序占用後，舊索引鎖備份至本機證據目錄。 |
