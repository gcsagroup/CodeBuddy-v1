# Harness 執行與目標權威遷移

日期：2026-10-14。目錄：`D:\CodeBuddy-v1`，無 Git 倉庫、分支、提交或推送；來源清單見 [source-baseline.json](source-baseline.json)。本記錄對應目前未提交原始碼，先前預覽測試及舊桌面程序不代表本次產品驗收。

[简体中文](2026-10-14-harness-authority.zh-CN.md) · [English](2026-10-14-harness-authority.en.md)

## 證據與批准邊界

使用者回報建立對話慢、答案集中出現，以及普通問候被標為中斷，並批准由官方 Harness 主導執行與排程，CodeBuddy 保留必要適配。原始會話 `c4117cd6-e198-4d7a-8ada-6ffdbd15ea85` 在北京時間 19:07:30、19:09:27 的原生 `turn/end` 均為 `completed`；舊適配因缺少 `codebuddy_task(answer)` 將其標成中斷。19:13:26 是獨立的 `TRANSPORT / Connection error.`，不是同一完成協定缺陷。

新會話移除自造 `submit_plan/start_task/task_result/propose_finish/answer` 門檻，使用已安裝的官方 `0.2.1-alpha.2` 插件。使用者後續明確前端可為後端權威調整；本切片不建立第二套排程協定。

## 事實來源與實作

| 事實 | 唯一執行或記錄來源 | CodeBuddy 職責 |
|---|---|---|
| 訊息接受、模型迴圈、工具及子 Agent 排程 | Harness Session Controller、AgentLoop、subagent | ACP/UI 欄位轉換、模型路由及權限適配 |
| 長目標與自動續輪 | 官方 goal、tool-goal、goal-round-driver | 消費 `goal/change` 與原生終態，不自行排續輪 |
| 當前輪清單 | `todo/write` 全量快照，`turn/start` 清空 | 顯示原清單；快照 ID 不代表 DAG 依賴 |
| 工具效果 | 原生工具結構化回執 | 展示及恢復引用，不以任務登記阻擋執行 |
| 暫停、恢復、重啟 | 原生生命週期及程序內 activation | 既有按鈕及輸入接原生控制，保留會話 ID 和歷史 |

新運行記錄 `executionOwner: harness`。`beginAttempt` 可顯式遷移舊 owner，舊事件前綴原樣保留。未知效果仍展示，允許先檢查檔案再繼續，不自動重放舊呼叫。舊門檻只保留歷史合同及回歸用途，不注入新會話。

`finishHarnessAttempt` 將正常無目標回覆標為 `harness_turn`，原生目標完成標為 `harness_goal`；active 目標、取消及行動/輸出限制保留暫停，真實傳輸錯誤保存失敗與代碼。這兩種完成均不等於 `verified_task` 或全部測試通過；驗證結果僅來自真實命令及獨立測試。

原生 goal 的 durable phase 與程序內 `armed/disarmed` 分離。重啟不自行恢復執行權；由使用者輸入與原生工具恢復。goal-round-driver 等待空閒及持久化 checkpoint，處理續輪與競爭。一輪結束不等於長目標完成。並行限制使用官方所有子 Agent 的總上限，角色模型選擇不另建 coder 排程器。

舊 UI 的 `cancel_task/cancel_branch` 對原生 todo 快照沒有對應執行概念，現明確回傳協議錯誤；單 worker 舊控制入口也在接入官方控制前回傳錯誤，不先停止整個 root 或偽造 worker 已停止。整個執行的暫停、恢復與緊急停止仍保留。新 run 不會把會話內上一項已完成目標再標為此次目標完成。

## 選擇依據

採用 [官方 goal](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/goal)、[todo](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/todo/tool-todo) 及 [Session Controller](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/api/session-controller)，重用事件、CAS、取消與持久化。[MIT 授權](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/LICENSE)，目前仍為 developer preview；固定版本，本次不自動升級。npm/參考原始碼對應界線見 [PROVENANCE.json](../../runtime/harness/PROVENANCE.json)。

沒有以回答結束宣布整個專案完成，也沒有依「你好」等關鍵字加入業務例外；普通對話直接回覆，長任務使用上游目標生命週期。

## 本切片驗證

在目前目錄使用已安裝 Node 24 執行：

```powershell
node --test --test-concurrency=1 runtime/tests/codepro.test.mjs runtime/tests/codepro-harness-projection.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/tests/roles-harness-integration.test.mjs runtime/tests/harness-authority-acp.test.mjs
```

31/31 通過、退出碼 0、約 9.86 秒。這是重疊子集，不與其他回歸相加。涵蓋舊歷史合同、新投影，以及官方 Harness、本機 HTTP 模型夾具、真實檔案與 PowerShell：跨模組、續輪、取消、重啟、同 run 恢復、原檔案 mtime/內容不變、Node 測試、總並行限制及角色路由。本切片未呼叫外部模型，未操作使用者 profile 或桌面視窗。

之後針對舊控制越權與目標作用域補充回歸：`node --test runtime/tests/codepro-harness-projection.test.mjs` 為 10/10、退出碼 0；舊控制修正後 legacy + projection 子集為 26/26、退出碼 0。這些是各次執行記錄，不作為後續全部變動的累計驗收。

主任務整合執行曾遇 Windows `state.json` 原子替換 `EPERM`。角色夾具原來每 10ms 開啟檔案觀察子 Agent 終態，確認存在與正式寫入重疊，但精確持鎖方未證實。現使用真實 Harness 事件的透明觀察器，等 compat 完成持久化後再計數；最後仍獨立讀盤核驗全部生命週期與回執。修改後單次相關回歸 1/1、退出碼 0、約 2.94 秒；保留並行上限與真實檔案斷言，不據此歸因外部掃描器。

這不是本次真實雲端模型、桌面端到端、數小時任務或大型倉庫驗收。[功能矩陣](v1-functionality.zh-TW.md) 保留其他首版接入與驗證缺口；本批全套與後續變動的最終執行證據由獨立驗收報告補充。
