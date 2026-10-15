# 全域與子目錄 AGENTS.md 驗證（2026-09-15）

隔離 Electron 視窗儲存全域 `AGENTS.md` 後重新開啟仍保留內容；既有專案 `AGENTS.md` 可被發現。只讀分析實際呼叫 `read_document` 讀取 `nested/readme.txt` 後，下一次模型請求的 system 訊息依序包含 `GLOBAL_RED`、`PROJECT_BLUE`、`SUBDIR_GREEN`，各出現一次。工具仍由只讀範圍限制；同一工具 ID 的 SQLite 請求與回執均為 success，桌面工具卡顯示「工具呼叫已完成」。

`D:\CodeBuddy`：子目錄提示順序、既有只讀回歸各 1/1 通過。新增回歸先確認子目錄後遺失產品身分（RED 0/1，exit 101）；明確保存本輪記憶與語言片段並重套專案附註、身分及分析規範後，整合測試 GREEN 1/1，合成記憶／語言／專案測試 1/1。嚴格 Clippy 與 CLI 建置 exit 0。`D:\CodeBuddy\ui\desktop`：前端全量 235 檔、2069 通過、4 跳過，exit 0；lint:check exit 0。最終二進位 SHA256：`0761DD644F327229B42F20246116A258F68FB508648C1E89EE21786B79662B0A`。

桌面驗收使用 `D:\CodeProAcceptance\default-lan-onboarding-20260914` 中的隔離設定與本機腳本 provider；先前工具卡未知狀態源於 provider 夾具跨回合重複 toolCallId，改用唯一 ID 後新回合顯示 success，未修改產品 UI。最終隔離新會話的讀取前與讀取後 system 請求均保有產品身分、只讀分析、報告規範、繁體語言與專案附註，子目錄規則只在讀取後加入。證據：`.cargo/evidence/audit-fixes-20260914/read-only-subdir-addenda-native-final.json`、`global-instructions-real-request.jsonl` 的 105–110 筆；舊版 v2 記錄保留供追溯。真實 LAN 模型 `192.168.9.120:8001` 已停止，完整模型理解驗收仍為 `NOT_RUN`。
