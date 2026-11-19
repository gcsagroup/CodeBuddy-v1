# Mac 目前 PDF 的唯讀落盤核對

[简体中文](mac-pdf-disk-observation.zh-CN.md) · [English](mac-pdf-disk-observation.en.md)

原生觀察與動作後的新回執增加可選的 `pdf_document`，並以 `PDF disk fields` 顯示。它只讀取目前已匹配視窗的 AXDocument 指定之本機 `file:` PDF。模型不能提供另一個路徑，不搜尋或寫入檔案，不自動儲存、提交；舊呼叫相容。

`status=read` 表示 PDFKit 成功解析穩定的磁碟快照。`fields` 保留每個 widget 的 `page`、`annotation`、`name`、`value`，不合併重複名稱，空字串與未知 `null` 分開。磁碟欄位與 AX 介面欄位分開，儲存前可以不同。使用者授權儲存後，主模型比較目標值與保留值，使用該動作的新回執核對，不必為相同事實另做辨識或 shell 讀取。

原生層核對讀取前後以及目前路徑的裝置、inode、長度、修改與變更時間；修改、替換檔案或視窗換文件時拒絕舊結果。無法開啟、損壞、加鎖或超限時回傳 `status=unavailable` 與原因，不帶舊欄位，也不阻斷一般觀察。沒有本機 PDF URL 時不回傳此欄位。

限制為 16 MiB、100 頁、256 個 widget、32 KiB 欄位文字；不將截斷資料回報為成功。回執包含大小、修改時間及讀取耗時，只證明當時的磁碟欄位，不證明雲端同步、視覺呈現或整項任務完成。

採用系統 [PDFKit widgetStringValue](https://developer.apple.com/documentation/pdfkit/pdfannotation/widgetstringvalue)，沒有新增相依套件；不恢復[舊 AXEdited 實驗](macos-document-state.zh-TW.md)的不可靠布林判斷。
