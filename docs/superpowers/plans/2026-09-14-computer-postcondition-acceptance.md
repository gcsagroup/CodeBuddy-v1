# 電腦動作後置條件驗收

日期：2026-09-14。本文為繁體預設版本；另有[簡體中文](2026-09-14-computer-postcondition-acceptance.zh-CN.md)與[English](2026-09-14-computer-postcondition-acceptance.en.md)。

## 結論

舊紀錄的 unknown 是驗收條件不足，並非已確認的產品誤判。當時只要求 foreground:true，而視窗在點擊前已位於前景；頁面改變不能證明該條件由點擊達成。本輪沒有修改產品程式碼或成功判定門檻，原始證據保留。

在隔離 Electron 視窗 83169794（PID 19340）透過真實 ACP 電腦工具點擊歷史記錄，指定已觀察到的精確可見 button「导入链接」為後置條件：首次出現回傳 worked；原本已存在且沒有可歸因變化時回傳 unknown；指定不存在的按鈕回傳 unknown 與逾時原因。獨立原生視窗樹核對了實際頁面。

44.279 秒後使用舊觀察時，工具在輸入前拒絕並要求重新觀察；更新觀察後，舊截圖識別碼已被清理，仍不能使用。這兩筆是預期保護結果，不是測試失敗。

## 證據與邊界

證據根目錄為 .cargo/evidence/audit-fixes-20260914/。computer-postcondition-native-summary.json 彙整 call-09、16、20、24、28、31；computer-\*-native.txt 保存獨立原生觀察。既有電腦模組測試 126 通過、0 失敗、0 忽略，命令與退出碼見 computer-postcondition-tests.json。

只證明指定頁面目標轉換，工具派發完成不等於結果已確認，更不等於整個任務完成。沒有發送模型提示，沒有探測 120 或 107；真實模型自主閉環仍待驗。鼠標約束、同類失敗重試及等待恢復仍在後續審計範圍。
