# 執行提示與模型選擇

這是本輪觀察提示，不是模型評級、失敗判定或另一套 Agent 核心。截圖僅參考版面，不推測 Codex 私有邏輯。

本次請求等待內容 90 秒、生成 180 秒、連續 3 次工具失敗或 3 次回應恢復時顯示不同原因。網路/HTTP 錯誤與回應格式問題分開，工具失敗提示先檢查參數、權限和環境。成功工具回執清除計數；工具開始/請求結束清除生成計時。不根據模型名稱評分，也不把只讀檢查稱為無進展。

審批、工具執行、上下文壓縮、子任務、交付複核與取消期間不顯示。「繼續等待」只隱藏本輪卡片，不發送請求；新輪次可再提示，重載不持久保留隱藏偏好。「停止並選擇模型」使用現有取消流程，空閒後開啟已有選擇器；不自動切換或重送，不刪除檔案。切換聊天不會誤開另一聊天的選擇器。

`driver` 消費既有命令失敗事實；`work-status` 透過 `execution_activity` 發送暫時計數；桌面 store 驗證輪次與可選欄位，hook/card 只顯示。無額外模型請求、權限或持久化遷移；舊服務缺欄位則不顯示相應提示。

參考 [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/running-agents/) 的錯誤/上限區分、[LangChain](https://reference.langchain.com/javascript/langchain/index/toolCallLimitMiddleware) 的本輪計數與可選行為，以及 [Anthropic](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) 的進展和驗證原則。前兩者公開倉庫為 MIT、本次查閱時公開文件與主分支可存取；未複製實作或新增依賴，不引入第二套循環，也不以硬上限評判模型品質。

提示無法代替實際產物驗證；先前安裝驗收中的功能缺陷、複核漏判和恢復問題仍未全部解決。交付複核與獨立驗收已於 2026-11-10 依使用者要求移除。
