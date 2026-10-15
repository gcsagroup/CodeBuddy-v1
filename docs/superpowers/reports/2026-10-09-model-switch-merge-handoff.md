# 模型切換修復：同事合併交接（2026-10-09）

[简体中文](2026-10-09-model-switch-merge-handoff.zh-CN.md) · [English](2026-10-09-model-switch-merge-handoff.en.md)

## 提交與範圍

- 儲存庫：`https://github.com/erjinyi-bool/CodeBuddy`，分支 `main`。
- 程式碼提交：`6d63cb6fa672918796bf527439d326bb46ad284c`。
- 修改前基底：`eadb7cf9852eab5b76ee629d1db0dabf216b7cb3`。本文件為後續獨立提交，可用 `git log -1 -- docs/superpowers/reports/2026-10-09-model-switch-merge-handoff.md` 查詢。
- 僅納入本次模型切換的 9 個檔案增量及三種語言交接文件。沒有新增依賴、公共協定、設定格式或資料庫遷移。
- 工作區既有大量已暫存及未暫存修改，均另外保留；本次不是所有 macOS 開發程式碼的完整快照。

## 已確認的根因

前端下拉清單讀取服務的即時模型列表；既有對話的切換校驗卻讀取提供商設定中的舊列表。現場 Windows 儲存的是 `qwen3.8-flash-next`，服務已提供 `Qwen3.8-27B-direct-A-best15-FP4`，因此介面可選新模型，後端卻以 `Invalid params / Model ... is not available` 拒絕。

之前的回歸僅涵蓋建立提供商及儲存預設模型，遺漏了既有對話的 `provider_model` 切換入口。預設設定已使用即時校驗，對話入口尚未復用；前端又將詳細錯誤替換為統一的「請重試」。

## 檔案與增量

| 檔案 | 本次修改及合併重點 |
| --- | --- |
| `crates/goose/src/acp/server.rs` | `validate_provider_model_selection` 對自訂提供商先復用 `validate_saved_custom_provider_models`。下線模型與離線服務均拒絕，不回退舊快取；內建提供商沿用原路徑。 |
| `crates/goose/tests/acp_unauthenticated_custom_provider_test.rs` | 擴展既有 ACP 測試：即時模型替換、舊列表過期、對話與預設設定一致、模型下線、HTTP 503、失敗後持久化選擇不變。 |
| `ui/desktop/src/components/ModelAndProviderContext.tsx` | 保留 `Promise<boolean>`，增加可選 `onError(message)`。依已知結構化錯誤碼顯示本地化提示，保留回滾及未知錯誤的通用提示。 |
| `ui/desktop/src/components/ModelAndProviderContext.test.tsx` | 涵蓋模型、網路及憑證錯誤；避免顯示私有路徑及原始錯誤正文，拒絕時不寫入預設設定。 |
| `ui/desktop/src/components/settings/models/subcomponents/SwitchModelModal.tsx` | 彈窗保留具體錯誤；保留目前對話守衛、預設模型交易與失敗時不儲存後續選項的行為。 |
| `ui/desktop/src/components/settings/models/subcomponents/SwitchModelModal.test.tsx` | 涵蓋中文具體錯誤、彈窗保持開啟、重試成功，並更新回呼參數斷言。 |
| `ui/desktop/src/i18n/messages/{en,zh-CN,zh-TW}.json` | 新增 `modelAndProviderContext.{modelUnavailable,endpointUnreachable,credentialsRejected,invalidResponse}`；維持 `{defaultMessage: ...}` 物件格式。 |

`server/providers.rs` 的既有校驗會取得即時模型列表並發送最小非串流請求。本次直接復用，沒有建立第二套探測，也未手動修改使用者儲存的模型列表或憑證。切換需要服務在線，可能產生少量模型呼叫用量。

## 同事合併步驟

1. 依團隊流程保存自己的工作，執行 `git status --short` 與 `git fetch origin`。
2. 適合快轉時使用 `git merge --ff-only origin/main`。分支已分歧時先審查 `git log --oneline HEAD..origin/main`，再整合；不要重設或覆蓋自己的修改。
3. 只接收本次修復時，先確認即時校驗 helper、`acpErrorCode`、預設模型交易已存在，再執行 `git cherry-pick 6d63cb6fa672918796bf527439d326bb46ad284c`。缺少基礎實作時先評估前置提交。
4. 雙方均修改模型切換時，保留「先校驗、再修改對話」順序；不要以靜態列表取代即時結果；保留 `updateDefaults`、`onError`、`superseded` 與目前對話守衛。
5. 翻譯衝突依鍵合併，保留其他訊息與物件結構，不要整份檔案採用其中一方。
6. 合併後重新建置後端與桌面程式，重跑相關測試及真實應用流程；舊後端搭配新 UI 不代表修復生效。

前一批已提交的記憶／延遲修復：`7b34092cf`（記憶）、`803f9431b`（稽核）、`bc4ff081d`（等待逾時），文件提交 `eadb7cf98`。詳見[前次交接文件](2026-10-09-memory-fixes-merge-handoff.md)，本次沒有重複提交這些修改。

## 驗證結果

| 層級 | 已驗證結果 |
| --- | --- |
| Windows ACP 整合測試 | 1 項擴展測試通過，使用真實 ACP 通道與受控 HTTP 夾具；結束碼 0。 |
| Mac release ACP 整合測試 | 同一測試通過，結束碼 0。 |
| 兩端前端元件測試 | 每端 2 個檔案、26 項通過，結束碼 0。 |
| Windows 型別檢查／ESLint／i18n／Clippy | 最終均為 0；中途斷言與翻譯型別問題已修正並重跑受影響項目。 |
| 格式及建置 | Rust 格式檢查、Windows 後端建置、Mac arm64 release 後端及安裝包完成。 |
| Windows 真實 Electron | 原對話 `20261009_24` 完成 LAN → Ollama → LAN，約 0.888／4.520／0.942 秒。頁尾、持久化及預設設定一致；下線模型被拒絕，選擇不變。新對話 `20261009_26` 使用新 LAN 模型實際回覆「模型切换正常」。 |
| Mac 安裝版 bundle43 | 對話 `20261009_21` 完成 LAN → Ollama → LAN，約 0.412／4.041／0.435 秒；核對持久化並實際回覆「模型切换正常」。 |

現場 LAN 設定不同：Windows `192.168.9.120:8001`，Mac `192.168.9.101:8001`。Mac 提供 `Qwen3-VL-30B-A3B-Instruct-FP8`。未為測試修改這些既有位址；時間為本次觀測值，不是效能保證。

### 複驗命令與證據

使用 README 規定的既有平台環境；Mac ACP 測試另加 `--release`。

```powershell
# 儲存庫根目錄
cargo test --locked --offline -p goose --test acp_unauthenticated_custom_provider_test --jobs 1 -- --test-threads=1
cargo clippy --locked --offline -p goose --lib --test acp_unauthenticated_custom_provider_test --jobs 1 -- -D warnings
cargo fmt --all --check
# ui/desktop
pnpm exec vitest run src/components/ModelAndProviderContext.test.tsx src/components/settings/models/subcomponents/SwitchModelModal.test.tsx
pnpm exec tsc --noEmit
```

Mac 打包入口：`node ui/desktop/scripts/bundle-macos.cjs --arch arm64 --backend target/aarch64-apple-darwin/release/goose`。

本機證據：`target/model-switch43-20261009/`；Mac：`target/macos-acceptance43/`。日誌、對話匯出及夾具留在本機，不提交 Git；本文件記錄去識別摘要。真實應用驗收使用帶既有未提交修改的工作區建置，不等於對本次純提交快照做了完整驗收；合併後的組合仍須複驗。

## 安裝包與邊界

- Mac 桌面：`~/Desktop/CodeBuddy-Mac-Test-20261009-bundle43/`。
- 已安裝：`~/Applications/CodeBuddy-Test-20261009-bundle43/CodeBuddy.app`。
- `CodeBuddy-arm64.dmg` SHA-256：`805d3207527b351d6ff9213110a08c6684c885c5ed65c8cd009a3cfbd5f9a6f1`。
- DMG 校驗、安裝結構、簽章完整性及後端雜湊一致性通過。Apple Silicon 內部測試包，採 ad-hoc 簽章；Intel、Developer ID 公證、Gatekeeper 互動及 Finder 拖曳安裝未驗收。安裝包、設定及金鑰不提交原始碼儲存庫。

## 另外記錄的現場現象

原記憶清空對話在成功切換後，接續訊息曾觸發恢復判斷等待逾時，原任務維持不變。新對話以同一模型正常回覆。本次沒有修改恢復判斷狀態機或延長逾時，故不宣稱該現象已修復。Windows 的 120 服務隨後又出現連線遭拒，發生於成功回覆之後；服務可用性仍需服務端持續執行。這兩項與已確認的舊列表校驗根因分別記錄。
