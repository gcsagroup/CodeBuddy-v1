# CodePro DAG 与运行时职责重构 Checkpoint

日期：2026-09-20
分支：`fix/codepro-context-compaction`
状态：第一阶段架构切片已完成源码与静态一致性收敛；2026-09-21 经 E2E 与对抗审查后，目标架构已从“固定 DAG 流水线”修正为“统一可靠运行时上的动态 Agent 循环 + 按需 DAG”。待按下述迁移计划继续实施、构建和 E2E；尚未形成可运行证明。

> **Final Plan 冻结声明（2026-09-21）**：本文自本次提交起作为 CodePro 动态运行时重构的最终架构基线。后续实现缺陷、局部源码约束、测试结果、文件名、类型名和模块拆分细节只追加到独立实施记录，不再反复修改本文。仅当用户目标发生变化、E2E 证明核心不变量错误，或源码约束证明目标架构无法实现时，才允许重新打开本文；重新打开必须记录原因、证据和新 revision。实施记录见 `docs/superpowers/reports/2026-09-21-codepro-dynamic-runtime-implementation-log.zh-CN.md`。

## 用户目标与边界

- 保留 CodePro 对原始目标、权限、真实工具回执、暂停恢复和最终完成门槛的确定性控制。
- 降低 Planner 协议负担，避免一个格式或合同字段错误阻止明确任务启动。
- 保留 DAG 的拓扑价值，但不再让 `TaskDAG` 同时充当运行状态、证据库、修复状态和最终完成权威。
- Coder、Tester 之间必须传递宿主构造的结构化依赖输入；自然语言说明只能是模型视图，不能成为控制事实。
- 当前主 Agent 默认负责提出“用户委托在语义上是否已交付”；高风险或策略要求时由独立 Reviewer/Judge 复核。`ConvergenceEngine` 只校验该提议不违反真实证据、授权和明确门槛；control-plane reducer 是唯一有权写入 Completed 的模块；报告只展示已提交结果。
- 当前工作树存在大量相关未提交改动。继续在同一分支、同一工作树施工，不新开 worktree，不清理或覆盖已有改动。
- 本轮不以新增大量单元测试或完整构建为目标；实现完成后由用户进行真实 E2E。Rust 修改仍必须执行 `cargo fmt`。

## 2026-09-20 重构前基线问题（2026-09-21 状态归一化）

1. **部分修复，仍需新架构替代。** Planner 曾需一次输出 goal requirements、任务、角色、依赖、验收标准和 scope；宿主已接管 purpose、预算和最低证据，2026-09-21 的 coordinator proposal 进一步移除 run/revision/完整 EvidenceRef 等宿主字段，但默认 CodePro 入口仍依赖首次 Planner/DAG。
2. **仍存在。** `TaskDAG` 同时保存拓扑、任务状态、合同、预算、验证证据、repair、review、finding 和 revision 历史，职责过载。
3. **V1 已修复，V2 待迁移。** `TaskInputEnvelopeV1` 已替代 Scheduler 内的自由文本交接，但 source task 状态、attempt、workspace delta 和 verification evidence 仍从可变 `TaskDAG` 读取；新架构必须改为分别读取 PlanGraph、RunProjection 和 Evidence Store。
4. **已修复生产提交边界，待 E2E。** Scheduler 向 control plane 提交的正常 `WorkerOutcome` 已携带已持久化 evidence refs；尚未证明所有 host-only、恢复和 shadow 分支一致。
5. **部分修复。** legacy outcome 已后移到 convergence 之后；2026-09-21 又增加 durable projection 到兼容 DAG 的每轮回填，但 `TaskDAG` 和 `CodeProRunState` 仍保存并修改生命周期状态。
6. **仍存在。** Scheduler 文件约 1.7 万行，包含调度、Worker 提示词、权限、命令判断、证据提取、修复、恢复和报告净化，属于职责集中而不是单纯代码长度问题。
7. **部分修复。** 通用 Planner 已不再创建 Reviewer 节点，宿主已有结构化 `ReviewVerdict`；专用 DAG、completion evaluator 和最终独立验收仍需归一为按策略触发的复核能力。

## 目标架构（2026-09-21 修订）

```text
Session 原始消息（不可改写）
    -> versioned Requirement Interpretation（模型语义解释，用户修正可覆盖）
    -> Main Agent Decision Loop
         Respond | Act | Delegate | RevisePlan | AskUser | ProposeFinish | Stop
    -> 单一可靠运行时
         权限 / 沙箱 / 状态提交 / 资源锁 / 取消 / 恢复 / 重试
    -> 工具或按需 Worker
    -> immutable Observation + EvidenceRef
    -> RunProjection / Evidence Store
    -> Completion Evaluator（主 Agent 默认提出语义交付判断；必要时独立复核）
    -> ConvergenceEngine（校验证据、授权和明确门槛）
    -> Reducer（唯一提交终态）
    -> Terminal Report（只读投影）
```

`TaskDAG` 不再是所有 Coding 请求的前置剧本，也不拥有运行生命周期。它是需要并行、委派或显式依赖时由主 Agent 提出的版本化工作图，并由同一个运行时执行。Planner 是可调用的规划能力，不是所有任务必须经过的协议编译器；Coder/Tester/Reviewer 是执行或验收策略，不是安全边界。

### 决策权边界

- 模型决定：如何调查、如何实现、是否调整计划、是否委派、失败意味着什么以及何时提议完成。
- 宿主决定：动作是否被授权、状态迁移是否合法、资源是否冲突、工具事实是否真实、证据是否仍绑定当前版本、是否可以提交终态。
- 宿主只补不改变业务意图的机械字段，例如 ID、revision、默认重试预算和展示名称；不得补技术方案、删除遗漏需求或扩大写入范围。
- 主 Agent 可以运行开发验证，但不能凭自然语言自签最终验收；是否要求独立 Tester/Reviewer 由风险、用户要求和证据类型决定。
- 计划修订必须保留旧 revision、已发生副作用和 evidence 失效关系，不能原地改写历史。
- task 状态变化不得改变 PlanGraph 或 plan revision；只有显式且经宿主校验的 `RevisePlan` 可以安装下一版拓扑。TaskInput、attempt、evidence 和 completion assessment 必须绑定 control-plane 当前正式 revision，不能信任兼容 DAG 中可能滞后的 revision。
- Completion Evaluator 不是常驻新增角色：默认由当前主 Agent根据权威 Observation 提出 `ProposeFinish`；仅在风险策略、用户要求或证据冲突时调用独立 Reviewer/Judge。

## 分阶段实施

### A. 强类型任务交接

- 新增版本化 `TaskInputEnvelope`，至少绑定 run、plan revision、consumer task、source task、attempt/status、purpose、workspace delta 和 verification evidence。
- Scheduler 内部只传 typed envelope；仅在模型调用边界序列化一次。
- envelope 必须验证来源通过正式 `InputEdge` / `TaskInputRef` 声明、计划版本一致且证据类型可消费。普通 Dependency 要求来源成功；`RecoveryEvidence` 可以引用失败诊断，但必须绑定结构化失败证据；禁止任意 task ID 越图引用。
- RepairContext 保持结构化，不再把新增控制事实写回 `description` 作为唯一载体。
- 新增 `TaskInputEnvelopeV2` 迁移：拓扑与合同只来自 PlanGraph，运行状态只来自 RunProjection，证据只来自 Evidence Store；不得继续从 `TaskDAG.task.status/output` 读取权威运行事实。V1 只作兼容输入。

完成判据：Coder/Tester 的依赖输入不再以 `Option<&str>` 在 Scheduler 内传播；伪造 task ID、未通过正式 `InputEdge` / `TaskInputRef` 声明的输入来源，或旧计划版本会在宿主边界失败。正式声明的 `RecoveryEvidence` 等非普通依赖关系不应仅因不是直接 Dependency 而被拒绝。

### B. Planner 提案与宿主验证分离

- Planner 只描述语义步骤、能力和最小依赖；宿主只能补齐不改变语义和授权的机械默认值。`read_scope` 只能在用户已授权工作区内补齐并进一步收窄，不能扩大可读对象；`behavior_scope` 只能规范化用户或 Planner 已明确表达的内容，不能创造新需求、技术步骤或验收条件。
- Coder 写入授权仍必须来自用户边界或明确提案，宿主不得猜测扩大。
- 当用户或模型已经明确表达 diagnose -> implement -> verify 时，宿主只把语义步骤编译为可靠的内部 ID、依赖和证据引用；宿主不得自行发明该业务流程。
- Planner 局部字段错误优先局部降级；只有目标、授权或写入范围真实不清楚才询问用户。

完成判据：明确任务不会因与业务语义无关的内部字段缺失而整体 planning failed；宿主仍 fail-closed 处理写入授权。

### C. 单一完成权

- durable 模式只允许 control-plane reducer 在 `ConvergenceEngine` 为 Eligible 时提交 Completed。
- legacy run state 只保存兼容投影，不先于 convergence 生成互相矛盾的终态和报告 outcome。
- terminal report 从已经提交的 projection、evidence 和 blocker 构造，不反向改变状态。

完成判据：同一次运行不会同时出现 legacy Completed 与 control-plane Paused；最终报告 outcome 与已提交终态一致。

### D. Scheduler 瘦身

- 逐步拆出 `TaskDispatcher`、`WorkerExecutor`、`EvidenceNormalizer`、`RecoveryCoordinator`。
- Scheduler 不再通过自然语言或报告字符串重新裁决上游结构化事实。
- 命令启发式只可作为证据分类辅助，不能产生授权、目标或完成结论。
- 将“可靠运行时调度”与“下一步业务决策”分开：前者继续负责 readiness、dispatch、锁、取消、重试和结果提交；后者由主 Agent 或显式 Planner/Judge 决策产生。

完成判据：主调度循环只处理 readiness、dispatch、result commit 和显式恢复转移；证据及恢复组件可独立审查。

## 2026-09-21 后续迁移计划

以下阶段依次进行。不得为了尽快接入主 Agent 而先建立第二套 session、事件、checkpoint、报告或完成状态。

### E. 先收敛唯一生命周期写入者

1. 列出 `TaskDAG`、`CodeProRunState`、Scheduler、control-plane reducer 对 task/run 状态的全部写入口。
2. durable 路径只允许 reducer 提交 task/run 生命周期。迁移期间兼容 `TaskDAG` 仍参与部分 Ready 判断、依赖读取和调度控制，因此必须如实视为**过渡控制源**，不能提前宣称已经降为只读投影。
3. 将 Scheduler 的 Ready 判断、依赖读取和状态迁移逐项切换到 `PlanGraph + RunProjection`；每迁移一项，就删除对应的 `TaskDAG` 反向控制入口。切换完成后，旧结构才只接受 projection 回填，不再驱动调度或终态。
4. 将恢复、repair 和 replan 表达为版本化 command/event，不直接改写已完成、已失败或已跳过的历史节点。

完成判据：N03 一类越界诊断完成后，不会因另一状态源尝试重启已完成任务；UI、报告和恢复读取同一个已提交 projection。

### F. 引入最小动态决策合同

1. 定义小而稳定的 `AgentDecision`：`Respond`、`Act`、`Delegate`、`RevisePlan`、`AskUser`、`ProposeFinish`、`Stop`。`Respond` 用于无需工作区动作和持久任务的直接回答；不能通过关键词硬分类，是否执行动作由主 Agent 基于用户目标决定，宿主只校验权限与状态边界。
2. 每项决定只引用 requirement、task、evidence 和 plan revision ID；不要求模型复述完整 DAG、预算、角色用途或内部证据枚举。
3. 宿主只校验 schema、引用、权限、资源、版本和副作用安全；语义不完整返回给模型调整，不得错误归因为“用户需求不清楚”。
4. 第一版由同一个主 Agent在真实 Observation 后作决定；Completion Evaluator 默认就是该主 Agent 的 `ProposeFinish` 决策，不新增永久 Agent。仅在高风险、低置信度、证据冲突或最终独立验收策略要求时调用 Reviewer/Judge。
5. 每次具体工具动作使用统一状态合同：`Proposed -> Authorized -> Dispatched -> Succeeded | Failed | Unknown | Cancelled`，并绑定 operation ID、attempt ID、幂等/可重试属性、真实工具回执和当前 plan revision。结果为 Unknown 的外部副作用不得自动重放。
6. 运行时提供确定性预算：连续模型决策、单动作重试、replan、委派数量、时间和成本分别设限；预算耗尽只能进入显式暂停、询问用户或失败状态，不能伪装完成，也不能静默开启新循环。

完成判据：普通顺序 Coding 能在同一上下文完成“读取 -> 修改 -> 聚焦验证 -> 根据结果再修改”；单个非安全内部字段错误不会阻止整个运行开始。

### G. 工具能力从角色解绑

1. 工具授权不再由 `AgentRole` 固定工具列表决定；宿主根据当前 Action、TaskContract、workspace scope、用户授权和风险生成 capability set。
2. 主 Agent/Coder 可以获得受审计、受沙箱和 scope 约束的开发命令能力，用于“修改 -> 聚焦验证 -> 根据结果再修改”；这类开发验证不能自行签发独立最终验收。
3. 独立 Tester 默认保持只读工作区和验证命令能力；Reviewer 只获得完成复核所需的最小 capability。
4. shell 的安全边界由统一 execution policy、cwd、网络/进程权限、工具回执和写后文件审计保证；角色名称不能成为安全边界，shell 也不得绕过 write scope。

完成判据：同一主 Agent可以在授权范围内连续修改和自测；越界 shell 副作用仍被宿主阻止或记录为未知结果，最终验收策略不因 Coder 自测自动满足。

### H. 让 DAG 成为按需工作图

1. 默认运行不要求 Planner 预先输出完整 DAG；主 Agent可以直接 Act，也可以提出 Delegate/RevisePlan。
2. Delegate 或并行请求经宿主校验后生成版本化 work graph；图只表达已承诺工作、依赖和资源关系。
3. 删除通过拓扑位置推断 Diagnostic/Verification 的控制语义；任务 purpose 由提案显式给出，宿主只验证枚举及与授权/证据类型的一致性。
4. 不再无条件给每个 Coder 追加固定 Tester。模型根据用户目标和改动内容提出验证方案；宿主只根据安全、发布等级和用户明确要求追加最低门槛，再由 verification policy 选择开发验证、独立测试、静态产物或人工验收。`verification policy` 是一个确定性合并策略：输入仅限用户明确验收要求、风险级别、实际改动资源和模型提出的验证方案；输出为最低验证门槛及允许的证据类型。它不是隐藏 Judge，不重新解释用户目标，也不得把所有修改静默改成“测试命令退出码必须为 0”。

完成判据：单 Agent、顺序多步、并行委派和高风险独立验收都复用同一事件、权限、evidence、恢复和终态系统。

### I. 分层完成语义

1. 分离原始消息、`UserRequirement`（版本化解释）、`ExecutionObligation` 和 `EvidenceRequirement`。
   - 每条有效 `UserRequirement` 保留原始消息来源和稳定 ID；完成前必须处于 `Satisfied`、`NotApplicable`、`Blocked` 或 `Withdrawn` 之一。宿主不解释语义，但负责防止已经登记的要求在 revise/压缩/恢复后静默消失。
2. “项目是否健康”与“用户委托是否完成”分别建模；测试仍失败可以与已完成的诊断/边界内任务同时成立。
3. `ProposeFinish` 触发完成评估，不直接提交 Completed；Completion Evaluator 解释证据对用户委托的语义，ConvergenceEngine 只阻止其与明确工具事实、权限或未满足门槛冲突，Reducer 才能提交 Completed。
4. 报告展示已提交事实、语义结论、未验证项和项目健康状态，不再把任一布尔值代替全部语义。

完成判据：N01 NoChange、N02 边界内修复、N03 边界外诊断和 M02 常规修复都能得到与用户委托一致、且不伪造项目健康度的终态。

### J. 迁移与发布策略

1. 不新增第三套运行路径。新决策循环调用现有 control-plane command/event、权限、工具、EvidenceRef、checkpoint 和报告投影。
2. 迁移期明确区分两种概念，避免与现有 `CodeProRuntimeMode::Shadow` 混用：
   - **兼容投影（compatibility projection）**：由权威 `RunProjection` 单向回填旧 `TaskDAG`，只服务尚未迁移的读取方；完成 Scheduler 切换前，它仍可能被旧调度代码读取，属于待消除的过渡控制源，不能称为纯只读镜像。
   - **运行时 Shadow 模式（`CodeProRuntimeMode::Shadow`）**：旧生产路径实际执行并生成用户可见结果；新路径只计算和记录对照结果，不执行副作用、不写 task/run 权威状态，也不生成最终报告。Shadow 对照只能写入独立的诊断/观测记录。
3. 每个迁移阶段必须记录：实际执行者、镜像计算者、唯一状态写入者和最终报告来源；不得用同一个 `shadow` 名称掩盖不同权力边界。
4. 每阶段先用已有 E2E 固定行为，再扩大到长任务、replan、暂停恢复和未知副作用场景。
5. 第一阶段 patch 完成后进行一次独立高能力模型对抗审查；审查只读，重点检查事实 owner、状态写入、证据失效和恢复边界，不能以审查文字替代构建/E2E。
6. 上下文压缩、进程恢复或模型切换后，从权威事实重新装配主 Agent 上下文：当前 requirement revision、plan revision、RunProjection、未完成/Unknown 动作、blocker、相关 EvidenceRef 和不得重复的副作用。自然语言摘要只能辅助理解，不能替代这些结构化事实。

完成判据：默认路径切换前，同一批 E2E 在新旧编排上有可对照的结构化运行记录；切换只改变编排策略，不改变权限、工具事实、持久化和完成权威。

## 明确不做

- 不删除 DAG，也不改成无约束的自由 Agent 群。
- 不把所有简单任务强制拆成 Planner/Coder/Tester。
- 不靠更多 Planner 提示词或字符串匹配掩盖协议问题。
- 不将模型自然语言报告当作工具执行、权限、完成或恢复事实。
- 不为了当前夹具通过而修改测试、放宽写入授权或伪造 evidence ref。
- 不把“薄主 Agent”实现为与 control plane 并列的新状态机。
- 不用关键词、文件数或静态风险等级硬判“是否必须 DAG”；是否委派由模型提议，宿主只做可行性和安全校验。
- 不让永久 Judge 对每个步骤重复解释用户目标；独立判断仅在策略要求的边界触发。

## E2E 验收重点

1. 普通 Coding 默认不创建完整 DAG：同一个主 Agent 完成“读取 -> 修改 -> 聚焦验证 -> 根据真实输出再次修改”，所有工具事实仍进入统一事件、证据和权限系统。
2. 主 Agent 遇到工具失败或新证据后可以结构化选择 `Act`、`RevisePlan`、`AskUser` 或 `ProposeFinish`，不得因原静态图没有对应节点而被迫停止。
3. 复杂任务只有在主 Agent 明确 `Delegate` 或需要并行、隔离、显式依赖时才产生 work graph；新图 revision 保留旧任务和证据历史，但旧 revision 证据不得自动满足新义务。
4. Coder/主 Agent 可以运行受限开发验证；高风险或用户明确要求的独立最终验收仍由只读 Tester/Reviewer 执行，开发自测不能冒充独立验收。
5. 基线失败 -> 实现步骤收到绑定当前 run/plan 的真实基线 -> 最终验收重跑相应验证；交接使用 `TaskInputRef` / `EvidenceRef`，不能只靠提示词写“根据 task-1”。
6. 基线已通过 -> `NoChange` 成为正式结果 -> 用户委托可以完成，不制造补丁，也不强制 Coder 伪造 `ChangedFiles`。
7. N03 类边界任务可得出“用户委托已完成，但项目测试仍失败”：项目健康状态与委托完成状态分别记录，不因测试仍红就把已完成的诊断错误降级为 Blocked。
8. Completion Evaluator 提议 `ProposeFinish` 但缺少真实证据、越过授权或仍有硬性 blocker 时，Convergence 必须拒绝；Reducer 只能在校验通过后写入 `Completed`。
9. Planner/Coordinator 候选缺少展示名、内部 ID 等非语义字段时由宿主绑定；缺少技术步骤时由模型补充或 revise；缺少写入授权时宿主明确阻止，绝不代替模型猜修法或扩大范围。
10. 暂停/恢复后只继续未完成动作；已知完成动作不重复执行，结果未知的副作用动作不得盲目重放。
11. 报告、任务面板和持久化 projection 对终态、checkpoint、未验证项保持一致；自然语言报告不能覆盖 reducer 的结构化终态。
12. 在相同权限、工具和夹具下对照旧固定编排与新动态编排：比较能否启动、工具动作数、交接完整性、是否误判完成和恢复正确性，而不只比较最终是否 PASS。
13. A -> B -> C 中 A/B 的完成只改变 task state，不改变 plan revision 或 current graph；最终 evidence coverage 仍覆盖同一版中的 A、B、C。只有显式 `RevisePlan` 才产生下一 revision，旧 revision 的 evidence 不会被当成新义务的默认凭证。
14. 简单解释类请求可直接 `Respond`，不创建 DAG；用户中途新增/撤回要求会产生 requirement revision，并停止尚未授权的动作。
15. 工具 dispatch 后崩溃或取消会留下 `Unknown`/`Cancelled` 动作事实；恢复后不得盲目重放。上下文压缩后仍能从结构化状态继续当前任务。

## 当前证据边界

本文记录的是截至 2026-09-21 当前工作树的源码事实和施工决策。此前 E2E 证据针对旧固定 DAG 版本，只能作为迁移基线，不能证明新动态运行时已通过 E2E。下方明确列出的局部编译结果也不等于桌面产品可运行或用户流程已验证；每阶段完成后必须更新实施状态和剩余断点。

## 2026-09-20 本轮实施记录

以下是旧固定 DAG 路线上的实施账本；每项状态以新目标架构为准，不能把“曾落地”理解为“必须永久保留”：

1. **需调整：迁移到 V2。** `TaskInputEnvelopeV1` 已让交接摆脱自由文本，但仍从可变 `TaskDAG` 读取部分运行事实；V2 必须分别从 PlanGraph、RunProjection 和 Evidence Store 取拓扑、状态和证据。
2. **保留。** `agents/task_evidence.rs` 将 Worker 终态、输出、workspace delta 与 verification evidence 固化为绑定 run/event/artifact 的 `EvidenceRef`；继续作为统一事实基础。
3. **保留并扩大覆盖。** Scheduler 正常 `WorkerOutcome` 已携带真实 evidence refs；后续要让主 Agent 工具动作、host-only、恢复和委派分支使用同一提交边界。
4. **需调整。** Convergence 使用 `ControlPlaneRefs` 的方向保留；依赖 DAG ledger 判定领域完成仅作为迁移兼容，最终应读取 UserRequirements、ExecutionObligations、EvidenceRequirements 与 RunProjection。
5. **保留并继续瘦身。** Planner 已不再复述宿主字段；新 coordinator proposal 进一步移除 run/revision/完整 EvidenceRef。Planner 仍只负责语义规划，写入 scope 继续由用户授权和宿主策略约束。
6. **保留。** 报告 outcome 必须在 convergence 与 reducer 终态之后投影，禁止先宣告 Completed 再被控制面降级。
7. **需调整并重命名。** 宿主生成的是执行义务和证据门槛，不是用户目标；必须拆成 `UserRequirements`、`ExecutionObligations`、`EvidenceRequirements`，避免循环证明。
8. **退出默认路径，保留兼容场景。** 固定 `diagnostic Tester -> implementation Coder -> verification Tester` 只适用于明确要求独立基线和复验的任务；普通 Coding 改为动态主循环，是否委派由模型和验证策略决定。
9. **保留。** 证据选择只使用结构化 outcome、时间和引用，禁止自然语言关键词成为控制条件。
10. **保留。** DAG 字段只做结构和安全边界验证；业务验收不能靠 acceptance criteria 中的词面匹配。
11. **保留。** host-only 动作与模型 Worker 共用 control-plane 注册、执行和 evidence commit 边界。
12. **需调整。** Convergence 始终运行的安全门槛保留，但它只验证事实、授权和硬门槛；“用户委托语义上是否交付”由 Completion Evaluator 提议，Reducer 才是唯一终态写入者。
13. **保留。** `FailRun` 必须引用已提交的失败证据，不能形成无根因的终态。
14. **需调整。** `RecoveryEvidence` 是正式输入关系的起点；后续用 plan revision、attempt、supersession 和 typed `InputEdge` 替代复用旧 task ID 的动态修图。
15. **保留。** Workspace delta 继续作为 evidence bundle 中的固化事实，不扩散为所有 DTO 的可选字段。
16. **保留并迁移到 V2。** 输入引用必须绑定 plan revision；V2 还需绑定 producer attempt 与适用的产物版本，使代码变化后旧证据可失效。
17. **需调整并分层。** replacement Planner 不再复述用户要求的方向正确；旧 `goal requirement` 必须拆分来源与职责，模型可版本化解释用户要求，宿主只维护来源、授权和证据绑定，不能从执行计划反推完整用户目标。

静态检查：2026-09-20 切片完成 `cargo fmt` 与 `git diff --check`；当时未运行类型联编和 E2E。

## 2026-09-21 实施记录

1. **运行状态权威收敛切片。** Durable 模式每轮调度前从 control-plane `RunProjection` 对齐兼容 `TaskDAG` 状态；Ready/Running/terminal/wait 状态按精确映射投影，不再让旧 DAG 中的 Pending/Ready 覆盖 reducer 已确认的终态。该切片没有新增 `TaskDAG` 写入权威，但 Scheduler 仍读取其 Ready、依赖和部分状态，因此它目前是兼容投影兼过渡控制源，尚未完成 `PlanGraph + RunProjection` 迁移。
2. **模型决策合同瘦身切片。** Coordinator 模型只输出语义 proposal、理由和已知 evidence event ID；run ID、decision ID、plan revision、协议版本、完整 `EvidenceRef`、预算和权限由宿主从当前 projection 绑定。模型不再被要求复述宿主事实，原有 envelope validator 与 control command 继续作为安全边界复用。
3. **当前验证边界。** 两个切片均已执行 `cargo fmt`；`cargo check -p goose --lib` 分别通过。Coordinator 四组集成测试夹具已切换为 proposal 协议，`codepro_coordinator_repair` 以及 `codepro_coordinator_advisory`、`codepro_coordinator_authoritative`、`codepro_coordinator_shadow` 已完成 `--no-run` 编译。尚未构建桌面应用或进行真实 E2E，因此不能声称产品行为已通过。
4. **调度控制源迁移切片。** Durable Scheduler 每轮先把兼容计划同步到 control plane，再从同一个最新 `RunProjection + current TaskGraph` 构造 `RuntimeSchedulingView`。Ready task、全局生命周期 blocker 和 repair 依赖都从该视图读取；批次选择不能再由兼容 DAG 的本地状态单独触发或阻塞执行。视图严格裁剪到当前 plan revision 的 task set，历史 revision 中保留的失败或暂停节点不会污染当前调度。任务正文、合同、恢复上下文和结果兼容回填仍来自 `TaskDAG`，所以这只是调度入口迁移，不代表整个 Scheduler 已切换到 `PlanGraph + RunProjection`。该切片已执行 `cargo fmt`、`git diff --check` 和 `cargo check -p goose --lib`；类型联编通过，仍未进行产品 E2E。
5. **计划 revision 不变量修复。** 2026-09-21 对抗审查确认旧 `planned_tasks()` 只保留 Pending/Ready/Running，导致任务完成被误识别为新拓扑并自动安装 revision，进而造成 TaskInput/evidence 使用本地旧 revision、completion 仅覆盖最后剩余节点。现已让兼容 DAG 向 control plane 声明完整计划；状态变化不再缩图或升 revision，拓扑不一致但缺少显式下一 revision 和 audit 时 fail closed。Durable TaskInput 与 Worker evidence 使用当前 `RuntimeSchedulingView` 的正式 revision。相关反向测试已改为保护“完成 A 后仍为同一 revision 且图仍含 A/B”。已执行 `cargo fmt --all`、`git diff --check` 和 `cargo check -p goose --lib`，类型联编通过；未运行单元测试、桌面构建或 E2E。

下一断点：

- `commit_host_retest_resume()` 当前仍用安装同拓扑的新 plan revision 来重新入队验证任务；这是现有 control-plane 缺少通用 Action/Task Attempt 恢复合同的兼容做法，不代表正确目标语义。重试或恢复只应增加 action/task attempt；除非拓扑、合同或执行义务真实变化，否则不得增加 plan revision。实现 attempt 状态机前不得直接删除该 revision 路径，以免破坏已存在的恢复能力。
- 当前代码仍只是旧 DAG/Coordinator 的可靠性迁移切片，尚未实现目标架构中的 Main Agent Decision Loop。下一阶段不得继续把旧 Coordinator 扩成更重的图管理员；应先落最小 `Respond/Act/RevisePlan/ProposeFinish` 决策边界及动作状态合同。
- `CompleteRun` 仍允许调用方提交整份 `CompletionRequirements`；需改为调用方只提出语义完成及 evidence IDs，由宿主从 Projection、权限、风险策略和 Evidence Store 构造硬门槛。Reducer 不接受调用方选择 evidence authority。
- Coordinator 新任务 proposal 仍要求模型填写正式 task ID、role、scope 和 required evidence，协议仍偏重；应逐步改为模型输出局部引用、语义目标、能力、依赖含义和建议验证，宿主生成正式 ID 并绑定已授权 scope。
- Durable 路径仍存在先写本地 `TaskDAG` 生命周期、再让 control plane 追认的分支；继续迁移为 command -> reducer -> projection -> 单向兼容回填。
- `EvidenceRef` 的格式和 run 归属校验尚不等于 artifact 已提交；Convergence 还需通过 Evidence Store 核对 artifact/event、内容摘要、attempt 和 revision。
- 通过编译和 E2E 核对 durable/shadow/host-only repair 三种执行路径的 evidence ref 是否都出现在同一 control-plane projection；源码已统一提交边界，但尚无运行证据。
- 一般“最终 Verification 失败后修复”的兼容分支仍会复用原 Verification task ID；诊断阶段已经改为 immutable source + distinct retest。下一阶段需用显式 attempt/supersession 语义替代剩余复用，同时保持 control-plane 对旧持久化任务的兼容。
- 收敛 legacy `CodeProRunState` 的写权限：只保留兼容投影，最终 Completed 只允许 reducer 在 convergence eligible 后提交。
- Planner 合同已明显瘦身，但首次和纠错仍使用同一模型；若后续 E2E 仍出现“业务理解正确但 JSON 无法启动”，应优先增加宿主对已解析安全片段的局部编译/降级，而不是继续扩大提示词或把协议错误归因给用户。
