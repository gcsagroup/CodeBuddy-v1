# Gemma 思考與合同修訂修復記錄（2026-10-13）

[简体中文](GEMMA_CONTRACT_20261013_ZH_CN.md) · [English](GEMMA_CONTRACT_20261013_EN.md)

## 問題與變更

- Gemma 4 的思考設定原先沒有傳到 OpenAI 相容服務。`formats/openai.rs` 將 off 對應 false，low/medium/high/max 對應 true，寫入 `chat_template_kwargs.enable_thinking`。不同檔位不代表不同的 Gemma 思考預算。未指定時保留服務預設，顯式自訂模板參數優先；Qwen 既有行為保留。
- 合同結構錯誤不再籠統要求所有欄位放在根層。`main_agent_contract.rs` 使用現有 `serde_path_to_error` 與 wire 型別指出錯誤路徑及 `requirements[i].semantics.revision_relation` 的正確位置。
- `reporting/projection.rs` 仍擁有版本關係判定；缺失或過期關係會回報陣列索引、目前版本與示意結構。宿主不自動補造關係或搬移錯誤欄位。模型須依使用者要求選擇保留、替換或撤回。
- `tests/codepro_runtime.rs` 擴充既有恢復測試，確認錯誤不改變狀態、正確提交能繼續，保留原有 stale/retained 檢查。較佳回饋不保證所有模型都能遵循 schema。

## 驗證

於儲存庫根目錄執行，以下命令均退出 0：

| 命令 | 結果 |
| --- | --- |
| `cargo test -p goose-provider-types --lib formats::openai::tests --jobs 1` | 96 通過，含 Gemma 各檔位、顯式參數優先、Qwen/OpenAI 回歸 |
| `cargo test -p goose --lib main_agent_contract --jobs 1` | 3 通過，含錯層欄位及正確結構恢復 |
| `cargo test -p goose --test codepro_runtime requirement_revision_recovers_after_rejected_unknown_effect_changes --jobs 1` | 1 通過，含缺失關係拒絕後狀態不變、正確修訂恢復 |
| `cargo test -p goose --lib run_relation_tests --jobs 1` | 7 通過，含 JSON 圍欄、嚴格 schema、取消及逾時邊界 |
| `cargo fmt --all --check`、`git diff --check` | 通過 |

於 `ui/desktop` 執行 `pnpm run ensure-dev-backend`，退出 0，最終建置耗時 14 分 18 秒。新後端為 `target/debug/goose.exe`，SHA-256：`8186e7eb25a45e93d4ba29a4b56a1230985a30d5a9b8a7843f571a683f1d8b13`。既有桌面程序占用舊後端，因此沒有覆蓋該程序使用的二進位檔。

日誌：`target/mcp-discovery-20261013/` 中的 `provider-tests.log`、`contract-tests.log`、`contract-runtime-tests.log`、`relation-tests.log`、`final-backend-build.log`。原始碼校驗值見 `source-manifest.json`。

### 實際服務複測

使用上述新二進位檔執行 `node target/mcp-discovery-20261013/probe.cjs target/debug/goose.exe --expect-fixed --model --thinking --both-thinking`，退出 0。隔離 profile 透過桌面 ACP 連接實際 Gemma 服務 `http://192.168.9.101:8001`，模型 `gemma-4-26B-A4B-it-uncensored-FP8-W8A16`。

| 場景 | 思考設定 | ACP 思考分片數 | 結果 |
| --- | --- | --- | --- |
| 查詢 MCP 後，在同一對話繼續提問 | high | 325 | 正確回答 15，正常結束，無恢復解析錯誤 |
| 同一對話繼續提問 | off | 0 | 正確回答 15，正常結束 |
| 新對話 | high | 153 | 正確回答 15，正常結束 |
| 新對話 | off | 0 | 正確回答 15，正常結束 |

實際請求日誌確認 high 對應 `enable_thinking:true`，off 對應 false。證據：`target/mcp-discovery-acp-DuSQFu/result.json`、`responses.jsonl`、`profile/logs/llm_request.*.jsonl`；建置後原始碼雜湊與 manifest 一致。

前一次同源複測 `target/mcp-discovery-acp-BdMMVj/` 的恢復判斷及回答成功，但「high 必須每次產生可見思考」斷言失敗：請求已開啟思考，分類器收到 622 個思考分片，最後簡單算術回答只有正文。內部分類分片不應顯示為使用者回答的思考。最終驗收分別核對 wire 參數、恢復成功與實際回答分片，保留差異紀錄；分片數不是穩定效能指標，也不承諾每次開啟都輸出思考。

### 驗收邊界

自動測試驗證錯誤輸入及正確修訂的狀態變化，尚未重播原「飛機大戰」任務的完整開發流程。未執行完整 Electron 桌面、Mac 真機或安裝包驗收；本批未執行 Clippy，合併前仍須相應檢查。建置與 ACP 聯網測試不取代桌面驗收。

## 交接

- 來源：`main / 964bbeb1587f1c5551ee17907e0b26632c4163ce` 加未提交變更；另有 [MCP 修復](MCP_DISCOVERY_20261013_ZH_TW.md)。
- 未修改使用者模型設定、憑據或歷史對話，未提交或推送。Windows/macOS 共用 Rust 層，但 Windows 驗證不等於 Mac 真機通過；舊安裝包未包含本批變更。
- 本機上下文設定與服務模型資訊的差異尚需單獨核對，沒有認定為此次失敗原因。
- 依據：[vLLM Gemma 4 文件](https://docs.vllm.ai/projects/recipes/en/stable/Google/Gemma4.html#thinking-reasoning-mode)。

## 聯網複測發現的關聯問題

Gemma 開啟思考後的恢復分類返回完整 JSON 圍欄，內容是合法的 `{"kind":"question"}`，舊入口直接解碼而報無效資料。證據：`target/mcp-discovery-acp-TjnShw/`。

`agents/agent_clarification.rs` 的兩個恢復分類入口使用局部格式解析，只接受裸 JSON 或單個完整普通/JSON 圍欄，再使用原型別驗證。未知關係、額外欄位、不完整圍欄、多段 JSON 及前後說明文字仍拒絕。未改變分類 owner、狀態、權限或任務歸屬。
