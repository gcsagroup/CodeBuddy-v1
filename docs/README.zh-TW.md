# CodeBuddy 文件索引

[简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md)

目前執行核心為 DeepSeek Harness，桌面為 Electron/TypeScript，Rust 僅用於獨立 MCP 工具。版本以桌面 package.json 為準；測試結論必須對應具體原始碼與產物。

## 開發入口

- [安裝、依賴、啟動、建構與測試](../documentation/codebuddy/GITHUB_OVERVIEW_ZH_TW.md)
- [模組職責與事實權威](../documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md)
- [Harness 適配說明](../runtime/harness/README.zh-TW.md)
- [腳本入口](../scripts/README.md)
- [第三方來源與授權](../documentation/codebuddy/THIRD_PARTY_NOTICE.md)

## 功能與平台

- [儲存目錄](storage-layout.zh-TW.md)
- [安裝預設模型](installation-model-defaults.zh-TW.md)
- [Windows 安裝介面](windows-installer-ui.zh-TW.md)
- [macOS 建構](macos.zh-TW.md)
- [macOS 安裝與解除安裝](macos-installation.zh-TW.md)
- [瀏覽器控制](browser-control.zh-TW.md)
- [電腦控制路由](computer-use-routing.zh-TW.md)
- [對話檔案](conversation-files.zh-TW.md)
- [桌面寵物](desktop-pets.zh-TW.md)
- [長期目標](long-term-goals.zh-TW.md)
- [圖片生成](image-generation.zh-TW.md)
- [影片生成](video-generation.zh-TW.md)

## 交接與歷史

- [2026-10-23 合併交接](reconstruction/2026-10-23-merge-handoff.zh-TW.md)
- [逐提交修改原因](reconstruction/2026-10-23-commit-rationale.zh-TW.md)
- [當批桌面交付紀錄](reconstruction/2026-10-23-desktop-delivery.zh-TW.md)

舊 Rust Agent 計畫、早期重構驗收紀錄及上游文件網站已從目前檔案樹移除。它們保留於 Git 歷史，不再作為現行實作說明。以 `git log --all -- <path>` 查找舊路徑，再以 `git show <commit>:<path>` 讀取內容。

本機未提交的設計草稿、驗收資料、依賴及建構產物不屬於此次清理範圍。歷史測試報告不代表目前版本已驗收。
