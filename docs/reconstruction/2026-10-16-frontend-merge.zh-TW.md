# 2026-10-16 同事前端分支合併

現有 `main` 合併 `origin/codex/dsh-frontend-ux` 的 21 個提交，頂點 `cead742`，本地基線 `692f235`，共同祖先 `01610d0`。不納入 Dependabot、不建立分支或改寫歷史。候選版本 `1.43.5`；`1.43.4` 為合併前保留產物。

保留聊天滾動載入、排隊及停止後傳送、過期審批收起、工具記錄折疊、歷史檔案變更與唯讀子 Agent 目錄／對話。原生子 Agent 繼承父模型及思考強度，Host 為 3 個並行、深度 1；舊角色設定仍保存，但不覆蓋執行選擇。

衝突解決保留本地 MCP 複用、非同步任務、按需發現、階段耗時、Office 工具箱名稱、GitHub 帳戶修復及品牌。權限篩選放在遠端組合綁定之後；不恢復過時核心入口，不遷移資料或憑據，第三方許可及來源保留。桌面 `diff@8.0.4` 已存在本機，沒有安裝依賴。

測試更新為工具先發現、子 Agent 按提示識別、IntersectionObserver 載入歷史、確定性動畫時鐘、真實待處理審批。後端全量 428 項首次 426 通過，兩項舊預期修正後能力檔案 25/25 通過；其餘 403 項沿用同批結果。三子 Agent 整合、展示組件 59/59 及型別檢查通過。前端全量遇到 Windows 記憶體耗盡及 worker 退出，改為分批串行，未宣稱全量通過。

建置：`node scripts/build-harness-windows.cjs target/codebuddy-package-1.43.5/harness-distribution`。證據 `.preview-evidence/h20-*` 留在本地。安裝包、真實模型和介面結果見下方；安裝升級與 macOS 未在本批驗證。

## 最終驗收與產物

後端 428 項均有本批有效通過結果（首次 426/428，修正後能力檔案 25/25）；並非單次全綠。受影響前端 479+59=538 項、另行 Git 快照／擴展彈窗 7 項、型別檢查及補齊 IntersectionObserver 宣告後的 ESLint 均退出 0。完整前端與瀏覽器夾具遇 Windows 記憶體耗盡而中止，不報全量通過。

打包應用真實 Kimi K3 對話：710 ms 顯示會話，5646 ms 首條可見回覆，原生 end_turn（單次樣本）。兩個子 Agent 分別建立 alpha.mjs/beta.mjs，主 Agent 建立 verify.mjs，node verify.mjs 退出 0 並輸出 MERGE_SMOKE_OK；約 35.9 秒。目錄、Alpha 唯讀對話、主會話變更面板及既有 GitHub 帳戶狀態已實際點擊核對。GitHub MCP 在隔離 profile 保持停用。

建置退出 0，內建 Node 24.21.0、Office、原生子程序與服務校驗通過，NuGet 與應用一致。產物 `ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Setup.exe`，363,771,392 位元組，SHA256 `ea7771130bd05a49b0b4b2adc42cc8f958ef2a38a40b45748fbe850ffe9adbf8`。sourceDigest `404fb903c175dd8fbccffb8133e5d96e41f65fd91649695aae3c3d983da443b2`。來源為本記錄所在合併提交的工作區；安裝包不提交 Git。未驗安裝升級、macOS 與全部舊功能。
