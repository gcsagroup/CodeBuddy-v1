# 預設工作區與專案綁定

本批實作位於 `D:\CodeBuddy-v1`，沿用原專案目前檔案的凍結基線；此目錄沒有 Git 儲存庫，未建立分支、提交或推送。基線來源見 `source-baseline.json`。

新版啟動器預設準備 `D:\CodeBuddy-Workspace`。Windows 沒有 D 槽以及 macOS/Linux 時使用使用者目錄下的 `Documents/CodeBuddy Workspace`。開發及隔離驗收可透過 `CODEBUDDY_WORKSPACE_ROOT` 指定絕對目錄。啟動器不再把應用程式原始碼目錄作為預設任務目錄。

最新 CodePro 前端已有自動目錄分配流程。本批只調整 Electron 宿主和啟動器：沒有明確選擇專案時，每個新工作階段在預設容器下取得唯一子目錄；使用者直接輸入任務即可沿現有流程建立工作階段。手動選擇既有專案仍使用該專案。預設容器和工作階段專案是兩個不同目錄，模型的工作目錄是工作階段專案。

`runtime/workspaces.mjs` 是新版工作區租約和專案中繼資料的唯一管理模組。它沿用現有 ACP 方法與回應：

- `workspace/lease/acquire` 重新檢查真實絕對路徑、目錄狀態、正規路徑和祖先檔案身分。新目錄只用非遞迴建立，既有目標按衝突處理。
- `consumeLease` 檢查連線歸屬、五分鐘有效期、單次消耗及工作階段目錄一致性；`validateSession` 在任務入口重新核驗目錄身分。
- `releaseSession` 只釋放處理程序內綁定，保留專案檔案。未消耗的租約斷線、到期或釋放時，僅清理仍屬於原建立且仍為空的目錄；沒有遞迴刪除。
- 租約不持久化。重新啟動後原前端透過檢查、重新取得和確認租約來恢復專案綁定。
- `sources` 的專案增刪改查和匯入匯出使用獨立資料目錄內的真實 Markdown 檔案。刪除專案中繼資料保留工作目錄和原始碼檔案。匯出遵循原 `version: 1`、`type: project` 格式。

整合入口：`new WorkspaceService(store, { projectDirectory })`；相容層呼叫 `handles`、`request`、`consumeLease`、`validateSession`、`releaseSession`、`disconnect`、`close`。`projectDirectory` 必須指向本版資料中的專案中繼資料目錄；也可使用 `store.directory/projects`。

本實作透過正規路徑和 `dev/ino/birthtime` 觀察目錄身分，拒絕符號連結及目錄接合祖先。它不持有舊 Rust 實作的平台目錄控制代碼，不宣稱具備作業系統沙箱或持續防重新命名保證。根容器建立子專案的特殊互動和原生目錄控制代碼級強化仍應獨立驗收。

自動化命令為 `node --test runtime/tests/workspaces.test.mjs scripts/default-workspace.test.cjs scripts/start-harness-preview.test.cjs`，使用既有 Node.js 24，14 項通過、0 失敗，退出碼 0。涵蓋真實目錄建立、原前端宿主檢查/確認合同、目錄替換、目錄接合、跨連線使用、到期、重新啟動續綁、專案來源 CRUD/匯出匯入及預設目錄啟動。測試使用暫存目錄，沒有操作使用者目前桌面處理程序。真實桌面與完整 CodePro 執行驗收由整合批次記錄；這些測試不代表整個首版已驗收。

參考：[Node.js 檔案系統 API](https://nodejs.org/docs/latest-v24.x/api/fs.html)、[ACP 工作階段設定](https://agentclientprotocol.com/protocol/v1/session-setup)。採用現有 ACP 合同與 Node 內建檔案系統能力，沒有新增依賴；舊 Rust Agent 執行核心沒有參與。
