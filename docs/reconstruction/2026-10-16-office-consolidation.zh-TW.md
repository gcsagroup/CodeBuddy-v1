# Office 工具整併與合併交接

日期：2026-10-16。基線 `main` / `e9540aa8b35f5ed63a136455a52e72137fd73918`；工作區 `D:\CodeBuddy-v1`。交付原始碼與本機驗收，不產生安裝包。前批 [工具箱審計](2026-10-16-toolbox-audit.zh-TW.md) 是移除前的歷史快照。

## 變更

- 移除 Rust DOCX/XLSX 編輯實作、MCP 註冊、參數型別和兩份專用測試文件；移除 `docx-rs/umya-spreadsheet` 及鎖檔中不再需要的相依套件。
- Office 統一使用現有 Harness `dsh-skill-office`、包內依賴查詢與原生 shell。沒有另寫編輯服務或排程器。
- 工具箱將三項內建技能歸入「Office 文件」，各自詳情與搜尋保留；舊工具入口改名「PDF 與網頁檔案」。
- 保留 `computercontroller` 設定鍵和 `cache/pdf_tool/web_scrape`。不修改使用者狀態、權限或憑據，歷史回執與圖示保留。
- 新 Windows 工具可執行檔 21,777,920 位元組，原為 41,534,464；不代表整個專案或安裝包大小。

## 選擇依據與邊界

舊 DOCX 替換文字會丟圖片，已實證。刪除前先以現有上游載荷驗證圖片、表格、粗體、原件保留和 XLSX 七類操作。採用 [官方 Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件/技能機制，保持 `0.2.1-alpha.2` 鎖定版本與 MIT Office 插件及現有授權聲明；本批不升級上游。

保留網頁工具的原因是功能不完全等價：鎖定版上游 fetch 支援公網文字，拒絕私網及二進位內容；舊工具還保存網頁檔案。公網正文優先使用 Harness。外部 MCP 缺 Key/Token 不算廢棄功能；安全 MCP 依使用者要求不測試。

## 同事合併方式

合併本批提交，衝突優先核對 Rust 工具註冊、runtime 清單/指紋、工具箱及語系。不要恢復舊 DOCX/XLSX。舊 `computercontroller` 設定繼續連接剩餘三工具，重啟同一會話後可找到上游 Office 技能。歷史不改寫、不重播；直接硬編碼舊工具名稱的外部配方需改為使用上游技能與原生 shell。未提供同名舊編輯代理，也未擴大權限。

已有 `runtime/py/runtime/office` 載荷不需要新增依賴；新克隆依 `scripts/office-builder/README.md` 準備。工具二進位不提交，依 README 離線建置後複製到 `runtime/tools/bin`，以實際產物更新大小與 SHA256；不同建置環境可能產生不同位元組。回滾須一起恢復原始碼、鎖檔、產物及指紋，使用者文件和資料不回寫；回滾會帶回舊 DOCX 缺陷。

## 驗證

使用目前原始碼預覽入口 `scripts/start-harness-preview.cjs`、現有 Node 24.21.0、Kimi K3 及隔離設定/工作區。

| 驗證 | 結果 |
|---|---|
| `node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs` | 退出 0，407 通過 |
| 工具箱/擴充設定/ACP 工具箱 Vitest | 退出 0，14 檔案、128 通過 |
| `cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1` | 退出 0，69 通過、1 項既有網路測試忽略 |
| 對應離線 Clippy（all-targets / -D warnings）及 codebuddy-tools 建置 | 退出 0 |
| TypeScript / i18n 一致性 | 退出 0 |
| 保留能力實際呼叫 | 22 次通過：PDF、網頁三模式、快取、八圖表與資源 |
| 真實桌面 Office 兩輪與獨立檔案檢查 | 兩輪原生 completed；圖片位元組/表格/粗體/原件及公式/其他工作表獨立通過，只使用上游技能 |

證據留在本機 `.preview-evidence/h16-*`。初次設定夾具的擴充物件格式錯誤已修正；第一次連續對話有一輪在開發熱更新時段記錄使用者中斷，不列為完整通過。模型曾漏必需參數或寫錯斷言，保留實際重試記錄。macOS、安裝包、長時間任務、全部文件版式未重驗；Gemma 參數相容問題本批未宣稱修復。

最終 Office 會話 `914972d9-a0ac-46f1-9430-0750fab50550`：建立約 81 秒、編輯約 44 秒；一次缺 description 的參數被拒絕，模型補齊後成功。證據 h16-final-native.json、h16-final-independent.json。ESLint 退出 0；661 個原有會話保留，設定雜湊不變。

本批追加電腦控制實測：Harness + Kimi K3 在專用視窗完成輸入、快捷鍵、點擊切換、取消、拖動及捲動，退出 0。可見回執包含 KEY-739、12 次拖動移動及 scrollY=40；證據 h16-computer.log。全部語言鍵校驗及 i18n 編譯退出 0，其他語言原有英文工具說明同步更新。

## 同事接入步驟

1. 先保存同事工作區未提交修改，確認已包含上述 Harness 基線。若仍為舊 Rust Agent 專案，先整合 Harness 遷移基線，再套用本批，勿只複製工具箱檔案。
2. 同倉庫且沒有分叉提交時，執行 `git fetch origin`、`git merge --ff-only origin/main`。已有獨立開發提交時，在同事現有目標分支審閱後 cherry-pick 本批完整提交，勿強推或覆蓋未提交內容。
3. Rust 刪除、Cargo 鎖檔、執行時清單、Office 分組和測試須整體合入。重建工具及同步指紋，執行上述驗證，並用含圖片/表格的 Word、含公式/第二工作表的 Excel 做兩輪修改回讀。
4. 本機證據不進 Git，合併者在自己的環境重驗關鍵路徑。本輪沒有合併其他同事分支。
