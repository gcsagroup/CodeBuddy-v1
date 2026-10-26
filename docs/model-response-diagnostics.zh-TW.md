# 模型只回傳思考內容：診斷與顯示修正

日期：2026-10-26。原始碼基線：`189096734438abafbb3580851cdce150f4ffd520`，`main`，包含既有未提交變更及本批修改。

## 已確認的現象

使用者提供的繪圖對話包含兩輪請求，每輪首次請求加五次原生重試。12 次原生 `assistant/attempt` 都只有 reasoning 區塊，replay 欄位簽名為 `reasoning`，原始結束原因皆為 `stop`，最後都被校驗為 `EMPTY_RESPONSE`。沒有原生 `tool/call` 或 `tool/result`。協定標記與工具名稱只是文字，不構成工具呼叫。服務回報的輸出 token 合計為 46,118，這不是費用計算。

當時連線為 Ollama Cloud 的 OpenAI 相容介面，模型 ID 為 `kimi-k3`。使用者核准的三次後續短請求皆 HTTP 200 且正常結束：一般回答有正文；預設思考的工具請求有結構化呼叫；`reasoning_effort: none` 的工具請求也有結構化呼叫。工具未執行，原對話未傳送，金鑰未儲存。

已確認的是歷史請求只有思考輸出，沒有正文或工具呼叫；上游暫時故障、特定上下文觸發的生成／解析異常，或特定串流形態在用戶端遺失，仍待區分。短請求成功不證明原任務已恢復；原生日誌也不是服務端原始 SSE。再次重現時應比較同一請求的原始欄位與適配後區塊。

## 本批修正及邊界

- `runtime/work-status.mjs` 使用既有診斷計數，僅在原生 `EMPTY_RESPONSE` 且正文、思考及工具區塊計數完整時指出只收到思考。未知或相反證據保留一般提示。重試顯示真實次數；只有原生終態才提示停止及後續處理方式。
- `GooseMessage.tsx` 將沒有失敗驗證證據的執行失敗顯示為需要處理／未完成。只有結構化 `verification_summary` 存在 failed 才顯示測試失敗。沿用簡體、繁體與英文翻譯；`INCOMPLETE` 僅屬顯示層，不寫入持久化或公開協定。
- 回歸涵蓋三種思考欄位、真實 Harness 串流解析、重試、取消、會話隔離與前端呈現。

Harness 持有完成、失敗及重試事實，計數只協助解釋。思考文字不提升為正文、工具呼叫或授權。保留原始記錄及其他未提交變更。

## 方案比較

採用鎖定 MIT 授權 DSH `0.2.1-alpha.2` 的既有欄位邊界、校驗與重試，不新增依賴或執行迴圈。不從思考文字解析並執行工具，也不自動關閉思考或切換模型。這些做法會改變操作邊界或使用者選項，短請求成功不足以支持它們。

本批保留原生五次重試。全面降低次數會影響網路、限流及服務故障恢復；個別錯誤的重試上限應另行評估原生策略介面與邊界，不在顯示修復中新增重試狀態機。

## 參考與復核

- [Ollama OpenAI 相容介面](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)
- [Ollama 工具呼叫](https://github.com/ollama/ollama/blob/main/docs/capabilities/tool-calling.mdx)
- 鎖定上游說明：`runtime/harness/node_modules/@deepseek-ai/dsh-llm-retry/README.zh.md`。公開最新版不等於安裝版本。

## 本批驗證結果

最終檢查使用既有 Node 24.18.0：後端 45 項、前端四個檔案共 64 項通過，型別檢查、限定檔案 ESLint 與 `git diff --check` 均退出 0。後端命令為 `node --test`，目標為 `runtime/tests/work-status.test.mjs` 及 Harness 的 `response-channels`、`model-response-validation`、`empty-response-recovery`、`recovery` 測試。前端使用既有 `vitest run --maxWorkers=1`，目標為 `GooseMessage.test.ts`、`GooseMessage.handoff.test.tsx`、`GooseMessage.stream.test.tsx`、`codeProPresentation.test.ts`；型別檢查為 `tsc --noEmit`，ESLint 使用 `--max-warnings 0 --no-warn-ignored`。

首次指定錯誤的 `ui/desktop/node_modules` 路徑使兩個檢查命令退出 1；確認依賴位於 `ui/node_modules` 後成功執行，未安裝或重建依賴。初次 Node 22 前端測試雖通過但有 engine 警告，已用 Node 24 重驗。

真實桌面由標準 `scripts/start-harness-preview.cjs` 的 `startPreview` 啟動，使用本目錄 dirty 原始碼與隔離資料目錄。本地 HTTP 模型夾具不呼叫雲端、不執行工具。實際輸入框送出、失敗後再次送出、重新載入三項驗證均退出 0。原生日誌記錄 6 次失敗 attempt、5 次重試、0 次工具呼叫，以及 error、completed 兩輪終態；模型夾具收到 7 次串流請求。畫面顯示需要處理／未完成與思考獨占提示；後續正文正常、錯誤列清除，重新載入保留記錄。已檢查截圖。啟動時有依賴 sourcemap 警告，未發現本批相關 renderer 異常；沒有為此改動依賴。

探測腳本、隔離 profile、日誌及截圖位於 `.preview-evidence/response-diagnosis-20261026/`，不納入提交。未建立分支、提交、推送、製作或安裝發行包。原始請求的上游根因仍待重現；本批改善診斷和呈現，不宣稱模型生成異常已完全修復。

驗收預覽已關閉：桌面與標準啟動器均退出 0，啟動回執為 stopped。CDP 關閉命令因目標先關閉而回報連線結束（輔助命令退出 1），以桌面退出碼與回執確認收尾。
