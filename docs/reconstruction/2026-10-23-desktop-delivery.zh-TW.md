# 2026-10-23 桌面串流與交付修正

[简体中文](2026-10-23-desktop-delivery.zh-CN.md) · [English](2026-10-23-desktop-delivery.en.md)

> 憑據更正：下方雙預置連線段落是已撤回的歷史候選方案。共享雲端 Key 與分發匯入已移除，目前原始碼不內建 Ollama 憑據，新使用者須自行配置。請勿依歷史段落恢復共享憑據。近期實作與驗證見[桌面互動開發說明](2026-10-25-desktop-ux-and-history.zh-TW.md)。

> 本文保留開發階段的時間順序紀錄；「待重建」「Mac LAN 待確認」屬於當時狀態。後續重建及限定範圍的安裝版驗收已完成，最新結果、限制與 Git 提交見[合併交接](2026-10-23-merge-handoff.zh-TW.md)。本機 Ollama 與 Ollama Cloud 的驗收範圍不同。

Windows 來源為 `D:\CodeBuddy-v1`、`main d43fcbbd0ec85afcb073cb74b14e835752a26e20` 加既有與本批未提交變更。接手時已有 278 條變更，未建立分支、提交或推送。Mac 位於 `/Users/erjinyi/Desktop/work/CodeBuddy-v1`，以 檔案 SHA256 快照與同步回執辨識來源，不能以舊 HEAD 代表候選內容。

## 修正與證據

原飛機遊戲會話第一輪首思考約 3.34 秒、首正文約 14.29 秒，118.13 秒停止，沒有寫檔工具；第二輪約 100 秒用於生成寫檔參數，沒有瀏覽器呼叫。因此不把整段等待都歸因於畫面緩衝。

串流及超過 8000 字元的程式碼區塊保留完整純文字，避免反覆語法高亮；短的已完成程式碼仍高亮。ResizeObserver 的版面寫入合併至動畫影格並清理；一般視窗錯誤不再標成 React 當機。新增工具參數首包診斷與「尚未執行」狀態，不記錄參數內容。

首輪公開目前權限允許的 write、edit、browser_control，其餘維持按需發現。模型區分建立專案與僅提供範例，宿主不以關鍵字裁決意圖。瀏覽器成功需有真實分頁 ID 與 HTTP(S) 位址；提示要求依工具回執報告實際檔案與預覽。

Ollama 沿用既有 Local Ollama 設定、`/api/tags` 與 `/api/show`，辨識聊天、工具及圖片能力；明確無工具或非聊天模型顯示原因，未知能力保留相容路徑。預設 LAN `http://192.168.9.101:8001`、`gemma-4-26B-A4B-it-uncensored-FP8-W8A16`、65536 上下文與圖片能力不變，既有設定不覆寫。

參考 [React memo](https://react.dev/reference/react/memo)、[useDeferredValue](https://react.dev/reference/react/useDeferredValue)、[Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)。沒有新增依賴或人為播放延遲。

## 驗證

Windows：Node 回歸首組 26 通過、後續 16 通過、預設模型 6 通過、最新 work-status 8 通過；UI 60 通過及取消/歷史 115 通過；串流瀏覽器 4 通過；捲動及原生嵌入瀏覽器 21 通過。Mac：Node 38 通過、1 平台條件跳過，追加狀態 8 通過；UI 109 通過，串流及嵌入瀏覽器 5 通過。兩端 TypeScript 檢查通過，以上命令退出 0；精確命令及測試清單見簡體版與本機日誌。

Windows 同一長程式碼夾具 112 次渲染，p95 9.7→3.9ms、最大 748.7→9.1ms、總渲染 2099.9→304.7ms，長任務 3→0。Mac 修正後 p95 4.2ms、最大 6.9ms、0 長任務。這不是所有情境或長期記憶體壓力的保證。

Windows 真實會話 `d21a0cca-c56f-4954-b593-54400b250380` 寫出 9720 位元組/345 行的 plane_war.html，後續「在右邊打開」真實載入右側遊戲；可觀察重新開始。32 秒輪次含約 27 秒批准等待，批准後約 0.3 秒取得瀏覽器回執。停止後 UI 212ms 空閒、Harness 253ms 記錄使用者中止，舊歷史可讀。稍後開發頁重新載入並釋放瀏覽器分頁，原因尚未確定；不列為跨重啟恢復通過。首輪總結仍有要求手動儲存的錯誤措辭，最終提示已補充實際檔案連結要求，需在新會話驗收。

Windows Ollama 服務可達但無模型；Mac 未發現執行中的服務及標準安裝。本批未下載模型，實際 Ollama 推理、工具與圖片仍待驗收。完整 Mac 模型任務、持續記憶體壓力、安裝/移除及公開分發不因自動測試或打包成功而視為通過。

本機證據：Windows `.preview-evidence/desktop-fixes-20261023`；Mac `/Users/erjinyi/Desktop/work/desktop-fixes-20261023`。安裝包、簽章、摘要與最終啟動狀態記於 `delivery.json`。既有設定與歷史保留在 `browser-control-20261022/profile-ready`，手測提示位於相鄰 `manual-tests`。

## 手動驗收

1. 新會話要求開發 HTML 飛機遊戲，核對檔案、變更卡與右側頁面；批准框由使用者處理，總結應連到實際檔案。
2. 要求在右邊打開並觀察、操作頁面；只有文字宣稱成功不算通過。
3. 「只給一個 HTML 按鈕範例，不建立檔案」應僅提供範例。
4. 長程式碼生成中測試捲動、輸入、停止、切換與返回歷史；停止後不應有遲到文字繼續增長。
5. 全新隔離資料目錄直接進入新任務與預設 LAN 模型，舊資料目錄保留設定與歷史。
6. Local Ollama 載入現有模型，空清單不自動下載；用支援 tools 的模型寫小檔案，支援 vision 的模型測圖片。服務離線、無工具能力應顯示清楚原因。


## 雙預設連線補充

新安裝同時提供 CodeBuddy LAN 與現有 ollama 雲端連線（https://ollama.com，22 個模型預設），LAN 維持初始選取。本批依使用者明確授權附帶統一 Ollama Cloud Key，首次啟動自動匯入本機受保護憑據，安裝後直接可用。未設定連線顯示設定卡片，但不加入可執行模型或子 Agent 模型選單。既有使用者設定保留。改動包含 runtime/default-model.json、store.mjs、distribution-model.test.mjs，ModelsAndRuntimeSettings、ProviderSettingsPage 與三組設定介面回歸。

Windows 最終執行期七組回歸 51 項通過；雙預設與原子儲存 13 項於兩端通過。設定介面三檔案 10 項通過，Windows 型別檢查與定向 ESLint 退出 0。最終來源清單在 shared-cloud-source/source.json，安裝包與最終驗證結果見本機 delivery.json。

Mac DMG 使用明確建立的 Finder 視窗解決同名舊掛載卷造成的版面錯誤，原掛載卷保留，完整 DMG 建置通過。Windows 使用已核准的使用者暫存目錄，原目錄權限保持原樣。

## 後續驗收發現與修復（2026-10-23）

實際雲端任務發現內建瀏覽器截圖未經官方附件入庫，下一次模型請求因 attachmentId 缺失而失敗。宿主工具入口現重用視覺路由及 Harness 附件服務，保存圖片參照，觀察失敗保留動作回執。新增模型續步、重啟恢復與異常圖片回歸；Windows 相關 82 項測試通過。重建候選套件後仍須重新進行實際驗收。

Ollama kimi-k3 原始串流正文為空，雲端清單首項調整為 kimi-k2.6；22 個目錄項尚未逐一驗收。Mac 安裝版 LAN 請求回傳 EHOSTUNREACH，同機 curl 成功，本機網路權限待使用者確認，不計為通過。
