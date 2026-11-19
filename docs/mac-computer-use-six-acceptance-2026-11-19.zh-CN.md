# Mac Computer Use 六项交付验收（2026-11-19）

[繁體中文](mac-computer-use-six-acceptance-2026-11-19.zh-TW.md) · [English](mac-computer-use-six-acceptance-2026-11-19.en.md)

结论：最初约定的六项，在本报告列出的夹具和运行环境中均通过。窗口描述定位、中文 FORMS、真实窗口切换、弹窗、Esc 接管、写入后丢失回执、同会话恢复、网页和 Preview PDF 均有实际工具回执及结果核对。交付为正在运行的 Mac 源码预览版，不是新 DMG，也不代表任意 Mac 应用全覆盖。

## 构建来源与模型

- Windows 源码：`D:\CodeBuddy-v1`，`main@4c8afad978b6e893a3545c0859dd5b4824a91223`，包含既有及本次未提交改动。未创建分支、提交或推送，未清理其他工作。
- Mac：`/Users/erjinyi/Desktop/work/CodeBuddy-v1`，Git HEAD `732113504de3601ab087a609ce20827b814db2c2`。采用 Windows 当前工作区源码覆盖同步，不能把 Mac HEAD 说成 Windows HEAD。交付前逐文件比较规范化换行的 SHA-256：Windows 纳入清单的文件在 Mac 均存在且内容一致。Mac 额外本地文件及许可证保留；排除 `.local`、依赖、缓存及本地报告目录。
- 最终运行时 PID `29316`，启动 `2026-11-19T02:54:24.016Z`；source/current hash 均为 `677e55481e4fa4e3a796f2720f7e8e76752d3073c7c28b4a4e5290ba9032a810`，`restartRequired=false`。
- 最终原生运行器 SHA-256：`9e30cfdd6ffcbafa6160d5ee5e8f3fa21de8d3dfd3ee5db3b707c0b94d1e8f17`。实际构建目录 `target/codebuddy-package/computer-arm64-sHYE7q`。
- 真机：Apple M2、16 GiB、macOS 27.0.1 (26A434)、Swift 6.4.2。GUI 启动进程实际读取控件、截图、输入成功；SSH 单独启动进程的屏幕权限失败不算产品失败。
- 主模型固定 Ollama `deepseek-v4.1-flash`、高思考强度；本地 CoreML FORMS 只提供匹配建议；`CUA-S1-Qwen3.5-4B` API 只做截图观察。

## 本轮修复

1. **窗口定位**：模型曾把“当前客户表”里的描述词当完整窗口标题。工具 schema 和技能明确：`window_title` 是不可变的精确标题约束，描述性目标先列出窗口并选真实 selector。宿主只允许首次发现工具建立范围，后续输入不能扩大或替换范围。不是增加中文关键词特判。
2. **FORMS 投影误过期**：Safari 会插入、移除无名称、无值的装饰性 AXGroup，使原先整个 AX 树比较失败。原生校验忽略这类空非编辑节点，仍保留所有有名称/值节点、所有可编辑字段（包括空且无名字段）、窗口及字段绑定校验。控件内容、编辑字段、位置或身份变化仍会拒绝旧投影。中文标签由主模型译成评分标签，中文原值不改写。
3. **断线等待不结束**：输入已经生效但原生执行器在回执前断开，模型再观察会卡在暂停等待。宿主现在将这一轮电脑控制结束为 `DESKTOP_STOPPED`，明确结果未知，保留其他独立工作能力；用户新一轮继续时重新观察，不重放旧输入。没有增加第二套状态协议。

主要修改：`runtime/desktop-coordinator.mjs`、`runtime/tests/desktop-coordinator.test.mjs`、`runtime/harness/skills/computer-use/SKILL.md`、`runtime/harness/test/computer-skill.test.mjs`、`tools/qwen-computer-use/main.go`、`macos/RuntimeContract.swift`、`macos/contract-tests.swift`；同步三语标签投影文档和所有权说明。此前已批准的 PDFKit 落盘读取、FORMS 参数及识图优化继续保留，见[上一批性能报告](mac-forms-performance-2026-11-19.zh-CN.md)。

## 六项验收

| 项目 | 实测结果 | 状态 |
|---|---|---|
| 1. Mac 基线 | 真机读取标题、字段、当前值；实际输入、截图；真实本地 CoreML 评分与官方样例链路 | PASS |
| 2. FORMS 匹配 | 中文 Company→云杉测试、Email→yunshan+forms@example.test，推荐及实际填写 2/2；同名邮箱保留并说明，未知客户等级不猜填 | PASS |
| 3. 对话到原生执行 | 可见 CodeBuddy 对话发起 Preview 修改，真实字段变化、回读及保存后磁盘一致 | PASS |
| 4. 草稿与中断 | 账单邮箱/备注逐字保留；切到 Finder 后旧点击被拒绝；弹窗取消；Esc 和断线各自停控，同会话重新观察后只补缺项 | PASS |
| 5. 网页和原生应用 | FluidUse 官方网页 3/3，另 20 项保留，提交 0；Preview 最终四栏正确且原文件保存 | PASS |
| 6. 对照与交付 | 同模型/强度/初值 A/B，记录正确、错误、遗漏、耗时及 token；可运行预览、提示词、夹具、原始记录齐备 | PASS |

中文本地评分证据：`cn-projection` 会话 `d2c2bbe1-6d06-4d0e-8c20-c7d80aa15fda`。原始中文评分 skip 后，主模型投影绑定真实字段，Company 和 Email 分别推荐目标值，概率约 0.999157 / 0.999960，单字段评分约 18.818 / 2.898 ms。未映射的账单及备注不评分、不写入；实际页面事件确认结果。

## 用户流程与中断证据

耗时以下统一采用 Harness `turn/start` 到 `turn/end`；服务往返计时另外保留，不能混算。

| 场景 / 记录名 | 秒 | 结果 |
|---|---:|---|
| 中文泛称当前客户表 / scope-cn | 29.980 | 海风测试、qa@example.test 2/2，旧值保留、提交 0 |
| 中文另一种描述 / scope-description | 33.839 | 青禾咨询、qinghe@example.test 2/2 |
| 英文指令 / scope-en | 42.582 | Cedar Labs、cedar.ops+review@example.test 2/2 |
| 明确完整标题 / scope-exact | 26.106 | 标题核对、title@example.test 2/2 |
| 精确标题不存在 / scope-missing | 10.748 | 两次同范围观察，零输入 |
| 同名邮箱 / ambiguous | 28.244 | 只改公司，两格邮箱逐字保留，明确说明分不清 |
| 不存在的客户等级 / unknown | 33.083 | 两个可确认字段填对，参考代码等旧值不变，报告缺失栏位 |
| 临时弹窗 / popup | 42.540 | 取消弹窗，不在弹窗输入；目标字段正确 |
| 可见 UI Esc / escape-ui | 40.227 | 公司已写，工作邮箱仍空；后续输入被 STOPPED 阻断 |
| 同一可见对话继续 / escape-ui-resume | 32.758 | 重新读取、取消弹窗、只补邮箱；不重写公司 |
| 写入后丢回执 / lost-fixed | 25.461 | 公司已实际写入；结果未知、停止电脑控制，无等待死锁 |
| 同会话断线恢复 / lost-fixed-resume | 12.151 | 重新读取已有公司，只补邮箱，不重复写入 |
| 实时切到 Finder / switch-timed | 40.108 | 旧点击 NOT dispatched；重新观察前台及 Safari 后继续，未写 Finder |
| 中文本地真实推荐 / cn-projection | 33.422 | 推荐 2/2、填写 2/2、无投影过期错误 |
| 官方样例 / official | 36.731 | Nora、Lin、nora.lin+sample@example.test 3/3，其他 20 项原样 |
| 可见对话 PDF / pdf-ui | 23.815 | 保存一次；无识图、无 shell；界面与落盘四栏一致 |
| 只读截图 / vision | 17.323 | 真实 CUA 返回四栏原文；零修改工具，PDF 哈希不变 |

窗口五项在本轮窗口修复候选上执行；其中两轮暴露装饰节点导致 FORMS 投影过期，因此只证明定位和最终填写，不算 FORMS 成功。随后原生修复已重建，中文 `cn-projection`、英文 `forms-compare` 和最终 PDF 使用修复后的运行器验证。Esc 在相同最终原生二进制上完成；随后宿主断线修复重新启动 PID 29316，断线及其后各项均使用此最终宿主。没有将旧二进制的未修复行为算作新实现通过。

断线通过终止本次隔离测试的原生 worker 制造，时间点位于真实页面公司输入事件之后、工具回执之前；并非仅关闭 RustDesk。第一次 `lost` 暴露等待问题，保留为修复前失败。修复后的初始公司已是目标值，但仍观察到一次完整写入及回执丢失；恢复轮次没有再写公司。

`escape`（ACP 发起，未激活可见 UI Esc 监听）和 `switch`（人工切窗太晚）均保留为无效注入尝试，不计通过。有效接管为 `escape-ui`，有效切窗为 `switch-timed`。测试过程没有把断线结果未知写成“未执行”。

最终可见 PDF 会话：`ec0548c4-8a0e-4feb-9e29-15e33998d1f0`。公司原本已是海风测试，所以实际只改工作邮箱；四栏结果为海风测试、haifeng+pdf@example.test、billing-keep@example.test、保留原备注：海风旧稿 001。一次 `super+s` 后，原生 PDFKit 回执和独立只读磁盘检查一致。可见 CodeBuddy 完成回执与 Preview 页面分别核对。

## 同条件性能对照

两个新会话、相同空公司/空工作邮箱及相同旧账单/备注，固定 DeepSeek 和高强度。结果均为填对 2、填错 0、漏填 0、提交 0。

| 路径 | Harness 秒 | 服务往返秒 | 未缓存输入 | 缓存读取 | 输出 token |
|---|---:|---:|---:|---:|---:|
| 原生控件，无 FORMS | 20.389 | 20.756 | 38,612 | 79,232 | 1,044 |
| 原生控件 + FORMS | 26.746 | 31.047 | 42,627 | 105,472 | 2,370 |

本例 FORMS 多约 6.36 秒、未缓存输入多约 10.4%，没有整体提速或省 token。收益是本地候选匹配证据；主模型观察、投影与决策仍有成本。不能把本地毫秒级评分说成整轮更快。这是单次配对，不是延迟分布统计。

最终 PDF 本轮 23.815 秒、31,013 / 70,528 / 1,375 token，没有额外识图和 shell。与此前不同初值不能再算新的优化百分比；严格同提示词同初值的历史 PDF 69.216→25.965 秒对照及识图同图对照保留在上一批报告。

## 自动验证和复用方式

以下最终有效命令均退出 0：

- Windows/Mac Node 24：`--test runtime/tests/desktop-coordinator.test.mjs runtime/tests/desktop-control.test.mjs runtime/harness/test/computer-skill.test.mjs`，各 38/38。
- Windows Node 24：`--test runtime/tests/session-lifecycle.test.mjs`，19/19。
- Mac `tools/qwen-computer-use`：`go test ./...`、`go vet ./...`；执行 gofmt。
- Mac 既有 `buildMacComputer(root,'arm64',{test:true})` 构建入口：Go、Swift 合同、真实 CoreML/PDF 8/8、release 构建通过；日志 `native-context-build.log`。已有 macOS API 弃用警告仍在，没有构建错误。
- `python -X utf8 .local/mac-six-20261119/verify.py`：逐条页面事件、FORMS 推荐、打断与恢复、PDF 落盘、识图及哈希、源码身份断言通过。验收脚本最初把官方 HTML 字段 ID 写成 firstName/lastName，按实际 first/last 修正；未修改产品结果。
- 源码清单对照与 `git diff --check` 通过。无 Rust 改动，未运行 Cargo 或重建安装包。

Mac 当前预览使用既有 `.local/fluiduse-20261118/launch-preview.command` → `start-preview.sh`；数据隔离在 `.local/fluiduse-20261118/profile`。本批证据在两端 `.local/mac-six-20261119/`，包括 `summary.json`、`verified.json`、`sessions/`、`events.jsonl`、`final-identity.json`、`source-{windows,mac}.json`、`cases.json`、测试日志和 PDF 前后值。夹具为 `server.cjs`（端口 56958）、官方样例 HTML、`/tmp/codebuddy-speed-customer.pdf`；进程重启后按 `start-server.py` 启动夹具。原始模型文件不纳入交付提交。

复验可在 Mac CodeBuddy 输入：

> 预览里打开的 codebuddy-speed-customer.pdf 是测试客户表。把公司改成“海风测试”，工作邮箱改为 haifeng+pdf@example.test，其他两栏保持原样。请核对后保存原文件，不提交。

网页提示词、英文、歧义、接管和恢复指令均在 `cases.json`。不得机械重跑故障注入脚本到其他会话；其目标严格限定本次隔离测试 worker。任意新表单、其他 macOS 版本、Windows 全产品 E2E 和发行安装包不属于本报告通过范围。
