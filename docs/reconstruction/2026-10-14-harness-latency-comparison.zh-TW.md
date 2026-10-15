# Harness 直連對比與首輪延遲

截至 2026-10-14 21:07，本地重復工作已修復，功能回歸與真實對話正常；**新會話延遲目標仍未達成**。最終真實窗口兩輪首正文為 13.743s、15.030s；同一會話追加消息為 3.780s。這些結果不支持“已穩定秒回”的結論。

## 對比方法

使用當前固定版本的官方 Harness `SessionController` 直接創建會話、選擇模型和發送“你好”，繞過 CodeBuddy Compat、ACP 和 Electron。不是另外安裝的上游 CLI。兩側使用相同 kimi-k3、high 思考檔位、50 個工具、提示詞、角色及 Exa/autovisualiser 擴展；配置憑據只在本機解密，不寫入報告。官方源碼和許可證來源見 [上游](https://github.com/deepseek-ai/deepseek-harness) 及本地 `runtime/harness/PROVENANCE.json`。

采用 Compat → 原生 → 原生 → Compat 順序，每個樣本使用獨立會話。原生側憑據在計時前注入，Compat 包含配置準備；兩者均計入運行時啟動、會話建立、工具發現和響應。Compat 隔離 profile 復制當前歷史與配置，不執行用戶日程。不是嚴格控制遠端負載的實驗，樣本數也不足以估計服務 SLA。

最終四個真實請求的正文均為 48,493 字節、50 個工具，SHA256 全部相同：`3cd5669b83df33cb7647cc03a88a6b8469cea8061dc3bc8d95260b1731556385`。沒有通過關閉工具或降低思考檔位獲得快結果。

| 最終比較 | 請求模型前 | 首正文 | 完成 |
|---|---:|---:|---:|
| Compat 1 | 8.581s | 12.401s | 13.183s |
| 官方原生 1 | 3.416s | 6.553s | 8.298s |
| 官方原生 2 | 3.441s | 7.273s | 8.628s |
| Compat 2 | 4.184s | 6.716s | 7.117s |

[最終比較回執](../../.preview-evidence/harness-compare-73Injt/receipt.json)。Compat 1 的 Exa 建連耗時 5.981s，適配準備 0.876s；第二輪本地適配與遠端耗時均有變化，不能將兩輪差值全部歸因于代碼優化。

其他批次也保留：修復前完整配置首正文 Compat 7.537/7.295s、原生 6.028/4.694s（[回執](../../.preview-evidence/harness-compare-boBe7R/receipt.json)）；之后空閑批次 Compat 8.910/6.541s、原生 5.405/4.092s（[回執](../../.preview-evidence/harness-compare-qiNbuv/receipt.json)）；另一批原生也達 12.178/13.756s（[回執](../../.preview-evidence/harness-compare-eW0vbo/receipt.json)，當時本機另有用戶對話）。不能挑單次最快值作為驗收。早先 20 工具原生樣本僅作探索，不與 50 工具路徑作等價比較。

## 已修復與剩余原因

- `runtime/secrets.mjs` 合并同一密文正在進行的 DPAPI 解密；完成和失敗都清理，不緩存已解密明文。`runtime/providers.mjs` 并行讀取 key 與 headers。
- `runtime/compat.mjs` 并行準備角色配置、擴展快照及原生工具清單，復用這一份快照；原有設置版本、會話身份與權限校驗保留。
- `runtime/store.mjs` 支持只復制指定字段的脫離式快照；`runtime/settings.mjs` 及 Compat 配置熱路徑不再復制全部歷史。寫入、原子替換、持久化格式保持原狀。同一份日常數據讀取偏好 50 次：全量快照 2028ms，字段快照小于 1ms（[本地測量](../../.preview-evidence/settings-projection-timing.json)）。此數字只覆蓋讀取成本。
- `runtime/compat.mjs`、`runtime/harness/index.mjs` 記錄適配準備、MCP 初始化、模型首增量和結束的脫敏耗時，不記錄 URL、密鑰、請求或響應正文，不改變官方重試與完成判定。

遠程 MCP 在官方插件激活時建立連接并發現工具。目前每個會話使用獨立配置作用域，新會話仍需重新連接；本次 Exa 在實際窗口分別為 2.625s、8.126s，自動可視化工具為 0.124s、0.100s。模型請求至首增量分別為 5.198s、2.703s（含思考增量），不是純首正文時間。該路徑仍有宿主建立會話、持久化投影及界面切換的額外耗時。

沒有關閉 Exa、改為工具未就緒即請求模型，也沒有自行建立跨會話 MCP 連接池。這些做法涉及工具可用性、會話配置快照和連接狀態隔離，不能用它們掩蓋本次速度驗收未達標。外部服務波動沒有因本地優化消失。

## 驗證和當前窗口

最終源碼來自 `D:\CodeBuddy-v1`，目錄沒有 `.git`；保留原有未提交文件，未建分支、提交、推送、安裝或升級依賴。當前批沒有修改前端。源碼 SHA256、完整設置保持一致、631 條歷史、真實 UI/持久化正文一致及啟動身份見 [驗收回執](../../.preview-evidence/startup-latency-final.json)，狀態明確為 `functional_pass_latency_not_met`。

后端回歸 58/58：`node --test --test-concurrency=1 runtime/tests/store-atomicity.test.mjs runtime/tests/settings-runtime.test.mjs runtime/tests/extension-resolution.test.mjs runtime/tests/providers.test.mjs runtime/tests/roles.test.mjs runtime/tests/acp-contract.test.mjs runtime/tests/session-extensions.test.mjs runtime/tests/model-settings.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/tests/history-list-latency.test.mjs`，退出 0，[日志](../../.preview-evidence/startup-projection-tests.log)。新增覆蓋并發解密、失敗后重試、并行準備順序、650 條歷史下配置快照隔離和提交可見性。

加入耗時日志后，重跑受影響目標與傳輸恢復測試 17/17，退出 0：`node --test --test-concurrency=1 runtime/tests/settings-runtime.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/harness/test/recovery.test.mjs`，[日志](../../.preview-evidence/startup-observation-tests.log)。包含模擬斷線恢復；不是公網連接穩定性證明。

21:03 通過現有 `node scripts/start-harness-preview.cjs` 啟動開發預覽，后端 PID 15132、Electron 主進程 38376，使用原 `.preview-data` 和默認工作區 `D:\CodeBuddy-Workspace`。真實 Electron 點擊“新任務”發送“你好”，新會話分別在 1.070s、0.884s 創建，8/68 個正文增量，兩次 Harness completed，無提交錯誤或誤報中斷。對話、設置與歷史均保留，窗口保持打開。

最終截圖：[第一輪](../../.preview-evidence/daily-ui-fZBC2U/result.png)、[第二輪](../../.preview-evidence/daily-ui-3v1bXF/result.png)。同一會話追加的 [回執](../../.preview-evidence/daily-ui-WyQEJz/receipt.json) 為首正文 3.780s、完成 4.799s；其中 `first_visible_assistant` 會讀到上一條回答，應以本輪 `agent_message_chunk` 計時，不能采用其 0.576s 值。追加消息未重做 MCP 初始化，模型首增量 2.105s。

中間未補足診斷的兩批真實窗口結果也保留：13 秒附近及 10–13 秒，不能作穩定加速證明。本次只驗收此缺陷鏈路；長任務、多模塊項目、macOS、全部首版功能及之前公網斷連的徹底根治不在通過結論內。后續優化重點是官方 MCP 生命周期與會話作用域，需保留所有工具能力和配置隔離。
