# 首版功能接入與驗收矩陣

最新上下文真實UI：4次成功自動壓縮、用量/進度更新、重啟後事實正確保留；閾值邊界已修，相關53/53。 [详情 / Details](2026-10-15-context-ui.zh-TW.md)。

最終實際複驗：組合修復的獨立預覽runtime20864，參數表單等待316.149秒後提交並信任執行，建立會話 `cb3b1a34-46f4-4e33-ad2e-3d727412d473`；Kimi準確回覆隨機FORM標記，26個訊息增量、零工具，Harness原生 `completed/harness_turn`，參數與畫面、落盤一致。第一次323.508秒租約到期仍作為失敗對照。 安裝包靜態邊界：Forge仍打包舊Rust資源，main.ts未指定外部後端時仍啟動startGooseServe。Harness資源與啟動接線尚未完成；目前僅start-preview.ps1開發預覽。

最新後端367/367、相關前端99/99、Node24子集45/45，皆exit0。見 [recipe parameters](2026-10-15-recipe-parameters.zh-TW.md)。

最新附件補驗：窄版附件、識圖能力設定與核准前路徑展示已修復；真Kimi圖片/中文檔案/修正/重載四輪通過，另驗拒絕分支。前端112/112，後端未改復用360/360。見[附件專題](2026-10-15-attachments.zh-TW.md)。拒絕操作頂部彙總誤報已修復及重載複驗。

最新補充：時間與天氣三工具已接入Harness，真Kimi、設定即時生效、連線重用、工具箱及歷史已驗；後端全集360/360。見[本批查詢驗收](2026-10-15-common-queries.zh-TW.md)。其他限制保留。

最新夜間證據見[驗收跟蹤](overnight-acceptance.zh-TW.md)：全集357項、真實模型十二模組31次成功壓縮、中文MCP設定保存及兩會話連線複用/工具箱統計。下方較舊條目以跟蹤文件的新證據為準。

**本批最新驗收：[Harness 主導執行驗收記錄](2026-10-14-harness-acceptance.zh-TW.md)。** 已補入真實模型串流對話、六模組 33/33 停止/後端重啟/同 run 續作及真實 Electron 兩輪聊天；最終全集、受控桌面恢復及交付啟動見報告獨立欄。下方舊預覽回執保留原有範圍，286 項不計為本次替換的全套通過。

審計日期：2026-10-14。對象為 `D:\CodeBuddy-v1` 當前文件，原項目 revision 為 `964bbeb1587f1c5551ee17907e0b26632c4163ce`，含未提交文件的復制清單見 [source-baseline.json](source-baseline.json)。目標目錄未初始化 Git；本批沒有分支、提交或推送。原 renderer 布局和交互保持，允許的 Electron 啟動、橋接、打包配置另列。最新頁面不等于全部接口已接通。

**I** 已實現；**P** 部分實現；**N** 待接。**A** 自動化隔離夾具；**R** 實際配置模型的 ACP 驗收；**U** 真實 Electron 用戶流程；**T** 實際內置 MCP 工具調用；**D** 此行完整桌面流程待驗。證據僅覆蓋實際場景，均未包含 macOS、發布安裝包或持續高負載。

**2026-10-14 後續權威修訂**：執行、排程與目標完成交由官方 Harness goal/todo/subagent 主導，CodeBuddy 保留展示、權限與設定適配。使用者已允許前端配合原生後端調整。新權威以[本次實施記錄](2026-10-14-harness-authority.zh-TW.md)為準；先前真實模型/桌面回執僅為歷史證據，不證明本次替換已通過相同產品驗收。

## 基礎任務與工具

| 功能 | 實現及事實 owner | 狀態 / 證據 | 邊界 |
|---|---|---|---|
| 默認工作區、項目選擇 | Electron 默認容器 + `workspaces.mjs` 目錄身份及租約 | I / A、U | Windows 為 `D:\CodeBuddy-Workspace`，每新任務獨立子目錄；顯式項目保留。其他平臺待實機 |
| 對話、流式輸出、取消、歷史加載 | `compat.mjs` → 官方 Harness Session Controller / AgentLoop / JSONL | I / A、U | 實際 Kimi 對話及 CodePro 小項目通過；其他服務逐項驗 |
| 目標、清單、暫停恢復、重啟續作 | 官方 goal/tool-goal/goal-round-driver + todo；`codepro.mjs` 僅投影 | I / A、D | 新官方 ACP 夾具跨模組、自動續輪、取消/重啟/同 run 續作通過；原檔案 mtime/內容保持，真實命令與獨立測試退出 0。新真實模型/桌面、長時間與大型倉庫待驗；todo 是當前輪快照，不虛構 DAG |
| 角色模型、多 Agent | 官方 subagent 排程，CodeBuddy 僅選角色模型 | I / A、D | 新 HTTP 夾具驗證原生跨角色總並行上限、雙 coder 寫入、reviewer 獨立模型及真實跨模組測試；沒有第二個 coder 排程門檻。雲端品質與完整桌面待驗 |
| 工具回執、崩潰恢復 | 原生結構化結果、Harness JSONL 與 transcript/UI 投影 | I / A | 真 exitCode；未知效果保留但允許先檢查，不自動重放舊呼叫。harness_turn/harness_goal 均不等於獨立測試通過 |
| 文件、搜索、PowerShell、后臺任務 | 官方 fs/shell/jobs，developer 開關參與工具限制 | I / A、R、U | 重啟不復活 OS 進程；目錄驗證不是系統沙箱 |
| MCP 配置、測試、調用、資源 | settings / session-extensions + 單連接 MCP SDK 橋 + 官方工具定義 | I / A、D | stdio、streamable-http；失敗可見；實際 stdio 關閉重連、活躍會話資源讀取、取消和權限隔離已驗 |
| 工具審批 | 宿主唯一審批入口；主子 Agent 同權限邊界 | I / A、D | chat 禁動作，auto/approve 生效；smart_approve 保留詢問，不宣稱獨立自動批準器 |
| 內置電腦控制、可視化 | 舊獨立 computercontroller / qwen_computer / autovisualiser MCP 適配 | I / A、T、D | 22 個工具發現；實際 5 次 list_apps/docx/cache/render_mermaid 調用通過。鼠標鍵盤操作、全工具及 macOS 待驗；二進制未重新構建證明源碼一致 |
| 技能、顯式技能調用、遠程下載 | 官方 filesystem skill provider + library / skill-download | I / A、D | 本地 CRUD/啟停/恢復；HTTPS SKILL.md、固定 commit GitHub tree 與 blob 校驗、預覽后完整發布；真實外網/桌面未驗 |
| 常用任務 / 配方 | library + recipe-execution，統一 Harness 會話 | P / A、R、U；高级 D | 參數表單、模板、模型溫度、max_turns 與擴充已接；HTTP envs 實際解析 URL/header 並保護憑據；retry/sub_recipes/response.json_schema 在儲存/執行前明確拒絕，舊資料保持可讀 |
| 自動任務 | `schedules.mjs`，官方 cron/時區 | I / A、D | 默認暫停、成功立即運行才允許啟用；失敗和重啟暫停，不補跑；非零秒/七字段 cron 待接 |
| 圖片與文件附件 | 官方 image admission / upload receipt | I / A、D | 圖片依賴模型真實能力；文件回執按會話單次消費；獨立 visionRoute 已接只讀輔助視覺，11 項自動驗證；真實上傳/視覺質量待驗 |

## 設置

| 頁面 | 已接行為 | 狀態 / 證據 | 邊界 |
|---|---|---|---|
| 通用、快捷鍵 | 原 Electron 外觀、語言、通知、輸入偏好和快捷鍵保存 | I / D | 系統沖突、所有開關、重啟及打包更新入口待逐項桌面驗 |
| 模型與運行環境 | 自定義 OpenAI 兼容/Ollama，發現驗證、保護憑據、默認模型、角色路由、模型能力配置 | P / A、U | reasoningEfforts/contextWindow/maxTokens/compat 映射生效；六種 effort 有 HTTP 驗證。未知能力不偽造；獨立 visionRoute 已有只讀輔助描述與取消/重啟驗證；OAuth 待接 |
| 行為與回答 | 模式、maxTurns、壓縮閾值、提示模板、全局及項目 AGENTS.md | I / A、D | 使用官方 instructions/compaction；模型能力須匹配設置 |
| 記憶 | 項目開關、審核、CRUD、過期、導出、工具調用、已批準記錄召回 | I / A、D | 復用 Harness storage-domain/storage-json，非上游專門 memory provider。個性化開關控制原主模型主動提議候選；關閉仍接受用戶明確 retain。候選須 UI 審核；無跨項目畫像；本地字詞檢索 |
| 工具與連接、賬號憑據 | MCP CRUD、保護存儲、API key 編輯/刪除；原外部 ACP 設置 | P / A、D | 外部 ACP 服務逐項驗；provider OAuth、GitHub 登錄待接 |
| 輸入 / 語音 | dictation 配置、憑據、取消及 OpenAI/Groq/ElevenLabs 轉寫請求 | P / A、D | 7 個真實 HTTP 夾具；真實麥克風、云端服務未驗；本地 ASR 及下載待接 |
| 安全與權限 | 顯式開啟的專用分類器實際消費，接在 always_allow 前 | I / A、D | 7 項分類測試及審批集成；未配置、錯誤、覆蓋不足明確本次詢問。只按開啟配置發送所需上下文，無關鍵詞替代分類、無未檢測即安全 |

## 歷史與保留入口

| 功能 | 狀態 / 實現 | 證據及剩余范圍 |
|---|---|---|
| 搜索、重命名、歸檔、刪除 | I / compat + 原 ACP 適配 | 真實 Electron 搜尋/改名/歸檔/重載/恢復、刪除取消保留與確認刪除通過，持久化一致；漏傳 includeArchived 導致清單為空已修。32項組件/ACP回歸與 TS/lint 通過；批量仍待驗 |
| JSON 導出/文件導入 | I / history + 唯讀投影 | 真實 Electron 匯出、Kimi 操作Windows保存/開啟對話框、獨立核對4條消息與隨機標記、匯入重載通過；唯讀事實漏投影已修，輸入/編輯/重試/工作區入口關閉，無舊執行或憑據繼承 |
| 工作區檔案、終端、內置瀏覽器 | I / 原 Electron 面板 | 36項自動基線；真實中文預覽/保存、外部衝突保留草稿及磁盤、重載確認；終端cwd/落盤、Ctrl+C及關閉確認；本機頁面鏈接/後退/前進及原生像素已驗。遠端網站、安裝包與macOS待驗 |
| 舊資料遷移 | I / legacy-migration | 實際落地 616 會話元數據及完整 SQLite 歸檔、1 暫停日程、3 條現存項目記憶寫入官方 storage；11 條來自已刪除目錄的記憶完整歸檔。真實 Electron 打開舊 51 消息歷史且 Kimi 配置不變；空歷史導入保護已修，最終重啟後 616 條全部保留，見 [實際介面回執](../../.preview-evidence/migrated-history-ui.json) |
| 項目源、Agent 模板 | I / workspaces、library | 文件 CRUD、導入導出、范圍驗證；無第二模型循環 |
| 普通聊天工作目錄切換 | I / 官方 fork + working-directory | 產品 ID 穩定、原日志保留、新 sandbox 根/MCP cwd/記憶 scope 同步，原 renderer/ACP 及重啟驗證；活動、只讀、CodePro 會話拒絕切換。實際 Electron 選擇器和 macOS 待驗 |
| Git 面板 | P / git-extension | 8 個唯讀、6 個本地寫工具；restore preview/confirm 復用既有介面，完整 diff 與索引綁定過期校驗。23/23 自動測試；真實 Electron 暫存、無 HEAD 取消暫存、過期拒絕及重新預覽還原通過，暫存與無關檔案保留。衝突繼續/中止、pull/push/preflight、外部 filter/簽名及 macOS 待接或待驗 |
| Review | I / codepro-review + 官方獨立 Harness session | snapshot/start/get/cancel；真實 Electron + Kimi 準確指出隔離樣本 a+b 改成 a-b 的位置與問題，檔案/索引不變；不代表所有審查品質。見 overnight-acceptance.zh-TW.md |
| GitHub issues/PR/CI/登錄 | N | 待接；未執行外部寫入 |
| MCP miniapps | I / mcp-apps、單連接橋、隔離代理 | 自動合同及真實Electron+Kimi：開啟、guest握手、按鈕呼叫/批准/拒絕、全螢幕/子母畫面保狀態、展開歷史恢復通過。直接UI呼叫歷史缺口已複用journal修復實測；多應用/外部網路/複雜交互另驗 |
| 編輯、重試、普通會話分叉 | I / conversation-editing + 官方 immutable fork | 原地編輯 A→B、真實模型回覆 B、重試及重載保存通過；產品 ID 穩定、原生 fork 留痕。舊 run/檔案副作用保留；普通分叉全部桌面路徑仍待驗 |
| Nostr 分享導入 | N | 顯式未接；CodePro 原 UI 禁 fork 保留 |
| 本地推理下載、內置廠商目錄 | N | 保留 secondary/legacy 入口，原第一方模型“開發中”；未作為已交付功能 |

## 既有預覽證據（2026-10-14，本次權威替換前）

- [先前預覽集中回歸](../../.preview-evidence/foundations-all-tests-final.log)：當時 runtime/tests、runtime/harness/test 及 scripts 測試完整序列執行，286/286，失敗/取消/跳過均為 0，退出碼 0。包含該次配方參數及會話生命週期修復；並非本次 Harness 權威替換後的全集。舊子集計數不再相加。

- [真實 Electron CodePro](../../.preview-evidence/real-codepro-ui.json)：Kimi-k3、默認目錄、原生文件/測試工具，獨立 3/3 測試退出 0；僅該小項目用戶流程。
- [真實模型多模塊 ACP](../../.preview-evidence/real-codepro-latest.json)：money/invoice、4 次文件寫入、原生測試退出 0，獨立 8/8；主 Agent 順序執行，約 108 秒，不等同長時間大項目或真實重啟驗收。
- [真實 Kimi 重啟續作](2026-10-14-real-codepro-resume.zh-TW.md)：首個模塊完成后 pause_run，關閉并新建服務器、重新 lease/load、resume_run 同 runId；233 秒內完成，獨立 15/15、原文件哈希/mtime 不變、原回執唯一，無 pending/uncertain effects。不是 Electron 重啟或強殺進程驗收。
- [實際 Electron 停止與重啟繼續](2026-10-14-electron-resume.zh-TW.md)：原界面可見控件、受控 HTTP 模型、同 run、真實工具、獨立 3/3，pageErrors/consoleErrors 為空，兩輪進程全部回收；與真實 Kimi ACP 驗收分開。
- [內置工具實際調用](../../.preview-evidence/builtin-execution-latest.json)：5 次真實調用通過；不等同物理桌面控制。
- [前端基礎測試](../../.preview-evidence/frontend-foundations-tests.log)：10 文件 / 80 測試通過。自動測試不替代各設置頁面的用戶操作。
- 自動化子集分別通過：MCP 橋/資源/應用/原 capabilities/內置發現 30；Git 只讀/本地寫/Review 19 及真實 ACP Git 寫入 1；普通聊天目錄/Harness/MCP 組合 14；技能下載與 library 19；library ACP 4；語音 7；visionRoute 11；legacy 10；會話編輯 6 與 ACP 1。子集可能重疊，禁止相加為獨立全套總數；集中運行以最終主任務日志為準。
- 其他既有通過記錄：Harness driver/capabilities、記憶 6、safety 7、journal 4（含真實 SIGKILL 與殘尾）、history 4、workspace/launcher 14、recipe 7、schedule 8、roles/CodePro 組合。設置 runtime 9 項包含生效參數與故障詢問；以各測試與專題記錄界定覆蓋。

用戶要求的全部前端功能仍為最終目標。剩余 Git 遠端/沖突操作、GitHub 賬號/PR/CI、Nostr、本地 ASR、復雜配方、OAuth，以及尚未執行的桌面完整流程、真實長時間項目、macOS 和安裝包驗收必須保留。真實舊 profile 已實際遷入；最終重啟已核實完整保留 616 條，歷史 dry-run 不作為該事實依據。

參考：[官方 Harness](https://github.com/deepseek-ai/deepseek-harness)（精確鎖定 0.2.1-alpha.2，MIT，developer preview）；[默認目錄](2026-10-14-default-workspace.zh-TW.md)；[配方與日程](2026-10-14-library-schedules.zh-TW.md)；[會話編輯](2026-10-14-conversation-editing.zh-TW.md)；[遠程技能](2026-10-14-skill-download.zh-TW.md)；[舊數據遷移](2026-10-14-legacy-migration.zh-TW.md)。
