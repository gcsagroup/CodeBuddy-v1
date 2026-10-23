# Windows 安裝器介面

安裝位置預設顯示 `%LOCALAPPDATA%\Programs\CodeBuddy`（通常位於 C 槽目前使用者目錄），不自動帶入上次選取的 D 槽等安裝位置。使用者仍可透過路徑框或瀏覽按鈕選取其他目錄；此設定不遷移舊安裝或使用者資料。

安裝器使用 Inno 原生淺色介面：白色內容區、淺灰底欄，統一字級、內容邊界與按鈕間距。瀏覽按鈕與路徑框等高；進度條上方直接顯示目前操作與正在處理的元件，不使用展開連結或日誌框；完成頁採左側 CodeBuddy 標識、右側說明與選項的雙欄配置。

保留桌面捷徑、開始功能表及完成後啟動的原有選擇，解除安裝仍保留使用者資料與專案。詳情顯示元件摘要，內部相依路徑僅保存在診斷日誌。

解除安裝頁同樣在進度條上方顯示目前操作及元件，不使用展開按鈕或日誌面板。摘要依安裝索引中實際消失的檔案更新，刪除仍由 Inno 負責。程式圖示在解除安裝開始時讀入記憶體；索引僅供觀察，越界項目會被忽略。執行 `node --test scripts/uninstall-details.test.cjs`，以隔離目錄驗證可見及靜默解除安裝、實際元件更新、使用者資料與未安裝專案檔案保留，並儲存視窗截圖。

實作位於 `scripts/installer/installer-ui.iss`、`codebuddy.iss` 及 `install-details.iss`。執行 `node --test scripts/installer-ui.test.cjs scripts/windows-wizard-installer.test.cjs`，使用不同 AppId 的隔離小型安裝器檢查配置、詳情及資料保留，並透過 PrintWindow 擷取該視窗。夾具關閉實際捷徑及應用啟動，不接觸正式安裝。

使用者提供的參考圖僅用於排版與視覺層級，保留 CodeBuddy 標識及行為。原生樣式說明：[WizardStyle](https://jrsoftware.org/ishelp/topic_setup_wizardstyle.htm)。
