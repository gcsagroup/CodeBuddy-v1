# 電腦操作方式約束

狀態：本切片自動化、Clippy、後端重建和隔離原生場景通過。真實模型理解與自主完整流程為 NOT_RUN。

2026-09-15 已核對 [OpenAI computer use 官方指南](https://developers.openai.com/api/docs/guides/tools-computer-use)：執行環境負責保留狀態及套用限制，螢幕與工具文字不能授權。採用宿主執行檢查與真實結果驗證；不引入範例的指令碼執行路徑，因為使用者明確禁止指令碼。不推測 Codex 私有實作，不複製外部程式碼或增加相依套件。

## 行為與邊界

沿用現有 unified turn 原目標及 continuation 關係，儲存 computer_operation_method。必須使用電腦控制保留註冊電腦鍵盤操作；只用滑鼠僅允許滑鼠動作、必要聚焦、停止及觀察。兩者保留宿主已分類的唯讀工具，禁止直接檔案修改、shell、程式碼執行與委派繞過。模型工具展示與實際派送共用判斷；巢狀呼叫繼承限制。應用程式工具目錄仍是目錄，不代表目前任務可執行。現有審批與電腦防護保持生效，手動批准不能解除方式約束。

只處理明確、有限的使用者措辭，例如「必須使用電腦控制」「只用滑鼠」以及實作明列的「继续，但必须只用鼠标」「继续，解除操作方式限制」。不從工具輸出建立或解除限制，也不把包含這些字句的任意長句一律視為續接。

續接保留原目標與方式；可見使用者的明確綁定修改僅原子更新方式欄位，核對會話、原目標和執行輪次，保留其他狀態。服務不可用時也儲存明確綁定的改變或解除，恢復後使用新狀態。新的 unified 目標重設方式；已接受的新 SimpleChange/Test/Change 目標解除舊方式，澄清路由不提前解除。舊訊息沒有 ID 時，普通續接仍保留方式。讀取或解析已有方式失敗時禁止推斷授權。

## 自動化證據

有效 RED 是公開入口實際把隔離檔案 original 改成 guarded。測試預算不足為測試夾具錯誤；實作期間的續接狀態遺失及 Platform developer 讀取誤隱藏均保留失敗證據。兩個舊後端建置被主動中斷，均未完成，不計通過或測試失敗。

最終凍結原始碼：方式測試 8 通過、SimpleChange 39 通過、preflight 13 通過、unified 10 通過；fmt、Clippy、後端建置 exit 0。前一實作檢查點的 ExtensionManager 65、tool_task 33、analysis 1、ACP 59+55 通過；工具上下文錯誤篩選器匹配 0 項記 NOT_RUN，改用真實測試模組後 12 通過。篩選器存在重疊，不合計獨立測試總數。

公開入口測試使用腳本化 provider 驗證拒絕、服務失敗期間解除及重新限制、恢復後的真實檔案內容。新目標解除由宿主路由測試覆蓋；原子更新測試覆蓋晚到輪次、舊目標和其他會話拒絕，工具文字和巢狀派送不能繞過。測試夾具不證明真實模型理解。

證據目錄：.cargo/evidence/audit-fixes-20260914/。method-final-gates.json 儲存每條命令、cwd、時間、exit code；method-source-frozen.json 與 method-frozen-verification.json 核對 7 個原始碼檔案。最終二進位 SHA256：E865D59C515942E2244A3B31D996F71A509591A7DDDF809052453E801FD3256E。

## 隔離原生驗收

真實 Electron 視窗及本次 goose.exe，以獨立 CodePro 持久狀態夾具執行實際 ACP 工具呼叫。read_document 回傳 original；鍵盤、輸入和直接寫入在審批前回傳方式特定的 policy_denied，焦點與介面文字未變，實際檔案保持 original。未限定名稱的 write 拒絕回執沿用 unknown::tool 稽核哨兵，原請求及拒絕原因保留在證據中。

第一次滑鼠呼叫被既有「桌面觀察過期」防護拒絕，未輸入；更新觀察後點擊歷史記錄，回執 worked，真實介面新出現「导入链接」按鈕。該次拒絕屬於已修正的驗收前置狀態，不是產品回歸。隨後釋放 ACP 會話，在真實介面載入並重新整理原任務；原目標、mouse_only 狀態及抽查的另一會話狀態保持不變。自有視窗和後端已關閉。

詳見 method-native-summary.json、method-native-call-02/03/04/05/09/13.json、method-native-mouse-result.png、method-native-reloaded.png。本輪沒有真實模型的新目標解除原生流程；此項證據來自自動化。模型為隔離 fixture-preserved，未探測停用的 120 或替換為 107。
