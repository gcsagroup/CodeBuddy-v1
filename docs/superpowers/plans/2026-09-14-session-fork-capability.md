# 對話複製能力一致性

日期：2026-09-14。狀態：能力保護、並行修復與本輪隔離原生驗收通過。

後端 `ensure_fork_allowed` 明確拒絕 `code_pro`，其餘已知對話類型沿用既有複製能力。原先歷史卡片、側欄右鍵選單、訊息編輯按鈕與 Ctrl+Enter 均可能送出不受支援的請求。

各入口共用 `canForkSession`；CodePro 或尚未取得類型時禁用複製，顯示新增獨立任務的說明。訊息編輯快捷鍵被拒絕時保留草稿，不改成原位編輯。原位編輯仍須明確點選。ACP 包裝層在呼叫前重新讀取對話類型，避免只依賴畫面快照。後端租約與權限規則未移除；本次不實作 CodePro 內容複製。

## 公開產品比較

當前 Codex 的 `fork_thread` 工具契約表示建立獨立子任務，只繼承已完成歷史，正在執行的未完成回合不複製。本修復採用能力明確及來源隔離原則，拒絕把 CodePro 不支援的 fork 假裝成可用。公開 [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 已查閱；當前頁面未提供完整 fork 契約，詳細比較以本工作階段可用工具說明為依據，不推斷私有實作。沒有複製第三方程式碼或新增依賴。

## 驗證

前端定向檢查最終為 5 檔案、29 通過、exit 0（`fork-focused-final.log`）。完整前端執行於補充測試案例之前：227 檔案、2022 通過、4 跳過、0 失敗；後續僅增加測試覆蓋，由最終定向檢查驗證。型別、lint、格式、翻譯檢查與編譯、渲染器建置皆 exit 0（`fork-gates.json`）。

原生驗收發現的載入問題促成確定性回歸：外層請求先持有存取許可，載入取得生命週期鎖並等待進行中請求，內層再次申請許可時互相等待。修復前在通知屏障下命中兩秒逾時斷言，0 通過、1 失敗、exit 101（`fork-deadlock-before-fixture-fixed.log`）。更早的獨立清理日誌目錄缺失屬於測試夾具失敗，不作為死鎖證據。

修復使用請求型別的 `JsonRpcMessage::matches_method` 識別 11 個已有內層存取保護的入口，跳過重複外層許可。內層保護完整保留；9 個入口仍要求可寫工作區，其餘兩個保留原有較窄要求。對應見 `fork-reentry-access-map.json`。

後端檢查全部通過（`fork-reentry-gates.json`）：並行與權限定向 7/7；完整核心 3304 通過、0 失敗、2 忽略；ACP 整合 59+55=114 通過；格式、Clippy、後端建置 exit 0。定向測試包含強制進入原競爭屏障、11 入口缺失對話/關閉狀態拒絕、9 入口可寫要求，以及既有進行中許可生命週期檢查。

真實 Electron：CodePro 歷史卡片、側欄選單、訊息編輯入口停用；Ctrl+Enter 保留草稿；一般對話複製產生新 ID、正文持久化，一般訊息編輯的分叉入口仍可用。重新建置後，對來源與副本執行 16 個場景：14 次真實載入、2 次快取切換，包含 8 次重新整理與一次程序重啟，全部通過。實際載入後端耗時 2162–2229 ms，正文與對應載入結束日誌同時確認。資料再次核對通過，未送出模型任務。

後端 SHA-256：`41709ABD6B42B800EEA57B7102CFFE7288912914FA6938ECC68E66E07F4D7051`。詳細記錄見 `fork-reentry-native-summary.json`、`fork-reentry-native-runs.json`、兩輪 backend JSONL、`fork-persistence.json`。首次觀察器錯誤要求快取切換產生新 RPC，原始誤判與原始碼依據保留於 `fork-reentry-native-observer-mismatch.json`；它不是產品失敗，也不算真實載入。

以上證據位於 `.cargo/evidence/audit-fixes-20260914/`。本輪通過限定於隔離 profile 的這些場景，不宣稱排除所有競態；真實模型執行仍待停機服務恢復後另行驗收，未連線該服務。
