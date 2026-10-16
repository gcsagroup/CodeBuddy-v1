# 工具箱驗收報告（2026-10-16）

> [後續：Office 整併實作與最新驗收](2026-10-16-office-consolidation.zh-TW.md)。
來源：`D:\CodeBuddy-v1`，`main`，revision `e9540aa8b35f5ed63a136455a52e72137fd73918`。真實桌面使用同批 H15 本機應用 `ui/desktop/out/CodeBuddy Harness-win32-x64/CodeBuddy.exe`，測試設定與工作區隔離。本次不是新安裝包驗收。

## 結果

25 個內建 MCP 工具均有實際呼叫：24 個通過代表性情境；舊 `docx_tool` 已重現圖片遺失，列為缺陷。工具數量不是全部參數組合的覆蓋率。完整工具名稱與狀態見 [脫敏 CSV](2026-10-16-toolbox-audit.csv)。

| 能力 | 驗證層級與結果 | 建議 |
|---|---|---|
| 原生檔案、搜尋、命令、圖片、網頁讀取 | 實際呼叫並核對夾具結果；包含 `read/write/edit/working_directory/glob/grep/read_image/pwsh/web_fetch` | 保留 |
| 按需發現、依賴與技能載入 | `search_mcp_tools/load_workspace_dependencies/skill` 實際呼叫 | 保留 Harness 機制 |
| 時間、地點、天氣（3） | 實際查詢；地點解析後使用明確座標取得目前天氣與兩日預報 | 通過；模糊地點要求補充資訊屬正常行為 |
| 電腦控制（9） | 真實模型完成進入、輸入、按鍵、開關、取消對話框、拖曳、捲動及儲存；涵蓋主視覺及輔助視覺降級 | 通過測試情境，但模型參數穩定性有保留意見 |
| 圖表（8） | 八項實際模型呼叫、資源讀取、桌面八個 guest frame 的 SVG/Canvas/文字及截圖 | 基礎渲染通過，未涵蓋全部互動和匯出 |
| 舊 DOCX | 替換文字回傳成功，圖片卻由 1 張變成 0 張 | **優先遷移至上游 Office，再淘汰舊實作** |
| 舊 XLSX | 七種操作類型及獨立檔案核對：修改值、公式與另一工作表保持正確 | 本例通過；完成相容遷移後可精簡 |
| PDF、網頁抓取、快取 | PDF 文字與內嵌圖片提取；本機 HTTP 的 text/json/binary；隔離快取 list/view/delete/clear | 基礎通過；未驗 OCR、複雜 PDF 或任意網站 |
| 上游 DOCX/XLSX | 本輪回歸通過；複用同 revision 前批真實模型的圖片/粗體、公式/其他工作表及原件保留證據 | 保留；區分新測與複用證據 |
| 上游 PPTX | Kimi 建立兩頁、修改第一頁，獨立讀取確認第二頁及原件不變 | 內容通過，未驗視覺排版；Gemma 同情境未完成 |
| 新增技能 | 建立、列表、執行 A、更新 B、停用/啟用、重啟後執行及對話事實保留 | 通過；首次模型從工作區讀取定義，不宣稱每次都已注入技能目錄 |
| Git、記憶、技能庫、目標及任務能力 | 六個相關測試檔合計 49 PASS、0 FAIL、0 SKIP | 自動化通過；未重新逐項做桌面 E2E |
| Exa | 兩個工具實際搜尋/抓取通過 | 保留 |
| Tavily | 搜尋、提取通過；crawl/map/research 缺 API Key | 後三項待設定，不是無用工具；現有停用狀態不變 |
| GitHub 官方 MCP | 缺 `CODEBUDDY_GITHUB_MCP_TOKEN` | 待設定，未操作倉庫 |
| 外部安全 MCP「1」 | 發現 150 工具，只做健康與快取狀態查詢；服務自報 124 依賴中 74 可用、50 缺失 | 使用者要求本輪暫不測；依賴數不是工具通過率 |
| 托管相容入口 | `tom/code_execution/summarize/todo/apps` | 名稱存在不代表重複引擎，未證實無用 |

## 問題與精簡判斷

舊 DOCX 的 `crates/goose-mcp/src/computercontroller/docx_tool.rs::do_replace` 新建文件，只重建文字段落後覆寫原檔，沒有保留圖片；其他非文字節點的風險來自靜態閱讀，本輪實證是圖片損失。建議遷移到既有 `office-docx`，完成歷史相容處理後刪除舊工具。不要整組刪除 `computercontroller`，以免連帶失去 PDF、快取和網頁抓取。使用者設定中該舊擴充已停用，本輪未更改。

Gemma 在 PPTX 測試反覆省略 `pwsh.description`，觸發 `INVALID_ARGS`，到達 20 輪測試上限仍未產出檔案；屬未完成驗收，不把行動上限當工具失效。Kimi 同任務通過。電腦拖曳首次模型送出字串座標，明確提示 JSON 數字後重測通過；保留第一次不穩定記錄，不把模型自述當橋接故障證據。

Tavily 三項雖然 `isError:false`，正文仍要求 Key，故列為待設定。可選擇精簡重複搜尋設定，但缺憑據或遠端依賴不構成刪除實作的依據。優先替換舊 DOCX；XLSX/抓取先做相容對照；保留其餘已驗能力。

## 證據與限制

本機證據根目錄 `.preview-evidence/`，不提交原始會話、憑據或 MCP URL：

- `toolbox-20261016/execution.json`：初次 52 呼叫，48 PASS / 4 FAIL；四項測試夾具缺少視覺能力或查詢 metadata，修正後在 `retest.json/followup.json` 複測。
- `toolbox-20261016/docx-image-regression.json`：圖片 1→0；`cache.json`：隔離快取生命週期。
- `real-computer-main-Insa79/receipt.json`：主視覺通過；`real-computer-auxiliary-Z87J3T/receipt.json`：輔助視覺 7 次觀察及可見結果通過。
- `real-skills-6sDNmz/receipt.json`：自訂技能生命週期；`toolbox-20261016/pptx-kimi/independent.json`：PPTX 產物獨立驗證。
- `toolbox-20261016/charts-ui.json/charts-frames.json/charts-ui.png`：27.3 秒完成八圖。後續額外補截圖腳本退出 1，當前頁面未找到目標 frame；補取證未完成，不覆蓋先前證據。
- `toolbox-20261016/external-calls.json/tavily-calls.json`：外部工具實際回執，按內容分類。
- `h15-user-preservation-after.json`：661 個原有會話保留，providers/preferences 雜湊未變，核對命令退出 0。

本輪測試入口是 `.preview-evidence/toolbox-{execute,followup,cache,computer-numeric,computer-entry,custom-skill,pptx-kimi,charts-ui,external-call,tavily-call}.mjs`；輔助視覺入口參數為 `auxiliary`。主場景命令退出 0 不代表其中每項工具均通過；DOCX 的成功回執已由獨立產物檢查推翻。補截圖失敗單列。

```powershell
node --test runtime/tests/git-write-acp.test.mjs runtime/tests/memory.test.mjs runtime/tests/library.test.mjs runtime/harness/test/upstream-tools.test.mjs runtime/harness/test/capabilities.test.mjs runtime/harness/test/goals.test.mjs
```

此命令退出 0，49 測試通過。使用現有 Node 24、專案 Python 及離線快取 Tavily，沒有安裝依賴。沒有刪除工具、修改產品原始碼或產生安裝包；報告尚未提交/推送。未重新驗收 macOS、安裝包、長任務多次壓縮或全部前端入口。本輪發現的 DOCX 缺陷與模型參數問題尚未修復，不宣稱整個首版已全部通過。
