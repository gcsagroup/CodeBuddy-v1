# 工具與技能目錄的 SDK 適配

適配減少未使用能力的常駐輸入，保留完整工具與技能呼叫，不刪減使用者指令、專案規則、權限或已載入的技能正文。

## 設計與相容性

SDK 鎖定 `0.2.1-alpha.2`，檢查技能外掛及註冊表來源雜湊後於記憶體套用，不修改 `node_modules`。主 Agent 的技能摘要索引限 640 字元，專案／使用者安裝技能優先；規則另行保留。完整原生 `source.entries` 仍持久化，但不送入模型正文。子 Agent 或缺少相容搜尋工具時保留完整原生展示。

`search_mcp_tools({kind:"skills",query,offset})` 每頁最多回傳 5 個目前允許呼叫的摘要。無結果時可換詞或空查詢分頁；正文仍由原生 `skill({name})` 載入。MCP 服務名稱索引限 320 字元，工具定義按需載入。`discoveryOnly` 回執明確區分搜尋與執行，搜尋不授權。

檔案技能沿用目錄的文件版本雜湊，透過原生已選候選傳遞，正文變更觸發原生目錄更新及重新載入提示。不另建註冊表或權限狀態；未提供版本的其他 provider 保留既有失效語義。診斷僅記錄字元／位元組統計；實際 token 以服務 usage 為準。

移除 `profile.mjs` 的 `catalogIndexMaxCharacters` 即回復完整展示。可選 `source.presentation` 和 entry `revision` 相容舊紀錄，必要時重新發布；不刪除、重寫或遷移使用者歷史。舊長目錄不會被追溯抹除，壓縮仍由 Harness 負責。

## 驗證與限制

回歸涵蓋 10／100／1,000 技能的最終 HTTP 請求大小、完整分頁、scope、呼叫策略、熱增刪、正文更新、回退、冷恢復、原生載入和工具拒絕。原生合同測試涵蓋 driver、模型中繼資料和服務入口。

早期問候樣本記錄了 1,368 → 948，但診斷沒有完整保留快取欄位，無法追溯重建完整輸入；後續以修正統計口徑後的樣本為準。夾具不是截圖中的完整設定，不能冒充對 2,277 的同條件比較，也未證明達到 40% 目標。

更正：早期工具／技能樣本僅累加原生 `inputTokens`，漏記 `cacheReadTokens`／`cacheWriteTokens`。之前的 6,692 → 3,223 與 13,386 → 4,367 是未快取輸入，不能證明總輸入降低或計費節省。診斷現保留快取讀寫及總 token；完整輸入為未快取輸入＋快取讀取＋快取寫入。舊證據保留，但不再作為整輪優化依據。

測試曾找出正文更新未重載和定義查詢被當作執行結果，修正後重測；初始失敗證據保留。回執及提示不能保證模型永不編造結果，必須核對真正的工具呼叫與傳回資料。

本輪是 Windows 源碼的 SDK／真實模型驗證，尚非 Windows／Mac 完整桌面 E2E，未重建安裝包。現有 Node 24 以 `node --test` 執行 `runtime/harness/test/` 的 skill-discovery、tool-discovery、computer-skill、capabilities、transport-observation、request-fit-contract，以及 `runtime/tests/` 的 toolbox-hot-update、shared-skills 測試檔。逐請求資料位於本地 `.local/context-budget-plan-20261124/`，不提交；依 README 重啟後才會套用至預覽。

設計參考 [工具上下文管理](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context)、[MCP 按需載入討論](https://www.anthropic.com/research/code-execution-with-mcp)、[Agent Skills 規範](https://agentskills.io/specification)。未複製外部程式碼、增加依賴或新建語義路由模型。

## 2026-11-24 深度複驗

修正統計後的 36 個真實模型任務全部通過功能核驗，每類每版 3 次。完整輸入中位數（基線／進一步壓縮／保守壓縮）：問候 945／851／905；技能 5,808／5,576／8,482；續輪寫入及讀回 18,365／18,893／24,667；MCP 6,957／9,142／7,987。包含快取及重送歷史。兩版均未證明整輪穩定節省，已撤回，恢復原有載入策略及 640 字元索引。小樣本不可將差異歸因於單句提示，也不代表一般回歸幅度。保留原生快取讀寫與總 token 診斷修復，不改桌面計費或執行協定。

相關 89 項回歸通過，最終受影響 35 項再次通過，退出碼 0。另有連續資料更新、技能授權拒絕、正文熱更新及冷恢復紀錄。初始驗收器誤將 PowerShell 的正確寫入判成失敗，原始紀錄保留；修正後上述 36 項全部通過。

main / 3a28db09 加未提交修改；未提交、推送、重啟桌面或產生安裝包，未執行 Windows/Mac 桌面 E2E。證據：.local/context-depth-20261124/acceptance.json。真實模型夾具自行關閉並清理；先前被自動策略阻止的舊目錄清理未重試。
