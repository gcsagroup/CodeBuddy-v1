# Harness 主导执行：本批验收记录

> 20:16 用户日常 profile 暴露了本记录未覆盖的大历史列表阻塞。本页下文是早先批次的历史证据，不代表日常配置已经验收；后续根因、修复及完整日常窗口复验见[补充记录](2026-10-14-history-latency.zh-CN.md)。

日期：2026-10-14（北京时间）。对象：`D:\CodeBuddy-v1` 当前源码；原项目 revision `964bbeb1587f1c5551ee17907e0b26632c4163ce` 与未提交文件来源见 [source-baseline.json](source-baseline.json)。当前目录无 Git 仓库，本批没有分支、提交或推送。官方 npm Harness 固定为 `0.2.1-alpha.2`，MIT developer preview；npm 与参考源码对应边界见 [PROVENANCE.json](../../runtime/harness/PROVENANCE.json)。

[繁體中文](2026-10-14-harness-acceptance.zh-TW.md) · [English](2026-10-14-harness-acceptance.en.md) · [功能矩阵](v1-functionality.zh-CN.md)

**本批范围已通过：真实模型 ACP 对话、六模块暂停/后端重启/续作、最终真实 Electron 两轮显示复验、受控 Electron 恢复及当前源码预览启动。全集 327/327、后续显示修订受影响子集 30/30、组件回归 42/42。** 这不是全部首版功能或正式安装包验收；旧预览 286 项不算当前全套。20:05 [最终源码身份](../../.preview-evidence/harness-final-source.json)记录 Node `v24.21.0` 及 19 个文件 SHA256。[最终前端比较](../../.preview-evidence/harness-frontend-final-comparison.json)检查 1069 个文件：1067 未变、2 个获准修改、意外差异 0。

两处前端修改仅为 `ui/desktop/src/components/ProgressiveMessageList.tsx` 和同名 `.test.tsx`：普通聊天没有真实操作时不生成空活动区，保留思考与实际工具展示。这属于用户已批准的必要显示适配，不再宣称前端源码完全零变更。19:53 的 1069 文件零差异历史事实保留在[修改前快照](../../.preview-evidence/harness-source-before-empty-activity.json)。

19:55 的[来源 UI 复核](../../.preview-evidence/harness-source-ui-current.json)记录原项目当前 HEAD 为 `dfdc47fb1a8d483fc02293b85d977e87a8969f10`，1074 个原 UI 文件与复制基线一致。该当前 HEAD 与上方初始基线 revision 区分，不以旧 revision 冒充原目录当前状态。

## 根因与处理边界

| 现象 | 已核实事实 | 本批处理及边界 |
|---|---|---|
| 新对话创建慢 | 旧 `session/new` 等待 Harness、配置解密及扩展初始化。隔离测量：受保护全局配置 7916ms、显式配置 13320ms、慢 MCP 15849ms | 新建先持久化会话，首次执行再初始化，减少重复解密；对应测量 4ms、279ms、274ms。初始化仍有成本，独立 MCP 并行连接并保留逐项错误 |
| 等待后集中出字 | 原会话原生首片前等待 26.768s / 19.298s，随后原生文本增量集中于 14ms / 19ms，发生在 ACP 之前。受控分时 SSE 经 Harness→ACP→原 renderer adapter 保持间隔 | 当前真实 SDK 和原始 SSE 均观察到流式输出；历史服务、网络或请求条件的具体成因尚未确定。新增脱敏耗时、状态及网络原因代码观测，不声称已经修复某个未证实的服务端问题 |
| 正常回复却显示中断 | 原生 `completed` 被旧 CodeBuddy 完成协议要求 `codebuddy_task(answer)` 误判，这是适配层缺陷 | 普通正常轮次按原生事实完成；长目标消费原生 goal，不要求旧登记协议 |
| 另一轮 Connection error | 19:13 原生记录为真实 `TRANSPORT / Connection error.`；旧配置强制重试 0 次 | 恢复官方有界重试，真实错误保留；重试改善恢复，但并未确定历史断连的底层来源 |

[创建前测量](../../.preview-evidence/session-new-timing-diagnostic.json)、[修改后测量](../../.preview-evidence/session-new-timing-diagnostic-after.json)为隔离后端场景，不是所有机器的延迟承诺。默认容器仍为 `D:\CodeBuddy-Workspace`，每任务独立目录，显式项目保留。

原会话 `c4117cd6-e198-4d7a-8ada-6ffdbd15ea85` 的结束原因见[权威迁移记录](2026-10-14-harness-authority.zh-CN.md)。[受控流式回执](../../.preview-evidence/stream-timing-bgBLI9/receipt.json)中三片间隔约 350ms，Harness→ACP 耗时 15.45 / 2.46 / 2.26ms；它验证适配器链路，不等于真实 Electron 屏幕验收。

## 事实 owner 与改动范围

| 范围 | 官方 owner | CodeBuddy 适配职责 |
|---|---|---|
| 执行与子 Agent 调度 | Session Controller、AgentLoop、subagent | `runtime/harness/index.mjs` 接入、权限和角色模型选择；并行参数 1–32 映射官方总上限，无第二套 coder 调度器 |
| 长目标与自动续轮 | goal / goal-round-driver / tool-goal | `profile.mjs` 启用官方插件；active+armed 时 prompt 保持承载。Stop disarm，重启不自动重放；显式暂停恢复先建立流/权限，再调用官方 CAS resume |
| 清单与完成展示 | todo/write、turn/start、goal/change | `codepro.mjs` 只投影结构化事实，todo 属于当前轮，不虚构 DAG；harness_turn/harness_goal 不等于独立测试通过 |
| 创建与通信 | 产品会话、原 ACP、Electron 桥接 | `compat.mjs` 分离创建与运行时初始化，前端接线服从原生后端权威 |
| 网络恢复 | 官方 llm-retry | `transport-observation.mjs` 只观测白名单错误代码、耗时及计数，不记录内容、凭据、请求头或 URL，不修改 fetch/流 |
| MCP/设置/记忆 | 官方 MCP、工具及 storage-domain/storage-json | 产品配置、权限与展示保留；外部记忆可走 MCP，不声称上游存在独立内置 memory provider |

完整接口见[运行时说明](../../runtime/harness/README.zh-CN.md)。MCP 独立连接并行，单项失败可见；官方默认 60 秒为每请求超时，版本协商可能涉及多个请求，不是全体扩展总启动期限。

## 真实模型与流式指标

使用已保存 `kimi-k3` 配置和隔离数据根。下表为不同时间样本；完整提示词和运行参数不保证逐字相同，不能作为严格等价的性能 A/B。

| 路径 | 首片/首正文 | 总耗时与增量 | 回执 |
|---|---|---|---|
| 原始 SSE，48 工具 schema，high | 首网络 body 2.217s | 4.131s；37 网络块、70 SSE 帧；未执行工具 | [HTTP 200](../../.preview-evidence/diagnosis-20261014/direct-sse.json) |
| 官方 Harness driver，48 工具 schema，high | 首思考 2.885s；首正文 3.516s | 4.282s；143 增量＝58 思考＋85 正文；网络块跨 1.392s；工具尝试 0 | [passed](../../.preview-evidence/official-real-stream-4WEjgH/receipt.json) |
| ACP 新会话“你好” | 首正文 6.639s，含首次运行时初始化 | 7.917s；117 正文块，首末跨度 1.252s | [passed](../../.preview-evidence/native-chat-xvSway/receipt.json) |
| 同一 ACP 会话第二轮 | 首正文 3.003s | 3.816s；89 正文块，跨度 0.608s | 同上；两轮均 end_turn / harness_turn，无工具回执 |

ACP `session/new` 为 4ms，不含目录选择、窗口绘制等用户操作。上述 ACP 样本时间约为北京时间 19:35。

北京时间 19:52–19:53 使用原 renderer、真实 Electron、保存模型和隔离 profile 另做两轮聊天：[真实界面回执](../../.preview-evidence/real-chat-ui-xXzIZR/receipt.json)。新会话可见耗时 **478ms**，无需目录选择器；首轮首正文 9.973s、完整可见回答 12.624s、81 块/4 次 UI 提交；二轮首正文 2.802s、完整可见回答 6.812s、152 块/5 次 UI 提交。两轮全文 ACP/DOM 一致、completed/harness_turn，pageErrors 和 consoleErrors 为空。验收进程已回收；这是普通聊天产品验收，不是所有页面或工具的桌面验收。首轮仍有约十秒首正文等待，应与快速创建会话区分。

20:03–20:04 在上述两处前端修改后执行[最终真实两轮显示复验](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json)，状态 passed。新会话 **361ms** 可见，无目录选择器；首轮首正文 **11.807s**、完整可见回答 **15.207s**，109 块/4 次 UI 提交；二轮首正文 **3.084s**、完整可见回答 **6.759s**，135 块/5 次 UI 提交。两轮全文一致、completed/harness_turn，思考显示保留，无空操作计数和普通聊天验证卡，pageErrors/consoleErrors 均为空，验收进程已回收。首轮正文等待仍达 11.807s，不以会话快速创建代替模型响应延迟结论。

## 六模块真实开发、停止与重启续作

[项目回执](../../.preview-evidence/native-project-SI0dN5/receipt.json)为 `passed`，北京时间 19:35:31–19:37:00，约 89.8 秒。真实模型通过 ACP、官方 Harness 和实际工具实现 money/catalog/cart/discount/inventory/order 六模块。只准改 `packages/*/index.mjs`，测试合同只读，禁止网络、安装和 Git 写入。

1. 原生 create_goal/todo 后首次文件写入落盘，客户端发 `session/cancel`；首轮 cancelled，任务 paused。
2. 关闭后端服务器、创建新服务器、重新取得工作区租约并加载原会话，再发继续消息。这是后端实例重启，未模拟 OS 强杀或 Electron 关闭重启。
3. sessionId `b793f5e7-e334-44b2-a9b2-cd22a9c8b81a`、runId `b39c0b2b-aa60-41ab-b0a3-2eeeff66a0fe` 保持，旧事件前缀保持。
4. 原生测试命令退出 0，独立合同测试 **33/33**、失败/取消/跳过均 0：[日志](../../.preview-evidence/native-project-SI0dN5/independent-tests.log)。测试文件哈希未变。独立读盘复核首个 money 文件 SHA256、mtime 精确保持，最终仅一次该路径写回执。
5. 原生 goal `goal-7b1c87ab-9a6f-44a0-a6ca-f3df736e3a0b` 为 complete，投影 harness_goal。首阶段 48.142s，恢复阶段 41.108s，恢复后首正文 2.936s。

原生 `roundsStarted: 0`：该真实样本没有触发自动目标续轮，自动续轮由受控官方插件回归另证。**已证明分钟级六模块和后端重启续作；未证明小时级无人值守、大型生产仓库、真实并行云端协作或全工具箱。**

## 受控 Electron 恢复

[本批真实 Electron 恢复回执](../../.preview-evidence/controlled-ui-resume-ox7zjR/receipt.json)为 passed：使用真实界面、受控 HTTP 模型，停止后关闭/重启桌面，再加载并继续同一 run `b6108765-a665-4f80-88da-27dda281a3c2`。原生 14 次工具调用、5 次 todo 写入，goal 最终 complete；首文件哈希/mtime 与历史保持，独立 [3/3 测试、退出 0](../../.preview-evidence/controlled-ui-resume-ox7zjR/independent-tests.log)，pageErrors/consoleErrors 均为空。这验证桌面控制链；与六模块真实云端模型 ACP 测试分开。界面任务报告尚未给出独立 verification 标签，保留实际命令回执，不由显示文字虚构该标签。

## 自动化与最终结果

Harness 定向命令（已安装 Node 24）：

```powershell
node --test --test-concurrency=1 runtime/harness/test/driver.test.mjs runtime/harness/test/capabilities.test.mjs runtime/harness/test/recovery.test.mjs runtime/harness/test/goals.test.mjs
```

[一次合集 39/39、退出 0](../../.preview-evidence/harness-final-39.log)；随后并发 1–32 与 maxTurns+goal 边界的受影响子集 [27/27、退出 0](../../.preview-evidence/harness-goal-capacity-boundaries.log)。它们重叠，不相加。覆盖自动续轮、CAS、停止/重启不重放、自动压缩保留 goal/todo、部分流断连重试且副作用一次、AUTH 不重试、取消退避、MCP 并行及显式超时。maxTurns 达限后官方 goal disarmed，未误报完成。

| 门槛 | 状态 | 实际回执 |
|---|---|---|
| 本批后端/脚本全集 | **PASS 327/327，退出 0** | [最终全集日志](../../.preview-evidence/harness-authority-final-tests.log)，228.410s，失败/取消/跳过 0；随后纯聊天显示修订的[受影响 30/30](../../.preview-evidence/harness-terminal-display-tests.log)退出 0，5.859s，不加总 |
| 真实 Electron 普通聊天最终显示 | **PASS（UqLIqK，20:03–20:04）** | [最终回执](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json)：两轮全文一致，无空操作计数/验证卡，思考保留，无 UI 错误。此前 [HKem83](../../.preview-evidence/real-chat-ui-HKem83/receipt.json) 的空计数断言失败仍保留，不覆盖旧失败证据 |
| 当前候选受控 Electron 停止/重启/继续 | **PASS（受控模型）** | 上方回执：同 run、原生目标 complete、真实工具、独立 3/3、无 UI 错误 |
| 显示适配组件回归 | **PASS 42/42，退出 0** | 3 个组件测试文件，33.21s；[日志](../../.preview-evidence/real-chat-ui-UqLIqK/component-tests.log)，实际命令见下 |
| 当前源码用户预览启动 | **PASS（进程 running）** | [20:06:38 启动回执](../../.preview-evidence/harness-final-preview.json)，19 源文件哈希一致，新任务页面可见；不是发布安装包 |

本批全集与显示修订后的实际命令如下；第二条是第一条之后的受影响回归，不把两次数量相加：

```powershell
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' --test --test-concurrency=1 runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/*.test.cjs scripts/*.test.mjs *> .preview-evidence/harness-authority-final-tests.log
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' --test --test-concurrency=1 runtime/tests/harness-authority-acp.test.mjs runtime/tests/codepro-harness-projection.test.mjs runtime/tests/codepro-integration.test.mjs runtime/tests/codepro-harness-integration.test.mjs *> .preview-evidence/harness-terminal-display-tests.log
```

组件测试工作目录为 `D:\CodeBuddy-v1\ui\desktop`；[回执 componentValidation](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json)保留原运行信息，未为日志重复执行：

```powershell
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/ProgressiveMessageList.test.tsx src/components/ToolCallExpandable.test.tsx src/components/GooseMessage.stream.test.tsx
```

## 当前预览启动及数据保留

通过现有 `start-preview.ps1` 入口启动，隐藏 PowerShell 启动进程 36220；启动器 25292、后端 36136、Forge 38156、Electron 主进程 39740。20:06:38 可见 CodeBuddy 新任务窗口（句柄 33295174），19 个当前源码哈希匹配。启动构建的 SDK/i18n 准备门禁退出 0；应用仍在运行，不能把应用生命周期写成“退出 0”。只读启动检查器退出 0。

用户目录 `.preview-data` 的启动前 621 个会话全部保留，当前仍 621；默认 `kimi-k3` 及 provider 配置指纹未变，1 个迁入日程仍暂停，`D:\CodeBuddy-Workspace` 存在。见[启动/数据回执](../../.preview-evidence/harness-final-preview.json)。本次检查没有发送模型请求；真实任务证据在前述隔离验收中。运行日志位于 `.preview-data/logs/preview/runtime.log` 与 `electron.log`。

[环境对比](../../.preview-evidence/harness-final-environment-comparison.json)为 unchanged、差异空：User/Machine/Process PATH 及协议注册指纹保持。该交付是当前源码的 Windows 开发预览窗口，非安装包或 macOS 交付。

## 保留的首版缺口

[功能矩阵](v1-functionality.zh-CN.md)保留 Git 远端/还原/冲突操作、GitHub 账号/PR/CI、Nostr、本地 ASR、复杂配方、OAuth、全部设置/工具真实桌面流程等未接或待验项。Windows 证据不替代 macOS、安装包、小时级任务或大型真实仓库验收。实现、受控自动化、真实模型 ACP、真实 Electron 和发布验收分开记录。
