# 日常歷史設定中的首輪卡頓

本記錄修正同日較早的驗收範圍：先前真實 Electron 測試只有少量歷史及部分擴充功能，日常 profile 啟動後未再傳送訊息，漏掉了大量歷史造成的阻塞。

目錄為 `D:\CodeBuddy-v1` 當前未提交原始碼，沒有 Git 倉庫；沒有分支、提交、推送、依賴安裝或升級。Harness 仍主導執行、排程及完成判定。

使用者 20:16 的「你好」在模型請求之前等待約 183 秒，後續另有 `UND_ERR_SOCKET` 及官方重試。日常視窗重現每次 `session/list` 約 11 秒，且連續刷新。[通信記錄](../../.preview-evidence/daily-ui-elx9cg/receipt.json)在約 122 秒受到開發熱重載影響，其後不算完整對話驗收。

確定根因：每條歷史取得最新執行資訊時同步複製全部資料；側欄以次數估算 10 秒輪詢，沒有包含請求耗時。同一份 623 條歷史（617 條未封存）測量：舊路徑 618 次快照、9764.7ms；修復後 1 次、20.7ms。[測量](../../.preview-evidence/history-list-before-after.json)只代表本機樣本。獨立 MCP 連線約 0.66/2.47 秒；完整設定獨立 ACP 首正文約 8.9 秒、完成約 10.5 秒，並非外網穩定性保證。

`runtime/compat.mjs` 列表共用單次快照，`runtime/codepro.mjs` 從該快照取得原有權威投影；`useNavigationSessions.ts` 按實際時間停止輪詢，卸載後不再刷新，版面與功能維持不變。新增 650 條歷史與慢請求回歸。後端合同 26/26、歷史與執行 23/23（重疊一項）、側欄 13/13，退出碼 0。第一次 hook 測試缺少 mock，修正後通過。[合同](../../.preview-evidence/history-latency-contract-tests.log)、[歷史](../../.preview-evidence/history-latency-tests.log)、[側欄](../../.preview-evidence/sidebar-latency-tests.log)。

20:32 以現有 `node scripts/start-harness-preview.cjs` 啟動修復版，後端 PID 18652、Electron 6808，視窗保留。沒有更換模型或刪減歷史及擴充功能，設定逐欄比較一致。兩次直接操作真實視窗建立新對話並傳送「你好」：建立耗時 1.223/0.878 秒，首正文 10.035/8.732 秒，後台完成 10.393/10.232 秒，正文增量 8/96 次。兩次 Harness completed，真實回答可見，第二次完整顯示與持久化正文相符。[最終回執與原始碼身分](../../.preview-evidence/history-latency-final.json)。UI 動畫完成時間與後台完成不同，8–10 秒仍包含初始化和模型等待；原網路斷線原因尚未完全確定。

命令：`node --test runtime/tests/history-list-latency.test.mjs runtime/tests/acp-contract.test.mjs runtime/tests/codepro-harness-projection.test.mjs`；`node --test runtime/tests/history.test.mjs runtime/tests/history-list-latency.test.mjs runtime/tests/codepro.test.mjs`；在 `ui/desktop` 執行 `node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/hooks/useNavigationSessions.test.tsx src/components/Layout/NavigationPanel.test.tsx`，退出碼均為 0。

macOS、數小時目標及全部首版功能仍不屬於本次缺陷修復的驗收結論。
