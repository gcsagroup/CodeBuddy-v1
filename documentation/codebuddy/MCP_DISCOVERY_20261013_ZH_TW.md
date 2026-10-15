# MCP 工具探索問題記錄（2026-10-13）

[简体中文](MCP_DISCOVERY_20261013_ZH_CN.md) · [English](MCP_DISCOVERY_20261013_EN.md)

## 實際重現

端點 `http://192.168.9.120:8889/mcp` 交握成功，回傳 150 個工具，均未宣告 `readOnlyHint`。透過應用程式後端實際呼叫 `server_health`，回傳 `healthy`。

隔離設定及實際桌面 ACP 後端測試：先建立對話再加入全域預設擴充功能，原對話有 0 個 HexStrike 工具；新增對話有 150 個；明確為原對話啟用後也有 150 個。

原 `search_available_extensions` 遺漏全域已啟用但尚未載入目前對話的擴充功能，且載入後只列擴充功能名稱，沒有工具清單。這是獨立重現的同類問題，尚未識別截圖對應的特定對話。

## 修復

探索邏輯以目前對話載入狀態比對設定，包含未載入的預設啟用項。同一個唯讀探索工具回傳已載入擴充功能的工具名稱；不將未標註工具改成唯讀，也不授予執行權限。移除擴充功能後，其工具不留在清單。

分析工具載入器說明目前可執行集合與 MCP 清單的差異。擴充功能視窗說明新對話預設值、既有對話啟用入口與連線測試範圍。先前的長錯誤排版修復一併保留。

## 驗證

- 自動化：MCP 發現回歸 1 項、唯讀分析 11 項、擴充功能視窗 16 項通過；TypeScript、ESLint、i18n 編譯/檢查通過，退出碼均為 0。
- 真實服務與桌面 ACP 後端：新 `target/debug/goose.exe` 完成新增擴充功能、新舊對話載入、150 個工具名稱比對與 `server_health` 檢查。
- 真實 Gemma 模型：綁定隔離工作區後，實際呼叫 `load_analysis_tools` 和 `extensionmanager__search_available_extensions`，回執成功，正確列出 `hexstrike__server_health` 與 `hexstrike__execute_command`。未執行掃描或命令工具。
- 證據：`target/mcp-discovery-acp-i0gDma/result.json`、`responses.jsonl`；結果記錄二進位 SHA256。
- 瀏覽器元件夾具在 1280×900、800×700、390×844 通過版面、錯誤提示和底部按鈕可達性驗證。
- 完整 Electron 互動、Mac 真機及本批安裝包尚未驗收。早期未綁定工作區的夾具結果不計通過。

原版本證據：`target/mcp-discovery-acp-DSeWKQ/result.json`；瀏覽器證據：`target/mcp-error-ui-20261013/browser-results.json`；測試日誌：`target/mcp-discovery-20261013/`。

## 交付範圍

目前 `main` 基線 `964bbeb1587f1c5551ee17907e0b26632c4163ce` 加未提交修改。主要檔案為 `extension_manager.rs`、`platform_extensions/ext_manager.rs`、`analysis_tools.rs`、`ExtensionModal.tsx` 及語言資源。沒有設定遷移、自動啟用既有對話或權限變更。尚未提交、推送或產生本批新安裝程式；原始碼修改不會自動更新既有 Windows/Mac 程式。瀏覽器夾具測試不等於完整 Electron 或 Mac 真機驗收。

補充 UI 檔案：新增 `ExtensionError.tsx`；修改 `ExtensionModal.tsx`、`ExtensionModal.test.tsx`、`EnvVarsSection.tsx`、`HeadersSection.tsx` 與 16 份語言資源。錯誤摘要醒目，原始詳情可展開並換行，正文捲動、底部按鈕固定；原始 HTML 以文字顯示。

## 最終整合建置複測

包含 [Gemma 與合同修復](GEMMA_CONTRACT_20261013_ZH_TW.md) 的最終後端再次通過 ACP 聯網測試，命令及二進位雜湊見該文件。證據：`target/mcp-discovery-acp-DuSQFu/`。HexStrike 回傳 150 個工具定義，舊對話載入前為 0、顯式載入後為 150，新對話為 150；`server_health` 呼叫成功。Gemma 實際呼叫 `load_analysis_tools` 與 `extensionmanager: search available extensions`，兩次回執均為 completed，隨後準確回報 `server_health` 與 `execute_command`。未執行命令或掃描類工具，150 個定義不代表全部實際操作已驗收。
