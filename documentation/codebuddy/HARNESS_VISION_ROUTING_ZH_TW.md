# Harness 輔助視覺適配記錄

2026-11-23：新使用者預設使用 `auto`（主模型優先）。目前聊天模型確認支援圖片時直接接收原圖，否則使用已設定的備用識圖模型。保留既有使用者儲存的專用模型或僅主模型選擇，可於設定 → 圖像理解手動切換。Windows 與 macOS 共用初始化邏輯。

日期：2026-10-14。原始碼為 `D:\CodeBuddy-v1` 目前檔案，該目錄無 Git revision；本批未提交、推送或變更介面原始碼。

## 行為與所有權

原設定介面的 `visionRoute` 現在參與實際請求。`runtime/vision-routing.mjs` 僅適配使用者訊息中的圖片，不解析任務意圖，不裁決任務完成，不擁有第二套 Agent 迴圈。

| 路由 | 實際行為 |
| --- | --- |
| 無圖片 | 原內容陣列直接交給主模型，不呼叫輔助模型 |
| auto | 主模型圖片能力明確 supported 時原圖直達主模型；否則使用已設定且能力明確 supported 的輔助模型 |
| always | 啟用輔助視覺時，每次含圖輸入都經過輔助模型，即使主模型支援圖片 |
| disabled 或未啟用 | 僅使用主模型；圖片能力 unknown/unsupported 時回傳明確錯誤 |

模型能力來自目前能力解析器及使用者儲存的能力覆寫；沒有按模型名稱猜測支援情況。儲存啟用設定時要求明確的 provider/model 且連線已設定；執行時檢查輔助模型圖片能力，避免設定儲存順序互相阻塞。

輔助呼叫仍由官方 Harness 執行，使用獨立工作階段、空工具清單、`toolFilter.allow=[]`、無 MCP、單次模型步驟、1024 輸出 token 和關閉自動壓縮。所有工具審批回傳拒絕，模型即使提出工具呼叫也不產生成功描述。只有正常結束且有非空文字時才回傳觀察。

原使用者圖片保留在產品訊息、原介面適配器和匯出歷史中。主模型接收的替換內容包含明確的不可信資料警示以及 JSON 包裝的觀察；這些內容不是工具事實、權限或開發驗收證據。後續對話恢復使用 Harness 的觀察文字歷史，不自動重新解釋或重放圖像副作用。

## 邊界與生命週期

- 每次輔助輸入最多 8 張圖、每張 8 MiB、總計 32 MiB；引用的使用者文字最多 32000 字元；觀察文字最多 16000 字元。實際圖像格式和像素由官方附件 admission 再驗證。
- 獨立 90 秒逾時；取消、逾時、服務關閉均傳遞 AbortSignal 並等待官方驅動實際停止。部分輸出、空回應、模型錯誤及工具嘗試均不轉為描述成功。執行期間輔助 provider 受到設定變更保護。
- 獨立工作階段不加入產品會話清單；Harness 的會話日誌與標準附件儲存仍保留在目前 profile。目前驅動沒有單會話實體清理 API，此處不承諾零留存。
- 原 Rust `vision_service.rs` 還包含截圖定位、座標、截圖代次綁定、狀態驗證、快取、縮圖和重試。本模組不遷入這些電腦控制能力；它只實現使用者圖片解釋，電腦控制需要其獨立適配與驗收。

## 自動驗證與實際產品邊界

命令：`node --test runtime/tests/vision-routing.test.mjs runtime/tests/vision-routing-harness.test.mjs runtime/tests/vision-routing-acp.test.mjs`。本批 11 項通過，退出碼 0：7 項路由/狀態單測、3 項真實 Harness 和本機 HTTP 模型協定測試、1 項真實 ACP 整鏈測試。

涵蓋無圖/主模型直達/always、不可信包裝、設定與能力門檻、圖像 admission、無工具 schema、工具嘗試拒絕、空輸出、錯誤、取消、逾時、HTTP 串流結束、provider 保護、原 renderer 圖片消費以及重新啟動匯出/後續對話。測試環境為臨時 profile 和本機受控模型服務。真實 Electron 上傳互動、外部視覺模型品質及 macOS 尚未由這組結果驗收。

## 參考

使用已安裝的 DeepSeek Harness `0.2.1-alpha.2`，沿用 MIT 授權的官方附件與會話執行方案；無新增依賴、無 vendored 修改。[官方附件架構](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md)說明圖片 admission、正規化和持久化職責。[官方附件套件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/README.md)提供介面背景。具體行為以本機鎖定版本和測試回執為準。
