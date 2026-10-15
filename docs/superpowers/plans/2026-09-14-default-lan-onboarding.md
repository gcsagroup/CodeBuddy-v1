# 預設區域網路模型初始化

日期：2026-09-14。狀態：自動化與真實 Electron 失敗恢復、既有設定保護驗收通過；真實模型成功路徑因服務停機待驗收。

預設服務為 `http://192.168.9.120:8001`。使用者已確認服務主動停機，數天後恢復；不再探測，也不改用舊服務。

新使用者在模型探索、提供商建立、預設值儲存與畫面狀態更新完成後進入聊天。失敗或單次操作超過 60 秒顯示可重試狀態與服務位址。空模型清單及多模型清單均不任選模型；唯一有效模型自動使用，多模型仍待確認部署預設 ID。沿用既有無驗證設定，沒有內嵌金鑰；實際服務驗證方式尚未確認。

完整或部分既有預設值皆保留；探索及建立完成後再次讀取，避免覆盖期間選定的預設值。這不是跨程序交易保證；最後讀取與儲存之間的競態仍需後端條件寫入才能完全消除。建立沿用後端相同設定冪等性。超時只停止前端後續流程，已送出的後端操作可能完成；不把逾時視為確定未寫入。

## 公開方案比較

[Codex 設定參考](https://developers.openai.com/codex/config-reference/) 將模型、提供商和服務位址分開指定；本方案採用明確模型選擇及使用者設定優先，沒有推測 Codex 私有初始化行為。[OpenAI 模型列表](https://platform.openai.com/docs/api-reference/models/list) 沒有宣告第一項為預設模型，因此拒絕沿用任選首項的語義。僅參考公開介面，未複製第三方程式碼或新增依賴。

## 驗證與剩餘關卡

在 `D:\CodeBuddy\ui\desktop` 執行 `pnpm exec vitest run src/components/onboarding/OnboardingGuard.test.tsx src/components/ModelAndProviderContext.test.tsx --maxWorkers=1`：18 通過、0 失敗（含 4 項模型上下文測試）；typecheck、限定 ESLint、限定 Prettier 通過。16 語系同步與 i18n 全量檢查通過。完整命令與退出碼見 `.cargo/evidence/default-lan-onboarding-20260914/gates.json`。

已從隔離空白設定啟動原始碼 Electron 與新建置後端，真實滑鼠驗證位址、錯誤和重試，鍵盤重新載入後仍可重試。隔離測試設定 `openai/fixture-preserved` 再次啟動後進入主畫面，重新載入後設定未被覆寫。證據為 `native-initial.*`、`native-retry-*`、`native-reload.txt`、`native-existing-config-result.json`。這些只證明失敗恢復與既有設定保護；實際模型發訊息、成功初始化持久化與串流回覆仍待服務恢復。安裝包尚未生成。

補充驗證：桌面全量 pnpm run test:run exit 0，227 個測試檔案、2016 通過、4 跳過、0 失敗。Vite renderer 生產建置 exit 0。完整日誌與結果在 .cargo/evidence/default-lan-onboarding-20260914/。
