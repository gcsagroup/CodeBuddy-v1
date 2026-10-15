# Mac 微信操作延遲：診斷與修復記錄（2026-10-13）

## 範圍與證據

使用者提供會話 `20261013_4`，主模型 `custom_ollama/deepseek-v4-pro:0813`。本次來源為 `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`，保留先前其他修改。私人會話及截圖僅留於忽略提交的 `target/mac-send-latency-20261013/`。

會話約從 19:02:42 至 19:08:22，最後取消，沒有「你好」傳送成功的回執。35 次帶稽核的工具呼叫共 54.172 秒，原生電腦工具僅 2.590 秒，臨時 Swift OCR 腳本一次 30.850 秒。回傳 9 個圖片區塊；擷取成功與模型理解圖片是不同階段。其他時間包含模型生成、授權等待與呼叫間隔；沒有獨立網路分段計時或模型連線逾時證據。

輔助視覺關閉，文字主模型沒有得到圖片理解結果；微信的輔助使用樹稀疏，模型因而繞行 OCR、shell、外部截圖並猜測座標。第一階段還缺少輔助使用權限。之後搜尋浮層出現，輸入 Jr 被焦點檢查拒絕，另一次點擊被遮擋檢查拒絕。原始浮層圖片是「搜尋網路結果」，不是已驗證的收件人視窗。

## 修復

- `vision_service.rs`：以 Disabled 型別區分輔助視覺關閉，分類為設定問題。
- `agent.rs`：主模型可識圖時保留圖片；文字模型缺少視覺時明確提示使用 ask_user 詢問設定選擇，區分擷取與理解，避免 OCR 繞行；不擅自啟用模型。
- `main.go`、`main_test.go`：提供觀察視窗、活動視窗精確識別碼及視窗局部座標範圍，避免外部截圖尺寸混用。
- `RuntimeContract.swift`、`runtime.swift`、`contract-tests.swift`：使用系統 AXFocusedWindow，依進程、幾何與標題唯一匹配，不再用最上層浮層代替鍵盤焦點。只在原生事件或 AX 寫操作邊界標記派送；保留點擊遮擋檢查及未知結果禁止重播的規則。

蘋果將 [AXFocusedWindow](https://developer.apple.com/documentation/applicationservices/kaxfocusedwindowattribute) 定義為應用程式當前焦點視窗。非啟用型浮層的疊放順序與鍵盤焦點可能不同；修復後真實產品路徑仍待驗收。

本次沒有變更公開 MCP schema、控制面狀態語義、授權方式或使用者模型設定；模型指引不等於宿主授權事實。

## 測試進度與驗收

Mac `go test ./...`、`go vet ./...` 退出 0；Swift 合同測試及完整原生執行層編譯退出 0，涵蓋搜尋浮層、真正聚焦彈窗、身分歧義、進程隔離、派送前失敗及部分派送失敗。封裝測試 15 項通過。

Rust 使用 `cargo test -p goose --lib FILTER --jobs 1 --locked --offline`，三個 FILTER 分別為 `unavailable_vision_keeps`（1 項）、`agents::vision_service::tests`（25 項）、`text_only_model_context`（2 項），均退出 0。已執行 `cargo fmt --all`。

Mac release 後端、`bundle-macos.cjs`、`macos-install-smoke.cjs` 均退出 0；冒煙測試使用獨立夾具，不代表微信互動通過。2054 個建置輸入與遠端逐檔雜湊一致；遠端 Git 基底為 `c3a537517a464053d090bc1983bafeddd00a79df + dirty`，必須結合本地 revision 與同步紀錄辨識來源。

已安裝 `/Applications/CodeBuddy.app`，舊應用備份於遠端倉庫 `target/mac-send-latency-20261013/CodeBuddy-before-latency.app`，保留使用者 profile。安裝包在遠端桌面 `CodeBuddy-Mac-20261013-desktop-latency/CodeBuddy-arm64.dmg`；本地副本為 `target/mac-send-latency-20261013/delivery/CodeBuddy-arm64.dmg`。

DMG SHA256：`a90b6b92a14fda71339e5f786043dd10236ba42a6d7f72ff7a09b30e3661925e`；後端 SHA256：`839143ec4f8677dfea3e57281c22568178dbe705976e8d77be056b1e74099711`。Apple Silicon ad-hoc 內部測試包，未驗收 Intel 或 Developer ID 公證。

**產品驗收阻塞**：19:49 系統回傳 `CGSSessionScreenIsLocked=Yes`；RustDesk 停留在 19:34 舊畫面。已請使用者解鎖；缺少視覺時的實際詢問、微信搜尋焦點與識圖仍未驗收，沒有傳送對外訊息，沒有擅自更動輔助視覺設定。

驗收包含：視覺關閉時詢問、啟用已設定視覺後讀取畫面、搜尋浮層正確綁定焦點、遮擋/焦點錯誤的準確派送狀態。真正對外傳訊需重新核對對象與內容，歷史會話指令不當作本次傳送授權。本次未提交、未推送。

## 解鎖後的補充調查與修復（20:50）

- 使用者要求全部改用 `Ollama / kimi-k3` 測試。兩次實機切換在模型發現階段出現 `Connect, TimedOut`，尚未開始識圖。
- 同一服務曾返回 HTTP 200；3 秒 HTTPS 建連限制也重現 SSL connection timeout，另一次 15 秒探測超時。客户端門檻過短與網路波動需分開記錄。
- `acp/server/providers.rs` 移除獨立的 3 秒建連門檻，保留 30 秒總時限及憑據驗證。慢建連回歸 1 項通過，退出 0，耗時 3.22 秒。
- 使用者已批准宿主直接詢問並等待的方案。`agent.rs` 保留型別化視覺錯誤，使用既有 ActionRequired 詢問處理方式，等待期間停止模型與工具呼叫；設定後重試會重新檢查。歷史圖片不阻塞新請求，支援圖片的主模型保留原圖。
- 沿用現有 elicitation 語義，不新增公共協定或自動授權；參考 [MCP elicitation](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/client/elicitation.mdx)。
- 新增回歸及實機驗收仍在進行；安裝包仍為前述 SHA256 版本。Kimi K3 尚未切換成功，不列為通過。


## 新增驗證結果（21:13）

- Rust `vision_configuration_`：3 項通過；`provider_persistence_tests`：11 項通過，皆退出 0。涵蓋拒圖後詢問、等待期間不追加模型呼叫、取消清理、歷史圖片及支援圖片的主模型。
- `cargo clippy -p goose --lib --jobs 1 --locked --offline -- -D warnings` 退出 0；已執行 `cargo fmt --all`。
- 前端 ElicitationRequest 4 項及 ACP elicitationRequests 5 項通過。保留本機 Node 22 與套件要求 Node 24 的警告，未更換環境。首次命令的多餘 `--` 導致過濾異常，已停止並以正確檔案過濾重跑；中止紀錄不列為通過。
- 2054 個建構輸入兩端雜湊相同，新 Mac 套件建構中。21:13 系統再次回傳鎖屏，RustDesk 仍為 20:30 舊畫面；實機驗收等待解鎖及新版安裝。


## 新套件交付（21:29）

- release 後端、bundle、安裝冒煙皆退出 0；已安裝 `/Applications/CodeBuddy.app` 並通過 codesign 嚴格校驗。
- arm64 / 1.43.2 / ad-hoc 套件：遠端桌面 `CodeBuddy-Mac-20261013-vision-pause/CodeBuddy-arm64.dmg`；本機 `target/mac-send-latency-20261013/vision-pause-delivery/CodeBuddy-arm64.dmg`。
- DMG SHA256：`bd667cf618d240ed63cc1ad16d7325a25f72f8cb856a9574b99e86020c9cab45`；後端 SHA256：`fdabb89890c7a00ac36e04735ea08c29f98b35dd431aac8b3582b1149538af49`。新版包含宿主視覺詢問與連線時限修復，取代上文舊版候選。
- 舊應用備份：遠端倉庫 `target/mac-send-latency-20261013/vision-pause/CodeBuddy-before-vision-pause.app`；使用者資料保留。來源為本機 main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty，2054 個建構輸入一致。
- 21:19 曾解鎖，21:27 再次自動鎖定；21:29 系統確認鎖屏。新版程序已啟動，renderer 尚未就緒。已請使用者再次解鎖。Kimi K3、識圖及失敗恢復仍待實機驗收，未對外傳訊、提交或推送。


## 解鎖後實機驗收（23:21）

- 新版 `/Applications/CodeBuddy.app` 於 22:49 啟動並完成 React 就緒；使用新後端日誌 `20261013_224941.log`，排除同時執行的舊測試應用。
- **實際模型切換通過**：設定頁及新對話顯示 `Ollama / kimi-k3`，會話 `20261013_5` 持久化為 `custom_ollama / kimi-k3`。模型探索耗時 1016 ms，回傳 18 個模型。
- 透過真實 UI 提交一次唯讀觀察。`list_apps` 觸發 macOS 的 CodeBuddy 螢幕錄製授權提示；回執確認 `/Applications/CodeBuddy.app` 缺少權限，未派送桌面輸入。
- 本輪解釋權限阻塞並詢問下一步，沒有重複截圖或對外傳送訊息。這驗證本輪模型請求/回覆及權限錯誤回饋；**尚未進入影像理解，也未觸發新增的視覺模型缺失宿主詢問路徑**。
- 已請使用者親自處理系統隱私授權。真實識圖、宿主視覺詢問 UI 與恢復、微信焦點流程仍待驗收。僅更新文件，沒有重新打包、提交或推送。

## 2026-10-14：錄影開關開啟仍被拒絕的根因

- 10:48:35 的 macOS tccd 日誌確認請求來自 `/Applications/CodeBuddy.app/Contents/Resources/bin/qwen-computer-runtime`，責任應用正確歸屬 `local.codebuddy.desktop`。系統明確記錄 `Failed to match existing code requirement ... kTCCServiceScreenCapture`。
- 舊授權要求為 `cdhash 5b9ee82b0866b12ff00e2bfbd26119fa3a6eff2c`，目前應用為 `cdhash 8e849af0e426fc06e6b114ba5c999fce1eb272b0`。更新後舊 TCC 授權與臨時簽章不匹配；失敗發生於截圖之前，與模型辨識圖片及網路逾時無關。
- 10:53 後曾啟動安裝磁碟副本 `/Volumes/CodeBuddy 1/CodeBuddy.app`，這是後續驗收的干擾項，並非此前已安裝應用失敗的解釋。後續已確認 `/Applications/CodeBuddy.app` 行程。
- 經使用者明確要求移除舊項目，執行 `tccutil reset ScreenCapture local.codebuddy.desktop`，退出 0，系統回報成功；僅重設 CodeBuddy 錄影授權，未修改 TCC 資料庫、其他應用權限或系統保護。等待使用者重新加入目前安裝的應用並授權。
- `RuntimeContract.swift` 提示已區分「目前行程被拒絕」與「開關未開啟」，說明更新後舊簽章項目的移除/重新加入步驟及安裝磁碟副本問題，避免反覆要求切換舊開關。
- 依現有 `build-macos-computer.cjs` 入口在遠端既有原始碼目錄執行 Swift 合同測試，退出 0。提示變更尚未重新封裝或覆蓋正在授權的應用；候選 DMG 雜湊保持上文版本。
- 目前未列出有效的 Developer ID Application 身分。後續分發升級需穩定且適用的簽章憑證及發佈設定；臨時簽章測試包不代表正式簽章發佈。參考 [Apple：TCC permissions](https://developer.apple.com/forums/thread/730043)。
- 本機與遠端證據：`target/mac-permission-20261014/tcc-signature-mismatch.log`。原始碼基線 `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`。保留既有變更，未提交、未推送。授權恢復後的真實截圖/辨識待驗收；重設成功不代表產品通過。
