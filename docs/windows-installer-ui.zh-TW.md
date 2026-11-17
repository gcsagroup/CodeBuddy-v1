# Windows 安裝器介面

手動安裝時先選擇範圍。「僅為我安裝」預設使用 `%LOCALAPPDATA%\Programs\CodeBuddy`。「為這部電腦的所有使用者安裝」會透過 Windows 要求管理員授權，預設使用 `%ProgramFiles%\CodeBuddy`。目錄頁顯示該範圍上次登記的位置、所需空間及目標磁碟可用空間。應用程式內更新沿用目前的安裝範圍和目錄。移除全機安裝時保留各帳戶的個人資料。

開啟安裝程式後選擇安裝範圍。選擇所有使用者時先確認 Windows 系統管理員權限，再選擇目錄，按「安裝」即可查看複製進度。

安裝器使用 Inno 原生淺色介面：白色內容區、淺灰底欄，統一字級、內容邊界與按鈕間距。瀏覽按鈕與路徑框等高；進度條上方直接顯示目前操作與正在處理的元件，不使用展開連結或日誌框；完成頁採左側 CodeBuddy 標識、右側說明與選項的雙欄配置。

移除個人安裝時預設保留個人資料。使用者也可以僅清除聊天記錄，或清除全部受管理的個人資料，兩者都需要再次確認。僅清除聊天時會保留模型設定、工作區、診斷日誌及另行匯出的副本。靜默解除安裝一律保留資料。

解除安裝頁同樣在進度條上方顯示目前操作及元件，不使用展開按鈕或日誌面板。摘要依安裝索引中實際消失的檔案更新，刪除仍由 Inno 負責。程式圖示在解除安裝開始時讀入記憶體；索引僅供觀察，越界項目會被忽略。執行 `node --test scripts/uninstall-details.test.cjs`，以隔離目錄驗證可見及靜默解除安裝、實際元件更新、使用者資料與未安裝專案檔案保留，並儲存視窗截圖。

實作位於 `scripts/installer/installer-ui.iss`、`codebuddy.iss` 及 `install-details.iss`。執行 `node --test scripts/installer-ui.test.cjs scripts/windows-wizard-installer.test.cjs`，使用不同 AppId 的隔離小型安裝器檢查配置、詳情及資料保留，並透過 PrintWindow 擷取該視窗。夾具關閉實際捷徑及應用啟動，不接觸正式安裝。

使用者提供的參考圖僅用於排版與視覺層級，保留 CodeBuddy 標識及行為。原生樣式說明：[WizardStyle](https://jrsoftware.org/ishelp/topic_setup_wizardstyle.htm)。

## 載入動畫尺寸

啟動首幀 HTML 與 React 畫面統一為 56px 外框、36px 標誌；對話載入為 44px 外框、28px 標誌。文字 14px，減輕陰影與留白。保留置中、明暗主題、減少動態偏好及就緒後立即消失的行為；側邊欄執行圖示不變，未修改安裝或狀態邏輯。
