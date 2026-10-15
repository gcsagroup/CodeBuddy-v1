# Mac 清理、重新安裝與電腦控制重測（2026-10-14）

使用者在明確說明原始碼、文件、備份和鑰匙圈範圍後，確認清除遠端 Mac 上 CodeBuddy、舊 CodeAgentPro 的全部相關內容並重新安裝測試。目標為 `erjinyi@192.168.9.106`，macOS 27.0.1 / arm64。Windows 儲存庫、其他 Mac 應用程式與專案、共用目錄、系統統一日誌及系統備份保留。

## 完成項目

- 依精確清單刪除 42 個路徑，包含 29 個使用者安裝副本、專屬設定/快取/對話/日誌、測試工作區、桌面及垃圾桶舊套件，以及 `/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001` 原始碼/Git/建置/備份目錄。
- 停止所屬程序、卸載兩個安裝磁碟；對兩個 bundle ID 執行 `tccutil reset All`，退出 0。清除專屬偏好、Dock 最近使用項目及舊啟動註冊。刪除後另清除 31 條殘留主應用程式/helper 註冊，最終為 0。
- 精確刪除 `codeagentpro / secrets`、`CodeBuddy Safe Storage / CodeBuddy Key`、`CodeAgentPro Safe Storage / CodeAgentPro Key`，退出 0；未讀取密鑰值。新啟動只重建 CodeBuddy Safe Storage；共用 `goose / secrets` 與舊模型憑據均不存在。
- 新候選套件及記錄先保存至 Windows，再清理 Mac。空白狀態核對：舊檔案、程序、安裝磁碟及兩代資料目錄均不存在。可用空間約由 174 GiB 增至 261 GiB；此結果不代表安全抹除或清除所有系統痕跡。
- 從 DMG 重新安裝至 `/Applications/CodeBuddy.app`，簽章及四個關鍵檔案雜湊核對通過。卸載磁碟並刪除傳入 DMG。
- 13:08 主程序 PID `73796`、後端 PID `73800` 均來自新安裝。`~/.CodeBuddy/state/electron-app/logs/main.log` 顯示 `InitializeNew`、React 就緒；資料庫對話數為 0，畫面顯示沒有最近聊天。舊資料目錄及遠端原始碼目錄不存在。

## 來源及驗證

Windows：`main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`；遠端 Git 基底：`c3a537517a464053d090bc1983bafeddd00a79df + dirty`。清理前 2054 個建置輸入的正規化雜湊一致。沿用 Node 24.10.0 / pnpm 11.9.0 和既有 release 後端，重建 Go/Swift 控制層與桌面套件；未重建 Rust、未安裝依賴。

| 檢查 | 結果 |
| --- | --- |
| `node --test scripts/macos-package.test.cjs` | 15 通過，退出 0 |
| `pnpm run bundle:mac --arch arm64 --backend <既有 release/goose>` | 退出 0；包含 Go/Swift 測試、編譯、簽章與 DMG 校驗 |
| `pnpm run test:macos-install` | 安裝冒煙通過，退出 0 |
| 清理、殘留註冊清除、新安裝 | 退出 0，有逐項回執 |
| 新安裝啟動、空白資料 | 畫面、程序、日誌、資料庫已核對 |
| Kimi K3 識圖、焦點/輸入、權限恢復 | 尚未完成 |

SSH 包裝器在三個成功階段後因結尾 CR 返回 1，各階段退出碼均為 0。清理最初兩次因權限重置需要註冊項、重複註銷已移除路徑而在刪除階段前停止；修正順序與候選範圍後完整退出 0。失敗原始記錄保留，不記為產品測試失敗。

版本 1.43.2 / arm64 / ad-hoc，未公證。DMG SHA256：`6d4f51e36b221da6501f239e731dfef2f5cc7370acc66df19cf5be0f51189c30`；安裝後 goose：`fdabb89890c7a00ac36e04735ea08c29f98b35dd431aac8b3582b1149538af49`；原生執行層：`4e2b259f1f0c630ca8e0196c579b020b372b1bfa0c5c87002a561daa0e995187`。

13:10 系統回報 `CGSSessionScreenIsLocked=Yes`，RustDesk 停留在 13:08，已停止 UI 操作並請使用者解鎖。舊模型密鑰已刪除，需在應用程式內重新設定 Ollama，實機模型統一使用 `kimi-k3`；系統權限與登入密碼由使用者處理。

解鎖後依序驗證即時畫面、模型設定、唯一安裝路徑、錄屏/輔助使用權限、唯讀觀察、獨立測試夾具輸入及權限恢復。未發送外部訊息；電腦控制產品 E2E 尚未通過。本輪無產品原始碼修改、提交或推送。證據與候選套件位於本機 `target/mac-clean-retest-20261014/`，不提交。
