# 真實 Kimi 暫停、服務重啟與同任務恢復驗收

2026-10-14，當前 `D:\CodeBuddy-v1` 源碼；基線見 [source-baseline.json](source-baseline.json)。使用精確鎖定的官方 Harness 0.2.1-alpha.2、原 ACP 控制接口和用戶已配置的 kimi-k3。沒有第二模型循環，沒有安裝依賴、Git 操作或外部業務寫入。只復制默認 provider 一項到獨立 profile；未修改原用戶配置，也未覆蓋此前真實驗收回執。

命令：Node 24 執行 `scripts/accept-real-codepro-resume.mjs`。實際 10:23:50–10:27:43 UTC（約 233 秒），退出碼 0。[完整回執](../../.preview-evidence/real-codepro-resume-qwEdcn/receipt.json)；[獨立測試日志](../../.preview-evidence/real-codepro-resume-qwEdcn/independent-tests.log)。

## 經過與結構化事實

| 階段 | 實際事實 |
|---|---|
| 原任務 | session `62c07f46-3c6b-43e9-b311-5240e2c34bd8`；run `a4b24ed2-f603-4649-979e-549c462218b9` |
| 計劃與首個模塊 | Kimi 創建 money → invoice-tests → verification。money 原生 write 成功回執 sequence 8，task_result succeeded 為 9 |
| 暫停 | 基于真實 task_result 通知調用 pause_run；pause_requested 10、attempt_finished 11。activeAttempt=null，pendingEffects=0，uncertainEffects=0 |
| 服務重啟 | 關閉服務器及連接，新建 createCompatServer，重新 acquire lease、session/load；原事件序列逐項相等，保持原 runId |
| 恢復 | run/control resume_run 為 12，attempt_started 13；Kimi 先讀取已有模塊，再補 invoice、tests、package.json |
| 驗證完成 | 源碼檢查后批準唯一固定 Node 測試命令；原生 verification exitCode=0，任務成功 27，run_completed 28、attempt_finished 29 |
| 獨立復驗 | 15/15 測試通過，退出碼 0；第一模塊 SHA256 和 mtime 不變，原事件前綴完整、原 write 回執僅一份；無待執行或不確定副作用 |

工具授權限定隔離目錄與四個目標文件，恢復階段禁止重寫第一模塊。shell 只批準固定本地測試命令；四個生成文件只包含本地模塊、node:test、node:assert/strict 及包元信息，人工源碼檢查以文件哈希和 mtime 回執綁定后放行。測試過程沒有執行網絡、安裝或 Git 工具。

腳本后續補嚴了 shell workdir、run_in_background、權限升級字段校驗；實際記錄的那次調用使用本隔離 workdir、未請求后臺或升級，符合補嚴后的條件。相關權限與事件連續性回歸 2/2；會話編輯 6 項及 ACP 編輯 1 項聯合 9/9，退出碼 0。

## 覆蓋邊界

這是一個實際云端模型通過 ACP、官方 Harness 原生工具和真實文件完成的恢復驗收，非腳本模型回復夾具。暫停由已提交回執觸發，沒有用等待時間猜測狀態；重啟使用新的服務器實例，未殺宿主操作系統進程。第一階段沒有人為長時間寫操作。

該結果不代表真實 Electron 關閉重開、macOS、強制殺進程時的工具副作用、大型倉庫全量質量或持續數小時負載已經通過。測試項目用于驗證執行與恢復鏈路，不作為生產財務庫交付。真實 SIGKILL journal 恢復另有自動測試，不與本次主動停機混為一項。

若重新運行，腳本創建全新獨立 profile；遇到固定測試命令審批，會生成 review-pending.json。檢查四個源文件后，將該精確哈希回執保存為 source-review.json。腳本設九分鐘總時限，超時保留可續的狀態并報告 interrupted，不歸因為產品缺陷。
