# 參與 CodeBuddy 開發

[简体中文](../CONTRIBUTING.md) · [繁體中文](contributing.zh-TW.md) · [English](contributing.en.md)

更新：2026-11-20。

## 開始之前

閱讀 [README](../documentation/codebuddy/GITHUB_OVERVIEW_ZH_TW.md)、[AGENTS.md](../AGENTS.md) 和元件局部規則。Agent 執行引擎負責執行，Electron/TypeScript 提供桌面，Rust 僅提供獨立 MCP 工具；不要恢復舊 Rust Agent、Provider 或舊 API 產生客戶端。

在 [Issues](https://github.com/erjinyi-bool/CodeBuddy-v1/issues) 提供版本或 commit、系統、重現步驟、預期與實際行為及脫敏日誌；安全問題依[安全說明](security.zh-TW.md)聯絡維護者。

## 修改與驗證

- 使用匹配原始碼的鎖檔及 README 啟動入口。依賴準備、工具載荷與安裝包建構是不同步驟，舊產物不能驗證新原始碼。
- 保留既有未提交修改；提交聚焦，不包含會話、憑據、profile、快取、截圖或建構產物。
- 復用現有事實與協定；跨模組介面或權限語義調整先說明方案及遷移範圍。
- 後端增加有效回歸；介面先跑元件測試再驗證真實互動；跨模組功能在實際應用驗證關鍵流程。
- 文件修改只檢查內容、相對連結與格式，不需重建產品。Rust 修改依規則執行格式、相關測試及 Clippy。
- 使用者文件維持簡體、繁體及英文同步；介面文案遵循既有多語言擷取與校驗流程。

命令與環境見根目錄 [README](../README.md)。自動化使用隔離資料目錄，不接觸個人聊天或模型配置。

## 提交與審查

PR 說明問題、最終行為、範圍、實際命令與退出結果，分列自動測試、真實互動及未驗證項。截圖不等於功能驗收，建構成功不等於安裝包通過。合併前核對目標分支、依賴與來源授權。

保留 [Apache-2.0 授權](../LICENSE)、上游版權及[第三方聲明](../documentation/codebuddy/THIRD_PARTY_NOTICE.md)。導入第三方程式碼時記錄版本、來源和授權；不因文件更新修改原授權。
