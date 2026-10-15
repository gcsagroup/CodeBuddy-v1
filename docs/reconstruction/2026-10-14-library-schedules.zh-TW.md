# 常用任務、技能和自動任務的 Harness 接入

本批原始碼位於 `D:\CodeBuddy-v1`，基線見 `source-baseline.json`。此目錄沒有 Git 儲存庫，未建立分支、提交或推送。本批保持 renderer 檔案凍結，只增加宿主相容模組及隔離回歸測試。

## 實作與事實歸屬

- `runtime/library.mjs` 儲存真實 YAML 常用任務、技能檔案及 Agent 範本。常用任務支援解析、儲存、更新、刪除、連結編碼/解碼、斜線命令；自動任務時間直接讀取 `state.schedules`，沒有第二套排程狀態。Agent 範本支援全域/專案範圍的讀寫、匯入及匯出。
- 技能全域目錄為 `store.directory/harness/agents/skills`，專案目錄為 `<project>/.agents/skills`。探索重用官方 `FileSystemSkillProvider`；成功寫入後呼叫 `driver.refreshSkills()` 讓 Harness 重新探索。建立、編輯、啟停、本機匯入、複製、刪除還原使用現有管理介面。刪除需要原前端反向 ACP 確認及相符 nonce；還原使用持久化副本。預覽綁定連線、五分鐘到期、單次使用，並檢查檔案身分及包含附屬檔案的內容版本。
- `runtime/recipe-execution.mjs` 的 `prepareRecipe(library, meta, sessionId, connection)` 只準備工作階段，不呼叫模型。原 `session/recipe/request-params` 表單提供參數；取消回傳 `recipe_params_cancelled`。支援 ID、分享連結及排程儲存的配方快照，渲染提示詞、指令、模型設定及擴充參數。檔案參數需要使用者明確提供路徑，不接受預設路徑，最多讀取 1 MiB UTF-8 內容。
- `settings.max_turns` 以正整數限制傳入 Harness，優先於全域輪數設定；達到上限是可繼續執行的暫停邊界。HTTP 擴充的 `envs`、`env_keys` 合併後替換 URI 與請求標頭中的 `$NAME` / `${ NAME }`；明確 `envs` 優先，單次替換，不寫入程序環境。工作階段擴充定義沿用金鑰保護機制儲存，缺少變數、無效 URL 回傳不含實際金鑰的錯誤。
- 參數範本重用 Nunjucks 3.2.4。官方說明其本身不提供範本沙箱，因此只有正向 AST 允許清單通過後才交給編譯器：純量參數、條件、單層有界迴圈及純文字過濾器。停用屬性存取、函式呼叫、巨集、匯入及檔案載入器，拒絕未知參數；編譯前估算輸出上限，渲染後再次限制 1 MiB。這不是作業系統沙箱。
- `runtime/schedules.mjs` 的 `ScheduleService` 是自動任務執行記錄與狀態的唯一寫入者。重用官方 `@deepseek-ai/dsh-schedule` 的五欄 cron 及時區/DST 計算；僅將原 UI 的字面值零秒六欄格式轉成五欄。支援 CRUD、執行、暫停/啟用、檢查、取消及工作階段歷史。`run(job,{signal,onSession})` 由相容層接到統一 Harness 工作階段入口，必須先儲存 `onSession(id)`，再執行提示詞並回傳結構化完成或取消結果。
- 新建預設暫停；明確 `paused:false` 沿用請求語意。成功執行才設定 `tested:true`，啟用需要成功記錄。失敗或取消後暫停。重新啟動發現執行中任務時標記 interrupted，未驗證任務保持暫停；從目前時間計算下一次，不自動重播錯過的任務。同一任務同時只允許一個執行。
- 專案範圍的 `sources` 同時接受原 UI 的 `projectId` 與明確 `projectDir`，透過 `WorkspaceService` 的專案記錄解析目錄；未知或多目錄專案缺少明確選擇時回傳錯誤，不回退寫入全域目錄。自動任務擴充定義使用宿主憑證保護，狀態 JSON 及排程 YAML 投影不重複儲存明文擴充。使用者主動儲存的原始常用任務 YAML 仍為一般檔案，其中直接填寫的金鑰不屬於加密儲存。

## 驗證範圍

以下命令均使用既有 Node.js 24，結束碼 0：

- `node --test runtime/tests/library.test.mjs runtime/tests/recipe-execution.test.mjs runtime/tests/schedules.test.mjs runtime/tests/session-extensions.test.mjs`：29/29 通過。暫存真實目錄與原 SDK DTO 驗證涵蓋參數取消、範本屬性/呼叫繞過、檔案讀取、技能確認及還原、版本衝突、排程去重/取消/失敗/重啟、擴充憑證保護、儲存前進階欄位驗證、輪數及 HTTP 環境變數合併規則。
- `node --test runtime/tests/library-compat-integration.test.mjs`：5/5 通過。真實 WebSocket ACP 涵蓋參數表單、模型/工具選擇、專案參照及取消；配方輪數實際傳入驅動。排程「立即執行」經過官方 Harness 與受控 HTTP 模型，確認一個工作階段及完成記錄。HTTP 環境變數測試透過官方 Harness 連接真實本機 MCP，檢查 URI、驗證請求標頭及檔案中沒有明文權杖；沒有呼叫外部模型。
- `node --test --test-name-pattern="step limit is a resumable bound" runtime/harness/test/capabilities.test.mjs`：1/1 通過。官方 Harness 達到輪數上限後回傳 `max_turns`，提高上限後繼續至 `end_turn`。

預設工作區另有 14 項通過記錄，見預設工作區三語說明。這些獨立批次的數字不代表完整應用程式覆蓋率。

這些屬於後端契約自動驗證。真實桌面互動、真實模型長任務、macOS 驗收與完整首版驗收由整合批次獨立記錄；本批沒有控制或關閉使用者目前桌面程序。

## 明確保留的邊界

技能遠端下載與本機匯入均已接入，新增驗收見 2026-10-14-skill-download.zh-TW.md。複雜配方的 `retry`、`sub_recipes`、結構化 `response.json_schema` 尚未接入。常用任務儲存與自動任務建立會先拒絕這些欄位，回傳精確欄位名稱，原檔案保持不變；既有配方仍可解析、查看及匯出，執行前同樣明確拒絕，不會靜默忽略。

原 UI 的 JSON 輸出格式與子配方是可見的進階選項：`RecipeFormFields.tsx` 的進階面板包含 JSON Schema 編輯器與 `subRecipes` 編輯器，`CreateEditRecipeModal.tsx` 將它們寫入 DTO。新配方預設摺疊該面板、這兩個欄位為空；一般標題/說明/指令路徑不受影響。`retry`、`settings.max_turns` 沒有獨立表單項，匯入配方及編輯時保留的設定仍可攜帶它們。`RecipeExtensionSelector.tsx` 會傳遞 HTTP `envs`，現已實際使用。自動任務表單透過檔案或分享連結選取配方，因此建立時採用同一執行驗證。

非零秒/七欄 cron、HTTP socket 擴充設定尚未支援。技能與工作區的檔案身分檢查不提供持續的 OS 目錄控制代碼鎖。上述進階選項仍屬於全部功能目標中的待完成範圍。

參考：[Nunjucks API 與範本安全說明](https://mozilla.github.io/nunjucks/api.html)、[Nunjucks 範本語法](https://mozilla.github.io/nunjucks/templating.html)、[YAML 文件](https://eemeli.org/yaml/)、[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。重用現有 YAML 與官方 Harness 套件；Nunjucks 相依套件由主要整合任務統一安裝及維護。沒有恢復舊 Agent 執行核心。
