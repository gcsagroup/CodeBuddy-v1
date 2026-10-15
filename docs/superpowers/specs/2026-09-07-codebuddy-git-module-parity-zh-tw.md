# CodeBuddy Git 模組對齊設計（繁體中文）

**狀態：** 分階段實作中
**日期：** 2026-09-07

[繁體中文（預設）](2026-09-07-codebuddy-git-module-parity-zh-tw.md) · [简体中文](2026-09-07-codebuddy-git-module-parity-zh-cn.md) · [English](2026-09-07-codebuddy-git-module-parity-en.md)

## 目標

用系統 Git、既有憑證管理器和 CodeBuddy 的 ACP 權限層快速補齊日常版本控制，不自行重寫 Git 傳輸、認證或物件資料庫。

## 與 Codex 公開行為的比較

依 OpenAI 公開文件，Codex 的 Code review 可檢視工作區、暫存區、提交與分支差異，並提供暫存、還原、提交和推送；本機任務也可使用 Git worktree 隔離。這些是可觀察的產品契約，不代表其私有實作。

- 採用：明確的差異範圍、分支操作、逐路徑暫存/取消暫存、推送前預覽，以及 worktree 隔離方向。
- 保留 CodeBuddy 設計：Rust 主機執行無 shell 的 Git 參數向量；ACP 登錄表決定唯讀、工作區寫入、外部寫入和高風險權限。
- 拒絕：猜測遠端分支、靜默 stash/reset、跳過預覽的破壞性還原，以及在游離 HEAD 上提交或拉取。

參考：

- <https://learn.chatgpt.com/docs/code-review>
- <https://learn.chatgpt.com/docs/environments/git-worktrees>
- <https://git-scm.com/docs/git-restore>
- <https://git-scm.com/docs/git-merge>
- <https://git-scm.com/docs/git-rebase>
- <https://git-scm.com/docs/git-cherry-pick>
- <https://git-scm.com/docs/git-revert>

## 第一批垂直切片

- `git_branch_create`：從目前 `HEAD` 建立並切換至經 Git 驗證的本機分支，可修復游離 HEAD。
- `git_branch_switch`：只切換至已存在且精確匹配的本機分支，不自動猜測遠端。
- `git_unstage`：只取消暫存使用者明確指定的相對路徑，不改變工作區內容。
- 桌面 Git 面板提供分支選擇、新分支輸入和逐檔取消暫存；所有操作完成後重新讀取儲存庫狀態。

## 第二批垂直切片

- `git_restore_preview`：只接受明確的儲存庫相對路徑，拒絕未追蹤或衝突路徑，並在介面截斷顯示前，以 SHA-256 將規範化工作區與完整二進位差異綁定為預檢憑據。
- `git_restore`：執行 `git restore --worktree -- <paths>` 前立即重新計算該憑據；過期預覽無法捨棄後續編輯，暫存區內容亦維持不變。
- 桌面 Git 面板顯示精確路徑與差異，明確警告破壞性後果，並同時要求面板內確認及 ACP 高風險權限核准。

## 第三批垂直切片

- `git_repository_snapshot`：以單一唯讀 ACP 呼叫並行讀取狀態、衝突、分支、工作區差異及暫存區差異，避免同一工作階段被五次工具初始化與生命週期鎖序列化。
- `git_conflicts`：顯示 merge、rebase、cherry-pick 或 revert 的進行中狀態及未解決路徑；本階段僅開放 merge 寫入流程。
- `git_conflict_continue`：只在 merge 已無未解決衝突時執行無互動的 `git merge --continue`；衝突解決檔案仍須由使用者明確暫存。
- `git_conflict_abort_preview` 與 `git_conflict_abort`：先顯示受影響路徑及完整工作區/暫存區差異，再將工作區、HEAD、merge 標記、狀態及完整差異綁定為 SHA-256 憑據；狀態一有變動，舊預覽立即失效。
- 桌面 Git 面板在衝突期間停用分支、同步、一般提交和一般還原，但保留暫存/取消暫存以完成解衝突；中止 merge 需要面板二次確認及 ACP 高風險權限核准。

## 第四批垂直切片

- `git_conflict_continue` 現在接受與目前狀態完全一致的 merge、rebase、cherry-pick 或 revert；僅在所有未合併項目都已解決並暫存後，呼叫 Git 原生的無互動 `--continue`。
- `git_conflict_abort_preview` 將完整工作區/暫存區證據與操作專屬 Git 狀態（`MERGE_HEAD`、rebase 狀態目錄、`CHERRY_PICK_HEAD`、`REVERT_HEAD` 及 sequencer 資料）共同納入雜湊。即使工作區未改變，只要 rebase 計畫等操作狀態改變，舊憑據也會失效。
- `git_conflict_abort` 重新計算憑據後才呼叫相符的原生 `--abort`，並保留無關的未追蹤檔案。桌面面板開放相同四種操作，並顯示對應確認文字；未知衝突狀態仍維持唯讀。
- continue 與 abort 仍是受保護的 ACP 寫入操作；abort 依然同時要求面板確認及主機高風險權限核准。

## 第五批垂直切片

- `CodeProRunState.workspace` 現在持久化帶 schema 版本的工作區權限描述，明確記錄模式、生命週期、來源路徑、執行路徑、修訂號、可選 Git 身分，以及強型別 apply/discard 復原日誌。
- 歷史 JSON 缺少描述欄位時，只保守遷移為不含 Git metadata 的 `direct_legacy`。模式與 metadata 不相符、空路徑、零修訂號、無效雜湊及狀態路徑不一致都會驗證失敗。
- 儲存執行狀態和 checkpoint 前會先正規化描述；投影只揭露有界的生命週期與身分欄位，不揭露復原日誌內容。
- 本切片尚未建立 worktree，也不改變執行路由。現有直接執行會繼續明確標示為 legacy，直到完成並驗證探索、建立、所有權驗證與重開。

## 第六批垂直切片

- `git_runtime_status` 現在會在桌面端載入儲存庫狀態前執行有時限、可取消的 `git --version` 偵測，並回傳可用狀態、經過驗證的版本資訊及對應平台的 `git-scm.com` 官方安裝頁面。
- 未偵測到 Git 時，儲存庫面板會在執行任何儲存庫命令前停止，詢問使用者是否下載 Git，並要求再次明確操作後才開啟經過驗證的官方下載頁面。安裝完成後需重新啟動 CodePro，讓新程序取得更新後的系統 PATH，並在啟動時再次偵測。
- 本切片不會靜默下載安裝套件、執行安裝程式或呼叫套件管理器；系統安裝仍由使用者控制。
- OpenAI 已發布的 Codex 文件沒有說明自動安裝 Git 的行為，只明確要求在使用者範圍內自主推進，並為破壞性或不可逆操作保留核准邊界。CodeBuddy 採用該確認邊界，不推測 Codex 私有安裝邏輯：https://developers.openai.com/api/docs/guides/latest-model

## 第七批垂直切片

- `github_runtime_status` 將 GitHub CLI 與 Git 分開偵測，然後執行官方的非互動式 `gh auth status --active --hostname github.com` 檢查；執行時間有上限，結果不輸出權杖。
- 儲存庫面板區分 GitHub CLI 未安裝、已安裝但未登入與已連線三種狀態。缺少 `gh` 不會阻斷一般 Git 的 fetch、pull、push 或 clone，只會把後續 PR、Issue 功能標記為尚未就緒。
- 前端橋接只接受固定的 `github.com` 主機、`https://cli.github.com/` 安裝網址與 `gh auth login --hostname github.com --web` 登入命令，拒絕後端替換命令或連結。
- 這與 Codex 的公開行為一致：其程式碼審查文件明確說明 PR 上下文需要 GitHub CLI 與 `gh auth login`；GitHub CLI 手冊將 `gh auth status` 定義為驗證狀態檢查。

參考：

- <https://learn.chatgpt.com/docs/code-review>
- <https://cli.github.com/manual/gh_auth_status>
- <https://cli.github.com/manual/gh_auth_login>

## 第八批垂直切片

- 現有 GitHub 交付鏈路已提供 Pull Request 狀態、必要檢查、有界的本機預檢，以及經明確確認的 Pull Request 建立。本批直接重用該鏈路，不再新增第二套 GitHub 後端。
- 儲存庫與 Pull Request 面板現在共用復原操作。缺少 `gh` 時，只有經過介面內確認才會開啟固定的官方下載頁；`gh` 未登入時，只複製固定登入指令，並要求使用者在終端完成授權後重新整理。
- CodeBuddy 不會靜默安裝 GitHub CLI、在背景啟動互動式驗證，也不會擷取憑據。剪貼簿或瀏覽器失敗會明確顯示，並可安全重試。
- Codex 的公開程式碼審查契約要求使用 GitHub CLI 與 `gh auth login` 取得 Pull Request 上下文。CodeBuddy 採用該公開前提，同時在安裝與憑據邊界保留使用者的明確控制。

## 第九批垂直切片

- 交付面板只為開啟狀態的 Pull Request 提供關閉操作，只為已關閉的 Pull Request 提供重新開啟操作；已合併的 Pull Request 維持唯讀。
- 最新預檢會將規範 GitHub 儲存庫、目前分支、Pull Request 編號、標題、URL、基礎分支、目前狀態及目標狀態綁定為 SHA-256 憑據。執行階段會在共用交付寫入鎖內重新檢查，並拒絕過期或遭替換的憑據。
- 後端只呼叫固定參數向量 `gh pr close <number>` 或 `gh pr reopen <number>`。關閉操作絕不傳入 `--delete-branch`；逾時、取消、輸出超限或非零結束都會回報為遠端結果不確定，要求檢查 GitHub 後再重試。
- 桌面端要求使用者主動開啟對話框、執行狀態預檢並進行第二次確認，才會寫入遠端。自動化測試及桌面驗收不會變更真實 Pull Request。
- 本實作採用 Codex 公開可觀察的模式，將 Pull Request 上下文保留於審查工作流程，並以 GitHub CLI 公開契約執行變更；不推測 Codex 私有實作。

參考：

- <https://learn.chatgpt.com/docs/code-review>
- <https://cli.github.com/manual/gh_pr_close>
- <https://cli.github.com/manual/gh_pr_reopen>

## 第十批垂直切片

- 開啟或已關閉的 Pull Request 可以編輯標題與正文；已合併的 Pull Request 繼續維持唯讀。
- 更新流程要求使用者開啟編輯對話框、修改內容、執行最新預檢並第二次確認。預檢把工作目錄、規範 GitHub 儲存庫、目前分支、Pull Request 編號、舊/新標題與正文、狀態、URL 和基礎分支綁定為 SHA-256 憑據。
- 執行階段在共用交付寫入鎖內重新讀取 Pull Request，並拒絕無效、無變更、遭替換或已過期的憑據。後端只呼叫固定參數向量 `gh pr edit <number> --title <title> --body-file -`，正文僅透過 stdin 傳遞，不經過 shell 或命令列參數。
- 逾時、取消、輸出超限或非零結束都會回報為遠端結果不確定，要求檢查 GitHub 後再重試。自動化測試不修改真實 Pull Request。
- 本實作沿用 Codex 公開可觀察到的 Pull Request 上下文與確認式工作流程，不推測 Codex 私有實作。

參考：

- <https://learn.chatgpt.com/zh-Hant/docs/code-review>
- <https://cli.github.com/manual/gh_pr_edit>

## 第十一批垂直切片

- Issue 面板透過固定且有界的 GitHub CLI 參數列出最多 20 筆開啟或已關閉的 Issue，並將每個回傳 URL 綁定到目前的規範 GitHub 儲存庫。
- 建立、編輯、關閉及重新開啟都要求最新 SHA-256 預檢與第二次確認。執行階段會在與 Pull Request 共用的遠端寫入鎖內重新讀取儲存庫及 Issue，拒絕無效、無變更、遭替換或過期的預檢。
- 標題只以固定參數傳給 `gh`，正文僅透過 `--body-file -` 的 stdin 傳遞。逾時、取消、輸出超限或非零結束一律視為遠端結果不確定，介面會停止後續寫入直到使用者在 GitHub 檢查結果。
- 這完成本版合併候選的 GitHub Issue 範圍。Codex 公開文件承諾審查、暫存、還原、提交、推送及 PR 上下文，沒有把 PR 留言、審查者管理或草稿切換列為核心 Git 工作流程；因此這三項保留為合併後增強，不作為本版門檻。

參考：

- <https://learn.chatgpt.com/zh-Hant/docs/code-review>
- <https://cli.github.com/manual/gh_issue_list>
- <https://cli.github.com/manual/gh_issue_create>
- <https://cli.github.com/manual/gh_issue_edit>
- <https://cli.github.com/manual/gh_issue_close>
- <https://cli.github.com/manual/gh_issue_reopen>

## 合併候選範圍

1. 一般 Git 傳輸繼續使用系統 Git；GitHub CLI 只負責驗證、Pull Request 與 Issue。
2. 所有 GitHub 寫入都需要最新預檢、明確確認及不確定結果的失敗關閉處理。
3. Pull Request 留言、審查請求與草稿狀態切換列入合併後增強，不阻擋本版候選。
