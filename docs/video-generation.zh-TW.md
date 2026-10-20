# 內建影片生成

完成後傳回本機 MP4 路徑與可點選的播放連結，透過瀏覽器播放 ComfyUI 保存的影片。連結需要服務在線，本機檔案可獨立保存及播放；影片不會以圖片嵌入聊天。再次查詢舊回執可補齊播放連結，不必重新生成。

於「設定 → 模型與執行 → 圖片與影片 · ComfyUI」儲存服務位址。Agent 可透過工具探索載入 generate_video，沿用圖片工具的位址與會話權限。

文生影片：「生成 5 秒小熊貓在溪流邊揮手的影片，640×384，帶流水和鳥鳴。」圖生影片：「以工作區 reference.png 為首幀生成 5 秒動畫。」目前圖生影片接受工作區 PNG，寬高請配合圖片比例。

generate 的 mode 為 text_to_video 或 image_to_video，後者需要 image_path。預設 640×640、5 秒、24 fps；寬高為 32 倍數，總像素上限 1344×768，時長 5–15 秒按 17k+5 幀向上取整，5 秒通常得到約 5.17 秒。

使用已安裝 MiniMax H3 FL2VA int8、Qwen3-VL 32B MiniMax int8、影片 fp16 VAE、音訊 fp32 VAE 與原生節點，20 步基礎採樣，不自動下載模型或安裝節點。更換服務需具備相同模型與節點。

提交一次後以相同 job_id 查詢 status，每次等待最多 30 秒，HTTP 上限 300 秒。伺服器完成且下載的 MP4 結構、影片軌元資料通過檢查並寫入 generated-videos/<job_id>/1.mp4 後才回報 completed。回執依會話保存，舊任務保留原服務位址；未知提交結果不自動重送。cancel 僅針對該任務；暫停 Agent 等待與取消 GPU 任務各自獨立。

依據[官方 H3 原生工作流程](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native)與服務節點介面，自行組裝 API 圖。官方 Harness 提問模組為 MIT；模型授權依各模型條款。模型清單或佇列成功不等於生成驗收。
