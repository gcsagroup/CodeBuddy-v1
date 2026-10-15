# 安全偵測設定的執行階段接入

對象為 `D:\CodeBuddy-v1` 目前工作區，來源身分見 [source-baseline.json](source-baseline.json)。本批只新增 `runtime/safety-policy.mjs` 與測試；不修改 renderer、舊 Rust 核心或既有權限 owner，沒有安裝依賴、提交或推送。

原 UI 位於 `SecurityToggle.tsx`。原 `crates/goose/src/security/{mod,scanner,classification_client,command_chunker,security_inspector}.rs` 明確：總開關啟用後，在 shell 呼叫前檢查；命令分類器分析原命令，提示分類器分析最近十條使用者文字；結果超過門檻時升級為 RequireApproval。預設門檻 0.8；實際核准比較為嚴格大於。模型映射或完整 endpoint 指向專門分類服務，並非目前對話模型。

實作沿用原結構化分類協定與評分組合，不增加 Agent 或模型排程迴圈。設定啟用後會產生額外分類 HTTP 請求。採用 Hugging Face 的 `{inputs,parameters?}` 與 `label/score` 結構，相容原巢狀陣列及目前扁平陣列；支援原 INJECTION/SAFE、LABEL_1/LABEL_0 與 logits 的穩定 softmax。未知標籤、非有限分數和損壞回應均為未完成偵測，不轉成「安全」。[官方 API](https://huggingface.co/docs/inference-providers/tasks/text-classification)

## 宿主接法

```js
const safety = new SafetyPolicy(store, {
  modelMapping: process.env.SECURITY_ML_MODEL_MAPPING,
  overrides: {
    promptEnabled: process.env.SECURITY_PROMPT_ENABLED_OVERRIDE,
    commandEnabled: process.env.SECURITY_COMMAND_CLASSIFIER_ENABLED_OVERRIDE,
  },
});
const finding = await safety.inspect({ tool, userMessages, signal });
```

`tool` 保持真實 `{id,name,arguments}`。只精確比對官方原生 `pwsh`、`bash` 和宿主舊 `shell`；讀取 `arguments.command` 原字串。不憑 MCP 名稱後綴認定 shell 身分。`userMessages` 由宿主根據訊息角色提供，按時間由舊至新，只含明確使用者輸入文字；服務取最後十條，不混入工具回應或 Assistant 內容。

在原權限流程先執行停用擴充、never_allow、chat 等拒絕條件，再呼叫檢查，最後處理 always_allow/auto。若 `requiresApproval` 為 true，必須使用現有核准通道確認本次呼叫，不能由「總是允許」自動放行；同一 finding 的確認不得保存為日後安全警示的免檢憑證。安全模組從不直接執行、批准或拒絕工具，也不修改任務完成狀態。

回傳欄位為 `status`、`requiresApproval`、`confidence`、`threshold`、`reasonCodes`、`explanation`、可選 `findingId`、`classifierScores`、`coverage`。狀態有 disabled、not_applicable、clear、flagged、unavailable。clear 僅表示本次設定分類分數未超過門檻，原工具權限仍適用。外部取消拋出 AbortError，不再彈出確認。

## 設定、隱私與行為邊界

- 總開關關閉、非適用工具，或對應分類器關閉時，不傳送對應文字。端點來自明確設定或顯式傳入的組織模型映射；不自動借用主對話模型、下載模型或尋找其他服務。
- 命令分窗沿用 500 UTF-8 位元組、256 位元組重疊、最多 12 視窗，保留字元邊界。近期使用者文字每條最多 64 KiB；超限表示覆蓋不足。各分類器最多並行 3 次請求，預設單次 5 秒，回應最多 64 KiB。門檻判斷保留原命令主信號與提示輔助信號組合。
- 權杖透過既有保護儲存解密，只用於記憶體內請求的 Bearer header；設定改變時重新解析。拒絕帶 URL 使用者資訊的端點及 HTTP 重新導向，不記錄原文字、權杖或服務回應內容。請求只發生在使用者已啟用對應分類器的路徑。
- **與舊 fallback 的明確差異**：本實作沒有複製原正則 patterns。總開關開啟卻沒有命令分類器、端點缺失、分類服務錯誤、部分視窗失敗或尾部未掃描時，回傳 unavailable 並要求本次確認；不偽造惡意機率、不把未偵測當 clear。僅啟用提示分類器仍缺少命令主信號，因此保留該未完成邊界。此路徑不是原 pattern-only 偵測的等價移植。
- 設定的外部分類模型仍可能誤報或漏報。這是核准升級信號，不是系統沙箱、語意授權判定或「所有提示注入已阻擋」的保證。

## 驗證

在 `runtime` 執行 `node --test tests/safety-policy.test.mjs`，7/7 通過，退出碼 0。使用本機受控 HTTP 服務及隨機測試權杖的實際 DPAPI 加解密；沒有呼叫使用者分類服務或真實主模型，沒有執行被分類命令。

涵蓋開關與門檻立即生效、依分類器分離傳送內容、最近十條、組織映射、原 payload、UTF-8 視窗、截斷尾部、部分失敗、未知標籤、回應大小、重新導向、逾時、取消、機率與 logits。實際桌面警示與使用者分類服務需經主整合另行驗收；本模組測試不替代權限流程整合證明。

參考：本倉庫上述 Goose 安全源碼與 Apache-2.0 授權；[Hugging Face Text Classification](https://huggingface.co/docs/inference-providers/tasks/text-classification)。復用原協定、標準 Node fetch 與既有憑證模組；未引入新的第三方依賴。
