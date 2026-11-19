# Mac performance and acceptance record: 2026-11-19

[简体中文](mac-performance-2026-11-19.zh-CN.md) · [繁體中文](mac-performance-2026-11-19.zh-TW.md)

This iteration retains guidance deduplication and two behavioral clarifications. Seven targeted scenarios passed on the final candidate. The batch contains 22 completed rounds and nine distinct literal prompts: 19 via the running Mac CodeBuddy ACP service and three through the visible CodeBuddy UI. Final Chinese/English web comparisons used less input and elapsed time. PDF latency remains variable; these samples do not establish universal or statistically significant acceleration.

## Delivered changes

- The only product file changed this iteration is `runtime/harness/skills/computer-use/SKILL.md`. Sixteen duplicate localized paragraphs were removed while their English rules remain. Length changed from 17,101 to 15,686 characters, down 8.27%; this is a character count, not tokenizer output.
- Single-field PDF edits now explicitly request `form_entities` in the first target observation, or matching before the first write if initially omitted. The guide also prohibits treating the chat workspace as the open document's location.
- The `AXEdited` experiment was fully reverted. Native sources match pre-iteration backups byte for byte and the runtime helper has its original hash. Preview did not provide reliable edited-state transitions; passing native contract tests did not establish product behavior. See the [rejected experiment](macos-document-state.en.md).
- Harness ownership, input permissions and main-model responsibilities are unchanged. No new dependencies, branches, commits, pushes or installer were produced.

## Comparable measurements

All request headers were checked for Ollama `deepseek-v4.1-flash`, `reasoningEffort=high`. Each language used the same prompt and reset initial values: empty company/work email, prefilled billing email/notes, and submission count zero.

| Scenario | ACP prompt-to-stop: baseline → final | Cumulative main-model input: baseline → final | Change |
|---|---:|---:|---|
| Chinese web | 30.479 → 26.209 s | 124,432 → 116,047 | Time -14.0%; input -6.7% |
| English web | 35.064 → 28.409 s | 126,006 → 115,489 | Time -19.0%; input -8.3% |

Input sums uncached input, cacheRead and cacheWrite across main-model requests. It is not a billing estimate. Cache reads, output and auxiliary vision usage are recorded separately. ACP timing measures prompt dispatch through stop; model-turn timing uses turn/start through turn/end. These are different measures. Network, cache and action selection vary, and the samples do not guarantee faster future runs.

An earlier deduplication candidate used an extra observation in English, increasing input to 127,490. A PDF round encountered the stale-control guard, reobserved and used 160,213 input tokens. Another PDF candidate used 96,402 input tokens but took 40.841 s, slower than fresh baseline rounds of 34.698/39.719 s. The final single-field PDF edit with save and vision took 67.508 s; the final two-field PDF edit without a save requirement took 20.825 s. Different tasks cannot serve as a before/after comparison.

## Actual outcomes and limitations

All seven final scenarios were checked against tool receipts and target contents; web tests also checked the entire event stream. Both target fields were correct in Chinese and English, unrelated values remained exact and submission count stayed zero. Ambiguous email labels caused only the company to change, both emails to remain intact and a clear skip explanation. Read-only used no input. The missing exact window produced two expected `0 exact visible matches` refusals and no changes to another window.

The single-field PDF test began in a new visible CodeBuddy chat, changed company to 山岚工作室 and preserved the other three fields; an independent PDF read verified the saved file. The two-field test also began in the UI, changed company to 海风测试 and work email to `qa@example.test`, and preserved billing/notes. It performed exactly two writes, no submission or save action; visible contents matched the after-state receipts. Disk persistence was not verified for that round. The PDF fixture has no submit button; the web fixture provides a real submit button and counter for that assertion.

FORMS participated in final write tasks, but Chinese web and two-field PDF targets received `skip` recommendations. In English, Company received the correct fill recommendation while Work email remained `skip`. The main model selected the correct controls from labels and user scope. Verification JSON retains recommendations, chosen input indices and actual read-back values. Correct filling is not evidence of improved Chinese FORMS matching.

The initial single-field UI candidate filled correctly but omitted FORMS and invented a file location; it is recorded as a failure. The clarified guide passed a fresh-chat retest. Both AXEdited rounds remain rejected experiments rather than final-candidate acceptance.

## Validation and provenance

Windows and Mac each ran `node --test runtime/harness/test/computer-skill.test.mjs runtime/harness/test/tool-discovery.test.mjs`: 17/17, exit 0, with existing Node 24.20.0 / 24.21.0 respectively. `python -X utf8 .local/mac-speed-20261119/verify.py`, `final-audit.py` and `git diff --check` exited 0. One accidental Windows invocation of the Mac-only runner immediately exited 1 with ENOENT for the absent Mac profile. It created no model trial; the runner was then executed in the correct Mac directory.

Windows source is `D:/CodeBuddy-v1`, `main@4c8afad978b6e893a3545c0859dd5b4824a91223`, with existing dirty work preserved. Mac source is `/Users/erjinyi/Desktop/work/CodeBuddy-v1`; its Git HEAD remains historical `7321135`, so that HEAD does not prove a full repository sync. Eight relevant source files were individually hash-matched against Windows. The current preview uses runtime PID 16190 and Electron PID 16207, artifactCheck passed and restartRequired false. Every final session loaded the new guidance.

This is targeted form-performance regression testing, not a new full Mac or six-item delivery certification. Esc takeover, disconnection recovery, dialogs and installer acceptance were not rerun this iteration. The preview remains running; previous-report rounds are not counted here.

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
