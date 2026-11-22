# CodeBuddy 圖示

選定原圖保存在 `codebuddy-selected.png`。正式母版 `codebuddy-master.png` 使用內建 imagegen 去除原圖外部淺色背景，保留石墨黑圓角底與兩條交錯的白色括號；macOS 單色範本為 `codebuddy-template-master.png`。其餘尺寸與格式由既有 Pillow 工具鏈等比匯出。未採用的候選圖已移除，歷史版本仍可由 Git 查閱；正式母版保持不變。

在倉庫根目錄執行 `python ui/desktop/scripts/generate-codebuddy-icons.py`，一次更新應用程式標誌、favicon、PNG、Windows ICO、macOS ICNS、Linux SVG 容器和系統匣資源。`src/images/prepare.sh` 呼叫相同腳本。SVG 嵌入同源 PNG，並非真正向量圖；更新提示僅疊加狀態圓點。請一併提交母版與匯出檔案。

應用程式統一使用 `CodeBuddyMark`；舊 `GooseLogo`/`Goose` 匯入是相容入口。系統匣初始化與更新狀態共用 `trayIconFileName`。第三方服務圖示與歷史文件插圖不屬於軟體品牌資源。

Windows 系統匣使用包含 16、20、24、32、40、48、64、128、256 像素圖層的 ICO，避免系統從 1024px PNG 再次縮小。視窗透過 `setAppDetails` 指定工作列圖示，安裝版 AppUserModelID 與 Squirrel 捷徑一致；開發預覽使用獨立 ID。比例適配使用 contain，不拉伸非正方形原圖。

已安裝程式與舊安裝包須重新建置、安裝後更新；Windows 捷徑快取也可能延遲刷新。Windows、macOS 安裝包的系統外觀需分別在對應平台驗收。

2026-10-19 Windows 本機驗證：在 `D:\CodeBuddy-v1` 的 `main`、`732113504de3601ab087a609ce20827b814db2c2` 加目前未提交修改上建置 1.43.6。工作區另有獨立的執行階段/macOS 修改，本次未提交或推送。

- `python ui/desktop/scripts/generate-codebuddy-icons.py`、圖示/元件 Vitest 5 項、TypeScript `--noEmit`、分發設定測試 4 項與相關 `git diff --check` 均結束於 0。完整 branding 測試先前為 4 通過、1 失敗，失敗項是 HEAD 已存在的 TLS 指紋斷言，與圖示無關；未將該套件標為通過。
- 使用既有 Node 24.21.0 執行 `node scripts/build-harness-windows.cjs`，結束於 0。產物 `out/make/squirrel.windows/x64/CodeBuddy-Setup.exe` 的 SHA-256 為 `baeabdecb6df02a8ea456ae9e6e037e5f04465a27330e9bbb5c1391aa7d78e70`。
- 本機執行該安裝器 `--silent`，結束於 0；透過安裝目錄啟動入口開啟程式，選單顯示 1.43.6。封裝 EXE、安裝器、已安裝主 EXE 和啟動入口 EXE 的全部 9 層圖示均與來源 ICO 一致；6 項安裝後圖示檔案雜湊亦一致。開始功能表捷徑 ID 為 `com.squirrel.CodeBuddyHarness.CodeBuddy`，桌面捷徑工作目錄為 `app-1.43.6`。
- 已觀察真實視窗標題圖示、版本選單和檔案總管中的新捷徑圖示預覽，預覽比例正常。桌面工具未回傳工作列/系統匣彈出區，故兩處實際外觀仍待直接確認；macOS 系統外觀尚未驗收。未清理 Windows 圖示快取。

本機證據位於倉庫 `.preview-evidence/branding/`，不納入提交。舊版 1.43.5 安裝器保存在該目錄；既有使用者設定與歷史未主動清除。

同日桌面圖示複核：使用者截圖顯示桌面仍使用舊圖。確認桌面捷徑目標與 EXE 圖示正確後，備份該捷徑，將圖示來源從固定路徑的啟動 EXE 改為已安裝的 `app-1.43.6/resources/images/icon.ico`，保留啟動目標及 AppUserModelID。使用者隨後確認桌面已顯示新圖示；證據支持舊圖示快取引用是原因。此項為本機捷徑修復，未修改安裝器，後續重新安裝會重新建立捷徑。

生成提示詞見 [English](README.en.md)。简体版见 [README.zh-CN.md](README.zh-CN.md)。
