# ComfyUI 參數、技能與背景等待

[简体](2026-10-27-comfyui-tuning.zh-CN.md) · [English](2026-10-27-comfyui-tuning.en.md)

基於 `D:\CodeBuddy-v1`、`main`、`797b2b0acb12456a12a42a5dc9f3cf97ca2880c9` 的既有 dirty worktree。保留原有修改；本批未提交／推送，未安裝依賴，未修改服務端工作流程或提交 GPU 生成。

## 行為

「期間」是秒數：提供的 I2V、T2V 預設 30 秒，R2V 預設 5 秒，原圖按 24 fps 轉幀並對齊。本批保留既有時長綁定，補足可見參數及調參介面。

`inspect` 現在回傳 `duration_seconds`、`tunable_parameters`；`workflow_parameters` 可調整實際連接的 Turbo、兩側步數、LoRA 強度、取樣器、scheduler、denoise，以及適用節點的 CFG、參考圖尺寸策略。類型、範圍和枚舉來自目前服務端 schema，重複／未知 ID 在提交前拒絕。模型、檔案、公式、連線及 fps 不走通用調參介面。

前台等待從建立任務起累計最多 240 秒。仍排隊／生成時回傳 `waiting_in_background=true`，模型應結束本輪，告知完成後在右側查看，不再自動輪詢。使用者主動詢問可再查。右側沿用原觀察與產物儲存流程；切換會話或退出應用後，ComfyUI 可繼續執行，回到原會話恢復觀察。

WebSocket 正常時約每 30 秒核查歷史，斷線時約每 10 秒；結束事件喚醒核查。事件本身不判定完成，慢下載不延長前台等待，也不重交生成。省略 wait_seconds 或設為 0 保留原單次查詢行為。

新增內建 `comfyui` 技能，提供三種語言，沿用 Harness 註冊、發現及權限；載入只展示已註冊媒體工具，不增加授權。改動檔案為 `runtime/comfyui-{saved-workflows,tool,video-tool,workflows,live}.mjs`、`runtime/harness/{comfyui-skill,profile,tool-discovery}.mjs`、`runtime/harness/skills/comfyui/SKILL*.md`，回歸在 `runtime/tests/comfyui-{saved-workflows,video-tool,skill}.test.mjs`。狀態和完成 owner 維持原模組。

## 方案依據

採用[官方事件語義](https://docs.comfy.org/development/comfyui-server/comms_messages)並自寫 CodeBuddy 適配技能。[現成 MiniMax 技能](https://github.com/artokun/comfyui-mcp/blob/main/plugin/skills/minimax-h3-video/SKILL.md)所在專案為 MIT、未歸檔，2026-10-27 查得最近推送為 10-26；但依賴其自有 MCP 工具，直接安裝不相容，因此未安裝或複製。

## 驗證與交接

- Node 24.22.1 執行 `--test runtime/tests/comfyui-*.test.mjs runtime/tests/generated-image-observation.test.mjs runtime/harness/test/computer-skill.test.mjs`：58/58，退出碼 0。
- `corepack pnpm --dir ui/desktop run test:run src/workspace-panel/WorkspaceGeneration.test.tsx src/workspace-panel/WorkspacePanel.test.tsx`：38/38，退出碼 0。系統 Node 22.23.2 有 engine 警告，未改環境。
- `corepack pnpm --dir ui/desktop exec playwright test generation-wait.browser.spec.ts --reporter=line --output=D:/CodeBuddy-v1/.local/comfyui-tuning/browser-results`：真實 Edge 2/2，退出碼 0；受控圖片／影片、播放和窄視窗截圖。
- 三個使用者 API 圖、四個服務端 UI 圖：7 組唯讀參數綁定／重新編譯通過，未提交生成。`git diff --check` 退出碼 0。
- Python 技能驗證器因缺少 yaml 退出碼 1；未安裝。以既有 JS YAML 庫檢查三語 frontmatter，並通過 Harness 註冊／載入測試。

README 的 `start-preview.ps1` 已完成目前源碼的 SDK／語言資源與 Electron 建置，React ready，使用 `.local/comfyui-tuning/preview` 隔離資料根。啟動程序持續執行，並非安裝包。證據位於 `.local/comfyui-tuning/`，不提交夾具或 profile。

待驗收提示：「用已儲存 MiniMax T2V 生成 30 秒影片並開啟 Turbo；超過 240 秒告知背景仍在生成，完成後右側展示。」核對單次提交、前台結束、右側完成與播放；I2V／R2V 另核對參考身分及品質。日誌在 `preview/logs/preview/`，會話用應用既有匯出入口。

真實模型 + GPU + 桌面的完整生成與畫質／顯存／長影片成功率尚未驗收。交付為實作、自動驗證與開發版驗收準備完成。

## 後續修復：使用技能先進入新對話

通用技能入口原本只有 `noAutoSubmit`，仍會建立會話。`SkillManager.tsx` 現在傳遞既有 `draftOnly`；`App.tsx`、`Hub.tsx` 支援普通對話草稿，CodePro 沿用既有流程。點擊只預填命令，使用者可編輯、選擇專案或離開；送出後才建立會話與目錄。專案技能保留目錄，既有空資料夾未刪除。

回歸涵蓋 `App.test.tsx`、`CodeProHub.input.test.tsx`、`codepro/CodeProHub.test.tsx`、`skills/SkillManager.test.tsx` 及 `tests/e2e/skill-draft.spec.ts`。Windows `fixtures.ts` 對齊 README 的 `start-preview.ps1`，傳遞現有 Node 與 Harness 偵錯埠，沒有安裝依賴。

元件命令為 `corepack pnpm --dir ui/desktop run test:run` 加上述四個 `src/` 測試路徑：首輪 63/64；修正新增測試的路徑字面量並新增路由斷言後，重跑後兩個相關檔案 31/31、退出碼 0，其餘兩檔已通過。`corepack pnpm --dir ui/desktop run typecheck`、定向 ESLint、`git diff --check` 均為退出碼 0。新 E2E 已格式化，既有 `CodeProHub.test.tsx` 整檔格式差異未擴大整理。

Node 24 在 `ui/desktop` 執行 `../node_modules/@playwright/test/cli.js test skill-draft.spec.ts --reporter=line --output=D:/CodeBuddy-v1/.local/skill-draft/e2e-rerun`：1/1、退出碼 0。真實 Electron 隔離 profile 中連續兩次點擊未建立目錄，送出後僅新增一個，前後截圖已檢視。首次舊夾具使用 Node 22 的啟動失敗不計為產品行為失敗。證據位於 `.local/skill-draft/`。

ESLint 通過範圍為上述 `src/` 檔案及新 E2E；額外檢查共享 `fixtures.ts` 得到 16 個既有規則錯誤，對 HEAD 內容重跑同樣 16 個，未擴大整理。

來源為 `main@797b2b0` 加未提交變更；未提交、推送或打包安裝版。技能入口已驗收，真實 GPU 生成仍待驗收。

### 技能預填文案統一

工具箱「使用技能」共用輸入框技能選單的 `composerMessages.useSkill`：簡繁體顯示「使用 comfyui 技能：」，英文顯示「Use the comfyui skill to:」。保留草稿與目錄選擇行為。`corepack pnpm --dir ui/desktop run test:run src/components/skills/SkillManager.test.tsx src/components/ChatInput.queue.test.tsx` 通過 63/63、退出碼 0；定向 ESLint、格式與 diff 檢查通過。證據前綴為 `.local/skill-draft/unified-text-`。

真實 Electron 的 skill-draft.spec.ts 對照工具箱與 / 選單：預填文字一致、送出前無新目錄、送出後一個目錄，1/1 通過、退出碼 0。截圖已檢視，結果位於 unified-text-e2e/。
