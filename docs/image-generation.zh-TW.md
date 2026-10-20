# 內建圖像生成

主 Agent 透過 `generate_image` 呼叫 ComfyUI，產生一般圖片、透明素材及參考圖編輯結果。聊天模型負責理解需求與提示詞，ComfyUI 工作流程負責像素。

在「設定 → 模型與執行 → 圖片與影片 · ComfyUI」儲存服務位址。預設為使用者指定的 `http://192.168.9.111:8188`，採用已安裝的 Qwen Image 2.1 工作流程。其他服務須具有相同模型及節點：Qwen Image 2.1 int8、Qwen3-VL 8B int8 編碼器、Qwen Image 2.1 VAE、`TextEncodeQwenImage21`、`SaveImageAdvanced`。缺少時回報真實錯誤，不自動下載或安裝。

直接要求 Agent 生圖即可，工具透過 `search_mcp_tools` 按需載入，沿用 Harness 權限與執行鏈。`generate` 提交一次並傳回 ID，`status` 最多等待 30 秒；未完成時繼續查詢同一任務。單次 HTTP 上限 300 秒。僅在服務完成且圖片已儲存後回報 `completed`。

每次一張 PNG，寬高各為 256–2048、32 像素倍數；最多兩張工作區內的 PNG 參考圖。結果位於 `generated-images/<job_id>/`。回執歸目前聊天所有，重建工具仍可查詢，設定變更不影響舊任務服務位址。UUID `request_id` 可避免重複提交；結果未知時保留回執，不自動重發。

`cancel` 使用單任務取消介面並複查狀態。舊服務缺少介面時具體說明，不發送全域中斷。停止聊天等待不等於取消遠端 GPU 任務，須以任務 ID 明確取消。

「自訂寵物」使用相同生圖工具，再以 `create_desktop_pet` 裝配八組動作並註冊預覽，不自動切換寵物。透明度、角色一致性及動作品質仍需預覽。

影片共用相同服務設定，透過內建 `generate_video` 呼叫 MiniMax H3，支援文字及 PNG 首幀圖像生成影片。參數、模型需求與任務查詢見[內建影片生成](video-generation.zh-TW.md)。

依據：[ComfyUI 官方介面](https://docs.comfy.org/development/comfyui-server/comms_routes)。ComfyUI 擁有佇列、執行與歷史事實；工具只保存回執和輸出，不新增 Agent 調度核心。自行撰寫 API 客戶端，不複製服務端實作。
