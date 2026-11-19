# Mac 單欄聚焦寫入

[简体中文](mac-focused-value.zh-CN.md) · [English](mac-focused-value.en.md)

`set_value` 新增選用布林參數 `focus`，僅 Mac 提供。使用者於 2026-11-19 批准：主模型仍選擇已觀察的欄位和值，focus=true 在一次原生呼叫中聚焦後寫入，省去獨立 click 與一次模型往返。不是批次填表，也不自動選擇其他欄位。

原生層先檢查視窗、欄位綁定、租約與值可寫性；需要時以 AXFocused 聚焦；之後重新核對視窗、原控制項身分/舊值/位置、實際焦點及人工輸入版本，才寫入並產生新回執。聚焦可能觸發應用事件，故不可省略第二次檢查。失敗即停止，不猜座標、不回退鍵盤、不重放；聚焦已派發時，失敗仍可能有副作用。

省略或 false 保留舊行為：網頁欄位必須已獲核實焦點，原生 PDF 沿用既有寫入規則。Windows 不公布或接受此參數。沒有新持久化狀態，Esc、排隊、斷線及恢復語義不變。

網頁欄位優先使用 `focus=true`；Preview PDF 等原生文件欄位省略 `focus`。實測 Preview 即使宣告 AXFocused 可寫，仍可能回傳 AX 錯誤 -25200，因此不為直接寫值增加不必要的聚焦步驟。

採用系統 [AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue) 與 [焦點屬性](https://developer.apple.com/documentation/applicationservices/carbon_accessibility/attributes)，復用身分、前台、輸入版本與租約檢查，不新增相依套件。click→模型→set_value 仍可用；未採用整表自動執行，避免略過逐欄判斷與中斷觀察。

FORMS 仍只提供建議。文字回執不重複候選資料及已拆解的 selected_option，完整結構化評分保留；精確建議值、目前值、標籤來源、機率與截斷警告仍可見。本機評分時間不等於整輪時間。
