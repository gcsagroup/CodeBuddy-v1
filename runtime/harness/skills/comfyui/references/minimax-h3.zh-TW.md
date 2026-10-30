# MiniMax H3 提示詞

限本介面支援的 T2V、I2V、圖片 R2V。模型的其他音訊／影片參考、末幀、控制網路能力不代表工具支援。先看參考像素，依使用者目標撰寫。

## 結構

- T2V：`integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music`，分別描述視聽事件、環境音、配樂。
- I2V：用 [requests.json](requests.json) 的首幀對齊開頭與三段結構，保留圖中構圖／身分，描述接續運動。
- R2V：`subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music` 六段。上傳順序對應 `<Picture 1>`／`<Picture 2>`，復用人物／物件給穩定 `<Subject N>`，說明保留與改變特徵；不要虛構影片或音訊參考。

## 內容

場景與動作優先英文，對白與畫面文字保留原語言。`[Shot 1]` 起始，後續鏡頭依遞增切點如 `[Shot 2] At 00:03.500, ...`，且在時長內。連續小動作可維持單鏡頭，不填充無關情節。

描述主體、動作結果、鏡頭與聲音；對白放對應畫面，使用穩定 `(S1)` 等及 `<d>` 標籤，保留使用者字面台詞。要求安靜／無配樂時寫清聲音欄位，不自行添加音樂。輸出是否有聲與內容須檢查。

核對時間線、參考身分和畫面文字。沒有負面條件分支的圖不塞禁詞清單，不以高 CFG 代替清楚描述。範例只提供結構，內容取自使用者。

## 調參與驗收

秒數傳 duration_seconds，由工作流對齊幀數，不重寫 length/fps。Turbo／取樣依 live 綁定，不因教程數字覆寫預設。未同意試樣就不額外生成。先檢查實際尺寸、時長、畫面和播放，再按回饋迭代；技術成功不等於品質滿意。

來源（2026-10-27）：[Comfy 指南](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)、MiniMax [基礎模式](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)／[全參考模式](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)。僅採用工具支援的子集。
