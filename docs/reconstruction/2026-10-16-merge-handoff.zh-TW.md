# Harness 11–15 原始碼合併交接

2026-10-16。[简体中文（預設）](2026-10-16-merge-handoff.zh-CN.md) · [English](2026-10-16-merge-handoff.en.md)。

## 範圍與基線

倉庫 `https://github.com/erjinyi-bool/CodeBuddy-v1.git`，既有 `main`，父基線 `01610d03764570282eee439cd2bfb49fcd373e98`。包含先前未提交的 Harness 11–14 及本次 15。以 `git log --oneline -- docs/reconstruction/2026-10-16-merge-handoff.zh-TW.md` 查詢交付及後續交接修訂。

使用者已將交付改為本機驗證後提交、推送，停止產生新安裝包。交付原始碼、鎖檔、測試與文件；模型金鑰、會話、原始驗收資料、Python 載荷、相依套件、二進位與建置快取不納入。歷史報告的「未提交」表示當時狀態。

## 變更摘要

| 模組 | 變更與合併注意事項 |
| --- | --- |
| 核心 | 刪除 11 個舊 Rust crate 和專用 CLI、Provider、原生 SDK 入口；Cargo 僅保留 `goose-mcp`。Harness 負責執行、排程、完成、計量與壓縮，勿恢復舊 Agent fallback。 |
| 獨立工具 | `codebuddy-tools.rs` 保留電腦控制、PDF、圖表、快取、天氣等未有等價上游替代的工具；Office、公網擷取優先使用上游。產品並非完全沒有 Rust。 |
| 按需載入 | `tool-discovery.mjs` 延後注入原生/MCP 完整 schema，保留探索、權限與動態刷新；縮短 task/memory 重複提示。 |
| 模型容量 | 讀取模型中繼資料、提供商查詢與明確設定；移除前端暫時 128K 猜測，防止切換後舊回應覆蓋。區分未知與已確認容量，33K 不是通用上限。 |
| 上下文 | Harness 判定壓縮，適配層傳遞執行中用量與壓縮事件。沿用已記錄的單檢查點相容修補，沒有第二套摘要器。 |
| 啟動 | 容量查詢和連線預熱並行、重用 MCP scope；預熱不建立會話、不生成回答、不執行工具。減少重複解密及歷史序列化；桌面與 Forge 拒絕舊核心回退。 |
| MCP tasks | 官方 SDK 協商 tasks、輪詢與取消；預設逾時 300 秒。已接受呼叫不盲目重播，task handle 不當成完成。跨行程外部非同步任務恢復仍有限制。 |
| Office | 官方 `dsh-skill-office`、依賴查詢、Python 3.12.14 與 13 個鎖定函式庫；官方準備器原樣附於 `scripts/office-builder/upstream`，含鎖檔及授權。透過技能與 Harness shell 操作，不重寫 Office 引擎。 |
| 工具箱 | `library.mjs` 將官方最終技能定義投影至來源及技能管理清單，詳情可讀、內建唯讀；修正底層已載入但介面缺項，沒有重做版面。 |
| 網頁 | 官方 `web_fetch` 保留權限、公網地址與 URL 邊界；未設定搜尋服務時不提供 `web_search`。 |
| SDK/建置 | ACP schema 原樣移至 `ui/sdk/schema`；CI、Justfile、桌面啟動及架構文件同步移除舊核心入口，協定欄位不變。 |
| Windows 路徑 | 真實 Squirrel 安裝曾因 268 字元路徑失敗；載荷縮短至 `runtime/py`、`runtime/office`，新增預檢和回歸。取消安裝包後未重跑真實安裝。 |

階段記錄：[H11](2026-10-15-harness11.zh-TW.md)、[H12](2026-10-15-harness12.zh-TW.md)、[H13](2026-10-15-harness13.zh-TW.md)、[H14](2026-10-16-harness14.zh-TW.md)、[H15](2026-10-16-harness15.zh-TW.md)、[工具替代審計](2026-10-16-rust-tool-reuse-audit.zh-TW.md)。權威來源見 `documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md`。

## 同事合併步驟

1. 保存同事未提交工作，檢查與父基線分歧。本次沒有代同事合併分支。
2. `git fetch origin main`，檢查 `git diff --stat 01610d03764570282eee439cd2bfb49fcd373e98..origin/main` 及檔案差異。
3. 在同事選定的整合分支整批合入遷移，避免只挑 Office UI 或部分 Rust 刪除。
4. 重點處理 Cargo manifest/lock、Harness index/profile、library/server、桌面 main/Forge、ACP 事件與 SDK schema 衝突。保留獨立功能，但 Harness 仍是執行與上下文唯一權威。
5. 協定先修改權威 schema 再生成 SDK；保留歷史匯入映射與 `_goose/unstable` 相容名稱，不恢復已刪 Rust 生成入口。
6. 按 README、Harness 鎖檔、工具 provenance 準備本機依賴，合併後驗證自己的程式碼，舊二進位不能證明新分支正確。

## 準備和驗證

使用 Node 24、倉庫 pnpm 和 Rust toolchain；已有依賴不用重新安裝或清除快取。

```powershell
# 首次 Office 準備：獨立的聯網下載步驟
npm ci --prefix scripts/office-builder --ignore-scripts --no-audit --no-fund
node scripts/prepare-harness-office.mjs

# 根目錄
node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/*.test.cjs
cargo fmt --check
cargo test --offline -p goose-mcp --features rustls-tls --jobs 1
cargo clippy --offline -p goose-mcp --all-targets --features rustls-tls --jobs 1 -- -D warnings

# ui/desktop
node ../node_modules/typescript/bin/tsc --noEmit
node ../node_modules/vitest/vitest.mjs run --maxWorkers=1

# 回根目錄啟動原始碼；不產生安裝包
.\start-preview.ps1
```

Office 準備器保留既有載荷，不覆蓋。`runtime/py`、`runtime/office` 和原生工具被 Git 忽略；缺少 Office 載荷時相關測試會跳過，需一起檢查跳過數。[準備器來源與說明](../../scripts/office-builder/README.md)。

## 驗證結果與邊界

- 本次後端/Harness/建置腳本 422 項通過、0 跳過；Rust 85 通過、1 聯網測試忽略。格式、Clippy、TypeScript 退出 0。完整前端 262 個檔案、2320 項全部通過，退出 0。
- 本機應用 `1.43.3-harness15`，`ui/desktop/out/CodeBuddy Harness-win32-x64/CodeBuddy.exe`；runtime digest `826f35f499126abbe1f8fa4e84f94f8249e48dfab2c64b224955b31eeb31012f`，來源為本工作目錄改動。
- 真實 Kimi K3：會話約 691 ms 可見、首段回答 5514 ms，屬單次樣本。普通需求建立 DOCX/XLSX 與網頁擷取，再定點修改；64.5/50.9 秒，兩輪 completed、零工具錯誤，使用官方技能/依賴/shell/web，未呼叫舊 MCP 文件工具。
- 獨立回讀確認原檔、圖片位元組、粗體、公式文字與其他工作表保留；真實工具箱列出三個技能並開啟詳情。原有 661 會話及模型/偏好雜湊未變，使用隔離 profile 驗收。
- H14 既有證據：八模組專案與重啟後修正合計 21 次自動壓縮、70/73 專案測試、每輪 64 獨立檢查通過；即時用量、停止/繼續、倉庫唯讀分析通過。本次未在 H15 全部重跑。
- 原始證據位於本機 `.preview-evidence/h15-final-*`、`h15-local-final-*`、`h15-user-preservation-after.json`，不公開原始會話或模型設定。

尚未完成全平台/全部技能保證：macOS、每種電腦控制操作、數小時正式專案、PPTX 真實模型操作與 Office 視覺版式仍待專項驗收。Excel 只驗公式文字/格式，未刷新計算快取；LibreOffice 視覺渲染未驗。Rust 忽略項不算通過。

先前安裝失敗可能留下不完整的 `%LOCALAPPDATA%/CodeBuddyHarness` 應用目錄，使用者資料保留。請使用原始碼入口或上述本機程式，不把舊開始功能表捷徑當 H15 驗收入口；不要分發 rejected H15 安裝包。短路徑有自動回歸及本機應用驗證，取消封裝後未重跑安裝。

回滾以 Git 審閱/還原處理，不刪除使用者 profile 或工作區。需要恢復安裝時先核對本機狀態，再使用先前驗收的 H14 包。升級 Harness 時復核模型中繼資料、MCP Apps/tasks 及 compaction 相容修補。
