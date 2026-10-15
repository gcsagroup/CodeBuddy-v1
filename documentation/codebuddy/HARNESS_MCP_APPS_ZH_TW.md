# Harness MCP 應用適配記錄

日期：2026-10-14。原始碼：D:\CodeBuddy-v1 目前檔案；此目錄沒有 Git revision，本批未提交或推送。介面原始碼保持原樣。

## 實作

- `runtime/harness/mcp-bridge.mjs` 為每個工作階段的每個 MCP 服務建立單一連線，重用官方 MCP SDK Client、Harness `createMcpToolDefinition` 與 `mcpResources.register`。Harness 繼續擁有唯一模型迴圈、工具執行及審批。
- 宿主依執行 token 保存 MCP 原始回執。僅最終成功且 canonical 值與展示內容均保持一致時，才向介面恢復 `content`、`structuredContent`、`_meta`。後置策略替換結果時不恢復原資料。工具 `_meta.ui.resourceUri` 映射至原介面的 `_meta.goose.mcpApp`。
- `resources/read` 回傳 `{result: MCP ReadResourceResult}`，保留文字、blob 及資源 `_meta`。範圍限目前工作階段啟用並已連線的服務；經官方資源工具及獨立審批讀取，不插入模型歷史，支援對話期間讀取與取消。
- `runtime/mcp-apps.mjs` 實作原 ACP `apps/list/import/export/delete`；使用 GooseApp JSON-LD 匯入格式，保存於新版 profile 的 `state.mcpApps`。重名追加編號；遠端快取應用不視為本地匯入應用刪除。具備數量、大小與分頁上限。
- HTTP 沙箱由 `runtime/mcp-app-proxy.mjs` 處理；來源隔離、認證及 TTL 見 `docs/reconstruction/` 的 MCP app proxy 三語記錄。

## 驗證與界線

`node --test runtime/tests/mcp-apps.test.mjs runtime/tests/mcp-apps-harness-integration.test.mjs runtime/harness/test/mcp-apps.test.mjs runtime/tests/builtin-extensions.test.mjs runtime/harness/test/capabilities.test.mjs`：30/30 通過，退出碼 0。最後收緊後置策略的中繼資料恢復後，受影響 driver 4 項及 ACP 1 項再度通過，退出碼 0。

測試採隔離暫存 profile、真實本地 HTTP/stdio MCP、官方 Harness、受控模型回應、凍結 SDK Zod 與原介面適配器。涵蓋單一連線、審批拒絕、工作階段隔離、子代理繼承、對話中讀取、取消、stdio PID 結束、重新連線、匯入匯出刪除、重啟快取與原介面結構化結果。

真實 Electron 小應用互動、外部 MCP、雲端模型選擇應用及 macOS 不在本批自動化驗收內。凍結介面的初始聊天工具結果僅消費應用資源標記；應用後續 `tools/call` 的完整 `_meta` 已透傳。後置策略改變結果及 MCP 錯誤結果保留 Harness 最終事實，不補造成功回執。

## 依據

- [MCP Apps 官方概述](https://modelcontextprotocol.io/extensions/apps/overview) 與 [官方 SDK/規範](https://github.com/modelcontextprotocol/ext-apps)。
- 鎖定 DeepSeek Harness `0.2.1-alpha.2` 的 `dsh-mcp-client`、`dsh-mcp-resources`、`dsh-tools`（MIT）。此版官方橋省略 Apps 中繼資料，宿主適配補齊；未修改 vendored 套件。
