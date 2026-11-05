# CodeBuddy Harness 執行環境

串流訊息以首個片段的觀察時間為建立時間，工具結果使用原生事件時間；匯出與重新載入保留該時間，不偽造舊對話缺失的時間。

`tool-error-contract.mjs` 對鎖定的原生工具錯誤序列化做記憶體適配，只補充有界、去重的傳輸錯誤碼（如 `ECONNREFUSED`、`CERT_HAS_EXPIRED`），不複製底層異常位址、堆疊或憑據，不改變重試與終態。遠端 MCP 未提供的原因仍未知。依據：[Node.js error.cause](https://nodejs.org/api/errors.html#errorcause)。

審批不可用與使用者拒絕分開回報：原生 `approval:never` 且宿主仍要求審批時，回傳 `APPROVAL_UNAVAILABLE`；子 Agent 應交回父 Agent 審批或執行，不擴大授權、不自動重放。

兩種匯出使用系統桌面作為儲存對話框預設目錄，僅確認後寫入。

鎖版預算相容修復由 `sdk-budget-contract.mjs` 校驗並於原生模組載入時套用，不改寫 `node_modules`。最終請求的同一投影用於估價與派發；輸出空間不足於 HTTP 前回報 `LOCAL_OUTPUT_BUDGET_EXHAUSTED`，異常短 length 回報 `OUTPUT_TRUNCATED`。本機預算／異常截斷恢復每個原生 turn 最多嘗試一次，且必須實際縮減並改善 fit 才重試；一般壓力壓縮仍依上游策略執行，網路 `always` 不能補充恢復次數。Completions 的合法 cap 1/128、一般 stop、原始 usage 與 Session v4 保持原語意。`index.mjs` 依序完成合同載入後才載入原 `driver.mjs` 實作；中繼資料與 schedule 入口亦先建立合同。版本或 SHA 改變會明確拒絕啟動，升級須複審並優先採等價上游合同，見 PROVENANCE.json。壓力顯示仍由原生 tokenMeter 負責，與 adapter 最終預算估計不同。

遠端 MCP 透過官方 `agent-preset-registry` 的長期作用域和租約跨會話重用；設定一致時僅首次連線，設定變化隔離新修訂，既有會話保留原連線。最多保留 8 組可重用設定，仍被租用的舊修訂由 Harness 繼續保留。stdio 維持會話/工作目錄隔離。工具清單變化會同步繼承工具限制，執行仍逐會話審批；詳見設計與真實視窗驗收（歷史文件，見 Git 歷史：`docs/reconstruction/2026-10-14-mcp-reuse.zh-TW.md`）。

長目標由官方 `goal`、`goal-round-driver`、`tool-goal` 管理，包含目標 CAS、自動續輪、輪數上限及暫停。`prompt` 在原生目標 active + armed 時保持開啟，等待官方續輪結束；一般無目標對話正常結束。回傳的 `goal` 是官方 GoalView。Stop 取消本次執行並 disarm；重新啟動保持 disarmed，不自行重播工作。明確暫停目標的恢復使用結構化 `prompt(...,{resumeGoal:{goalId,revision}})`，先建立權限及事件承載再呼叫官方 resume。`getGoal` 唯讀；`controlGoal` 支援 pause，以及已有承載執行中的 resume；閒置時直接 resume 會被拒絕。

模型請求預設使用官方有界重試（5 次，500ms 起退避，間隔最多 10 秒），不再強制關閉重試。`llm/retry`、`goal/change`、`turn/start` 與 `todo/write` 透過 `harness_event` 保留原生身分；todo 清單僅屬於目前 turn。`model_diagnostic` 只記錄首片/結束耗時、HTTP 狀態、區塊數及白名單網路錯誤代碼，不記錄內容、憑證、請求標頭或 URL。觀測不修改 fetch、串流或重試結果。

Host 固定使用官方 `maxActiveSubagents: 3`、`maxDepth: 1`：每個主會話的原生子 Agent 樹最多同時執行 3 個子 Agent，子 Agent 不能再派發下一層。舊 `roleModels`、`maxParallelSubagents` 和 `maxParallelCoders` 不參與執行；舊角色路由不能覆蓋主會話目前所選模型。

官方 npm @deepseek-ai/dsh 及外掛精確鎖定 0.2.1-alpha.2；採 MIT，仍為 developer preview。profile 組合官方 boot、Session Controller、AgentLoop、JSONL、MCP、skills、subagent、jobs 與 compaction，沒有第二個模型循環。來源及完整性見 PROVENANCE.json；npm 與參考原始碼位元組等價未證實。[上游倉庫](https://github.com/deepseek-ai/deepseek-harness)。

使用 Node 24+。已核准依賴準備入口為 `npm ci --ignore-scripts --no-audit --no-fund`；本批沒有安裝、下載或升級依賴，沒有修改系統 PATH。

length 恢復及依賴零輸出的溢位判定只使用服務明確回報的輸出計數（包含 0）。缺 usage 或缺輸出欄位時保持未知，保留原 `max-tokens` 終態，不從正文猜 token 數，也不將 SDK 預設 0 當成真實用量。

Responses 啟用輸出上限時最少需要 16 token（[官方約束](https://developers.openai.com/api/reference/ruby/resources/responses/methods/create)）。明確 cap 小於 16 會於 HTTP 前以 `INVALID_OUTPUT_BUDGET` 結束，不抬高上限、壓縮或重試；剩餘空間不足 16 則交原生有界預算恢復。Completions 的合法 cap 1 仍保留。明確關閉 `supportsMaxOutputTokens` 繼續表示不傳送服務端上限。

## 適配介面

摘要本身也使用 adapter 的實際 fit。完整請求經既有中介層和投影準備後，若放不下所請求的摘要輸出（預設 4,096 token），LLM 服務於 HTTP 前回報 `COMPACTION_OUTPUT_BUDGET_EXHAUSTED`。原生壓縮在同一交易內依工具配對邊界幾何縮短選區，同步重建輸入與 shadow 集合；未摘要的尾段仍為原 surface 事件。有限次本機準備只尋找一個可用區間，不保證最長或窮盡所有區間。最終候選重用已綁定的連線快照與設定，只發一次摘要 HTTP；實際 length 或取消不再觸發第二次摘要。找不到可用區間時不提交檢查點，保留原失敗。一般壓力路徑的單檢查點保護也涵蓋縮區後的實際摘要輸入。

原生工具圖片引用僅由附件儲存驗證讀取，再由適配層產生合法 ACP 顯示區塊。預覽讀取失敗只降級圖片顯示，工具的真實終態與原回執仍保留；舊紀錄只在回放投影修復，不重播工具或改寫歷史。選用圖片 I/O 完成後重新讀取目前歷史與即時高水位，再同步重設和回放。

`createHarnessDriver({dataDir,cwd,instructionsHome})` 必須指定隔離資料根。呼叫 `createSession({sessionId,cwd,provider,model,options})`、`prompt(sessionId,content,{onEvent,onPermission,signal})`，退出呼叫 `close()`。provider 支援 baseUrl（API 根）、apiKey、protocol、headers、compat、contextWindow、maxTokens、inputModalities、reasoningEfforts。模型及 MCP 憑據僅在驅動記憶體；磁碟 Host providers 為空，不發現舊版或環境密鑰。

`configureSession(sessionId,options)` 在空閒時生效；應用保存並在重啟後重新傳入。參數：

- systemPrompt、maxTokens、temperature、thinkingEffort 進入真實模型請求；思考檔位須 provider 宣告。
- 自訂連線依模型清單的 `owned_by` 選擇預覽介面：vLLM 使用 `/v1/chat/completions/render`，SGLang 使用 `/v1/tokenize`，保留 API 基礎路徑及連線驗證。預覽僅渲染實際聊天範本，不生成回答；僅顯示會改變範本的檔位，合併等效檔位並保留服務預設值。結果重用既有能力快取，重新整理模型清單後再次驗證。舊服務缺少預覽、呼叫失敗或參數被忽略時不推斷強度，模型詳情顯示「尚未確認可用檔位」；不依通用參數列舉或模型名稱判定支援情況。依據：[vLLM reasoning controls](https://docs.vllm.ai/en/stable/features/reasoning_outputs/)、[SGLang tokenization](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/serving_tokenize.py)。
- maxTurns 限制本次 prompt 主／子 Agent 的官方步驟；到達後返回 max_turns，歷史保留，不標記業務完成。
- autoCompactThreshold（0 到 1）、autoCompact 使用官方 token-meter／compaction-basic；`compact(sessionId,{signal})` 手動壓縮，原事件證據保留。
- 壓縮相容層為同一路由補齊目前對話的思考檔位，避免摘要請求切換聊天範本而失去前綴快取；明確指定的摘要檔位、獨立摘要模型或已變更的會話設定不覆蓋。摘要維持官方原有指令與所選區間的完整輸入，輸出預算從 1,024 提升至 4,096 token，容納思考和完整檢查點；並非要求輸出更多文字。鎖版選區修復保留最新 `source.kind=user` 的原始事件，後續產生的 runtime-context／skill-catalog 不會取代它。遵守原有 tail 預算，在使用者事件兩側選擇工具配對完整、估價較大的連續區間，優先非單檢查點區間；長任務仍能壓縮後續工具歷史，不複製或重排使用者輸入。只有舊檢查點可選時保留超限恢復和手動壓縮能力，一般壓力路徑仍略過它。後半區摘要可能無法重用完整前綴快取。截斷拒絕、取消及檢查點交易仍歸官方引擎；摘要本身不是任意任務無損的保證。升級 Harness 後複查此相容層。
- tools 為 `[{name,description,inputSchema,execute}]`。execute 接收 `(args,{sessionId,signal,callId})` 並返回 JSON 物件，仍經官方 registry、校驗和核准。
- mcpServers 使用官方 stdio／streamable-http 設定；工具名為 mcp__server__tool。獨立服務並行連線，保留各項 ready／error 狀態及設定順序；失敗連線釋放，其他能力仍可用，重配重試。`extensionStatus(sessionId)` 返回狀態；`testExtension(server)` 臨時連線、發現、釋放，失敗直接報錯。連線、工具發現、同步呼叫及每次 Tasks 請求預設 300 秒，明確設定的 `toolCallTimeoutMs` 優先。擴充設定 `timeout` 單位為秒，測試與正式工作階段共用轉換，儲存後透過既有重設機制套用。版本協商可能有多個請求，因此這不是全部服務的總啟動期限。
- 首次連線／重連以協議能力及工具定義探測非同步：2025 Tasks 同時要求服務端 `tasks.requests.tools.call` 及工具 `execution.taskSupport` 為 optional／required；2026 Tasks 使用 `io.modelcontextprotocol/tasks` 擴充，由服務端決定是否回傳任務。未宣告支援的工具走同步，不猜工具名稱、不執行探測業務動作。`mcp-tasks.mjs` 在適配層輪詢，將最終 MCP 回執交回 Harness，已受理的呼叫不重送；300 秒限制單次請求，非非同步任務總時長，使用者仍可取消。取消回執不證明遠端已停止。目前未支援 Tasks 內的互動輸入或程序重啟後自動恢復。SDK 2.2.0 尚無 Tasks 執行時，新版擴充使用鎖定版本的內部 codec 相容適配；升級時須重新驗證並優先移除此適配。設計參考：[MCP Tasks](https://tasks.extensions.modelcontextprotocol.io/)。
- toolFilter:{allow?,deny?} 只過濾繼承工具；同 scope 的 MCP／宿主工具須由統一核准入口執行精確 allowlist。
- 通用原生 `subagent` 接收 `{description,prompt,cwd?}`，預設繼承主 Agent 實際請求使用的 provider、model 和 reasoning effort；不註冊 `subagent_<role>` 或開放子模型選擇。建立、並行、深度和結果回傳由 Harness 管理，子 Agent 的讀寫和命令仍經原核准入口。

onEvent 支援 Promise 並依序等待；前工具回執處理後才進入下一核准或宿主 execute。事件帶 sessionId，子 Agent 內容需獨立投影。tool_result.structuredContent／error 為官方回執；shell 前台結果含 exitCode、aborted、timedOut，background 句柄不等於驗證完成。attemptId 與持久 messageId 不同。

每項工具要求 onPermission 明確返回 true，子 Agent 經官方即時歸屬繼承核准。檔案另受工作區策略限制；原生 shell 不宣稱核心沙箱。取消停止活躍子 Agent 與所屬 jobs，返回實際狀態；running／stopping 仍待確認。Jobs 為程序內任務，重啟後依持久會話核對、續作，不復活原 OS 程序。

另有 listTools、callTool（空閒維護視窗）、steer（活躍 inbox）、history、listSessions、rename、fork、follow、upload。

圖片直接作為 prompt part `{type:'image',mediaType,data:<base64>,name?}` 傳入，模型 inputModalities 須宣告 image；官方 admission 驗證、正規化並持久化參照。一般檔案先 `upload(sessionId,{data:<base64>,name})`，再將 `{type:'file',receiptId}` 放入同會話 prompt；回執使用一次，模型收到按需讀取的檔案控制代碼。

`../transcripts.mjs` 僅儲存 ACP 顯示投影，不接管 Harness 執行歷史。`openTranscriptJournal(store)` 在啟動恢復未完成 NDJSON；`begin({sessionId,turnId,users,title?})` 回傳 append、appendUsage、finalize。各追加等待 fsync 後才回傳；finalize 在 store 原子更新中合入片段與回放高水位，再清理 journal。應在 UI 通知前 await 追加；恢復既有片段不新增完成結論。

ACP `session/cancel` 是取消請求。適配層在首個非同步校驗前登記佔用；真實終態傳送給原請求及同會話觀察連線，收尾路徑退出時先刪除佔用，再同步傳送既有 `session_info_update` 的 `activeRunId: null`。終態、Host 釋放及原 prompt RPC 回傳各有明確時點，取消通知寫出不能替代它們。

## 技能與記憶

AGENTS.md 讀取使用官方 agent-instructions 外掛。`instructionsHome` 指定本版全域目錄，預設隔離資料根；產品傳入 CODEBUDDY_HOME。專案及巢狀目錄遵循官方發現規則。固定版本在 apply 時同步讀取環境路徑，包裝器只在同步初始化期間設定並立即還原 Process 變數，不觸碰 User/Machine 環境。

官方 spawn 建立平級 scope，宿主透過已驗證 parent ownership，在 child 的 agent/created 階段明確重建工具、MCP、系統指令和壓縮設定；執行及核准仍使用真實 child sessionId，模型與思考檔位由原生委派繼承，不注入角色 override。

官方技能根為專案 .dsh/skills／.agents/skills，以及資料根 skills／agents/skills；提供 listSkills、refreshSkills 與官方 /skill-name 顯式注入。

固定版本沒有獨立內建 memory provider。第三方記憶走官方 MCP；CodeBuddy 本地記錄復用 storage-domain／storage-json 的 codebuddy_memory。memory.get(scope,key)／list(scope) 同步讀取，set(scope,key,JSONvalue)／delete(scope,key) 非同步持久化。應用擁有記錄 schema、專案 scope、候選啟用與檢索語意，不增設第二個記憶模型或資料庫。

## 驗證邊界

2026-10-16 MCP 非同步／逾時批次：在 `D:\CodeBuddy-v1`、`main`、`01610d03764570282eee439cd2bfb49fcd373e98` 加既有及本批未提交修改上，使用已有 Node 24.21.0 執行以下命令，均退出 0。新增 21 項涵蓋兩代 Tasks 的 HTTP／stdio、核准、取消、失敗、輸出 schema、模型收到最終結果後繼續，以及同步呼叫實際等待約 65 秒成功；相關回歸 35、19、4 項通過。沒有安裝依賴、切換分支、提交或推送；未建置／安裝新版，未執行真實 HexStrike 或桌面 E2E，這僅證明原始碼及隔離整合鏈路。以下舊批次記錄另行保留。

```powershell
# D:\CodeBuddy-v1\runtime
node --test tests/mcp-task-execution.test.mjs
node --test tests/session-extensions.test.mjs tests/extension-resolution.test.mjs tests/harness-integration.test.mjs tests/mcp-apps-harness-integration.test.mjs
node --test tests/builtin-extensions.test.mjs
# D:\CodeBuddy-v1\runtime\harness
node --test test/mcp-apps.test.mjs test/mcp-metadata.test.mjs test/mcp-startup.test.mjs test/capabilities.test.mjs
```

`node --test test/driver.test.mjs test/capabilities.test.mjs`：Windows 28/28、退出碼 0。真實官方 Harness、原生 PowerShell、隔離暫存目錄與本機受控模型／MCP 服務，涵蓋參數實際請求、非同步回執、MCP 隔離與離線降級、技能、子 Agent 路由／核准／取消、背景任務、步驟上限、壓縮、影像重啟復用、檔案回執隔離、記憶重啟與憑據不落盤。`node --test tests/transcripts.test.mjs`（runtime 目錄）4/4，含跨程序強制終止、截斷尾列與提交後清理失敗恢復。這不代表真實模型大專案品質、全部 UI、桌面 E2E、macOS 或舊資料遷移驗收。
