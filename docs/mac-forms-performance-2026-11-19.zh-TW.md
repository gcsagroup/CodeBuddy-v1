# Mac FORMS 中文接入與 PDF 效能複驗（2026-11-19）

[简体中文](mac-forms-performance-2026-11-19.zh-CN.md) · [English](mac-forms-performance-2026-11-19.en.md)

後續狀態：視窗定位、接管與斷線問題已於[六項交付驗收](mac-computer-use-six-acceptance-2026-11-19.zh-TW.md)修復並複測。本頁保留當時候選與失敗紀錄，不作為最新完成狀態。

已實作並實測：綁定觀察的英文評分標籤、原生 PDF 唯讀落盤回執，以及精簡截圖辨識。相同提示詞、初始欄位值、主模型與思考強度的 PDF 對照，由 69.216 秒降至 25.965 秒。這是本批範圍內的驗收，不代表 Mac 全功能或歷史六項工作全部重測。

## 來源與執行版本

Windows 位於 `D:\CodeBuddy-v1`，`main@4c8afad978b6e893a3545c0859dd5b4824a91223`，保留既有及本批未提交修改；未建立分支、提交或推送。Mac 位於 `/Users/erjinyi/Desktop/work/CodeBuddy-v1`，Git HEAD 仍為 `732113504de3601ab087a609ce20827b814db2c2`，不能宣稱整個 checkout 相同；相關目前原始碼另以雜湊核對。

最終程序 PID 26736，啟動時間 `2026-11-19T02:05:52.141Z`，source/current hash：`d4fb5daa8fa4ca024beaae6406d397569bcab305127fb8f68cedc7da1f977811`。原生 SHA-256：`1e7be4114091ce6e852bbb6c5f7fcf12cb3fce5e0c0c9c895836ba889571a881`。交付為可執行原始碼預覽，沒有新 DMG。主模型固定 Ollama `deepseek-v4.1-flash`、高思考強度；辨識為 `CUA-S1-Qwen3.5-4B`；FORMS 使用本機 CoreML。

## 根因與實作

116 個真實模型消融案例確認：中文欄位、資料鍵及表單標題可能導致 skip；英文 `Work email` 也可能失敗，`Email` 則能匹配；原有內容另會影響結果。這符合上游有限詞彙的[模型說明](https://github.com/trycua/cua/blob/main/libs/cua-s1/MODEL_CARD.md)及[概念定義](https://github.com/trycua/cua/blob/main/libs/cua-s1/python/src/cua_s1/concepts.py)。

- 使用者批准的可選 `form_labels`：主模型提供英文評分標籤，Go 綁定實際觀察，Swift 核對視窗、位置、控件、附近標籤及舊值後才推理。原始中文值不改寫、不清空；未映射欄位不評分；舊呼叫相容。詳見[協議](mac-form-label-projection.zh-TW.md)。
- 自訂識圖連線 ID 曾漏掉 CUA 的停用 thinking 設定；現按相同端點與模型判定，只影響唯讀截圖觀察器，不改主模型。
- 原生回執補充 AXDocument、確認的前景視窗，省略 AX 樹重複空屬性，保留索引及有效證據。
- 另經使用者批准的 [PDF 磁碟回執](mac-pdf-disk-observation.zh-TW.md)只讀目前視窗 AXDocument 指定的 PDF，區分介面未儲存值與磁碟值，拒絕不穩定或不可讀結果，不自動儲存或提交，沒有新增相依套件。

修改範圍包括 providers、vision-routing、桌面技能、Go 觀察與表單匹配、原生 runtime/contract/FormMatching、新增 PDFDiskObservation、Package 來源清單、回歸測試及所有權文件。

## 最終候選結果

耗時使用 Harness turn 起訖。輸入拆分未快取與快取讀取，不將合計當成費用。ACP 案例使用執行中的 Mac CodeBuddy 與真實桌面；PDF 對照由可見 CodeBuddy 對話發起。

| 場景 | 秒 | 未快取輸入／快取讀取／輸出 token | 結果 |
|---|---:|---:|---|
| PDF 雙欄還原對照初值 | 22.172 | 35,380 / 67,328 / 1,288 | 磁碟正確，儲存一次，無識圖/shell |
| 可見對話，相同 PDF 指令 | 25.965 | 26,739 / 75,776 / 1,535 | 2/2，另兩欄保留，儲存一次，無識圖/shell |
| 英文指令，只改工作信箱 | 23.618 | 40,302 / 82,432 / 1,534 | 一欄正確，另三欄保留 |
| 明確要求截圖抄錄 | 23.736 | 17,125 / 28,288 / 521 | 四欄正確，沒有輸入 |
| 中文網頁表單 | 23.665 | 47,106 / 133,888 / 2,053 | FORMS 推薦與寫入 2/2，舊值保留，提交 0 |
| 英文網頁表單 | 22.148 | 31,150 / 89,728 / 1,039 | 2/2，舊值保留，提交 0 |
| 泛稱目前表單，兩個同名信箱 | 47.527 | 33,235 / 112,640 / 3,783 | 只改公司，兩信箱和備註保留，提交 0；過期 FORMS 投影被拒絕 |
| PDF 唯讀檢查 | 10.990 | 15,786 / 29,184 / 428 | 無輸入工具，檔案雜湊不變 |
| 精確目標視窗不存在 | 13.655 | 16,081 / 26,112 / 865 | 無輸入工具，檔案雜湊不變 |

舊 PDF 對照為 69.216 秒，58,387 未快取／128,384 快取／2,885 輸出 token，12 次工具呼叫；新輪次 8 次。此配對耗時減少約 62.5%、未快取輸入減少約 54.2%、輸出減少約 46.8%。僅為一次配對；模型工具選擇、快取與服務延遲仍會波動。原生讀取約 0.75–2.02 ms。

同圖 CUA 對照：精簡前 18.087 秒、132 輸出 token；精簡後 9.164／9.129 秒、各 34 token，欄位一致。最終四欄真機辨識為 11.167 秒、51 token。沒有降低解析度或截斷欄位原文。

中文推薦 Company→海風測試原值「海风测试」、Email→qa@example.test，機率約 0.999447／0.999953，每欄約 2–4 ms。網頁每筆事件皆核對帳單、備註與零提交；PDF 另由 PDFKit 讀取磁碟核實。

## 保留失敗與驗證界線

最終 15 個相關原始碼雜湊與 Windows 目前工作區一致。`python -X utf8 .local/mac-deep-20261119/verify-v2.py` 退出碼 0，涵蓋來源身分、三組最終網頁每筆事件、三輪 PDF 儲存回執與獨立磁碟值、配對初始及最終值、唯讀雜湊與四欄辨識。網頁最終可見值另經 RustDesk 核對；證據見 `verified-v2.json`、`pdf-disk-*` 及 `disk-readonly-*`。

最終泛稱歧義會話 `9bad3e49-959f-45b4-b155-f3d34167438d` 成功定位，只改公司。原生驗證拒絕過期 FORMS 投影；主模型保留兩格歧義信箱並解釋未填原因。這是保守降級通過，不是 FORMS 評分成功；一次定位成功也不能證明早先定位機制缺陷已修復。

早先會話 `b9341ef2-8b54-4a4d-a375-c6d578ac1356` 將泛稱「客戶表」誤作完整視窗標題，未能定位，沒有寫入。明確指定標題後，同名信箱案例成功只改公司、保留兩個信箱與備註；不能把它當成早先語義定位問題已修復。已有值時 FORMS 仍可合理 skip，主模型負責明確授權的修改語義。

有效最終命令退出碼皆為 0：Windows/Mac Node 24 識圖測試各 20/20；provider 46/46；computer-skill 4/4；Mac `go test ./...`、`go vet ./...`；既有 `buildMacComputer(root,'arm64',{test:true})` 包含原生合同、Swift/CoreML/PDF 8/8 及 release 構建；證據斷言與 `git diff --check`。Windows Python 預設編碼曾讀取 UTF-8 JSON 失敗，使用 `python -X utf8` 後通過，屬證據讀取環境問題。

證據位於 `.local/mac-deep-20261119/`：來源與程序身分、原始會話、彙總、網頁事件、PDF 前後值、唯讀雜湊、消融及測試日誌。未發布安裝包，未重跑完整 Windows 產品 E2E 或全部接管／斷線場景；中間版本與失敗記錄均保留。
