# 瀏覽器觀察最佳化與驗收

2026-11-17

[简体中文](computer-use-browser-optimization-2026-11-17.zh-CN.md) · [繁體中文](computer-use-browser-optimization-2026-11-17.zh-TW.md) · [English](computer-use-browser-optimization-2026-11-17.en.md)

## 結果

同一客戶表單與動態搜尋任務，前後各跑 3 次。主模型維持 deepseek-v4.1-flash:1017、極致思考；CUA-S1-Qwen3.5-4B 只識圖、沒有動作工具。最終 6 輪均通過檢查，沒有呼叫 CUA。

| 任務 | 優化前均值 | 優化後均值 | 耗時減少 | 任務正確率 |
| --- | ---: | ---: | ---: | --- |
| 表單 | 34.40 s | 27.66 s | 19.6% | 3/3 → 3/3 |
| 搜尋 | 40.85 s | 31.38 s | 23.2% | 3/3 → 3/3 |

![Comparison](../.local/browser-observation-20261117/浏览器优化前后对比.png)

## 改動

1. 瀏覽器動作直接回傳最新的精簡控制項狀態和新候選，沿用已驗證的原文引用。主模型可以直接執行下一步，減少單獨 observe 往返；需要正文時仍可完整觀察頁面。
2. 保留無障礙節點父子關係，並明確聚合 status/alert 的實際文字。「已選客戶」與同名建議按鈕能夠區分，可直接讀取的欄位無需 OCR。
3. 瀏覽器相同截圖重用上次已完成的識圖結果，限定同輪、同工作階段、同分頁、同導覽版本、同模型與完全相同圖片雜湊。圖片、導覽或目標變化及取消不重用無效結果；當前工具文字回執仍保留。
4. 內建 CUA 的直接讀圖設定涵蓋瀏覽器截圖，僅觀察模型關閉思考且沒有動作工具。主模型思考強度與一般附件圖片問答設定不變。
5. 輸入參數錯誤先拒絕，不提前消耗候選、不派發輸入。真正派發結果不確定時仍消耗候選；動作後讀取失敗保留真實派發事實，不自動重播輸入。舊 node 呼叫保留此前完整觀察過且仍存在的節點。

設計沿用現有 CDP 擁有者，參考 [Playwright ARIA snapshots](https://playwright.dev/docs/aria-snapshots) 的階層結構觀察方式，未複製外部實作或新增相依套件。

## 建置與驗證

- `D:/CodeBuddy-v1`, `main@4c8afad97` + dirty work; `./start-preview.ps1`.
- Runtime PID 28160, Electron PID 17324; started `2026-11-17T21:37:06.9688940+08:00`, bundle written `2026-11-17T21:37:06.9360807+08:00`.
- Runtime SHA256: `949630197931caf5a7a464c5125d5807b7f6c915ba6555ed5460265a30773d3e`.
- Controller SHA256: `12C5E376E02316C6273D24DC7A0FDE9D548049AACB355CA59FEA6238708F97DC`.
- Bundle SHA256: `273C03A705C277FFFD1AB5851CEE4909546CF7582F7AE1618645B83A91EFCF38`.
- 未建立分支、提交、推送、安裝相依套件或製作安裝包；保留其他未提交修改。

| Command | Result / exit |
| --- | --- |
| `vitest run src/workspace-panel/browserControl.test.ts` | 13 PASS / 0 |
| `tsc --noEmit` | PASS / 0 |
| `node --test runtime/tests/vision-routing.test.mjs` (final cache-key regression) | 14 PASS / 0 |
| `playwright test tests/e2e/workspace-browser.electron.spec.ts --reporter=list` | 1 PASS, 13.7 s / 0 |
| `node --test runtime/tests/vision-routing.test.mjs runtime/tests/browser-tool.test.mjs runtime/tests/vision-routing-harness.test.mjs runtime/harness/test/mcp-vision.test.mjs` | 31 PASS / 0 |
| `node --test --test-name-pattern='host.*(capture identity\|image admission\|screenshot)' runtime/harness/test/capabilities.test.mjs` | 3 PASS / 0 |
| `node --test runtime/tests/browser-tool.test.mjs` (final description) | 4 PASS / 0 |

命令使用既有 Node 24 與 ui/node_modules 執行檔。初次 Vitest 路徑誤指 desktop/node_modules，改用既有工作區套件後通過，沒有安裝依賴；第一次重啟等待舊後端結束後才重試。

## 原始執行輪次

| Phase / task | Session | Seconds | Tools | Main requests | CUA |
| --- | --- | ---: | ---: | ---: | ---: |
| after / form | `463855e6-ac1d-43df-9760-c0db9f17aca3` | 27.193 | 6 | 8 | 0 |
| after / form | `2d350f7d-c80f-42ce-bb7b-bb1f9d4572df` | 34.292 | 7 | 9 | 0 |
| after / form | `d1dc9982-5118-4a63-bbb3-71a2d55c6a16` | 21.496 | 5 | 7 | 0 |
| before / form | `19af5992-cbfd-4f3b-8af5-a553ca04ba4a` | 35.231 | 8 | 9 | 0 |
| before / form | `e9b7de3a-33e4-40d8-9e8b-f684035be41a` | 37.881 | 7 | 9 | 0 |
| before / form | `7e0e0f2b-98ac-422e-98a8-0262657b0fcd` | 30.080 | 7 | 9 | 0 |
| after / search | `a094730b-de7d-4d87-a25b-a6377c6c4ca2` | 32.291 | 9 | 11 | 0 |
| after / search | `0c60ccc5-d576-4ff9-a0c1-ca8f768bcec1` | 29.510 | 8 | 8 | 0 |
| after / search | `813540ca-7b4d-426f-a35b-9ef60207f7b3` | 32.328 | 7 | 9 | 0 |
| before / search | `b852a055-c392-405d-8f49-ee8e5f9421d8` | 46.804 | 8 | 9 | 1 |
| before / search | `a75f0367-968a-44e5-a535-692c4ed896b5` | 43.319 | 9 | 10 | 0 |
| before / search | `070d3d63-260c-4634-bee9-ab13cdec1eec` | 32.437 | 7 | 8 | 0 |

## 快取驗證與限制

兩次截圖工具回傳分別為 **6.967 秒、0.833 秒**，實際 CUA 推理 1 次（5.881 秒，0 個動作工具）。每次都重新呼叫 capturePage，重用的是已完成的識圖文字，不能依主模型回覆誤稱為跳過了第二次截圖。

搜尋的工具呼叫均值仍為 8 次，主模型請求 9 → 9.33 次；本批搜尋提速主要來自省去 CUA，並非所有工具往返都減少。表單工具呼叫 7.33 → 6 次。最終主模型請求耗時均值約為表單 23.86 秒、搜尋 25.64 秒，仍是主要耗時。基線採用本次最佳化前的候選介面版本，原始碼身分存於 before-hashes.json。

- Cache session: `1c5db5d0-42af-4b0c-bb6b-94f47e2f6404`. Screenshot calls: 2; CUA sessions: 1; reused observations: 1.
- 開發輪次耗時 44.664 秒，曾出現兩次參數／候選過期錯誤，恢復後填寫正確。保留獨立證據；該輪早於最終修復，不混入最終版本對照。
- 計時為 Harness turn/start 至 turn/end，包含模型與工具，不包含會話初始化與獨立人工核對。順序測試未隨機交錯，遠端負載、快取與模型波動仍影響比較。
- 表單檢查兩個目標欄位、保留帳單信箱與備註、零提交；搜尋檢查查詢、正確候選、未選帳單候選及實際選中結果。最終每輪另有獨立可見控制項核對。基線搜尋第 3 輪有動作與控制項回執，但面板已收起，未保留獨立頁面核對。小樣本任務成功率不等於一般視覺辨識準確率。
- 主模型仍偶爾多做觀察或控制台檢查，剩餘延遲已計入，未隱藏。識圖快取不能修正錯誤辨識。本批未重跑 Mac、安裝包及未變更的原生應用驗收。

## 檔案與證據

- `ui/desktop/src/workspace-panel/browserControl.ts` + `.test.ts`
- `ui/desktop/tests/e2e/workspace-browser.electron.spec.ts`
- `runtime/browser-tool.mjs`, `runtime/vision-routing.mjs`, `runtime/compat.mjs`, `runtime/harness/driver.mjs`
- `runtime/tests/vision-routing.test.mjs`, `runtime/harness/test/capabilities.test.mjs`
- [Data](../.local/browser-observation-20261117/comparison-data.json), [cache evidence](../.local/browser-observation-20261117/cache-validation.json), [source identity](../.local/browser-observation-20261117/loaded-identity.json).
- `.local/browser-observation-20261117/`: raw session exports, timings, visible control readbacks, runtime logs, chart and reproducible analysis scripts. Local evidence remains uncommitted.

[Final process/bundle check](../.local/browser-observation-20261117/final-identity-check.json) · [Runtime hash check](../.local/browser-observation-20261117/runtime-source-check.json) · [Verification summary](../.local/browser-observation-20261117/verification-summary.json)
