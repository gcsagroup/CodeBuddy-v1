# Harness Git 與程式碼審查適配

## 範圍

新版保留原前端，透過 ACP 和官方 deepseek-harness 接入 Git 讀取與獨立程式碼審查。Git CLI 負責儲存庫事實，`CodeProReviews` 負責審查狀態，Harness 負責模型執行。審查完成不代表開發任務完成或測試通過。

`runtime/git-extension.mjs` 提供執行環境、GitHub CLI 狀態、儲存庫快照、狀態、衝突、分支和差異七個唯讀工具。`git__` 工具名稱與原介面的裸名相容；回傳原 JSON 欄位和 text content。Git 註冊為預設啟用的 builtin，避免舊前端對 platform Git 的重複擴充清理規則。關閉擴充後不向該會話提供工具。

Git 讀取使用固定參數、porcelain NUL 協定、輸出上限和取消訊號。繼承的 Git 路由變數被清除；可選索引寫入、fsmonitor、外部 diff、textconv、延遲擷取和設定的 clean/smudge/process filter 被關閉。未知或失敗狀態保留錯誤，不偽裝為空儲存庫。

## 審查行為

原有 snapshot/start/get/cancel 四個 RPC 由 `runtime/codepro-review.mjs` 接收。工作區範圍比較索引與目前檔案並包含未追蹤檔案；暫存範圍比較 HEAD 與索引；分支範圍比較 merge-base 與 HEAD。連續兩次擷取得到相同 fingerprint 才接受快照，啟動前重新檢查內容和模型。

快照限制為每檔案 64 KiB、200 個檔案、總內容 256 KiB。敏感路徑、連結、非一般檔案、二進位、無效 UTF-8 和超額內容明確排除。差異使用既有 jsdiff 5.0.0，在可取消 Worker 中執行。模型接收固定快照，只能呼叫 `codebuddy_review_result`。宿主驗證問題定位確實落在快照的差異區段內；涵蓋不完整時，空問題清單不構成成功結果。

只有有效結構化提案加 Harness 正常結束才提交 completed。一般文字回覆不代表審查成功。取消等待實際執行退出，逾時記錄 failed，服務重啟遺留的 running 記錄轉換為 interrupted，並保留歷史。查詢重新計算 current/stale/unknown；讀取歷史不會自動重新執行模型。

## 驗證與剩餘邊界

在目前原始碼執行 Node 測試：`runtime/tests/git-extension.test.mjs`、`runtime/tests/codepro-review.test.mjs`、`runtime/tests/review-harness-integration.test.mjs`。涵蓋原 UI 解析器與 SDK Zod、真實臨時 Git 資料、索引不變、快照/位置/時效校驗、取消/重啟，以及 ACP → 官方 Harness → 本地 HTTP 模型 → 真實宿主回執。這些測試未使用使用者儲存庫或真實雲端模型。

Git 暫存、還原、提交、分支變更、拉取和推送等寫入操作仍需依原預覽協定接入；唯讀工具測試不代表這些操作已支援。真實 Electron 審查互動、真實模型品質和 macOS 產品驗收須分別確認。本記錄不是安裝套件或全功能發布驗收。

實作依據：[Git status](https://git-scm.com/docs/git-status)、[Git diff](https://git-scm.com/docs/git-diff)、[jsdiff](https://github.com/kpdecker/jsdiff)。既有 cyanheads Git MCP 適配器的 Windows runner 和輸出結構不同，未以其舊 Agent 執行鏈替代 Harness。
