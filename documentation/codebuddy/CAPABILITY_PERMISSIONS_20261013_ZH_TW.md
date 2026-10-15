# 工具發現、擴充啟用確認與 Mac 授權診斷（2026-10-13）

[简体中文](CAPABILITY_PERMISSIONS_20261013_ZH_CN.md) · [English](CAPABILITY_PERMISSIONS_20261013_EN.md)

## 證據與修復

Mac 會話 `20261013_1`、`20261013_2` 來自 `c3a537517a464053d090bc1983bafeddd00a79df + dirty`。第一份先查 `list_functions` 就判定沒有桌面能力，但該清單只列代碼模式的唯讀回呼，刻意排除電腦控制；匯出的最終擴充快照不足以倒推第一輪開關狀態。之後兩份會話均有實際 `qwen_computer__list_apps` 呼叫及錄屏權限錯誤，證明那些呼叫時擴充已載入。

SSH 唯讀核對確認兩個程式並存：`/Volumes/CodeBuddy/CodeBuddy.app` 是 `local.codebuddy.desktop`；舊 `~/Applications/CodeAgentPro-Test-20261001-4nejwg57/CodeAgentPro.app` 是 `local.codeagentpro.desktop`。畫面勾選舊程式，並不證明新程式已授權。Swift 助手原先僅做權限預檢，沒有請求系統授權，錯誤也缺少目前程式的身分與路徑。

- `platform_extensions/code_execution.rs`：在保留唯讀回呼定義的同時，附上 ExtensionManager 的實際清單；清單不是執行授權，電腦工具仍使用直接工具介面。
- `platform_extensions/ext_manager.rs`：要求先發現擴充，必要時提出啟用請求並等待批准；已載入狀態與系統權限分開。
- `permission/permission_inspector.rs`：啟用擴充使用既有批准流程，自主模式不預設略過，沿用明確允許/拒絕及會話授權。沒有新增 ACP 介面或持久化格式。
- `extension_manager.rs`：驗證直接電腦工具可被發現，移除後清單失效。
- `tools/qwen-computer-use/macos/{RuntimeContract.swift,runtime.swift,contract-tests.swift}`：已有權限不提示，缺少權限則請求並重新檢查；錯誤列明實際名稱、bundle ID、路徑。doctor 維持唯讀。
- `ui/desktop/forge.config.ts`：加入錄屏與輔助使用用途說明。

ExtensionManager、PermissionInspector、原生助手分別繼續擁有載入狀態、啟用批准與系統權限事實。不以自然語言判定授權，不讀寫 TCC 資料庫；彈窗出現不等於已批准。

## 驗證與交付

- `cargo test -p goose --lib permission::permission_inspector::tests --jobs 1`：53 項通過，退出碼 0，包含新增啟用確認回歸。
- `cargo test -p goose --lib --features code-mode capability_activation_catalog --jobs 1`：1 項通過，退出碼 0；首次新增測試的 MCP 內容方法引用錯誤（退出碼 101），修正後重跑通過。
- `node --test ui/desktop/scripts/macos-package.test.cjs`：15 項通過，退出碼 0。
- Mac 以 `xcrun swiftc -parse-as-library -O -target arm64-apple-macos14.0` 編譯原生合同測試及完整助手；測試和兩次編譯均退出 0。覆蓋已有權限不重複請求、拒絕後仍拒絕、請求後複查與應用身分定位。完整助手保留一條既有 API 棄用警告。

- `cargo test -p goose --lib --features code-mode agents::platform_extensions::code_execution::tests --jobs 1`: 12 項通過，退出碼 0。
- `cargo fmt --all -- --check`, `git diff --check`: exit 0.

- 日誌與輸入雜湊：`target/capability-permissions-20261013/`，僅為本地證據，不納入原始碼提交。

本地來源為 `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce` 加既有與本批未提交修改。Swift 使用雜湊一致的本地修改檔案進行遠端獨立建置，沒有覆蓋遠端不同 revision 的原始碼或應用。

真實系統彈窗、批准/拒絕後的完整桌面流程與微信發送尚未驗收。沒有發訊息、切換應用、修改系統權限、產生安裝包、提交或推送。自動測試不代表已安裝程式已更新。已有「始終允許」授權會沿用；模型仍須提出啟用請求，清單不會自動授權或執行。應從穩定安裝位置啟動目前程式，再依系統提示授權。

參考：[Apple 錄屏權限](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)、[系統請求 API](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess%28%29)。

## 後續 Mac 安裝交付更新（2026-10-13）

本節更新前述原始碼修復階段的「未安裝」狀態。

- 已產生 1.43.2 / arm64 安裝包，位於遠端桌面 `CodeBuddy-Mac-20261013-permissions`；安裝並正常啟動於 `/Applications/CodeBuddy.app`，保留舊應用、設定與歷史。
- 本地原始碼 `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`；遠端 Git 基線仍為 `c3a537517a464053d090bc1983bafeddd00a79df + dirty`。備份後同步 35 個差異檔案，核對 2,054 個建置輸入一致。產物 revision 記錄遠端基線；內容映射見 `source-applied.json`、`delivery.json`。
- 後端 release、bundle、安裝冒煙退出 0。Mac 包裝測試 15 項、擴充元件測試 16 項通過。安裝冒煙涵蓋 DMG、簽章、安装副本啟動、檔案讀寫搜尋、真實 PTY 與 WebContentsView。
- 真實會話 `20261013_3` 使用既有 Ollama / deepseek-v4-pro:0813；缺少錄屏權限時實際顯示 CodeBuddy 系統授權並回報正確路徑。使用者授權重啟後，list_apps 成功傳回 6 個視窗，未重複彈窗，未傳送外部訊息。
- **整體部分通過**：工具成功後仍反覆完成檢查，最終 `paused / completion_blocked`、終態 `interrupted`。權限及視窗列舉成功不等於整輪完成。模型自述不作為宿主成功證據。
- 未驗收停用擴充後的批准卡、輔助功能輸入授權、Gemma/MCP 全套回歸、Intel 或 Developer ID 公證；此為 ad-hoc 內部測試包。
- 首次舊 target 快取建置遇 xet-runtime E0463；沿用當日既有成功腳本的 target 後通過，未清快取、安裝依賴或更換工具鏈。交付腳本改用串流雜湊以相容 Mac 舊 Python，重跑退出 0。
- 本輪沒有額外產品原始碼修改、提交或推送。安裝包、三語說明、回執：`target/mac-update-permissions-20261013/delivery/`。

### Commands and artifact identity

All final commands exited 0 in the established remote build environment:

```text
cargo build --release -p goose-cli --bin goose --target aarch64-apple-darwin --jobs 1 --locked --offline
node ui/desktop/scripts/bundle-macos.cjs --arch arm64 --backend /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/macos-release-20261013/rust-build/aarch64-apple-darwin/release/goose
node ui/desktop/scripts/macos-install-smoke.cjs
node --test ui/desktop/scripts/macos-package.test.cjs
# cwd: ui/desktop
pnpm run test:run src/components/settings/extensions/modal/ExtensionModal.test.tsx
```

DMG SHA256: `ec96e52d8da95f9f9f444885d8347c3978041c84c8529636197361bfcd789b9e`.
Backend SHA256: `5cc9995191d8aae5d610a3b4813188e28ba3f6a3550ca1021786e67c7c930a7c`.
Remote installation evidence: `ui/desktop/out/macos-install-LxevkV/result.json`.
Build logs: `target/mac-update-permissions-20261013/{backend,bundle,install}.log`.
