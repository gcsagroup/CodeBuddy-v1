# Mac 多提示詞驗收與效能評估 — 2026-11-18

[简体中文](mac-performance-2026-11-18.zh-CN.md) · [English](mac-performance-2026-11-18.en.md)

本輪共 25 個真實模型任務回合、11 種提示詞。最終候選版的相關功能場景通過；**尚未證明全面提速或全面減少 token**，也不是所有 Mac 功能、應用程式及安裝升級的完整認證。

## 方法與結果

固定 Ollama `deepseek-v4.1-flash`、主任務 `high` 思考強度。普通問答、CSV、多輪修改、檔案預覽和 PDF 單欄修改從 Mac CodeBuddy UI 發起；批次場景經同一執行服務的 ACP 發起。以實際視窗、原生回讀、網頁被動事件和已儲存 PDF 核對，不用元件測試代替桌面驗收。

- 算術正確回覆 4.5 千克，2.010 秒，沒有工具呼叫。
- CSV 的 paid 訂單 4 筆、260.00；金額格式、排序、零金額客戶正確；原始檔案雜湊不變。
- 修正同一路徑的回應檔案預覽仍顯示舊內容，實際點新回應連結後，既有分頁更新而不重複開啟。
- 最終中英文網頁兩個目標欄位均正確，帳單信箱與備註逐字保留，提交 0；事件紀錄沒有發現中途破壞保留欄位。
- 同名信箱僅填公司，兩個信箱保留並回報無法判定；唯讀及不存在的精確視窗不呼叫輸入工具。
- Preview 正確填寫並儲存 PDF，處理誤打空格；另從 UI 只改公司成「青禾複核」（實際測試值為簡體「青禾复核」），其他三欄保持原值，磁碟內容與畫面一致，回執只有一句。

未重新驗收安裝升級、Word/Excel、大檔案極限及全部中斷恢復。較早批次的 Esc、切窗和斷線記錄不視為本輪新執行檔的驗收。

回執品質仍有缺口：同名信箱場景把沒有文字說明的 `0` 猜成「疑似剩餘提交次數」，解釋不準確；提交 0 由夾具事件證實，並非依賴模型說法。唯讀要求簡短，但回覆仍偏長。欄位保護通過不等於回答品質全部通過。

## 效能

| Scenario | Seconds | Model calls | Tool calls | Raw input | Cache read | Output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| English baseline | 24.380 | 10 | 9 | 143,213 | 113,024 | 989 |
| English final | 24.110 | 9 | 8 | 119,277 | 101,376 | 897 |
| PDF baseline | 42.098 | 9 | 8 | 124,808 | 99,328 | 1,565 |
| PDF final | 50.722 | 9 | 8 | 127,446 | 110,336 | 2,156 |
| PDF single-field UI final | 26.407 | 8 | 7 | 81,391 | 66,176 | 1,122 |
| Chinese final | 28.835 | 9 | 8 | 121,465 | 97,024 | 911 |
| Ambiguous final | 34.281 | 8 | 7 | 103,176 | 85,632 | 1,940 |
| Read-only final | 28.487 | 5 | 4 | 46,175 | 37,504 | 1,142 |


秒數是 Harness turn/start 到 turn/end；ACP 完整耗時另記 CSV serviceMs。Raw input 是主模型所有請求的 uncached + cache read + cache write 累計，不是最終上下文長度或計費金額。標題生成及視覺輔助另外計算；最終雙欄 PDF 的視覺模型另用輸入 5,620、輸出 228 token。FORMS 本機執行，不產生 API token 費用，但仍有計算成本。

英文少一次工具呼叫，輸入減少 16.7%，24.380 → 24.110 秒基本持平。PDF 輸入增加 2.1%、耗時增加 20.5%。每組最終比較只有一輪，不能當作穩定收益；中文最終 ACP 和早先 UI 上下文不同，不作嚴格 A/B。

## 修改與撤回

保留：`WorkspacePanel.tsx` 與測試修正唯讀預覽更新及關閉競態；`tool-discovery.mjs` 與測試讓 MCP 連接中也提供正確 skill 入口；Swift runtime、RuntimeContract 與 contract-tests 在網頁文字賦值前核對實際焦點，保留原生 PDF 的直接賦值；完整 computer-use skill 加入對應指引。網頁由 AXWebArea 祖先判定，沒有應用程式名稱特例。Harness 權限及執行所有權不變。[Apple AX setter](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue)

撤回：把 skill 從約 1.67 萬字元壓成約 0.86 萬的試驗，導致額外搜尋和重試；一輪 PDF 達 118.781 秒、487,435 輸入 token。該版本偶爾較快的中文結果不算最終收益。強制所有文字控件聚焦也曾誤拒絕 Preview，最終已限於網頁文字欄位。

最終英文工具執行合計 2.458 秒，整輪 24.110 秒；其餘包括模型往返及框架間隔。優先減少無效工具搜尋、重複觀察及不必要整窗識圖，再考慮回執壓縮，保留視窗身份、欄位值與失敗/接管資料，並進行多輪 A/B。[工具設計參考](https://www.anthropic.com/research/writing-tools-for-agents)

提示詞明確指定應用程式、目標欄位、保留內容、停止條件及回覆長度。中文 FORMS 經常建議跳過，正確寫入仍依賴主模型；沒有中文匹配準確率提高的證據。

交付為現有 Mac 原始碼開發執行版；本輪 8 個修改檔案雜湊與 Windows 一致，保留其他 dirty 檔案，未提交、推送或建立 DMG。

## Evidence / 源码与证据 / 原始碼與證據

- Windows: `D:\CodeBuddy-v1`, `main@4c8afad978b6e893a3545c0859dd5b4824a91223` + dirty files.
- Mac: `/Users/erjinyi/Desktop/work/CodeBuddy-v1`; existing checkout, `start-preview.sh`, isolated `.local/fluiduse-20261118/profile`. Mac Git HEAD remains older; source manifests and SHA-256 identify this build.
- Runtime source SHA-256: `0878b4d8688eb29855cdf4f64ae5e277fd021945422abe918e85421b246324ea`.
- Native helper SHA-256: `f1e505bd2addd3ccac1f847ddb1431a52ed859001ad6a3d08467b528a7d2c04c`.
- Final computer-use skill SHA-256: `40f06bdfd866e4058411b1d7abc67b176385669f1291d7bc315ab36940039ff2`.
- [All trials and exact prompts](../.local/mac-performance-20261118/all-trials.csv), [raw usage](../.local/mac-performance-20261118/metrics.json), [field/event assertions](../.local/mac-performance-20261118/verification.json), [build identity](../.local/mac-performance-20261118/final-identity.json), [vision usage](../.local/mac-performance-20261118/vision-usage.json).
- [Model timings](../.local/mac-performance-20261118/model-timings.log), [native tests/build](../.local/mac-performance-20261118/native-web-focus-tests.log), [Mac discovery tests](../.local/mac-performance-20261118/mac-final-discovery-tests.log), [component tests](../.local/mac-performance-20261118/workspace-panel-node24-tests.log), [typecheck](../.local/mac-performance-20261118/typecheck.log).

## Commands / 命令

All completed with exit code 0. Node 24 was used; the PATH Node 22 was not used for accepted checks.

```text
node24 --test runtime/harness/test/computer-skill.test.mjs runtime/harness/test/tool-discovery.test.mjs
# Windows and Mac: 17/17
# cwd ui/desktop:
node24 ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/workspace-panel/WorkspacePanel.test.tsx
# 51/51
node24 ../node_modules/typescript/bin/tsc --noEmit
# Mac wrapper invokes the existing native test/build entry:
CODEBUDDY_GO_EXECUTABLE=/usr/local/go/bin/go node24 .local/fluiduse-20261118/test-native.cjs
# Go tests, Swift contracts, 4 CoreML tests, release native build
python -X utf8 .local/mac-performance-20261118/summarize.py
git diff --check -- <changed source files>
```

Native build retained an existing deprecated `activateIgnoringOtherApps` warning. No dependency reinstall, branch creation, commit, push or installer release was performed.
