# Windows 子程序初始化與錯誤彈窗

2026-11-10。`python.exe`、`where.exe` 的 `0xc0000142` 是 `STATUS_DLL_INIT_FAILED`，表示 DLL 初始化失敗，不等於未安裝 Python，也不能直接歸因於模型或安裝包。

鎖定的 Harness ACL 沙箱要求受限子程序繼承主機控制台。本次保留原生執行器、權限及 Job 生命週期：主機設定程序級錯誤模式，保留原旗標；ACL 啟動器在降權前初始化缺少的控制台，沿用隱藏啟動屬性，還原重新導向的標準句柄。已有控制台不變。初始化失敗就回報錯誤，不繞過沙箱。

真實退出碼及 stderr 繼續保留，介面顯示「未成功」。沒有變更系統登錄、全域錯誤報告、ACL 授權、受限 SID 或預設權限。macOS 不呼叫 Win32 API。程式碼位於 `runtime/harness/windows-process-errors.mjs`、`windows-sandbox-startup.mjs`、`windows-sandbox.mjs`、`index.mjs`。

Windows 4 項程序／權限整合測試及 54 項 Harness 回歸通過；Mac 54 項相關回歸通過。包含無控制台主機、隱藏控制台、PowerShell 7／5.1、Python 巢狀程序，以及真正匯入初始化失敗 DLL 的 EXE。錯誤保留為 `0xc0000142`，後續命令能繼續，工作區外寫入仍被拒絕。原始碼桌面版使用本機確定性模型夾具呼叫真實命令，確認失敗顯示與後續執行；這不是模型自主能力驗收。

```text
node --test runtime/tests/windows-process-startup.test.mjs runtime/tests/windows-workspace-label.test.mjs runtime/tests/pwsh-failure-audit.test.mjs
node --test runtime/harness/test/driver.test.mjs runtime/harness/test/capabilities.test.mjs
```

使用既有 Node 24、MSVC、Python；可用 `CB_STARTUP_TEST_PYTHON` 指定 Python，不自動安裝依賴。證據：`.local/windows-startup-20261110` 及測試輸出的暫存目錄。同事電腦尚待新包實測，其他 DLL 損壞、防護軟體或外部程序重設錯誤模式仍可能造成失敗。

依據：[Microsoft SetErrorMode](https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-seterrormode)、[Harness 使用者復現](https://github.com/deepseek-ai/deepseek-harness/discussions/8142)。上游報告不等於同事電腦的根因證明。
