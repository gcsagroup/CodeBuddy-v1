# Mac 性能优化与验收记录：2026-11-19

[繁體中文](mac-performance-2026-11-19.zh-TW.md) · [English](mac-performance-2026-11-19.en.md)

本轮保留提示词去重与两条行为澄清；最终版本 7 个针对性场景通过，累计记录 22 轮、9 条不同提示词，其中 19 轮经正在运行的 Mac CodeBuddy ACP 发起，3 轮从真实 CodeBuddy 界面发起。中英文网页的最终单轮对照减少了输入 token 和耗时；PDF 耗时仍有波动，不能宣称全面提速或统计显著。

## 实际交付

- 产品文件仅改 `runtime/harness/skills/computer-use/SKILL.md`：删除 16 段中英文含义重复的本地化说明，保留对应英文规则；17,101 → 15,686 字符，减少 8.27%。这是字符数，不是 tokenizer 估算。
- 明确单字段 PDF 也应在首次目标观察携带 `form_entities`；遗漏时在首次写入前请求匹配。明确对话工作区不是打开文件的位置，不能编造保存路径。
- 修改状态 `AXEdited` 试验已完整撤回：原生源码与本轮开始备份逐字一致，运行 helper 恢复原哈希。真实 Preview 没有返回可靠的修改状态变化；不能把原生合同测试通过当作功能成立。详见[撤回记录](macos-document-state.zh-CN.md)。
- 现有 Harness 所有权、输入权限及主模型分工未改变；未新增依赖，未提交、推送或新建分支，未生成新安装包。

## 可比较的结果

模型固定为 Ollama `deepseek-v4.1-flash`，`reasoningEffort=high`，每轮请求头已核对。中英文分别使用完全相同提示词和表单初始值：公司/工作邮箱为空，账单邮箱/备注预置旧值，提交计数为 0。

| 场景 | ACP 整轮耗时：基线 → 最终 | 主模型累计输入 token：基线 → 最终 | 变化 |
|---|---:|---:|---|
| 中文网页 | 30.479 → 26.209 秒 | 124,432 → 116,047 | 耗时 -14.0%；输入 -6.7% |
| 英文网页 | 35.064 → 28.409 秒 | 126,006 → 115,489 | 耗时 -19.0%；输入 -8.3% |

输入口径为主模型各次请求的未缓存输入 + cacheRead + cacheWrite，不是计费金额；缓存输入另列。输出、辅助识图用量分别留档。ACP 整轮从发送 prompt 到返回结束计时，主模型轮次时间从日志 turn/start 到 turn/end，二者不能混用。网络/缓存/模型动作选择会影响时间；样本不足以保证每次都快。

首版去重候选的英文一轮多做一次观察，输入反而升至 127,490；PDF 一轮触发旧控件保护后重新观察，输入升至 160,213。另一 PDF 候选轮输入 96,402，但 40.841 秒仍慢于新鲜基线的 34.698/39.719 秒。最终单字段 PDF 含保存和识图为 67.508 秒；最终双字段 PDF 不要求保存，20.825 秒。两者任务不同，不能当作优化前后对照。

## 最终版本的真实结果

7 个场景均核对实际工具回执及目标内容；网页额外核对整个事件流。中文/英文两个目标字段均 2/2 正确，账单邮箱和备注逐字保留，提交次数 0。同名邮箱场景只改公司，两个邮箱保留，并明确说明不能区分。只读场景无输入调用；精确窗口不存在时出现两条预期的“0 exact visible matches”拒绝回执，没有改其他窗口。

单字段 PDF 从 CodeBuddy 新对话发起，公司改为“山岚工作室”，另三栏不变；执行保存后独立读取 PDF 文件核对。双字段 PDF 同样从界面发起，公司改为“海风测试”、工作邮箱为 `qa@example.test`，另两栏保留；只执行两次写入，无提交或保存动作，屏幕与写后回读一致。此轮未验证磁盘持久化，PDF 夹具本身没有提交按钮；网页的真实提交按钮承担提交计数验收。

FORMS 确实参与最终写入任务，但不等于匹配质量通过：中文网页和双字段 PDF 的目标字段均推荐 `skip`；英文只给 Company 推荐正确值，Work email 仍为 `skip`。主模型依据标签与用户指令选择了正确控件。验收 JSON 同时保存每个控件的推荐、主模型写入索引、实际回读；不能将填对归功于 FORMS 中文匹配改善。

首版单字段 UI 轮虽然填对，却漏调 FORMS 并编造了文件位置，已标为不通过；补充上述规则后以新对话重测通过。原生 AXEdited 两轮只记录实验结果，不计入最终候选验收。

## 验证与范围

Windows 和 Mac 均执行 `node --test runtime/harness/test/computer-skill.test.mjs runtime/harness/test/tool-discovery.test.mjs`，各 17/17，通过、退出码 0。Windows 使用既有 Node 24.20.0，Mac 使用既有 Node 24.21.0。`python -X utf8 .local/mac-speed-20261119/verify.py`、`final-audit.py`、`git diff --check` 均退出 0。曾在 Windows 误启动 Mac 专用 runner，因本机没有 Mac profile 立即 ENOENT 退出 1；未形成模型测试轮，随后在正确 Mac 目录运行。

源码来自 Windows `D:/CodeBuddy-v1`、`main@4c8afad978b6e893a3545c0859dd5b4824a91223` 加已有未提交改动。Mac 目录 `/Users/erjinyi/Desktop/work/CodeBuddy-v1` 的 Git HEAD 仍为历史 `7321135`，不能用该 HEAD 声称全仓同步；本次相关 8 个源码文件已逐个与 Windows 哈希核对一致。当前预览运行 runtime PID 16190 / Electron PID 16207，artifactCheck passed，restartRequired false。每条最终会话均确认实际加载新规则。

本轮是针对表单链路的性能回归，不是重做 Mac 所有功能或六项完整交付认证。Esc 接管、断线恢复、弹窗与安装包本轮未重新测试。保留当前预览版供查看，不将旧报告的测试数量计入本轮。

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
