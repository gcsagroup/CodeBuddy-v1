# 本地功能融合與失敗修復驗收記錄

## 範圍與來源

主目錄 `D:\Users\jiangrui\Desktop\CodeBuddy`、main，合併基線 `b05b297d10e8e7c02160d37c65875108d47b3d42`。原 stash `442a5495fdafcd7b016608782c81d5a785508ee4` 與逐檔備份保留。已依使用者授權融合原本未提交功能，包括 Git MCP、GitHub 登入/登出、macOS、設定與工作區，同時保留同事分支的完成檢查、暫停回答、串流順序與目前活動投影。

## 核心修復

失敗任務與精確證據保存在歷史計畫，新修復/複測承擔驗收。歷史 RecoveryEvidence 不是執行依賴或權限來源；同一 DAG/run 身分、原合同、失敗證據及重試上限繼續校驗。歸檔保留行動預算並移除目前任務映射。共享進程 owner 使用既有 runtime 登記表。負數用量視為未知，暫停回答依宿主事實且無執行工具。修正中文 GitHub 編譯訊息目錄；新增繁體文案補齊，其餘新語言鍵使用英文回退，翻譯品質尚未驗收。

## 自動化驗收

最終退出碼均為 0；完整命令、來源與日誌詳見同名簡體中文版。

| 項目 | 結果 | 日誌 |
| --- | --- | --- |
| 後端相關回歸 | 2212 通過，3 略過 | fusion-rust-final-3.log |
| 上下文壓縮 | 18/18 | fusion-context-final.log |
| runtime 整合 | 18/18 | fusion-runtime-integration-final.log |
| Clippy，警告視為錯誤 | 通過 | fusion-clippy-final.log |
| 前端全量 | 2307 通過，4 略過 | fusion-vitest-final.json |
| 真實 Edge 瀏覽器 | 17/17 | fusion-browser.log |
| Git MCP 真實本地倉庫 | 4/4 | fusion-git-mcp.log |
| 發行/macOS 腳本 | 54/54 | fusion-distribution.log |
| 根啟動腳本 | 2/2 | fusion-root-launcher.log |

恢復專項 273/273、TypeScript、改動檔案 ESLint 與 15 個語言目錄校驗通過。加入啟動診斷日誌後，再次型別檢查及 main.ts ESLint 通過。

## 真實桌面驗收

以專案 `pnpm run start-gui-debug` 啟動目前來源，在 Electron 提交盲測安全整數帳單修復，未提供參考答案，僅操作 `D:\test-codebuddy-merge-20261010`。

會話 `20261010_4`，run `run_eaf9d891-e415-47e0-af48-9184ee8d5f24`。Agent 自行重現、修復並執行 `node --test`，16/16 通過；外部獨立檢查由修復前 18/22 改善為 22/22。原有 9 項測試內容及使用者草稿保留。宿主結構化回執為 `completion_accepted`，持久化終態 `completed`。檔案樹及來源預覽正常，重新載入後完成結果仍正確，未殘留舊暫停狀態。

暫時 shell 權限已逐位元組恢復，SHA-256：`c2271237f1414d0583e44a092c3e5e6a10c4b61368f1c9f747014ef798f6b6a3`。

證據：`desktop-fusion-current-session.json`、`desktop-fusion-summary.txt`、`desktop-fusion-fixture-after.log`、`invoice-independent-after.log`；目錄 `D:\CodeBuddy\.cargo\merge-codebuddy-20261010`。會話、憑據、profile 與本地日誌不提交。

## 邊界與交付

暫態命令會話啟動曾無視窗退出；持久隱藏 PowerShell 執行同一入口後通過。證據支持啟動會話生命週期干擾的判斷，尚未確認完整因果。macOS 真機、安裝包安裝與全部電腦控制情境尚未逐項實測。盲測驗證目前 Windows 編碼與完成持久化流程；歷史失敗歸檔邊界由自動化驗證。提交及推送以最終 Git 回執為準。
