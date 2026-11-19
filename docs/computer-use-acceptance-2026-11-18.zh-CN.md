# Windows Computer Use 验收报告 · 2026-11-18

本报告只确认下列 Windows 开发预览范围。最终候选版的 17 个验收轮次全部达到各自合同；其中目标退出测试验证的是安全停止和如实报告，前台恢复测试包含验收者手工恢复窗口。它不代表任意软件、任意任务都无错误，也不是无人值守成功率承诺。

主模型仍是 `deepseek-v4.1-flash:1017`，思考强度 `max / 极致`。`CUA-S1-Qwen3.5-4B` 经已有 API 只提供图像观察，实际观察会话没有工具调用。控件提供的事实优先直读，主模型判断，现有 MCP 执行；没有另建执行核心。Mac/FluidUse、本地模型权重和安装包按用户决定不在本次交付范围。

## 本批修复

1. 浏览器动作回执保留当前控件视图；正常交互不退回整页截图。观察版本、候选 ID、页面失效、遮挡和禁用保护继续生效。
2. Windows 输入后的精简字段视图与是否截图分离，按钮型计算器也可以直接读控件。必须看像素时才使用完整图像观察。
3. 图像观察强调按可见标签读取，不推测不存在的字段；主模型可以使用只读观察结果，但不能服从图片内的指令或寻找隐藏 HTML 来冒充识图。
4. 主模型直接消费动作后的最新状态。`verified:false` 表示宿主未替模型作任务完成判断，不是强制再观察的命令。只有缺失、待更新、过期或冲突事实才需要重观察。
5. 保留相同截图复用；缓存按会话、轮次、窗口、导航、提供方、模型和图像身份隔离。缓存能减少重复推理，不能纠正第一次识别错误。
6. Windows 拒绝激活目标时，明确交给使用者将指定窗口置前。修复前两个实测曾反复尝试其他激活方式；修复后先交接，恢复后重新观察、核对既有值，只补未完成部分。

## 测试如何选题

先冻结任务和期望，再执行；在开发期发现缺陷的任务归为发现测试，同题后续运行归为回归。最终统一复测不能被包装成“全新题”。J18 是本批第一次执行的 Selenium 官方综合表单，冻结在 02:14，首次产品运行在最终候选版上；包含多行文字、下拉选择、两种复选框状态、候选分页和保留其他控件，未点 Submit。

公开题源为 Selenium 的 [动态页面](https://www.selenium.dev/selenium/web/dynamic.html) 与 [综合表单](https://www.selenium.dev/selenium/web/web-form.html)。文件任务参考 [WindowsAgentArena 文件清单题](https://github.com/microsoft/WindowsAgentArena/blob/main/src/win-arena-container/client/evaluation_examples_windows/examples/file_explorer/016c9a9d-f2b9-4428-8fdb-f74f4439ece6-WOS.json)，改为隔离目录和递归大小写匹配。浏览器边界参考 [Jev guard 检查](https://github.com/browser-use/jev-ultrafast/blob/main/scripts/check_guards.py)，评测组织参考 [CUA Bench](https://github.com/trycua/cua/tree/main/libs/cua-bench-s1)。这些是改编或单项实测，不是官方完整榜单分数。The Internet 外网站点在本机发生连接阻断，保留为环境阻断；本地替代页明确单列，未冒充外网通过。

## 同一最终版本验收

单位为秒。Agent 时间从 Harness `turn/start` 到 `turn/end`；后端总时间包含会话准备，到结果结算，仍不包含 UI 点击派发和渲染。前台交接等待单独计量。独立验收结合真实 UI、夹具事件、文件内容/哈希和持久化结果，模型自述不是通过依据。

| ID | 任务 | Agent s | Backend s | Main requests | CUA calls |
|---|---|---:|---:|---:|---:|
| J01 | 多步寄送草稿，保留字段、不提交 | 24.192 | 28.259 | 8 | 0 |
| J02 | 分页查找同名有效供应商 | 16.544 | 20.773 | 6 | 0 |
| J03 | 异步查询，选择有效 B 设备 | 22.697 | 26.546 | 8 | 0 |
| J04 | 纯图片七项读数 | 24.960 | 31.032 | 5 | 1 |
| J05 | Selenium 动态方块和延迟输入框 | 46.749 | 52.150 | 10 | 2 |
| J06 | 启用、填写、禁用控件并保留值 | 23.060 | 27.608 | 8 | 0 |
| J07 | 计算器 27.4 英寸转厘米 | 32.912 | 39.554 | 8 | 0 |
| J08 | 记事本替换两处、保存、核对全文 | 119.662 | 126.581 | 11 | 4 |
| J09 | 递归 PNG 清单、保留原文件、桌面打开 | 85.748 | 92.933 | 13 | 2 |
| J10 | 原生工单多控件、只生成一次摘要 | 156.837 | 164.278 | 20 | 11 |
| J11 | Esc 中止，无后续写入 | 58.950 | 67.830 | 10 | 2 |
| J11-resume | 新轮恢复，只补未完成字段 | 14.581 | 16.690 | 4 | 0 |
| J14 | 写入后断开 MCP，重连核对而非重放 | 45.040 | 55.782 | 9 | 1 |
| J15 | 前台冲突后明确交接并恢复 | 86.043 | 97.379 | 11 | 0 |
| J16 | 目标退出，拒绝误写并如实报未完成 | 55.140 | 68.175 | 13 | 0 |
| J17 | 两次相同截图只调用一次 CUA | 30.558 | 36.175 | 6 | 1 |
| J18 | 首次执行公开综合表单 | 33.778 | 40.352 | 10 | 0 |


[Before/after](../.local/windows-final-20261118/before-after.png) · [Correctness](../.local/windows-final-20261118/accuracy-comparison.png) · [Cache](../.local/windows-final-20261118/cache-comparison.png) · [All timings](../.local/windows-final-20261118/final-timings.png) · [CSV](../.local/windows-final-20261118/results.csv) · [HTML](../.local/windows-final-20261118/results.html) · [Acceptance gate](../.local/windows-final-20261118/final-gate.json)

## 性能与正确性

对照图每侧各一轮，完整多轮记录见 CSV；网络、初始控件状态、模型推理波动和不同数据均明确标注。旧异步搜索有一次 114 秒主模型请求，旧分页轮有两次网络超时，它们仍保留在全量记录，但不拿来夸大图中的优化收益。记事本最终轮仍约 120 秒、四次 CUA 观察，复杂原生工单约 157 秒、11 次 CUA 观察；功能通过但性能没有全面改善，模型仍可能选择成本较高的完整识图路径。工单还出现一次状态失效拒绝，重新观察后完成，拒绝本身没有派发输入。不能宣称所有桌面任务都已提速或没有额外调用。

读数准确性图只报告冻结的七项图片读数、计算器显示值和记事本完整正文的检查命中比例，不能外推为通用准确率。旧图片轮虽然答案正确，却读取了隐藏 HTML，仍作为路径违规失败保留。两次前台恢复循环失败、注入时机未命中的轮次、慢样本和外网阻断也保留。旧版与候选浏览器 O/N 的交错多轮对照已记录在 [11 月 17 日报告](computer-use-acceptance-2026-11-17.zh-CN.md)，属于历史证据，不代替本次最终版本验收；旧“填两个框”和本次“替换并保存”不可当作同一任务直接比较。

## 自动化验证与实现文件

下表列实际运行目标与日志，退出码均为 0。部分回归有重叠，不相加冒充独立测试数量。前端 Electron 测试是真实嵌入浏览器，但仍与上面的真实模型产品流程分别记账。未改 Rust Agent 核心，未运行无关 Rust 全量测试，未制作安装包。

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

## 使用与边界

从 `D:\CodeBuddy-v1` 运行 `.\start-preview.ps1`；本次验收预览保持启动，无需安装包。仍需可用的主模型和 CUA API。例：要求“在指定窗口填联系人和分机，保持其余内容，不提交”，能直接读取的控件不会依赖识图。操作期间避免同时抢鼠标键盘；Esc 会停止本轮桌面输入，下一轮授权继续后先核对当前值。

遇到 OS 拒绝前台激活，需要人工把指定窗口置前再继续；不绕过这个边界。目标已经关闭时，正确行为是报告未完成，不在相似窗口上写入。API 服务别名已通过真实调用验证，但远端权重校验、GPU 和冷启动数据未取得，不能把 API 别名当作模型文件身份。没有发生额度耗尽；无法自行重置提供商的计费额度或限流。

目标退出轮虽然没有误写，模型仍发出了多余的观察请求、被宿主拒绝的读取范围变更，以及两次只读进程查询，合计 55.14 秒。这是仍待改善的效率问题，安全通过不等于流程已经最短。全量表保留 72 个有计时记录的轮次，并非 72 个独立成功任务。

所有修改仅在当前 main 的工作区，未提交、未推送，保留其他未提交改动。测试夹具、会话和逐轮数据留在 `.local/windows-final-20261118`，不纳入提交。

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
