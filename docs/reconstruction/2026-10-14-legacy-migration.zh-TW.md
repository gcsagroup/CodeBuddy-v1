# 舊資料離線遷移

本批原始碼為 `D:\CodeBuddy-v1` 目前檔案，基線見 `source-baseline.json`；沒有建立分支、提交或推送。原專案及舊使用者資料僅供讀取。實作位於 `runtime/legacy-migration.mjs`、`runtime/profile-lock.mjs`，入口為 `scripts/migrate-legacy-profile.mjs`。

## 使用與整合

先執行唯讀清單：`node scripts/migrate-legacy-profile.mjs --source <舊profile絕對路徑> --target <新版backend絕對路徑>`。寫入須另外提供 `--apply --offline`，並先關閉目標新版。遷移及服務端共用 `acquireProfileLock(dataDir)` 的 SQLite 獨占交易；程序結束自動釋放。遷移亦檢查舊啟動回執的程序是否存活，涵蓋尚未採用鎖的預覽版本。`--offline` 不繞過存活程序或鎖檢查。

`inspectLegacyProfile` 回傳數量及相容邊界，不列印聊天正文或設定值。`migrateLegacyProfile` 使用 Node 內建 SQLite backup 產生獨立一致快照，並執行 quick_check。原資料庫及 WAL 以唯讀連線讀取。state.json 僅加入原 UI 可見的 user/code_pro 工作階段中繼資料，含 `readonlyHistory:true` 與 `legacyHistory:{archiveId,sessionId}`。訊息留在 `legacy/<archiveId>/sessions.db`；`loadLegacyConversation(dataDir,reference)` 按需讀取一個工作階段，重用既有歷史驗證及 UI 投影器。隱藏/子 Agent 工作階段保留於歸檔，不加入原 UI 清單；舊執行與權限不恢復。

設定僅補缺失項，保留新版預設模型、既有提供商及憑證。相容自訂提供商定義遷入後，舊鑰匙圈金鑰需要重新填寫；既有明文自訂 header 以新版憑證保護儲存。新增 MCP 設定預設停用；未知舊內建擴充明確列出。舊排程由現有 ScheduleService 建立，全部暫停、未驗證，清除執行標記與舊執行工作階段，不重播任務。

記憶原檔完整保留於歸檔。舊專案識別碼採用 Blake3，新版採用 Harness 儲存域；未確認對應時不猜專案歸屬。透過 `--project-map <JSON檔案>` 提供 `{ "舊32位identity": "專案絕對目錄" }` 後，經 ProjectMemory 與官方 driver.memory 遷入專案記憶，保留 active/candidate/disabled、有效期及信心程度。原 user 範圍記錄另列待審，不擴大新版專案邊界。穩定 ID 讓重跑跳過已匯入記錄；跨模組中途結束可再次執行，報告明列未處理項，未宣稱跨檔案原子回滾。

## 驗證

`node --test runtime/tests/legacy-migration.test.mjs`：10 項通過，結束碼 0。使用真實隔離 SQLite/WAL、暫存目錄、原 DTO 投影及官方 Harness 記憶重啟，涵蓋唯讀清單、快照獨立、按需讀取、新版設定保留、憑證落盤保護、排程暫停、記憶對應/狀態、冪等重跑、程序鎖與退出釋放、來源/目標重疊及符號連結拒絕。

真實服務端 WebSocket ACP 回歸另確認 load/export 按需讀取、舊隱藏訊息不投影、state 不回寫正文，歷史查看沒有 Agent 執行呼叫；prompt 拒絕恢復舊任務。執行中服務拒絕遷入，關閉後冪等重跑成功。

對 `C:\Users\jiangrui\.CodeAgentPro\profiles\local` 實際執行的是 dry-run，結束碼 0：789 個工作階段，原 UI 可見 616 個；22021 條訊息，資料庫 235692032 位元組；9 個自訂提供商、24 個擴充設定、11 份記憶檔案共 14 條記錄、1 個排程。本批未執行使用者資料 apply，亦未完成桌面歷史查看驗收。未對應記憶、舊金鑰及不支援的舊擴充須依遷移報告處理。

後續唯讀身分比對已完成：`runtime/legacy-memory-mapping.mjs` 按舊 Rust 的 canonical 路徑（含 Windows `\\?\` 前綴）、斜線轉換、小寫及 Blake3 前 32 位規則，從原 projects.json 與 session working_dir 比對全部 11 個身分。5 個目錄仍存在，共 3 條可遷入記錄；其餘 6 個目錄已刪除，共 11 條保留歸檔及已核對的歷史路徑。報告與可用對應分別位於 `.preview-data/validation/legacy-memory-mapping-report.json`、`legacy-memory-project-map.json`。新增 2 項格式與比對測試通過，結束碼 0；唯讀報告不含記憶正文。

參考：[SQLite Online Backup API](https://www.sqlite.org/backup.html)、[Node SQLite API](https://nodejs.org/api/sqlite.html)、[noble-hashes](https://github.com/paulmillr/noble-hashes)。重用既有 Node 24 SQLite、YAML、憑證保護及 Harness。單次身分核對在獨立暫存目錄取得 `@noble/hashes` 2.0.1（MIT），驗證固定 npm SHA512 及 Blake3 空字串標準向量，不執行套件腳本；產品相依套件與鎖定檔案沒有變更。
