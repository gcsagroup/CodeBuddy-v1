# 首段回覆最佳化：會話與任務快照

來源 `D:\CodeBuddy-v1`，無 .git，未建立分支、提交或推送。候選 `1.43.3-harness4`。模型、思考強度、55 個工具及前端互動保持原樣；Harness 繼續持有執行與完成權威。

真實隔離診斷發現簡單問候中狀態讀取 21 次累計 1127ms，部分只需目前會話或任務卻複製整份歷史。store 的 readSession 先選會話再複製；compat、conversation-driver、transcripts 改用此快照，codepro 查詢只讀 codeproRuns。寫入、權限、持久化與復原語義保持原樣。

同資料交替三組，每組 20 次會話與任務讀取：舊路徑 2624/3105/2874ms、新路徑 29/20/35ms。這是局部效能，不代表整體比例。真實請求首段 20.738→9.003 秒，但模組及 OS 快取、網路均有變數，未將全部差值歸因修正。

相關測試 23/23 + 43/43，exit 0，涵蓋快照隔離、交易提交、刪除、原生 Harness、轉錄、並發及復原。命令與檔案見[簡體紀錄](2026-10-15-response-latency.zh-CN.md)。證據 latency-snapshot-benchmark.json、adapter-profile-before/after.log、latency-snapshot-tests.log、latency-adapter-regression.log。

沿 README 以既有 Node 24 建構和安裝 harness4，皆 exit 0；實裝發現 Windows 應用容器的目錄與檔案真實路徑不同，導致工具身分校驗失敗，故不列通過候選。修復改由實際 manifest 檔案定位資源，服務回歸 3/3、型別檢查及 lint 通過。harness5 因新增容量缺陷而主動作廢，統一進入 harness6。

使用者目前已切換 Gemma，工具增加至 205 個，不能直接比較前述 Kimi 計時。harness4 冷/熱 9.38/4.86 秒雖有文字，但僅輸出 1 token、以 max_tokens 中斷，均不算正常對話通過。詳見[模型視窗紀錄](2026-10-15-context-capacity.zh-TW.md)。舊安裝包保留 target/accepted-harness-installer-1.43.3-harness3。
