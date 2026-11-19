# Mac 文件修改狀態實驗：已撤回

[简体中文](macos-document-state.zh-CN.md) · [English](macos-document-state.en.md)

2026-11-19 的實驗沒有進入交付版本。本機 Preview 不支援視窗級 `AXEdited`；改讀該視窗自己的關閉按鈕後，填寫前、填寫後和儲存後均為 `false`，無法證明本次 PDF 欄位是否存在未儲存修改。原生原始碼與執行中的模組均已恢復實驗前版本。

原擬採用 true = 應用程式回報有未儲存修改、false = 回報沒有、unknown = 缺失、讀取失敗或類型錯誤。這些是實驗語義，不是已交付的產品合同。false 不能獨立證明磁碟內容、同步、內容正確或儲存授權。

實驗參考 [Apple AXEdited 屬性](https://developer.apple.com/documentation/applicationservices/kaxeditedattribute?language=objc)，僅接受 CFBoolean，原生合同測試通過。但實際應用沒有回傳所需狀態變化，因此編譯與單元測試不能代替產品驗收。

視窗級試驗 `after-pdf-1` 為 39.156 秒、103,595 輸入 token；關閉按鈕試驗 `after-pdf-2` 為 82.184 秒、371,010 輸入 token，主模型額外查找磁碟檔案。PDF 最終內容正確，但效能目標未通過。證據位於本機 `.local/mac-speed-20261119/`。輸入 token 包含快取讀取，不能當作計費金額。提示詞去重結果見本批效能報告。
