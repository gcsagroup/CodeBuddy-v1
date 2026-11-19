# CUA 本機部署評估與 API 驗證

日期：2026-11-17。來源：`D:\CodeBuddy-v1`，`main@4c8afad978b6e893a3545c0859dd5b4824a91223`，含既有未提交變更。未切換分支、提交、封裝或修改使用者設定。

## 結論

保留已設定的遠端 API `http://192.168.9.101:8001`，模型 `CUA-S1-Qwen3.5-4B`。主模型仍為 `deepseek-v4.1-flash:1017`，思考強度未變。CUA 僅提供圖像觀察，主模型判斷，原 MCP 執行操作。

本機記憶體足以嘗試 Q4 CPU 推論，但本次沒有完成本機推論。不能斷言硬體跑不動，也不能聲稱本機驗收通過。GPU 執行環境與下載速度尚未滿足驗證條件，因此依使用者允許的備案保留 API。

## 核實資料

- CPU：Ryzen 7 4800H；物理記憶體約 31.37 GiB，當時可用約 10.38 GiB。
- GPU：GTX 1650 Ti，4,096 MiB 顯示記憶體，當時占用 519 MiB；驅動 457.49。
- D 槽當時可用約 82.13 GiB。
- 已安裝 Ollama 0.40.16；附帶 llama-server 0.9.0-dev，commit `6c01da627`。
- [指定模型倉庫](https://huggingface.co/GCSA-AiLab/cua-s1-4b-0.2-GGUF-MLX/tree/main/GGUF)，固定 revision `01b53a83a8d492000e83ce69835d4c21c6c09be7`。
- Q4_K_M 為 2,741,242,176 位元組；配套 F16 mmproj 為 672,423,392 位元組，合計 3.18 GiB。還需要運算緩衝和上下文快取，檔案能放進顯示記憶體不代表完整推論能放入。
- 模型已合併 multimodal LoRA，必須使用同倉庫合併後的視覺投影。MLX 用於 Apple Silicon；Windows 評估 GGUF。倉庫標註 Apache-2.0；散布時保留授權和歸屬。簡單圖像測試不能替代量化後的完整任務評估。

## 本機未通過部署驗證的原因

Ollama GPU 探測 watchdog 超時，最後回報 CPU 與 `total_vram=0 B`。[官方硬體說明](https://docs.ollama.com/gpu)列出 GTX 1650 Ti，要求 NVIDIA 驅動 550 或更新；本機驅動不符合。這是目前環境的結果，不是顯卡永遠不受支援的結論。未升級驅動。

官方下載與鏡像片段探測約 0.1 MB/s，完整權重未下載。下載已停止，部分檔案以 `.part` 保留，不能載入或視為雜湊驗證通過。測試啟動的 Ollama 已停止。本機冷啟動、峰值記憶體、辨識延遲與品質均未測，沒有虛構本機比較值。

後續本機部署需完成固定版本下載與 SHA-256 校驗，使用同一批圖片實測，再接入既有 provider。[llama.cpp 多模態介面](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)支援模型與 mmproj 配對及相容 API，不需另建 Agent 核心。

## 遠端實測與限制

經目前 CodeBuddy VisionRouting 與 Harness 進行固定圖片測試，每張一次新請求及一次同 turn 相同圖片複用：

| 圖片 | 首次辨識 | 快取複用 |
| --- | ---: | ---: |
| 記事本 | 9.79 秒 | 0.26 毫秒 |
| 計算器 | 17.68 秒 | 0.54 毫秒 |
| 客戶表單 | 8.58 秒 | 0.24 毫秒 |

三張圖片均含預期關鍵文字；三次快取均複用。這不是整體準確率 100%，也不是三個桌面任務重測或 Windows 全量驗收。輸出仍包含冗餘及未經圖像證明的推斷，不能當成操作完成證據。快取耗時不含截圖和主模型判斷。

遠端目錄回報 vLLM、模型 CUA、65,536 上下文與 W8A16 路徑；使用者確認其來源是指定模型。介面沒有權重雜湊，不能把遠端 W8A16 和本機 GGUF Q4 當成同一量化檔案。

Node 24 執行 distribution-model、vision-routing、vision-routing-harness、vision-routing-acp、mcp-vision 五個測試目標：39 項通過，退出碼 0。`node .local/cua-local-20261117/verify-api.mjs` 三次真實呼叫完成，退出碼 0。

記錄位於 `D:\CodeBuddy-v1\.local\cua-local-20261117\`：`remote-api-result.json`、`remote-api.log`、`routing-tests.log`、`ollama-discovery.log`、`verify-api.mjs`。API 配置原本已存在，本次未重複新增提供商、覆蓋設定或將本機測試目錄提交。
