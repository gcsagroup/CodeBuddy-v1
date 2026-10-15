# 專案分析上下文超限修復

2026-09-14

程式碼修復、自動化驗證及後端建置通過；真實模型及完整桌面驗收因閘道拒絕連線而受阻，尚未完成驗收。

閘道可以回答一般問候，但以 HTTP 413 / context_exceeded 拒絕較大的分析請求。用戶端顯示的 128k 不能證明閘道實際允許這麼多內容。分析路徑原先載入過多擴充說明和工具定義；長工具結果也會進入後續請求。另外，壓縮清理在單筆或奇數筆工具結果時存在索引錯誤。

唯讀分析先提供檔案讀取、目錄、搜尋及受限 shell，其餘已啟用的唯讀工具按需載入。每次載入 1～3 個定義並取代目前選擇；載入本身不執行工具，也不算完成取證。保留原權限、工作區、使用者及專案指令。

長工具文字在模型請求中改為首尾各 512 字元的明確節錄；需要中段內容時繼續定向讀取。完整工具結果仍保存在使用者可見歷史中。此預算針對每筆工具結果的文字，不是整個請求、圖片或結構化內容的容量保證。

修正單筆、奇數筆工具結果的壓縮清理，並檢查壓縮是否真正縮減模型上下文；無效時保留歷史、明確回報未完成。一般聊天及其他執行路徑維持現有行為。

採用公開的工具按需載入原則；目前介面是 Chat Completions，因此不直接接入 Responses 專屬 defer_loading 或 /compact。沒有推斷 Codex 私有實作。 [OpenAI Agents SDK tools](https://openai.github.io/openai-agents-python/tools/)

分析回歸 42 通過；壓縮專項 13 通過；完整後端 3297 通過、0 失敗、2 忽略；ACP 與控制 129 通過、0 失敗、0 忽略（1+59+55+3+11）。格式及嚴格 Clippy 通過。專項測試已包含在完整後端測試中，不應直接相加為總覆蓋數量。以上命令工作目錄均為 D:\CodeBuddy，退出碼均為 0。

```text
cargo test -p goose --lib analysis --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --lib context_mgmt::tests --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --lib --features code-mode --jobs 1 -- --test-threads=1
cargo fmt --all --check
cargo clippy --all-targets --features code-mode --jobs 1 -- -D warnings
cargo test -p goose --test acp_custom_provider_methods_test --test acp_custom_requests_test --test acp_server_test --test codepro_control_command --test codepro_control_reducer --features code-mode --jobs 1 -- --test-threads=1
```

V2 在真實閘道上前兩輪分析成功，但第三輪約 60 KB 檔案分析仍失敗。該失敗紀錄已保留，不能將 ACP end_turn 或測試程式退出 0 視為任務成功。V3 驗收必須核對實際報告中的檔案依據及末尾標識，並檢查舊失敗對話恢復及重新整理後的持久化。

目前安裝包及使用者已執行的舊後端尚未更新；程式碼驗證不等於安裝包交付。測試憑證不寫入本報告。

Evidence: `.cargo/evidence/analysis-context-20260914/` (`source-v3.json`, `v3/gates.json`, `v3/*.log`, `real-analysis-acp-v2-failed.json`, `real-request-sizes-v2-failed.json`).

V3 後端建置退出 0。真實 ACP 對話 20260914_4 第一輪回報模型服務暫時不可用，未產生專案分析，驗收程式退出 1。隨後模型清單及聊天介面皆無法連線；2026-09-14 16:53（亞洲/上海）複查仍為 ECONNREFUSED，目標 192.168.9.107:8080。此結果屬外部服務無法連線，不能宣稱上下文修復的真實驗收通過。

獨立 Electron 執行個體已使用新版後端啟動並顯示舊對話清單。舊失敗對話續分析、檔案末尾標識、真實專案分析及重新整理持久化仍未完成；沒有修改使用者正在使用的舊後端。閘道恢復後先重跑 accept-analysis.mjs 與 accept-repository.mjs，再完成原生桌面舊對話恢復及重新整理驗證。

```text
cargo build -p goose-cli --features code-mode --jobs 1
node .cargo/evidence/analysis-context-20260914/accept-analysis.mjs
```

Backend SHA256: `B17C4F9FF00F63FE8D8483E85015BF345ED70472122671BC372B6A120D43BAF2`

Latest evidence: `v3/fixed-binary.json`, `v3/gateway-availability.json`, `real-analysis-acp.json`, `native-launch.json`.
