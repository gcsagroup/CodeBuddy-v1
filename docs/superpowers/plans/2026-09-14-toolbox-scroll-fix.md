# 工具箱開關捲動跳頂修復

2026-09-14

原因：ToolboxView 每次重新整理皆進入整頁載入狀態，暫時移除全部工具卡片，捲動內容高度驟降，導致瀏覽器將位置調整至頂部；進階分組也會重新建立。

修復：載入提示僅用於首次載入。後續開關及重新整理保留清單節點，只更新回傳資料；使用請求序號避免較早請求覆蓋較新的工具狀態。工具權限及設定儲存介面維持不變。

專項驗證：4 個測試檔案、27 項通過，退出碼 0。新增回歸涵蓋連續啟用/停用期間節點及展開狀態保持，以及非同步請求亂序回傳。

原生桌面驗收：以獨立設定啟動 Electron，透過真實滑鼠捲動至清單中下方，停用並重新啟用任務委派，位置不變；展開進階分組，在頁面下方啟用任務清單，位置及展開狀態不變；Ctrl+R 後搜尋任務清單，確認啟用狀態已儲存；於搜尋結果中停用任務清單，搜尋條件保留。測試前開關狀態已恢復，使用者原視窗未變更。

完整驗證通過：227 個測試檔案全部通過，2009 項通過、0 失敗、4 跳過；型別檢查、全前端 ESLint、修改檔案 Prettier 及正式建置皆退出 0。建置有第三方 use client 指令及較大分塊警告，無建置失敗。測試後原始碼雜湊未變。

此修復保留已載入清單，未新增捲動位置持久化；主動重新載入頁面仍遵循既有初始化行為。舊安裝包尚未重新打包。

Evidence: `.cargo/evidence/toolbox-scroll-20260914/` (`source.json`, `native-evidence.json`, `gates.json`).

```text
# cwd: D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/components/toolbox src/acp/toolbox.test.ts --maxWorkers=1
pnpm exec vitest run --maxWorkers=1
pnpm run typecheck
pnpm exec eslint "src/**/*.{ts,tsx}" --max-warnings 0 --no-warn-ignored
pnpm exec prettier --check src/components/toolbox/ToolboxView.tsx src/components/toolbox/ToolboxView.test.tsx
pnpm exec vite build --config vite.renderer.config.mts --outDir .vite/renderer/toolbox_acceptance
```
