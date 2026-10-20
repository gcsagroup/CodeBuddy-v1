# 遠端 MCP 工作階段恢復

## 行為與邊界

修復有工作階段的 Streamable HTTP 連線收到失效回執後持續使用舊 Mcp-Session-Id，以及停用/啟用、刪除/重新新增相同設定仍命中舊連線的問題。沿用既有 MCP bridge、SDK 和 Harness 租約管理，沒有新增排程器或修改持久化格式。

- 帶有工作階段身分的 HTTP 404 觸發既有退避重連。相容 HTTP 400 且 JSON-RPC error.code 為 -32600、error.message 精確為 Session not found 的回執；一般 400、驗證錯誤與工具文字不視為工作階段失效。
- 新 transport 重新初始化，移除設定中任何大小寫的 Mcp-Session-Id 標頭，保留驗證標頭並重新探索工具。恢復期間連線狀態為 error，恢復後為 ready。
- 原呼叫保留實際錯誤，不自動重播工具、資源請求或已受理的 Tasks。結果未知的操作不因重連而重複執行；後續獨立呼叫使用新連線。
- 全域擴充設定及聊天內擴充增刪使對應共享 preset 退役，下次使用取得新連線。既有租約繼續服務持有者，避免中斷其他聊天；釋放後由 Harness 回收。一般查詢及未涉及的設定仍可重用健康連線。
- 遵守既有重試上限、退避及退出清理，不定時替換健康工作階段 ID，也不強制遷移無工作階段協定。

## 依據

[MCP 2025-11-25 工作階段管理](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/transports.mdx#session-management) 要求失效的 404 觸發不攜帶舊 ID 的初始化。沿用已安裝的 MCP Client SDK 2.2.0 與 DeepSeek Harness 0.2.1-alpha.2（MIT），沒有新增依賴。400 處理是針對已觀察到的伺服器協定回執的相容路徑，不解析模型自然語言。

## 驗證記錄

來源：D:\\CodeBuddy-v1，main，基線 7321135 加目前工作區修改；保留其他未提交修改。現有 Node 24.19.0 執行相關回歸 74 項全部通過，退出碼 0，包含 65 秒同步呼叫及異步 Tasks。完整命令列於同名 zh-CN 文件。

補充 Tasks 工作階段遺失、重試耗盡、退出取消三項邊界測試後，執行：

```powershell
node --test runtime/harness/test/mcp-session-recovery.test.mjs runtime/tests/mcp-session-recovery-acp.test.mjs
```

10 項通過，退出碼 0。ACP 測試經由真實 WebSocket 與目前相容服務/Harness，涵蓋設定開關、刪除重加、聊天內增刪及失效恢復，使用本機隔離伺服器與資料目錄。

## 真實桌面驗收（2026-10-19，三項核心情境通過）

透過既有 `scripts/start-harness-preview.cjs` 的 `startPreview` 啟動目前工作區 Electron，使用獨立 profile、本機 MCP 與確定性模型夾具。執行端口 62957、頁面 localhost:5174；聊天 bf402e8a-b86b-4ad8-92a8-20833439ccf3。6 個核心修復檔案的 SHA-256 均與啟動前一致。桌面訊息與工具箱操作、伺服器記錄及 Harness 持久化回執共同確認：

- 基線：08:44:27 UTC，session-2，execution=1，成功。
- 404 失效恢復：08:48:58.437 舊會話遭拒，534 ms 後不帶舊 ID 初始化 session-3；下一條訊息於 08:49:20 成功，execution=2。原失敗呼叫未重放。
- 關閉再啟用：介面顯示停用後重新啟用，08:52:12 初始化 session-4，08:52:15 成功，execution=3。
- 刪除後同名同地址重加：桌面確認刪除後清單從 4 項降為 3 項，持久化設定同步移除；透過表單重建 DesktopProbe 與原地址，回到原聊天。09:15:49.251 不帶舊 ID 初始化 session-5，09:15:51.280 實際呼叫成功，execution=4。

先前控制助手曾回報快照與元素快取錯誤。本輪重置 node_repl、重新匯入 sky 並綁定既有視窗 ID 後恢復。部分無障礙元素點擊位置與畫面不一致，使用最新截圖定位、每步重新觀察，完成刪除確認、重新新增及原聊天傳送。開發頁面中途重載，重開表單後完成。未修改助手或產品原始碼；只確認本次控制鏈路恢復，不宣稱底層缺陷永久修復。

夾具的 `search_mcp_tools` 被既有聊天的擴充權限拒絕；直接 health 呼叫另由真實回執證實成功，工具搜尋路徑不列為通過。HTTP 400 僅有自動測試證據。忽略目錄 `.preview-evidence/mcp-session-desktop/` 保存 wire.jsonl、source-identity.json、8 張截圖和 profile 會話記錄。新增 06-deleted.png、07-readded.png、08-delete-readd-success.png。第 5 輪持久化 tool/result seq=93、isError=false，與伺服器及介面一致；原失敗呼叫未重放。北京時間 17:15:51 完成。

現有 Node 執行該目錄 run.mjs；啟動器仍執行，無最終退出碼。本輪雜湊、持久化查詢與三語文件檢查退出碼 0；未重跑先前通過的自動測試。三語報告已更新；未提交、推送或重新打包，真實 Hex 與安裝版未驗收。
