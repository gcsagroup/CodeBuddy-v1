# 首版 Harness 預覽實施計畫

執行：在已核准的 `D:\CodeBuddy-v1` 中拆分任務並行實作，逐項測試及審查；不建立分支或提交。

**目標：** 原 CodeBuddy 介面連接真實 Harness，交付可啟動、可查看且能力邊界清楚的 Windows 開發預覽。

**架構：** 保持原介面及 SDK 合約；Node ACP 相容服務連接固定版本 Harness driver；新版獨立儲存，舊核心不承擔新任務。

**技術：** Electron/React/TypeScript、Node、WebSocket JSON-RPC、deepseek-harness。

**2026-10-14 進度：** 首版實作與交付已完成：整合測試 40/40、原 UI/連線/路由測試 40/40，1069 個凍結檔案一致。原 Electron 設定與一般聊天路徑完成真實模型驗收，並已啟動無偵錯連接埠的使用者實例（Electron PID 2196）。預設 CodePro 新任務、MCP、舊資料遷移、macOS 與完整產品驗收仍待完成。執行方式、證據與邊界見[首版說明](2026-10-14-preview-status.zh-TW.md)。

**真實模型與交付：** 使用者親自設定 `https://ollama.com` 的 `kimi-k3`，明確同意保留設定並繼續驗證。一般聊天 3 輪均回傳指定文字與 token usage；重新啟動後歷史回放與即時使用者/助手 6 則訊息順序通過，均未呼叫工具。新版設定與 Harness 工作階段已儲存至預設 `.preview-data`。`start-chat-preview.cmd` 可選開啟原一般模式；預設 `start-preview.cmd` 的 CodePro 路由維持不變。完整任務、真實模型工具執行與取消、CodePro 等能力繼續個別驗收。

## 全域約束

- 凍結介面、互動、文字與樣式；只調整宿主啟動、連線與打包。
- 基線含原專案尚未提交的修改；原專案唯讀。
- 上游調研 SHA：`d743267388641bc76f17c45ce8b4c231aed1d32c`；安裝須記錄實際套件版本及原始碼識別。
- 獨立資料、程序與應用程式識別；不接管舊協定、不修改系統 PATH、不自動遷移憑證。
- 本輪交付已驗證的預覽，其餘整體方案功能列入遷移清單，不以佔位成功冒充接通。

## 任務 1：原始碼基線

檔案：`scripts/create-source-baseline.mjs`、`docs/reconstruction/source-baseline.json`。

- [x] 以 `git ls-files -z --cached --others --exclude-standard` 取得原始檔並複製；排除建置產物、依賴及私人檔案。
- [x] 逐檔記錄 SHA256；複製後前端雜湊與來源一致；拒絕覆寫內容不同的既有檔案。
- [x] 記錄來源 HEAD、dirty 狀態及實際複製清單。

驗證：`node scripts/create-source-baseline.mjs --verify`，凍結檔案須全數一致。

## 任務 2：真實 Harness driver

檔案：`runtime/harness/index.mjs`、`runtime/harness/package.json`、`runtime/harness/test/`。

```js
const driver = await createHarnessDriver({ dataDir });
await driver.createSession({ sessionId, cwd, provider, model });
await driver.prompt(sessionId, content, { onEvent, signal });
await driver.cancel(sessionId);
await driver.close();
```

- [x] 固定上游依賴並驗證可載入，使用上游執行迴圈。
- [x] 接入工作階段、即時正文/思考、工具回執與取消。
- [x] 使用受控模型協定夾具驗證真實 Harness 路徑；真實供應商另行驗收。

驗證：`node --test runtime/harness/test/*.test.mjs`；記錄 Node 絕對路徑。

## 任務 3：ACP 相容與持久化

檔案：`runtime/server.mjs`、`runtime/compat.mjs`、`runtime/store.mjs`、`runtime/tests/`。

- [x] 實作本機驗證、initialize、工作階段建立/載入/清單、prompt、cancel 及原介面必要設定/provider 介面。
- [x] 映射真實 driver 事件，獨立控制連線可在 prompt 執行中停止。
- [x] 儲存新版歷史與設定；未接通方法回報明確協定錯誤。
- [x] 測試錯誤憑證、未知方法、工具/思考順序、取消、重新啟動後歷史與狀態隔離。

驗證：`node --test runtime/tests/*.test.mjs`。

## 任務 4：Electron 接線

檔案：`ui/desktop/src/main.ts`、`scripts/start-harness-preview.cjs`、`start-preview.ps1`、`start-preview.cmd`、`start-chat-preview.cmd`。`gooseServe.ts`、`preload.ts`、renderer 無須修改。

- [x] 啟動新版 Node 服務，沿用原 ACP 用戶端。
- [x] 隔離 userData、協定註冊及自動更新；保留原介面。
- [x] 執行元件/型別檢查，再使用真實 Electron 入口啟動。

驗證：使用現有 typecheck、聚焦元件測試與首版說明中的專用啟動命令。

## 任務 5：交付

- [x] 核對凍結檔案及允許修改清單，審查相容服務不呼叫舊核心。
- [x] 執行首版真實介面關鍵路徑：設定、3 輪一般文字對話、重新啟動後歷史與訊息順序；記錄模型、PID、日誌、基線及啟動命令。
- [x] 更新簡體、繁體與英文執行說明及已完成/待遷移清單。
- [x] 啟動首版供使用者查看，分開報告自動測試、受控模型、真實模型與產品驗收。完整遷移待辦保留在首版說明與總體方案中。
