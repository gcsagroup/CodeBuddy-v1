# 無效歸一化座標的重試計數

日期：2026-09-14。本文為繁體預設版本；另有[簡體中文](2026-09-14-computer-invalid-coordinate-retry.zh-CN.md)與[English](2026-09-14-computer-invalid-coordinate-retry.en.md)。

## 已確認反例

隔離視窗的真實 ACP 呼叫使用 `screenshot_normalized_1000`、`x:1001`、`y:500`，三次使用不同新截圖，均在輸入前回傳「归一化截图坐标必须位于 0..1000」。截圖更新不能修正此座標錯誤，但原有重試指紋包含截圖識別碼，會分別計數。證據：`.cargo/evidence/audit-fixes-20260914/computer-normalized-range-native.json`。直接 ACP 不經主 Agent 的重試狀態機，不能單憑這三次拒絕宣稱主循環停止已驗收。

## 最小設計

僅對電腦座標工具、歸一化座標模式、明確錯誤回執及上述精確單一錯誤文字，從失敗指紋排除截圖識別碼。保留座標、座標空間、目標及其他參數；修正輸入可再次嘗試。沿用既有第二次檢查、第三次暫停的機制，不改權限、工具輸入或任務完成判定。

現介面沒有此拒絕的結構化錯誤類別，因此本次精確文字分類有明確局限：不使用模糊比對，不擴大到過期狀態、視窗變更、一般 unknown 或所有電腦錯誤。

## 公開方案比較

OpenAI 的公開電腦使用文件要求執行環境保留狀態、套用權限與執行限制，並依動作、截圖和最終狀態評估結果。本方案保留新狀態的重新評估機會，只限制無法由換截圖修正的已知參數拒絕；不推測 Codex 私有重試演算法，也不將回合上限視為產品故障。[OpenAI：Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)

## 驗證狀態

回歸已通過：定向 tracker 26 項；完整 goose 函式庫 3307 項通過、2 項忽略；ACP 114 項。新增主執行層測試及相關統一回合複測 9 項、既有分析 provider 回歸 1 項均通過；格式、Clippy 與新版後端建置退出碼均為 0。

主執行層證據確認第二次失敗後持久化修復提示、第三次後暫停、provider 僅呼叫 3 次，且原目標保留。首次測試因 MOIM 在 provider 訊息中附加內容導致整條相等斷言失敗；改為包含完整提示常數，持久化精確內容與停止斷言保持不變。這是測試斷言不匹配既有訊息封裝，不是產品回歸。

新版隔離 Electron 的真實 ACP 驗收：越界座標在輸入前遭拒，頁面未切換；新截圖配合正確座標後進入歷史記錄頁，目標按鈕從不存在變為可見，回執為 `worked`。證據見 `retry-gates.json`、`retry-execution-focused.json`、`retry-final-gates.json`、`retry-native-summary.json`（均位於上述證據目錄）。直接 ACP、真實回執重放與主執行層測試是獨立證據；真實模型自主閉環因使用者停服仍為 `NOT_RUN`，不探測 120 或 107。
