# 時間與天氣 Harness 接線與驗收

D:\CodeBuddy-v1 無.git；無新分支、提交、推送或安裝，前端原始碼未變。原始基線964bbeb1587f1c5551ee17907e0b26632c4163ce與未提交修改保留。原始碼指紋：overnight-source-commonqueries.json。

原設定頁可以保存查詢設定，但新版缺少三個工具。現重用原 Rust CommonQueriesClient，透過獨立stdio MCP提供 time_now、location_resolve、weather_get。Harness持有執行、權限與完成判定，不啟動舊Agent。

runtime store仍是設定權威，每次由宿主透過MCP原生_meta傳入五個驗證後的非敏感欄位；模型參數不能改變連網政策，其他服務不接收設定。缺失或無效資料明確拒絕，已撤除檔案鏡像。修正查詢設定保存後無條件清除初始化的問題，保留既有連線；其他設定仍依原規則失效。IANA時區驗證拒絕僅JavaScript接受的數值偏移。

沿用rmcp 1.8.0，啟用既有server feature，無新套件/版本/鎖定檔變更。[官方SDK](https://github.com/modelcontextprotocol/rust-sdk)，MIT；重用工具Apache-2.0。Windows x64預設啟用，其他缺少產物的平台停用，macOS待驗。

驗證：fmt exit0；Rust查詢12通過/1項既有公網測試略過、exit0；三個相關套件庫目標Clippy -D warnings exit0；離線鎖定goose-cli構建exit0。新工具goose-0a286375/goose.exe、332407808位元組、SHA256 `0a286375a8d30f0acbbf38f40275372a13a613dc5b5ad50fae5d0de6b23fa602`，舊產物保留。原生MCP4/4；後端集中回歸360/360、零略過、exit0、261.7秒，overnight-commonqueries-final.log。前端原元件3/3沿用既有有效證據。

真實Electron與Kimi會話3149b4e4-d124-4d1f-8fe6-6f5f0a7a3323，約899ms進入新會話：上海時間/停用連網、同會話改UTC、啟用連網並解析廣州（廣東）後用真實座標查詢Open-Meteo均通過。五次工具呼叫、三輪Harness完成；查詢服務僅初始化一次，PID37856保持。第二次時間參數為timezone:null，依既有可選語義使用設定；嚴格空物件斷言已修正，沒有產品特判。非法+01:00保存被拒絕且保留原設定，測試偏好已恢復預設。工具箱三工具發現及歷史重新載入通過；早先選擇器名稱/隱藏元素定位問題屬測試腳本。

證據：real-skills-4e2BOF/foundations-ui-receipt.json.commonQueries及commonqueries-*.png。隔離預覽runtime7580/desktop19932/exec69369/CDP9395，使用者20048未動，舊exec5859已exit0。這不是所有功能、macOS或安裝套件驗收通過的宣告。

實際程式碼變更：`runtime/common-query-settings.mjs`、`runtime/compat.mjs`、`runtime/settings.mjs`、`runtime/builtin-extensions.mjs`、`runtime/tool-policy.mjs`、`runtime/harness/index.mjs`、`runtime/harness/mcp-bridge.mjs`、`crates/goose/Cargo.toml`、`crates/goose/src/agents/platform_extensions/common_queries.rs`、`crates/goose-mcp/src/mcp_server_runner.rs`、`crates/goose-cli/src/cli.rs`；tests/settings-runtime、tests/builtin-extensions、harness/test/mcp-metadata及工具provenance。
