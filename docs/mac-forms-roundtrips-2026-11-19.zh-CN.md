# Mac FORMS 工具往返优化与复验（2026-11-19）

[繁體中文](mac-forms-roundtrips-2026-11-19.zh-TW.md) · [English](mac-forms-roundtrips-2026-11-19.en.md)

本批完成原生单字段聚焦写入、FORMS 文本回执去重，以及真实 Mac 复验。最终三组每组少两次工具调用，合计输入 token（含缓存）减少 31.19%，工具执行时间减少 33.35%。**整轮平均耗时没有明显改善：Harness 平均 24.489→24.476 秒；包含轮次外等待的 ACP 平均 25.860→28.837 秒，反而增加 11.51%。不能宣称全面提速。**

三组最终表单均为目标 2/2、误填 0、漏填 0，账单邮箱和原备注逐字保留，提交 0。聚焦弹窗、同名邮箱、实际 Esc 接管、写入后回执丢失与恢复、PDF 保存读回均有本批证据。此前六项的完整范围见[上一批报告](mac-computer-use-six-acceptance-2026-11-19.zh-CN.md)；本批是受影响链路复验，不把上一版官方样例网页等证据冒充新二进制重测。

## 根因与实现

上一批同条件无 FORMS / 有 FORMS 为 20.389 / 26.746 秒；工具累计约 2.439 / 2.844 秒。6.357 秒差异中工具仅增加约 0.405 秒，本地两个投影字段评分约 6.27 / 1.96 ms。主要成本在额外模型往返、上下文和轮次外等待，不是 FORMS 每字段推理花了几秒。

- 用户批准的 `set_value(focus=true)`：在同一次原生调用内聚焦已观察字段，再复核窗口、身份、旧值、位置、实际焦点、人工输入版本及租约，最后写值并回读。每字段省掉 click→模型→set_value 中的独立 click。仍逐字段决策，不批量填写；失败没有坐标或键盘回退。省略参数兼容原行为。详见[协议边界](mac-focused-value.zh-CN.md)。
- FORMS 文本回执去除重复候选资料、已拆解的 selected_option 和重复标签；完整结构化结果不变。保留精确推荐值、当前值、控件索引、来源、概率、截断和错误信息。
- 中间英文轮把“local FORMS”误当工作区文件，发生额外工具搜索和 glob。技能明确它是 `get_app_state(form_entities=...)` 内置的本地能力，最终英文轮没有这些无关调用；没有更改用户测试提示词或全局工具选择器。
- Preview 实测 AXFocused 即使标为可写，仍可能返回 -25200。最终技能限定网页优先 focus=true，原生 PDF 使用已有直接写值。没有给原生执行器加失败自动回退。

实际改动：`tools/qwen-computer-use/main.go`、`form_matching.go`、`focused_value_test.go`、`macos/RuntimeContract.swift`、`macos/runtime.swift`、`macos/contract-tests.swift`；`runtime/harness/skills/computer-use/SKILL.md`；所有权地图 `documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md`；三语协议及本报告。保留其他既有 dirty 文件。

## 同条件三组对照

同一台 Mac、外部 Safari、同一夹具与初值，每组前后提示词逐字相同；Ollama `deepseek-v4.1-flash`、`reasoningEffort=high` 已从每轮 request/header 验证。公司、工作邮箱初始为空；账单为 `billing-keep@example.test`，备注为 `旧备注逐字保留 731：先核对，后提交。`。每组通过运行中 Mac CodeBuddy 的 ACP 对话链路驱动真实原生工具，另以 RustDesk 查看实际结果；不是直接调用工具替代主模型。可见 CodeBuddy 对话另用于 Esc 与 PDF。

| 提示词组 | Harness 秒，前→最终 | ACP 秒，前→最终 | 工具次数 | 未缓存输入 token | 缓存读取 token | 输出 token |
|---|---:|---:|---:|---:|---:|---:|
| 中文明确字段 | 27.780→38.655 | 28.181→48.827 | 9→7 | 43,543→24,842 | 104,192→77,952 | 1,390→1,175 |
| 英文明确字段 | 23.157→15.585 | 24.583→18.063 | 8→6 | 31,535→25,546 | 89,088→55,168 | 952→869 |
| 中文口语表达 | 22.530→19.187 | 24.816→19.621 | 9→7 | 43,659→24,292 | 99,328→75,264 | 1,700→1,641 |

合计工具次数 26→20；工具回执字符 154,212→123,979（-19.60%）；未缓存输入 -37.10%、缓存读取 -28.78%、输出 -8.83%。合计输入不是账单金额。样本是三个不同提示词各一次配对，不是稳定性分布或统计显著性结论。

中文最终轮工具仅 2.448 秒，但请求到模型答复的步骤间隔中有 7.852 秒、10.869 秒的长等待，ACP 另比 Harness 多约 10.172 秒。日志能定位到模型/轮次外围等待，不能据此证明是某个远程供应商内部故障。英文和口语轮速度改善，中文轮抵消了整体收益；不删掉这条慢记录。

中文最终轮 FORMS 投影 Company/Email 后实际推荐两项；英文 Company 推荐填、Work email 仍建议 skip，主模型依据明确字段与用户指令选择填写。不能把后者记作 FORMS 两项推荐成功。中文口语轮推荐与填写均两项正确。

完整提示词、会话、工具参数、回执、耗时和 token 在本地 `.local/mac-forms-speed2-20261119/{cases,summary,metrics}.json` 与 `sessions/`。最终会话依次为 `820b5654-d559-4f2e-a45a-a3ed55ebb542`、`e7ae4fcb-10be-4b8c-a01c-abdff649d02c`、`6be5ebfe-705e-4649-bf2c-fd67964137cf`。

## 安全及保存复验

| 场景 | 实际结果 |
|---|---|
| 聚焦即弹窗 | 原生复核发现控件消失，未写公司/邮箱，弹窗旧值未改；模型停止输入。操作员在整轮结束后关闭测试弹窗。 |
| 两格都叫“邮箱” | 只填公司；两邮箱旧值、备注保留，并告知歧义。 |
| 公司写入后原生进程断线 | 夹具观测真实公司 input 后终止已绑定的测试 worker；回执未知进入 DESKTOP_STOPPED，工作邮箱未填，不自动重放。 |
| 同会话断线恢复 | 先重新观察，只补工作邮箱；公司不重复写，旧值保留，提交 0。 |
| 可见 CodeBuddy 对话，人工 Esc | 公司已填、邮箱未填时实际按 Esc；到用户新一轮恢复之间无 input 事件。 |
| 同可见会话恢复 | 重新观察、关闭临时弹窗，仅补邮箱；未知参考代码 REF-KEEP-721 也保留，提交 0。 |
| 可见 CodeBuddy 对话，Preview PDF 保存 | 单次旧式 set_value、单次保存；磁盘四栏与目标一致，原备注和账单保留。独立 PDFKit 读回及可见界面双重核对。 |

本批所谓断线是原生 worker 在写入与回执之间被终止，不是 RustDesk 断开或任意网络中断的泛化证明。安全场景与最终轮使用同一原生二进制；最后技能变更只调整 PDF 调用选择，网页路径未改。

PDF 最终会话 `f46940ba-512f-4d8e-9d57-d6aa31a537e7`：52.687 秒，11 工具调用；磁盘 `工作邮箱=haifeng+verified@example.test`。本轮仍发生一次不完整窗口选择器拒绝、一次识图及保存后额外观察；这是功能/落盘通过，**不计作 PDF 提速成功**。PDF 原生磁盘读取约 0.811 ms；不能用它代替整轮耗时。

中间候选三组耗时 26.792 / 36.980 / 23.195 秒，保留在记录中；英文额外文件搜索的问题已修正。第一次 PDF 聚焦调用失败，后续被操作员 Esc 中断，未保存；该失败记录保留，不算通过。

## 构建、自动验证与交付边界

Windows 源码为 `D:\CodeBuddy-v1`，`main@4c8afad978b6e893a3545c0859dd5b4824a91223` 加已有及本批未提交改动。Mac 为 `/Users/erjinyi/Desktop/work/CodeBuddy-v1`，Git HEAD `732113504de3601ab087a609ce20827b814db2c2`，应用 Windows 当前源码覆盖层；两端源码清单按规范化换行哈希核对，不能只比较两个 HEAD。

最终运行 PID `31533`，启动 `2026-11-19T04:01:06.499Z`，source/current hash 同为 `677e55481e4fa4e3a796f2720f7e8e76752d3073c7c28b4a4e5290ba9032a810`，restartRequired=false。该运行时 hash 不覆盖所有原生/技能内容，另留原生 SHA-256 `fad15ef85ce0d3eda9d55834bff34ad3cacb233ebaf8ab52ba8cd692326dda29`、最终技能 SHA-256 `43d56e37f49d44e16ddc7b61504213f1f2efe0c479d8c920e8277564744b0d6d` 及源文件清单。

以下有效命令均退出 0：

- Windows、Mac Node 24 `--test runtime/harness/test/computer-skill.test.mjs runtime/tests/desktop-coordinator.test.mjs runtime/tests/desktop-control.test.mjs`：各 38/38；最终 PDF 调整后单独技能回归各 4/4。
- Mac `go test ./...`、`go vet ./...`（`tools/qwen-computer-use`）；Go 文件已 gofmt。
- 现有 `.local/mac-deep-20261119/build.cjs` 包装 `buildMacComputer(root,'arm64',{test:true})`：Swift 合同及真实 CoreML/PDF 8/8、production 原生构建通过，产物 `computer-arm64-mVVpaa`。有既有 macOS activateIgnoringOtherApps 弃用告警，不是构建失败。
- `python -X utf8 .local/mac-forms-speed2-20261119/verify.py`：9 轮前/中/后表单事件、初值、逐字保留、提交 0、模型/强度相同、聚焦弹窗、Esc/断线恢复和 PDF 磁盘值断言通过。
- 本批相关文件 `git diff --check` 通过。未改 Rust，未运行 Cargo/Clippy；未做 Windows 桌面产品 E2E。

这是已运行并验收的 Mac 源码预览，没有制作新 DMG，没有提交或推送，没有新增依赖。测试服务/页面在取证后关闭，保留可运行预览和本地证据。剩余性能限制是主模型及轮次外等待波动、少量冗余观察；没有通过降思考强度、隐藏失败或移除安全检查来换速度。
