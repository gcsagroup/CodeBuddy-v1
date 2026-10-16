# Rust 獨立工具與 Harness 上游複用調查

日期：2026-10-16。工作區 `D:\CodeBuddy-v1`，main / `01610d03764570282eee439cd2bfb49fcd373e98` 加既有修改。本輪只調查與記錄，沒有刪除工具、修改執行鏈、安裝依賴、提交或推送。

結論：有值得複用的上游能力，但尚未找到可整組、直接且無損取代現有 16 個 Rust MCP 工具的上游工具。優先接入 Office 技能及公網網頁讀取；其他功能繼續由 Harness 呼叫既有 MCP。不要為追求零 Rust 重寫文檔、圖表或天氣後端。

## 已核對的事實

- 本機鎖定 Harness `0.2.1-alpha.2`；官方樹版本 `86a402200d95fecef4529d969836f1fe13c6cb0d`，18673 項且未截斷。讀到的最新電腦控制插件 manifest 為 `0.2.1-alpha.4`，不可與已安裝版本混用。
- 透過目前 Harness 在隔離目錄連接三個真實 MCP 進程，列出 3 個時間天氣、5 個文檔網頁快取、8 個視覺化工具；腳本退出 0。沒有模型請求、桌面操作或使用者檔案變動。
- 基本檔案、搜尋、PowerShell、子 Agent、技能與工作管理已複用 Harness，不屬於這 16 個剩餘工具。

## 對照表

| 現有功能 | 上游候選與判斷 |
| --- | --- |
| `docx_tool` 讀取、追加、替換、樣式及圖片 | `dsh-skill-office` 的 Word/python-docx 流程可複用；是技能工作流，不是同名 API。必須驗證未修改內容與版式保留。 |
| `xlsx_tool` 七類工作表/區域/單元格/搜尋/保存操作 | Excel/openpyxl/pandas 技能可複用；須驗證多表、公式及樣式，不能用 DataFrame 匯出覆蓋原工作簿。 |
| `pdf_tool` 提取文字與內嵌圖片 | Office-to-PDF 是轉檔，文字/圖片讀取工具也不等價；保留。 |
| `web_scrape` text/json/binary 與資源快取 | 官方 `web_fetch` 可複用公網文字讀取；其 HTTP 提供者拒絕非公網和二進位，未覆蓋下載、內網與原快取合同。 |
| `cache` list/view/delete/clear | FS/MCP resources 可作基礎，舊快取與歷史資源仍需相容接縫，非直接替換。 |
| `time_now` 任意 IANA 時區即時查詢 | `dsh-time-context` 是步驟上下文，預設最短 10 分鐘間隔；不等同於結構化時間查詢。 |
| `location_resolve`、`weather_get` | 本次官方工具目錄未找到等價提供者；網頁搜尋不涵蓋預設城市、聯網開關、單位、日期、快取及限流合同。 |
| chord/donut/map/mermaid/radar/sankey/treemap/show_chart 八種圖表 | `present` 只交付檔案，不生成圖表或提供既有 MCP App 展示；保留，避免重寫模板庫。 |

本機依賴可見 Office/web/present 包，但目前 profile 未掛載，真實工具目錄也沒有它們。Office 需官方 Python 與函式庫載荷及 `load_workspace_dependencies`；不把 Codex 私有運行目錄當成產品依賴。新增載荷可能抵消移除 41.5 MB 工具程式的體積收益。

## 電腦控制與遷移邊界

現有電腦控制來自獨立 `qwen-computer-use.exe`，不屬於以上 16 項。上游 Cua Driver MCP/native 插件值得另行評估，但屬實驗性、需要對應驅動與權限；native 依賴 `@trycua/cua-driver@0.28.0`，不是零原生依賴。上游要求圖像能力，未直接提供本專案「主模型優先、輔助視覺降級」的完整合同；還須驗證焦點、輸入、取消、跨會話串行及 Windows/macOS 權限。

Rust crate 尚含未由工具入口接入的 MemoryServer 與平台自動化定義；實際目录沒有舊 computer_control、automation_script 或 Rust memory。刪除未接入原始碼是另項清理，本輪未執行。

建議先掛載已鎖版本的 Office 技能與公網 fetch，延續按需發現；使用官方庫和載荷，CodeBuddy 只接路徑、設定與交付。逐一通過 DOCX、XLSX、網頁/下載/快取自動化與安裝版真實操作後，才停用對應工具。PDF、天氣、圖表仍需要既有服務，因此此時仍保留 codebuddy-tools。新依賴、版本升級、授權條款與平台打包須另行核對。

本輪是合同調查與工具目錄驗證，不是替代工具 E2E 通過；未產生新版安裝包，Harness14 未變。本機證據位於 `.preview-evidence/rust-tool-reuse-inventory.json`、`harness-tool-audit-upstream-tree.json` 與 `audit-upstream-*`，不提交。

[簡體完整版與官方原始碼連結](2026-10-16-rust-tool-reuse-audit.zh-CN.md) · [English](2026-10-16-rust-tool-reuse-audit.en.md)。上游依據：[Office](https://github.com/deepseek-ai/deepseek-harness/tree/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/skill/skill-office)、[Web](https://github.com/deepseek-ai/deepseek-harness/tree/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/web)、[Cua Driver](https://github.com/deepseek-ai/deepseek-harness/tree/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/experimental/computer-use-cua-driver-native)。
