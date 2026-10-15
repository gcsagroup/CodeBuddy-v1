# Kimi K3 電腦控制對比驗收與建議

日期：2026-10-12，Asia/Shanghai。簡體詳版：[COMPUTER_CONTROL_KIMI_COMPARISON_20261012_ZH_CN.md](COMPUTER_CONTROL_KIMI_COMPARISON_20261012_ZH_CN.md)。英文版：[COMPUTER_CONTROL_KIMI_COMPARISON_20261012_EN.md](COMPUTER_CONTROL_KIMI_COMPARISON_20261012_EN.md)。

## 建議

目前保留 **Kimi K3 主 Agent + 既有 qwen_computer 控制器**；主 Agent 優先看圖，必要時呼叫同為 Kimi K3 的輔助視覺。Windows-MCP v0.8.8 保留為隔離候選，完成宿主適配後再決定是否替換。

既有 qwen_computer 本身已透過 MCP 接入，並非恢復過去移除的自研或組合版。此次比較的是兩種實作與接入品質。

## 環境及變更

- 目錄 <CodeBuddy checkout>；main，HEAD 50dfeb1be31350a54a97de40318c8d0890361eaf，含原有常見查詢/天氣未提交修改。
- 透過真實 CodeBuddy Electron/ACP 桌面執行任務，未重新建置或修改產品原始碼，未提交/推送。
- 僅調整 target/common-query-acceptance/home 隔離設定：預設、主/分析/編碼/測試/審查 Agent 與輔助視覺全部使用 custom_1/kimi-k3；正式 profile 未動。
- 主模型及輔助視覺有實際呼叫證據，其餘角色僅核對設定，未分別驗收開發任務。
- 隔離設定明確啟用 Kimi 圖片輸入，實際供應商請求含 image_url。最終視覺路由為 auto、qwen 啟用、候選停用，原設定快照為 kimi-original-config-state.json。
- 每次結束後移除該測試會話的控制器，最後候選 serve.py 程序數為零。

## 真實結果

| 場景 | 既有 qwen + Kimi | Windows-MCP + Kimi |
|---|---|---|
| 計算器 (63+19)×4 | 通過，93 秒/12 呼叫，328 | 糾錯後通過，156 秒/26 呼叫，328 |
| 微信隱藏至系統匣後恢復並發送 | 通過，89 秒/13 呼叫，2 次錯誤後恢復 | 未完成；觀測 256 秒/12 呼叫，3 次錯誤，停於長時間無進展 |
| 已開啟微信後發送 | 未另作重複測試 | 通過，103 秒/8 呼叫，1 次錯誤後恢復 |
| 豆包保留草稿、新聊天、發送、讀回覆、回查草稿 | 通過，231 秒/15 呼叫，0 工具錯誤 | 未完成；觀測 111 秒/14 呼叫、9 錯誤，持續 CONTROL_UNAVAILABLE |
| Kimi 輔助視覺唯讀辨識 | 通過，21 秒/2 工具呼叫，獨立圖片请求與 JSON 回覆已核實 | 未另外驗證候選視覺適配 |

秒數為會話首末訊息跨度；中止項不是完成時間。樣本為單次探索測試，並非穩定率統計。微信兩次成功初始狀態不同，不宜直接排名。計算器初始數值不同，但兩輪都清空後重算。畫面與可存取性樹同時供應，這是完整產品驗收，並非純視覺/OCR/UIA 各自準確率。

### 可見證據

- 微信「小號」標題及右側新氣泡：K3现有验收1012-A、K3候选验收1012-B2，輸入框清空且無失敗標記。僅代表發送端可見，未讀取收件端。原候選訊息 K3候选验收1012-B 沒有發送證據。
- 豆包實際完整回覆 K3 现有豆包 1012-A，完成按鈕可見、連續觀察一致；回到原輸入框仍為「保留草稿1012：周五确认出发时间。」。
- 輔助視覺的獨立 kimi-k3 請求含一張圖片，JSON 正確識別頁面及草稿，見 kimi-aux-actual-proof.json。主模型各案例也核對到圖片輸入。

## 根因與限制

1. **宿主接入缺口已證實。** agent.rs 只將 qwen_computer__ 分類至桌面串行流；其他工具透過 desktop_tool_stream.rs 並行合流。候選計算器 7 次 Click 約 104 毫秒內啟動、完成順序不同，畫面成為 6+39；Kimi 隨後清空重算。這是宿主與候選的適配問題，並非全是上游缺陷。證據 kimi-windows-click-order.json。
2. **控制狀態異常。** session 20261012_14 在 23:10–23:11 出現 unavailable→user→ready，使用者確認無操作或其他控制任務。舊會話保留程序曾構成混雜因素，但清理成單候選後豆包仍重現 unavailable。先前直接測試有 indicator 狀態未確認的例外；本輪每次錯誤尚無相同堆疊，根因不宜全部合併。模型所稱「另一方佔用」超出原始證據。
3. **單動作快不等於任務快。** 先前微測候選熱態點擊加裁剪圖約 0.76–0.78 秒，既有含觀察動作約 1.86–1.93 秒，工作量不同。候選完整 Snapshot 曾達 27–29 秒。關閉 UI 樹採集後仍回報空視窗集合，容易讓模型混淆未採集與不存在。
4. **既有方案仍有成本。** 微信定位錯誤及豆包首次點擊未生效都需恢復。大型 UI 樹、歷史與模型往返增加耗時；豆包累計輸入 845545、輸出 9606 token 為多請求累加，非單次上下文或費用。

## 實施次序

先保留既有控制器。候選後續先復用宿主串行機制，以明確桌面能力及共享輸入資源分類，避免假冒工具名稱；管理單一控制者與會話釋放，保留人工接管；定位 indicator/control state、區分未採集與不存在、减少無進展重試及不必要完整樹。適配後以相同初態、交替次序、多輪計算器、中文輸入、隱藏視窗、微信唯一發送、豆包草稿、遮擋恢復驗收，再依完整任務結果選型。此輪只交付設定、測試與方案，以上修復尚未實施。

## 證據及交付狀態

target/windows-mcp-comparison 內含 kimi-results.json、kimi-*-session.json、kimi-*-ui.png、kimi-*-image-audit.json、kimi-windows-click-order.json、kimi-input-confirmation.json、kimi-aux-actual-proof.json。私人桌面內容僅保留在本機忽略目錄。

git status --short 退出碼 0，原有修改保留。未執行 Cargo/前端全套、未產生安裝包，本輪執行的是真實桌面 E2E。

[Windows-MCP 官方倉庫](https://github.com/CursorTouch/Windows-MCP)採 MIT，公開提供截圖/UIA/輸入能力。官方單動作延遲描述不代表本專案完整任務速度；建議以本機證據為準。
