# CodeBuddy 名稱統一與相容讀取

## 範圍

來源：main / c3a537517a464053d090bc1983bafeddd00a79df 加本次未提交變更。統一產品名稱、視窗／選單／托盤、模型身份提示、15 種語言資源、套件及安裝標識、環境變數、啟動與驗收腳本、原始碼識別符、檔名、文件路徑與 GitHub 連結。保留 upstream goose、CodePro 工作模式及第三方專案的名稱。既有 Windows PTY 打包修復保留。

## 已批准的相容方案

- 新安裝預設使用 `.CodeBuddy`；若新目錄尚不存在而 `.CodeAgentPro` 已存在，直接使用原目錄。明確指定的新 HOME 優先，不複製、搬移或刪除原資料。
- 舊 `CODEAGENTPRO_` 啟動變數作為相容別名；新 `CODEBUDDY_` 值優先，空值仍按原校驗規則處理。
- 系統憑據命名空間、設定 revision 欄位、歷史證據指紋及未完成清理的隔離目錄格式保持穩定。這些舊識別符是讀取既有資料所需的格式，不是介面品牌。
- 讀取既有提示檔、遷移紀錄、舊產品深層連結與 ACP metadata；新介面與新發出的連結使用 CodeBuddy。保留既有自訂模型選擇與位址，原專案既有的設定欄位正規化機制繼續執行。
- Windows 安裝名稱改為 `CodeBuddy-Setup.exe`；macOS 為 `CodeBuddy.app`，bundle ID 為 `local.codebuddy.desktop`。新 bundle ID 的系統權限需由系統重新確認。既有正式安裝與此前生成的安裝包均未就地修改。

## 驗收與交付

本文件的提交狀態記錄驗收完成時的情況；後續提交與推送以 Git 歷史為準。

證據位於本機 `target/brand-*.log`、`target/brand-*.exit`，完整改名清單和修改前備份位於 `target/brand-rename-manifest.json` / `target/brand-rename-backup.zip`，均不納入 Git。此次尚未提交或推送；舊安裝包不代表本次原始碼。

### 已執行檢查

以下命令於此次修改所在目錄執行。前端工作目錄為 `ui/desktop`，Rust 工作目錄為儲存庫根目錄。

| 檢查 | 實際結果 | 證據 |
| --- | --- | --- |
| `pnpm run typecheck` | 最終原始碼複測結束碼 0 | `brand-typecheck-final.log` |
| `pnpm run i18n:compile` / `pnpm run i18n:check` | 結束碼 0；15 種語言、2728 個訊息識別符校驗通過 | `brand-i18n.log` / `brand-i18n-check.log` |
| `pnpm run test:distribution` | 最終 51/51 通過，結束碼 0 | `brand-distribution-final.log` |
| Vitest，限定儲存、連結、憑據啟動、圖示與載入元件等 9 個相關檔案 | 87 通過、4 跳過，結束碼 0 | `brand-vitest.log` |
| 任務續接與清理恢復元件，限定 3 個相關檔案 | 28/28 通過，結束碼 0；協定欄位穩定後其中 2 個檔案再驗 21/21 通過 | `brand-acp-vitest.log` / `brand-acp-wire-final.log` |
| `pnpm run test:macos-package` | 在 Windows 執行的打包邏輯測試 15/15 通過，結束碼 0；不是 Mac 真機驗收 | `brand-mac-package-tests.log` |
| `pnpm run build-goose-sdk` | 結束碼 0 | `brand-sdk.log` |
| `cargo fmt --all -- --check` | 最終結束碼 0 | `brand-format-final.log` |
| `cargo test -p goose --test codebuddy_storage_paths --jobs 1 --locked --offline` | 最終原始碼 5/5 通過，結束碼 0 | `brand-rust-final.log` |
| 原始碼、檔名及 Word 文件完整性檢查 | 117 個重新命名目標存在；舊檔名清零；三份匯報 DOCX 的 XML 無舊品牌且 ZIP 校驗正常 | `brand-source-audit.json` |

最初分發測試發現本機產生的 Windows shim 仍為舊文案，依新的已追蹤原始碼同步後複測通過。舊快取仍保留，新增隔離測試驗證舊快取複用、新快取優先且不下載。最初格式檢查也已修正並複測。對應失敗日誌保留，最終狀態以本表及桌面驗收段列出的證據為準。

開發後端的另一套編譯配置曾觸發全量編譯，該次建置已主動中止，結束碼 1；它不計入通過結果。直接 CLI 建置首次因終端未載入 LLVM 定位設定結束 101；使用專案既有 `resolveWindowsBuildEnvironment()` 初始化 Windows SDK 後，相同預設 debug profile 下的 `cargo build -p goose-cli --bin goose --jobs 1 --locked --offline` 成功，結束碼 0，證據為 `brand-cli-build-final.log`。新執行檔執行 `goose.exe --version` 傳回 `1.43.0`，結束碼 0；這是上游後端版本，桌面套件版本仍為 `1.43.2`。

### Windows 真實桌面驗收

執行 `node target/brand-native-smoke.cjs`，透過專案正式的 `pnpm run start-gui` 啟動目前原始碼及本次編譯的後端，結束碼 0。證據為 `target/brand-native-smoke-accepted.log`、`target/brand-native-7JRhw5/result.json` 與同目錄 `desktop.png`。

隔離設定只建立舊 `.CodeAgentPro` 目錄並使用舊啟動變數，實際視窗標題與介面顯示 CodeBuddy；應用程式繼續使用舊目錄，保留資料標記、模型選擇及端點，未建立新資料目錄。透過真實 Electron 工作區介面讀取並儲存檔案成功。模型設定依原有機制規範化欄位，驗證的是設定值保留。前兩次測試夾具分別因關閉標準輸入、斷言舊欄位位置而中斷，修正夾具後複驗通過。

邊界：本輪沒有執行模型任務或微信傳送；Mac 真機尚未複驗，新 Windows／Mac 安裝包尚未重新產生。本輪原始碼尚未提交或推送。

### 相容格式細節

舊 ACP 欄位名繼續作為穩定的發出格式，讀取端同時接受新名稱；這避免新前端與既有後端的任務續接失配。原始碼中保留的舊名稱只用於相容欄位、資料目錄、憑據、歷史指紋及其測試或說明。舊連結可被應用程式解析，不代表系統已為新安裝重新註冊舊協定。Windows 既有可攜 Node 快取繼續依版本標記複用。
