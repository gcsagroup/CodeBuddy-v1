# 應用程式更新

[简体中文](updates.zh-CN.md) · [English](updates.en.md)

先手動安裝支援更新的版本（本批交付目標為 1.43.14；1.43.12 僅供內部升級測試）；1.43.9 停用了更新入口。在帳號設定連接自己的 GitHub 帳號，須有私有儲存庫 `erjinyi-bool/CodeBuddy-v1` 讀取權限。在一般設定選擇正式或預覽頻道，依序檢查、下載、重新啟動更新。正式頻道忽略 prerelease。先儲存檔案、完成工作並關閉終端；升級保留原安裝路徑、聊天、設定與工作區，不要先刪除資料目錄。

登入憑據僅在 Electron 主程序暫時使用，不放進安裝包、日誌、介面或更新清單，不使用 MCP Token。帳號切換後重新檢查。下載可重試，首版沒有斷點續傳或自動降級。

Windows 使用 Inno EXE；Mac 自動更新使用相同簽名身分的 `.app` ZIP，DMG 用於首次安裝。Apple Development 僅供本次內部驗證；正式站外發佈需要 Developer ID Application 與公證。Intel 需要單獨的 x64 包。

每次遞增 `ui/desktop/package.json` 的語義版本，標籤為 `codebuddy-<版本>` 或 `codebuddy-<版本>-<批次>`。用已有 Node 產生清單：

```text
node scripts/create-update-manifest.cjs 1.43.14 codebuddy-update.json win32:x64:CodeBuddy-1.43.14.exe darwin:arm64:CodeBuddy-1.43.14.zip
```

先建立草稿 Release，完整上傳平台包與清單，核對遠端大小和 SHA-256 再發佈。歷史 Release 沒有清單則略過；已發佈的包需要變更時使用新版本。內部測試用 prerelease，驗收後才進正式頻道。

Electron 管理驗證、下載與更新狀態；Harness 確認沒有進行中的請求或工作並持久化後才退出。Windows 助手等待原程序退出、呼叫 Inno 並核對版本；Mac 交給 Electron/Squirrel 校驗簽名和替換。安裝前再次校驗快取。Windows 失敗記錄位於 Electron 資料目錄的 `updates`，重新開啟會提示。沒有業務資料遷移回滾機制。

自動化測試不等於實際升級驗收；需比對舊版升級後的聊天、設定、加密憑據和真正執行的版本。

參考：[Electron](https://www.electronjs.org/docs/latest/tutorial/updates)、[Inno](https://jrsoftware.org/ishelp/topic_setupcmdline.htm)、[Apple ATS](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)。沿用現有元件，沒有新增更新框架。

Windows 更新助手先確認啟動與接手安裝，應用收到回執後才退出。早期內部預覽的助手啟動缺陷已導致該預覽撤回，須手動覆蓋安裝本版。驗收使用含助手修正的內部 1.43.12 升級到 1.43.13。Mac 自動升級驗收依使用者要求暫停，本批更新清單僅發佈 Windows x64。

使用前須安裝 GitHub CLI，並以有儲存庫讀取權限的個人帳號登入。Windows 更新助手使用系統 PowerShell 模組，避免繼承 PowerShell 7 模組路徑導致驗證失敗；應用退出前驗證安裝包，安裝前再次校驗。

從 1.43.14 起預設選擇測試版頻道，檢查更新包含預先發佈版本；仍可手動切換正式版。介面、主程序及未指定頻道的呼叫使用相同預設值。
