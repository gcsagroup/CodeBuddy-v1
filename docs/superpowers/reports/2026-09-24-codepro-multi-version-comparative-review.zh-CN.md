# CodeBuddy 多版本、交付与交互对照审查

日期：2026-09-24。性质：只读取证与修复建议，不是实施记录、测试通过证明或冻结计划修订。

## 1. 结论先行

差距真实存在，而且不只是 UI，也不能归结为模型能力或子 Agent 数量。

CodeBuddy 已经有可追查的工具回执、权限拦截、事件账本和完成证据。但本轮证据说明：**同一个用户目标，在工作区选择、委派暂停、主循环继续执行、下一轮恢复和完成判定之间，仍会失去一致的绑定。** 前端又主要展示工具传输卡，未把实际工作组织成可理解的过程。

因此，“骨架更清楚了”成立，“只是外观细节未打磨”不够准确。当前同时有核心行为缺陷、链路迁移缺口和独立的展示问题。新架构不应推翻，当前产品也不能放行。

WorkBuddy 的优势值得承认：提供了更完整的项目产物、实际测试脚本、较清楚的技术组织和持续的用户可见说明。但它的自述不是宿主源码；报告生成器也存在验证结果来源不可靠的问题。应学习交付方法和信息层级，不复制它的所有断言、规则和绕过策略。

三位子 Agent 分别负责会话/账本、当前源码反证、成熟框架源码；主 Agent 抽核关键账本与证据 artifact，检查 WorkBuddy 产物，并对初步结论作交叉质疑。最终保留的边界包括：

- 原始目标仍未完成，不等于所有工具都没做事。
- 目录选择不匹配是触发条件，不是宿主无法受阻退出、暂停后继续执行的免责理由。
- 工具写入获批不等于用户接受替换交付目标。
- 用户后续取消委派要求必须被尊重，不永久保留旧要求。
- 不同模型、不同任务、不同目录、不同运行版本，不能只按工具数量或总时长排名。

## 2. 样本身份与比较边界

| 样本 | 实际对象与证据 | 可以判断 | 不可以判断 |
| --- | --- | --- | --- |
| 用户提供的旧版 `对话.txt` | session `20260924_13`；`D:\test121`；目标“帮我开发一个教务管理系统”；provenance `24a06d767f4f02d1fcf11651a62b471c3d4d0fa2`、dirty=true | 旧 Planner/Coder/Tester 路径、worker 活动事件、启动请求与失效检查点 | 不能当作干净 baseline；父级没有普通 toolRequest 不等于 worker 没执行 |
| 新版完整教务系统附件 | session `20260923_12`；`C:\test\test_0922`；目标“开发一个完整的教务系统”；provenance `1d9a60af…`、dirty=true | 动态 Main Agent 写文件、环境探查/验证受阻、委派预检与用户接手启动 | 不能把当前磁盘后续修改当作当次产物；不能把吃饭等待计入执行效率 |
| EDU 候补名单 | session `20260924_1`；`C:\test\test_0923`；目标在已有系统上加候补、先独立只读审查；provenance `1d9a60af…`、dirty=true | 导出、canonical session DB、控制面账本与 Evidence artifact 可互证 | 与从零建设教务系统不是同任务；损坏导出不可直接当合法 JSON 统计 |
| WorkBuddy 教务项目 | `C:\test\test_0924` 的 README、实现、测试、开发档案、报告脚本，加用户截图和自述 | 静态产物质量、测试断言、交付组织、截图可见交互 | 未取得完整原始宿主日志/私有源码；不能证明全部内部机制、当前产品 PASS 或量化效率领先 |
| Codex 对照 | 用户视频/截图；官方工程说明与公开源码 | 公开事件、审批与工具循环设计；可观察的展示层级 | 公开 Rust/TUI 源码不等于桌面客户端内部归组算法 |

两个合法 CodeBuddy JSON 的模型配置均为 `kimi-k3`、context_limit=128000；这不足以控制系统提示、工具、模型服务实际版本及运行条件。WorkBuddy 截图显示不同模型标签，不能把全部产物差异归因框架。

审查当前源码：`C:\Users\admin\CodeBuddy`，分支 `fix/codepro-context-compaction`，HEAD `1d9a60af0f543fa7f160b87a9904cd7440a9c444`，大量已有 dirty 改动。当前桌面内置 `goose.exe` 文件时间 2026-09-24 10:19:34，SHA-256：

`B55E6CA0FA7D5B58E5ADA61ECB4B6D68182DAD1DB7D0413FB6930B95DADEE605`

这是本轮读到的文件身份，不能倒推各历史会话必然运行这个二进制，也不能以 HEAD 代替完整 candidate 源码身份。

输入归档哈希：

- 旧版 `对话.txt`：`BAB4B11AFA1F11099B3214B746637E5F843D8AA72BB0436CDBC85D71924F6434`。
- 新版附件 `1b715021…/已粘贴的文本.txt`：`D56EFDC3442405B22DF8A86E8233B2C790121A88CB62CFE54154BAC75296A36A`。
- `EDU-0924-1125.txt`：`31A65B775A39C2663AD62A857A6CE8030DD5E7D62176B89DC6C016894451C639`。

EDU 导出剥落了引号、路径反斜杠等字符。只读 DB 中该 session 的 276 条消息、最后时间 `2026-09-24T03:24:53Z` 与导出尾部元数据一致。本轮以 DB 和权威账本补证，不自行“修复”原始证据文件。以下时间线统一使用 UTC，换算本地需加 8 小时。

## 3. 三个 CodeBuddy 样本真正说明了什么

### 3.1 旧版：不是没执行，而是阶段、交付和恢复没有闭环

旧版 68 条消息中有 58 条 `progressMessage`。可以看到 Coder 的文件写入和 Tester 的读取/命令事件。原任务下 Coder 记录了 `src/db.py`、`src/app.py`、`run.py`、`src/__init__.py`、`README.md` 五个文件变更；事件有开始/结束等记录，不能把事件数直接当不同文件数。

Tester 的 `mkdir tests` 被有界验证合同跳过，动态验证仍为 NOT_RUN。首轮出现 `completed` 展示，但报告说明整体不能判断完成。随后用户仅要求“帮我启动”，却再次进入 change/L2 的 Planner→Coder→Tester；中断后 checkpoint 为空，接下来的启动询问和继续确认反复得到“检查点已失效”。

合理之处：worker 活动有结构化路径和工具结果，能生成细粒度进度。

不合理之处：启动被固定开发流水线接管；已有产物与下一步启动没有形成顺畅延续；失效恢复变成对话死胡同。该样本不能证明旧版交付更可靠，更不能成为恢复旧固定流水线的理由。

### 3.2 新版完整教务系统：能写大量代码，但无法完成最基本的“运行起来”

导出有 157 条消息、56 次工具请求，其中 26 次成功写入、12 次 shell 请求均未执行，唯一委派发生在主要写入之后，请求涉及依赖安装、测试和可写修复，被父子写域检查拒绝。这不是“委派根本没有实现”，也不是子 Agent 自主协作成功。

最早的环境探查已经失败：`python --version`、`pip show flask` 被有界 shell 拦截。之后继续生成 Flask 项目，直到用户手工启动报 `ModuleNotFoundError: No module named 'flask'`。这是交付链上的真实损失：**环境可行性尚未建立，后面的代码产出没有转化成可运行交付。**

当前 `ValidationInvocation::is_allowed` 对 Node、Python 等执行形式的支持不同；例如 Node 版本查询和脚本调用有路径，Python 简单版本查询不在相同分支。这个分类器不是通用开发执行能力，更不能因命令名字像“test”就证明脚本无副作用。[当前验证调用源码](C:/Users/admin/CodeBuddy/crates/goose/src/agents/validation_invocation.rs:247)

不能用“多加几个字符串”解决此类问题，也不能取消安全门禁。应先明确普通环境探查、项目本地执行、依赖安装/网络副作用分别由哪种现有执行能力和审批合同承接；能力不足时给出真实边界，在技术路线仍可调整时让模型看见。

当前磁盘项目还存在值得独立改进的产物质量问题：README 明示教学演示版，登录以明文密码比较；WorkBuddy 产物使用带盐 scrypt。两者说明模型输出质量也有差距，但不能仅凭一份产物给模型或架构作普遍排名。CodeBuddy 的测试文件亦包含角色权限和数据库断言，不应描述为完全没有测试意识。[CodeBuddy 产物](C:/test/test_0922/jiaowu-system/README.md)、[登录实现](C:/test/test_0922/jiaowu-system/app.py:70)、[WorkBuddy 密码实现](C:/test/test_0924/server/lib/common.js:9)

### 3.3 EDU：本轮最高优先级是暂停后继续执行与续跑合同失联

原请求是修改“当前教务系统”，但工作区是 `C:\test\test_0923`，其中主要是 greeting 测试夹具；现有教务系统后来被定位在 `C:\test\test_0924`。缺少正确对象时，合理行为是保留原目标、说明定位结果，并请求真正必要的目录/范围选择，或合法受阻退出；不是反复自检直到另造一个可以通过自测的替代交付。

canonical 会话共 96 次工具请求：其中委派 10、写入 3、编辑 6、shell 16。10 次委派中，首次超时，8 次因 run 已 Paused 无法注册，1 次因子工作目录越界拒绝。这里的计数说明重复碰撞与无效推进，不用于和不同样本比赛速度。众多 `role=user` 记录实际是工具结果、压缩摘要或宿主复核注入，不是人类重新授权。

| UTC 时间/事件 | 已确认事实 | 含义 |
| --- | --- | --- |
| 02:49 起 | 原 run 注册完整候补目标，开始只读委派 | 这里确实尝试使用子 Agent |
| 02:54:41 | 委派超时；子任务、主任务和原 run 均写入 Paused | 账本能准确记录受阻，是已有价值 |
| 约 03:01 | 同一聊天继续成功写入独立 `edu-waitlist` 三文件 | 已暂停控制面没有有效约束仍在运行的工具循环 |
| 后续 | 独立示例测试 12/12；外部原系统旧冒烟 40/40 | 都不是“已集成候补”的证据 |
| 03:12:32 | 用户“继续”创建新 run，而非原 run 恢复事件 | 必须核对合同继承，而不是只看聊天看起来连续 |
| 03:14—03:18 左右 | 外部 `db.js`、`enroll.js` 编辑被 exact-file write_scope 拒绝 | 跨目录写入拦截有效；未发现这些编辑成功越权 |
| 03:21:11 | “继续”run 的 `task_succeeded`、`run_completed` 落账 | artifact 无工作区写入，唯一验证是独立示例测试，原系统集成未完成 |
| 03:21:37 后 | 用户“不delegate了”创建另一个 run，随后也 Completed | 用户已撤销后续委派要求，不应再强迫委派；但不等于撤销候补集成目标 |
| 03:24 | 用户“2”选的是把现有项目移入工作区再改造；新 run 随后 Cancelled，零工具 | 不是用户接受独立示例；取消来源未知，不能归因模型失败，也不能断言用户主动取消 |

这里的定性不是靠最终文案猜出来的：

- 原 run `run_0453d44c-46ab-4c0b-ad30-bb9e957fb4e0` 的权威账本只有 22 条事件；seq16 接受 paused outcome，seq19 保存子任务 checkpoint，seq20/21 暂停子任务/主任务，seq22 `run_paused`，未见后续 ResumeRun。
- “继续”run `run_fad46a0d-acc4-4031-9150-cbf2e2c15268`：seq1 goal 为“继续”，seq2 仅注册 revision 1 的 `run-goal`，绑定本条消息；seq9/10/11 接受 succeeded 并 Completed。
- 其 Evidence artifact 中 `workspaceWriteActionIds=[]`；唯一 validation 是 `node --test edu-waitlist/test/waitlist.test.js`、cwd `C:\test\test_0923`、exitCode=0。不是现有教务系统候补集成验证。
- “不delegate了”run 为 `run_bf2c823f-d244-43c9-a477-68ceb150a1f3`；“2”run 为 `run_05ce75f1-82d8-4595-9015-e32a6fd9ee3a`。各自有独立的根 requirement revision 1，已读绑定/账本未见继承原 requirement 或 supersession 关系。
- `run_started.goal` 保留输入本身并非错误；**缺少结构化的当前有效要求关联，且替代项目的验证被接受为本次复杂变更完成证据**，才是错误。
- 语义路由实际上已经把“2”正确解释成“迁移现有系统后改造”。不能简单归咎模型看不懂用户。

当前最低门槛也解释了风险机制：`ComplexChange` 在无 workspace write 时只要求存在 validation observation；有写入但没有 validation observation 也可能通过。这个局部门槛不能证明“改了正确项目、满足当前要求”。它可以是最低事实筛选，但不能替代最终覆盖验证。[tool_task.rs:726](C:/Users/admin/CodeBuddy/crates/goose/src/agents/tool_task.rs:726)、[初始 requirement 注册](C:/Users/admin/CodeBuddy/crates/goose/src/acp/server/codepro_control.rs:425)

暂停后仍执行也有对应的静态机制：委派取消分支会先提交暂停再返回工具错误；主循环起始主要检查 cancellation token，未在该处重新核对 Durable RunProjection；回合末最终收口又会对已 Paused 的投影直接返回。运行账本证明现象，当前源码解释可疑链路，二者不等于已锁定历史二进制每一行。[委派取消](C:/Users/admin/CodeBuddy/crates/goose/src/agents/platform_extensions/summon.rs:1420)、[主循环](C:/Users/admin/CodeBuddy/crates/goose/src/agents/agent.rs:12393)、[终态收口](C:/Users/admin/CodeBuddy/crates/goose/src/agents/agent.rs:9073)

新输入进入旧 run 有 checkpoint/continuation/clarification/retry 等绑定条件；否则会创建新 UUID。此次哪一个旧绑定条件失效，仍需针对判定回执继续定位，不能凭“继续”两个字建立新的关键词规则。[ACP 绑定分支](C:/Users/admin/CodeBuddy/crates/goose/src/acp/server.rs:3334)

必须保留 N03 反例：诊断任务可以在不写文件、项目测试失败时完成。修法不是所有 Change 都强制 exit 0，而是验收当前要求对应的效果；目标中的修复、诊断、验证、交付不能混为一个“有工具成功”。

## 4. 为什么上次前端修改没有解决用户看到的问题

结论：不是单纯 CSS 没改好，也不能未经证据归咎缓存。上轮主要修了活动的消费者，却没有把默认开发路径、ACP 传输、历史重载和公开说明完整接进同一展示合同。

1. **生产端缺口。** 当前 `agent.rs:12343` 只在 `read_only_analysis` 为 true 时创建 `CodeProAnalysisActivityTracker`，工具回执转活动的路径受 tracker 存在与否控制。EDU 是 change，导出主要只有 intent/strategy 活动，实际操作走普通 toolRequest/toolResponse。折叠组件无法呈现不存在的结构化活动。
2. **普通工具仍走旧卡。** `ProgressiveMessageList` 的结构化分支与 `GooseMessage` 普通消息分支并存，后者仍到 `ToolCallWithResponse` 的有边框卡片。“运行命令”“工具调用已完成”仍是默认表述。不是做了一个 Timeline，所有工具就自动进入它。
3. **live 与历史形态不同。** ACP adapter 能把带 ActivityEvent 的 status 转为 `codeProActivity`；会话持久化/导出消息仍可为 `progressMessage`，EDU 当次就是如此，并非仅旧版数据。当前 inline 匹配不等价覆盖二者，也不能假定所有历史都经过 live 的同一适配分支。只测理想 ActivityEvent 输入，漏掉真实通知和重载入口。
4. **进度文字与终稿没有清楚区分。** 主循环会暂扣无工具调用的 Text 进行完成复核。这里既不能让阶段说明全部被当终稿，也不能把隐藏 thinking/完成草稿全部公开。没有证据证明模型每次都已经产生了可直接展示的公开说明。
5. **计划清单没有贯通。** `todo.v0` 存在并供模型再次读取，但任务面板主要从报告或 progressMessage 派生，不直接呈现这份 checklist。模型勾选是执行计划，不是控制面的成功事件。
6. **PublicProgress 不是完整动作日志。** adapter 按 runId/attemptId 更新状态槽；空 attemptId 可能合并同 run 更新。可以做当前状态，但不能拿它代替逐 action 历史或补造 action identity。

源码锚点：

- [活动 tracker 入口](C:/Users/admin/CodeBuddy/crates/goose/src/agents/agent.rs:12343)、[无工具 Text 过滤](C:/Users/admin/CodeBuddy/crates/goose/src/agents/agent.rs:13083)。
- [ACP 通知适配](C:/Users/admin/CodeBuddy/ui/desktop/src/acp/adapter/gooseSessionNotifications.ts:53)、[消息分流](C:/Users/admin/CodeBuddy/ui/desktop/src/components/ProgressiveMessageList.tsx:388)、[普通工具卡](C:/Users/admin/CodeBuddy/ui/desktop/src/components/ToolCallWithResponse.tsx:286)。
- [任务面板](C:/Users/admin/CodeBuddy/ui/desktop/src/components/codepro/CodeProTaskPanel.tsx:237)、[todo 工具](C:/Users/admin/CodeBuddy/crates/goose/src/agents/platform_extensions/todo.rs:84)。

这次应吸取的教训是：**组件测试通过，证明组件能处理测试给它的数据；不证明实际产品已经把数据送到组件。** 上轮不能以局部样式、类型检查和测试数量代替真实开发会话验收。

## 5. 我理解的 UI 差距与目标

用户要的不是把卡片边框删掉，而是主次关系改变：正文讲“为什么、发现了什么、下一步”；轻量活动讲“做了什么”；展开详情讲“依据是什么”；审批/失败/阻塞需要用户注意时单独显露。

| 层次 | 当前反例 | 目标体验 | 事实边界 |
| --- | --- | --- | --- |
| 公开说明 | 长时间只有“正在处理”及工具卡 | 在阶段转折给简短、真实的发现与下一步 | 模型公开说明，不冒充控制状态，不展示私有思考 |
| 活动 | 每条同等重量、有边框、泛化工具名 | 紧凑无边框行；命令/文件名可辨；按自然工作段折叠 | 来自真实请求与回执，不靠前端猜技术结论 |
| 长列表 | 工具记录占满主对话 | 展开区域有限高、滚轮查看全部；保留展开状态与稳定定位 | 不截掉证据；重复次数不能因折叠消失 |
| 编辑证据 | 工具成功或阶段完成像文件完成 | 独立展示已确认改动；有真实 diff 才显示 +/-、审查入口 | 仅写成功不自动证明净变化；无证据不造“撤销”按钮 |
| 审批 | 批准后仍保留大表格，或又问实现选择 | 待批时突出动作/范围/后果；处理后收起为简短记录 | 本任务允许绑定明确范围，不自动扩权 |
| 任务清单 | todo 是工具名，未形成进度认知 | 清楚标为“模型计划”的工作清单；另展示实际任务状态 | todo.v0 的勾选不能合成任务完成；真实任务状态仅消费 RunProjection |
| 收尾 | 大篇复核但用户不知道到底能否用 | 总结交付、验证、限制；列可核对文件和运行方式 | 清楚区分项目可运行、测试通过、视觉未验收 |

借鉴 Codex/WorkBuddy 的层次，不复制它们的文案、尺寸或每几个调用分组。阶段由实际公开说明/明确工作上下文形成；不能机械每十次工具调用生成“总结”。没有公开说明时可显示事实摘要，但不能编“已定位根因”。

方案比较：

- 只改旧卡 CSS：见效快，但解决不了身份、重复、历史加载、阶段说明，拒绝作为完整修复。
- 仅把只读 tracker 条件去掉：可能把分析路径假设扩散到所有工具，也无法天然解决 live/replay，不能直接当方案。
- **推荐复用现有工具请求/回执和活动身份，建立一致的展示适配，补齐确实缺失的宿主事实字段。** 同一 action 只展示一次；公开说明、审批、任务计划、工具事实仍保留不同语义；后台控制面唯一权威不变。具体 producer/adapter 分工须依据源码边界定，不再造第二套 UI 运行状态。

## 6. WorkBuddy 值得学什么，又不能照搬什么

值得学的真实内容：

- 先验证关键运行条件，再选择依赖和实现路线。截图展示 Node SQLite 探查，产物确实基于内置 Node 模块，减少本轮环境安装阻力。
- 公共基础设施先成型：API、DOM、表格/弹窗、图表、课表与业务页面分开；`dom.js` 对重复事件委托有明确处理。
- 角色 × 资源组织接口与断言，跨角色场景比单纯“页面能打开”更有价值。
- 可见的“发现问题→说明调整→继续验证”，让用户知道工具失败后在如何推进。
- 启动入口、演示数据、账号、测试脚本、README 和档案一起交付，而不是把代码文件列表当全部交付。

但它也不是无缺陷金标准：

1. `export-report.mjs:30-58` 丢弃 spawnSync 的 status/error/signal，只取输出；包含“通过”就缓存，否则可能回退旧缓存并声称子进程受限。缓存没有绑定源码哈希/运行身份。故开头“永远是当前真实结果”的声明不成立，不能排除历史绿结果装饰当前代码。
2. `render-check.mjs:19-21` 缺 jsdom 时跳过并 exit 0；未处理异常被记录打印，但最终退出码只取用例 fail 数。必须区分 SKIPPED、失败与通过。
3. `smoke-test.mjs:139` 的“教师仅可见本人教学班”只检查列表非空，未证明所有记录归属；`:194` 的学生课表长度 >=0 不能证明课表正确。数量不是覆盖充分性的证明。
4. jsdom 文字断言不证明真实浏览器布局、交互、响应式和视觉质量。截图中实际浏览器探查失败后换 jsdom，是验证能力降级，必须如实标注。
5. 报告中的开发叙事来自脚本硬编码数组，不是完整原始运行账本。文档提到安全拦截后改用另一执行器删文件，只能当自述，且不应学习为绕过权限的方法。

这些问题不抹杀它的交付优势。恰恰说明 CodeBuddy 应把已有审计能力与这种交付组织结合，而不是选择“漂亮但不可追溯”或“可追溯但不好用”二选一。

自述中“agent 负责确定性、LLM 负责判断力”也需修正：模型编写的测试可能漏测、断言可能错；宿主能保证某脚本确实以某退出码结束，不能自动保证脚本覆盖全部需求。不冗余也并非完全不可机检，重复依赖/死代码可以辅助检测，但业务上是否需要某模块仍需判断。

## 7. 成熟公开源码：采用机制，不移植整套框架

使用 OpenAI Docs 技能核对官方材料，并按用户要求读取公开仓库源码。没有安装/运行外部框架。以下是源码结论，不是桌面私有实现推测。

### Codex

官方工程文章对应的固定提交 `99f47d6e9a3546c14c43af99c7a58fa6bd130548` 中，`try_run_turn` 消费模型事件、调度工具 future、保存工具结果、发布独立消息增量和回合 diff；有后续工作则继续模型循环。可借鉴“工具结果驱动下一步，事实事件驱动展示”，不能由此推导它已确定性证明业务验收。[固定源码](https://github.com/openai/codex/blob/99f47d6e9a3546c14c43af99c7a58fa6bd130548/codex-rs/core/src/codex.rs#L2665)、[官方说明](https://openai.com/index/unrolling-the-codex-agent-loop/)

本轮读取的 main 协议明确区分 AgentMessage.phase、Plan、CommandExecution、FileChange；命令具有 id/cwd/status/exit_code。`request_user_input` 与工具审批也有不同处理入口。所以“Codex 从不问选择题”并不成立；应学习的是何时该问、问题归谁负责，而不是删除需求澄清。main 会漂移，以下不能称为固定版本审计。[事件项源码](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs)、[提问入口](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input.rs)、[审批编排](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/orchestrator.rs)

### LangGraph

审查版本 `1.2.12`，提交 `49cce0ca852be4cfb567a1cbe0e511ff325a1682`。流式消息、自定义进度、任务/状态更新有不同通道；checkpoint 恢复与 interrupt 有明确语义。其图执行 done 表示没有下一批任务，不等价业务交付成功；interrupt 恢复可能从节点开头再运行，不能保证外部副作用 exactly-once。[调度循环](https://github.com/langchain-ai/langgraph/blob/49cce0ca852be4cfb567a1cbe0e511ff325a1682/libs/langgraph/langgraph/pregel/_loop.py)、[流式接口](https://github.com/langchain-ai/langgraph/blob/49cce0ca852be4cfb567a1cbe0e511ff325a1682/libs/langgraph/langgraph/pregel/main.py)、[interrupt 语义](https://github.com/langchain-ai/langgraph/blob/49cce0ca852be4cfb567a1cbe0e511ff325a1682/libs/langgraph/langgraph/types.py)

### OpenHands Software Agent SDK

审查版本 `v1.47.0`，提交 `50080b58d35b4824fda25fca2345d80bcd08aeff`。工具 observation 绑定 action/tool_call，委派是可选工具。其普通文本响应可设 FINISHED，第二次 run 可能隐式确认 pending actions；子 Agent 审批默认继承也不等于父子 capability 交集。这些默认值不能直接代替 CodeBuddy 的显式审批与验收合同。[Agent](https://github.com/OpenHands/software-agent-sdk/blob/50080b58d35b4824fda25fca2345d80bcd08aeff/openhands-sdk/openhands/sdk/agent/agent.py)、[响应分派](https://github.com/OpenHands/software-agent-sdk/blob/50080b58d35b4824fda25fca2345d80bcd08aeff/openhands-sdk/openhands/sdk/agent/response_dispatch.py)、[运行/审批](https://github.com/OpenHands/software-agent-sdk/blob/50080b58d35b4824fda25fca2345d80bcd08aeff/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py)、[委派](https://github.com/OpenHands/software-agent-sdk/blob/50080b58d35b4824fda25fca2345d80bcd08aeff/openhands-tools/openhands/tools/delegate/impl.py)

共同可学：模型自主决定技术动作；宿主保障真实执行、权限、身份和恢复；用户进度与控制状态分层。不能照搬：通用 FINISHED/done 当业务 Completed、继续等于授权、取消 token 等于副作用已停止、checkpoint 等于安全重放。

## 8. 对抗审查后保留的修复顺序与边界

下表是下一批方案建议，不自动扩大既有冻结范围；涉及公共协议、核心状态或权限变化必须按仓库规则另行确认。

| 优先级 | 问题簇与首个应闭合的断点 | 唯一事实责任 | 最小验收 |
| --- | --- | --- | --- |
| P0 | 原 run Paused 后仍派发工作；新输入丢失当前任务关联 | 现有输入/恢复 owner 负责绑定；Reducer 独占状态迁移；执行器消费已提交状态 | 暂停后不能继续新写；新输入结构化绑定原 run/当前要求，未知副作用对账且 Reducer 允许后才恢复，否则保留具体 blocker；修订有明确替代关系 |
| P0 | 替代项目测试被接受为复杂变更完成；受阻被包装成功 | Requirement/TaskContract 的既有提交边界、Convergence、Reducer | 错目录、独立 demo 自测通过时不能完成原集成；合法受阻有具体 gap，且不无限复核 |
| P0/P1 按风险 | 权限、委派取消、真实 outcome 与主循环不一致 | Authorization/Execution Policy、既有 worker outcome ingress | 子权限不扩大；取消请求/停止确认/未知副作用分开；本任务批准后同范围生效，越界仍拒绝 |
| P1 | 环境探查/合法验证无执行路径，错误审批不能解锁 | 既有 shell/tool 执行合同与策略 | 获准范围内可完成真实环境探查和相关验证；缺依赖/需安装明确区分；不增字符串特例或任意 shell 权限 |
| P1 用户体验 | 默认 Change 工具事实未进入轻量展示，live/reload 不一致 | 工具事实 owner → ACP adapter → UI 只读投影 | 从实际 Change 调用到界面，再重载，同 action 同结果；进度不冒充编辑/成功 |
| P2 | 长会话密度、布局、动画和额外便利功能 | 现有 UI 展示层 | 百条活动可滚动、不抖动；失败/审批可发现；无假 diff/撤销按钮 |

P0 内是实施顺序，不表示权限/委派可以延期放行。也不能因修委派而要求所有任务必须委派。

不做：恢复固定 Planner→Coder→Tester；新增 Judge/第二 requirement store/第二 evidence store；靠最终文案关键字认定受阻；识别“继续”“2”的短语特判；把文件批准当目标变更；给所有 Change 一刀切成功测试；为了截图新增总结 Agent。

需要机制调整时先比较边界，而非增加提示词：主循环应能依据已知事实正常继续、受阻或提出完成；宿主不得为了防假完成把它永久困在复核里。不是每个普通探索动作都要重建完整计划。

## 9. 下一轮验证要改成真正贯穿的链路

先做最小跨边界回放/聚焦回归，再一次集中 candidate 构建和人工 E2E。不是继续堆组件总数，也不是马上重复一小时教务长任务。

1. **错对象反例**：空/错误工作区请求修改现有系统；识别缺口、保留目标、合法暂停；不得自建 demo 后 Completed。
2. **恢复反例**：委派超时→原 run Paused→用户继续；先对账，恢复绑定和授权一致；暂停期间不得出现新写入。
3. **用户修订反例**：“不委派了”撤销委派要求，但保留集成目标；选项答案绑定实际问题与选项，不成为新字面目标。
4. **证据反例**：别的项目测试绿、记忆写入、独立示例绿都不能满足原项目交付；保留 N01 无需改动、N03 诊断完成但项目仍失败。
5. **真实展示链**：同一会话有公开阶段说明、读文件、成功/失败命令、编辑、审批、委派；验证后端→ACP→adapter→消息列表，重载后不丢不重，不把纯进度算编辑。
6. **可运行交付**：干净但依赖已明确的样例，完成最小开发→真实启动/验证→交付，记录服务进程、端口、cwd、版本、退出码与清理责任；不是只看测试摘要。

每次记录 task/requirement revision、workspace、run/task/action/child identity、批准 option_id 与命中范围、工具回执、产物版本、最终状态。验收“执行正确”与“用户看得懂”分别打分，模型 prose 不替代任一事实。

多 Agent 的验收不是“调用次数>0”：独立子任务是否真正启动、有回执、权限受限、取消可对账、结果用于集成，才有意义。单 Agent 做共享骨架与串行集成完全合理；有价值的独立审查/可分文件实现再委派。

## 10. 关键证据索引与本轮工作边界

- [旧版原始会话](C:/Users/admin/Documents/xwechat_files/wxid_1kqgkm5gd6pa11_5fa7/msg/file/2026-09/对话.txt)
- [新版完整教务会话](C:/Users/admin/.codex/attachments/1b715021-a303-4b5c-a0e5-057cc2fefbd8/已粘贴的文本.txt)
- [EDU 损坏导出](C:/Users/admin/Desktop/会话记录/EDU-0924-1125.txt)
- canonical session DB：`C:\Users\admin\.CodeBuddy\profiles\local\sessions\sessions.db`，本轮以只读连接查询。
- [原 EDU run 权威账本](C:/Users/admin/.CodeBuddy/profiles/local/runs/control-plane/run_0453d44c-46ab-4c0b-ad30-bb9e957fb4e0/events.v1.jsonl)
- [继续 run 权威账本](C:/Users/admin/.CodeBuddy/profiles/local/runs/control-plane/run_fad46a0d-acc4-4031-9150-cbf2e2c15268/events.v1.jsonl)
- [继续 run 完成证据](C:/Users/admin/.CodeBuddy/profiles/local/runs/run_fad46a0d-acc4-4031-9150-cbf2e2c15268/run/artifacts/main-agent-evidence-a7d67e76251b0f04-1790220071677535.main-agent-task-evidence.txt)
- [撤销委派 run 账本](C:/Users/admin/.CodeBuddy/profiles/local/runs/control-plane/run_bf2c823f-d244-43c9-a477-68ceb150a1f3/events.v1.jsonl)
- [选项 2 run 账本](C:/Users/admin/.CodeBuddy/profiles/local/runs/control-plane/run_05ce75f1-82d8-4595-9015-e32a6fd9ee3a/events.v1.jsonl)
- [WorkBuddy README](C:/test/test_0924/README.md)、[开发档案](C:/test/test_0924/docs/开发过程档案.md)、[报告生成器](C:/test/test_0924/scripts/export-report.mjs)、[接口测试](C:/test/test_0924/scripts/smoke-test.mjs)、[渲染检查](C:/test/test_0924/scripts/render-check.mjs)
- [冻结事实权威](C:/Users/admin/CodeBuddy/documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md)

本轮只新增此报告。执行了文件/源码读取、Git 身份检查、输入/二进制哈希、session DB 和事件账本只读查询，以及官方公开资料/源码研究；没有修改产品代码、冻结计划、原始会话、数据库或外部项目，没有运行产品测试、桌面构建、安装依赖或产品 E2E，没有提交或推送。

未知/未验收：WorkBuddy 全部原始工具日志与私有实现；各历史 dirty binary 的逐文件精确源码映射；真实视觉与长会话滚动验收；拟议修复的自动验证与产品效果。公开 main 源码链接为本轮读取时内容，不保证未来不变。

最终判断：新控制面提供了追踪问题的基础，但这轮证明它尚未稳定控制实际执行和续跑。应优先修“同一任务的事实与状态不脱节”，同时用真实入口补齐展示链；不能继续把模块存在、日志详细、单测通过当作产品已经具备对应能力。
