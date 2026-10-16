# GitHub 帳戶設定修復

日期：2026-10-16；`D:\CodeBuddy-v1`、`main`、基線 `04362df`。本批不產生安裝包。

舊帳戶卡片仍呼叫已移除的 Rust OAuth 方法，錯誤和現有 CLI 狀態同時顯示。現已刪除卡片內舊狀態機、無呼叫者的 ACP 包裝及專用文案，統一使用既有 GitHubConnections、Electron IPC 和官方 GitHub CLI；SDK 相容 schema 保留，不新增 OAuth 服務。

帳戶/MCP 每個檢查階段有 25 秒介面上限，遲到結果不覆蓋新結果，MCP 等待不阻擋帳戶登入。狀態消費 `gh auth status --json hosts` 的 active/state/login，移除重複的 `gh api user`；同時查詢共用執行，已完成結果不快取，登入/登出後重新驗證。此界面期限不影響 Harness 工具執行。

依據：[官方 CLI 說明](https://cli.github.com/manual/gh_auth_status)與本機 help。CLI 負責認證和憑據，GitHub MCP 仍單獨設定；不自動啟用 MCP 或複製憑據。

驗證：帳戶設定與 CLI 的 Vitest 35 項通過；最終失效處理後 CLI 12 項重驗通過。TypeScript、ESLint、i18n 檢查與編譯均退出 0。使用 README 原始碼入口重啟 Electron，實際進入帳戶設定並重新整理，結果另列。未退出使用者帳戶；新帳戶的完整瀏覽器授權未實測，設備碼流程只有自動化回歸。

合併時整體套用卡片、CLI 檢查、ACP 刪除及語言變更，重啟 Electron 載入主行程。原始證據留在 `.preview-evidence/h17-*`，不提交帳戶設定或截圖。

真實桌面：首次檢查 3,974 ms、手動重新整理 3,965 ms，帳戶連線成功、MCP 停用，舊錯誤消失。精簡重複查詢前一次為 16,249 ms；僅為當次觀測，非固定延遲保證。證據 h17-ui-receipt.json / h17-ui-final.png；目前原始碼啟動器 PID 50132。
