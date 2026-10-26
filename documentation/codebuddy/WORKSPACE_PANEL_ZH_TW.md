# 工作區面板交付說明

日期：2026-09-30。修改基於 `main` 的 `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`，驗收使用目前含修改的工作目錄。

## 功能與實作

- 右側原任務面板替換成「工作區檔案／新增終端機／瀏覽器」入口，可調整寬度、展開、收合及切換標籤。
- 檔案支援目錄樹、檔名搜尋、Markdown／圖片／文字預覽、文字編輯與儲存。磁碟版本不同時拒絕覆寫，保留編輯草稿；關閉未儲存檔案前使用既有確認視窗。
- 終端機使用 MIT 授權的 `@xterm/xterm@6.0.0`、`@xterm/addon-fit@0.11.0`、`node-pty@1.1.0`；啟動目錄為目前會話工作區，支援多標籤、調整尺寸、Ctrl+C 和關閉程序。
- 瀏覽器使用 Electron `WebContentsView`，支援 HTTP/HTTPS、位址列、前進、後退、重新整理。網頁使用 sandbox，沒有 Node 或應用程式 preload 權限。
- 會話資料由既有 ACP snapshot 提供；面板只保存檔案草稿和標籤。主程序管理終端機／網頁資源，依應用視窗及會話隔離。切換會話保留資源，關閉視窗或重載 renderer 清理資源。
- 使用現有 Markdown 預覽、國際化和確認視窗。Rust 後端無需為這項功能重編。

## 合併位置

核心在 `ui/desktop/src/workspace-panel/`；入口為 `AppLayout.tsx`、`main.ts` 和 `preload.ts`。依賴修改在 desktop `package.json` 和 `ui/pnpm-lock.yaml`；`forge.config.ts` 使用 node-pty Windows Node-API 預編譯檔並解包原生模組。三語詞條新增於 `src/i18n/messages/`。

此工作目錄另外存在 Git MCP 等先前修改，提交時應按功能區分。

## 驗證

在 `ui/desktop` 執行：

```text
pnpm exec vitest run src/workspace-panel src/components/Layout/AppLayout.test.ts --maxWorkers=1
pnpm exec tsc --noEmit
pnpm exec eslint src/workspace-panel src/components/Layout/AppLayout.tsx src/preload.ts --no-warn-ignored
```

23 個測試通過，退出碼 0。類型檢查和上述 ESLint 通過。涵蓋真實暫存檔、中文、BOM／CRLF、競爭儲存、路徑穿越／junction、二進位／大小邊界、元件互動、草稿隔離和關閉確認。

正式 `start-gui-debug` 啟動的 Electron 會話 `20260930_31` 已實際驗收：中文檔案編輯儲存；PowerShell 工作目錄及中文檔案輸出；Ctrl+C 中斷長命令後繼續執行；終端機確認關閉；跨會話資源存取拒絕；瀏覽器本地頁面連結、前進／後退／重新整理；切換至另一會話後返回，草稿和終端輸出保留。頁面實測 `require` 和 `window.electron` 均為 undefined。

本機證據位於 `D:\CodeBuddy\.cargo\workspace-panel`，不納入 Git。`tests.log`、`file-ui-result.json`、`terminal-evidence.json`、`switch-evidence.json` 記錄結果。

## 邊界

- 此次為開發版桌面驗收；安裝包尚未重新建置驗收。
- 草稿及標籤保存在 renderer 記憶體，可跨會話切換，尚未支援程式重啟還原。未儲存草稿會攔截關閉／重載，應先儲存或關閉檔案標籤。
- 文字預覽／編輯上限 2 MiB，搜尋跳過依賴／建置目錄且結果有上限；不提供大型二進位文件編輯。
- 終端機是使用者手動互動的 shell，不是 Agent 的 shell 授權入口。
- `i18n:check` 仍有既有英文目錄差異：5 個 `currentPlan.*` 多餘鍵及 5 個 `toolAction.*Summary` 值差異。新增 `workspacePanel.*` 與提取內容一致；未將此既有檢查標為通過。

參考： [xterm.js](https://github.com/xtermjs/xterm.js/)、[node-pty](https://github.com/microsoft/node-pty)、[Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)。

## 2026-10-08 介面優化

參考使用者提供的 DeepSeek Hermes 截圖，統一檔案、終端及瀏覽器的分頁列、工具列、留白與細捲軸。檔案預覽預設收起目錄樹，可隨時展開；重用既有 react-syntax-highlighter 提供語法高亮、行號及換行。超過 100,000 字元保留完整純文字，避免高亮拖慢介面。終端跟隨應用程式主題，增加工作目錄、執行狀態、清屏與最低文字對比度；清屏不向 shell 傳送指令。瀏覽器改進網址列、空白頁及載入提示，空白頁時隱藏原生空白視圖。

變更集中在 src/workspace-panel 元件、CSS、元件測試及三語文案，沒有新增相依套件。檔案儲存版本檢查、終端程序及瀏覽器權限沿用既有實作。

於 ui/desktop 執行 pnpm exec vitest run src/workspace-panel --maxWorkers=1，5 個測試檔案、30 項通過；pnpm exec tsc --noEmit、變更元件的 ESLint、pnpm run i18n:compile 均以 0 結束。真實 Electron 開發版（main / 00a6656df 加未提交變更）已驗證程式碼預覽、目錄折疊及換行，真實終端 Write-Output 與 Get-Location，以及網址列開啟公開範例網頁並取得實際內容、標題及可見狀態。熱更新重新載入期間的結果不計入成功，待穩定後重測。

本機證據位於 D:/CodeBuddy/.cargo/panel-*-refresh.png、panel-browser-content.png、panel-refresh-acceptance.json，不納入版本控制。尚未重建安裝包，未提交或推送 GitHub；深色主題已實作，尚未單獨進行深色主題真實互動驗收。

## 2026-10-26 檔案操作與文件閱讀

以上建構與驗收記錄僅適用於各自日期。目前本機檔案連結左鍵在側欄開啟，Ctrl/Cmd+左鍵由主行程處理外部開啟。程式碼檔案以 VS Code 檔案 URI 開啟，避免執行腳本；Markdown、一般文字及 CSV 保留使用者的預設應用。圖片本身左鍵進入透明底板的放大彈層，顯示實際縮放百分比與一個適配按鈕；圖片、檔案連結及網頁連結各有自己的右鍵選單。尺寸觀察於彈層節點掛載後建立。

PDF、DOCX、PPTX 可在側欄閱讀、選取文字及縮放；XLSX 使用上游唯讀表格。Office 原始檔案不在這裡編輯或儲存。主行程保留會話、真實路徑、版本與限量讀取檢查；官方 OfficeToPdf 服務負責轉換、排隊、快取及取消。關閉或重新整理會取消對應請求，不覆寫原檔。

適配器鎖定上游 0.2.1-alpha.2，版本不符須重新審查。PDF.js 6.3.289 需要 Electron 41 尚未提供的 Math.sumPrecise，因此會在內嵌字型解析時錯誤回退。適配器在 PDF 主執行緒與 worker 中按需安裝源自 core-js 的標準相容實作，保留 MIT 授權；不改上游繪製演算法，不以普通 reduce 或降低字型安全限制替代。升級執行環境後，須確認兩個環境均原生支援該 API 並通過精度、字型及繪製回歸，才考慮移除相容實作。

相容回歸：根目錄執行 `node --test ui/desktop/scripts/dsh-document-preview-assets.test.mjs`，搭配桌面既有 test:run、typecheck、i18n:check。隔離繪製測試不代表完整產品驗收；主行程或 Vite 適配變更後，須由標準預覽入口重新啟動再驗收。
