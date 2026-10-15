# Git 面板本機寫入操作

日期：2026-10-14。工作目錄 `D:\CodeBuddy-v1`，來源為 `source-baseline.json` 的 revision `964bbeb1587f1c5551ee17907e0b26632c4163ce` 及原專案未提交檔案。目標目錄沒有 Git 中繼資料；本批沒有在開發目錄建立分支、提交或推送。所有測試倉庫、分支及提交均屬 OS 暫存目錄的獨立測試資料。

## 實作及合同

保留原 `ui/desktop/src/acp/git.ts` 和 `GitRepositoryPanel.tsx`。`runtime/git-extension.mjs` 使用已安裝 Git CLI 作為 Harness host tools。`gitTools()` 提供 7 個讀取工具及以下 5 個寫入工具；`createGitReader()` 維持僅 7 個讀取工具供 Review 使用。權限由既有宿主/Harness 流程決定。

| 原 UI 工具          | 輸入        | 原 UI 回執                                |
| ------------------- | ----------- | ----------------------------------------- |
| `git_stage`         | `{paths}`   | `{staged_paths}`                          |
| `git_unstage`       | `{paths}`   | `{unstaged_paths}`                        |
| `git_commit`        | `{message}` | `{commit,branch,subject,committed_paths}` |
| `git_branch_create` | `{name}`    | `{branch,created:true}`                   |
| `git_branch_switch` | `{name}`    | `{branch,created:false}`                  |

暫存只接受狀態中實際存在的明確檔案路徑；取消暫存使用 `git restore --staged`，需要已有 HEAD 並保留工作區內容。提交只使用暫存區，回執讀取 Git 產生的實際 commit。建立分支會立即切換；切換僅接受已有本機分支，保留 Git 對未提交內容的保護。讀寫共用 canonical repository 佇列；此佇列只協調本程序，外部 Git/編輯器仍可能修改倉庫，Git 原有鎖及拒絕結果繼續生效。

命令採用固定 argv、無 shell 的 `execFile`、literal pathspec 和 `--`。路徑依倉庫相對位置及真實狀態驗證，拒絕空清單、路徑穿越、中繼資料、目錄泛選及連結祖先。子程序只取得 Git 所需的目錄及系統環境；模型/MCP 金鑰與繼承的 Git 路由覆寫不會傳入，錯誤也不回顯可能含金鑰的原始命令輸出。

原 Rust `run_git_with_env` 已停用 hooks/fsmonitor，本實作延續該語義。讀取停用 external diff/textconv 及外部 clean/smudge/process。寫入若實際命中外部 filter（包括目標分支屬性），會明確要求使用該倉庫的專用 Git 流程；僅全域安裝 LFS 而專案沒有對應屬性仍可使用一般操作。`commit.gpgsign=true` 會明確回報簽章流程待接，不擅自建立未簽章提交。分支屬性使用 `git check-attr --source`，已驗 Windows Git `2.55.0.windows.2`；較舊 Git 與 macOS 尚待平台驗收。

## 驗證及剩餘範圍

`git-write.test.mjs` 使用真實暫存 Git 倉庫、原 renderer parser 及 SDK `zGooseToolCallResponse_unstable`，涵蓋五種回執、暫存隔離、unborn、髒分支切換拒絕、路徑邊界、hooks/filter/signing、佇列、取消及實際子程序環境。`git-write-acp.test.mjs` 使用真實 server/WebSocket 與官方 Harness，驗證裸工具名稱、SDK、7 個面板讀取免重複審批、5 個寫入遵守 `ask_before`，以及 `never_allow` 與關閉 Git 擴充套件的否決。GitHub CLI 使用空白隔離 profile；沒有存取使用者登入設定或遠端 Git 寫入。模型服務只用 loopback 測試資料驗證設定，工具階段沒有模型請求。

Node 24 `--test runtime/tests/git-write.test.mjs runtime/tests/git-extension.test.mjs runtime/tests/codepro-review.test.mjs runtime/tests/review-harness-integration.test.mjs`：19 項通過、退出碼 0；另執行 `--test runtime/tests/git-write-acp.test.mjs`：1 項通過、退出碼 0，包括關閉/重新啟用擴充套件後工具清單及權限保留。自動化及協定通過不代表真實 Electron 使用者流程或 macOS 已驗收。

本批尚未接入 `git_restore_preview/restore`、`git_conflict_abort_preview/abort/continue`、`git_pull`、`git_push_preview/push`。這些操作必須保留原快照綁定、失效及確認合同；沒有偽造 preflight 或用通用 shell 取代面板按鈕。GitHub issues/PR/CI/OAuth 另列。

## 參考

沿用系統已有 Git，沒有新增相依套件或移植 Git 實作。參考 [git-add](https://git-scm.com/docs/git-add)、[git-switch](https://git-scm.com/docs/git-switch)、[git-commit](https://git-scm.com/docs/git-commit)、[githooks](https://git-scm.com/docs/githooks) 官方行為及原 Rust/TypeScript 合同。
