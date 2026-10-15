# 自然工具動作展示

已完成限定驗收。

沿用工具卡與技術詳情，標題使用有限本地化動作及檔案短名，分列執行中、等待、失敗、取消、未知與工具呼叫完成。工具完成不代表整輪任務完成。完整工具名稱、參數、輸出與錯誤仍可展開。

目前請求的新 toolCallId 經會話儲存、hook 和訊息列表傳至工具卡，通知插入不再使狀態變成未知。歷史回放、既有 ID 與晚到結果不登記；新請求、结束、失敗和清理會清空。審批嚴格配對 ID，明確回執優先決定終態。ACP SDK 定義工具 ID 在會話內唯一。

相關測試 87 項通過；最終完整前端 230 個檔案、2053 項通過、4 項略過。型別、lint、格式、2600 則訊息語系檢查、語系編譯與渲染建置均為 exit 0。因改動穿過會話與訊息列表，重跑全量前端；後端原始碼未變，雜湊一致，未重複建置。

隔離原生視窗以腳本 loopback 提供器走真實聊天、審批與工具路徑，觀察執行中至工具完成；只讀命令輸出 original、exit_code 0。詳情與錯誤可見，刷新後成功、工具取消及缺少回執的未知狀態保持正確。歷史失敗/取消/缺失回執為已標註夾具；不等同真實模型驗收。首次 shell 語法錯誤屬夾具錯誤，已保留證據。視窗、程序及提供器已關閉。

[OpenAI App Server](https://openai.com/index/unlocking-the-codex-harness/): public item/turn lifecycle separation informed the design; no private UI assumptions or external code.

Evidence: `.cargo/evidence/audit-fixes-20260914/natural-native-summary.json`, `natural-gates.json`, `natural-source-frozen.json`, `natural-tool-identity-audit.json`. Real model: **NOT_RUN**; 120/107 were not probed.
