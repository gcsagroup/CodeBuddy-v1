# 專案記憶與等待延遲：合併交接

[简体中文](2026-10-09-memory-fixes-merge-handoff.zh-CN.md) · [English](2026-10-09-memory-fixes-merge-handoff.en.md)

## 來源與提交

既有 `main` 工作區；基底 `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`。本批兩端應用驗收完成，下列程式碼提交與本交接文件一併交付。

### 程式碼提交

- `7b34092cf4c90587ee592ee47263b49474ebea5e` — memory
- `803f9431b5dfd1eaaffdc4226cf79322d7d6fa40` — audit
- `bc4ff081d1bdd3f43e5d5dd55c296ca592885588` — providers

## 修改內容

| 檔案 | 原因及修復 |
| --- | --- |
| `crates/goose/src/agents/tool_task.rs` | 刪除／清空記憶成功後，完成檢查未接受其回執。接受可信內置工具的型別化成功回執，綁定原始 UUID／目前專案，包含冪等刪除與清空；失敗、偽造或目標不符仍拒絕。 |
| `crates/goose/src/agents/agent.rs` | 純對話仍帶執行任務綁定，造成反覆完成檢查。在既有純對話限制套用處清除該綁定；一般執行任務保留證據門檻。 |
| `crates/goose/src/agents/tool_audit.rs` | 歷史檔案逐筆非同步 I/O 與串行掃描拖慢收尾。批次阻塞 I/O、重用已解析回執，以共用四執行緒池掃描；仍逐一鎖定並驗證所有歷史工作階段。增加鎖等待／讀取耗時診斷。 |
| `crates/goose-providers/src/openai.rs`、`openai_compatible.rs` | 自訂 Ollama 使用 OpenAI 相容路徑，原本只有 600 秒整體 HTTP 逾時。預設 60 秒限制無資料等待，涵蓋重試與回應標頭，標頭不重設首次期限；後續 SSE 資料延長等待期限，心跳註解不延長。逾時結束本次請求，不自動重送。 |

既有明確 `timeout_seconds` 設定仍用於 OpenAI 提供商的等待期限；未設定時使用 60 秒。非串流模式沿用原 HTTP 逾時。這限制應用等待，不代表外部模型的推理速度已提高。沒有新增依賴、公共協定或記憶格式遷移；沒有停用審計損壞檢查或任務完成門檻。

## 同事接收步驟

1. `git status --short`，依團隊流程保留自己的未提交工作。
2. `git fetch origin`，核對本報告最終提交編號。
3. `main` 可快轉時執行 `git merge --ff-only origin/main`；已分歧時先檢視差異再整合。
4. 注意上述五個檔案的重疊修改，尤其純對話綁定、記憶回執、審計鎖定、提供商重試及 SSE 解析。
5. 依 README 使用原平台環境，執行[驗收報告](2026-10-09-project-memory-acceptance.md)的命令並重建後端。自訂慢速模型若需要更長的靜默等待，可使用既有逾時設定。

## 交付邊界

同專案不同對話可共用已儲存記憶；完整聊天歷史及跨裝置同步不在此範圍。工作區另有既有已暫存與未暫存改動，本批不吸收這些其他改動；真實應用驗收使用該工作區產物，並不表示所有產物內容都包含於本批提交。設定檔、憑據、原始會話、夾具及安裝包留在忽略目錄。

Mac 套件為 Apple Silicon 內部測試版，使用 ad-hoc 簽章；Intel、Developer ID 公證與 Gatekeeper 互動未驗收。

## 設計參考

沿用現有 Rayon 依賴限制並行 I/O；依 [Tokio 阻塞工作說明](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)避免無界阻塞工作。HTTP 整體逾時與讀取等待不同，參考 [reqwest ClientBuilder](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html)。SSE 等待限制留在提供商傳輸層，不增加業務判定者。
