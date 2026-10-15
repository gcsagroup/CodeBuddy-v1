# 目錄恢復修復與驗收

## 已確認的問題

自建隔離目錄暫時改名後，公開 `session/info` 請求在讀取資料庫元資料前即被工作區租約檢查拒絕，原生介面因此顯示英文錯誤，無法進入 `session/load` 既有的重新確認流程。

同一會話尚在載入時，帶有不同 `cwd` 或 `workspaceLeaseId` 的請求也會共用舊請求，造成新的明確參數未送達。成功及失敗的舊請求均有確定性 RED 用例。

## 最小修復與邊界

`GetSessionInfo` 由處理函式保護：先取得會話生命週期鎖，再取得存取許可，只讀資料庫元資料，不讀取專案檔案、不取得或刷新工作區租約。工具及寫入仍使用既有工作區校驗；不存在及已關閉會話仍拒絕。

前端相同載入參數共用請求，不同參數按順序執行，前一個請求失敗後仍可繼續。不同會話互不等待。這不新增取消 API，也不授予跨目錄重綁權限。

既有會話恢復原目錄；新目錄使用新任務。原目錄失效不應靜默建立新目錄或改綁另一專案。

## 驗證狀態

前端相關 6 檔 78 項通過，TypeScript 與 ESLint exit 0。後端新增 2 項通過；分發回歸 9 項、載入回歸 12 項通過，前端全量 2060 通過、4 跳過。首次後端測試為 1 通過、1 測試夾具失敗（缺少獨立 cleanup journal root）；修正夾具後重跑通過。

Rust 回歸、Clippy 與新後端構建通過。公開 ACP、取消不改綁定、恢复原目錄、重試重新檢查、明確確認、刷新及雙視窗 A/B 隔離均通過；原有 8 筆會話雜湊未變。全量 2060 通過、4 跳過發生於最後「無效目錄映射／重試按鈕」之前，最後改動由 78 項定向測試、型別／ESLint 及原生驗收覆蓋。真實模型十輪為 NOT_RUN，未探測 120 或 107。

證據：`D:/CodeBuddy/.cargo/evidence/audit-fixes-20260914/` 中的 `directory-acp-recovery-red.json`、`directory-missing-before.png`、`directory-load-concurrency-red.log`、`directory-focused-final.log`、`directory-metadata-tests-fixed.json`、`directory-source-frozen.json`。

Final evidence: `directory-native-summary.json`, `directory-acp-recovery-green-final.json`, `directory-focused-retry-final.log`, `directory-final-ui-gates.json`.
