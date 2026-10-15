# 歷史分頁與搜尋限定驗收

本輪未改產品邏輯，新增 3 項組件回歸測試；相關 3 檔 23 項測試全部通過，TypeScript、ESLint、Prettier 均 exit 0。既有後端 history 11 項通過，未重複編譯 Rust。

隔離 Electron 與真實 ACP 使用 105 筆測試資料。逐張原生截圖確認 105 筆及 50/50/5 邊界；切換關鍵詞得到 Beta 50 筆、Alpha 55 筆；清空後可見原先不符合關鍵詞的記錄。開啟 B-105、返回搜尋 A-055 並開啟正文成功；刷新後 Alpha 仍為 55 筆。原有 8 筆隔離會話資料雜湊未變，驗收視窗已關閉，啟動器 exit 0。

原生切詞未強制製造晚到傳輸；過期分頁、舊關鍵詞及工作區模式結果的隔離由 deferred promise 組件測試證明。捲動後 UIA 文字快取未更新，所以分頁證據採用實際截圖。歷史為全域列表，workspaceMode 是類型篩選，不是專案路徑篩選。專案/日期篩選及歸檔/批次管理仍待後續審計。真實模型 NOT_RUN；未探測 120 或 107。

Evidence: `D:/CodeBuddy/.cargo/evidence/audit-fixes-20260914/history-pagination-native-summary.json`, `history-pagination-native-scan.json`, `history-pagination-focused.log`, `history-existing-preserved.json`.

Command (cwd `D:/CodeBuddy/ui/desktop`):

```text
pnpm exec vitest run src/components/sessions/SessionListView.search.test.tsx src/components/sessions/SessionListView.capabilities.test.tsx src/acp/__tests__/sessions.test.ts --maxWorkers=1
```
