# Mac 安裝、更新與解除安裝

開啟 DMG，將 CodeBuddy 拖入 Applications，退出磁碟映像後從「應用程式」啟動。更新時結束舊應用並替換副本，不需清理資料。預設資料位置仍為 `~/.CodeBuddy`，既有自訂位置繼續有效；Windows 安裝流程不變。

安裝版選單「CodeBuddy → 解除安裝 CodeBuddy…」提供「保留資料（推薦）」與「清理應用資料」。前者僅移除目前應用副本；後者清理已知設定、聊天、寵物、快取、偏好和位置記錄。專案預設保留，只有另行勾選才刪除目前資料根目錄的 `workspaces` 與 `backend/workspaces`。外部專案、未知檔案、歷史目錄、其他安裝副本及遷移備份保留。

最終確認顯示路徑和邏輯大小；實際釋放空間可能較少。應用與執行服務結束後才刪除，路徑身分變更時停止，不追蹤符號連結。清理模式嘗試移除專用鑰匙圈項 `local.codebuddy.credentials.v1 / aes-gcm-master-v1` 並重設 `local.codebuddy.desktop` 隱私授權；仍有保留憑證存放區時保留共用金鑰。失敗及殘留逐項記錄於系統暫存目錄 `codebuddy-uninstall-*/result.json`，結束視窗顯示位置。直接拖入垃圾桶不會執行此流程。

此功能僅存在於打包 Mac 應用的原生選單，不提供 Agent/MCP 入口，不改變 Harness 所有權。公開發行仍需適當簽章與公證。

測試：`node --test runtime/tests/macos-uninstall.test.cjs`，桌面 Vitest 目標 `src/storage/macosUninstall.test.ts`。原生建置沿用 `node scripts/build-harness-macos.cjs --arch arm64 --node-license <Node LICENSE>`。隔離邏輯測試以替身驗證鑰匙圈/TCC，真實安裝與解除安裝結果另行記錄。

參考：[Apple](https://support.apple.com/en-ie/102610)、[VS Code](https://code.visualstudio.com/docs/setup/uninstall)、[Homebrew zap](https://docs.brew.sh/Cask-Cookbook#stanza-zap)。DMG 使用 Finder、AppKit 與 hdiutil，沒有新增安裝依賴。

Mac 打包驗證使用隨機命名的暫時鑰匙圈項目，驗證加密、解密、竄改拒絕及 Unicode 後自動刪除；不存取使用者正式主金鑰。
