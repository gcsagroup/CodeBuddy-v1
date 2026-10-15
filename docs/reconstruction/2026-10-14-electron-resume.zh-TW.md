# Electron 既有停止與重啟續作驗收

日期：2026-10-14；源碼為當前 `D:\CodeBuddy-v1`，見 [source-baseline.json](source-baseline.json)。使用已有 `start-harness-preview.cjs` 入口、Node 24、原 Electron renderer、官方 Harness 0.2.1-alpha.2 與本機受控 HTTP 模型。未修改 renderer、用戶 Kimi profile、依賴、分支或提交。

`node scripts/accept-controlled-codepro-resume-ui.cjs` 最終退出 0，實際 10:40:14–10:41:45 UTC。獨立 profile 為 `.preview-evidence/controlled-ui-resume-RnxtKT`；[回執](../../.preview-evidence/controlled-ui-resume-RnxtKT/receipt.json)和[獨立測試日志](../../.preview-evidence/controlled-ui-resume-RnxtKT/independent-tests.log)保留。

## 原界面的實際路徑

1. 點擊“新任務”，在原輸入框發送獨立開發目標。
2. 受控模型通過官方工具創建三步計劃，實際寫入 math 模塊并提交成功回執，然后等待下一次模型響應。
3. 點擊輸入框旁的“停止”。owner 結束 attempt，保存 paused；無執行中 attempt、待執行副作用或不確定副作用。
4. 關閉實際 Electron 窗口，原 launcher 回收后端及 Electron 子進程。
5. 同一 profile 再次通過原 launcher 啟動，點擊“歷史記錄”打開同一個任務，點擊“確認并開始”確認已有工作區。
6. 原輸入框發送“繼續現有任務……”，保留同一 runId。模型讀取既有結構化事實，寫 invoice 與 tests，運行真實 PowerShell/Node 測試，提交驗證與完成提案。
7. 原頁面實際顯示“已完成”“測試通過”“3/3”；獨立重跑 3/3 通過、退出 0。最后關閉驗收窗口并檢查進程回收。

最新 AppLayout 使用 WorkspacePanel，舊 CodeProControlPlanePanel 的“暫停/恢復”按鈕沒有掛載。因此本次驗證的是可見“停止”與后續消息繼續，不聲稱點擊過不可見按鈕。腳本沒有調用隱藏 ACP 控制請求替代 UI 操作；Playwright/CDP 使用原生 locator 操作，頁面 JavaScript 僅只讀觀察。

## 身份、狀態與回收

| 對象 | 證據 |
|---|---|
| Session | `cb7d8ea7-7e64-47c5-b3b5-825783de2aa3` |
| Run | `3620b8c7-2a82-4342-b8dc-11d57d8de84e`，重啟前后相同 |
| 路由 | `http://localhost:5173/#/codepro/pair?resumeSessionId=cb7d8ea7-7e64-47c5-b3b5-825783de2aa3` |
| 狀態序列 | run_created 1 → attempt_started 2 → 首模塊回執 6、任務成功 7 → 停止后 attempt_finished 8 → 繼續 attempt_started 9 → 驗證回執 18 / exitCode 0 → run_completed 20 → attempt_finished 21 |
| 第一輪進程 | runtime 34068、Forge 36152、Electron 主進程 34128；含子進程全部退出 |
| 第二輪進程 | runtime 36404、Forge 33268、Electron 主進程 9676；含子進程全部退出 |
| 測試編排進程 | PID 23968，最終退出碼 0；9389 無監聽 |
| 連續性 | 原事件前綴逐項相等；首文件 hash、mtime 不變；首 write 回執唯一；最終 pendingEffects/uncertainEffects 為 0 |
| 頁面錯誤 | pageErrors=[]，consoleErrors=[] |

截圖：[執行中](../../.preview-evidence/controlled-ui-resume-RnxtKT/01-running-before-pause.png)、[停止后](../../.preview-evidence/controlled-ui-resume-RnxtKT/02-paused.png)、[重開確認](../../.preview-evidence/controlled-ui-resume-RnxtKT/03-reopened-workspace-confirmation.png)、[已回放](../../.preview-evidence/controlled-ui-resume-RnxtKT/04-replayed-paused-run.png)、[完成](../../.preview-evidence/controlled-ui-resume-RnxtKT/05-completed.png)。停止和完成截圖已實際查看。

## 保留的不完整嘗試與邊界

- `controlled-ui-resume-QOEUSE`：原本查找舊暫停按鈕，確認當前頁面沒有該入口，退出 1；窗口與子進程回收。
- `controlled-ui-resume-mosbb9`：實際停止/重啟/繼續已到真實 run_completed，但固定模型序列沒有回應官方自動壓縮之后的額外請求，退出 1。原生 JSONL 明確為 compact-checkpoint；屬于驗收夾具缺口，原記錄保留。
- 最終夾具為 owner 已完成后的少量純文本請求補齊有限回復，重新完整運行通過。最終也出現 1 次官方自動壓縮；這不證明云端壓縮摘要質量。

本次為真實 Electron 用戶路徑、受控模型、真實文件和原生測試的 Windows 驗收。與 [真實 Kimi ACP 恢復 15 項測試](2026-10-14-real-codepro-resume.zh-TW.md)分開記錄，不把兩份證據合成為“真實 Kimi Electron 重啟已驗”。沒有小時級負載、復雜倉庫、強殺進程或 macOS 驗收結論。
