# Mac FORMS 工具往返最佳化與複驗（2026-11-19）

[简体中文](mac-forms-roundtrips-2026-11-19.zh-CN.md) · [English](mac-forms-roundtrips-2026-11-19.en.md)

已實作原生單欄位聚焦寫入、FORMS 文字回執去重，並完成真實 Mac 複驗。最終三組各省兩次工具呼叫，合計輸入 token（含快取）減少 31.19%，工具執行時間減少 33.35%。**整輪平均未明顯加速：Harness 24.489→24.476 秒；包含輪次外等待的 ACP 25.860→28.837 秒，增加 11.51%。不能宣稱全面提速。**

三組最終均目標 2/2、誤填/漏填 0、原帳單信箱及備註保留、提交 0。先前六項範圍見[上一批報告](mac-computer-use-six-acceptance-2026-11-19.zh-TW.md)；本批是受影響鏈路複驗，舊版官方範例網頁證據不是新二進位的重測。

## 原因與實作

先前同條件無/有 FORMS 為 20.389/26.746 秒，但工具總時間只增加約 0.405 秒；兩個投影欄位本地評分約 6.27/1.96 ms。額外模型往返、上下文及輪次外等待才是主要成本。

- 使用者批准 `set_value(focus=true)`：聚焦已觀察欄位後，再核對視窗、身分、舊值、位置、實際焦點、人工輸入版本及租約，才寫入並回讀。逐欄位決策，失敗沒有座標/鍵盤回退；省略參數保留舊行為。詳見[協定](mac-focused-value.zh-TW.md)。
- FORMS 文字去除重複候選、已拆解 selected_option 與重複標籤，完整結構化資料不變；精確值、索引、來源、機率、截斷與錯誤保留。
- 中間英文輪將 local FORMS 誤認為工作區檔案，增加搜尋/glob；技能釐清它是 get_app_state 內建能力。最終沒有這些無關呼叫；使用者測試提示詞未變。
- Preview AXFocused 宣告可寫仍可能回 -25200。最終技能只對網頁優先 focus=true，PDF 沿用直接寫值，沒有執行器自動回退。

改動檔案：`tools/qwen-computer-use/{main.go,form_matching.go,focused_value_test.go}`、`macos/{RuntimeContract.swift,runtime.swift,contract-tests.swift}`、`runtime/harness/skills/computer-use/SKILL.md`、所有權地圖及三語文件。其他 dirty 改動保留。

## 同條件比較

同一 Mac、Safari、夾具/初值，各組前後提示詞完全相同；每輪 request/header 確認 Ollama deepseek-v4.1-flash、high。公司/工作信箱初始空白，帳單 billing-keep@example.test，備註「旧备注逐字保留 731：先核对，后提交。」。使用執行中 CodeBuddy ACP 對話與真實原生工具，RustDesk 檢查畫面；Esc/PDF 另由可見 CodeBuddy 對話發起。

| 提示詞 | Harness 秒，前→最終 | ACP 秒 | 工具次數 | 未快取輸入 | 快取讀取 | 輸出 |
|---|---:|---:|---:|---:|---:|---:|
| 中文明確欄位 | 27.780→38.655 | 28.181→48.827 | 9→7 | 43,543→24,842 | 104,192→77,952 | 1,390→1,175 |
| 英文 | 23.157→15.585 | 24.583→18.063 | 8→6 | 31,535→25,546 | 89,088→55,168 | 952→869 |
| 中文口語 | 22.530→19.187 | 24.816→19.621 | 9→7 | 43,659→24,292 | 99,328→75,264 | 1,700→1,641 |

總工具 26→20、回執字元 -19.60%、未快取輸入 -37.10%、快取 -28.78%、輸出 -8.83%。合計輸入不等於帳單金額。三個提示詞各一次配對，不代表統計顯著或穩定分布。

中文最終工具僅 2.448 秒，模型步驟間出現 7.852/10.869 秒長等待，ACP 比 Harness 多 10.172 秒；不能據此判定供應商內部原因。英文與口語較快，中文抵消總收益，慢記錄保留。中文投影後兩項推薦成功；英文 Work email 仍 skip，由主模型依明確指令填入，不算 FORMS 兩項成功。

本地 `.local/mac-forms-speed2-20261119/` 保存 cases/summary/metrics、sessions、事件與 verified.json。最終會話：`820b5654-d559-4f2e-a45a-a3ed55ebb542`、`e7ae4fcb-10be-4b8c-a01c-abdff649d02c`、`6be5ebfe-705e-4649-bf2c-fd67964137cf`。

## 保護與 PDF

- 聚焦觸發彈窗後原生復核停止，沒有寫公司/信箱，彈窗舊值保留；操作員於整輪結束後才關閉。
- 同名「邮箱」只填公司，兩個信箱及備註不變並說明歧義。
- 公司實際寫入後終止綁定的測試原生 worker，造成回執未知：DESKTOP_STOPPED，未寫工作信箱；同會話恢復先重讀，只補工作信箱，不重寫公司。
- 可見對話中實際按 Esc，中斷到下一輪恢復沒有 input 事件；恢復重讀後只補信箱，REF-KEEP-721 等原值保留、提交 0。
- 可見對話 PDF 最終一次直接 set_value、一次儲存；獨立 PDFKit 讀回工作信箱 haifeng+verified@example.test，其餘三欄正確保留，可見畫面亦核對。

斷線測的是原生 worker 在寫入/回執間終止，不泛化為 RustDesk 或任意網路中斷。保護案例與最終比較使用同一原生二進位，最後技能只調整 PDF 選擇。

PDF 最終會話 `f46940ba-512f-4d8e-9d57-d6aa31a537e7` 為 52.687 秒、11 次工具，仍有不完整視窗選擇器拒絕、一次識圖與儲存後額外觀察。**功能/落盤通過，不計為 PDF 提速成功。** 磁碟讀取約 0.811 ms 不是整輪耗時。第一次 PDF 聚焦失敗後被操作員 Esc 中斷未儲存，失敗記錄保留。中間三組 26.792/36.980/23.195 秒也不刪除。

## 來源與驗證

Windows `D:\CodeBuddy-v1`，main@4c8afad978b6e893a3545c0859dd5b4824a91223 加未提交改動；Mac `/Users/erjinyi/Desktop/work/CodeBuddy-v1`，HEAD 732113504de3601ab087a609ce20827b814db2c2 加 Windows 目前來源覆蓋層，以正規化換行雜湊清單核對。

執行 PID 31533，2026-11-19T04:01:06.499Z 啟動，source/current 同為 677e55481e4fa4e3a796f2720f7e8e76752d3073c7c28b4a4e5290ba9032a810，無需重啟。另記原生 SHA fad15ef85ce0d3eda9d55834bff34ad3cacb233ebaf8ab52ba8cd692326dda29、最終技能 SHA 43d56e37f49d44e16ddc7b61504213f1f2efe0c479d8c920e8277564744b0d6d，因執行時雜湊不涵蓋全部原生/技能內容。

有效命令均退出 0：兩端 Node24 `--test runtime/harness/test/computer-skill.test.mjs runtime/tests/desktop-coordinator.test.mjs runtime/tests/desktop-control.test.mjs` 各38/38，最終技能各4/4；Mac go test ./...、go vet ./... 與 gofmt；既有 build.cjs 包裝 buildMacComputer 的 Swift 合同、真實 CoreML/PDF8/8、production 構建；verify.py 九輪事件/同模型強度/保護/磁碟斷言；相關 git diff --check。有既有 activateIgnoringOtherApps 棄用警告。未改 Rust，未跑 Cargo/Clippy，未做 Windows 產品 E2E。

交付為執行中的 Mac 原始碼預覽，未製作 DMG、未提交/推送、無新依賴。取證後關閉測試服務/頁面，保留預覽和證據。剩餘瓶頸是模型/輪次外等待及少量冗餘觀察，沒有降低思考強度或移除安全檢查來換速度。
