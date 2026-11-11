# 非同步刪除對話

2026-11-10 使用者核准：確認刪除只等待檢查與小型刪除記錄落盤，隨即關閉確認框並移除對話。MCP 釋放、關聯自動任務停用、失敗訊息日誌清理及完整狀態整理在背景繼續；工作區檔案保留。

Store 持有刪除事實，`session-deletions/<SHA256(sessionId)>.json` 只保存產品與原生 ID、接受時間。讀取與後續提交屏蔽已刪除資料；落盤失敗則保留對話。執行中的任務仍拒絕刪除。背景失敗保留記錄並退避重試，重啟續做；清理及狀態刷盤完成才移除記錄。已接受的刪除不因資源清理失敗撤銷，錯誤保留於執行日誌。

舊 profile 無需版本遷移；降級至不識別刪除記錄的版本前必須先完成背景清理，以免舊版展示舊快照。保留專案檔案，不擴大為清除全部原生歸檔。未新增雲端服務或依賴。

參考 [Microsoft 非同步請求模式](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply) 與 [AWS Outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) 的持久受理與冪等恢復原則，未複製外部程式碼。ACP 成功表示邏輯刪除已提交，不要求資源回收已完成。
