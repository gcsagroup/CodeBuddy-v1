# 內建工具透過 Harness MCP 接入

本批在 `D:\CodeBuddy-v1` 增加 `runtime/builtin-extensions.mjs`，保持 renderer 凍結。未建立分支、提交或推送；此目錄沒有 Git 儲存庫。模型推理、工作階段、排程及工具許可仍由新版 Harness 與相容層負責。舊程式只使用固定的獨立 stdio MCP 入口，未啟動舊 Agent、舊 ACP server 或舊排程器。

## 接入契約

`builtinMcp(extension,{cwd,dataDir})` 與 `toTestExtension(...)` 為非同步函式：對下列 `type: builtin` 回傳官方 `dsh-mcp-client` 設定，其他類型回傳 `undefined`。`isBuiltinMcp` 檢查是否屬於本模組；`builtinToolNames(name)` 提供已核實固定產物的原工具名稱。`listAvailableBuiltins()` 回傳 `{configKey,enabled:false,available,reason?,extension}`，可用性只證明平台及檔案校驗，真實連線仍呼叫 `driver.testExtension`。

| 原介面擴充 | 固定入口 | 本批真實探索 |
| --- | --- | --- |
| `qwen_computer` | `qwen-computer-use.exe --foreground-input mcp` | 9 項：click、drag、get_app_state、list_apps、perform_secondary_action、press_key、scroll、set_value、type_text |
| `computercontroller` | `goose.exe mcp computercontroller` | 5 項：cache、docx_tool、pdf_tool、web_scrape、xlsx_tool |
| `autovisualiser` | `goose.exe mcp autovisualiser` | 8 項：render_chord、render_donut、render_map、render_mermaid、render_radar、render_sankey、render_treemap、show_chart |

模型使用的工具名為 `mcp__<擴充名>__<工具名>`，權限、啟停及工具允許清單由工作階段相容層統一消費。擴充參數中附加的 command/args/env 不會改變內建固定入口。首次使用及檔案身分變更時核對 SHA256，檔案大小、身分及修改時間變更後重新檢查。

## 目錄與來源

兩個檔案均從原專案 `D:\Users\jiangrui\Desktop\CodeBuddy\ui\desktop\src\bin` 複製至新版 `runtime/tools/bin`，複製前後核對 SHA256。完整來源、時間、大小及授權條款雜湊見 `runtime/tools/provenance.json`。

- `goose.exe`：331,956,224 位元組，SHA256 `8186e7eb25a45e93d4ba29a4b56a1230985a30d5a9b8a7843f571a683f1d8b13`。原 workspace 與根 LICENSE 宣告 Apache-2.0，完整文字位於 `runtime/tools/licenses/goose-Apache-2.0.txt`。
- `qwen-computer-use.exe`：4,736,000 位元組，SHA256 `5b08525ee3825d611a4ef643badbdf15dd55e95816e4f5f15fd06dbe30c5f9b8`。來源目錄包含 MIT 授權，完整文字位於 `runtime/tools/licenses/qwen-computer-use-MIT.txt`。

這些為原專案既有工具產物，本批未重新編譯。來源基線 revision 為 `964bbeb1587f1c5551ee17907e0b26632c4163ce` 並包含未提交變更；現有二進位檔與該原始碼的可重現建置對應尚未驗證。上述寬鬆授權允許在保留授權條款與通知的前提下重用工具；正式安裝包仍需完成間接相依套件的第三方通知清單。條款參考：[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)、[MIT](https://opensource.org/license/mit)。

舊 CLI 的日誌、專案記錄、使用者設定、快取及暫存目錄透過子程序環境指向 `dataDir/tool-runtime/<擴充名>`，不變更宿主環境。`CODEBUDDY_HOME`、舊路徑別名、HOME、USERPROFILE、APPDATA、LOCALAPPDATA、TEMP/TMP 與 XDG 路徑均隔離。已關閉舊工具遙測。工具明確要求儲存的文件仍寫入工作區或使用者指定輸出位置；這些環境設定不是檔案系統沙箱。

電腦動作保留原工具語意：`--foreground-input` 讓輸入前恢復已觀察目標視窗，原 `OPEN_COMPUTER_USE_*` 設定保持繼承。本批沒有額外強制關閉啟動、焦點或文字回退能力。單純 initialize/tools/list 不派發桌面動作。

## 驗證與邊界

`node --test runtime/tests/builtin-extensions.test.mjs` 使用既有 Node.js 24，3 項通過、0 失敗、結束碼 0。暫存目錄測試包括產物/平台校驗、固定命令、環境隔離及父程序環境不變；官方 Harness 實際啟動 3 個服務，探索 22 個工具，並驗證舊 CLI 日誌與文件/圖表快取位於隔離目錄。未執行 tools/call，未點擊、鍵盤輸入或關閉使用者程序。

目前只包含 Windows x64 產物；macOS 明確回報待提供對應產物。此記錄不代表文件編輯、電腦操作、真實模型或完整桌面 E2E 已通過，後續呼叫驗證由主要整合批次另記。
