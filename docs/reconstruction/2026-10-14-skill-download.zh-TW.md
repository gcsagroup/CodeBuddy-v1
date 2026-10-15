# 技能預覽下載與套用

原始碼位於 `D:\CodeBuddy-v1`，基線見 `source-baseline.json`；沒有建立分支、提交或推送。本批保持 renderer 原檔案，連接既有 `skills/manage/download-preview` 與 `skills/manage/apply`。

`runtime/skill-download.mjs` 接受使用者填寫的公開 HTTPS `SKILL.md` 位址，或 GitHub `tree/<ref>/<技能目錄>` 位址。GitHub 分支先解析成提交與根 tree，再讀取選定目錄的 Git tree；檢查檔案模式，拒絕符號連結、子模組、路徑越界及重名，並使用 Git blob 雜湊核對下載位元組。只使用公開存取，不讀取 GitHub 憑證。單檔位址只匯入該檔案，不猜測附屬檔案的位置。

重用現有 `ipaddr.js` 2.5.0（MIT）檢查位址，DNS 結果固定到 HTTPS socket；每次重新導向重新檢查協定、連接埠、位址與允許的 GitHub 主機。限制為 64 個檔案、單檔 1 MiB、總檔案內容 4 MiB、5 次重新導向、單次請求 20 秒、整次下載 60 秒。查詢參數從持久化來源記錄及預覽來源文字中移除。

`LibraryService` 將下載結果保存在綁定連線、五分鐘到期的記憶體預覽中，驗證 UTF-8 與 Agent Skills 必要欄位；使用者點擊原「套用」後安裝該份快照，不重新存取上游。沿用路徑身分、衝突及單次使用驗證；完整目錄先寫到 Harness 技能掃描目錄之外，再整體重新命名發布，最後刷新官方技能探索。斷線及關閉會取消尚未完成的下載。

保留選定目錄內的 LICENSE、參考資料與腳本。匯入過程不執行腳本。保留上游聲明的授權條款，不推斷缺失的許可；不從選定目錄以外取得授權條款。`.codebuddy-source.json` 記錄提交、原檔案雜湊及安裝後的技能名稱/文件雜湊，區分因目標目錄改名而重寫的 frontmatter。

`node --test runtime/tests/skill-download.test.mjs runtime/tests/library.test.mjs`：19 項通過，結束碼 0。涵蓋原 SDK DTO、真實暫存檔案、受控本機 HTTP 位元組傳輸、固定提交/雜湊、位址限制、大小/時間限制、到期、斷線、衝突、來源與授權條款保留及腳本不執行。測試未向真實外部技能服務發出下載，也未修改使用者技能目錄。桌面按鈕互動與真實外部服務屬於後續產品驗收。

參考：[Agent Skills 規範](https://agentskills.io/specification)、[GitHub Git Trees API](https://docs.github.com/en/rest/git/trees)、[GitHub Contents API](https://docs.github.com/en/rest/repos/contents)。選擇 Git Trees 因為它明確提供連結與可執行檔案模式；Contents API 對部分連結回傳目標檔案內容。沒有增加相依套件或啟用舊 Agent 核心。
