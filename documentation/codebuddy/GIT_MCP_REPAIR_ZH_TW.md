# Git MCP 修復與合併交接

基準：CodeBuddy main / 00a6656，加本次未提交修復。原有安裝包與 ACP 格式修改不屬於本次。

## 修復內容

1. Git 寫入仍由 MCP 執行。ExtensionManager 在清除外部偽造 metadata 後，觀察工作區與 Git 索引／引用的變化；MainAgentActionFacts 消費宿主證據。既有權責、權限與完成門檻保持原有 owner。
2. 省略或相對 path 明確綁定目前任務工作區，避免伺服器可變工作目錄與驗收範圍不一致。
3. 一般分支推送透過宿主查詢實際 push URL 的遠端 ref，提交 SHA 相同才產生 external_effect 證據。dry-run、刪除、tags、多個 push URL 及工作區外的 linked-worktree metadata 不產生此證據。
4. Windows Git 子進程使用專案既有 Job Object 管理器。MCP 的逾時／取消會結束監管進程，連帶清理子進程；請以實測結果確認。
5. status 改用 porcelain v2 的 NUL 記錄，保留中文、空白、重新命名方向和衝突檔名。merge 以未合併索引確認衝突，衝突回報錯誤並保留現場；abort 檢查退出碼。
6. Git 簽名遵循儲存庫設定，預設不額外強加上游 -S；現有明確 GIT_SIGN_COMMITS 設定保留。無互動提示，驗證失敗應交回使用者處理。

## 合併原則

獨立修改由 Git 自動合併；內容衝突由 Agent 檢查雙方需求、編輯衝突、執行相關測試，再暫存和提交。沒有足夠語意依據時保留衝突並提出具體問題，不能直接選一側覆蓋。只測試隔離倉庫及已指定的 GitHub 測試分支；產品 main 未合併或推送。

## Files / 檔案 / 文件

- crates/goose/src/agents/git_mcp.rs
- crates/goose/src/agents/extension_manager.rs
- crates/goose/src/agents/tool_execution.rs
- crates/goose/src/agents/tool_task.rs
- crates/goose/src/agents/mod.rs
- crates/goose-cli/src/main.rs
- scripts/git-mcp-adapter.cjs
- scripts/git-mcp-adapter.test.cjs

## Runtime

`@cyanheads/git-mcp-server@2.15.3` (Apache-2.0). Keep its original bundle unchanged; the adapter generates `dist/index.codebuddy.js` alongside it. A version/anchor mismatch stops configuration.

`node scripts/git-mcp-adapter.cjs RUNTIME_ROOT GOOSE_EXECUTABLE`

The executable must contain this patch. Enable `git_merge` in the existing `local_git` tool allowlist. The launcher uses the existing Node runtime and credentials; do not commit profile data, credentials, bundles or test repositories.

## Checks

- `node --test scripts/git-mcp-adapter.test.cjs`
- `cargo test -p goose --lib git_mcp --jobs 4`
- `cargo clippy -p goose-cli --bin goose --jobs 4`
- `cargo build -p goose-cli --bin goose --jobs 4`

Use the repository's Windows development build environment. See the final acceptance report for actual results; commands here are not a pass claim.

## References

- [Upstream Git MCP](https://github.com/cyanheads/git-mcp-server)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

## 補充修復：已知衝突與未知結果

介接器僅在 Git 合併進程已回傳退出碼 1、索引仍有衝突時附帶結構化衝突類別；宿主再次檢查 MERGE_HEAD 與未合併索引後，才記錄「已確認衝突」。它仍是失敗工具回執，不計為合併成功，但不會永久污染後續完成判斷。逾時、取消、一般錯誤與偽造標記繼續受未知結果檢查約束。舊會話缺少新回執的歷史錯誤不會被自動刪除。

Windows 正規化路徑的 `\\?\` 前綴在介接器邊界轉換為等價一般路徑，再繼續執行上游工作區檢查；工作區外路徑仍會被拒絕。

完成核驗缺少 expected_effect 時，錯誤訊息現在明確要求先修訂需求語意，再依新版本提交證據；外部效果應引用宿主回執中的資源識別碼，避免模型反覆提交同一個無效請求。這項改動僅改善錯誤引導，未降低證據要求。

## 2026-09-30 驗收結果（Kimi 場景通過，仍有體驗限制）

開發後端 SHA256：10385E8681E4461B36EBE3B7BBC6EF5D8BD9B46360D105445D126D6CB6D52D11。原始碼基準 main / 00a6656，加上本批尚未提交的修復；本次續測未修改後端原始碼。

- 自動驗證：Git 回歸 6/6、完成狀態回歸 50/50、介接器 4/4；前兩組重疊，不相加。Clippy 與建置退出碼 0，有 25 條既有警告。
- 真實 MCP：24 次基礎及拒絕場景呼叫（含 5 次預期拒絕）、6 次合併／衝突／撤銷呼叫；路徑邊界、取消與 60 秒逾時子進程清理均通過。
- **全新衝突聊天 20260930_28：通過。** Agent 從原始分支觸發衝突，理解並修改 fee.cjs，保留雙方行為；原測試 2/2。雙親合併提交 d5e8d68 已推送本機測試遠端，測試與草稿保持原樣；宿主 finished，沒有暫停原因。
- **GitHub 推送聊天 20260930_29：通過。** 僅提交 Kimi 驗收檔案，提交 2c791c8 在指定測試分支獨立核實，草稿未提交；宿主 finished。
- **GitHub 拉取聊天 20260930_30：通過。** 實際快轉拉取同事新提交 54c4c3d，新檔案內容、遠端 SHA 與草稿獨立核對通過；宿主 finished。

邊界與發現：本機 Qwen 先前的完整聊天驗收仍未通過；本輪 Kimi 通過不代表所有模型均穩定。Kimi 在完成核驗仍有證據編號或目標資源填錯後重試，最後回覆也會暴露內部核驗用語。會話 20260930_27 沿用先前已編輯的衝突現場，最後等待模型回覆被停止，不計為獨立解衝突通過。

使用者授權後，kimi-k3 的 /api/chat 與 /v1/chat/completions 最小工具探測均回傳 200；早先 DeepSeek 的 410 不代表整個相容介面失效。產品 Ollama 類型聊天仍呼叫 /v1/chat/completions，沒有實作原生聊天協定遷移。建立暫時提供商另觸發 Windows 憑據庫單筆 2560 字元限制；本輪重用原提供商完成測試，容量問題尚未修復。

已恢復 shell: never_allow、原 custom_1 提供商檔案與預設 deepseek-v4.1-flash。Kimi 驗收不證明原預設模型可用。憑據未寫入倉庫；原始碼尚未提交，GitHub 僅指定測試分支有驗收提交。

本機證據：D:/CodeBuddy/.cargo/codebuddy-git-mcp/acceptance-summary.json，以及 fresh-kimi-conflict-chat.json、conflict-independent-result.json、kimi-push-chat.json、kimi-pull-chat.json、kimi-*-independent-result.json。
