# Windows Computer Use 驗收報告 · 2026-11-18

本報告只確認下列 Windows 開發預覽範圍。最終候選版的 17 個驗收輪次全部符合各自合同；目標退出測試驗證安全停止和如實回報，前景恢復包含驗收者手動恢復視窗。這不代表任意軟體、任意任務都沒有錯誤，也不是無人值守成功率承諾。

主模型維持 `deepseek-v4.1-flash:1017`、`max / 極致`。`CUA-S1-Qwen3.5-4B` 透過既有 API 只提供圖像觀察，真實觀察會話沒有工具呼叫。優先直接讀取控制項，主模型判斷，既有 MCP 執行，沒有另建執行核心。Mac/FluidUse、本機權重與安裝包依使用者決定不在本次範圍。

## 本批修正

1. 瀏覽器動作回執保留控制項視圖，正常互動不退回整頁截圖；觀察版本、候選 ID、導覽失效、遮擋和停用保護不變。
2. Windows 輸入後的精簡欄位視圖與截圖分離，按鈕型計算機也可直接讀控制項；缺少視覺事實才完整識圖。
3. 圖像觀察依可見標籤讀值，不推測不存在的欄位。主模型可以使用唯讀觀察結果，但不服從圖片指令、不讀隱藏 HTML 冒充識圖。
4. 主模型重用動作後最新狀態；`verified:false` 只表示宿主沒有替模型裁決完成，不要求再觀察。缺失、等待更新、過期或衝突事實才重觀察。
5. 相同截圖快取依會話、輪次、視窗、導覽、提供方、模型和圖像隔離；減少重複推理，不會修正第一次辨識錯誤。
6. OS 拒絕目標啟用時明確交接。修正前兩次實測反覆嘗試其他啟用方式；修正後先請使用者將指定視窗置前，恢復後重新核對，只補未完成內容。

## 選題與證據

先凍結任務和期望再執行；首次發現測試與同題回歸分開。J18 是本批首次執行的 Selenium 綜合表單，02:14 凍結，首次產品執行即在最終版；包含多行文字、下拉、兩種核取方塊狀態、候選分頁和保留其他控制項，未按 Submit。

題源：[Selenium 動態頁](https://www.selenium.dev/selenium/web/dynamic.html)、[綜合表單](https://www.selenium.dev/selenium/web/web-form.html)、[WindowsAgentArena 檔案清單題](https://github.com/microsoft/WindowsAgentArena/blob/main/src/win-arena-container/client/evaluation_examples_windows/examples/file_explorer/016c9a9d-f2b9-4428-8fdb-f74f4439ece6-WOS.json)、[Jev guard](https://github.com/browser-use/jev-ultrafast/blob/main/scripts/check_guards.py)、[CUA Bench](https://github.com/trycua/cua/tree/main/libs/cua-bench-s1)。WAA 改為隔離目錄與遞迴大小寫匹配；不是完整官方基準分數。The Internet 外網站點連線受阻，保留環境阻斷，本機替代頁另列。

## 同一最終版本驗收

單位秒。Agent 時間是 `turn/start` 至 `turn/end`；後端總時間包含會話準備與結算，不含 UI 派發及渲染。前景交接等待另計。真實畫面、夾具事件、檔案內容與雜湊、持久化結果共同核驗，模型自述不能證明通過。

| ID | 任務 | Agent s | Backend s | Main requests | CUA calls |
|---|---|---:|---:|---:|---:|
| J01 | 多步寄送草稿，保留欄位、不提交 | 24.192 | 28.259 | 8 | 0 |
| J02 | 分頁查找同名有效供應商 | 16.544 | 20.773 | 6 | 0 |
| J03 | 非同步查詢，選擇有效 B 設備 | 22.697 | 26.546 | 8 | 0 |
| J04 | 純圖片七項讀數 | 24.960 | 31.032 | 5 | 1 |
| J05 | Selenium 動態方塊和延遲輸入框 | 46.749 | 52.150 | 10 | 2 |
| J06 | 啟用、填寫、停用控制項並保留值 | 23.060 | 27.608 | 8 | 0 |
| J07 | 計算機 27.4 英吋轉公分 | 32.912 | 39.554 | 8 | 0 |
| J08 | 記事本取代兩處、儲存、核對全文 | 119.662 | 126.581 | 11 | 4 |
| J09 | 遞迴 PNG 清單、保留原檔、桌面開啟 | 85.748 | 92.933 | 13 | 2 |
| J10 | 原生工單多控制項、只產生一次摘要 | 156.837 | 164.278 | 20 | 11 |
| J11 | Esc 中止，無後續寫入 | 58.950 | 67.830 | 10 | 2 |
| J11-resume | 新輪恢復，只補未完成欄位 | 14.581 | 16.690 | 4 | 0 |
| J14 | 寫入後中斷 MCP，重連核對而非重播 | 45.040 | 55.782 | 9 | 1 |
| J15 | 前景衝突後明確交接並恢復 | 86.043 | 97.379 | 11 | 0 |
| J16 | 目標退出，拒絕誤寫並如實回報未完成 | 55.140 | 68.175 | 13 | 0 |
| J17 | 兩次相同截圖只呼叫一次 CUA | 30.558 | 36.175 | 6 | 1 |
| J18 | 首次執行公開綜合表單 | 33.778 | 40.352 | 10 | 0 |


[Before/after](../.local/windows-final-20261118/before-after.png) · [Correctness](../.local/windows-final-20261118/accuracy-comparison.png) · [Cache](../.local/windows-final-20261118/cache-comparison.png) · [All timings](../.local/windows-final-20261118/final-timings.png) · [CSV](../.local/windows-final-20261118/results.csv) · [HTML](../.local/windows-final-20261118/results.html) · [Acceptance gate](../.local/windows-final-20261118/final-gate.json)

## 效能與正確性

圖表每側各一輪，全量多輪資料見 CSV。網路、初始控制項、推理波動及不同資料均標註。舊搜尋曾有一次 114 秒模型請求，舊分頁曾兩次連線逾時；保留全量紀錄，但不以此誇大改善。記事本最終輪約 120 秒、四次 CUA，複雜原生工單約 157 秒、11 次 CUA；模型仍可能選擇較昂貴的完整識圖路徑。工單出現一次狀態失效拒絕，重新觀察後完成，拒絕未派發輸入。功能通過不代表全面提速或沒有多餘呼叫。

正確性圖僅為七項凍結圖片讀數、計算機顯示和記事本完整文字的檢查命中比例，不是通用準確率。舊圖片輪讀隱藏 HTML，即使答案正確仍列路徑違規；兩次前景循環失敗、注入未命中、慢樣本及外網阻斷均保留。[11 月 17 日 O/N 交錯對照](computer-use-acceptance-2026-11-17.zh-TW.md)是歷史證據，不能代替目前版本驗收；舊填兩欄與新取代並儲存也不是相同任務。

## 自動驗證與實作

以下實際執行目標退出碼均為 0；重疊回歸不相加當作獨立數量。Electron 真實瀏覽器測試與模型產品驗收分別記錄。沒有修改 Rust Agent 核心、執行無關全量 Rust 測試或製作安裝包。

| Target | Result | Log |
|---|---|---|
| `browserControl.test.ts / Vitest` | 17 PASS; exit 0 | [view-regression-after.log](../.local/windows-final-20261118/view-regression-after.log) |
| `workspace-browser.electron.spec.ts / Playwright` | 1 PASS; exit 0 | [browser-electron-after.log](../.local/windows-final-20261118/browser-electron-after.log) |
| `TypeScript tsc --noEmit` | exit 0 | [typecheck-after.log](../.local/windows-final-20261118/typecheck-after.log) |
| `runtime/tests/browser-tool.test.mjs` | 5 PASS; exit 0 | [browser-runtime-after.log](../.local/windows-final-20261118/browser-runtime-after.log) |
| `runtime/tests/vision-routing*.test.mjs` | 20 PASS; exit 0 | [vision-final.log](../.local/windows-final-20261118/vision-final.log) |
| `runtime/harness/test/computer-skill.test.mjs + tool-discovery.test.mjs` | 16 PASS; exit 0 | [activation-handoff-host.log](../.local/windows-final-20261118/activation-handoff-host.log) |
| `runtime/harness/test/mcp-vision.test.mjs` | 9 PASS; exit 0 | [after-state-host-test.log](../.local/windows-final-20261118/after-state-host-test.log) |
| `tools/qwen-computer-use: go test ./...` | PASS; 32.354s; exit 0 | [go-activation-handoff.log](../.local/windows-final-20261118/go-activation-handoff.log) |
| `tools/qwen-computer-use: go vet ./...` | exit 0 | [go-activation-vet.log](../.local/windows-final-20261118/go-activation-vet.log) |

- [ui/desktop/src/workspace-panel/browserControl.ts](../ui/desktop/src/workspace-panel/browserControl.ts)
- [ui/desktop/src/workspace-panel/browserControl.test.ts](../ui/desktop/src/workspace-panel/browserControl.test.ts)
- [ui/desktop/tests/e2e/workspace-browser.electron.spec.ts](../ui/desktop/tests/e2e/workspace-browser.electron.spec.ts)
- [runtime/vision-routing.mjs](../runtime/vision-routing.mjs)
- [runtime/tests/vision-routing.test.mjs](../runtime/tests/vision-routing.test.mjs)
- [runtime/harness/tool-discovery.mjs](../runtime/harness/tool-discovery.mjs)
- [runtime/harness/profile.mjs](../runtime/harness/profile.mjs)
- [runtime/harness/skills/computer-use/SKILL.md](../runtime/harness/skills/computer-use/SKILL.md)
- [runtime/harness/test/computer-skill.test.mjs](../runtime/harness/test/computer-skill.test.mjs)
- [runtime/harness/test/mcp-vision.test.mjs](../runtime/harness/test/mcp-vision.test.mjs)
- [tools/qwen-computer-use/main.go](../tools/qwen-computer-use/main.go)
- [tools/qwen-computer-use/observation_test.go](../tools/qwen-computer-use/observation_test.go)
- [tools/qwen-computer-use/desktop-input.cs](../tools/qwen-computer-use/desktop-input.cs)
- [runtime/builtin-artifacts.mjs](../runtime/builtin-artifacts.mjs)
- [runtime/tools/provenance.json](../runtime/tools/provenance.json)

## 使用與限制

在 `D:\CodeBuddy-v1` 執行 `.\start-preview.ps1`，本次預覽保持運行。需要可用的主模型與 CUA API。指定視窗、所需欄位和保留範圍即可；能直接讀控制項的內容優先直讀。操作時避免搶滑鼠鍵盤；Esc 中止本輪桌面輸入，下一輪繼續時先核對當前值。

OS 拒絕前景啟用時需人工將指定視窗置前；目標關閉則如實回報未完成，不寫入相似視窗。API 別名有真實呼叫證據，但未取得遠端權重校驗、GPU 或冷啟動資料，不能用別名證明權重身分。沒有發生額度耗盡，也不能自行重置服務商計費額度或限流。

目標退出輪沒有誤寫，但仍有多餘觀察、被宿主拒絕的讀取範圍變更及兩次唯讀進程查詢，共 55.14 秒。安全通過不代表流程最短。全量表保留 72 個有計時紀錄的輪次，不是 72 個獨立成功任務。

目前 main 工作區修改未提交、未推送，保留其他未提交改動。夾具、會話和逐輪資料在 `.local/windows-final-20261118`，不納入提交。

## Build / Evidence

- Worktree: `D:\CodeBuddy-v1`, `main@4c8afad978b6e893a3545c0859dd5b4824a91223`, dirty. Candidate: `final6-after-state-host`.
- Runtime PID: `10412`; Electron main PID: `46832`; launch: `2026-11-18 02:28:39 +08:00`.
- runtimeHash: `b13b5ffc02fc16e4e909352d0f61cd38f060ad74fb0ae8acdd45aa35fb02b909`
- controllerHash: `051E5FEE7A51277842E7ACF81D0AAA801C8B6CA2DF220330EFAE2410A750A924`
- nativeHash: `8AF5EBF26B61D598382323C2650108F87D84D8A13F2C11055D6BBEA096E637BD`
- visionHash: `B9F2CE79CA45694147A7E1CCF6B6BB62CE43FB23557CE6C45684B82A875E6368`
- discoveryHash: `9DB908163E561C953CB3C429B9EB2AFC9736DB1BD129DDFCD290287695E87A1B`
- profileHash: `91DBC6D6BECE27507BA6A65835DFAB1A579D0834FBF85765F3DE5BC08BBE86F6`
- skillHash: `66A1B0031793BB61DA04563FC52B7376C72943E55D2CBC55C99D00AE6BAED5B1`
- bundleHash: `C2934D38D8B7CB4BD46D52245C88FD6E2B1294C4A5563433DCFEF8B82C26325B`

[Loaded identity](../.local/windows-final-20261118/identity-verified.json) · [Launch receipt](../.local/windows-final-20261118/launch-unified.json) · [Native source manifest](../.local/windows-final-20261118/native-source-manifest.json)

| Case | Session | Evidence |
|---|---|---|
| J01 | `3cb655b4-ec09-4ad6-a860-948289e916ba` | [J01-independent.json](../.local/windows-final-20261118/J01-independent.json) |
| J02 | `1aded07b-58c4-4847-8121-c69fa0ae519a` | [J02-independent.json](../.local/windows-final-20261118/J02-independent.json) |
| J03 | `54a3ea0b-9dfc-4ec2-848a-ed5126f53f51` | [J03-independent.json](../.local/windows-final-20261118/J03-independent.json) |
| J04 | `a5ec7cdc-67cd-4854-8f3e-30f847244381` | [J04-independent.json](../.local/windows-final-20261118/J04-independent.json) |
| J05 | `857c1a8c-731b-49ba-92ba-b9e1699c440c` | [J05-independent.json](../.local/windows-final-20261118/J05-independent.json) |
| J06 | `7b78749c-e1ee-4c0a-9882-8e4b6f44cf77` | [J06-independent.json](../.local/windows-final-20261118/J06-independent.json) |
| J07 | `35e31902-e3b5-45f0-84ee-7dc58bd5d273` | [J07-independent.json](../.local/windows-final-20261118/J07-independent.json) |
| J08 | `93638c27-365d-4317-8948-6ed6961a600a` | [J08-independent.json](../.local/windows-final-20261118/J08-independent.json) |
| J09 | `eb987ad0-7441-4203-9d79-d8e114acbd37` | [J09-independent.json](../.local/windows-final-20261118/J09-independent.json) |
| J10 | `62a100ee-a342-4e63-bf99-ac9e4b8a23ee` | [J10-independent.json](../.local/windows-final-20261118/J10-independent.json) |
| J11 | `d81e5e61-0abf-4117-ae02-2d19a6fd6c1e` | [J11-independent.json](../.local/windows-final-20261118/J11-independent.json) |
| J11-resume | `d81e5e61-0abf-4117-ae02-2d19a6fd6c1e` | [J11-resume-independent.json](../.local/windows-final-20261118/J11-resume-independent.json) |
| J14 | `ac3f61e5-5951-4728-84ae-2723cbc289fd` | [J14-independent.json](../.local/windows-final-20261118/J14-independent.json) |
| J15 | `fa3a730d-f88b-4f75-b43f-97785559211a` | [J15-independent.json](../.local/windows-final-20261118/J15-independent.json) |
| J16 | `905f5011-c963-4e7f-abcb-cb24ff0d0320` | [J16-independent.json](../.local/windows-final-20261118/J16-independent.json) |
| J17 | `467be12a-a670-4bda-a448-f32cc515dba6` | [J17-independent.json](../.local/windows-final-20261118/J17-independent.json) |
| J18 | `93b52177-413b-4e60-a1a2-ab0a74a4d812` | [J18-independent.json](../.local/windows-final-20261118/J18-independent.json) |
