# 配方表單斷線與重連修復

D:\CodeBuddy-v1無Git；修改acpConnection.ts、recipeParamRequests.ts及兩項測試檔，未提交、推送、安裝。Harness執行與完成權威不變。

真實隔離視窗切斷正在填表的單一WebSocket後，後端已結束請求，舊表單仍可見。自動化先紅2失敗/11通過；修復將每個表單綁定所屬連線的AbortController，關閉／重置／恢復及初始化失敗只清理本連線，提交或取消移除監聽，不重放舊提交。

相關四檔40/40、TypeScript及目標ESLint最終exit0；初次AbortSignal lint問題改用AbortController的signal型別解決。真實重測斷線關閉表單，重新執行配方後，會話883f0412-04ba-45a8-a95b-4df839cc7afc準確回覆RECONNECTED標記、零工具、Harness completed/harness_turn。會話31→32，失敗嘗試未持久化。

故障由本機wrapper精確終止填表socket，未改頁面狀態或使用者網路；回執recipe-disconnect-ui-receipt.json、截圖recipe-disconnect-*.png。wrapper已退出，普通預覽runtime3720/desktop12528/exec56226恢復；使用者20048保留，4排程暫停。前兩個預覽Ctrl+C退出1為人工中斷，不算測試通過。後端未改，重用367/367。整機睡眠未實測；系統恢復清理僅單元測試。
