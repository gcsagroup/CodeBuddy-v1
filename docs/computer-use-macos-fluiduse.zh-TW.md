# Mac 本機表單匹配

同日後續效能批次更新了 Mac 原生賦值焦點檢查及開發產物；下方舊記錄保留為歷史結果。現行產物身份、25 回合多提示詞結果和未達成的效能目標見 [Mac 效能驗收](mac-performance-2026-11-18.zh-TW.md)。

宿主統一轉換控件樹與 FORMS 建議的 `element_index`，確保兩者指向同次觀察的同一控件。建議無法綁定真實控件時降級為 `unavailable` 並清空建議，不保留可能指向別處的編號。

Mac 預設 `view=fields`，使用原生控件索引和回讀，不套用 Windows 寫入權杖。原始回執保留截圖；主模型僅在需要視覺資訊時明確請求 `view=full`，進入既有 CUA 識圖路徑。動作後回到控件觀察。

[简体中文](computer-use-macos-fluiduse.zh-CN.md) · [English](computer-use-macos-fluiduse.en.md)

Mac 的 `get_app_state` 可傳入 `form_entities`，每筆包含使用者提供的 `label` 和 `value`。現有 Swift helper 讀取真實 Accessibility 控件，透過 FluidUse FormSchema 和 FluidAudio CUA-S1-FORMS 本機評分，回傳欄位索引、原值、建議值、評分、截斷資訊和耗時。主模型決定動作，既有原生工具執行並回讀。

建議不授權覆寫草稿或提交。遇到同名欄位、未知欄位或跳過建議，主模型須結合任務判斷。中文資料探測中的公司、工作郵箱等欄位皆建議跳過，目前沒有中文匹配準確率提升證據。

PDF 控件沒有自身名稱時，評分層使用 FluidUse 的 `nearbyLabel`，從本次觀察的靜態文字及幾何位置取得候選標籤。`matching_label` 與 `label_source=nearby_text_candidate` 標明來源；原始名稱、索引及輸入身分不變。主模型仍須核對周圍文字，不把候選標籤視為系統確認的名稱。

依賴準備須先取得下載授權。FluidUse 固定在 `b51f7adfbade197f0a9c802e34ba8a98cd4ecbc9`，FluidAudio 固定為 `0.15.8`，代碼皆為 Apache-2.0。

沒有可編輯控件時回傳 `status=no_fields`、`execution=not_run`，不載入模型或宣稱已評分。實際評分才回傳 `scored`；快取缺失等錯誤回傳 `unavailable`，保留視窗觀察。

Preview 的 Accessibility 標題可能包含頁數，與截圖介面標題不同。原生映射核對程序及幾何，使用標題消除歧義；標題不同只接受唯一幾何匹配，讀取控件樹時另驗證反向映射。重疊視窗無法區分時拒絕輸入，不建立頁數後綴或應用名稱特例。參考 [Apple kAXTitleAttribute](https://developer.apple.com/documentation/applicationservices/kaxtitleattribute)。

```bash
cd tools/qwen-computer-use/macos
swift package --disable-keychain resolve
cd ../../..
corepack pnpm --dir ui/desktop run test:macos-native
node scripts/prepare-harness-macos-tools.cjs --arch arm64
runtime/tools/bin/qwen-computer-runtime --prepare-forms
bash ./start-preview.sh
```

`--disable-keychain` 只略過公開依賴的鑰匙圈憑據查詢。正常構建使用已解析依賴。`--prepare-forms` 顯式下載模型到 FluidAudio 使用者快取；普通觀察只讀本機模型，缺失時回報不可用並保留控件觀察。

驗收從同批 Mac CodeBuddy 對話發起，固定 Ollama DeepSeek 及思考強度。每輪恢復初值，驗證公司和工作郵箱 2/2 正確、帳單郵箱和備註逐字保留、提交計數 0。同名「郵箱」無法區分時保留原值。記錄 FORMS 建議、主模型選擇及回讀，並驗證 Preview PDF、切窗、接管、Esc、斷線恢復。SSH 權限診斷與應用子進程實測分別記錄；產品通過狀態以同批實機記錄為準。

## 2026-11-18 實機驗收記錄

Windows `D:\CodeBuddy-v1` 的 `main@4c8afad978b6e893a3545c0859dd5b4824a91223` 與未提交原始碼已同步到 Mac 既有工作區，2439 個檔案的換行正規化 SHA-256 一致。Mac Git HEAD 未切換，以檔案清單確認建置來源。未提交、未推送。使用 `start-preview.sh` 開發執行版驗收，未製作或替換安裝套件。

最終產物 SHA-256：`qwen-computer-use=05679fcdf6dac2a887da375b1d6781dd56aa39cfc279d459cd75ab97ddb05316`；`qwen-computer-runtime=dcd8867a193f1ee49d2e28ffc71c1888fd52bcca8b95634d9a2961283b69ab4d`。主任務實際使用 Ollama `deepseek-v4.1-flash/high`；標題生成使用獨立 `off` 請求。整窗視覺觀察實際呼叫 `CUA-S1-Qwen3.5-4B` API。

| 場景 | 結果 |
| --- | --- |
| 英文舊路徑 / FORMS 對照 | 相同初值、模型、思考強度；兩者填對 2/2、填錯 0、漏填 0，保留帳單信箱與備註，提交 0；33.024 秒 / 29.380 秒 |
| 本地推理 | Company 建議 `Northwind Studio` 並被採納；Work email 建議跳過，由主模型依指令填寫；最終對話 6 份評分回執的編號均與各自控制項樹對應 |
| Preview PDF | 真實 CodeBuddy 對話發起，兩欄正確、舊值保留；儲存後以 PDFKit 讀回磁碟四欄 |
| Esc | 阻斷後續操作；新訊息重新觀察，只補填信箱並儲存，不重寫公司 |
| Worker 斷線 | 定向結束測試 worker 後暫停、不重放；新訊息重新觀察後繼續 |
| 人工切窗 | 舊觀察的輸入未派發；取得新狀態並重新聚焦後才輸入 |
| 中文網頁 | 公司與工作信箱 2/2 正確；帳單信箱、備註全程保留，提交 0 |
| 同名信箱 | 只填公司；兩個信箱和備註保留，明確說明工作信箱未填，提交 0 |

Mac Go `test ./...`、`vet ./...`、native contract、4 個真實 CoreML 測試、24 個 Mac 建置/封裝測試、12 個 Harness 技能/視覺路由測試通過。最終證據核對 16 項通過，涵蓋原始碼清單、表單事件、PDF 磁碟值、中斷後工具呼叫與編號一致性。回執及日誌位於本地 `.local/fluiduse-20261118/`，不提交。

限制：中文欄位的 FORMS 建議仍全部為跳過，正確填寫由主模型語義判斷完成，不能宣稱中文準確率提升；單組英文對照不能證明穩定加速。驗收僅涵蓋本批夾具、目前 Mac 與建置，不代表任意應用均成功。

## 2026-11-18 補項與六項驗收

先前紀錄未涵蓋上游 Plan 預覽、未知欄位、彈窗與完整寫入後遺失回執，不能據此宣稱全部完成。補測結果如下。

| 約定項目 | 結果 |
| --- | --- |
| 1. Mac 基線 | 通過。arm64、macOS 27.0.1、Swift 6.4.2；實際子程序讀取視窗、欄位、目前值。鎖定版本 FluidUse Demo 載入模型，Plan only 觀察 25 個元素、評分 24 個、產生 19 項 planned，未執行或提交 |
| 2. 本機匹配 | 通過接入與行為驗收。CoreML 建議索引與真實控制項相符；中文由主模型判斷，同名郵箱保留。未知參考代碼保留 REF-KEEP-721，不存在的客戶等級明確報告未填，兩個有對應欄位的目標 2/2 正確 |
| 3. 對話到原生輸入 | 通過。從 Mac CodeBuddy 發起，以 Ollama DeepSeek/high 執行；原生回讀、可見結果與網頁事件一致，Preview PDF 已核對控制項與磁碟值 |
| 4. 草稿與中斷 | 通過。保留舊值、切窗、Esc 與彈窗均有實測；彈窗期間不輸入文字。公司完整寫入後斷開 native worker，報告結果未知並停止；新訊息先觀察，只補郵箱，不重寫公司 |
| 5. 網頁與原生應用 | 通過。上游樣例只附加被動事件記錄，從 CodeBuddy 操作外部 Safari 填對姓名與郵箱 3/3，其餘 20 項保持初值、提交 0；Preview 中文 PDF 已跑通 |
| 6. 對照與交付 | 通過約定測量。同初值、同主模型/high，舊路徑 33.024 秒、FORMS 路徑 29.380 秒；均 2/2、錯 0、漏 0、提交 0。保留開發預覽版、夾具產生器、指令和證據，未製作安裝包 |

補測發現成功回執遺失時，主模型曾將已寫入的公司誤報為「未寫入」。`runtime/desktop-coordinator.mjs` 現在明確將執行後暫停報告為結果未知，操作前值只代表歷史觀察；不變更權限、狀態機或原生二進位檔。`node --test runtime/tests/desktop-coordinator.test.mjs` 在 Windows/Mac 均 31/31、退出碼 0。重啟後第 6 輪正確報告未知，第 7 輪先觀察並只補郵箱，最後 2/2、舊值保留、提交 0。

證據位於 `.local/fluiduse-20261118/supplement/`：198 條 `session-evidence.json`、`events.jsonl`、`lost-receipt-fault.json`、11 項通過的 `checks.json`、`upstream-plan.log`、`model-invocations.json`、`build-identity.json`。第 4 輪部分寫入與第 5 輪修復前誤報保留但排除於通過結論。最終執行時來源雜湊 `8372b5a78bf1a0140ff9f455113cdbf22defcc1f47f71aea3ed5e40fa11aa44e`，不需要重啟；原生產物雜湊與上文相同。未受報告修復影響的原生、匹配與正常流程證據重用；中斷及恢復採用修復後實測。

上游 Plan 曾將網站推薦到留言、將提交按鈕推薦為 click；Plan only 且不允許提交，未執行這些建議。這不代表所有建議正確，仍須主模型核對，亦無中文匹配改善或穩定加速證據。
