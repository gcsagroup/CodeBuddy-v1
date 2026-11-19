# Mac Computer Use 六項交付驗收（2026-11-19）

[简体中文](mac-computer-use-six-acceptance-2026-11-19.zh-CN.md) · [English](mac-computer-use-six-acceptance-2026-11-19.en.md)

最初約定的六項，在本報告的測試案例與機器上均通過。視窗定位、中文 FORMS、切換視窗、彈窗、Esc 接管、寫入後遺失回執、同對話恢復、網頁及 Preview PDF 均有真實回執與結果核對。交付為正在執行的原始碼預覽版，不是新 DMG，也不代表任意 Mac 應用全覆蓋。

## 原始碼與執行身分

Windows：`D:\CodeBuddy-v1`，main `4c8afad978b6e893a3545c0859dd5b4824a91223`，保留既有及本次未提交變更，未建立分支、提交或推送。Mac：`/Users/erjinyi/Desktop/work/CodeBuddy-v1`，Git HEAD `732113504de3601ab087a609ce20827b814db2c2`，以 Windows 目前工作區原始碼同步覆蓋。交付前逐檔核對，Windows 清單內檔案在 Mac 均存在且正規化換行後 SHA-256 一致；排除本機證據、相依套件、快取及本機報告。Mac 額外檔案與授權條款保留。兩端 Git HEAD 並不相同。

最終執行程序 PID 29316，啟動 `2026-11-19T02:54:24.016Z`；source/current hash 均為 `677e55481e4fa4e3a796f2720f7e8e76752d3073c7c28b4a4e5290ba9032a810`，restartRequired=false。原生二進位 SHA-256：`9e30cfdd6ffcbafa6160d5ee5e8f3fa21de8d3dfd3ee5db3b707c0b94d1e8f17`，建置目錄 `target/codebuddy-package/computer-arm64-sHYE7q`。

真機：Apple M2、16 GiB、macOS 27.0.1 (26A434)、Swift 6.4.2。GUI 啟動程序實際讀取控制項、輸入及截圖成功。SSH 獨立啟動程序的畫面錄製權限失敗屬環境限制，不算產品失敗。主模型固定 Ollama `deepseek-v4.1-flash`、高思考強度；本機 CoreML FORMS 提供建議，`CUA-S1-Qwen3.5-4B` API 僅辨識截圖。

## 本輪修復

1. 模型曾把描述性的「目前客戶表」當完整視窗標題。schema 與技能明確區分描述和精確標題限制；先列出視窗，再選真實 selector。宿主僅允許首次探索建立範圍，後續不能擴大或替換，沒有新增中文關鍵詞特判。
2. Safari 的空白裝飾 AXGroup 增減造成 FORMS 投影誤判過期。原生校驗只忽略無名稱、無值的非編輯裝飾節點，仍保留所有有名稱或值的節點、全部可編輯欄位（包含無名空欄），並核對視窗、身分、位置、值及唯一綁定。中文由主模型轉成評分標籤，原值不翻譯。
3. 寫入已生效但回執前原生程序斷線，模型重新觀察會一直等待暫停解除。現在結束本輪電腦控制為 DESKTOP_STOPPED，明確回報結果未知，其他獨立工作仍可進行；使用者繼續後先重新觀察，不重放舊輸入。沒有新增另一套狀態協議。

修改範圍：`runtime/desktop-coordinator.mjs` 及測試、computer-use 技能及測試、`tools/qwen-computer-use/main.go`、`macos/RuntimeContract.swift` 及合同測試、三語投影文件與所有權說明。先前已批准的 PDFKit 磁碟回執及辨識優化保留，見[前批效能報告](mac-forms-performance-2026-11-19.zh-TW.md)。

## 六項驗收

| 項目 | 真實結果 | 狀態 |
|---|---|---|
| Mac 基線 | 讀取標題、欄位、目前值，實際輸入與截圖；真實 CoreML 評分及官方範例 | PASS |
| FORMS 匹配 | 中文建議與填寫 2/2；同名信箱保留並說明；未知欄位不猜填 | PASS |
| 對話到原生輸入 | 可見 CodeBuddy 對話修改 Preview，介面與已儲存 PDF 一致 | PASS |
| 草稿及中斷 | 舊值保留；切到 Finder 後舊點擊拒絕；彈窗取消；Esc/斷線停止控制，同對話重新觀察後續作 | PASS |
| 網頁與原生應用 | 官方範例 3/3，另 20 項保留、提交 0；Preview 原檔儲存成功 | PASS |
| 對照及交付 | 同模型、強度、初值，記錄正確率、時間、token；預覽、案例、證據齊備 | PASS |

中文證據 `cn-projection`，對話 `d2c2bbe1-6d06-4d0e-8c20-c7d80aa15fda`。原始中文評分 skip 後，主模型投影綁定真實控制項，本機 Company→云杉测试、Email→yunshan+forms@example.test 均建議 fill，機率約 0.999157 / 0.999960，單欄約 18.818 / 2.898 ms。未映射的帳單與備註不評分、不修改。

以下時間統一為 Harness turn/start 至 turn/end，服務往返另記：

| 場景 | 秒 | 結果 |
|---|---:|---|
| scope-cn / scope-description / scope-en | 29.980 / 33.839 / 42.582 | 三種描述性提示詞各填對 2/2 |
| scope-exact / scope-missing | 26.106 / 10.748 | 精確標題成功；不存在標題零輸入 |
| ambiguous / unknown | 28.244 / 33.083 | 同名信箱保留；缺少客戶等級欄位有明確說明 |
| popup | 42.540 | 取消彈窗，不在彈窗輸入 |
| escape-ui / escape-ui-resume | 40.227 / 32.758 | 可見 UI Esc 停控；同對話重讀後只補信箱 |
| lost-fixed / lost-fixed-resume | 25.461 / 12.151 | 寫入後丟回執，未知而非死等；恢復不重寫公司 |
| switch-timed | 40.108 | Finder 前台導致 NOT dispatched；重新觀察後繼續 Safari |
| cn-projection | 33.422 | 真實本機建議與填寫 2/2，無過期錯誤 |
| official | 36.731 | Nora、Lin、nora.lin+sample@example.test，另 20 項原樣 |
| pdf-ui | 23.815 | 儲存一次，無辨識或 shell，四個磁碟欄位正確 |
| vision | 17.323 | 真實 CUA 回傳四欄原文，零修改工具，PDF 雜湊不變 |

視窗五項使用本輪定位修復候選，其中兩輪揭露裝飾節點過期問題，只計定位與最終填寫通過，不計 FORMS 成功。原生修復重建後，以中文、英文對照及最終 PDF 驗證。Esc 使用同一最終原生二進位；之後宿主斷線修復重啟 PID 29316，斷線及後續項目均使用最終宿主。沒有以舊二進位未修復結果充當新實作通過。

斷線透過終止本次隔離原生 worker 製造，發生在真實公司輸入事件後、回執前，不只是關閉 RustDesk。首次 lost 揭露等待問題，保留為修復前失敗。lost-fixed 初始公司已是目標值，但仍記錄一次完整真實寫入及回執丟失；恢復未重寫公司。escape 沒有可見 UI 鍵盤監聽，switch 人工切窗過晚，均列為無效注入嘗試；有效替代為 escape-ui 與 switch-timed。

最終可見 PDF 對話 `ec0548c4-8a0e-4feb-9e29-15e33998d1f0`：公司原已是海风测试，只將工作信箱改為 haifeng+pdf@example.test；帳單 billing-keep@example.test、備註「保留原备注：海风旧稿 001」逐字保留。一次 super+s 後，原生 PDFKit 與獨立磁碟讀回一致。CodeBuddy 完成回覆與 Preview 畫面分別核對。

## 同條件效能對照

兩個新對話採同模型、強度、空公司/工作信箱及相同舊帳單/備註。兩條路徑均填對 2、填錯 0、漏填 0、提交 0。

| 路徑 | Harness 秒 | 服務往返秒 | 未快取輸入 | 快取讀取 | 輸出 token |
|---|---:|---:|---:|---:|---:|
| 原生控制項 | 20.389 | 20.756 | 38,612 | 79,232 | 1,044 |
| 原生 + FORMS | 26.746 | 31.047 | 42,627 | 105,472 | 2,370 |

本例 FORMS 多約 6.36 秒、未快取輸入多約 10.4%，沒有證明整輪提速或省 token。價值是可核查的候選匹配，主模型觀察、投影及判斷仍有成本。這是單次配對，不是延遲分布。

最終 PDF 為 23.815 秒，31,013 / 70,528 / 1,375 token，沒有額外辨識或 shell。初值不同，不能再與之前計算新優化百分比。歷史嚴格同提示詞同初值的 PDF 69.216→25.965 秒及同圖辨識對照保留於前批報告。

## 自動驗證與復用

以下最終有效命令退出碼均為 0：

- Windows/Mac Node 24：`--test runtime/tests/desktop-coordinator.test.mjs runtime/tests/desktop-control.test.mjs runtime/harness/test/computer-skill.test.mjs`，各 38/38。
- Windows Node 24：`--test runtime/tests/session-lifecycle.test.mjs`，19/19。
- Mac `tools/qwen-computer-use`：gofmt、`go test ./...`、`go vet ./...`。
- 既有 `buildMacComputer(root,'arm64',{test:true})`：Go/Swift 合同、真實 CoreML/PDF 8/8、release 建置通過；既有 macOS API 棄用警告保留，沒有建置錯誤。
- `python -X utf8 .local/mac-six-20261119/verify.py`：逐條網頁事件、推薦、中斷恢復、落盤、辨識雜湊與身分斷言通過。腳本最初把官方 HTML ID 寫成 firstName/lastName，按實際 first/last 修正，沒有改產品結果。
- 原始碼清單比較與 `git diff --check` 通過。無 Rust 修改，未執行 Cargo 或安裝包建置。

執行中的預覽：`.local/fluiduse-20261118/launch-preview.command` → 官方 `start-preview.sh`，隔離 profile 為 `.local/fluiduse-20261118/profile`。兩端證據在 `.local/mac-six-20261119/`，包括 summary、verified、sessions、events、identity、原始碼清單、cases.json 及測試日誌。測試案例使用 server.cjs（56958 埠）、官方範例 HTML 及 `/tmp/codebuddy-speed-customer.pdf`，重啟後由 start-server.py 啟動案例服務。

可在 Mac CodeBuddy 輸入：「预览里打开的 codebuddy-speed-customer.pdf 是测试客户表。把公司改成“海风测试”，工作邮箱改为 haifeng+pdf@example.test，其他两栏保持原样。请核对后保存原文件，不提交。」其餘中英文、歧義與恢復提示詞在 cases.json。故障注入只限定本次隔離 worker，不應重放至其他對話。任意新表單、其他 macOS、Windows 全產品驗收及發行安裝包不在本次 PASS 範圍。
