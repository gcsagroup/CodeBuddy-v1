# MCP 工具佔用與模型視窗修復

來源：`D:\CodeBuddy-v1` 既有複製目錄，無 `.git`，未提交或推送。候選 `1.43.3-harness6`。保留使用者模型、思考強度與工具權限。

最終交付為 `1.43.3-harness7`，包含下文首頁容量修復。harness6 證據明確標示為中間候選驗證，不冒充最終包重跑全部長任務。

目前 Gemma 服務 `/v1/models` 回報 `max_model_len: 65536`，但適配層原先僅保留模型 ID，向 Harness 傳遞 32768 的預設值，因此介面顯示約 33k。實裝新對話含 205 個工具，定義共 167380 字元；實際輸入約 32260 tokens，本地估算約 43k。Harness 的 pi-ai 依視窗扣除估算輸入與 4096 安全餘量，導致輸出額度僅剩 1 token，最終以 `max_tokens` 中斷。

官方 token meter 有計入工具；歷史壓縮不縮減工具 schema、系統提示或會話前綴。新對話沒有歷史可壓，工具定義本身超限需要正確容量或控制載入範圍。

修復於 `providers.mjs` 讀取服務提供的正整數視窗，按連線指紋快取五分鐘、合併並行讀取，變更連線或憑據後失效。舊設定首次使用最多兩秒查詢，失敗短暫快取並保留原有回退。`roles.mjs` 以提供方和模型共同區分路由容量；普通會話、審查和輔助視覺也傳遞模型。執行、計量與壓縮仍由 Harness 主導。

另包含單會話快照提速，以及從實際清單檔案定位安裝資源目錄的 Windows 應用容器修復；保留工具身分校驗。

驗證：提供方/角色/視覺 24/24；會話生命週期 9/9；大工具壓力、手動及自動壓縮 3/3，均 exit 0。生命週期初跑遇到舊夾具沒有 GET 模型列表路由，修正夾具後重測通過；中斷初跑不計成功。真實 Gemma 保留 205 個工具後完整 `end_turn`，源碼冷啟動首段約 12 秒、模型階段約 0.8 秒，不作為安裝版效能結論。連續真實壓縮與安裝版 UI 結果見下文；harness5 已作廢。

證據：`.preview-evidence/gemma-context-fixed-real.log`、`harness-compare-X05bSL`、`context-metadata-tests.log`、`harness6-session-regression.log`、`context-tool-pressure-tests.log`。

安裝候選 `1.43.3-harness6` 於 13:07 建構完成、13:09 靜默安裝完成，均 exit 0；八項安裝檔案雜湊與構建一致。資源指紋 `d5d62f8a871f78583170eeac088547d3bedfff0a671836ec24098e10709bdf05`；安裝包 SHA256 `FB73321B967854A566E6A684E6CE38F2677B59483B6ADE38DD4D24BBE68D53C0`。副本位於 `target/accepted-harness-installer-1.43.3-harness6/CodeBuddy-Harness-Setup.exe`，目錄名稱不代表所有測試通過。真實 UI 已完成下列測試。完整命令及回執見簡體紀錄。

## 最終驗收更新

真實普通會話保留 201 個工具（CodePro 多四個角色工具），完成六次官方超限恢復壓縮。前七輪正常結束，第八輪觸及測試腳本 180 秒期限而被取消；重啟並載入原生會話後，下一輪正常完成，最後一條實際回答正確保留 HARBOR-fd137641、修正稅率 750 bps、整數分及運費不計稅。證據為 `.preview-evidence/mcp-context-pliiLm/receipt.json`、`resume-receipt.json`、`verified-summary.json`。保留超時紀錄，不宣稱全程無中斷或小時級大型專案通過；壓縮包含服務拒絕過大請求後的恢復，不是全部超限都在發送前攔截。

實裝介面冷／熱新會話出現耗時 1.321／1.292 秒，首段 45.360／3.885 秒；兩輪正常結束，收到 179／230 個文本分段，介面文字變化 26／33 次。原生視窗 65536、輸出預算 4096，保留 205 工具。模型階段冷／熱首段為 36.653／0.549 秒，遠端 MCP 複用後準備由 6.476 降至 1.295 秒。冷啟動模型延遲尚存，單組樣本不保證後續耗時；約 53k 長輸入可等待數分鐘。證據：`harness6-gemma-cold.json`、`harness6-gemma-warm.json`、`installed-context6-4ElYTl/logs/harness/runtime.log`。

實裝 UI 執行原生 PowerShell、建立 hello.txt 並讀回 HARNESS6-FILE-OK，原生狀態完成，共 41.646 秒。模型兩次未成對填寫 sandbox_permissions／justification，被 Harness 拒絕後自行補齊成功，未放寬權限校驗。證據：`harness6-installed-tools.json/png`、`harness6-tools-native-summary.json`。另任務／重啟整合 1/1、CodePro 適配 11/11，exit 0。未變更前端布局，未提交或推送。

參考：[官方壓縮邊界](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md)，依本機 `0.2.1-alpha.2` 核對。

[简体中文](2026-10-15-context-capacity.zh-CN.md) · [English](2026-10-15-context-capacity.en.md)

## 首頁容量補充修復（harness7）

harness6 回到預設資料目錄時發現：首頁在建立對話前讀取模型庫存，容量元資料尚未載入，仍顯示 33k，雖然執行已使用 65536。`resolvedInventory` 讓 `providers/list` 透過同一有界快取取得設定完成連線的容量，再回傳首頁。未設定連線略過，離線目錄保留回退；不變更前端布局或 MCP 連線。

`node --test runtime/tests/providers.test.mjs runtime/tests/acp-contract.test.mjs`：24/24，exit 0，紀錄 `harness7-inventory-tests.log`。新增回歸涵蓋首次對話前容量、並行庫存、首輪路由複用查詢與離線回退。harness6 執行鏈路證據另行標示，最終安裝包仍需重驗首頁與真實對話。

原始碼範圍：`runtime/{providers,roles,compat,vision-routing}.mjs` 容量路由；`runtime/{store,conversation-driver,transcripts,codepro}.mjs` 定向快照；`ui/desktop/src/harnessService.ts` 資源根目錄；`ui/desktop/package.json` 版本。回歸涵蓋提供方、角色、快照原子性、會話生命週期、原生 Harness 能力與桌面服務。保留其他既有修改，無分支、提交、推送或依賴安裝。

最終封裝命令 `node scripts/build-harness-windows.cjs target/harness-package-context7/harness-distribution` 於 13:39:45 完成，exit 0，含原生子程序門禁；`CodeBuddy-Harness-Setup.exe --silent` 於 13:40:55 安裝完成，exit 0。EXE、歸檔、清單及兩個變更執行檔案共五項雜湊與包內來源一致。穩定檔案：`target/accepted-harness-installer-1.43.3-harness7/CodeBuddy-Harness-Setup.exe`；SHA256 `FC3003A48ECCF82C6B3E47C93C360DA844296C43D40CBC4122AFEEAA6006EDAC`；資源指紋 `5d43f6e7208d83c2c25a8b43c8b78215c68c77c144ba5d7a8cc4eadcf9f18d9b`。預設使用者目錄首次發送前首頁顯示 `0 / 66k`（65536），保留 Gemma 設定與歷史。證據：`harness7-initial-homepage.json/png`、`harness7-installed-identity.json`、`harness7-install.json`。

最終實裝 UI 兩次「你好」均 end_turn／原生 completed：會話出現 0.986／1.282 秒、首段 8.007／3.878 秒、整輪 18.880／12.875 秒；文本分段 219／166，介面變化 31／25 次。兩輪保留 205 工具、原生容量 65536。首輪模型首段 0.748 秒；遠端快取未受控，不將相對先前 45 秒樣本的差異全歸因最後補丁。第三個 UI 任務以原生 pwsh 輸出 HARNESS7-OK，回執無錯誤且原生完成，10.360 秒；工作區自動建立。證據：`harness7-installed-greeting.json`、`harness7-installed-greeting-warm.json`、`harness7-installed-command.json/png`、`harness7-native-summary.json`。保留預設使用者配置下的新包視窗。六次壓縮沿用本批 harness6 未變動執行鏈路證據，未在 harness7 重跑；長輸入延遲與更大專案的資訊保真仍有驗證邊界。
