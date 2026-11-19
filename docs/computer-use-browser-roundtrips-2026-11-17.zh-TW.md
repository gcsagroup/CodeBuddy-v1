# 減少主模型重複觀察：瀏覽器實測

2026-11-17

[简体中文](computer-use-browser-roundtrips-2026-11-17.zh-CN.md) · [繁體中文](computer-use-browser-roundtrips-2026-11-17.zh-TW.md) · [English](computer-use-browser-roundtrips-2026-11-17.en.md)

主模型維持 deepseek-v4.1-flash:1017，思考強度維持 max（極致）。CUA-S1-Qwen3.5-4B 仍只識圖。本輪僅修改瀏覽器觀察與工具說明，未修改模型選擇、推理強度或視覺路由。

| Task | Before / s | After / s | Reduction | Passed |
| --- | ---: | ---: | ---: | --- |
| form | 27.660 | 19.007 | 31.3% | 3/3 → 3/3 |
| search | 31.376 | 18.627 | 40.6% | 3/3 → 3/3 |

![Comparison](../.local/browser-roundtrips-20261117/浏览器优化前后对比.png)

六輪獨立 observe 呼叫從 16 降至 0，console 從 1 降至 0。最終每輪均為四次工具呼叫、五次任務模型請求，工具錯誤與 CUA 呼叫皆為零。任務模型平均耗時為表單 14.67 秒、搜尋 14.05 秒，仍是實測主要耗時。

開啟頁面直接回傳精簡控制項、候選與文字引用，省去單獨觀察與補登記文字的往返。明確呼叫 observe 預設仍含頁面正文，可用 view=controls 取得精簡控制項。文字引用在同頁觀察間保留，空陣列清除，導覽自動清除。

動作後讀取真實控制項，約每 80 ms 檢查變化；連續約 240 ms 不變或輪詢預算約 800 ms 時回傳。非同步搜尋建議可直接使用。單次讀取與排程不保證硬性超時，安靜間隔也不表示業務完成，缺失結果仍應繼續觀察。

主模型根據動作回執最新值判斷完成；verified:false 表示宿主不代替模型判斷完成。資訊不足才重新觀察，無須固定的最終截圖、觀察或主控台檢查。保留候選失效、遮擋、焦點變化與不確定寫入的防重複執行邊界。

開發階段兩輪表單耗時 21.172 / 22.206 秒，均正確，但各有一次遺漏分頁 ID 的拒絕呼叫。現已將分頁 ID 前置，說明每個候選動作須同時傳 id、observationId、candidateId。保留開發證據，不混入最終六輪。

基線採上一批最終版本的六輪真實產品任務，不是更早的初版。本版重啟後，分別以新對話執行相同表單與搜尋提示詞三次；表單僅改 N1/N2/N3 輪次標籤。頁面與 160 ms 非同步搜尋延遲保持不變。

正確率檢查實際結果：表單兩個目標值、保留帳單信箱及備註、提交次數 0；搜尋詞為海風、選擇海風測試、未選海風帳單、已選客戶值正確。最終六輪均有獨立 Windows 可見控制項讀回，不以 Agent 自述代替。

計時從 Harness turn/start 至 turn/end，含模型、工具與錯誤恢復，不含對話建立、傳送前等待與獨立驗收。介面計時可能較長。前後未隨機交錯，網路、遠端負載、快取及模型路徑有波動；三輪均值不是普適保證，任務正確率也不是一般視覺準確率。

自動檢查：Vitest 瀏覽器控制 16/16、執行階段 browser-tool 5/5、TypeScript --noEmit、真實 Electron 整合 1/1，退出碼均 0。最後僅調整回執屬性順序與工具文字，執行階段 5/5 再次通過；最終六輪在該調整重啟後執行。未跑安裝包、Mac 或未受影響的原生應用全套驗收。

原始碼與交付：D:\CodeBuddy-v1，main，revision 如下，包含本次及既有未提交變更。未建立分支、未提交、未推送、未封裝。使用倉庫 .\start-preview.ps1 建置啟動。

| Phase / task | Session | Seconds | Tools | Main requests | CUA | Errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| after / form | `c7387663-9bbe-441b-a421-5a06d98e2702` | 17.500 | 4 | 5 | 0 | 0 |
| after / form | `f651375d-46f1-4cea-b2ec-dac59d0a562a` | 19.765 | 4 | 5 | 0 | 0 |
| after / form | `819dd277-d858-44a4-9a40-1486587f1188` | 19.755 | 4 | 5 | 0 | 0 |
| before / form | `463855e6-ac1d-43df-9760-c0db9f17aca3` | 27.193 | 6 | 7 | 0 | 0 |
| before / form | `2d350f7d-c80f-42ce-bb7b-bb1f9d4572df` | 34.292 | 7 | 8 | 0 | 0 |
| before / form | `d1dc9982-5118-4a63-bbb3-71a2d55c6a16` | 21.496 | 5 | 6 | 0 | 0 |
| after / search | `c748fe22-c875-4d06-9746-0784e44f680f` | 15.805 | 4 | 5 | 0 | 0 |
| after / search | `22bc5d3f-25c7-47fd-adac-b3001b47ac6c` | 20.728 | 4 | 5 | 0 | 0 |
| after / search | `98fbce58-bd9e-430a-9541-98cb928d329f` | 19.347 | 4 | 5 | 0 | 0 |
| before / search | `a094730b-de7d-4d87-a25b-a6377c6c4ca2` | 32.291 | 9 | 10 | 0 | 0 |
| before / search | `0c60ccc5-d576-4ff9-a0c1-ca8f768bcec1` | 29.510 | 8 | 8 | 0 | 0 |
| before / search | `813540ca-7b4d-426f-a35b-9ef60207f7b3` | 32.328 | 7 | 8 | 0 | 0 |

主模型請求數排除明確標記為 session-title 的自動標題呼叫；任務判斷全程為 max。自動標題沿用原有 off 設定，可與任務並行，其時間另存。此口徑修正上一份報告混合計數，端到端耗時不變。

```json
{
  "revision": "4c8afad978b6e893a3545c0859dd5b4824a91223",
  "electron": {
    "sourceHash": "063A7948F121E9476A201DCC2D8269B87E4FF0503D0347E675630B4A8F75C053",
    "started": "2026-11-17T22:45:02.0319770+08:00",
    "bundleWritten": "2026-11-17T22:45:01.9978947+08:00",
    "revision": "4c8afad978b6e893a3545c0859dd5b4824a91223",
    "electronPid": 44888,
    "bundleHash": "A0A2B56597446D12A5E002584E590F6C6B9ECBD7C4367D5A9154DAA3571219E0"
  },
  "runtime": {
    "pid": 48300,
    "startedAt": "2026-11-17T14:44:47.645Z",
    "sourceHash": "c99fce2a15e62318651d11d680dc04afae4bcc97f44457ea3f17fe18c51c4d49",
    "currentHash": "c99fce2a15e62318651d11d680dc04afae4bcc97f44457ea3f17fe18c51c4d49",
    "restartRequired": false
  }
}
```

Changed files:

- `runtime/browser-tool.mjs` + `runtime/tests/browser-tool.test.mjs`
- `ui/desktop/src/workspace-panel/browserControl.ts` + `.test.ts`
- `ui/desktop/src/workspace-panel/workspacePanelMain.ts`
- `ui/desktop/tests/e2e/workspace-browser.electron.spec.ts`

Commands (existing Node 24 runtime, cwd `ui/desktop` except runtime tests):

```powershell
node ../node_modules/vitest/vitest.mjs run src/workspace-panel/browserControl.test.ts
node ../node_modules/typescript/bin/tsc --noEmit
node ../node_modules/@playwright/test/cli.js test tests/e2e/workspace-browser.electron.spec.ts --reporter=list
node --test runtime/tests/browser-tool.test.mjs
```

[Raw data](../.local/browser-roundtrips-20261117/comparison-data.json) · [Source identity](../.local/browser-roundtrips-20261117/loaded-identity.json) · [Independent readback validation](../.local/browser-roundtrips-20261117/visible-check.py)

Local evidence: `.local/browser-roundtrips-20261117/` contains session exports, model timings, visible readbacks, runtime logs and reproducible chart/report scripts. Previous baseline evidence remains in `.local/browser-observation-20261117/`.

Design reference: [Playwright actionability](https://playwright.dev/docs/actionability) and [retrying assertions](https://playwright.dev/docs/test-assertions) motivate read-before-next-step checks. This bounded accessibility settling mechanism is project-specific and does not replace an explicit outcome assertion. No external code or dependency was imported.
