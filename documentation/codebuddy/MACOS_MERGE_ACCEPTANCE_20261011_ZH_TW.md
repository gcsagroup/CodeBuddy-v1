# Mac 主目錄融合修復與驗收記錄（2026-10-11）

## 本次結論

依下表區分自動化、原生安裝包和真實介面驗收。此記錄涵蓋目前 main 加本次修復；未執行的範圍仍標記為 NOT_RUN。

**PARTIAL_ACCEPTANCE — Kimi/native gates PASS; DeepSeek completion BLOCKED**

已修復本次 Mac 平台契約與測試夾具問題，Windows/Mac 最終自動回歸通過，最終 arm64 DMG 與真實安裝副本通過；Kimi 完成整套 10 項真實介面驗收。整體尚非全綠：原主模型 DeepSeek 在最終副本仍未提交完成核驗，只能確認檔案已正確寫入和讀回，宿主保持暫停。新增恢復指引並未在這個模型上解決該問題，保留為後續模型相容性/完成鏈路缺口；未調低完成標準，未更改預設模型。

## 修復內容

- 補齊 Unix 測試 Agent 的工具與命令契約：使用實際提供的工具、每輪一條測試命令，回報真實退出碼；純文字任務使用 read_document 核對內容，未執行動態測試時回報 NOT_RUN。權限檢查與完成證據要求沿用現有設計。

- 修正測試夾具中的 Windows 路徑、CMD 和 Python 可執行檔假設。Unix hook 夾具以 sh 執行其一般檔案；宿主驗證夾具執行實際 Python 測試，並核對只執行一次。新增 Unix 活動展示測試及原生 Python 執行測試。

- 補上 Mac 專用 ActivePromptRun 測試初始化器的 durable_execution_bound；人工核對 Unix 提示快照與目前 main 的工具註冊結果。

- 加強主 Agent 完成拒絕後的恢復指引：讀取目前要求和真實回執，再以已有回執提交核驗；未核驗的部分具體交接，保留已完成工作。指引與結構化完成事實分開，未更改權限、要求或宿主完成門檻。

## 驗收結果

| Check | Exit | Result | Evidence |
| --- | --- | --- | --- |
| Mac SDK/locale build + TypeScript | 0 | PASS | sdk-build.log / locale-build.log / typecheck.log |
| Mac frontend | 0 | 60 passed | frontend-native.log |
| Mac package contracts | 0 | 41 passed, 8 skipped | mac-package-contract.log |
| Mac Git MCP | 0 | 3 passed, 1 Windows-only skipped | git-mcp-native.log |
| Mac backend regression | 0 | 2130 passed, 0 failed, 5 ignored | backend-final-recovery.log |
| Mac context | 0 | 18 passed | context-repaired.log |
| Mac Clippy | 0 | PASS, 6 retained platform warnings | clippy-final-recovery.log |
| Windows backend regression | 0 | 2213 passed, 0 failed, 3 ignored | windows-final-recovery-regression.log |
| Windows final fixture | 0 | 1 passed | windows-final-fixture.log |
| Windows final strict Clippy | 0 | PASS | windows-final-recovery-clippy.log |
| Format + diff checks | 0 | PASS | cargo fmt --all -- --check / git diff --check |
| Mac runtime integration | 0 | 18 passed | runtime-repaired.log |
| Mac native package/install | 0 | PASS; final-source arm64 DMG + copied installed application | cli-repaired.log / package-repaired.log / installed-final-result.json |
| Mac actual UI / original DeepSeek | 1 | FAIL: correct file; host completion_blocked; 2/10 checks | deepseek-final-result.json / deepseek-final-authority.json |
| Mac actual UI / Kimi | 0 | PASS: 10/10, committed completion + persisted terminal | kimi-final-result.json / kimi-final-authority.json |
| Mac native ACP workspace/restart | 0 | PASS: 8 lifecycle/boundary checks | workspace-restart.log |
| Private test credential cleanup | 0 | PASS: removed after both tests; formal profile/Keychain untouched | credential-cleanup.json |

## 平台邊界

Mac/Unix 的技能匯入及 held-object 清理寫入仍依既有設計受限。Windows 寫入成功/回滾測試只在 Windows 執行；Unix 補上拒絕寫入、設定位元組和任務資料原樣保留的測試。這些功能的 Mac 寫入能力尚未開放，通過拒絕測試不代表完整功能對齊。Intel Mac、跨應用電腦輸入/TCC、Developer ID 公證與 Gatekeeper/Finder 安裝驗收未執行。

## 環境、備份與失敗歷史

macOS 26.6.2 arm64、16 GB RAM；原生 Rust 1.96.1/Node 24.10.0。Mac 舊目錄的二進位 patch、未追蹤檔案、原生啟動器及 stash 已保留。使用 Git bundle 快進到 21b5582f9b0cc645ba096d560eb6291d15f7e7b2，再同步修復檔案雜湊；既有安裝副本保持原狀。

第一輪 2086 通過、48 失敗；指定原生 PATH、TMPDIR=/private/tmp 和單執行緒後，2106 通過、28 失敗。修復後一輪為 2128 通過、1 失敗（目錄觀察不是動態驗證證據）；改用實際測試夾具後進行最終回歸。中途主動終止的編譯與一次夾具缺少匯入導致的編譯失敗均保留，未計入通過。Windows 預設測試執行緒栈曾溢位；沿用倉庫 CI 的 RUST_MIN_STACK=8388608 後完整回歸通過。

## 憑據與來源

使用者授權將 Windows 主模型的必要設定/一項憑據傳至 Mac 隔離驗收環境，模型預檢取得 HTTP 200 和實際回覆。憑據只供測試子程序環境使用；不寫入正式 Mac 設定或全域 Keychain，不提交 Git。原 Windows 殼層權限檔案已於先前驗收後恢復。

## 原生驗收與證據

```text

Source base: 21b5582f9b0cc645ba096d560eb6291d15f7e7b2 + tested repair-source-manifest.json (8 files)
CLI SHA-256: 337ec245bbaa267596eb41d09b00acb8f565f8fd92dc78d83131043411286ec6
DMG SHA-256: a92dc22bb0c655808cecfb5ce5f8f9b626911c87e1182d8369da4afa937d4305
App version: 1.43.2; arm64; deployment 14.0; signing: ad-hoc
CLI release build: 20m 32s; exit 0
Manifest records dirty=true because repair commits followed acceptance.
Raw source hashes are provenance, not canonical Git blob hashes.

/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/ui/desktop/out/macos-install-XDZwnT/installed/CodeBuddy.app

/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/ui/desktop/out/CodeBuddy-darwin-arm64/CodeBuddy-arm64.dmg

```

Kimi：一般新任務入口→實際模型寫入→磁碟位元組核對→run_completed→會話 turnTerminal completed→重載保留→檔案樹/預覽/編輯/儲存 Unicode→取消關閉保留草稿→真實 PTY 鍵盤輸入與工作區 cwd→WebContentsView 本機及公開 HTTPS，10/10 通過。DeepSeek 同一安裝副本只通過入口與正確檔案兩項；實際回執為 run_paused/completion_blocked，而非完成。Kimi 並未證明所有模型相容。兩輪各自使用隔離 profile，未重播已完成動作；私有憑據檔已移除。

```text

Local: D:\Users\jiangrui\Desktop\CodeBuddy\target\macos-merge-acceptance-20261011

Remote: /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/macos-merge-acceptance-20261011

Source: repair-source-manifest.json

Windows backup stash: 442a5495f

Mac backup stash: ad5c457ee

```

## Commands

```sh

cargo test --locked --offline -p goose --lib --release --jobs 1 -- agents:: acp:: context:: permission:: --test-threads=1

cargo test --locked --offline -p goose --lib --release --jobs 1 -- context_mgmt:: --test-threads=1

cargo test --locked --offline -p goose --test codepro_runtime --release --jobs 1 -- --test-threads=1

cargo clippy --locked --offline -p goose --lib --release --jobs 1

cargo build --release -p goose-cli --bin goose --target aarch64-apple-darwin --jobs 1 --locked --offline

node scripts/bundle-macos.cjs --arch arm64 --backend /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/aarch64-apple-darwin/release/goose

node scripts/macos-install-smoke.cjs

cargo test --locked --offline -p goose --lib --release --jobs 1 -- main_agent_ rejected_completion_feedback --test-threads=1

```

原主模型 DeepSeek 的兩輪真實任務已寫入並讀回正確檔案，但未提交完成核驗，宿主保持 completion_blocked；模型口頭完成不是通過。本次新增已有回執的恢復指引。首次指引位置破壞舊 JSON 解析的回歸測試已揭露並修正，最終 Windows 2213/Mac 2130 通過。Kimi 在較早安裝副本已通過 10 項真實介面流程；下表只以最終重新構建副本的結果作本次交付依據。

## Source SHA-256 (raw tested files)

```json
{
  "crates/goose/src/acp/server/custom_dispatch.rs": "67afe08e70b5af8b16ba41b4f7b56c8a9f5a33ad88df6f15d5aa779ac0ce56f1",
  "crates/goose/src/acp/server/onboarding.rs": "f13eaacae6a193ea49a86d6500f64d56995c45e2145aa08fd9d6ddda680cb3ec",
  "crates/goose/src/agents/agent.rs": "20195ea3113e638910f1540651ba286b38b18ecbbb3a10005baff015e85daf2f",
  "crates/goose/src/agents/codepro_state_store.rs": "beb7b8a67be790d5f6f01bea0bebc3ebf4ee5fe3203270b49960f602be31b28c",
  "crates/goose/src/agents/snapshots/goose__agents__prompt_manager__tests__all_platform_extensions.snap": "0699a5bb55721b17f5575e4b8f66c0da2e39ed13313c8400a4d69f1c7b56cb23",
  "crates/goose/src/agents/task_scheduler.rs": "ec58622c0735782b0f8dc5e4cb668b97628593e3131fd825f7faaec26e1500ca",
  "crates/goose/src/agents/tester_runtime.rs": "b3b972639f0d3004fec59fbb8fa5bdbefaa557c170a1d6ae7ab0964f773220e0",
  "crates/goose/src/agents/tool_execution.rs": "7d9743feff5f0dc2b0a596dc8070664e2464e66013cb8e0b3e890d84ff98fb56"
}
```

## Windows final verification commands

```powershell
$env:CARGO_PROFILE_DEV_DEBUG = "0"
$env:CARGO_INCREMENTAL = "0"
$env:RUST_MIN_STACK = "8388608"
cargo test -p goose --lib --jobs 1 --offline -- agents:: acp:: context:: permission:: --test-threads=1
cargo clippy -p goose -p goose-providers -p goose-provider-types -p goose-sdk-types --lib --jobs 1 --offline -- -D warnings
cargo fmt --all -- --check
git diff --check
```
