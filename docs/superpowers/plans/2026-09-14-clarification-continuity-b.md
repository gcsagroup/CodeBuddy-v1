# 普通澄清對話的目標連續性：B 批次方案

## 目前狀態：v40，自動化通過，發布驗收未完成

2026-09-14 13:37：完整 ACP 測試 55 通過，控制指令整合測試 3 + 11 通過，核心完整函式庫測試 3286 通過、0 失敗、2 忽略，fmt 通過。純「继续」回歸涵蓋暫停/取消、相同執行識別碼與完整目標、預算保留、完成後不重播，以及跨工作區/跨工作階段拒絕。先前暫停來自測試夾具在服務啟動後另行寫入歷史執行，未初始化該服務的調度入口；改為正式啟動恢復與 LoadSession 後已通過，未放寬正式權限。

依主管最新安排，資源交還用於閘道模型連線修復。Clippy 自動接續後已中止，未計通過或失敗；本批後端建置、獨立真實桌面驗收、安裝包仍未完成。以上通過結果屬於閘道修復前的凍結原始碼，不能代替後續整合驗收。證據見 `.cargo/evidence/clarification-continuity-b-20260914/gates-v40-summary.json`、`source-v40.json`、`handoff-v40-paused-for-gateway.json`。原 B 完成現場未修改。

## v33 歷史狀態

2026-09-14：原始碼凍結，共享編譯與桌面窗口交還主管，優先進行 Git 合入驗收。v26 的相關定向測試、fmt、完整 all-targets clippy 與 CLI 建置均通過，精確命令及結果見證據目錄中的 `gates-v26-summary.json` 和 `control-integration-v26.json`。

原 B 工作階段 20260914_6 真實輸入「继续」後，原 Node 測試命令 exit 0，原 DAG 完成；原 Coder 輸出、契約、預算、三個專案檔案均未改變。真實關閉重開後僅有一份新的完成報告，未重複執行。但 ACP 錯誤註冊新的執行識別碼，控制目標僅為「继续」，舊澄清仍綁定原識別碼。因此本批尚未全部通過；原 B 完成現場已封存。

v29 的真實 ACP 請求回歸重現重複註冊（預期 1 個，實際 2 個）。v30 修復後，原執行識別碼、完整目標與註冊數量斷言通過；v33 整項測試仍 exit 101（0 通過、1 失敗），後續執行為 Paused，未滿足 Completed。唯讀稽核發現測試夾具缺少明確動態驗證描述及可發現的專案測試入口；這尚不能解釋全部暫停原因，需修正夾具並核對持久事件，不降低完成斷言或放寬正式權限。

主管歸還資源後繼續回歸、ACP/控制門檻、clippy、建置及獨立受控中斷任務的真實桌面驗收，包括完成後再次「继续」不重播動作。現有後端仍為 v26，尚不包含 v30 修復，安裝包未更新。本批不代表所有工具箱工具已逐項實測通過。

目前證據：`.cargo/evidence/clarification-continuity-b-20260914/source-v33-frozen-for-git.json`、`handoff-v33-paused-for-git.json`、`native-v8/b-v26-acceptance-incomplete.json`。A/C 原有證據保留。

## 歷史狀態與原方案（以下不是目前驗收結論）

日期：2026-09-14。目前仍在驗收，尚未完成。v19 的 DAG 80、修復 37、連續性 19 項測試全部通過（篩選有重疊，不相加）；fmt、完整 all-targets clippy 與 CLI 建置 exit 0。實際 qwen3.5:397b / v19 桌面驗收：A 工作階段 20260914_1 僅答「邮箱」後保留原目標並完成原始碼、測試修改，宿主真實測試 exit 0；介面報告重複顯示由獨立前端任務修復，不能據此宣告整體通過。B 工作階段 20260914_6 經真實關閉重開後，僅答「继续」仍追問原渠道，答「短信」後進入原目標；測試失敗修復已實際繼承原 src 與 test 授權並補齊原始碼，但複測遭自身保存的 Windows Node 絕對路徑拒絕，任務仍暫停。C 工作階段 20260914_13 將原修改目標替換為唯讀查看 package.json：舊澄清關聯 closed，新目標 read_only/finished，真實 read_document 1 次，測試執行 0 次，3 個基線檔案雜湊未變。C 後已關閉 Electron/backend 並釋放介面。命令恢復已取得有效 RED（0 通過、1 失敗，錯誤與現場一致），v21 最小修復及相關門檻進行中；保留原 B 工作階段待恢復驗收。證據目錄為 `.cargo/evidence/clarification-continuity-b-20260914/`；v9 完整函式庫 3274 通過、2 忽略以及 ACP/控制 123 通過僅屬較早原始碼門檻，不冒充 v21 全量驗收。以下方案與行號為歷史紀錄。

[简体中文](2026-09-14-clarification-continuity-b.zh-CN.md) · [English](2026-09-14-clarification-continuity-b.en.md)

## 目標與範圍

使用者提出目標，Agent 詢問關鍵選項，使用者簡短回答後，繼續完成原目標並採用新約束。例如「為目前登入加入驗證碼，先問我要哪種」→「簡訊還是電子郵件？」→「電子郵件」：執行器與 Planner 應收到原登入需求及電子郵件約束，不能把「電子郵件」當作獨立專案目標。

本批僅處理普通 `CodeProExecutionRoute::Clarify` 的連續性；不重做已驗收的 A 檢查點輸入、測試命令授權與 UI 回放。取消後舊執行狀態投影不同步留作緊隨批次。本批的 `cancel` 僅取消待澄清關聯，不能順便改寫既有執行取消協定。工具箱、串流展示與其他模組不在本批。

## 已核實的現況

以下行號為本次只讀快照，實作前重新核對。

| 位置 | 事實與影響 |
|---|---|
| `crates/goose/src/agents/agent.rs:8444` | Clarify 儲存助理問題文字後返回，沒有保存問題與源目標的結構化關聯。 |
| `crates/goose/src/agents/agent.rs:8668` | 意圖模型取得最近 6 條訊息、每條至多尾部 2000 字；提供歷史不等於持久保存待回答目標。 |
| `crates/goose/src/agents/agent.rs:8117` | 執行目標取目前使用者訊息；新 DAG 與執行狀態也使用此目標。 |
| `crates/goose/src/agents/agent.rs:2409` | 源訊息還原只處理 `ResumeAfterWorkspace`，不是普通澄清回答。 |
| `crates/goose/src/agents/agent.rs:13702` | 現有測試只證明意圖路由收到歷史，沒有斷言 Planner/DAG 取得完整目標。 |
| `crates/goose/src/agents/codepro_intent.rs:678` | 決策包含 intent、clarification、public_summary，沒有回答與問題的關係。 |

尚未執行本批 RED，以上為程式碼證據，不當作新實機重現結果。

## 最小實作方向

1. 保存有型別、帶版本的待澄清記錄，綁定 session、源使用者訊息 ID、助理問題訊息 ID、工作區及目前狀態。源目標從已驗證的真實使用者訊息讀取，保留其附件及可見性語義；模型不能用自述的「原目標」替代來源。
2. 在下一輪執行路由前讀取有效記錄，將輸入關係分為 `answer`、`new_task`、`cancel`、`clarify`。只有已核實的問題關聯與答覆才能形成內部執行上下文。仍有歧義時繼續詢問；新目標或取消使舊關聯失效，不自動夾帶舊工作。
3. 原始使用者目標及回答分別保存一次，不改寫聊天歷史。內部上下文由原目標、問題及原始回答組成，貫穿意圖、實際 Planner、DAG、控制面目標與報告；不要只修路由提示詞。
4. 先持久化問題/回答關聯與可恢復的消費狀態，再允許執行。保存失敗必須回報未執行並保留恢復線索；不能先跑工具再補寫。重送相同訊息 ID 不再次消費，同樣文字但不同訊息 ID 不以文字去重。消費已記錄但尚未啟動的中斷不能丟失原目標。
5. 優先重用既有會話儲存；若用 extension data，採嚴格型別解析及帶預期版本/問題 ID 的局部更新，避免覆蓋其他模組的 extension data。驗證源訊息角色、工作區、問題狀態及答案 ID；不建立通用新目標子系統。

預期落點：`agent.rs` 的 Clarify 與執行入口、`codepro_intent.rs` 的關係判定、必要的獨立澄清資料模組、`session/session_manager.rs` 的原子局部持久化，以及 `acp/server.rs` 的控制目標一致性。只有 RED 證明需要時才修改該位置；不預先擴充公開 SDK 協定。

## 先建立可重現失敗的測試

以下名稱為擬新增，不宣稱目前存在或通過。以 `clarification_continuity` 作為定向篩選前綴。

| 測試 | 輸入與必要斷言 |
|---|---|
| `clarification_continuity_answer_reaches_planner_and_dag` | 用受控 Provider 依序提供 Clarify 與 Change 決策，經正式回覆入口跑兩輪，攔截實際 Planner 請求並讀取真實臨時執行儲存。原目標、問題及「電子郵件」都須傳入，DAG 不能只以回答為目標；原始使用者訊息各一條。不能手動把合成目標送進 Planner 讓測試自行通過。 |
| `clarification_continuity_reload_preserves_pending_source` | 問題保存後重建 Agent/SessionManager，再回答；使用較長歷史驗證不依賴最近 6 條訊息。 |
| `clarification_continuity_new_task_and_cancel_do_not_resume` | 回答「算了，先只分析 README」與明確取消；不恢復原寫入目標，取消不執行工具。 |
| `clarification_continuity_rejects_stale_or_foreign_bindings` | 不同 session/工作區、已失效問題、非使用者源訊息、損壞資料；不能繼承或執行錯誤目標。 |
| `clarification_continuity_duplicate_and_commit_failure` | 同一答案 ID 重送、保存前/保存後啟動前故障；執行計數不增加兩次，保存失敗時為零，重載後仍能辨識待處理答案。 |
| `clarification_continuity_ambiguous_answer_stays_pending` | 僅「繼續」且關鍵選项尚未回答；不猜選項，不假報完成。 |
| ACP 路徑 | 在 `crates/goose/tests/acp_server_test.rs` 核對控制面 goal、使用者原文、Planner/DAG 的來源一致性及重載後不重送。 |

優先將測試放在 `crates/goose/tests/codepro_clarification_continuity.rs`；若正式入口的私有路由無法在整合測試攔截，可在 `agent.rs` 既有測試區加入最小 Provider 輔助，但不可為測試繞過真正入口。RED 的失敗必須由錯誤目標或缺失关联斷言造成；編譯失敗、環境阻塞、模型行動上限不算有效 RED。

## 門禁與真實驗收

取得資源後先核對 dirty diff 所有權、磁碟及活動建置；串行執行 Cargo。下列命令均規劃在 `D:\CodeBuddy` 執行，目前 NOT_RUN。

```powershell
cargo test -p goose --features code-mode --jobs 1 clarification_continuity -- --test-threads=1
cargo test -p goose --lib --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --test acp_server_test --features code-mode --jobs 1 -- --test-threads=1
cargo fmt --all --check
cargo clippy --all-targets --features code-mode --jobs 1 -- -D warnings
cargo build -p goose-cli --features code-mode --jobs 1
```

依最終修改範圍補齊相關整合測試與工作區建置門禁；若修改前端，再跑相關组件、型別、lint、完整前端與建置。若按功能規則更新 `goose-self-test.yaml`，需重建後執行 `goose run --recipe goose-self-test.yaml`，不得把未完成項標成通過。

真實 Electron 驗收使用隔離專案與真实模型：提出小型、本地可驗證的修改目標並要求先詢問一個關鍵選項；真實鍵盤簡答後，檢查實際修改、測試輸出、目標及報告。另一次在問題出現後正常關閉並重開，再回答；完成後刷新、重開歷史，確認無內容遺失及重複副作用。以磁碟產物與執行紀錄核對結果，不只看「完成」卡。真實模型未走到 Clarify 路徑時記為該路徑未覆蓋，不能以其他成功流程替代。

## 與公開 Codex 行為的對照

[官方 App Server 文件](https://learn.chatgpt.com/docs/app-server) 公開了 thread/resume、turn/interrupt 與 requestUserInput/resolved：會話可重開、停止輪次以 interrupted 結束、輸入請求以 ID 關聯解決狀態。採納分離會話/輪次/問題身份與保留歷史的原則；不推論 Codex 私有儲存，也不複製整套協定或新增全域 goal API。B 的具體型別與交易設計是本專案提案，不是 Codex 內部實作事實。

## 完成判定

RED 有效、最小修復及必要門禁通過、真實兩輪與重開流程通過、主管獨立複核後，才報 B 完成。報告列出來源版本、命令/cwd/退出碼、通過/失敗/略過、真實操作與產物位置。取消 raw state 投影修復仍另列後續，不混入本批完成聲明。
