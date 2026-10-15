# Harness 安裝包與首響應分段驗收（2026-10-15）

進行中，尚未宣告安裝後驗收通過。新增只讀Undici分段：建立/發送/回應標頭、首思考、首正文、結束；不更改模型、重試或流內容、不記錄秘密。相同kimi-k3/high/55工具/52433字節四次對照，Compat首正文7760/6470ms，原生4330/3820ms；此為冷啟動，未重現分鐘等待，舊慢樣本仍保留。

使用Electron utilityProcess承載既有Harness，服務關閉先等待原生清理；缺少資源直接失敗，不回退舊Agent。Forge/Squirrel沿用，CodeBuddyHarness安裝ID與~/.CodeBuddy-Harness資料獨立；已驗Rust僅提供MCP工具。node scripts/build-harness-windows.cjs使用既有Node24與依賴，所有資源SHA校驗，無使用者profile打包。

已通過：傳輸5/5、服務2/2、發行36/36、TypeScript/lint exit0；真Electron utility啟動/健康/關閉exit0。修正日誌退出時序；Vite監聽out內EXE造成EBUSY，現排除輸出目錄，待實際復驗。舊預覽退出後以獨占鎖複製637會話及原設定到全新安裝資料目錄，SHA一致且日程暫停，原資料保留。

安裝檔指紋及實際模型/工具/重啟驗收待補。macOS仍待獨立產物。依據Electron utilityProcess、Forge Squirrel及Undici官方文件，連結見簡體版。

## 安裝建構修復

首次 make 程序未留下退出回執，不計通過。用 Forge 官方 --skip-package 接續後，NuGet 明確報 Windows 路徑超過 260 字元（harness-installer-make-retry.log，exit1）。原階段包含完整 CLI 依賴，未啟用的 experimental-inspector 相對路徑達 190 字元。現從 ESM 匯入及實際 profile 收集入口，遞迴複製執行、peer 與已存在的 optional 依賴，保留巢狀版本、授權及執行資源，排除開發依賴、型別宣告和 source map。依賴回歸 1/1 exit0；父層共用 bufferutil 等套件亦保留原 Node 解析佈局。

實際 Vite 服務觀察到原始碼夾具 add/change，out 夾具無事件，exit0（vite-watch-receipt.json）。渲染介面未修改。

## 10:46 實裝回歸與修復

1.43.2 已實際靜默安裝，exit0，登記於 LOCALAPPDATA/CodeBuddyHarness；安裝後 EXE、app.asar、Harness 清單與候選一致。但啟動因適配層直接引用的 dsh-schedule 遺漏而失敗，此包不屬於可用交付。失敗安裝包已保留在 target/failed-harness-installer-1.43.2，測試程序已關閉，設定保留。

已擴充掃描 runtime 頂層的相對 Harness 匯入，包括日程和語音 WAV 校驗，適配器自身也改用執行依賴閉包。新增完整 Compat 服務及原生會話打包前門禁，舊階段紅測確認失敗（stage-service-red.log）。修復候選為 1.43.3-harness1，正建構後進行實際升級、對話及重啟續聊。

Squirrel 缺 7z.exe/dll 別名的環境缺口亦已修復：在專案獨立 vendorDirectory 暫存已有架構工具，依賴目錄不變。NuGet 續做核對應用與 Harness 指紋，關閉 ZIP 後由獨立輸入封裝。最新相關門禁 38/38 exit0（harness-package-final-gates.log）。

## 11:10 首次傳送併發缺陷

完整依賴修復後的候選能啟動並顯示歷史與設定，但首次專案請求在模型啟動前遭適配層排他鎖拒絕。Git 側欄工具與傳送共用鎖。現讓傳送等待已開始的工具收尾並保留下一次執行機會，取消等待不送模型請求，編輯與刪除保護仍在。修復前兩項紅測，修復後相關 24/24；補充真實 Harness 維護及串流整合後本組 11/11，均 exit0。

正在重建含修復的安裝包，記錄 harness-installer-admission.log。10:58 計時涵蓋輸入並處於建構負載，暫不作空閒效能結論。修復後實裝驗收尚待完成。

## 11:28 原生子程序宿主修復

1.43.3-harness1 實際升級 exit0 且指紋一致，但工具執行發現 Electron utility 的 execPath 使 Harness Windows Job runner 提前退出，因此不列為可用交付。現捆綁已有 Node 24.18.0 與 LICENSE，以 Node 原生 IPC 啟動與關閉服務，保持 Harness 子程序機制。可信包根目錄先解析實體路徑，處理 Codex MSIX 的 LocalCache 重定向，檔案校驗保留。

候選升至 1.43.3-harness2；服務 2/2、TypeScript、lint 均 exit0，封裝前新增包內 Node 的 PowerShell/glob 執行門檻。建構日誌 harness-installer-node-runtime.log，修復後實裝驗收待完成。第二個有效新對話樣本約 1.02 秒進入、8.09 秒呈現；遠端 MCP 已復用，準備 754ms，上游首資料 4629ms。warm.json 讀到隱藏舊訊息而失效，採用 warm-v2.json。

## 11:41 退出競態與候選

包內 Node 的 PowerShell/glob 門檻與完整服務啟動、別名解析、退出均通過。候選真實模型調用時間及 PowerShell 成功；純問候約 1.31 秒進入、6.14 秒顯示。退出仍到 15 秒兜底，紅測證實停止期間可接受 WebSocket 重連；修復後相關 10/10 exit0。版本升至 1.43.3-harness3，harness-installer-final.log，最終實裝驗收待完成。

## 12:06 最終安裝版實測

來源為 D:\CodeBuddy-v1 現有檔案及未提交修改；無 .git，未建立分支、提交或推送。建構與實際升級均 exit 0，安裝後七個關鍵檔案雜湊與候選一致。獨立識別 CodeBuddyHarness，啟動 `%LOCALAPPDATA%/CodeBuddyHarness/app-1.43.3-harness3/CodeBuddy.exe`，資料 `~/.CodeBuddy-Harness/backend`。本機 MSIX 路徑重導已解析；原快捷方式保留。

純問候 1.698 秒進入、11.400 秒可見回覆，分段顯示；冷會話準備 5149ms，上游正文 2657ms，仍有冷啟動等待。後續專案會話準備 948ms，遠端 MCP 重用。真實安裝版約 145.5 秒完成 money/tax/invoice。模型第一次測試 33/34，自行修正錯誤測試斷言後 34/34；宿主複跑 34/34、外部獨立合同 7/7，exit 0。原生 turn/end completed；專案記憶保留候選狀態。

使用既有「立即壓縮」按鈕，原生壓縮約 26.35 秒完成，用量 23k→17k（16925/32768）。直接輸入 /compact 回車被斜線選單攔截，不算通過。正常關閉回執 220ms，主程序、Node、MCP 均退出；重啟從歷史確認保存的工作區並續聊。

本批門檻：原生會話 11/11、停止競態 10/10、發行 40/40、服務 2/2，TypeScript/lint/建構 exit 0。修改會話進入鎖、停止重連、包內 Node IPC、依賴閉包、工具實測門檻及 Squirrel 封裝，對應檔案與詳細命令見簡體紀錄。證據 `.preview-evidence/harness3-installed-*.json`、專案測試與獨立測試 log、harness-final-install.json。未下載安裝開發依賴。Windows 本次實裝證據不代表 macOS、連續多次自動壓縮或小時級大型生產專案全部通過。


- Version: `1.43.3-harness3`
- Installer: `ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Harness-Setup.exe`
- SHA256: `9D4EA185DF6861188743CC6905E898E0FB360391A4D9F87EC1A7896AB708627E`
- Harness sourceDigest: `cd5443c4d6cb2c3d729596ac42895891531d7782793e6cf6774cf23a1a862c78`

## 12:10 重啟續聊與計時

原會話續聊約 28 秒完成，保留 HARBOR-625、625 基點、運費不計稅、10975；真實工具測試 34/34，新參數輸出 11050。第二輪原生 completed；六個檔案雜湊未變。最後新會話問候 1.332 秒進入、8.054 秒可見回覆、10.347 秒結束，MCP 重用、準備 1433ms、上游正文 2534ms。8–11 秒首顯仍待優化，未量測差值不全歸因上游。證據 harness3-installed-resume.json、harness3-installed-warm.json、harness3-project-resume-hashes.json。安裝版保持運行。
