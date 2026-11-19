# Windows 原生控制項優化驗收

主模型 deepseek-v4.1-flash:1017、思考強度 max 不變；CUA-S1-Qwen3.5-4B 經 API 僅辨識圖片，無操作工具。未製作安裝包、未提交或推送。

欄位視圖保留已讀取的正文、按鈕和焦點；一次 full 不再讓同視窗後續動作持續辨識圖片。成功動作導致的標題變更，只沿用同一 PID/HWND 的精確身分；外部改名、輸入衝突、跨視窗不繼承。儲存已確認後不再為重複核驗遞迴搜尋磁碟。

每項新舊各一次固定對照，另兩項預先保留的新任務。真實桌面串行執行，UI 初始內容一致；記事本最終重跑透過 UI 還原未儲存內容，另核對儲存時間與完整檔案。Execution 為 Agent 回合；Service 包含後端準備，不含 UI 傳送及繪製。依檔案和表單事件核對，不以模型自述判定。

限制：最初輪與原生測試爭用桌面鎖，排除計時；僅提供檔名的探索輪誤綁完整標題並委派，已停止，不能宣稱全數修好；中間版 226.708 秒雖已儲存，但多餘磁碟搜尋被停止，完整記錄保留。舊式控制項仍保留必要識圖。本輪小樣本不代表泛化準確率或所有 Windows 軟體無缺陷。

go test ./...（34.451 秒）、go vet、go build 均退出 0；宿主 20/20、路由整合 4/4、最終 skill 3/3 通過。依 .\start-preview.ps1 啟動。

補充：新工單曾使用過期欄位編號，被拒絕後重讀並恢復；57.716 秒包含重試。當前回執未包含部分控制項狀態，不代表 Windows 層必然無法讀取。主模型呼叫數未整體下降（14→14、16→18）。

## Changed files / 改动文件

`tools/qwen-computer-use/main.go`, `observation_test.go`, `README{.zh-CN,.en,}.md`; `runtime/harness/skills/computer-use/SKILL.md`; `runtime/builtin-artifacts.mjs`, `runtime/tools/provenance.json` and rebuilt native binary. Existing unrelated dirty changes were preserved.

## Commands / 验证命令

```text
cd tools/qwen-computer-use
go test ./...
go vet ./...
go build -o ../../target/debug/qwen-computer-use.exe .
# repository root; installed Node 24
node --test runtime/harness/test/computer-skill.test.mjs runtime/tests/vision-routing.test.mjs runtime/tests/builtin-artifacts.test.mjs
node --test runtime/tests/vision-routing-harness.test.mjs
node --test runtime/harness/test/computer-skill.test.mjs
.\start-preview.ps1
```

All checks exited 0; the preview is a running development process, not an installer.

| Case | Execution s | Service s | Main calls | CUA calls | Result |
|---|---:|---:|---:|---:|---|
| before-notepad | 155.255 | 169.677 | 14 | 6 | PASS |
| after-notepad | 69.988 | 74.681 | 14 | 0 | PASS |
| before-native | 109.867 | 121.627 | 16 | 7 | PASS |
| after-native | 83.882 | 87.897 | 18 | 3 | PASS |
| holdout-notepad | 103.728 | 108.540 | 15 | 0 | PASS |
| holdout-native | 57.716 | 62.708 | 11 | 2 | PASS |

## Evidence / 证据

- `before-notepad`: `afe62e13-bef7-44cf-a401-e25d1b5514c1`; `before-notepad-verified.json` / `before-notepad-timings.json`.
- `after-notepad`: `b4fb1440-1c59-468c-b8bf-08acfac7a90a`; `after-notepad-verified.json` / `after-notepad-timings.json`.
- `before-native`: `177b5f97-0732-412b-b136-cc362974c813`; `before-native-verified.json` / `before-native-timings.json`.
- `after-native`: `a25f3a4b-d1e3-43c6-aa62-9dd4bf3aad2d`; `after-native-verified.json` / `after-native-timings.json`.
- `holdout-notepad`: `cd028729-efed-49cd-8845-a82403324cf1`; `holdout-notepad-verified.json` / `holdout-notepad-timings.json`.
- `holdout-native`: `86ff4dee-bf3f-4b74-b2ed-93c9bbcd0b6a`; `holdout-native-verified.json` / `holdout-native-timings.json`.

Source: `D:\CodeBuddy-v1`, main@4c8afad978b6e893a3545c0859dd5b4824a91223 with uncommitted changes. Native `0.2.3-local.22`, SHA256 `c83699118497c15d7bf09284142266d85e02116c436dcb219238bfb3737ef827`.

Artifacts: `.local/windows-controls-20261118/` (results.csv/json, comparison.png, accuracy.png, manifest.json, run-notes.json, logs and per-session receipts).
