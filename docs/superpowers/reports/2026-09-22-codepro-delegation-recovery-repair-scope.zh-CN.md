# 09-22 第二修复批次：授权、委派与恢复的实施边界

状态：证据复核与方案完成；产品代码尚未修改，未执行构建、测试或新 E2E。

本文是冻结 Final Plan 下的实施方案，不替代 Final Plan 或事实权威表。上一批 shell 正规化/失败隔离/响应幂等的实施范围已经结束；本文件提出下一批边界，不把上一批“不得修改 intent”等局部限制误当永久架构规则。冻结文档保持原样。

## 1. 修正本轮 E2E 定性

| 案例 | 本轮结论 | 边界 |
| --- | --- | --- |
| N01 | 行为通过，效率存在问题 | 真实 exit_code=0、4/4、零直接写入；未证明 execution obligation 产品链 |
| N03 | 诊断行为通过 | exit_code=1、配置根因、零写入；诊断交付不等于项目健康 |
| M02 | 最终文件正确，执行资格不合格 | 父写权限丢失；超时委派产生文件变化；Durable 未完成 |
| D01 | 业务要求与运行时均不合格 | 首个只读委派成功，但第二个写入委派违反“主 Agent 保留实现责任” |

“最终文件正确”不能抵消执行责任、权限或未知结果违约。此前把 D01 称为“业务成功、运行时失败”不准确，本节予以纠正。

## 2. 本次重新核对的直接证据

- M02 会话 6406 附近发出写入 delegate；6439 附近回执 timed_out，durationMs=305033；6497 附近重新读取已修复文件。
- D01 会话 6187 附近发出第二个写入 delegate；6219 附近回执 timed_out，durationMs=305087；6277 附近读取已修复文件。
- 当前 `summon.rs::handle_delegate` 创建 `AgentConfig` 使用 `GooseMode::Auto`，没有传入 `ctx.codepro_task_scope`。`AgentConfig` 本身已有 `with_codepro_permission_scope()`，说明存在可复用接线点。
- `tool_execution.rs::CodeProWorkspaceWriteGuard` 在 scope 为 None 时不建立路径守卫。子 Agent scope 丢失是源码确认的权限继承缺口；不能声称本次已证明能写任意工作区外文件。
- `extension_manager.rs::run_bounded_tool_operation` 到期请求取消，随后等待 drain_timeout（默认 5 秒）；丢弃 drain 结果，返回超时。清理不能完成时执行 future 被丢弃。
- `summon.rs` 的成功/失败 outcome 提交位于被上述有界包装器包裹的 future 内。因此清理时间耗尽时可一起丢失 outcome 提交；不是简单“没有 Err 分支”。
- `run_subagent_task()` 仅返回详细结果的 response，丢掉已有 `SubagentTerminalOutcome`；`handle_delegate` 对 Ok(text) 直接提交成功。这是额外静态风险，尚未证明它导致本轮两次超时。
- `ConvergenceEngine` 对 Proposed/Ready/Running 仅设 `has_active_work`，没有对应 task blocker；Reducer 拒绝完成时返回的 blocker 数组可能为空。
- 重新读取实际事件账本：M02 最后 event:17、D01 最后 event:28 均为 `run_paused(action_budget_boundary)`；N01/N03 最后均为 `run_completed`。M02/D01 的超时子任务未形成 outcome 终态。
- 四个 run 的 `user_requirements_committed` 只有 run-goal，没有 execution_obligations。这个结论来自事件账本，不只是提示词/源码推断。

证据目录：`C:\Users\admin\.CodeBuddy\profiles\local\runs\control-plane\`。
run IDs：M02 `run_494b9c86-2626-4da1-a6d1-74f77a65c2db`；D01 `run_2cc37ba3-81cd-4b1a-9bf6-b1e094f77169`；N01 `run_7aeedc6d-af42-4724-b694-676dd767d052`；N03 `run_4bad3c56-4f75-48ff-a505-d5f777c73bd7`。

### 不把未知写成事实

超时后看到文件变化证明执行期间产生过副作用，不能独立证明“取消后仍继续写入”。仍需子会话工具审计的写入时间、取消确认与进程退出证据。取消请求、Worker 已退出、文件变化已对账是三个不同事实。文件读回正确不能证明没有其他副作用，也不能代替 Worker 正式 outcome。

## 3. 三个可证伪假设与最低成本检查

| 假设 | 当前支持 | 下一项区分检查 |
| --- | --- | --- |
| 父 scope 没传到子 Agent，委派走无 scope 的普通工具路径 | 源码确认配置丢失，父拒写而委派后文件变化 | 核对子会话 ToolAudit 的 taskScoped/scope digest；回归检查实际子工具上下文，而非只断言 DTO 相等 |
| 超时外层丢弃执行 future，使 outcome 收口未完成 | 有界包装器和 summon 提交位置吻合，账本缺 outcome | 可控 Worker：先写一次后挂起，触发取消/耗尽 drain；检查唯一 outcome、未确认效果与迟到回执处理 |
| 继续入口丢失 Durable binding，走兼容完成路径 | pause 后工具继续，但无新增 Durable 事件，unified finished | 跟踪恢复入口的 active run/task/options；恢复回归断言先提交运行恢复，再派发工具且同一 run ID |

## 4. 快照

已封存：`.acceptance/0922-pre-repair-20260922-144330/manifest.json`。

- 分支 `fix/codepro-context-compaction`，HEAD `1d9a60af0f543fa7f160b87a9904cd7440a9c444`。
- 保存 HEAD 到工作区的 binary diff、index diff、变更与未跟踪文件副本及哈希、Cargo.lock、冻结文档、桌面 package/lockfile、当前后端二进制、四份会话、四份控制面目录和启动记录。
- 本地 AGENTS.md 单独标记 local-rules-not-for-commit，排除在源码 patch 外；没有创建提交、分支或 worktree。
- 当前 debug/desktop 后端 SHA-256：`68DF449312BAB3EB9B8BBC2C8376CD1DA08DCA304D4F24BB54E0D7B9C9BC99BE`。这是封存时的身份，不能倒推 E2E 时未记录的二进制哈希。
- 每份拷贝校验源前/目标/源后三次哈希。该快照不声称对整个活动 profile 实现跨文件事务一致性。
- 后端 `20260922_125706.log` 被运行中进程独占，未复制；manifest 明确记录缺项。没有为复制日志停止用户进程。凭据、provider 配置和完整 live profile 未复制。
- 本次快照对应已暴露故障的 candidate，不冒充可靠的“重构前 baseline”；现有已修改夹具也不能充当干净 seed。

## 5. 推荐实施顺序与完成条件

### A. 授权与委派能力闭环

1. 从既有用户要求解释入口取得带 source message 的资源和责任约束候选，由既有授权边界校验并提交。执行形态不再充当授权来源；staged 不得抹掉明确文件范围。
2. 复用 CodeProTaskScope 和 AgentConfig scope 接口，将 scope 绑定到真实 child task/run/permission session；子权限至多为父有效权限、委派合同和系统策略的交集。
3. “主 Agent 实现、子任务只读”必须约束 child capability，即使父有写权限，子任务也不能继承写权限。单纯证明 child ⊆ parent 不足以保护 D01。
4. 批准来自正式权限入口；普通 AskUser 答案不自动创建授权。授权修复不能把 workspace 变成全写，也不能让 shell 绕过文件约束。

退出条件：分阶段任务能使用已明确授予的单文件权限；父零写权限时不能通过子 Agent 写；父有写权限但合同限定子只读时仍不能写；拒绝有可执行原因，不要求用户选择 scope/shell。

### B. 委派取消、结果收口与完成反馈闭环

1. 复用详细子运行结果，不把 Ok(text) 当完成事实；已有预算耗尽/provider unavailable 等结构化结果需保留。
2. 将委派登记、执行句柄、取消与结果提交交给现有 runtime/outcome ingress 的受监督生命周期；关键收口不能只存在于可能被外层超时丢弃的 future 内。
3. 超时请求取消后禁止新动作派发；已派发动作等待确认或记为未确认。文件变更、Worker 退出和 outcome 分别留真实证据。
4. 优先复用现有 effect ledger/uncertain reconciliation；当前直接委派尚未完整进入它，不能仅把 uncertain_effects 数字置零。若现有结构不能表达，先给出最小协议适配，不建设另一套 ActionAttempt 存储。
5. 只读对账确认已有副作用后再决定下一步；不盲重试、不自动回滚用户文件、不将超时等同于无副作用。迟到回执不能覆盖已接受终态；同一 producer attempt 最多一个权威 outcome。
6. Convergence 返回具体 run/task/state、缺失 outcome/evidence 等 gap。内部接线故障应反馈为运行时阻塞；反复通过测试不能修复它。

退出条件：可控的“先写后超时”回归能留下准确 delta、取消/退出证据和唯一 outcome 或明确未确认阻塞；父任务不能完成，直到该缺口由对应 owner 处理。普通成功/只读委派路径不新增必经角色或额外模型复核。

### C. 暂停恢复和终态单写闭环

1. 继续入口从持久化 active run 和 Projection 恢复原 root task、授权、子任务及证据；先完成合法状态迁移，再派发工具。
2. 未确认子作用先对账；旧文本摘要不得抹去 blocker，续跑不得重复已确认写入。
3. 兼容 unified 状态单向消费 Durable 结果；失败不反写权威终态，不能在 Durable Paused 时另行 finished。

退出条件：暂停/继续/进程重启后仍为同一 run；无孤儿 Running child；报告和兼容状态能追溯终态事件。恢复操作不借新 plan revision 或新 run 掩盖旧任务。

### D. 已登记的 P1 完成债务

义务来源改为模型结构化候选 + 宿主校验来源/归属/边界，复用 UserRequirement、ExecutionObligation、EvidenceRequirement；不再由固定动词表或 Markdown 形态决定是否登记。shell 的真实 exit_code 同时进入模型可见 observation 和证据，不能让模型重新推断。指定命令和等价调用的区别、ExitCodeObserved 与 SuccessfulExitCode 的真实入口均须验证。

退出条件：带/不带反引号、等价自然措辞、否定/引用场景不靠字符串补丁处理；必须执行的命令未运行时不能完成；诊断允许已观察非零退出，修复后要求通过的义务不能以非零退出完成。通用语义覆盖未实现部分继续如实记录。

## 6. 权威与改动边界

| 事实 | 本批复用 owner | 主要接线位置 |
| --- | --- | --- |
| 原始授权与责任约束 | 原消息 + 宿主校验的要求/授权合同 | intent/ACP 的现有解释入口、根任务 scope 绑定 |
| 子能力收窄 | 现有权限系统 | summon、AgentConfig、tool context；守卫继续执行 |
| Worker 结果 | outcome ingress + Reducer | summon/subagent handler、runtime、重放 |
| 工具取消与真实回执 | 工具执行边界 | extension_manager、执行句柄、审计 |
| 未确认效果 | 既有 effect ledger/reconciliation | 委派接入适配；不另建库 |
| 完成 gap | Convergence | Reducer 拒绝回执到 Main Agent |
| 恢复和终态 | Durable runtime + Reducer | ACP/agent 恢复绑定、兼容投影 |

不扩大到 Planner 重设计、旧 DAG 全部清理、UI 复制按钮/turnTerminal/token 展示、全局 risk 重写、完整新 ActionAttempt 系统或依赖替换。D01 的“独立审查”导致 L3 升级另列后续问题。

实施期每新增字段先说明来源、唯一 writer、消费者、失效规则及替代的旧职责。改变冻结事实 owner 或需要扩大权限时停止并比较方案；文件名/内部辅助类型调整按基线自主实施。

## 7. 验证与诊断交付

先补少量真实边界回归，整条相邻链稳定后集中运行一次相关测试；不为每个小改动重复编译。构建和产品 E2E 继续使用既有 README 和已约定节奏，本次准备阶段均未运行。

必须覆盖：父子 scope 交集及 readonly contract；写后超时与迟到回执；活动 child 明确 gap；暂停继续同 run；真实 obligation 登记与不满足时拒绝；N01/N03 正向保护。至少一条穿过 ACP/工具回执/证据/Convergence/Reducer，组件测试不能替代该集成边界。

每条诊断串起 session/run/parent task/child task/worker session/tool request/attempt（已有时）/audit/event。缺失字段标未知，不能伪造 ID。记录取消请求和确认的区别、scope digest、提交/拒绝原因、证据引用；只在事件持久化成功后输出状态成功日志。

下一轮人工 E2E：新的干净 seed 副本、封存 candidate 源码和二进制哈希，按 N01 → N03 → M02 → D01；再做受控超时/恢复反例。D01 除最终文件正确外，还必须证明唯一写者是 Main Agent，子任务全部只读，run/task/兼容显示一致。

## 8. 成熟实现对照与取舍

- Claude Code 官方 subagents 文档明确子 Agent 继承父权限，并可限制工具；前台子任务审批由主会话呈现。采用权限继承与收窄原则，复用本项目已有审批入口。不照抄“去掉 Edit/Write 就实现只读”，因为 shell/MCP 同样可能产生写入。来源：https://code.claude.com/docs/en/sub-agents
- Temporal 官方 Activity Execution 文档区分取消请求、接收取消及等待取消完成。采用取消确认、执行身份和可恢复结果的思路，不引入 Temporal 依赖、不把文件/外部副作用宣称成 exactly-once。来源：https://docs.temporal.io/activity-execution

本方案新增的是现有链路的接线和约束，不要求用户理解内部执行器选择，不重新引入固定 Planner→Coder→Tester 流水线。
