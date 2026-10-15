# 專案跨對話記憶與等待延遲驗收

[简体中文](2026-10-09-project-memory-acceptance.zh-CN.md) · [English](2026-10-09-project-memory-acceptance.en.md)

## 結論與來源

本批記憶修復與等待限制驗收通過。同一裝置、設定檔及專案的不同對話可共用已儲存記憶；完整對話合併及跨裝置同步不在範圍內。Windows 開發版與 Mac 安裝版均使用真實 Electron 應用及使用者已配置的 Ollama `deepseek-v4-pro:0813`。

來源為既有 `main`、基底 `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加待提交修復。工作區含其他既有改動；本次五個 Rust 檔案的雜湊與新後端已核對。安裝包來自該 dirty 工作區，不能視為僅本批提交的乾淨重建。提交編號見[合併交接](2026-10-09-memory-fixes-merge-handoff.md)。

## 自動驗證

- 兩端各 56 項記憶單元、14 項整合、5 項純對話限制、52 項任務合同測試通過。記憶單元另有 1 項外部 Hindsight 測試按既有標記略過。
- 最新兩端提供商完整測試各 138 項通過，含 5 項無資料等待回歸：Chat/Responses 標頭停滯、心跳、持續文字/思考/工具參數、部分輸出後停滯、非串流相容性。
- 兩端審計測試各 29 項通過、1 項手動基準預設略過；另在 Windows 明確執行該基準並通過。保留損壞記錄拒絕、子工作階段孤立請求及跨 run 隔離。
- Windows 適用 Clippy `-D warnings`、兩端格式與後端建置退出碼 0。Mac 安裝包驗證、唯讀掛載、安裝及深度嚴格簽章檢查退出碼 0。

## 真實應用驗收

bundle41 兩端已逐項核對儲存、新對話召回、其他專案隔離、更新後原對話讀取、刪除、刪除後召回、清空及清空後召回；驗證持久化、工具回執及宿主狀態，純對話沒有執行任務或工具呼叫。

最新 bundle42 重驗結果（秒，包含模型與應用開銷）：

| 路徑 | Windows | Mac |
| --- | ---: | ---: |
| 儲存記憶 | 92.371 | 24.542 |
| 新對話召回 | 21.807 | 17.988 |
| 清空記憶 | 45.406 | 21.688 |
| 本機無回應服務，應用結束等待 | 61.093 | 60.680 |
| 切回 Ollama，回覆「連接已恢復」 | 10.163 | 9.737 |

無回應服務只綁定各機 `127.0.0.1`，不使用憑據；兩端各記錄一次串流 POST，沒有自動重送。畫面提示意圖識別服務暫時不可用、保留原任務並可重試；該錯誤不一定寫成 assistant 訊息。完成後刪除臨時提供商、停止服務，測試會話切回 Ollama。

## 延遲及失效證據

舊版 Windows 首次掃描 224.293 秒、同版複測 7.785 秒；新版另行啟動測試程序全量掃描 2.016 秒。快取條件不同，不宣稱同條件冷啟動提升。新版首個儲存整輪 92.371 秒已包含收尾；未再重現舊 224 秒收尾。仍保留全歷史校驗，不以略過資料加速。

舊 Mac 曾等待外部模型約 286 秒；現在預設 60 秒限制無資料等待，活動 SSE 會刷新期限。這不代表外部模型推理加快，明確設定的提供商逾時仍受尊重，非串流模式不變。

保留原始失敗：bundle41 首次 240 秒 UI 等待超時後宿主才完成；Windows 一次原對話召回遇提供商不可用，定點複測通過。bundle42 初輪腳本選中隱藏面板、模型切換後未等待頁面更新、提供商顯示名稱誤配，以及人工操作混入舊測試會話，相關紀錄不計入通過證據。修正腳本後獨立會話實測通過；Windows timeout 紀錄的 `turn not_started` 是預期的語義決策前失敗，不是執行任務失敗，恢復記錄無失敗項。

## 未涵蓋

Intel 硬體、Developer ID 公證、Gatekeeper 互動、Finder 拖拽及全產品所有功能未在本批驗收。Mac 為 ad-hoc 簽章內部測試包；記憶跨裝置同步與完整聊天歷史合併未實作於本批。

## 重現命令

Windows 工作目錄： `D:\Users\jiangrui\Desktop\CodeBuddy`. Mac： `/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001`. 沿用 README 的既有建置環境；Mac 測試使用 `--release`。

```text
cargo test --locked --offline -p goose --lib --test codepro_project_memory_tools --jobs 1 project_memory -- --test-threads=1
cargo test --locked --offline -p goose --test codepro_project_memory_tools --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib explicit_no_tools --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib agents::tool_task::tests --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib agents::tool_audit::tests --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose-providers --lib --jobs 1 -- --test-threads=1
cargo clippy --locked --offline -p goose -p goose-providers --lib --tests --jobs 1 -- -D warnings
cargo fmt --all -- --check
```

Windows 審計基準使用新建置的測試程式，設定 `CODEPRO_AUDIT_BENCH_ROOT=C:/Users/jiangrui/.CodeBuddy/profiles/local/audit` 及參數 `agents::tool_audit::tests::completion_scan_existing_history_benchmark --ignored --nocapture --test-threads=1`：退出碼 0，2,016 毫秒。

## 證據

本機忽略目錄內的證據（含會話內容，不提交）：

- `target/memory-cross-chat-20261009/`: 記憶測試及原始／重試日誌。
- `target/memory-cross-chat-20261009/retest/windows-e2e.json`, `windows-refresh-retry.json`, `mac-e2e.json`, `mac-late-clear.json`: bundle41 功能驗收及延後完成記錄。
- `target/memory-cross-chat-20261009/retest/windows-latency42.json`, `windows-timeout42.json`.
- `target/delay-fixes-20261009/`: 提供商／審計／Clippy／建置日誌、退出碼、來源清單、基準、逾時請求及恢復日誌。
- `target/delay-fixes-20261009/mac-evidence/target/macos-acceptance42/`: 安裝驗證、逾時證據及恢復日誌，恢復退出碼 0。
- `target/delay-fixes-20261009/mac-evidence/target/memory-cross-chat-20261009/retest/mac-latency42.json`.

## 安裝包

Apple Silicon bundle42： `target/macos-release-20261009-bundle42/CodeBuddy-arm64.dmg`.

SHA-256: `823a477eeca3d924c034ec20efb0d54a8f85aa00bdfd272b5aa8866e278eefa4`.

Mac 桌面副本： `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261009-bundle42/CodeBuddy-arm64.dmg`.

已安裝的驗收程式： `/Users/erjinyi/Applications/CodeBuddy-Test-20261009-bundle42/CodeBuddy.app`.

Windows 後端 SHA-256： `2c9271093b2c05585db42f95ed9fba8b4ef9ebb5b64cc16d5d11348c25cbc0fc`.
Mac 套件後端 SHA-256： `9c92481bc2e16ddd53a2de1a6fe239e1475eb26b35f82da48e4ecae2c355cedf`.
