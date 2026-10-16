# CodeBuddy Harness 執行環境

遠端 MCP 透過官方 `agent-preset-registry` 的長期作用域和租約跨會話重用；設定一致時僅首次連線，設定變化隔離新修訂，既有會話保留原連線。最多保留 8 組可重用設定，仍被租用的舊修訂由 Harness 繼續保留。stdio 維持會話/工作目錄隔離。工具清單變化會同步繼承工具限制，執行仍逐會話審批；詳見[設計與真實視窗驗收](../../docs/reconstruction/2026-10-14-mcp-reuse.zh-TW.md)。

長目標由官方 `goal`、`goal-round-driver`、`tool-goal` 管理，包含目標 CAS、自動續輪、輪數上限及暫停。`prompt` 在原生目標 active + armed 時保持開啟，等待官方續輪結束；一般無目標對話正常結束。回傳的 `goal` 是官方 GoalView。Stop 取消本次執行並 disarm；重新啟動保持 disarmed，不自行重播工作。明確暫停目標的恢復使用結構化 `prompt(...,{resumeGoal:{goalId,revision}})`，先建立權限及事件承載再呼叫官方 resume。`getGoal` 唯讀；`controlGoal` 支援 pause，以及已有承載執行中的 resume；閒置時直接 resume 會被拒絕。

模型請求預設使用官方有界重試（5 次，500ms 起退避，間隔最多 10 秒），不再強制關閉重試。`llm/retry`、`goal/change`、`turn/start` 與 `todo/write` 透過 `harness_event` 保留原生身分；todo 清單僅屬於目前 turn。`model_diagnostic` 只記錄首片/結束耗時、HTTP 狀態、區塊數及白名單網路錯誤代碼，不記錄內容、憑證、請求標頭或 URL。觀測不修改 fetch、串流或重試結果。

Host 固定使用官方 `maxActiveSubagents: 3`、`maxDepth: 1`：每個主會話的原生子 Agent 樹最多同時執行 3 個子 Agent，子 Agent 不能再派發下一層。舊 `roleModels`、`maxParallelSubagents` 和 `maxParallelCoders` 不參與執行；舊角色路由不能覆蓋主會話目前所選模型。

官方 npm @deepseek-ai/dsh 及外掛精確鎖定 0.2.1-alpha.2；採 MIT，仍為 developer preview。profile 組合官方 boot、Session Controller、AgentLoop、JSONL、MCP、skills、subagent、jobs 與 compaction，沒有第二個模型循環。來源及完整性見 PROVENANCE.json；npm 與參考原始碼位元組等價未證實。[上游倉庫](https://github.com/deepseek-ai/deepseek-harness)。

使用 Node 24+。已核准依賴準備入口為 `npm ci --ignore-scripts --no-audit --no-fund`；本批沒有安裝、下載或升級依賴，沒有修改系統 PATH。

## 適配介面

`createHarnessDriver({dataDir,cwd,instructionsHome})` 必須指定隔離資料根。呼叫 `createSession({sessionId,cwd,provider,model,options})`、`prompt(sessionId,content,{onEvent,onPermission,signal})`，退出呼叫 `close()`。provider 支援 baseUrl（API 根）、apiKey、protocol、headers、compat、contextWindow、maxTokens、inputModalities、reasoningEfforts。模型及 MCP 憑據僅在驅動記憶體；磁碟 Host providers 為空，不發現舊版或環境密鑰。

`configureSession(sessionId,options)` 在空閒時生效；應用保存並在重啟後重新傳入。參數：

- systemPrompt、maxTokens、temperature、thinkingEffort 進入真實模型請求；思考檔位須 provider 宣告。
- maxTurns 限制本次 prompt 主／子 Agent 的官方步驟；到達後返回 max_turns，歷史保留，不標記業務完成。
- autoCompactThreshold（0 到 1）、autoCompact 使用官方 token-meter／compaction-basic；`compact(sessionId,{signal})` 手動壓縮，原事件證據保留。
- tools 為 `[{name,description,inputSchema,execute}]`。execute 接收 `(args,{sessionId,signal,callId})` 並返回 JSON 物件，仍經官方 registry、校驗和核准。
- mcpServers 使用官方 stdio／streamable-http 設定；工具名為 mcp__server__tool。獨立服務並行連線，保留各項 ready／error 狀態及設定順序；失敗連線釋放，其他能力仍可用，重配重試。`extensionStatus(sessionId)` 返回狀態；`testExtension(server)` 臨時連線、發現、釋放，失敗直接報錯。官方連線及工具發現使用各請求逾時，預設 60 秒；版本協商可能有多個請求，因此該值並非全部服務的總啟動期限。
- toolFilter:{allow?,deny?} 只過濾繼承工具；同 scope 的 MCP／宿主工具須由統一核准入口執行精確 allowlist。
- 通用原生 `subagent` 接收 `{description,prompt,cwd?}`，預設繼承主 Agent 實際請求使用的 provider、model 和 reasoning effort；不註冊 `subagent_<role>` 或開放子模型選擇。建立、並行、深度和結果回傳由 Harness 管理，子 Agent 的讀寫和命令仍經原核准入口。

onEvent 支援 Promise 並依序等待；前工具回執處理後才進入下一核准或宿主 execute。事件帶 sessionId，子 Agent 內容需獨立投影。tool_result.structuredContent／error 為官方回執；shell 前台結果含 exitCode、aborted、timedOut，background 句柄不等於驗證完成。attemptId 與持久 messageId 不同。

每項工具要求 onPermission 明確返回 true，子 Agent 經官方即時歸屬繼承核准。檔案另受工作區策略限制；原生 shell 不宣稱核心沙箱。取消停止活躍子 Agent 與所屬 jobs，返回實際狀態；running／stopping 仍待確認。Jobs 為程序內任務，重啟後依持久會話核對、續作，不復活原 OS 程序。

另有 listTools、callTool（空閒維護視窗）、steer（活躍 inbox）、history、listSessions、rename、fork、follow、upload。

圖片直接作為 prompt part `{type:'image',mediaType,data:<base64>,name?}` 傳入，模型 inputModalities 須宣告 image；官方 admission 驗證、正規化並持久化參照。一般檔案先 `upload(sessionId,{data:<base64>,name})`，再將 `{type:'file',receiptId}` 放入同會話 prompt；回執使用一次，模型收到按需讀取的檔案控制代碼。

`../transcripts.mjs` 僅儲存 ACP 顯示投影，不接管 Harness 執行歷史。`openTranscriptJournal(store)` 在啟動恢復未完成 NDJSON；`begin({sessionId,turnId,users,title?})` 回傳 append、appendUsage、finalize。各追加等待 fsync 後才回傳；finalize 在 store 原子更新中合入片段與回放高水位，再清理 journal。應在 UI 通知前 await 追加；恢復既有片段不新增完成結論。

## 技能與記憶

AGENTS.md 讀取使用官方 agent-instructions 外掛。`instructionsHome` 指定本版全域目錄，預設隔離資料根；產品傳入 CODEBUDDY_HOME。專案及巢狀目錄遵循官方發現規則。固定版本在 apply 時同步讀取環境路徑，包裝器只在同步初始化期間設定並立即還原 Process 變數，不觸碰 User/Machine 環境。

官方 spawn 建立平級 scope，宿主透過已驗證 parent ownership，在 child 的 agent/created 階段明確重建工具、MCP、系統指令和壓縮設定；執行及核准仍使用真實 child sessionId，模型與思考檔位由原生委派繼承，不注入角色 override。

官方技能根為專案 .dsh/skills／.agents/skills，以及資料根 skills／agents/skills；提供 listSkills、refreshSkills 與官方 /skill-name 顯式注入。

固定版本沒有獨立內建 memory provider。第三方記憶走官方 MCP；CodeBuddy 本地記錄復用 storage-domain／storage-json 的 codebuddy_memory。memory.get(scope,key)／list(scope) 同步讀取，set(scope,key,JSONvalue)／delete(scope,key) 非同步持久化。應用擁有記錄 schema、專案 scope、候選啟用與檢索語意，不增設第二個記憶模型或資料庫。

## 驗證邊界

`node --test test/driver.test.mjs test/capabilities.test.mjs`：Windows 28/28、退出碼 0。真實官方 Harness、原生 PowerShell、隔離暫存目錄與本機受控模型／MCP 服務，涵蓋參數實際請求、非同步回執、MCP 隔離與離線降級、技能、子 Agent 路由／核准／取消、背景任務、步驟上限、壓縮、影像重啟復用、檔案回執隔離、記憶重啟與憑據不落盤。`node --test tests/transcripts.test.mjs`（runtime 目錄）4/4，含跨程序強制終止、截斷尾列與提交後清理失敗恢復。這不代表真實模型大專案品質、全部 UI、桌面 E2E、macOS 或舊資料遷移驗收。
