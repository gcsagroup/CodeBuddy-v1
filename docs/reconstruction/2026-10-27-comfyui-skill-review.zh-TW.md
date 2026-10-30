# ComfyUI 技能增強與來源比較

2026-10-27，`D:\CodeBuddy-v1`，`main@797b2b0` 加未提交變更。僅技能、參考文件與合同測試；未改公共工具協定、權限、連線、狀態歸屬，未安裝第三方技能／依賴，未提交、推送或打包。

## 調查與取捨

- [官方 Comfy CLI 技能](https://github.com/Comfy-Org/comfy-cli/blob/main/comfy_cli/skills/comfy/SKILL.md)：GPL-3.0、未歸檔、當日 API 顯示最近推送 2026-10-27。採用發現／執行區分和 live schema 優先；不引入 CLI、雲路由及安裝部署行為，未複製實作。
- [Portable Toolkit](https://github.com/Zambav/ComfyUI-Agent-Toolkit/blob/main/SKILL.md)：MIT、未歸檔、最近推送 2026-06-04。採用按需參考和環境發現，不引入訓練、cron 或 API 客戶端；未歸檔不等於品質已驗證。
- [ComfyUI Expert](https://github.com/MCKRUZ/ComfyUI-Expert/blob/master/skills/comfyui-api/SKILL.md)：MIT、已歸檔、最近推送 2026-03-18。不採用每 5 秒無上限輪詢及全域 interrupt，保留 240 秒轉背景和單任務取消。
- 交叉核對官方[路由](https://docs.comfy.org/development/comfyui-server/comms_routes)／[事件](https://docs.comfy.org/development/comfyui-server/comms_messages)，仍以宿主回執作狀態權威。
- 依據 [H3 提示指南](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)與 MiniMax [基礎](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)／[全參考](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)文件，只整理工具已支援的子集。

## 變更

`runtime/harness/skills/comfyui/` 三語主技能新增任務邊界、素材檢查、有限恢復、按需文件和交付證據；取消無條件先跑小樣。`references/operations*` 提供五模式、參考槽、尺寸比例、時長、Turbo／約束與故障分類；`references/minimax-h3*` 提供三段／六段提示結構。`requests.json` 含五個可替換示例，不是自動批次。`runtime/tests/comfyui-skill.test.mjs` 驗證原生 read 讀取及五模式經實際工具到受控 HTTP 的上傳、綁定和單次提交。

文檔沒有擴大工具能力：尺寸仍受 ResolutionSelector 與比例綁定限制，模型支援不等於介面已提供。

## 驗證與限制

既有 Node 24.22.1 執行 `node --test runtime/tests/comfyui-skill.test.mjs runtime/tests/comfyui-saved-workflows.test.mjs runtime/tests/comfyui-video-tool.test.mjs`：37/37、退出碼 0。補齊 I2V 開頭後重跑 skill 測試：8/8、退出碼 0。含權限、長時長、240 秒、恢復與背景發布回歸；皆隔離夾具，未消耗 GPU。

以既有 JS YAML 檢查 3 份 frontmatter、9 份 Markdown 本地引用通過；diff 檢查通過，沒有安裝依賴。分發遞迴複製已涵蓋 skills，僅靜態核對；沒有 UI 改動，未重複構建桌面或安裝包。日誌在 `.local/skill-draft/skill-upgrade-tests.log` 與 `skill-upgrade-examples-final.log`。新對話載入新內容，既有對話需重新載入技能。

夾具證明合同，不證明真實模型的遵循率或 GPU 畫質。實際驗收尚待：30 秒保留、I2V／R2V 身分、Turbo 分支、240 秒後右側交付、斷線／OOM 不重交。

[简体](2026-10-27-comfyui-skill-review.zh-CN.md) · [English](2026-10-27-comfyui-skill-review.en.md)

## 20 秒真實生成驗收補充

真實桌面模型選中了 20 秒、512×288 和 Turbo 8 步，但參數未進入 ComfyUI：`workflow_parameters[].value` 的 `type` 陣列超出 Harness 校驗器支援子集，誤報 `must be a lossless JSON value`。改用語義等價的三個純量 `oneOf` 分支，不改變參數值、任務歸屬或提交邏輯。新增原生 Harness 呼叫回歸，確認布林、數字、字串原樣傳遞，陣列／物件／null 在派發前被拒絕。

上述三檔案測試命令重跑：38/38，退出碼 0；`git diff --check` 通過。透過倉庫 `start-preview.ps1` 重啟同一隔離 profile 後繼續真實任務；成片結果另行記錄，自動測試不代表 GPU 驗收。

真實桌面會話 `0072aa1b-9ea1-4852-b6d8-cb9f472013f3` 於 13:05:49（上海時間）提交唯一任務 `32e161cf-b88f-4561-aade-d1191dc09ca4`。伺服器佇列確認時長 20、16:9／0.140625 MP／32 對齊、Turbo=true／8 步。模型只呼叫一次 `status(wait_seconds=240)`，返回 `waiting_in_background=true` 後結束回覆；右側繼續顯示採樣 5/8、63%。已驗證真實調參、單次提交及前後台交接；記錄時影片尚未完成，MP4 時長、播放與畫質仍待成片驗收。模型未依指引讀取額外參考檔，因此成功提交不代表完整技能遵循。
