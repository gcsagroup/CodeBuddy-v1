# Harness 上下文與生成中壓縮驗收

候選 1.43.3-harness10；來源 D:\CodeBuddy-v1，main / 01610d03764570282eee439cd2bfb49fcd373e98 與保留的未提交修改。本批未提交、未推送。

普通問候的主要固定成本是工具 schema 與系統說明。Git、角色包裝與 MCP 工具改為按需載入，伺服器說明隨工具載入；保留 Harness 註冊、權限、執行、子 Agent 調度及原生壓縮。基本請求從 43 個工具降至 25 個。宿主指令獨立保存，避免被子 Agent persona 覆蓋。

官方串流組裝器與估算器每 250ms 至多投影一次生成中用量，提交後以原生 meter 校正；臨時投影不寫入歷史。既有 status_message.data 傳遞來源，避免 SDK 剝離額外欄位。UI 用 ≈ 標示估算、? 標示容量未確認。32768 是適配層缺省預算；優先服務中繼資料，並可按連線與模型配置部署容量，受已知服務上限約束，清空恢復自動識別，下次發送生效。

Harness 在模型步驟邊界檢查設定比例並壓縮，工具 schema 參與壓力計算，不中斷正在傳輸的單次回答。最後回答超過閾值也可能等下一個模型步驟；顯示估算不控制壓縮。

已驗證：後端 373/373、前端四目標 19/19、TypeScript 均退出 0。真實 Kimi-k3 問候輸入 4536 tokens（舊樣本 6638），顯示估算 5211；冷/熱總耗時 8.824/5.054 秒，非延遲保證。熱樣本 1 個未快取輸入另有 4535 個快取輸入。

真實多模組任務同一輪 233.278 秒、20 次工具調用、7 次原生自動壓縮、256 次上下文相關更新。六份合同對應金額、發票、報表三模組；獨立測試退出 0，額外 9 條斷言覆蓋舍入、數量、負數異常、空集合、格式、介面與依賴約束。真實模型亦完成 MCP 搜尋後時間查詢。

證據：.preview-evidence/context9-full-final.log、context9-ui-final.log、context9-typecheck-final.log、context9-real-2g9Fg2/receipt.json、context9-real-klEBZ9/receipt.json 與 independent-contracts.json。原始資料不提交。

真實桌面 harness9：會話 1011ms 出現，正文 10779ms；冷啟動準備 4496ms，模型請求至正文 4813ms，仍有延遲。容量保存 65536 後顯示 66k，重開設定保持，清空後恢復 33k?。同一桌面開發任務 196738ms、5 次自動壓縮，執行中可見 5k→13k→20k→14k 等更新，獨立測試 11/11 與額外 9 條斷言通過。

harness9 實際安裝退出 0，應用/asar/清單及 50 個運行源檔指紋一致；重啟續聊正確回憶六個要點，原生終態 completed。舊計時腳本因歷史渲染/訊息數量假設未收斂，改用可見正文與原生終態獨立核實，不把該腳本列為 PASS。

harness10 補上已結束任務過濾器對 context_meter 的放行，防止回放後丟失來源標記，保持任務封存。回歸先失敗後通過：相關 68/68、TypeScript 退出 0；本批不同前端測試合計 75。後端未再變動，復用本批 373 項與真實模型證據。macOS、所有技能與小時級生產專案未在本批重驗。完整記錄及本地證據位置見同目錄簡體版本。

## 最終交付

harness10 完整構建與實際靜默安裝均退出 0。EXE、asar、清單及 50 個運行源檔一致；後端與本批真實多模組驗收版本完全一致。真實回放顯示 ≈17k / 33k? 與正確來源，新會話正常完成（會話 1026ms、正文首次可見 10175ms）。證據 harness10-installed-identity.json、harness10-replay.json、harness10-installed-hello.json。

安裝包 target/accepted-harness-installer-1.43.3-harness10/CodeBuddy-Harness-Setup.exe，325128704 位元組；SHA256 F0545B0619DF3375801B9F33CF121D426D865D0CA5E516F6BF5BDEB5F62C562B。維持 main 與未提交修改，未提交/推送。
