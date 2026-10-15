# CodeBuddy

## 目前 Harness 首版候選（D:\CodeBuddy-v1）

Git 保存原始碼、依賴鎖定檔案及授權文件；不包含本機模型憑據、聊天資料、原始驗收紀錄、`node_modules`、建構目錄與安裝包。`vendor/deepseek-harness` 僅是本機上游參考快取，執行依賴以 `runtime/harness/package-lock.json` 為準。首次複製後，除開發依賴外，須依 `runtime/tools/provenance.json` 將對應平台 MCP 工具準備至 `runtime/tools/bin`；啟動／封裝會驗證檔案，Git 不含預編譯工具。目前 Windows 安裝包已包含這些執行元件。

Windows 最終候選 `1.43.3-harness7` 已實裝，首次首頁顯示服務容量 65536（約 66k），修復舊 33k 預設值造成的輸出中斷。最終包真實 UI 完整流式對話首段 8.0／3.9 秒，會話約 1 秒出現；冷啟動樣本仍曾達 45 秒，延遲未全解決。本批中間候選另有六次壓縮、重啟事實延續與檔案工具證據。安裝包 `target/accepted-harness-installer-1.43.3-harness7/CodeBuddy-Harness-Setup.exe`；啟動「CodeBuddy Harness」，預設工作區 `~/CodeBuddy-Workspace`、資料 `~/.CodeBuddy-Harness`，保留目前設定。見[驗收紀錄](../../docs/reconstruction/2026-10-15-context-capacity.zh-TW.md)。macOS 與小時級生產專案仍待驗。

安裝包包含建構機既有的 Node 24 執行檔及授權文件，Harness 與原生任務子程序使用包內 Node。封裝前會實際執行 PowerShell 與檔案搜尋；專案開發所需的語言工具鏈仍依專案要求準備。

Windows 安裝包入口：使用既有 Node 24+ 執行 `node scripts/build-harness-windows.cjs`，沿用本機依賴與 Electron Forge/Squirrel，將 Harness、適配層及已驗 MCP 工具打包。安裝識別為 CodeBuddyHarness，資料位於 `~/.CodeBuddy-Harness`，首次啟動可設定模型，不自動匯入舊版。結果見[安裝驗收紀錄](../../docs/reconstruction/2026-10-15-harness-package.zh-TW.md)。已有同批應用產物時可用 `node scripts/build-harness-windows.cjs <stage-directory> --make-only` 接續安裝程式生成；不適用於跳過原始碼變更後的重建。

此目錄由 Harness 主導執行。Windows 使用既有啟動器：
NuGet 已完成而 Squirrel 封裝中斷時，可用 `node scripts/build-harness-windows.cjs <stage-directory> --finalize-only` 接續。先核對封裝內的應用與 Harness 指紋，並在獨立 `target/harness-winstaller-*` 暫存既有工具，補齊 7-Zip 檔名，不修改依賴目錄。

```powershell
Set-Location D:\CodeBuddy-v1
.\start-preview.ps1
```

啟動器選用已存在的 Node.js 24+，準備 SDK／語言資源，再啟動 Harness 橋接與 Electron，不自動安裝依賴。模型、歷史及設定保存在 `.preview-data`，日誌與啟動回執位於 `.preview-data/logs/preview`。新任務預設在 `D:\CodeBuddy-Workspace` 建立獨立工作目錄，亦可選擇現有專案。模型在設定中配置。

上述 start-preview 是原始碼開發入口，資料與安裝版分開。實際結果見[安裝紀錄](../../docs/reconstruction/2026-10-15-harness-package.zh-TW.md)、[夜間驗收紀錄](../../docs/reconstruction/overnight-acceptance.zh-TW.md)及[功能矩陣](../../docs/reconstruction/v1-functionality.zh-TW.md)。下方保留的原專案 `start-gui`／Rust 打包流程屬於舊後端入口，不用於啟動此目錄的 Harness 版本。

Windows 桌面 AI 開發助手，整合專案分析、程式修改、命令執行、Git 審查及可配置工具。目前是原始碼開發預覽，不代表每項流程均已通過實際驗收。

## 舊後端的原始碼啟動紀錄

準備 Git、Node.js 24.x（24.10 或相容版本）、Visual Studio 2022 C++ Build Tools、Windows SDK 與 LLVM/Clang。Rust 版本見 [rust-toolchain.toml](../../rust-toolchain.toml)，pnpm 版本見 [ui/package.json](../../ui/package.json)。

```powershell
git clone https://github.com/erjinyi-bool/CodeBuddy.git
Set-Location .\CodeBuddy
corepack pnpm --dir .\ui install --frozen-lockfile
Set-Location .\ui\desktop
node .\scripts\prepare-platform-binaries.js
corepack pnpm run start-gui
```

沒有 Corepack 時，先執行 `npm install --global corepack`。啟動流程準備後端、SDK 及語言資源，首次編譯需時間與充足磁碟空間。

## 第一次使用

1. 在設定中配置提供商、服務位址、API Key 與可用模型。
2. 在新任務選擇專案資料夾。
3. 先輸入「只讀取專案，說明入口與測試命令，不修改檔案」。
4. 再提出具體修改目標與測試要求。
5. 檢查工具回執、檔案差異與實際測試結果。

版本控制提供狀態、差異與審查。寫入或遠端操作前確認倉庫；外部 MCP 需配置與驗證連線。電腦控制需指定軟體及完成條件，不能以已啟用代替功能驗收。

啟動失敗先檢查編譯器與 Clang；模型錯誤先檢查連線與工具支援。回報恢復問題時保留會話，移除密鑰與個人資訊。

[完整簡體指南](../../README.md) · [貢獻指南](../../CONTRIBUTING.md) · [授權](../../LICENSE) · [第三方聲明](THIRD_PARTY_NOTICE.md)

上游 goose 部落格及活動素材不再隨儲存庫複製，相關文件連結指向上游網站；使用指南仍需要的配圖保留在 `documentation/static/img/upstream-blog/`。本機 `target/` 等建置快取不屬於原始碼，重新編譯時會產生。
