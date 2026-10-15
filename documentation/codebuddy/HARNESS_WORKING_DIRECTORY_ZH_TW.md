# 一般聊天工作目錄切換

日期：2026-10-14。原始碼為 `D:\CodeBuddy-v1` 目前檔案；無 Git revision，本批未提交或推送。原介面保持不變。

## 合約與實作

原 ACP `_goose/unstable/session/working-dir/update` 接收 `{sessionId, workingDir}`，成功回傳 `{}`。只接受真實存在的絕對目錄；不建立目錄。活動會話、匯入的唯讀歷史及 CodePro 會話拒絕切換。CodePro 繼續受任務工作區 lease 約束。

官方 `workingDirectory.set` 只改變有效目錄，明確保留原權限；`sandboxPolicy.resolve` 的 workspace-write 根來自不可變的 `session.header.cwd`。因此僅改產品欄位或呼叫目錄 setter 會造成新路徑與舊寫入邊界不一致。

`runtime/harness/working-directory.mjs` 重用公開的官方 `buildForkSeed`、`agents.create`、`workingDirectory.set` 和 `sessions.flush`：保留完整舊日誌，為新目錄建立新 native session header，視需要修正繼承的目錄投影並持久化。沒有新增模型迴圈、變更舊日誌或將沙箱擴大為完全存取。已有 agent preset 的特殊組合會明確拒絕，目前產品一般會話不使用該組合。

`conversation-driver.mjs` 保持產品會話 ID 穩定。Compat 在會話鎖內原子儲存新 native 指標、目錄和 `directoryChanges`；儲存失敗只留下未發布的 native fork，舊產品指標及會話仍有效。成功後清除舊能力 scope，下次 ensure 用新目錄重建 Git、專案記憶和 MCP。舊 native ID 從會話清單投影中隱藏，日誌仍保留。舊 scope 釋放失敗記錄明確日誌，服務關閉負責最終清理。

AGENTS 和原生檔案工具使用官方目錄機制；新 header 同時成為新寫入邊界。工具審批仍生效，不攜帶一次性審批。歷史訊息及舊工具結果繼續保留，所以歷史中出現舊專案資料不等於目前專案記憶作用域洩漏；主動記憶讀取和注入只使用新目錄。

## 驗證與邊界

執行命令：`node --test runtime/tests/working-directory-harness.test.mjs runtime/tests/working-directory-acp.test.mjs runtime/tests/conversation-editing.test.mjs runtime/harness/test/mcp-apps.test.mjs`。14/14 通過，退出碼 0：目錄切換 4 項、歷史編輯回歸 6 項、MCP 驅動回歸 4 項。

隔離 `.preview-evidence/codebuddy-directory-harness-*` 測試目錄位於系統 Temp 之外，驗證 A→B→重新啟動→C，相對 write/read 落新目錄，以及 B 會話對舊 A 絕對路徑的寫入被官方檔案沙箱拒絕。模型上下文的目前目錄與寫入根均精確指向 B。其他臨時測試環境驗證歷史、AGENTS、審批、無效路徑、活動拒絕、CodePro/唯讀拒絕、專案記憶隔離，以及 stdio MCP 的實際 PID 退出與新 cwd。

測試使用真實官方 Harness、ACP、原 SDK Zod、本機受控模型 HTTP 和 stdio MCP；不涉及使用者專案分支或提交。真實 Electron 目錄選擇器互動及 macOS 尚未由這組結果驗收。宿主檔案沙箱的驗證不代表 PowerShell 程序具有同等級作業系統沙箱。

## 依據

使用本機鎖定的 MIT 授權 DeepSeek Harness `0.2.1-alpha.2`；檢查了 `dsh-working-directory`、`dsh-sandbox-policy`、`dsh-agent`、`dsh-session` 的公開型別與實作。官方 [工具目錄](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md)說明各工具目錄與執行後端職責；具體接線以本機版本為準。無新增依賴或 vendored 修改。
