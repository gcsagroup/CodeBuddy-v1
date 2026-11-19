# Mac prompt-suite acceptance and performance — 2026-11-18

[简体中文](mac-performance-2026-11-18.zh-CN.md) · [繁體中文](mac-performance-2026-11-18.zh-TW.md)

This batch contains 25 real model task turns and 11 distinct prompts. Relevant final-candidate functional cases passed. **A general latency or token reduction has not been established.** This is bounded coverage, not certification of every Mac feature, application or installation path.

## Method and acceptance

The main model stayed on the requested Ollama `deepseek-v4.1-flash`, with `high` reasoning effort. UI cases were submitted from Mac CodeBuddy; batch cases used ACP on that same running service and native desktop executor. Visible windows, native readbacks, passive browser events and saved PDF contents were checked. Component tests are reported separately from product E2E.

- Arithmetic returned exactly 4.5 kg in 2.010 seconds without tools.
- CSV processing produced 4 paid orders and 260.00 total; formatting, sorting and zero-value customers were correct. The source CSV hash remained unchanged.
- A stale response-file preview was reproduced and fixed. Clicking the new response link refreshed the existing read-only tab without duplicating it.
- Final Chinese and English forms filled 2/2 target fields, preserved billing email and notes verbatim, and submitted zero times. Passive events showed no transient corruption of protected fields.
- Ambiguous email labels caused both email values to be retained, with a specific explanation; only the company was entered. Read-only and missing-exact-window cases used no input tools.
- Preview PDF filling, typo-space correction and saving succeeded. A final UI prompt changed only the existing company to `青禾复核`, preserved all other three fields, saved to disk and returned one sentence.

Installation/upgrades, Word/Excel, large-file limits and every interruption/recovery case were not rerun. Earlier Esc, focus-switch and disconnect evidence is not claimed as acceptance of this new binary.

Response quality remains imperfect: the ambiguous-email reply guessed that an unlabeled `0` might mean remaining submissions. This interpretation was inaccurate; zero submissions were verified from fixture events, not the model's explanation. The read-only response was also verbose despite a brevity request. Field protection passing does not establish that every response-quality criterion passed.

## Measurements

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


Seconds measure Harness turn/start through turn/end; ACP serviceMs is recorded separately in the CSV. Raw input sums uncached input, cache reads and cache writes across all main-model requests. It is neither the final context size nor a billing estimate. Title generation and auxiliary vision calls are separate; final two-field PDF vision added 5,620 input and 228 output tokens. Local FORMS has no API-token bill but still consumes compute.

English used one fewer tool call and 16.7% less input, while latency was essentially unchanged (24.380 to 24.110 seconds). PDF input increased 2.1% and latency increased 20.5%. Each final matched comparison has one run; cache, network and model variability preclude a stable general improvement claim. Final Chinese ACP and earlier UI contexts differ and are not a strict A/B pair.

## Retained fixes and rejected experiments

`WorkspacePanel.tsx` and its tests refresh reopened response-file references while protecting editable files and tabs closed during a pending read. `tool-discovery.mjs` and its tests expose the correct skill/wait entry while desktop MCP is connecting. Swift runtime, RuntimeContract and contract tests require verified focus before writing web text fields, preventing Safari from routing the value into another focused editor. AXWebArea ancestry distinguishes web content without application-name exceptions; native PDF annotations retain supported direct value writes. The full computer-use skill adds this distinction. Harness ownership of execution and permissions is unchanged. [Apple AX setter](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue)

Compressing the skill from about 16.7k to 8.6k characters caused extra searches and recovery calls; one PDF run reached 118.781 seconds and 487,435 input tokens. That experiment was reverted, and its occasional faster Chinese result is not counted as final improvement. A focus check initially applied to all text controls falsely rejected Preview operations; it was narrowed to web text fields.

Final English tool execution totaled 2.458 seconds within a 24.110-second turn; the remainder includes model round trips and framework gaps. The next priorities are fewer redundant discovery calls and observations, and avoiding unnecessary full-window vision. Receipt/history compaction must preserve target identity, actual values, failures and takeover information and pass repeated A/B evaluation. Shorter text alone is not acceptance. [Tool-design reference](https://www.anthropic.com/research/writing-tools-for-agents)

Prompts should name the application, changed fields, preserved fields, stopping condition and desired reply length. Local FORMS often recommended skipping Chinese fields; correct completion relied on the main model. Improved Chinese matching accuracy is not established.

Delivery is the existing Mac source development runtime. All eight source files changed in this batch match Windows normalized hashes. Unrelated dirty work was retained; no commit, push or DMG release was made.

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
