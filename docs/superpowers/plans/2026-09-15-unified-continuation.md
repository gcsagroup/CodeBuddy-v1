# 統一任務續接來源

2026-09-15 · [繁體中文](2026-09-15-unified-continuation.md) · [简体中文](2026-09-15-unified-continuation.zh-CN.md) · [English](2026-09-15-unified-continuation.en.md)

已確認反例：`繼續。` 被當作新目標，丟失先前 unknown 操作的追蹤視窗。定向 RED：0 通過、1 失敗；證據 `continuation-red.json`。

沿用統一回合既有 source_message_id 作為目標來源；新增可選訊息中繼資料 task_continuation_of 僅記錄對此來源的參照。turn_id 仍表示本輪執行，steer 仍只表示投遞方式。可信入口核對既有任務狀態、工作區、intent 與歷史來源後寫入；預設缺省相容舊資料，使用者原文不能建立關係。目標提取和 unknown 歷史追蹤共用此已解析的關係。

本次只支援既有純繼續語句加句末標點，以及明確的繼續加僅滑鼠限制短句。取消、停止、明確新目標、額外混合內容及不匹配來源不自動視為續接。不擴大舊 clarification 的純繼續語義；不宣稱任意自然語言分類，也不代表已強制禁止鍵盤或腳本。

OpenAI 公開文件描述 steering 將新增要求納入續接並保留已完成工作。本次採用保留原任務及更新原文的原則，不推測 Codex 私有分類器，不引入外部程式碼或依賴。

公開 `reply_codepro` 入口及續接回歸 10 項通過；訊息型別 429、tracker 30、統一回合 10、既有 provider 回歸 1、ACP 114 項均通過。各過濾器有重疊，不相加為總數。格式、Clippy、後端建置退出碼均為 0，見 `continuation-focused.json` 與 `continuation-gates.json`。

公開入口測試先提交附加滑鼠限制，再重載後提交帶標點的繼續；每次 provider 實際收到原目標、限制原文及 unknown 回執，原 source 保留，三次失敗後暫停。舊訊息缺省、來源／工作區不匹配、偽造文字及晚到舊關聯的邊界見 `continuation-boundary-evidence.json`。首次執行層失敗源於測試漏掉公開入口的訊息持久化步驟；保留原記錄，最終已直接測試公開入口，見 `continuation-test-fixture-classification.json`。

新版獨立 Electron 已驗證舊會話載入及 Ctrl+R 重載相容性，原訊息與手動模式仍可見，見 `continuation-native-summary.json`。這只證明載入／刷新相容；真實模型理解及自主桌面續接仍為 `NOT_RUN`，不探測 120 或 107。僅用滑鼠的工具執行強制仍未實作，屬下一切片。

[OpenAI: Model guidance](https://developers.openai.com/api/docs/guides/latest-model)

Evidence: `.cargo/evidence/audit-fixes-20260914/`.
