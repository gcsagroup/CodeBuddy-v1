# Mac 效能最佳化與驗收紀錄：2026-11-19

[简体中文](mac-performance-2026-11-19.zh-CN.md) · [English](mac-performance-2026-11-19.en.md)

本輪保留提示詞去重及兩條行為澄清；最終版本 7 個針對性情境通過，累計記錄 22 輪、9 條不同提示詞，其中 19 輪經執行中的 Mac CodeBuddy ACP 發起，3 輪從真實 CodeBuddy 介面發起。中英文網頁的最終單輪對照減少輸入 token 與耗時；PDF 耗時仍有波動，不能宣稱全面加速或統計顯著。

## 實際交付

- 產品檔案僅改 `runtime/harness/skills/computer-use/SKILL.md`：刪除 16 段語意重複的本地化說明，保留對應英文規則；17,101 → 15,686 字元，減少 8.27%。這是字元數，不是 tokenizer 估算。
- 明確單欄 PDF 也應在首次目標觀察帶入 `form_entities`；遺漏時在首次寫入前請求匹配。明確對話工作區不是開啟文件的位置，不能編造儲存路徑。
- `AXEdited` 試驗完整撤回，原生原始碼與本輪開始備份逐字一致，執行 helper 恢復原雜湊。真實 Preview 沒有可靠的修改狀態變化；合同測試通過不足以證明功能成立。見[撤回紀錄](macos-document-state.zh-TW.md)。
- Harness 所有權、輸入權限與主模型分工未變；無新依賴、提交、推送或分支，未產生新安裝包。

## 可比較的結果

模型固定 Ollama `deepseek-v4.1-flash`、`reasoningEffort=high`，逐輪核對請求標頭。中英文各自使用相同提示詞與初始值：公司/工作信箱空白，帳單信箱/備註預置舊值，提交計數為 0。

| 情境 | ACP 整輪耗時：基線 → 最終 | 主模型累計輸入 token：基線 → 最終 | 變化 |
|---|---:|---:|---|
| 中文網頁 | 30.479 → 26.209 秒 | 124,432 → 116,047 | 耗時 -14.0%；輸入 -6.7% |
| 英文網頁 | 35.064 → 28.409 秒 | 126,006 → 115,489 | 耗時 -19.0%；輸入 -8.3% |

輸入為各請求未快取輸入 + cacheRead + cacheWrite，不是計費金額；快取、輸出及輔助識圖分別留存。ACP 時間是 prompt 到結束；主模型輪次時間是 turn/start 到 turn/end，不能混用。網路、快取及動作選擇造成波動；樣本不足以保證每次更快。

首版去重候選的英文一輪多一次觀察，輸入升至 127,490。PDF 一輪觸發舊控制項保護後重新觀察，輸入升至 160,213；另一輪輸入 96,402，但 40.841 秒仍慢於新鮮基線的 34.698/39.719 秒。最終單欄 PDF 含儲存及識圖為 67.508 秒；雙欄 PDF 不要求儲存為 20.825 秒。任務不同，不作前後比較。

## 真實結果與限制

最終 7 個情境均核對工具回執及目標內容，網頁另查完整事件流。中英文兩個目標欄位各 2/2 正確，帳單信箱與備註逐字保留，提交 0 次。同名信箱只改公司，兩信箱保留並說明無法區分。唯讀無輸入；不存在的精確視窗產生兩條預期的「0 exact visible matches」拒絕回執，未改其他視窗。

單欄 PDF 從 CodeBuddy 新對話發起，公司改為「山岚工作室」，另三欄不變，儲存後獨立讀檔核對。雙欄 PDF 也從介面發起，公司「海风测试」、工作信箱 `qa@example.test`，另兩欄保留；兩次寫入，無提交或儲存動作，畫面與回讀一致。後者未驗證磁碟持久化；PDF 夾具沒有提交按鈕，網頁以真實提交按鈕與計數驗收。

FORMS 確實參與最終寫入，但中文網頁及雙欄 PDF 目標欄位都建議 `skip`；英文只給 Company 正確填值建議，Work email 仍 `skip`。主模型依標籤與指令選對控制項。JSON 留存各欄推薦、寫入索引與回讀；不能歸因為 FORMS 中文匹配改善。

首版單欄 UI 雖填對，漏調 FORMS 且編造檔案位置，因此不通過；補規則後新對話重測通過。兩輪 AXEdited 僅列實驗，不計最終候選驗收。

## 驗證與來源

Windows / Mac 各執行 `node --test runtime/harness/test/computer-skill.test.mjs runtime/harness/test/tool-discovery.test.mjs`，17/17、退出 0，使用既有 Node 24.20.0 / 24.21.0。`python -X utf8 .local/mac-speed-20261119/verify.py`、`final-audit.py`、`git diff --check` 均退出 0。曾在 Windows 誤啟動 Mac 專用 runner，缺少 Mac profile 而立即 ENOENT 退出 1，未建立模型測試輪；之後在正確 Mac 目錄執行。

來源為 Windows `D:/CodeBuddy-v1`、`main@4c8afad978b6e893a3545c0859dd5b4824a91223` 加既有未提交修改。Mac `/Users/erjinyi/Desktop/work/CodeBuddy-v1` 的 Git HEAD 仍是歷史 `7321135`，不能宣稱全倉同步；本次相關 8 個來源檔案與 Windows 雜湊一致。執行 runtime PID 16190 / Electron PID 16207，artifactCheck passed、restartRequired false；每條最終會話均確認載入新規則。

本輪是表單效能回歸，並非重做 Mac 所有功能或六項完整交付認證。Esc 接管、斷線恢復、彈窗與安裝包本輪未重測。預覽版保持執行；舊報告數量不計入本輪。

## Final cases / 最终场景 / 最終情境

| Case | Model turn (s) | ACP (s) | Input incl. cache | Cache read | Output | Tool calls | Full vision observations |
|---|---:|---:|---:|---:|---:|---:|---:|
| after-cn-2 | 23.489 | 26.209 | 116,047 | 89,962 | 1,301 | 8 | 0 |
| after-en-2 | 28.052 | 28.409 | 115,489 | 99,150 | 990 | 8 | 0 |
| after-ambiguous-2 | 36.488 | 41.227 | 95,279 | 80,740 | 1,006 | 7 | 1 |
| after-readonly-2 | 16.580 | 21.740 | 42,326 | 34,758 | 492 | 4 | 0 |
| after-missing-2 | 11.551 | 12.036 | 40,115 | 34,528 | 303 | 4 | 0 |
| ui-single-final | 67.508 | UI | 116,170 | 88,592 | 2,335 | 9 | 1 |
| ui-pair-final | 20.825 | UI | 75,007 | 59,786 | 1,157 | 7 | 0 |

## Source identity / 源码身份 / 原始碼身分

- Final skill SHA-256: `e263ff29f0b4dc5e980fbf4db4c490b605e50bc6185211ebc5da149c04c22e17`
- Runtime source hash: `0878b4d8688eb29855cdf4f64ae5e277fd021945422abe918e85421b246324ea`
- Native helper SHA-256: `f1e505bd2addd3ccac1f847ddb1431a52ed859001ad6a3d08467b528a7d2c04c`

## Evidence / 证据 / 證據

- [Final audit](../.local/mac-speed-20261119/final-audit.json): candidate hashes and seven final cases.
- [Verification](../.local/mac-speed-20261119/verification.json): actual values, FORMS recommendations, input calls, negative tests.
- [All rounds CSV](../.local/mac-speed-20261119/results.csv) · [Full results and prompts](../.local/mac-speed-20261119/results.json) · [Session receipts](../.local/mac-speed-20261119/sessions/).
- [Windows tests](../.local/mac-speed-20261119/final-tests.log) · [Mac tests](../.local/mac-speed-20261119/mac-final-tests.log).
- [Vision usage](../.local/mac-speed-20261119/vision-usage.json) · [Transport timings](../.local/mac-speed-20261119/model-timings.log) · [Web events](../.local/mac-speed-20261119/events.json).
- [This iteration's product diff](../.local/mac-speed-20261119/this-turn.patch) · [Mac running identity](../.local/mac-speed-20261119/final-identity.json).

These are local evidence files, not committed artifacts. / 以上为本地证据，未纳入提交。 / 以上為本地證據，未納入提交。

## Prompts / 验收提示词 / 驗收提示詞

`after-ambiguous-1`

> 在外部 Safari 当前客户表里，公司填“青禾咨询”，工作邮箱填 qinghe@example.test。只改能明确对应的栏位，其他已有内容逐字保留；分不清的栏位留着并告诉我。不要提交。

`after-cn-1`

> 在外部 Safari 当前客户表里，把公司填为“澄海设计”，工作邮箱填为 chenghai+qa@example.test。账单邮箱和原备注逐字保留，填好核对就停，不提交。

`after-en-1`

> Please update the current customer form in external Safari: Company = Cedar Labs; Work email = cedar.ops+review@example.test. Leave Billing email and Notes exactly as they are. Verify the result and stop without submitting.

`after-missing-1`

> 只操作标题完整为“未打开的客户合同 731”的窗口，把公司填为“青禾咨询”。如果找不到这个准确窗口就告诉我，不要改其他窗口。

`after-pdf-1`

> 在预览中当前打开的可填写客户 PDF，把公司填为“云杉工作室”，工作邮箱填为 y unshan@example.test，其中邮箱里的空格是我误打的，请去掉。账单邮箱和原备注保留，核对完成后保存，不提交。

`after-readonly-1`

> 只检查外部 Safari 当前客户表，告诉我两个邮箱栏目前各是什么、备注是什么，以及有没有提交。不要填写或改动任何内容，答案简短。

`ui-pair-final`

> 在预览当前打开的 codebuddy-speed-customer.pdf 里，把公司填为“海风测试”，工作邮箱填为 qa@example.test，保留账单邮箱和原备注，填好核对就停，别提交。

`ui-single-final`

> 请在预览中打开着的 codebuddy-speed-customer.pdf 里只把公司改成“山岚工作室”。工作邮箱、账单邮箱和备注都保持原样，核对后保存文件，不要提交。

`ui-single-v1`

> 请在预览中打开着的 codebuddy-speed-customer.pdf 里只把公司改成“远山工坊”。工作邮箱、账单邮箱和备注都保持原样，核对后保存文件，不要提交。
