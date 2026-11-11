# 輸入框統計列

生成期間顯示目前請求最近取樣時段的輸出速度，每次取樣至少間隔半秒。已辨識的 vLLM 服務會隨串流回傳累計輸出 token 數；其他服務也可提供逐塊計數。只有輸出片段時使用 Harness 的 token 估算並標記 `≈`。從首段輸出取樣，每次請求重新計算。生成結束後顯示會話平均速度。

操作列保留權限、模型及傳送按鈕；獨立統計列顯示生成速度、快取命中與上下文占用，窄視窗可換行，滑鼠懸停或鍵盤聚焦可查看說明。

平均速度直接採用已鎖定 Harness 0.2.1-alpha.2 的官方 `@deepseek-ai/dsh-session-stats`：`decodeTokens / (decodeMs / 1000)`，代表目前會話已完成請求的平均解碼速度，不含首 token 等待與工具執行；完成請求後更新，重新載入不計入閒置時間。跨模型會話仍為整個會話的平均值。

快取命中使用最近一次非壓縮請求的既有用量回執：快取讀取 / 總輸入。優先採用 `totalTokens - outputTokens`，否則按 Harness 的未快取輸入、快取讀取、快取寫入三個桶相加；寫入不算命中。缺少資料顯示「未回報」，明確零命中顯示 `0%`，未完整命中不捨入成 `100%`。上下文沿用原有計量與警示，估算值帶 `≈`。

透過既有 `status_message.data.context_meter` 傳遞可選的 `sessionStats`，避免 SDK 過濾未定義的 usage_update 中繼資料。不新增模型請求、獨立計時器、資料庫或執行核心，舊服務與歷史資料仍可使用。

採用本機鎖定的 Harness 官方插件（MIT）及既有 React 元件；不搬入其整套 Web UI。[LM Studio](https://lmstudio.ai/docs/developer/rest/chat) 區分速度與首 token 耗時；[Cline](https://docs.cline.bot/core-workflows/task-management) 顯示可用的快取資訊並按請求更新。僅參考資訊分層，不加入外部依賴。統計精度取決於服務回報，不能反推未回報的 KV cache 命中。

快取回執修正：透過既有鎖定適配器保留 OpenAI 相容服務明確回報的零值，避免原生 mapUsage 丟棄它。缺少資料仍未知，正值維持原生映射。按請求隔離並隨原生會話儲存，舊紀錄不補造數字。vLLM 啟用前綴快取與回報 prompt_tokens_details.cached_tokens 為獨立設定。
