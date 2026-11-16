# 思考預算與結束思考

另見 [简体中文（默认）](REASONING_CONTROL_ZH_CN.md) / [English](REASONING_CONTROL_EN.md)。

## 採用範圍

參考 pi-llama-cpp，將思考預算與整則回覆的輸出上限分開。保留既有官方 Harness / pi-ai 適配器，不安裝另一套 Agent 核心，也不由客戶端拼接思考結束標記。

目前只對模型目錄明確標識為 vLLM、且 OpenAPI 宣告 `thinking_token_budget` 的 Chat Completions 連線啟用。能力探測沿用連線目錄快取；拖動思考檔位不產生生成請求。未知或探測失敗的服務維持原協定。

每次請求的思考預算上限為 minimal 512、low 2048、medium 4096、high 8192、xhigh 16384 個 token。提供 max 的模型沿用 16384。介面依模型實際支援的檔位顯示。關閉思考時省略預算。輸出空間較小時，原生序列化器會為正文保留空間並縮減預算。GPT 和 Ollama 連線依各自協定傳遞支援的思考檔位。

實際限制由伺服器執行。OpenAPI 宣告不能證明模型解析器設定正確；token 預算也不是固定秒數保證，仍需真實流式請求與任務驗收。

## 尚未採用

pi-llama-cpp 的 `reasoning_end` 依賴 llama.cpp 專用控制介面。目前未驗證 vLLM 或 Ollama Kimi 有等價介面，因此不提供無效按鈕，也不暗中降低 Kimi 檔位。未來需以會話、執行輪次和 completion ID 定位請求，檢查回應的成功欄位，不能只看 HTTP 200 或目前模型選單。

結束思考不能保證工具執行、檔案寫入或測試成功；權限、失敗狀態及匯出資訊問題仍需分別修復。

## 驗證與來源

2026-11-09 的真實 Gemma 服務探測中，預算 64 時思考欄位約為 62 token，但模型繼續在正文推演，耗盡 2048 個輸出 token，未給出要求的簡短答案。結束思考區塊不等於結束推演，較低預算也不保證較佳體驗。真實專案驗收另發現固定回傳成功的檢查器，必須由執行及驗證回執檢查獨立處理。

`runtime/tests/vllm-thinking.test.mjs` 覆蓋原生序列化、關閉思考、快取、未知服務及 Gemma 舊範本相容。自動測試不等於 Windows/macOS 安裝包驗收。

- [pi-llama-cpp](https://github.com/gsanhueza/pi-llama-cpp#reasoning-control)（MIT；參考機制，沒有複製程式碼）
- [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [vLLM reasoning outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)
