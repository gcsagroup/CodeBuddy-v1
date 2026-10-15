# 歷史記錄管理第一階段驗證

日期：2026-09-15。

## 範圍與設計

本階段加入 Active、Archived、All 三種歷史檢視，以工作目錄作為專案篩選值，並提供 Today、Last 7 days、Last 30 days 的活動時間篩選。單一會話可封存或還原；刪除仍沿用既有確認流程。

後端原本已提供 `_goose/unstable/session/archive`、`unarchive`，清單中也已回傳 `archivedAt`、`projectId` 與活動時間。本階段重用既有協定，不增加另一套封存狀態。歷史頁會載入所有分頁後在客戶端套用篩選，因此目前正確但不適合無限制的大型歷史庫；伺服器端篩選與交易式批次管理留待後續協定設計。

OpenAI 的公開行為將封存定義為隱藏而非刪除，封存不需要刪除確認，並提供獨立的封存管理與還原入口。本階段採用這個可恢復邊界；不採用「一鍵刪除全部」，因目前 CodeBuddy 沒有批次刪除的原子 ACP 契約。[OpenAI：刪除與封存聊天](https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt) [OpenAI：Codex 聊天封存與刪除](https://help.openai.com/en/articles/20001333-how-to-archive-and-delete-chats-in-codex)

## 自動化證據

- RED：`SessionListView.management.test.tsx` 初次執行 3 失敗，缺少檢視、篩選與封存操作。
- GREEN：新測試 3 通過；連同分頁、搜尋、複製能力及 ACP session 測試共 31 通過、0 失敗。
- `prettier --write`、`tsc --noEmit`、精確 ESLint 均 exit 0。
- 證據：`.cargo/evidence/audit-fixes-20260914/history-management-red.log`、`history-management-green.log`、`history-management-focused.log`、`history-management-ui-gates.json`。

## 尚未完成

- 15 個語系目錄尚未重新產生；需等待共享 i18n 寫入工作結束後統一執行。
- 真實 Electron 視窗中的封存、還原、篩選與刷新持久化尚未驗收；本執行緒目前沒有原生應用控制 API。
- 批次管理尚未實作。批次刪除必須先定義原子性、部分失敗與確認邊界，不能用前端 `Promise.all` 冒充交易。
