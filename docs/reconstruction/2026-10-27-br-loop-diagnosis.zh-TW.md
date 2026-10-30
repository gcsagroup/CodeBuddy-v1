# 同事安裝版連續 `<br>` 診斷

本輪僅調查、真實資料復現及記錄，沒有修改產品邏輯、原始導出、安裝包或模型設定。來源為同事安裝版；分析源碼是 `D:\CodeBuddy-v1`、main、797b2b0 加既有未提交改動，尚未核實同事安裝包的精確版本。沒有提交或推送。

## 已確認

- 會話 `f439531e-647e-41e3-bf2e-30b5f8ff644b` 共 13 條訊息、13 個唯一 ID。
- 只有一次圖片生成、兩次 30 秒狀態查詢；第一張 1088×1920 PNG 已完成。
- 最後正文有 16,896 個 UTF-16 單元；尾部是 3,315 次 `<br>\n`，佔 98.1%。該訊息沒有工具呼叫，wave 未提交，create_desktop_pet 未呼叫。
- `htmlSecurity.ts` 將每個包含 HTML 的行各自包成程式碼區塊，且包含 br；`MarkdownContent.tsx` 呼叫它。因此原文產生 3,315 個 pre，對應截圖黑條。它放大顯示，但沒有創造原始重複內容。
- 正文還存在模型通道標記，值得檢查格式。導出程式固定將模型欄位寫成 null，亦缺少原始 SSE、逐 chunk 時序及結束原因。

## 尚未確定

模型生成退化／服務端格式設定是優先假設，但缺少同事原始響應，仍不能排除適配或重放重複。這不是已證實的特定模型故障。現有空響應檢查接受可見文字，不檢測此類重複；當時實際輸出上限未知。圖片完成後才發生異常，因此 ComfyUI 的 240 秒等待規則不會終止這次模型流。

## 驗證與建議

以既有 Node 24 執行 `.local/br-loop-diagnosis/analyze.mjs`，真實原文經實際轉換函式及 ReactMarkdown 服務端渲染產生 3,315 個 pre；直接渲染原文為 0 個 pre。於 `ui/desktop` 執行 `node ../node_modules/vitest/vitest.mjs run src/utils/htmlSecurity.test.ts src/components/MarkdownContent.test.tsx --maxWorkers=1`，77/77 通過；兩條命令退出碼均為 0。無模型或 GPU 請求，無同事安裝包 E2E。證據保存在 `.local/br-loop-diagnosis/evidence.json`。

建議分層處理，尚未實施：展示層避免逐行 HTML 程式碼區塊，保留安全轉義及原文；Harness 模型流邊界評估通用重複保護及輸出預算，透過結構化終止與既有取消處理，不以 br 關鍵字決定完成、不盲目重交圖片；供應商層核對模型、模板、工具／推理解析、EOS 和取樣參數。終止語義變更須依倉庫規則另行確認設計。

參考：[ReactMarkdown 預設 HTML 轉義](https://github.com/remarkjs/react-markdown)、[vLLM SamplingParams](https://docs.vllm.ai/en/stable/api/vllm/sampling_params/)。後者只是可比較機制，未確認同事使用 vLLM。

下一步需同事的安裝包檔名／版本、模型名、故障時間段日誌及該會話的 `backend/harness/sessions/.../session.v4.jsonl`；若要確定首次重複來源，再對照該請求原始 SSE。不需要 API key 或整份憑據設定。短提示詞成功不代表原始長上下文已修復。

[简体完整报告](2026-10-27-br-loop-diagnosis.zh-CN.md) · [English](2026-10-27-br-loop-diagnosis.en.md)
