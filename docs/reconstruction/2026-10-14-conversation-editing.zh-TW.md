# 會話編輯、重試與分叉

原始碼為 `D:\CodeBuddy-v1` 目前檔案，身分見 [source-baseline.json](source-baseline.json)。renderer 維持原樣，本批未安裝相依項、提交或推送。實作檔案為 `runtime/conversation-driver.mjs`、`runtime/conversation-editing.mjs` 與 Harness driver 的 fork 薄配接。

原 `chatSessionController.ts` 的普通 retry 在目前會話追加原使用者請求，不呼叫 truncate。edit 呼叫 `_goose/unstable/session/conversation/truncate`，接著傳送編輯內容。普通 fork 使用 `session/fork` 與可選 `_meta.conversationBefore`；CodePro 的原 UI 已禁止 fork。繼續執行與重新驗證仍由 CodePro 的結構化控制面負責。

固定官方 Harness `0.2.1-alpha.2` 提供 `sessionController.fork({sessionId,atSeq})`，依精確事件前綴建立新 native session，並封閉開放 turn；其 Session 是追加日誌，沒有原地 truncate API。本實作選擇官方 fork，不直接修改 JSONL 或另建模型迴圈。專案為 MIT developer preview，繼續鎖定目前版本。[官方儲存庫](https://github.com/deepseek-ai/deepseek-harness)

## 接入合約

```js
const driver = createConversationDriver(rawDriver, store);
const editing = new ConversationEditing(store, driver, {
  isActive: id => active.has(id),
  beforeTruncate: async session => { /* 呼叫 CodePro owner 的取消介面 */ },
  onChanged: id => initialized.delete(id),
});
await editing.request(method, params);
```

- server 需先包裝 driver；延遲載入入口增加 `fork` 與 `history`，其他原 driver 方法繼續透傳。prompt 必須傳原 UI `userId` 為 `requestId`；steer 同樣維持真實訊息 ID。
- fork 回傳新產品 `{sessionId}`；truncate 回傳 `{}`。編輯在一次 product store 提交中更新可見訊息、usage 與 `nativeSessionId`，產品會話 ID 不變。舊 native 日誌與 `conversationEdits` 遷移記錄保留；沒有檔案回滾。
- 對應訊息邊界取官方 `agent/inbox/spliced` 中精確 user-rpc admission 的前一事件。只在 `user/message` 前截斷會保留舊佇列輸入，因此不採用該位置。新 native 日誌先完成官方 flush，再發布產品指標。
- facade 映射呼叫參數、主 Agent 的事件/審批身分和宿主工具執行上下文；子 Agent 保持真實 ID。會話編輯、prompt、直接工具呼叫共用互斥邊界。記憶、MCP 測試與 skills 重新整理仍由原 driver 提供。
- CodePro 活動中拒絕 edit。idle edit 經 `runs.control` 的 emergency_stop 結束非終態舊 run；completed/cancelled/failed/fatal/exhausted 保留原結論。下一次 prompt 建立新 run。舊工具副作用、不確定 effects 與稽核事實保留，不自動重放或回滾。

原 UI 以整秒時間裁剪，因此同秒的多條訊息共同進入被移除前綴邊界。倒序或交錯時間戳、舊預覽缺少精確 UI/native request 映射、唯讀匯入、活動任務均明確報錯；不依訊息文字猜測邊界。歷史複製僅繼承選定設定與訊息，不複製執行狀態、審批憑據或 journal receipts。

若取消舊 run 後產品狀態提交失敗，原指標與可見歷史保留，可能留下未發布 native fork；舊 run 的取消仍是已發生事實。這類失敗不會讓新上下文繼續使用舊 run。後續原任務執行需依介面狀態重新發起，未自動刪除稽核日誌。

## 驗證

在 `runtime` 執行 `node --test tests/conversation-editing.test.mjs`，6/6 通過，退出碼 0。真實官方 Harness + 本機受控 HTTP，暫存目錄，涵蓋第一條編輯不重排舊輸入、精確上下文、同秒語意、歷史與 usage、重新啟動、真實主/子 Agent 工具身分、審批、活動互斥、取消/狀態提交失敗。

`node --test tests/conversation-editing-acp.test.mjs`，1/1 通過，退出碼 0。真實 WebSocket ACP + 官方 Harness 執行計畫、開始任務與原生寫檔，原 UI truncate RPC 取消舊 run，再透過原 prompt 建立新 run、新計畫與新模型上下文；舊事件與實際檔案保留。未呼叫真實使用者模型，未修改使用者資料；原桌面編輯互動仍需單獨驗收。
