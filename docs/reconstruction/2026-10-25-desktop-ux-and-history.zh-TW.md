# 2026-10-25 桌面互動與歷史載入開發說明

[简体中文](2026-10-25-desktop-ux-and-history.zh-CN.md) · [English](2026-10-25-desktop-ux-and-history.en.md)

## 範圍與職責

本批接續 10 月 23 日整合結果，包含圖片操作、相對檔案連結、歷史載入、閱讀位置、等待回饋、瀏覽器核准、插話佇列與 Windows 工具執行階段。執行、權限、取消、壓縮及原生日誌仍由既有 Harness 鏈路負責；未改依賴鎖檔、官方核心或持久化協定。

- `runtime/compat.mjs`：保留工作區檢查及一致快照。僅在歷史重播合併相鄰、同訊息 ID、同類型且全部信封中繼資料相同的助手文字／思考。新合併幀不超過 64 Ki 字元，原本超大的幀不拆分；使用者、工具、圖片及中繼資料變化均為邊界。不改原始日誌或即時輸出。會話資訊按欄位投影。
- `ui/desktop/src/acp/adapter/{messages,shared}.ts`：內部維持可變輸入，已知單筆更新／插入只複製該訊息，重用其他已隔離快照；其他變更走完整發布。
- `chatSessionStore.ts`：每筆歷史通知仍完整套用，聊天 React 訂閱於載入時發布首次載入態與最終快照；權限及控制消費者不略過。
- `ChatInput.tsx`：負責草稿、待發輸入及接收回執；沿用原生取消與傳輸釋放屏障，不重疊提交 prompt。
- `ToolCallExpandable.tsx`、`ui/scroll-area.tsx`、`BaseChat.tsx`：保留閱讀位置與明確展開狀態，觀察自然內容高度；同會話明確送出且確認接收後回到最新。
- `runtime/work-status.mjs`、`ToolCallConfirmation.tsx`：消費真實診斷、顯示收到的瀏覽器動作與對象，不決定權限或修補錯誤參數。
- `ImagePreview.tsx`、Electron `main.ts`：可用鍵盤操作的圖片預覽、原生複製與另存。`workspaceFilePanel.ts` 將相對連結交由既有主程序工作區路徑檢查。

## 互動約定

普通插話在當前輪完整結束、傳輸釋放後依序逐條處理。「立即傳送」只凍結點擊時確定尚未傳送的項目，依序合併文字與圖片；不包含輸入框草稿、後續新增項或接收不確定的輸入。確認接收才移除，拒收保留；停止撤銷待執行的立即傳送並保留佇列。沿用原儲存格式、核對與恢復流程。

僅多條普通待發項提供展開；未知回執的核對操作持續可見。前端停止出列不等於 Agent 暫停。結算折疊尊重閱讀；拒收、切換會話及自動出列不觸發回到最新。

HTTP 回應標頭仍為等待，真正的文字、思考或工具參數才切換為接收，標頭不重置計時。核准對象以純文字顯示，缺少對象明確提示，不推測或自動批准。

## 計時與效能

後端 `[Session load timing]` 區分讀取、工作區、投影、傳送、恢復、問題、權限、選項和擴充階段。`updateCount` 含 usage 更新；`dispatchedUpdates` 僅計歷史 session 通知，不能直接當成同一分母。

前端 `session_load_timing` 記錄開啟、中繼資料、重播回應、store 就緒、DOM 提交及可見提交，也記錄快取與失敗；最多保留 16 筆觀測。只記 ID、數量及時間，不記正文、參數或憑據；日誌失敗不阻斷載入。可見提交不是作業系統合成器首幀，前後端階段重疊而不能直接相加。

| 相同受控首次載入樣本；每格單次觀測 | 優化前 | 優化後 |
| --- | ---: | ---: |
| 1000 條訊息、400000 字元 | 5164 ms | 2124 ms |
| 300 條訊息、28800 個片段 | 9469 ms | 3306 ms |
| 300 條複雜 Markdown 訊息 | 4810 ms | 4211 ms |

夾具不含模型生成，不外推所有會話，短會話未顯示穩定收益。僅 renderer 的三組重複中位數中，千條訊息重播處理由 935.7 ms 降至 45.3 ms，不是整機開啟時間。首次載入指 renderer 無該會話快取，沒有清空作業系統檔案快取。

## Windows 依賴與驗證

`stage-harness-distribution.cjs` 從已準備的 Python 載荷複製正式版 `vcruntime140.dll` 與上游授權，放在工具旁；缺少載荷即失敗，不借用 System32、不下載或安裝。`verify-harness-stage.mjs` 核對副本與授權，`windows-tool-runtime.test.cjs` 覆蓋分發與缺失拒絕。

本次整合複核：64 個前端檔案／842 項測試、45 項執行服務／歷史／問題／預設模型／封裝測試，以及實際 Edge 中 24 項受控瀏覽器回歸通過；TypeScript、相關 ESLint 和語系檢查通過。保留最初沙箱暫存檔 rename EPERM 的失敗紀錄，以相同命令在宿主隔離夾具驗證，不將失敗算作通過；另有兩次錯誤日誌路徑導致檢查未啟動，也未計入。

重跑使用 README 入口。執行服務相關用例為 history-replay-compaction、history-list-latency、harness-integration、work-status、questions、distribution-model；封裝用例為 windows-tool-runtime、distribution-credentials、windows-wizard-installer。桌面涵蓋 ACP、BaseChat、佇列／接收、圖片、Markdown、核准和捲動；瀏覽器夾具為 `tests/e2e/scroll-area.browser.spec.ts`。

既有 Windows 實際流程驗證圖片複製／另存、閱讀後傳送、停止續聊、三條自動接續與明確合併傳送。同一 36 次捲動矩陣由 6 次空白變為 0 次。自動化、受控瀏覽器和真實產品證據分開。Win10、Mac 本批未實機驗收；不宣稱所有模型通過或壓縮 A/B 已完成。模型原始協定串、參數錯誤另行跟進，壓縮程式未改。

## 憑據與提交界線

僅提交原始碼、必要回歸與開發文件。週報、profile、原始會話、本機診斷、截圖、產物和安裝登記不提交。不得恢復共享雲端憑據或舊分發憑據，新使用者自行配置，既有設定不覆寫。

推送前檢查目前檔案、新增 diff 及基線後所有新增歷史 blob；已知舊憑據僅於記憶體比對，不輸出內容。模式掃描與淺克隆不能證明遠端全部歷史、其他分支或舊安裝包乾淨；曾分發的憑據應由持有人輪換或撤銷，本批不擅自執行。
