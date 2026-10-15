# 意圖、驗證邊界與報告修復計畫

2026-09-16 · 繁體中文（預設）

[简体中文](2026-09-16-intent-permission-root-cause-review-plan.zh-CN.md) · [English](2026-09-16-intent-permission-root-cause-review-plan.en.md)

狀態：階段 A 已實作並完成其核心桌面驗證，路由證據增強也已完成核心桌面驗收。階段 B 已依據 L03/L04/L05 最小差異證據獲准實作目前請求的單檔範圍修復，分支為 `fix/simple-change-scope-roles`。C–E 不在本次實作範圍。

本文與另外兩個語言版本是同一份權威計畫。早期修復計畫和複核歸檔中的有效證據、校準結論與後續階段已合併至本文，不再維護獨立舊計畫。`reports/` 中的證據報告只保留一份，不複製成三種語言。

## 1. 範圍與結論強度

### 目前先行項：路由證據增強

分支：`fix/intent-routing-evidence`。主軸是持續維護使用者目前任務的目標、邊界與變更；本項僅為定位理解在哪個環節出現偏差提供證據，不實作新的任務契約或分類器。

- 沿用既有 `intent_completed` 活動及 session/run/event ID，增加可選、版本化的 `routing_evidence`；不新增日誌目錄。
- 來源由實際呼叫分支傳入，區分聊天快速路徑、工作區約束、語義分類後的結果、檢查點及文字恢復；不得事後重跑關鍵字推斷來源。
- 記錄分類結果、語義降級原因、實際執行意圖與覆寫原因、目標來自已綁定的執行訊息或澄清脈絡、單檔檢查是否評估/符合、最終入口路線。執行訊息可能已綁定歷史請求，不等同於使用者剛提交的原文。
- 首批涵蓋既有意圖完成事件；提前工作區閘門、澄清返回及不重發前奏的恢復路徑仍可能沒有此事件。不得依缺少欄位推斷這些層已執行或通過。Planner、權限稽核與執行回執繼續查各自既有證據，本項不宣稱已串通全部層。
- 新欄位不進入模型脈絡，不含提示詞、使用者全文、程式碼或金鑰；舊記錄缺欄位保持未知。桌面技術詳情可讀、匯出與日誌讀寫不遺失欄位。
- 先驗證缺欄位的迴歸失敗，再驗證新舊記錄讀寫、分支真實性、事件關聯與桌面行為；未完成項記為 NOT_RUN。

設計對照：[OpenAI 沙盒說明](https://learn.chatgpt.com/zh-Hans/docs/sandboxing) 分開技術邊界與審批策略。採用「分類、權限、執行事實不能混為一個結果」的原則；不照搬其權限設定、不推斷 Codex 私有意圖實作。目前產品可觀察到的審批與命令退出碼同樣是獨立事實。日誌欄位不是執行授權。

本計畫只涵蓋 CodePro 的意圖識別、任務調度、工具呼叫邊界與結果報告。它不修改 Computer Use、Git、Mac 或搜尋模組，也不擴大 Shell、直譯器或路徑權限。

已確認的事實：

- P04 的編碼任務成功修改 `app.js`，Tester 請求的 `node -e` 被宿主有界驗證合約跳過；它不是使用者主動跳過，也沒有真實待審批請求。
- G03 和工作階段 `20260916_24` 顯示，前一輪唯讀分析後，後續明確修改請求仍可能保留 `read_only` 意圖並路由給 Planner；這屬於階段 B，不是階段 A。
- P01 顯示簡單修改完成後可能沒有執行必要驗證；這屬於階段 C1。
- 舊 revision 中的失敗證據仍在磁碟；跨 revision 彙總與重試屬於階段 E，不能用階段 A 的單次報告修復取代。

不把相似現象強行合併成一個根因。宿主策略拒絕、使用者拒絕、待審批、錯誤路由與驗證遺漏分別處理。

## 2. 入口與呼叫鏈

桌面請求的相關鏈路為：

```text
使用者訊息
→ agent.rs 識別目前請求與約束
→ execution strategy 選擇簡單修改或 L2 DAG
→ task_scheduler.rs 分派 Coder / Tester 並處理工具結果
→ TaskOutput 持久化任務事實
→ result_aggregator.rs 彙總執行結果
→ codepro_terminal_report.rs 產生使用者報告
→ codepro_run_result.rs / 桌面端顯示終態
```

權限判斷與意圖路由是不同層次。正確識別「要修改」不會自動放寬命令權限；命令被策略拒絕也不能反推使用者要求跳過。

## 3. 外部設計對照

依據儲存庫規則，本設計對照公開資料，而不推斷私有實作：

- [OpenAI Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)：採用「技術邊界、審批策略和執行回執分層」原則。
- [OpenAI 模型指引](https://developers.openai.com/api/docs/guides/latest-model)：採用「從指令與先前脈絡推斷使用者意圖及任務範圍」以及明確約束問題表面的原則。本階段僅把目前訊息中的修改目標、保護邊界與驗證命令分開，不據此推斷 Codex 私有解析器，也不把模型提示詞當作路徑授權。
- [OpenCode 權限生命週期](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/permission/index.ts)：採用 allow / ask / deny 狀態明確、真實審批必須有待處理請求的思想。
- [Cline 命令攔截器](https://github.com/cline/cline/blob/82b8e1fa0471f728e3d9540fd19aa063e2049497/sdk/packages/core/src/extensions/tools/command-guard-extension.ts)：採用「跳過單一動作不等於終止整個任務」的思想。

不採用：換模型取代確定性規則、全面放開直譯器、複製簡單黑名單、把生命週期 `completed` 機械改成 `failed`，或刪除舊失敗證據。

## 4. 全階段約束

1. 修改範圍來自目前請求和可核驗合約；命令、範例或引用中出現路徑不產生編輯授權。
2. 路由選擇不授予新的 Shell 權限；既有 `node -e`、拼接命令與任意直譯器邊界保持不變。
3. 未執行、失敗與成功是三種事實；未執行必須保留 `exit_code = null`。
4. 使用者主動跳過、宿主邊界、真實待審批與使用者拒絕分別記錄。
5. 子任務、本輪和整個執行的修改作用域分別顯示。
6. 編輯完成不等於測試通過；歷史成功也不能自動證明目前檔案狀態。
7. 舊狀態缺少欄位時顯示未知，不從模型文字推導使用者授權。
8. 日誌沿用 session、run、task 和 tool call ID，只為錯誤與安全事件增加必要結構化事實。

## 5. 實作順序

### 階段 A：可信的 NOT_RUN 原因與報告作用域——已實作

- `TaskOutput` 增加選用、版本化的 `ValidationNotRunEvidenceV1`。
- 原因限定為 `user_requested`、`host_boundary`、`unknown`。
- 證據只能由調度器依據真實分支建立；模型文字不能填寫或覆蓋。
- 新報告優先讀取結構化證據，舊記錄缺少欄位時相容讀取並顯示未知。
- Coder 的全域修改記錄與 Tester 的局部「無修改」同時保留；靜態報告標題標明任務、角色與「僅本子任務」。
- 本階段不改變路由、白名單、審批策略或跨 revision 彙總。

### 階段 B：目前請求的意圖與約束作用域——單檔範圍修復實作中

L03/L04/L05 已形成最小差異證據：單一修改目標可命中 `simple_change`；增加一個明確受保護的檔名會錯誤降級；兩個真實修改目標應繼續走一般 `change`。原始碼複核確認 `classify_simple_change()` 原先收集訊息中的所有路徑，不區分其語意角色。

本次只修復單檔快速路線的確定性資格檢查：依目前訊息的子句與作用域標記區分編輯、保護與命令片段，僅編輯片段中的路徑參與目標計數。重疊標記優先採用較長、較具體的保護表達；不確定輸入仍保守回退一般路線。它不是新的通用意圖分類器，也不修改語意路由、Planner、權限、白名單或審批。

迴歸必須涵蓋 L03 的受保護檔案、保護表達在前、中文「不要修改測試檔案」、英文 `modify/leave unchanged`、驗證命令中的路徑，以及 L05 的真實多檔拒絕。實作前聚焦測試為 39 通過、2 失敗；最小實作後為 41 通過、0 失敗。桌面後端重建和 L03/L04/L05 重跑仍是完成門檻。

### 階段 C1：簡單修改的驗證要求——待授權

讓簡單修改合約明確記錄本輪是否要求動態驗證，以及使用者是否明確排除命令。編輯成功但依使用者要求不驗證，與遺漏必要驗證必須使用不同事實。

### 階段 C2：已執行驗證的證據新鮮度——待授權

先記錄實際驗證事實，再依後續寫入判斷結果是否過期。後續寫入不能抹除「曾執行」，舊成功也不能證明新版本。

### 階段 D：使用者可見終態——待授權

保持 wire protocol 的生命週期語意，只修正 UI 對 PASS、NOT_RUN、等待審批與復原操作的表達。

### 階段 E：跨 revision 歷史與重試——待進一步設計

使用穩定驗收識別碼關聯舊失敗、新修改與新驗證；不透過任務名稱或命令字串猜測繼承關係，不繼承已撤銷的權限。

## 6. 階段 A 變更範圍

```text
crates/goose/src/agents/agent.rs
crates/goose/src/agents/codepro_run_result.rs
crates/goose/src/agents/codepro_terminal_report.rs
crates/goose/src/agents/result_aggregator.rs
crates/goose/src/agents/task_dag.rs
crates/goose/src/agents/task_scheduler.rs
crates/goose/tests/codepro_result_convergence.rs
crates/goose/tests/finding_candidate_contract.rs
```

沒有修改鎖定檔、Computer Use、Git、Mac 或搜尋模組。

## 7. 階段 A 驗證記錄

聚焦測試：

- `task_dag::tests`：82/82 通過。
- `result_aggregator::tests`：40/40 通過。
- `codepro_terminal_report::tests`：49/49 通過。
- `codepro_run_result::tests`：17/17 通過。
- 新增的調度器來源、遮罩、混合原因與作用域測試均通過。
- `task_scheduler::tests`：185/187 通過；兩個既有失敗分別涉及 Python 依賴和舊 host Node 測試回執，不在階段 A 路徑。

門檻記錄：

- `cargo fmt --check` 與 `git diff --check` 通過。
- `cargo clippy --all-targets -- -D warnings` 僅剩 `load_hints.rs` 三處既有 `needless_borrows`。
- 全量 `cargo test -p goose --lib --jobs 1` 在 Windows 遇到既有 PermissionDenied 與一個堆疊溢位，未完成全綠。
- 桌面 `typecheck`、`lint:check` 通過；Vitest 執行未完成，`format:check` 命中大量既有格式差異。
- 依 README 重建並啟動桌面後端成功；建置二進位雜湊已核對一致。

真實桌面樣本 `20260916_25` / `run_332218f4-8794-4fb7-8ce5-a3e5886fc6c2`：

- Coder 實際把 `app.js` 從 `hello` 改為 `hi`。
- Tester 的驗證命令被宿主邊界跳過，沒有退出碼。
- 持久化狀態記錄 `reason=host_boundary`、tool call ID 與原始命令。
- 最終報告保留 `app.js` 修改、顯示 NOT_RUN，沒有偽造 PASS 或待審批。
- 重新啟動桌面並開啟工作階段後，上述報告與檔案狀態仍然存在。

## 8. 已知低優先事項

- `validation_not_run.cwd` 在該桌面樣本中為 `null`，但事件與最終報告仍保存正確專案路徑。
- 可見報告寫「環境問題：無」，結構化統計卻把宿主邊界計入 `environment_problem: 1`。
- 模型產生的靜態建議出現沒有證據的 Node 版本猜測與編號從 2 開始的問題。

這些事項目前不影響使用者判斷真實執行結果，不為它們擴大階段 A。只有出現實際 UI、統計或除錯影響時再單獨處理。

## 9. 後續階段驗收門檻

- 每個階段先補可重現回歸，再做最小修改。
- 執行相關 Rust/桌面測試、格式、lint 與建置門檻；既有失敗單獨記錄。
- 重新建置後端並啟動 Electron，在真實視窗驗證可見結果與重新啟動持久化。
- 未執行的驗證必須明確標記，不以跳過、零匹配或靜態觀察冒充通過。
- 每個階段獨立評審與授權；階段 B 不因階段 A 完成而自動開始。
