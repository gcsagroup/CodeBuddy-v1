# Mac 多提示词验收与性能评估 — 2026-11-18

[繁體中文](mac-performance-2026-11-18.zh-TW.md) · [English](mac-performance-2026-11-18.en.md)

本轮共 25 个真实模型任务回合、11 种不同提示词，覆盖普通回答、文件处理、多轮修改、响应文件预览、中文/英文网页、可填写 PDF、同名字段、只读要求和不存在的目标窗口。最终候选版相关功能场景通过；**全面提速和全面降低 token 尚未成立**。这里不是整个 Mac 产品、所有应用和安装升级的全量认证。

## 方法与边界

主模型固定为用户指定的 Ollama `deepseek-v4.1-flash`，主任务思考强度固定 `high`。没有降低强度来制造提速。实际运行 Mac 桌面和原生执行器；UI 场景从 CodeBuddy 输入框发送，批量场景通过同一运行服务的 ACP 发起，结果核对真实窗口、原生回读、网页被动事件和保存后的 PDF。两种入口分别标注，组件测试不冒充产品 E2E。

速度表的秒数为 Harness `turn/start` 到 `turn/end`；ACP 整体耗时另记 CSV 的 `serviceMs`。输入为所有主模型请求的累计原始输入：uncached + cache read + cache write，不是最后一轮上下文长度，也不等于计费金额。标题生成及视觉辅助模型不混进主任务表；视觉 usage 单独导出。最终 PDF 双字段任务额外识图输入 5,620、输出 228 token。FORMS 在本地运行，没有 API token 账单，但不表示零计算成本。

对照英文和 PDF 使用相同提示词、同一模型/强度和恢复后的相同字段初值。每组只有一次最终对照，存在模型、缓存和网络波动，不能推断稳定百分比收益。中文最终 ACP 与早先 UI 的工作区上下文不同，不作严格速度 A/B。

## 验收结果

- 无工具算术：准确返回 `4.5 千克`，2.010 秒；没有多余工具调用。
- CSV：paid 4 笔、合计 260.00；排序、两位小数和零金额客户正确；源 CSV SHA-256 保持不变。
- 多轮文件预览：复现旧标签页显示旧内容，修复后从新响应链接打开同一路径，原标签页刷新且没有重复标签页。
- 最终中文与英文网页：目标字段 2/2 正确；账单邮箱、备注逐字保留；提交为 0；被动事件未发现中途误改保护字段。
- 最终同名邮箱：只填写公司，两个邮箱维持原值，并明确告知无法判定哪一个是工作邮箱。
- 最终只读检查、精确标题不存在：只观察并回报，不调用输入工具；不把其他窗口当目标。
- 最终 Preview：公司和带空格的邮箱资料正确填写、纠正邮箱空格并保存；再从 Mac CodeBuddy UI 发起单字段修改，公司变为“青禾复核”，另外三栏逐字保留，磁盘读取与可见结果一致，按要求一句话回执。

本轮未重新逐项执行安装/升级、Word/Excel、大文件极限和全部中断恢复场景；较早 FluidUse 批次的 Esc、切窗和断线记录不冒充本轮新二进制验收。

回执质量仍有不足：最终同名邮箱场景把页面未标明含义的 `0` 猜成“疑似剩余提交次数”，该解释不准确；提交为 0 的结论来自夹具事件，而不是这句模型解释。只读提示要求简短，回答仍偏长。以上不影响本次字段保护结果，但不能把回答质量也写成全部通过。

## 性能数据

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


英文最终比基线少一次工具调用，累计主模型输入少 16.7%，耗时基本持平（24.380 → 24.110 秒）。PDF 最终仍为 8 次工具调用，输入增加 2.1%，耗时增加 20.5%。因此不能把英文这一轮的收益推广到全部场景。单字段修改是额外覆盖，不与双字段任务比较速度。

## 实际保留的修复

1. `WorkspacePanel.tsx` 及测试：响应文件的只读预览再次打开时重新读取磁盘；保护编辑中的普通文件；异步读取完成时不重新打开用户已关闭的标签页。
2. `tool-discovery.mjs` 及测试：电脑控制 MCP 尚在连接时，首轮就说明正确的 skill 加载和等待入口；沿用既有连接与权限机制，减少盲查工具。
3. `macos/runtime.swift`、`RuntimeContract.swift`、`contract-tests.swift`：网页文本字段写值前，验证目标就是实际焦点，防止 Safari 把值写到另一个正在编辑的框。通过 AXWebArea 祖先判断网页，不按应用名字硬编码。原生 PDF 控件继续允许系统支持的直接赋值。
4. computer-use skill：保留原有完整说明，补充 Mac 网页焦点与原生 PDF 写值差别。

修改依据是实际 Safari 临时错写和 Preview 误拒绝，不是模型自述。系统可写属性仍由原生执行器校验；参考 [Apple AX setter](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue)。Harness 的执行、授权、完成判定所有权未改变。

## 撤回的试验与下一步

把 skill 从约 1.67 万字符压到约 0.86 万，虽然单次中文变快，却使其他场景多次搜索、重试或查磁盘；其中一次 PDF 达 118.781 秒、487,435 输入 token。压缩方案已撤回，未把该中文快结果计入最终优化收益。过宽的“所有文本控件必须聚焦”检查会误拒绝 Preview，也已改为仅对网页文本控件施加检查。

最终英文工具执行合计 2.458 秒，整轮 24.110 秒，余下约 21.652 秒包括模型往返与框架间隔。优先方向是减少无效往返、重复工具搜索及不必要整窗识图；其次才是减少重复观察文本。修改回执格式或压缩历史应保留窗口身份、字段值、失败与接管信息，并经过多轮 A/B，不能只按字符数验收。[工具设计参考](https://www.anthropic.com/research/writing-tools-for-agents)

用户提示词可明确应用、目标字段、要保留的字段、停止条件与回执长度。例如：“在预览的当前客户 PDF 中只把公司改成‘青禾复核’，其他栏位逐字保留，保存，不提交，只用一句话回报。”这能减少解释性输出；是否降低整轮输入仍取决于工具调用次数。中文 FORMS 经常建议跳过，正确填写依赖主模型判断；本轮不声称匹配模型提高了中文准确率。

交付是现有 Mac 源码开发运行版。8 个本轮修改源码文件的归一化 SHA-256 与 Windows 一致；此前全目录清单也完成过对照。保留所有无关 dirty 文件，未提交、未推送、未制作 DMG。

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
