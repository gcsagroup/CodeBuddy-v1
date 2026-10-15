# X01：目标切换、权限、完成与循环的全局对抗审查

日期：2026-09-22。状态：用户 E2E、会话与事件账本复核 + 当前源码静态审查；未修改产品代码，未构建、测试或重新运行 E2E。

当前有效实施顺序与放行边界见文末第 9 节“最终收口复核”。本文件作为本轮 Failure Card；第 9 节合并 X01 与 N01/N03/M02/D01，不新增总计划。此前第二修复批次方案的先后顺序被该节取代，原始证据仍保留。

本报告补充第二修复批次的优先级依据，不修改冻结 Final Plan 或事实权威表，不把新缺陷变成新的总架构。当前工作树为 `C:\Users\admin\CodeBuddy`，分支 `fix/codepro-context-compaction`，HEAD `1d9a60af0f543fa7f160b87a9904cd7440a9c444`，dirty。当前源码与历史运行二进制不能仅凭 HEAD 认定完全一致；下文分别标明运行事实和源码机制。

## 1. 先校正用户实际操作，不能把主动中断算成产品失败

原始附件：`C:\Users\admin\.codex\attachments\ff417441-b673-431c-88b1-1dc96da72822\已粘贴的文本.txt`，session `20260922_12`，工作区 `C:\test\test_0922\codepro-first-repair-e2e\X01`。

用户补充：四个主要阶段为大学教务系统、中断后微信记账小程序、再继续大学教务系统并中断、最后手动 compact。

| 北京时间 | 原始可见文本 | 记录解释 |
| --- | --- | --- |
| 14:07:31 | 帮我做一个大学教务管理系统，要能管理学生、课程、选课和成绩，你自己看着设计并实现。 | 第一个开发目标 |
| 14:12:00 | 帮我做一个微信记账小程序，可以记录每天的收入支出，还能按月份统计。 | 第二个开发目标；后台消息标记 `steer=true` |
| 14:27:11 | 1 | 附加选择回复，不应当作独立完整开发目标 |
| 14:35:56 | 继续 | 附加续跑输入；含 `taskContinuationOf=not9dnoj` |
| 14:37:02 | 继续帮我做一个大学教务管理系统，要能管理学生、课程、选课和成绩，你自己看着设计并实现。 | 第三个开发阶段，回到教务系统 |
| 14:48:02 | /compact | 第四个主要操作，手动压缩 |
| 14:48:58 | Compaction complete | 宿主成功确认，并保存压缩摘要 |

模型转去实现小程序是响应用户输入，不是自行跑题。后两份 run 的 Cancelled 与用户主动中断相容，不能计为执行失败。第一次 UI 中断的精确取消动作未由本附件独立证明；可证明的是第二个目标进入后端时是 steer，而第一份 Durable run 没有同步提交目标修订。需要区分用户点击停止、后端接收取消、执行已停、目标已替换。

压缩本身有成功证据；压缩后没有继续执行样本，不能证明恢复正确，也不能把压缩前的故障归因于压缩。

## 2. 运行事实与规模

- 117 次顶层工具请求：48 次 execute_typescript、31 次 write、13 次 tree，其余为工具发现、shell、AskUser、记忆等。顶层请求与响应各 117 条。
- 56 次宿主 `Main Agent completion review`，只有 3 次 `Completion proposal rejected by the host`。前者不能当作 56 次 Convergence 拒绝。
- 没有真正的 delegate 工具调用。`load` 失败不是委派失败；X01 不能评价 Worker join 是否修好。
- 文件写入尝试均遭 scope 拒绝；多次 tree 为空，本次只读检查工作区也为空。确有其他状态变更：启用扩展、写入项目记忆，不能统称“零副作用”。
- 会话累计消耗 11,658,072 tokens，其中累计输入 11,562,301，缓存读取 10,038,794；不是单次上下文 11.7M。已观察到的消息 usage 输入峰值 96,415，不能据此声称覆盖了所有内部请求，也不能证明达到 128k。

控制面账本位于 `C:\Users\admin\.CodeBuddy\profiles\local\runs\control-plane\`：

| run ID | 持久化 goal | 最后事件 | 解释 |
| --- | --- | --- | --- |
| run_eb33dc8b-5611-43ba-a94f-0a8df4c53201 | 大学教务管理系统 | event:11 run_completed | summary 却说小程序被阻塞、目录为空；假完成与目标来源错位 |
| run_0f1aab3e-3ae4-44a0-9a50-85368952a324 | 1 | run_paused | repeated_tool_failure；原目标未形成有效根合同 |
| run_44ca4f8c-2e7e-4e0b-b02b-6bf30077e567 | 继续 | run_cancelled | 续跑输入成为新 run 的字面目标；取消本身不判错 |
| run_2c803295-429b-4e22-939c-bd88596adb14 | 继续帮我做大学教务系统…… | run_cancelled | 正确保存当前目标并记录取消；不因人工中断判失败 |

四份 run 均只有 requirement revision 1。首次 `run_started.goal` 是历史事实，不要求覆盖修改；问题是没有另一条权威的目标修订/替代关系把小程序来源和当前有效合同接上。

## 3. 最严重的新增证据：权限分类被拿来证明实现交付

第一份 run 的完成证据：

`runs\run_eb33dc8b-5611-43ba-a94f-0a8df4c53201\run\artifacts\main-agent-evidence-a7d67e76251b0f04-1790058360356550.main-agent-task-evidence.txt`

其中 `workspaceWriteActionIds` 唯一成员为 `01a0c7c5-6f59-71a3-a266-5fa620c1da5c`；validation 列表为空。此 ID 在原始会话对应 `projectmemory::project_memory_remember`，request `call_qex7nqf6`，成功、`workspace_write`、`user_confirmed`、taskScoped，scope digest 与证据匹配。它保存的是阻塞说明，不是项目源文件。

当前源码链：

1. `tool_task.rs::MainAgentActionFacts::observe`（约 407–427）把任意成功的 `WorkspaceWrite` 审计归入 workspace_write_action_ids。
2. `minimum_completion_evidence_satisfied`（约 705–724）对 Change 类接受“有 workspace write 且没有 validation observation”。
3. `agent.rs::propose_main_agent_finish`（约 9064 起）通过最低门槛后提交 evidence bundle；没有因报告说 blocked 而形成另一种结构化结束提案。
4. `convergence.rs::CompletionProposal::for_main_agent`（约 58–78）把整包 evidence 自动挂到全部 requirements。
5. 运行事件确实提交了 task_succeeded 和 run_completed，summary 同时承认目录为空、工作未交付。

这是安全权限分类、资源变化、交付证据三种事实混用，不能仅归为报告文案或未来语义优化。优先级 P0（完成真实性）。禁止用“排除 projectmemory 工具名”修补：记忆写、Git 元数据写、文件写、外部发送都应证明各自发生的效果，不能共同替代代码产物或用户交付。

同样不能改成“所有 Change 必须测试退出码 0”：文档修改、无需修改和 N03 的诊断交付将被误杀。完成应围绕当前有效委托、模型覆盖提案、确定性义务与真实资源证据，而非工具次数或任务大类。

## 4. 其他问题簇：按首个偏离点定位

### 4.1 输入与运行绑定：语义已经换了，权威合同没有跟上

`agent.rs` 约 12276 的 steer 消费路径更新对话与部分 unified 方法信息，没有在该路径提交对应 UserRequirement revision。模型可以看到微信目标，但完成仍使用教务系统的根 requirement。后续选择“1”和“继续”又分别成了新 run 的字面 goal。

建议复用现有 `CommitUserRequirements`、恢复 binding 和控制面：目标替换可以修订当前 run，或关闭旧 run 并建立有来源关系的新 run；二者均可，不能强制任何消息一律同 run。普通继续应恢复原合同；有实质目标切换则保留替代关系。提交新合同后，未派发的旧授权动作必须失效；已经派发的动作需要记录并对账，不能假定撤销可回滚。

### 4.2 授权：拒绝有效，但正常开发能力没有接通

两次 AskUser accept 后，写入仍被同一 scope 拒绝。AskUser 回答本身不是正式 capability 提交；这不是要求用户懂 Rust 或自己选 shell 绕过策略的理由。

绿地开发无需预知每个文件名，但也不应因此给任意工作区全写。资源授权应能表达“在用户指定的新项目目录内创建项目”，显式禁止范围和高风险动作继续有效；普通开发命令也不能全部被仅测试命令的 validation guard 代管。启动服务、安装依赖、迁移数据风险不同，应使用现有审批和沙箱，而不是默认放开 shell。

### 4.3 循环：模型的重复尝试与宿主反复催促相互放大

`agent.rs` 约 13480 每轮工具后清除 `tool_completion_reviewed`；无工具结束分支约 13779–13800 又要求复核。模型复核时调用一个工具，随后再次触发复核。X01 56 次提示是直接事实。

`tool_task.rs` 约 657–683 把不同工具参数的成功回执计为 distinct_successes；`agent.rs` 约 12468–12480 在预算边界消费它来申请延长。execute_typescript 中 catch 内层错误再正常返回，外层成功是合理的“脚本执行结束”，却不等于目标进展。换脚本文本即可产生不同成功指纹，这是源码风险；每次实际延长分别由哪条回执触发，仍需逐条关联预算事件，不能直接把全部成本归因于它。

应保留有界纠错和真实复核，但允许模型明确提出“受阻并返回用户”，复用既有暂停/阻塞链。相同 requirement/evidence/capability 状态下的同一缺口不反复注入泛化复核；新增事实可重新评估。复核无需永久新增 Judge。工具成功不自动等于业务进展，也不必给每个只读成功发明进度分类。

### 4.4 报告、记忆、压缩：派生信息反过来强化未经证明的结论

- 大段源码草稿在导出中 `userVisible=false, agentVisible=false`；最终报告却引用“前面的完整源码可复制”。持久化可见性不支持这项交付主张。未做 UI 重载核对，不能排除流式过程曾显示过草稿。
- 临时微信目标与 blocker 被保存成 `project_rule`，无过期时间，内容还断言完整源码已交付。审计有 user_confirmed，不能称完全未经许可；但临时运行事实不应升级为长期项目规则或独立恢复权威。
- compact 摘要保留了最新教务系统目标和写入阻塞，这是正向证据；同时仍复述“完整源码已交付”“仅剩落盘”等未验证结论，并把 load 混写为 delegate。摘要不能替代资源、动作、权限的权威事实。

## 5. 对照组：哪些应保留，哪些不能照搬

### 项目自身的正向对照

N01：真实测试通过且没有代码修改；N03：诊断交付与项目仍失败分离；D01 首个只读子任务：有实际身份和结果；X01：compound shell 单独拒绝后 tree 仍成功，部分取消已写入 Durable，手动 compact 生成摘要。说明不应回滚整个动态主 Agent 或恢复固定三角色流水线。

### 成熟公开实现（2026-09-22 查阅，公开 main 文档可能继续变化）

| 对照 | 可确认的机制 | 采用与拒绝 |
| --- | --- | --- |
| [OpenHands Agent](https://docs.openhands.dev/sdk/arch/agent) 与 [公开 agent.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/agent/agent.py) | Action/Observation 分开；源码 `_ActionBatch.prepare/emit/finalize` 按 action ID 隔离拒绝、保留结果，并处理 FinishTool/可选 refinement | 采用单动作反馈与明确结束；不照搬整套框架。成熟实现也有追加复核，不能宣称所有复核皆错，更不能把 FINISHED 直接等同于 CodePro 用户验收成功 |
| [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | 使用同一 thread_id 恢复 checkpoint，审批结果通过 Command(resume=...) 回到挂起位置；节点重跑需处理副作用 | 采用恢复身份和输入关联；不因已有 Rust runtime 再引入 LangGraph 或强制全任务图 |
| [Claude Code security](https://code.claude.com/docs/en/security) | 权限模式、目录范围、动作审批与沙箱共同约束；允许一次/持续批准有实际执行含义 | 采用可落地批准与目录边界，拒绝“让用户选择内部绕路技术”。不把其他产品模式默认值直接当本项目授权 |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) | 子任务工具可继承并收窄，子报告中的批准宣称不是用户权威；异常结果与部分产出分开 | 采用父子约束和结果来源；工具 allowlist 不替代 shell 文件系统安全，禁止只禁 Edit/Write 就声称只读 |
| [Temporal cancellation](https://docs.temporal.io/activity-execution) | 取消请求、Activity 接收/接受取消、Workflow 是否等待是不同步骤 | 采用取消确认与副作用对账的区分；不为两个超时样例重建 Temporal，也不声称 exactly-once |
| [Anthropic agent patterns](https://www.anthropic.com/engineering/building-effective-agents) | 环境反馈驱动循环，遇 blocker 可暂停，有停止条件；增加复杂度需证明收益 | 采用动态主循环与停止边界；不以“大任务”为理由无限复核、自动加预算 |

## 6. 对建议自身的对抗审查

1. “所有目标都细拆成巨大 JSON”会重演 Planner 问题。只让模型提交必要语义候选/覆盖，宿主补内部 ID 和校验引用；不要一次要求完美计划。
2. “宿主证明语义全覆盖”做不到。宿主验证来源、版本、资源、命令和未确认副作用；语义覆盖仍是可审查模型判断，不能假装确定性代码能证明任意软件需求。
3. “改完权限就自然好了”不成立。X01 已证明未写出文件也可 Completed；先防错误完成、目标漂移，再扩大正常开发可用性。
4. “所有旧 run 必须恢复”不成立。用户主动替换目标时可创建 successor；必须关联来源、终结旧执行并正确处理进行中动作。
5. “禁止模型尝试其他工具”过度僵硬。环境错误可以换工具；已明确权限拒绝不可通过换执行通道扩大权限。需要正式能力修订，不能靠工具名黑名单。
6. “写入次数/新回执就是进展”不成立。读取能产生关键新证据，重复改文件也可能毫无进展；不建立新的机械打分器作为业务决策者。
7. “compact 成功=上下文恢复合格”不成立。摘要已生成与恢复后不会重复副作用要分别验收。

## 7. 修复优先级及最小边界

不追加一套 requirement/evidence/completion store，不新增永久 Judge，不调整 frozen 架构。下述是方案，不是已经实施。

| 顺序 | 范围 | 唯一事实责任与明确不改 | 验收反例 |
| --- | --- | --- | --- |
| P0-A | 完成真实性 + 合法受阻退出 | ToolAudit 提供动作事实；现有 evidence 链绑定真实资源；Main Agent 提出语义结果，Convergence 校验，Reducer 唯一提交；不按最终文案关键词判断 | 只保存记忆/启用扩展/捕获脚本异常不能满足软件交付；受阻可一次停止，不强迫做更多工具 |
| P0-B | 用户更新、继续、授权贯通 | Session 保留原文；既有 CommitUserRequirements/权限边界提交修订；恢复绑定当前 run/task；不让 unified 或 AskUser 答案另行裁决 | 大学→微信有明确替代来源；“1/继续”不成为无上下文合同；已有授权不会因执行形态丢失 |
| P0-C | Delegate 权限、超时与唯一 outcome | 沿现有 scope、Worker outcome、取消与 Reducer；不新增平行生命周期 | 子能力不超过父及子委托；D01 主 Agent 写入责任保留；超时后副作用待对账，活跃子任务提供带 ID blocker |
| P1 | 开发能力与完成复核/预算 | 正常开发动作走现有安全边界；一次拒绝只影响该动作；预算不把任意外层成功当目标进展；不默认开放 shell | 环境检查、新项目建文件、聚焦验证可执行；同状态复核不空转；先保护 N01/N03 |
| P1/P2 | 派生内容的来源与可见性 | 报告只消费事实，记忆不作恢复权威，压缩装配引用当前合同与证据；不造通用日志平台 | 草稿不冒充已交付；临时 blocker 不成永恒项目规则；压缩后只读续跑核对 |

P0-C 是前轮已有安全缺陷，X01 未覆盖不等于可以延期忽略。P0-A/B/C 应在同一 candidate 放行前全部验收，可按上述顺序编码，避免边放权限边留下错误目标和错误完成。

### 最多三个待证伪假设与低成本检查

| 假设 | 当前程度 | 区分检查 |
| --- | --- | --- |
| generic WorkspaceWrite 被作为实现证据，促成 X01 假完成 | 运行 audit→artifact→Completed 与源码链高度吻合 | 对当前代码重放相同最小审计包：只有记忆写、无文件，必须不能满足开发交付；不需要再跑 40 分钟模型 |
| steer/resume 未同步合同，是目标错位的主要原因 | 用户消息、四份账本及当前 steer 路径支持 | 给定现有消息序列，跟踪绑定/requirement revision/取消事件；补第一次点击停止的 UI→ACP 时间证据以区分取消丢失与消息按 steer 设计处理 |
| 复核重置与包装器成功共同延长无进展循环 | 复核次数和机制已证实；每次预算延长归因仍未知 | 对预算延长事件关联 last evidence/capability revision 与 action ID；用 catch 内层失败的包装器回执对照真正新证据 |

## 8. 验证与归档边界

先集中做链路反例，再构建一次 candidate；本轮不执行。之后人工 E2E 建议：N01 → N03 → 干净 M02 → D01 → 新增绿地项目 → 中断/换目标/继续 → 手动 compact 后恢复。将“新建项目”与“多次换目标”分开测试，X01 保留为组合压力样例。

既有源码/二进制快照 `.acceptance/0922-pre-repair-20260922-144330/manifest.json` 保留，不覆盖。新增 X01 会话、四份账本与完成证据宜单独补充封存；快照只用于可追溯，不证明当时 UI 连接的二进制身份。当前调查不停止进程、不清理实际项目记忆、不修改夹具。

总体结论：动态主 Agent 与可靠运行时方向仍成立；当前主要缺陷是**合同切换、权限效果、证据含义和终止反馈的连接错误**，并非已证明大模型不具备大型开发能力。这里不是继续雕琢状态名，而是让原有事实在正确边界流转，并删除工具成功/权限分类/复核文案代替业务交付的隐式判断。

## 9. 最终收口复核：五例合并，停止扩张问题范围

### 9.1 最终定性与证据升级

整批 candidate：`E2E_EXECUTED / QUALIFICATION_FAILED`。允许按下述边界修复，不允许当作产品可放行。N01/N03 是需要保护的真实行为正例，不证明所有权限、恢复或完成合同正确。

| 案例 | 确认结论 | 本次直接账本复核 |
| --- | --- | --- |
| N01 | 行为通过、效率和退出码呈现有问题 | event:11 run_completed；真实 exit_code=0；2 次字面 npm.cmd test，11 次顶层工具请求 |
| N03 | 条件诊断委托通过，项目测试仍失败 | event:11 run_completed；真实 exit_code=1；1 次 npm.cmd test，6 次请求；不等于证明 app.js 对所有输入无缺陷 |
| M02 | 文件最终正确，执行资格失败 | event:17 run_paused(action_budget_boundary)；delegate-2dceba5a6e722381 无 outcome，最后 task/worker 迁移为 Running |
| D01 | 实现责任违约且执行资格失败 | event:28 run_paused(action_budget_boundary)；首个 delegate-bf55992ac9ac48d0 成功停止；第二个 delegate-d11c979953f2eb1a 无 outcome，最后迁移为 Running |
| X01 | 已证实假完成；人工中断和成功 compact 分开评价 | 首 run event:11 run_completed 与空目录/记忆写证据矛盾；当前有效目标没有修订 |

四个早期 run 的 requirement 提交均只有根 run-goal，没有 execution_obligations。M02/D01 的最终 Paused、具体未收口 child、执行义务未登记已经从未知升级为账本事实，不需要再让用户重跑长任务来证明。

复算顶层记录：M02 72 次工具/22 次 npm.cmd test/25 次 review/28 次 proposal rejected；D01 72/23/23/48。统计的是导出中对应消息数量，不宣称每条提示都等于独立持久化 ControlCommand 或模型请求。

### 9.2 必须保留的限定和反例

1. 已发生写入且委派超时，不等于已证明取消确认后继续写。父子权限不一致是源码和行为共同支持的漏洞；是否能逃出用户工作区尚未证明。
2. `run_started.goal` 保留初始目标正确，不应覆盖历史。需要修的是当前 requirement revision、替代关系、授权和动作绑定；完成申请也必须按当前合同校验，不能只检查 plan revision。
3. “1/继续”必须回到有上下文的输入解析/恢复入口，不代表无条件恢复某个旧 run；有多个候选或旧 run 已合法结束时可以澄清或建立明确关联的后继 run。不能用关键词路由。
4. AskUser 不是万能权限开关。有效审批必须绑定 pending action/资源、任务、当前授权版本和具体批准范围，经过宿主提交后才生效；其他回答不自动授予权限。原请求已经明确授权的部分应修复绑定，不重复索要授权。
5. 记忆写入不能证明软件开发交付，但可以证明用户明确委托的“保存这条记忆”已执行。Git 元数据也可证明用户委托的 Git 操作。按要求—效果关联，不按工具名永久黑名单。
6. 无写入不能一律禁止完成，否则 N01/N03 和只读工作都会失败；有写入也不能一律允许完成。测试通过必须与要求、被测资源及有效版本对应，其他命令成功或修改前通过不能冒充当前验收。
7. N01 确有 structuredContent.exit_code=0，正文只有测试输出；模型却声称推断退出码。模型最终没正确使用事实已确认；具体是 provider 序列化漏传还是模型忽略，尚需检查实际模型入参，不能仅凭最终文字钉死。
8. 子调用失败被脚本捕获后，外层成功不一定是错误回执；错误是将外层成功无条件解释为所有子操作成功或用户目标取得进展。

### 9.3 唯一有效的分批实施顺序

| 切片 | 必须一起闭环 | 替代/删除的旧职责 | 放行所需最小反例 |
| --- | --- | --- | --- |
| 1. 完成真实性与受阻退出（P0，先做） | Main Agent 提交有来源的覆盖/受阻提案；现有 evidence 核对真实效果；Convergence 返回具体缺口；Reducer 写终态 | 删除 permissionClass/工具成功次数直接证明交付、整包 evidence 自动覆盖所有要求的通路；不靠最终文案 blocked/success 关键词 | 开发目标+仅记忆写+空目录不得 Completed；明确保存记忆任务可正确完成；受阻可合法返回，不用反复读文件换取结束 |
| 2. 当前目标、停止和继续（P0） | 新输入解释→现有要求/授权修订→执行前版本校验→恢复绑定；兼容 unified 单向派生 | 删除裸消息“1/继续”建立无上下文 goal、旧兼容状态独立完成或决定恢复的路径 | A→B 后旧候选动作和旧完成提案不得跨合同使用；普通恢复保留 run/task；主动取消不再继续派发，已发生效果仍保存 |
| 3. 资源授权、委派与超时结果（P0） | 保留原授权；child 为父有效权限、子委托和策略的交集；有界执行之外可靠接收结果；取消与效果对账 | 删除 staged 丢资源范围、child 无 scope Auto、Ok(text) 自动成功、超时丢失 outcome 的通路 | 父禁写子不能写；父可写但子只读仍不能写；写后超时不盲重试；迟到结果不能抢终态；D01 唯一实现写者为 Main Agent |
| 4. 剩余循环、呈现与压缩债务（P1/P2） | 预算与复核不因包装器伪进展无限延长；真实回执清楚呈现；临时记忆/摘要不当权威 | 删除同状态反复泛化 review、临时 blocker 升长期规则、隐藏草稿冒充已交付等行为 | 同缺口无新事实可停；真实 exit code 可见；compact 后恢复当前要求、权限和未确认动作 |

切片顺序不是缺陷重要性降级：Delegate 权限漏洞始终是 P0，同批 candidate 必须修复。不能只完成切片 1 就恢复产品写入验收。合法受阻退出、具体 gap 属于第一步，不延期到一般“循环治理”；否则会把假完成变成无法结束。

ExecutionObligation 的来源/登记和有效 evidence 匹配纳入切片 1/2 的当前要求合同，不再全部推到最后。无需一次实现任意自然语言的完美语义证明；模型负责可审查的解释，宿主验证来源、版本、资源、确定性义务及未知效果。旧字段无法表达必须的边界时先提出最小兼容适配，不建新 store，不偷偷用字符串匹配代替。

### 9.4 验证节奏与剩余未知

第一步先写可稳定复现 X01 的最小回归，再准备相邻链回归；实现期间不跑长 E2E。集中验证包含：虚假资源证据、NoChange/N03 正例、指定命令与有效版本、stale goal proposal、父子权限/只读责任、写后超时/迟到 outcome、具体 active-child gap、暂停恢复与兼容投影。至少一条贯通入口注册→工具回执→证据→Convergence→Reducer，不仅断言 helper。

聚焦回归通过并完成 P0 后，封存 candidate 当前 dirty 源码与二进制身份，按 README 集中构建；人工 E2E 使用干净 seed，先 N01/N03，再 M02/D01，再单独新建项目、目标切换/停止/恢复，最后 compact 后恢复。不能仅凭第一个反例通过就宣布整批资格恢复。

实现前无需再调查全部体系或重跑 X01。剩余三个定向证据缺口为：子写入/取消确认时序，第一次 UI 中断到 ACP/steer 的接收时序，provider 实际发送的退出码与预算延长动作关联。它们影响具体补丁和诊断归因，不推翻已经坐实的 P0。

现有 snapshot 保留；X01 补充证据封存仍未完成，后续首次代码改动前应补附件、四份 run 账本与完成 artifact 的副本/哈希。不把活动 profile 当事务快照，不复制凭据，不覆盖已封存候选，不把新增归档误称重构前 baseline。

本轮只追加 Failure Card 的有效范围和最终复核，没有产品代码修改、构建、测试、提交或推送；冻结两份架构文档未修改。详细日志不代替产品验收。
