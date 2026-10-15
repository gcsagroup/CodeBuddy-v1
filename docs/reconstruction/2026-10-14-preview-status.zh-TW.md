# Harness 首版預覽：使用與驗收說明

> 歷史記錄：本文描述早期一般聊天階段，已由[基礎能力目前交付記錄](2026-10-14-foundations-status.zh-TW.md)及[功能矩陣](v1-functionality.zh-TW.md)取代。以下待接能力、程序編號及測試數量不代表目前狀態。

日期：2026-10-14。目錄：`D:\CodeBuddy-v1`。本版是 Windows 開發預覽，完整能力遷移繼續依照[總體方案](2026-10-14-harness-refactor.zh-TW.md)推進。

## 版本與原始碼

- 原專案：`D:\Users\jiangrui\Desktop\CodeBuddy`；基線 HEAD：`964bbeb1587f1c5551ee17907e0b26632c4163ce`，包含複製時尚未提交的檔案。逐檔記錄見 [source-baseline.json](source-baseline.json)。
- Harness 套件固定為 `@deepseek-ai/dsh@0.2.1-alpha.2` 和 `@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2`；上游原始碼識別：`d743267388641bc76f17c45ce8b4c231aed1d32c`。
- 原 renderer 介面、樣式、文字、互動與 SDK 原始碼凍結。Electron `main.ts` 調整啟動與隔離；專用啟動器將原 ACP 用戶端連到新版服務。已接通的一般聊天任務透過真實 Harness 執行迴圈運行。
- 使用 Node.js 24、Electron 41.1.0。目前交付方式為開發啟動；尚未製作獨立安裝套件，未建立分支、提交或推送。

## 本版範圍

| 能力 | 目前範圍與驗收邊界 |
| --- | --- |
| 模型設定 | 使用原設定介面管理 OpenAI 相容、Ollama 連線與預設模型；首次啟動開啟原設定頁面。 |
| 一般文字對話 | 原一般聊天 ACP 路徑連接 Harness；正文、上游實際提供的思考增量及工具結果映射至原訊息介面。預設 CodePro 工作台任務尚未接通。 |
| 檔案與 PowerShell 工具 | 在一般工作階段路徑接入 Harness 檔案與 Windows PowerShell 工具；執行前經過原介面的權限詢問，拒絕後不執行。CodePro 工具鏈另行遷移。 |
| 取消 | 在生成過程中處理停止請求，不等待整輪完成後才取消。 |
| 歷史 | 新版工作階段及設定獨立持久化；重新啟動後可列出並回放新版歷史。舊版歷史匯入仍待實作。 |

這些是首版實作範圍。原介面的所有選單與預設 CodePro 入口仍保留；選單可見或模型設定成功不代表 CodePro 新任務已完成遷移。另提供可選的一般聊天入口，以 `CODEPRO_UNIFIED_MODE=false` 開啟原有一般模式，預設入口保持原值。使用者已親自設定 `https://ollama.com` 的 `kimi-k3`，並明確同意保留設定、繼續驗證；真實無工具對話共 3 輪成功，重新啟動後歷史回放與 6 則使用者/助手訊息順序通過。完整任務、真實模型工具執行與取消及其他能力仍待專項驗收。

## 啟動與設定

目前機器已備妥專案本機依賴，兩個入口共用新版資料，啟動器會選擇可用的 Node.js 24：

| 入口 | 用途 |
| --- | --- |
| `D:\CodeBuddy-v1\start-preview.cmd` | 保持原預設 CodePro 工作台路由；可查看原設定與頁面，CodePro 新任務仍待遷移。 |
| `D:\CodeBuddy-v1\start-chat-preview.cmd` | 可選的原一般聊天模式；供目前已接通的 Harness 文字對話使用。 |

按兩下所需入口即可。亦可在 PowerShell 明確指定已驗證的執行環境啟動預設入口：

```powershell
Set-Location 'D:\CodeBuddy-v1'
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' 'D:\CodeBuddy-v1\scripts\start-harness-preview.cjs'
```

啟動器編譯既有 SDK 和語言資源，啟動經過驗證的本機相容服務，再啟動原 Electron 介面。它不執行舊 Rust Agent 的建置或啟動入口。

1. 首次啟動在原模型設定頁面新增自訂服務，選擇 OpenAI 相容或 Ollama，填入自己的位址、金鑰與模型。
2. 儲存時會讀取模型清單，並發送一條簡短模型驗證請求；請求送往填寫的服務，可能依該服務規則計費。
3. 選擇真實預設模型並檢查儲存結果。使用者已設定 `kimi-k3` 並授權保留；後續一般聊天可由 `start-chat-preview.cmd` 開啟。預覽不自動連接原始碼中的預設 LAN 位址。原預設 CodePro 新任務仍待接通。
4. 一般模式的專項驗收順序為：一般文字 → 專用工作目錄中的檔案讀取、寫入與 PowerShell → 停止操作；逐項核對權限提示、工具結果及實際檔案。
5. 結束並重新啟動，核對模型設定，以及專項測試中已生成的新版歷史。請勿將一般模式結果擴大為 CodePro 驗收通過。

Windows 關閉所有視窗會結束本次桌面程序；啟動器隨後回收自己啟動的後端。亦可在啟動終端按 `Ctrl+C` 結束。macOS 的生命週期與發行驗收另行進行。

## 資料、日誌與隔離

- 新版預設資料：`D:\CodeBuddy-v1\.preview-data`；後端狀態：`.preview-data\backend\state.json`。
- Electron profile：`.preview-data\state\electron-app`；Harness 持久化：`.preview-data\backend\harness`。
- 啟動記錄：`.preview-data\logs\preview\launch.json`，包含本次 PID、連接埠、路徑與結束狀態，不含驗證金鑰。
- 日誌：同目錄 `prepare.log`、`runtime.log`、`electron.log`；Electron 主程序日誌位於 `.preview-data\state\electron-app\logs\main.log`。
- 保持原專案與舊版資料獨立；本輪不自動遷移歷史、設定、記憶、憑證或排程。新版儲存的金鑰由 Windows 目前使用者 DPAPI 保護。
- 候選版停用舊更新管道、舊協定註冊、舊版 shim 覆寫與預設 LAN 注入。偵錯連接埠預設關閉；受控驗收可透過 `CODEBUDDY_PREVIEW_DEVTOOLS_PORT` 僅在 `127.0.0.1` 開啟。
- 自動驗收透過啟動器的絕對 `dataDirectory` 參數使用獨立目錄。使用者在該視窗親自設定真實服務後，已明確授權保留；新版後端設定與 Harness 工作階段已儲存至預設 `.preview-data`，原驗收 profile 同時保留。重新啟動後的設定讀取、歷史回放與繼續對話均通過。這是本輪新版資料保留，舊版資料匯入仍待實作。

## 驗證記錄

整合命令 `node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/start-harness-preview.test.cjs` 已通過 40/40，日誌見 `.preview-evidence\automated-tests.log`；下表分組計數包含在這 40 項中，原 UI 的 40 項另行執行。原始碼凍結檢查符合 1069 個檔案。

| 驗證層 | 目前記錄 |
| --- | --- |
| SDK、語言資源、桌面型別檢查 | 已通過，結束碼 0。 |
| 修改檔案 ESLint | `ui/desktop/src/main.ts` 已通過，結束碼 0。原檔既有 Prettier 警告未進行全檔格式清理。 |
| 原 UI/連線/路由測試 | 40 項通過：模型設定/Onboarding 24，連線/路由 16。 |
| 新啟動器 | 4 項通過，涵蓋真實子程序、隔離 profile、首次導覽、故障結束與程序回收。 |
| ACP/provider 相容服務 | 整合回執：20 項通過，含 ACP 14、provider 6。 |
| 真實 Harness driver | 主 Agent 整合回執：9 項通過，使用受控模型協定；含金鑰/header 實際發送及持久化無明文檢查。 |
| ACP → Harness 整鏈 | 主 Agent 整合回執：7 項通過，含父測試 1、子測試 6；真實供應商效果另驗。 |
| Windows 真實 Electron 介面 | 原設定與一般聊天路徑通過：模型設定、3 輪真實對話、重新啟動後歷史回放，以及即時使用者/助手 6 則訊息順序。原 renderer 保持凍結。 |
| 使用者真實模型服務 | `https://ollama.com` / `kimi-k3` 回傳 `CODEBUDDY_HARNESS_REAL_OK`、`CODEBUDDY_HARNESS_RESTART_OK`、`CODEBUDDY_HARNESS_ORDER_OK` 及 token usage；3 輪均未呼叫工具。完整任務、真實模型工具執行與取消尚未驗收。 |
| macOS、安裝套件 | 尚未驗收。 |

真實介面回執見 `.preview-evidence\real-model-ui.json`，截圖見 `.preview-evidence\real-model-restarted.png`。最終交付回執 `.preview-evidence\final-validation.json` 記錄於 2026-10-14 16:11:52（Asia/Shanghai）：已使用 Windows PowerShell 5.1 執行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\CodeBuddy-v1\start-preview.ps1 -OrdinaryChat`，視窗標題為 `CodeBuddy`；Electron 主程序 PID 2196，啟動器 PID 28420，後端 PID 30200，Forge PID 10456。交付實例使用預設 `.preview-data`，偵錯連接埠關閉；使用者/機器環境變數、程序 PATH 與舊協定註冊指紋與啟動前一致。PID 是該次驗收快照，後續啟動以 `launch.json` 為準，其中 `desktopPid` 指 Forge 啟動程序。

## 後續遷移

- 舊版聊天歷史可讀匯入、設定與記憶遷移；未完成的舊任務在新版重新發起。
- 排程遷入後預設暫停，逐項驗證，核對舊版對應排程停用後再啟用。
- MCP 與外掛執行、CodePro 執行及排程、視覺與電腦控制、記憶、技能、配方等完整能力遷移。
- macOS 憑證、工具、真實桌面流程及發行建置；維持先完成 Windows 驗收，再完成 macOS 驗收。
- 正式打包、升級及回復驗證。

遇到未接通的能力應回報明確協定錯誤；不得將空結果、選單存在或自動測試通過視為完整產品驗收通過。

補充狀態：該次交付實例於 2026-10-14 16:14:00 正常退出，桌面退出碼為 0，啟動器及後端均已回收，設定與歷史仍保留。再次試用請雙擊 `start-chat-preview.cmd`。退出核驗見 `.preview-evidence\shutdown-validation.json`。
