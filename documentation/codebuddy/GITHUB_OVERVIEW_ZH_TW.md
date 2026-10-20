# CodeBuddy

[简体中文](../../README.md) · 繁體中文 · [English](GITHUB_OVERVIEW_EN.md)

CodeBuddy 是桌面 AI 開發助手，整合專案分析、程式修改、命令執行、Git 審查、記憶、技能與 MCP 工具。目前候選版本為 `1.43.5`；驗收結果以對應交付紀錄為準，建構成功不代表所有功能均已完成實際驗收。

## 原始碼啟動

準備 Git、Node.js 24.x、`ui/package.json` 指定的 pnpm 與既有專案依賴。建構獨立原生工具還需要 `rust-toolchain.toml` 指定的 Rust、Visual Studio C++ Build Tools、Windows SDK 與 LLVM/Clang。

在倉庫根目錄執行：

```powershell
.\start-preview.ps1
```

啟動器使用既有依賴，啟動執行服務與 Electron。開發版與安裝版預設資料根統一為 `~/.CodeBuddy`，啟動日誌位於其中的 `logs/preview`，預設工作區位於 `workspaces`。模型在設定中配置；既有專案保留原位置。覆寫與遷移方式見[儲存目錄說明](../../docs/storage-layout.zh-TW.md)。

## Windows 安裝包

```powershell
node scripts/build-harness-windows.cjs
```

安裝程式為 `ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Setup.exe`，應用名稱為 CodeBuddy。安裝識別 `CodeBuddyHarness` 保留安裝相容性；預設資料目錄為 `~/.CodeBuddy`。啟動不會自動匯入或覆寫舊資料目錄。

首次封裝前依 [Office 建構器說明](../../scripts/office-builder/README.md) 準備 `runtime/py` 與 `runtime/office`。準備步驟會下載依賴；正常封裝僅複製及驗證已有檔案。包內包含 Node 與所需執行載荷；專案開發工具鏈仍依專案需求準備。

獨立 MCP 工具依 `runtime/tools/provenance.json` 準備至 `runtime/tools/bin`。離線建構命令：

```powershell
cargo build --offline -p goose-mcp --features rustls-tls --bin codebuddy-tools --jobs 1
```

替換工具產物時，同步核對來源紀錄及 `runtime/builtin-extensions.mjs` 的大小與 SHA256。執行依賴鎖定於 `runtime/harness/package-lock.json`。

`node scripts/build-harness-windows.cjs <stage-directory> --make-only` 僅用於同一批原始碼、完整應用與相符暫存目錄。NuGet 已完成而 Squirrel 封裝中斷時可用 `--finalize-only`，先驗證封裝身分。原始碼變更後須重新建構並使用新暫存目錄。

## 使用與驗證

1. 在設定中配置模型服務、憑據與模型。
2. 使用預設工作區或選擇專案建立任務。
3. 先唯讀分析專案，再說明修改目標與驗收條件。
4. 核對檔案差異、工具回執與測試退出碼；模型宣稱完成不等於獨立驗收通過。

技能與外部 MCP 保留各自的配置及權限。GitHub 帳戶登入與 GitHub MCP 啟用是不同狀態。憑據及本機聊天資料不要提交到 Git。

在 `ui/desktop` 執行 `corepack pnpm run typecheck`、`corepack pnpm run test:run` 與 `corepack pnpm run lint:check`。執行服務整合測試位於 `runtime/tests` 及 `runtime/harness/test`。

Windows 檢查不代表 macOS 或長時間生產專案驗收通過。完整證據與待驗項目見[交付及驗收紀錄](../../docs/reconstruction)；歷史版本名稱和結果維持原始紀錄。第三方授權、版權及來源紀錄保留，包括 `runtime/harness/PROVENANCE.json`。
