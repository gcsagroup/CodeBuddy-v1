# 自然語言長期偏好路由失敗分析

日期：2026-09-12
狀態：唯讀稽核完成，尚未實作修復
驗收證據：`D:\CodeBuddy\.cargo\evidence\memory-candidate-native-20260912-resume\acceptance-status.md`

[简体中文](2026-09-12-memory-natural-routing-failure-analysis.zh-CN.md) · [English](2026-09-12-memory-natural-routing-failure-analysis.en.md)

## 1. 結論

這不是單純的模型隨機偏離，可分成兩個層次：

1. **確定性的路由缺陷**：使用者明確說「請明確記住一項長期使用者偏好」，但 `is_project_memory_management_request` 不識別「長期使用者偏好」，因此沒有進入記憶專用執行路徑。
2. **模型相關的具體表現**：後續 `qwen3.5:397b` 把請求分類為 `ComplexChange`，規劃並建立了 `goose/preferences.yaml`。其他模型可能產生不同錯誤表現，但只要前置判定未修復，仍可能繞過記憶專用路徑。

受控提示中直接指定 `project_memory_remember` 能成功，只證明後端工具與狀態轉換可用，不能取代自然語言場景。

## 2. 已驗證事實

### 原始請求與模型

- 父會話：`20260912_3`。
- 原始請求：`請明確記住一項長期使用者偏好：以後回答第一行使用「已確認偏好-ACT-K3M9」。本次明確允許寫入長期使用者偏好。`
- Provider：`custom_454541111`。
- 模型：`qwen3.5:397b`，`thinking_effort=high`，`toolshim=false`。
- 工作目錄：隔離的 `project-a`。

### 實際呼叫鏈

1. `is_project_memory_management_request` 要求同時存在記憶範圍詞與記憶動作詞。
2. 範圍詞包含「專案記憶、長期記憶、跨對話記憶、跨會話記憶」，但不包含「長期使用者偏好」或「使用者偏好」。
3. 原始請求雖然包含「記住」與「長期使用者偏好」，仍回傳 `false`。
4. `reply_codepro_with_intent_core` 因此沒有覆寫外層意圖，也沒有啟用 `codepro_project_memory_management()`。
5. 記憶專用路徑原本會只保留 `project_memory_*` 工具，並追加「不能用工作區檔案取代記憶」的系統說明；本次沒有進入該路徑。
6. 外層模型把請求作為 `ComplexChange` 拆成 planner、coder、tester 與報告會話。
7. 父會話沒有 `project_memory_remember` 請求；子會話只使用 `tree`、`write`、`read_document` 與 `shell`，最終建立 `project-a\goose\preferences.yaml`。

### Scope 與儲存結果

- 失敗場景沒有寫入 Project Memory，因此沒有實際 memory scope。
- 建立的是專案本地檔案，語意上錯誤地變成 project scope。
- 受控重試明確呼叫 `project_memory_remember`，使用 `scope=user`、`user_confirmed=true` 後成功寫為 `source=user_explicit`、`status=active`。
- candidate、active、跨專案召回與重啟持久化的後端驗收均通過；自然路由仍失敗。

## 3. 提示與工具設計中的第二個問題

即使只補充關鍵字，現有記憶專用系統說明仍寫著：顯式保存請求使用「current-project scope」。這與工具 schema 支援的長期使用者偏好不一致。

工具 schema 已正確說明：

- `scope` 預設是 project；長期低風險互動偏好可以使用 user scope。
- 只有使用者明確確認 user scope 時才設定 `user_confirmed=true`。

因此修復不能只增加一個關鍵字，還必須刪除「所有顯式保存都使用目前專案 scope」的誤導，明確區分：

- 長期使用者偏好：`scope=user`，使用者本輪明確授權時 `user_confirmed=true`。
- 專案規則、專案上下文：`scope=project`。
- AI 自動推斷的低風險習慣：`scope=user`，不設定 `user_confirmed=true`，進入 candidate。

## 4. 與 Codex 公開行為對比

OpenAI 官方文件把固定指令與生成記憶分開：必須穩定執行的團隊指導放在 `AGENTS.md` 或版本控制文件中；記憶只是輔助召回層。Codex 的本地記憶也把「允許生成記憶」與「允許在未來會話使用記憶」分成獨立控制。

CodeBuddy 應採用相同邊界：使用者明確要求保存長期偏好時進入結構化使用者記憶，不應被解釋為開發一個專案設定檔，也不應靜默寫入 `AGENTS.md`。

公開來源：

- [OpenAI Docs：Memories](https://learn.chatgpt.com/docs/customization/memories)
- [OpenAI Docs：Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

## 5. 最小修復範圍

### 必須修改

1. 擴充自然語言記憶管理判定，識別「長期使用者偏好、使用者級偏好、我的長期偏好」等明確 user-memory 範圍表達；仍要求同時出現「記住、保存、寫入」等動作詞。
2. 修改記憶專用系統說明，要求模型保持使用者表達的 scope，不再把所有顯式保存預設成目前專案。
3. 對明確的長期使用者偏好說明 `scope=user`；只有目前訊息明確授權時才設定 `user_confirmed=true`。
4. 保持記憶專用工具白名單，確保這類請求看不到 `write`、`edit`、`shell`、任務拆分或子 Agent 路徑。

### 暫不修改

- 不修改 Project Memory 儲存格式。
- 不修改 candidate/active 狀態機。
- 不增加向量資料庫或新的偏好設定檔。
- 不刪除失敗驗收產生的 `goose/preferences.yaml`，繼續作為原始證據保留。

## 6. 最小迴歸測試

1. **意圖單元測試**：原始自然請求必須回傳 memory-management；「我偏好簡短回答」但沒有保存動作、`保存 README.md`、一次性會話代號不得誤判。
2. **路由測試**：原始請求必須進入統一記憶路徑，不得建立 `ComplexChange` DAG 或子會話。
3. **工具白名單測試**：只向模型提供 `project_memory_search/remember/forget/clear/stats`，不得提供檔案寫入工具。
4. **提示快照測試**：明確包含 user/project scope 區分，且不再出現所有顯式保存使用 current-project scope 的文字。
5. **後端整合測試**：mock provider 對原始自然請求呼叫一次 `project_memory_remember`；斷言 `scope=user`、`user_confirmed=true`、`status=active`，並斷言工作區沒有新增檔案。
6. **真實 Electron 迴歸**：原樣輸入自然請求，只允許一次權限；必須觀察父會話直接呼叫 `project_memory_remember`，沒有子會話，沒有 `goose/preferences.yaml` 或 `AGENTS.md`，重啟後能在專案 B 自動召回。

## 7. 完成標準與預估

此缺陷應在進入下一個記憶功能前修復。最小實作預估 0.5 個工作日；包含自動化門禁與真實 Electron 迴歸預估 1 個工作日。只有自然語言場景通過後，才能把「明確長期使用者偏好可用」標記為完成。
