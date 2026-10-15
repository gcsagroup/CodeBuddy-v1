# Harness 主導執行：本批驗收記錄

> 20:16 日常 profile 暴露了先前未覆蓋的大量歷史列表阻塞。下文屬於較早批次的歷史證據；根因、修復及日常視窗複驗見[補充記錄](2026-10-14-history-latency.zh-TW.md)。

日期：2026-10-14（北京時間）。對象：`D:\CodeBuddy-v1` 目前原始碼；原專案 revision `964bbeb1587f1c5551ee17907e0b26632c4163ce` 與未提交檔案來源見 [source-baseline.json](source-baseline.json)。目前目錄無 Git 倉庫，本批沒有分支、提交或推送。官方 npm Harness 固定為 `0.2.1-alpha.2`，MIT developer preview；npm 與參考原始碼對應邊界見 [PROVENANCE.json](../../runtime/harness/PROVENANCE.json)。

[简体中文](2026-10-14-harness-acceptance.zh-CN.md) · [English](2026-10-14-harness-acceptance.en.md) · [功能矩陣](v1-functionality.zh-TW.md)

**本批範圍已通過：真實模型 ACP 對話、六模組暫停/後端重啟/續作、最終真實 Electron 兩輪顯示複驗、受控 Electron 恢復及目前原始碼預覽啟動。全集 327/327、後續顯示修訂受影響子集 30/30、元件回歸 42/42。** 這不是全部首版功能或正式安裝包驗收；舊預覽 286 項不算目前全套。20:05 [最終原始碼身分](../../.preview-evidence/harness-final-source.json)記錄 Node `v24.21.0` 與 19 個檔案 SHA256。[最終前端比較](../../.preview-evidence/harness-frontend-final-comparison.json)檢查 1069 個檔案：1067 未變、2 個獲准修改、意外差異 0。

兩處前端修改僅為 `ui/desktop/src/components/ProgressiveMessageList.tsx` 與同名 `.test.tsx`：一般聊天沒有真實操作時不產生空活動區，保留思考與實際工具展示。這屬於使用者已核准的必要顯示適配，不再聲稱前端原始碼完全零變更。19:53 的 1069 檔案零差異歷史事實保留在[修改前快照](../../.preview-evidence/harness-source-before-empty-activity.json)。

19:55 的[來源 UI 複核](../../.preview-evidence/harness-source-ui-current.json)記錄原專案目前 HEAD 為 `dfdc47fb1a8d483fc02293b85d977e87a8969f10`，1074 個原 UI 檔案與複製基線一致。此目前 HEAD 與上方初始基線 revision 區分，不以舊 revision 冒充原目錄目前狀態。

## 根因與處理邊界

| 現象 | 已核實事實 | 本批處理及邊界 |
|---|---|---|
| 新對話建立慢 | 舊 `session/new` 等待 Harness、設定解密與擴充初始化。隔離測量：受保護全域設定 7916ms、明確設定 13320ms、慢 MCP 15849ms | 新建先保存對話，首次執行再初始化，減少重複解密；對應測量 4ms、279ms、274ms。初始化仍有成本，獨立 MCP 並行連線並保留各項錯誤 |
| 等待後集中出字 | 原對話原生首片前等待 26.768s / 19.298s，其後原生文字增量集中於 14ms / 19ms，發生在 ACP 之前。受控分時 SSE 經 Harness→ACP→原 renderer adapter 保持間隔 | 目前真實 SDK 與原始 SSE 均觀察到串流輸出；歷史服務、網路或請求條件的具體成因尚未確定。新增去敏耗時、狀態與網路原因代碼觀測，不聲稱已修復某個未證實的服務端問題 |
| 正常回覆卻顯示中斷 | 原生 `completed` 被舊 CodeBuddy 完成協定要求 `codebuddy_task(answer)` 誤判，這是適配層缺陷 | 一般正常輪次按原生事實完成；長目標消費原生 goal，不要求舊登記協定 |
| 另一輪 Connection error | 19:13 原生記錄為真實 `TRANSPORT / Connection error.`；舊設定強制重試 0 次 | 恢復官方有界重試，真實錯誤保留；重試改善恢復，但未確定歷史斷線的底層來源 |

[建立前測量](../../.preview-evidence/session-new-timing-diagnostic.json)、[修改後測量](../../.preview-evidence/session-new-timing-diagnostic-after.json)為隔離後端情境，不是所有裝置的延遲承諾。預設容器仍為 `D:\CodeBuddy-Workspace`，每任務獨立目錄，明確選擇專案保留。

原對話 `c4117cd6-e198-4d7a-8ada-6ffdbd15ea85` 的結束原因見[權威遷移記錄](2026-10-14-harness-authority.zh-TW.md)。[受控串流回執](../../.preview-evidence/stream-timing-bgBLI9/receipt.json)中三片間隔約 350ms，Harness→ACP 耗時 15.45 / 2.46 / 2.26ms；它驗證適配器鏈路，不等於真實 Electron 畫面驗收。

## 事實 owner 與改動範圍

| 範圍 | 官方 owner | CodeBuddy 適配職責 |
|---|---|---|
| 執行與子 Agent 排程 | Session Controller、AgentLoop、subagent | `runtime/harness/index.mjs` 接入、權限及角色模型選擇；並行參數 1–32 對應官方總上限，無第二套 coder 排程器 |
| 長目標與自動續輪 | goal / goal-round-driver / tool-goal | `profile.mjs` 啟用官方外掛；active+armed 時 prompt 保持承載。Stop disarm，重啟不自動重播；明確暫停恢復先建立串流/權限，再呼叫官方 CAS resume |
| 清單與完成展示 | todo/write、turn/start、goal/change | `codepro.mjs` 僅投影結構化事實，todo 屬於目前輪，不虛構 DAG；harness_turn/harness_goal 不等於獨立測試通過 |
| 建立與通訊 | 產品對話、原 ACP、Electron 橋接 | `compat.mjs` 分離建立及執行環境初始化，前端接線服從原生後端權威 |
| 網路恢復 | 官方 llm-retry | `transport-observation.mjs` 僅觀測白名單錯誤代碼、耗時與計數，不記錄內容、憑據、請求標頭或 URL，不修改 fetch/串流 |
| MCP/設定/記憶 | 官方 MCP、工具及 storage-domain/storage-json | 產品設定、權限與展示保留；外部記憶可走 MCP，不聲稱上游存在獨立內置 memory provider |

完整介面見[執行環境說明](../../runtime/harness/README.zh-TW.md)。MCP 獨立連線並行、單項失敗可見；官方預設 60 秒為每請求逾時，版本協商可能涉及多個請求，並非全體擴充總啟動期限。

## 真實模型與串流指標

使用已保存 `kimi-k3` 設定及隔離資料根。下表為不同時間樣本；完整提示詞與執行參數不保證逐字相同，不應作為嚴格等價的效能 A/B。

| 路徑 | 首片/首正文 | 總耗時與增量 | 回執 |
|---|---|---|---|
| 原始 SSE，48 工具 schema，high | 首網路 body 2.217s | 4.131s；37 網路區塊、70 SSE 幀；未執行工具 | [HTTP 200](../../.preview-evidence/diagnosis-20261014/direct-sse.json) |
| 官方 Harness driver，48 工具 schema，high | 首思考 2.885s；首正文 3.516s | 4.282s；143 增量＝58 思考＋85 正文；網路區塊跨 1.392s；工具嘗試 0 | [passed](../../.preview-evidence/official-real-stream-4WEjgH/receipt.json) |
| ACP 新對話「你好」 | 首正文 6.639s，含首次執行環境初始化 | 7.917s；117 正文區塊，首末跨度 1.252s | [passed](../../.preview-evidence/native-chat-xvSway/receipt.json) |
| 同一 ACP 對話第二輪 | 首正文 3.003s | 3.816s；89 正文區塊，跨度 0.608s | 同上；兩輪均 end_turn / harness_turn，無工具回執 |

ACP `session/new` 為 4ms，不含目錄選擇、視窗繪製等使用者操作。上述 ACP 樣本時間約為北京時間 19:35。

北京時間 19:52–19:53 使用原 renderer、真實 Electron、保存模型與隔離 profile 另做兩輪聊天：[真實介面回執](../../.preview-evidence/real-chat-ui-xXzIZR/receipt.json)。新對話可見耗時 **478ms**，無須目錄選擇器；首輪首正文 9.973s、完整可見回答 12.624s、81 區塊/4 次 UI 提交；二輪首正文 2.802s、完整可見回答 6.812s、152 區塊/5 次 UI 提交。兩輪全文 ACP/DOM 一致、completed/harness_turn，pageErrors 與 consoleErrors 為空。驗收程序已回收；這是一般聊天產品驗收，不是所有頁面或工具的桌面驗收。首輪仍有約十秒首正文等待，應與快速建立對話區分。

20:03–20:04 在上述兩處前端修改後執行[最終真實兩輪顯示複驗](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json)，狀態 passed。新對話 **361ms** 可見，無目錄選擇器；首輪首正文 **11.807s**、完整可見回答 **15.207s**，109 區塊/4 次 UI 提交；二輪首正文 **3.084s**、完整可見回答 **6.759s**，135 區塊/5 次 UI 提交。兩輪全文一致、completed/harness_turn，思考顯示保留，無空操作計數與一般聊天驗證卡，pageErrors/consoleErrors 均為空，驗收程序已回收。首輪正文等待仍達 11.807s，不以快速建立對話代替模型回應延遲結論。

## 六模組真實開發、停止與重啟續作

[專案回執](../../.preview-evidence/native-project-SI0dN5/receipt.json)為 `passed`，北京時間 19:35:31–19:37:00，約 89.8 秒。真實模型透過 ACP、官方 Harness 與實際工具實作 money/catalog/cart/discount/inventory/order 六模組。僅准修改 `packages/*/index.mjs`，測試合同唯讀，禁止網路、安裝及 Git 寫入。

1. 原生 create_goal/todo 後首次檔案寫入，客戶端送出 `session/cancel`；首輪 cancelled，任務 paused。
2. 關閉後端伺服器、建立新伺服器、重新取得工作區租約並載入原對話，再送出繼續訊息。這是後端實例重啟，未模擬 OS 強制終止或 Electron 關閉重啟。
3. sessionId `b793f5e7-e334-44b2-a9b2-cd22a9c8b81a`、runId `b39c0b2b-aa60-41ab-b0a3-2eeeff66a0fe` 保持，舊事件前綴保持。
4. 原生測試命令退出 0，獨立合同測試 **33/33**、失敗/取消/跳過均 0：[日誌](../../.preview-evidence/native-project-SI0dN5/independent-tests.log)。測試檔案雜湊未變。獨立讀盤複核首個 money 檔案 SHA256、mtime 精確保持，最終僅一次該路徑寫入回執。
5. 原生 goal `goal-7b1c87ab-9a6f-44a0-a6ca-f3df736e3a0b` 為 complete，投影 harness_goal。首階段 48.142s，恢復階段 41.108s，恢復後首正文 2.936s。

原生 `roundsStarted: 0`：此真實樣本沒有觸發自動目標續輪，自動續輪由受控官方外掛回歸另證。**已證明分鐘級六模組與後端重啟續作；未證明小時級無人值守、大型正式倉庫、真實並行雲端協作或全工具箱。**

## 受控 Electron 恢復

[本批真實 Electron 恢復回執](../../.preview-evidence/controlled-ui-resume-ox7zjR/receipt.json)為 passed：使用真實介面、受控 HTTP 模型，停止後關閉/重啟桌面，再載入並繼續同一 run `b6108765-a665-4f80-88da-27dda281a3c2`。原生 14 次工具呼叫、5 次 todo 寫入，goal 最終 complete；首檔案雜湊/mtime 與歷史保持，獨立 [3/3 測試、退出 0](../../.preview-evidence/controlled-ui-resume-ox7zjR/independent-tests.log)，pageErrors/consoleErrors 均為空。這驗證桌面控制鏈，與六模組真實雲端模型 ACP 測試分開。介面任務報告尚未給出獨立 verification 標籤，保留實際命令回執，不由顯示文字虛構該標籤。

## 自動化與最終結果

Harness 定向命令（已安裝 Node 24）：

```powershell
node --test --test-concurrency=1 runtime/harness/test/driver.test.mjs runtime/harness/test/capabilities.test.mjs runtime/harness/test/recovery.test.mjs runtime/harness/test/goals.test.mjs
```

[一次合集 39/39、退出 0](../../.preview-evidence/harness-final-39.log)；其後並行 1–32 與 maxTurns+goal 邊界的受影響子集 [27/27、退出 0](../../.preview-evidence/harness-goal-capacity-boundaries.log)。它們重疊，不相加。涵蓋自動續輪、CAS、停止/重啟不重播、自動壓縮保留 goal/todo、部分串流斷線重試且副作用一次、AUTH 不重試、取消退避、MCP 並行及明確逾時。maxTurns 達限後官方 goal disarmed，未誤報完成。

| 門檻 | 狀態 | 實際回執 |
|---|---|---|
| 本批後端/腳本全集 | **PASS 327/327，退出 0** | [最終全集日誌](../../.preview-evidence/harness-authority-final-tests.log)，228.410s，失敗/取消/跳過 0；其後一般聊天顯示修訂的[受影響 30/30](../../.preview-evidence/harness-terminal-display-tests.log)退出 0，5.859s，不加總 |
| 真實 Electron 一般聊天最終顯示 | **PASS（UqLIqK，20:03–20:04）** | [最終回執](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json)：兩輪全文一致，無空操作計數/驗證卡，思考保留，無 UI 錯誤。先前 [HKem83](../../.preview-evidence/real-chat-ui-HKem83/receipt.json) 的空計數斷言失敗仍保留，不覆蓋舊失敗證據 |
| 目前候選受控 Electron 停止/重啟/繼續 | **PASS（受控模型）** | 上方回執：同 run、原生目標 complete、真實工具、獨立 3/3、無 UI 錯誤 |
| 顯示適配元件回歸 | **PASS 42/42，退出 0** | 3 個元件測試檔案，33.21s；[日誌](../../.preview-evidence/real-chat-ui-UqLIqK/component-tests.log)，實際命令見下 |
| 目前原始碼使用者預覽啟動 | **PASS（程序 running）** | [20:06:38 啟動回執](../../.preview-evidence/harness-final-preview.json)，19 原始檔雜湊一致，新任務頁面可見；並非發布安裝包 |

本批全集與顯示修訂後的實際命令如下；第二條是第一條之後的受影響回歸，不將兩次數量相加：

```powershell
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' --test --test-concurrency=1 runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/*.test.cjs scripts/*.test.mjs *> .preview-evidence/harness-authority-final-tests.log
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' --test --test-concurrency=1 runtime/tests/harness-authority-acp.test.mjs runtime/tests/codepro-harness-projection.test.mjs runtime/tests/codepro-integration.test.mjs runtime/tests/codepro-harness-integration.test.mjs *> .preview-evidence/harness-terminal-display-tests.log
```

元件測試工作目錄為 `D:\CodeBuddy-v1\ui\desktop`；[回執 componentValidation](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json)保留原執行資訊，未為日誌重複執行：

```powershell
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/ProgressiveMessageList.test.tsx src/components/ToolCallExpandable.test.tsx src/components/GooseMessage.stream.test.tsx
```

## 目前預覽啟動及資料保留

透過既有 `start-preview.ps1` 入口啟動，隱藏 PowerShell 啟動程序 36220；啟動器 25292、後端 36136、Forge 38156、Electron 主程序 39740。20:06:38 可見 CodeBuddy 新任務視窗（控制代碼 33295174），19 個目前原始碼雜湊吻合。啟動建置的 SDK/i18n 準備門檻退出 0；應用仍在執行，應用生命週期並非「退出 0」。唯讀啟動檢查器退出 0。

使用者目錄 `.preview-data` 的啟動前 621 個對話全部保留，目前仍為 621；預設 `kimi-k3` 與 provider 設定指紋未變，1 個遷入日程仍暫停，`D:\CodeBuddy-Workspace` 存在。見[啟動/資料回執](../../.preview-evidence/harness-final-preview.json)。本次檢查沒有送出模型請求；真實任務證據在前述隔離驗收中。執行日誌位於 `.preview-data/logs/preview/runtime.log` 與 `electron.log`。

[環境比較](../../.preview-evidence/harness-final-environment-comparison.json)為 unchanged、差異為空：User/Machine/Process PATH 及協定註冊指紋保持。此交付是目前原始碼的 Windows 開發預覽視窗，並非安裝包或 macOS 交付。

## 保留的首版缺口

[功能矩陣](v1-functionality.zh-TW.md)保留 Git 遠端/還原/衝突操作、GitHub 帳號/PR/CI、Nostr、本地 ASR、複雜配方、OAuth、全部設定/工具真實桌面流程等未接或待驗項。Windows 證據不替代 macOS、安裝包、小時級任務或大型真實倉庫驗收。實作、受控自動化、真實模型 ACP、真實 Electron 及發布驗收分開記錄。
