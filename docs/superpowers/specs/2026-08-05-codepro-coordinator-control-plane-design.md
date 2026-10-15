# CodePro Coordinator 与 Control Plane 架构设计

**日期：** 2026-08-05

**状态：** 架构方向已批准，实施计划编写中

**目标产品：** Windows 优先、体验接近 Codex 的 CodePro 桌面开发 Agent

**迁移原则：** 保留现有会话、DAG、权限、审计和恢复能力，渐进替换，不推倒重写

## 1. 背景与问题

当前 CodePro 已经具备 Planner、Coder、Tester、Reviewer、任务 DAG、行动预算、暂停恢复、结构化证据、权限、幂等和审计能力。现有控制链是混合架构：Planner 和 Worker 使用 LLM，`Agent::reply_codepro()` 与 `TaskScheduler` 使用 Rust 代码推进任务状态。

现有架构的主要问题不是“存在调度器”，而是语义决策与确定性执行没有形成清晰边界：

- 初始 DAG 对后续路径约束较强，任务完成或语义失败后缺少统一重规划入口；
- 基础设施失败、实现错误、验证失败、权限阻塞和上下文不足没有统一类型合同；
- 用户级取消主要是整轮取消，缺少 Worker、任务和分支粒度；
- Reviewer 返工、重试、暂停、恢复和最终报告逻辑集中在大型入口文件中；
- Worker 可以在任务内自治，但不能以稳定协议请求协助或方向修正；
- 状态数据库、活动消息和最终报告存在形成多套事实源的风险；
- 完成判断仍可能受到行动次数、自然语言报告和固定流程的影响。

本设计将 CodePro 改造成“LLM 负责策略、Rust 负责机制”的混合控制系统。

### 1.1 实施前置缺陷

控制架构迁移开始前，必须先形成可恢复基线并关闭两个当前证据缺口：

- 非 Git 工作区中，Shell 或外部工具间接写入未必经过文件参数登记，可能逃逸增量证据追踪；
- 历史影子工作区与用户实际项目路径可能产生显示、修改位置和恢复语义不一致。

这两个缺陷作为独立的 U-74F 紧急基线修复包处理。未通过对应回归测试和真实 Windows 项目验收前，不得进入 U-75。

## 2. 目标与非目标

### 2.1 目标

1. 主 Coordinator Agent 成为唯一语义协调者。
2. Rust Control Plane 成为唯一权威状态和执行入口。
3. Worker 使用独立上下文，在任务合同内自治。
4. 支持动态创建任务、重规划、返工、换 Worker 和向用户求助。
5. 支持停止 Worker、取消任务、取消分支、暂停运行和紧急停止。
6. 使用版本化事件和结构化协议驱动后端、ACP、桌面 UI 与恢复。
7. 保留权限、沙箱、审计、预算、幂等和外部副作用保护。
8. 简单任务不引入额外多 Agent 和 Coordinator 成本。
9. 旧会话、旧 DAG 与旧前端协议可以渐进迁移和回退。
10. 在 Windows 安装版完成真实 Provider、Git、MCP、取消和恢复验收。

### 2.2 非目标

- 不让 LLM 直接终止进程、批准权限或修改权威数据库；
- 不在首版开放无限递归子 Agent；
- 不默认允许多个 Writer 修改共享文件；
- 不在本项目中重建模型训练、多租户 SaaS 或云调度平台；
- 不把 GitHub 日志、制品下载、浏览器控制等外围功能混入本次控制架构重构；
- 不一次性重写 `agent.rs`、`task_scheduler.rs` 或现有持久化层。

## 3. 业界参考与设计结论

Codex、Claude Code 和 Hermes 都允许主会话委派独立 Agent，由父级汇总结果；它们同时保留确定性的线程生命周期、权限、工具、并发和状态机制。共同模式不是“全部交给 LLM”，而是：

- 主 Agent 负责目标、委派、语义判断和结果汇总；
- 子 Agent 在独立上下文中完成有界任务；
- 宿主负责权限、安全、生命周期、工具执行和状态一致性；
- 并行优先用于独立、只读或文件所有权清晰的工作；
- 用户批准不能由另一个 Agent 代替。

参考资料：

- OpenAI Codex Subagents：<https://developers.openai.com/codex/multi-agent>
- Claude Code Subagents：<https://code.claude.com/docs/en/sub-agents>
- Claude Code Agent Teams：<https://code.claude.com/docs/en/agent-teams>
- Hermes Delegation Patterns：<https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/delegation-patterns.md>

因此采用混合控制架构，不采用纯 LLM 控制或继续强化固定调度器两种极端方案。

## 4. 总体架构

```text
用户
  -> Coordinator Agent（语义决策）
  -> Rust Control Plane（校验与执行）
  -> Worker Runtime（独立 Agent 会话）
  -> 结构化事件与结果
  -> Rust Control Plane（权威状态）
  -> Coordinator Agent（继续、修复、重规划、求助或完成）
```

### 4.1 Coordinator Agent

负责：

- 理解用户目标、约束和追加要求；
- 判断直接执行或委派；
- 创建、修改和收敛任务计划；
- 选择 Worker 类型与模型能力；
- 解释语义失败和协助请求；
- 决定重试、修复、换方案、暂停、求助用户或结束；
- 生成面向用户的结论。

Coordinator 不拥有执行工具、数据库写权限、进程终止权、权限批准权或硬预算修改权。它只能产生结构化决策候选。

### 4.2 Rust Control Plane

负责：

- 权威运行状态机；
- 决策 Schema、权限和任务合同校验；
- Agent 启停、取消、超时和进程树清理；
- 并发、Token、行动和资源预算；
- 工具权限、沙箱、网络限制和用户授权；
- 幂等、防重复写入和不确定副作用；
- 事件追加、投影、崩溃恢复和审计；
- DAG 合法性、任务依赖和文件写入所有权；
- 完成条件的最终裁决。

### 4.3 Worker Agent

Worker 是独立 Agent 会话，在任务合同内自行分析、调用工具、选择局部方案、保存检查点并返回结构化结果。首版 Worker 不能直接修改全局 DAG 或无限创建子 Agent，只能提交协助请求，由 Coordinator 决定是否创建新任务。

首版内置 Worker 类型：

- `general`
- `explorer`
- `planner`
- `coder`
- `tester`
- `reviewer`

角色是能力、Prompt、模型和权限模板，不再代表固定执行顺序。

## 5. 状态模型

### 5.1 运行状态

```rust
enum RunState {
    Planning,
    Running,
    WaitingForUser,
    Paused,
    Recovering,
    Completing,
    Completed,
    Failed,
    Cancelled,
}
```

### 5.2 任务状态

```rust
enum TaskState {
    Proposed,
    Ready,
    Running,
    WaitingForCoordinator,
    WaitingForApproval,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
    Skipped,
}
```

### 5.3 Agent 状态

```rust
enum AgentState {
    Starting,
    Running,
    Idle,
    Stopping,
    Stopped,
    Crashed,
}
```

三层状态独立。Agent 崩溃不自动等同于任务失败，任务失败也不自动等同于整轮失败。

## 6. 权威事件协议

所有状态变化写入单一追加式事件流；投影数据库只保存可重建的查询状态，不构成第二事实源。核心事件包括：

```text
RunStarted
PlanProposed
PlanRevised
TaskCreated
TaskStateChanged
AgentSpawned
AgentStateChanged
ToolCallStarted
ToolCallCompleted
CheckpointSaved
TaskSucceeded
TaskFailed
AssistanceRequested
PermissionRequested
CoordinatorDecisionMade
RunPaused
RunCompleted
RunFailed
RunCancelled
```

每个事件包含：

- `run_id`
- `event_id`
- 单调递增 `sequence`
- 可选 `task_id` 和 `agent_id`
- `causation_id`
- `correlation_id`
- UTC 时间戳
- 协议版本
- 类型化 Payload
- 有界、脱敏证据引用

事件存储采用宿主单写者和乐观序号。LLM、Worker 和 UI 只能提交命令或事件候选，不能直接写入权威状态。当前状态数据库和 UI 状态均由事件投影产生。

## 7. Worker 结果与失败分类

```rust
enum WorkerOutcome {
    Succeeded(TaskResult),
    Failed(TaskFailure),
    Blocked(BlockReason),
    NeedsHelp(AssistanceRequest),
    Paused(Checkpoint),
    Cancelled(CancellationReport),
}
```

```rust
enum FailureClass {
    TransientInfrastructure,
    Environment,
    Validation,
    Implementation,
    PermissionDenied,
    PolicyViolation,
    ContextInsufficient,
    BudgetExhausted,
    NoProgress,
    Unknown,
}
```

处理权划分：

| 失败类型 | 决策者 | 行为 |
|---|---|---|
| 临时网络、429、连接重置 | Control Plane | 有界退避重试 |
| 超时、取消、资源耗尽 | Control Plane | 停止并保存检查点 |
| 测试失败、实现错误 | Coordinator | 修复、重规划或换 Worker |
| 权限拒绝、策略违规 | 用户与宿主策略 | 禁止 Agent 自行批准 |
| 需求不清、方案冲突 | Coordinator | 向用户提问 |
| 重复动作、无进展 | 宿主检测，Coordinator 决策 | 停止 Worker 或重规划 |

## 8. Coordinator 决策协议

```rust
enum CoordinatorDecision {
    ContinueTask,
    SendInstruction,
    SpawnTask,
    RetryTask,
    ReplaceWorker,
    RevisePlan,
    PauseTask,
    CancelTask,
    CancelBranch,
    AskUser,
    CompleteRun,
    FailRun,
}
```

每项决策必须携带：

- 决策原因；
- 目标任务或 Agent；
- 输入证据 ID；
- 任务合同或计划修订；
- 请求预算；
- 权限要求；
- 预期完成条件；
- 被取代的计划版本。

Control Plane 必须检查决策是否越权、是否扩大写入范围、是否违反依赖与文件所有权、是否超过预算，以及证据是否属于当前运行。

Coordinator 输出使用 JSON Schema。首次格式错误允许一次格式修复；再次失败时使用安全默认，只能暂停、报告或询问用户。

## 9. 控制循环

```text
接收用户目标
  -> Coordinator 生成初始计划
  -> Control Plane 校验并写入事件
  -> Dispatcher 启动 Ready Worker
  -> Worker 返回结果、失败、阻塞或协助请求
  -> Control Plane 先执行安全与基础设施归类
  -> 在语义决策点唤醒 Coordinator
  -> Coordinator 返回结构化决策
  -> Control Plane 校验并执行
  -> 满足收敛条件后生成报告
```

只有以下情况唤醒 Coordinator：

- 任务完成或语义失败；
- Worker 请求帮助；
- 无进展或预算告警；
- 需要修改 DAG；
- 用户追加要求；
- 权限或环境阻塞；
- 准备结束运行。

普通工具调用和可确定恢复的临时错误不额外消耗 Coordinator Token。

对于无需委派的简单任务，当前主 Agent 直接承担 Coordinator 角色并执行；不会为了满足架构形式再增加一次独立模型调用或创建 Worker。只有出现委派、重规划、协助请求或语义失败时，才进入显式协调循环。

## 10. 中断与恢复

### 10.1 中断级别

| 操作 | 行为 |
|---|---|
| `StopWorker` | 停止一个 Agent，任务等待 Coordinator |
| `CancelTask` | 取消任务及当前 Agent |
| `CancelBranch` | 取消任务和依赖它的下游任务 |
| `PauseRun` | 停止新调度，保存可获得的检查点 |
| `EmergencyStop` | 立即撤销全部取消 Token、停止进程树并阻止新的外部写入；无法确认结果的在途写入标记为 `Uncertain` |

紧急停止由宿主立即执行，不等待 LLM。宿主不能承诺撤销已经被外部系统接受的副作用；这类操作必须进入不确定副作用恢复流程。取消后迟到的成功结果不能覆盖取消终态。

### 10.2 恢复流程

1. 重放事件并检查连续序号；
2. 查找无终态 Agent 和工具调用；
3. 将未知外部副作用标记为 `Uncertain`；
4. 禁止自动重试 `Uncertain` 写入；
5. 恢复合同、预算、依赖和文件所有权；
6. 生成有界恢复摘要；
7. Coordinator 决定继续、重新验证或请求用户确认。

## 11. 收敛条件

运行只有同时满足以下条件才能成功完成：

- 用户目标和硬约束已有明确覆盖；
- 所有必需任务进入终态；
- 修改任务具有真实测试证据；
- Reviewer 阻断问题已关闭或明确交给用户；
- 没有未决高风险写入；
- 没有未处理的 `Uncertain` 副作用；
- 最终报告区分完成、发现问题、未完成和未验证。

行动预算、超时和返工次数是安全上限，不是成功条件。

## 12. 目标代码结构

```text
crates/goose/src/agents/
├─ coordinator/
│  ├─ coordinator.rs
│  ├─ decision.rs
│  ├─ context.rs
│  ├─ prompt.rs
│  └─ validation.rs
├─ control_plane/
│  ├─ run_engine.rs
│  ├─ lifecycle.rs
│  ├─ dispatcher.rs
│  ├─ failure_policy.rs
│  ├─ recovery.rs
│  └─ convergence.rs
├─ protocol/
│  ├─ events.rs
│  ├─ outcomes.rs
│  ├─ commands.rs
│  ├─ identifiers.rs
│  └─ versioning.rs
├─ workers/
│  ├─ runner.rs
│  ├─ registry.rs
│  ├─ contract.rs
│  ├─ handle.rs
│  └─ assistance.rs
├─ task_graph/
│  ├─ graph.rs
│  ├─ validation.rs
│  ├─ ownership.rs
│  └─ revision.rs
└─ reporting/
   ├─ projection.rs
   ├─ user_report.rs
   └─ technical_report.rs
```

新文件建议不超过约 800 行；超过 1,000 行必须评估职责拆分。迁移完成后，`Agent::reply_codepro()` 只负责入口适配、启动 `RunEngine`、转发结构化事件和返回最终报告。

## 13. 核心 Rust 接口

```rust
#[async_trait]
pub trait Coordinator {
    async fn decide(
        &self,
        context: CoordinatorContext,
    ) -> Result<CoordinatorDecision>;
}
```

```rust
#[async_trait]
pub trait ControlPlane {
    async fn apply(
        &mut self,
        decision: CoordinatorDecision,
    ) -> Result<DecisionReceipt>;

    async fn handle_event(
        &mut self,
        event: RunEvent,
    ) -> Result<Vec<ControlEffect>>;
}
```

```rust
#[async_trait]
pub trait WorkerRuntime {
    async fn spawn(&self, request: SpawnWorkerRequest) -> Result<AgentHandle>;
    async fn send(
        &self,
        handle: &AgentHandle,
        instruction: WorkerInstruction,
    ) -> Result<()>;
    async fn stop(
        &self,
        handle: &AgentHandle,
        mode: StopMode,
    ) -> Result<StopReceipt>;
}
```

```rust
#[async_trait]
pub trait RunEventStore {
    async fn append(
        &self,
        expected_sequence: u64,
        events: &[RunEvent],
    ) -> Result<AppendReceipt>;
    async fn load(&self, run_id: &RunId) -> Result<Vec<RunEvent>>;
}
```

现有 `run_subagent_task_detailed()`、`TaskScheduler`、`TaskDAG` 和状态存储通过适配器接入，先不删除。

## 14. Coordinator 上下文与 Prompt

```rust
struct CoordinatorContext {
    user_goal: UserGoal,
    user_constraints: Vec<Constraint>,
    current_plan: PlanSnapshot,
    recent_events: Vec<EventSummary>,
    task_outcomes: Vec<TaskOutcomeSummary>,
    active_agents: Vec<AgentSummary>,
    open_blockers: Vec<Blocker>,
    evidence_refs: Vec<EvidenceRef>,
    permission_state: PermissionSnapshot,
    budget_state: BudgetSnapshot,
    workspace_state: WorkspaceSnapshot,
    user_steering: Option<UserSteering>,
}
```

上下文规则：

- 不默认传递完整工具日志、文件正文或网页内容；
- 提供有界摘要和可追溯证据引用；
- 用户目标、安全要求和开放阻塞不得因压缩丢失；
- 网页、代码、日志和 Worker 文本统一标记为不可信；
- Coordinator 需要更多证据时只能申请只读访问；
- Prompt 分为 `SYSTEM POLICY`、`HOST STATE`、`USER GOAL`、`UNTRUSTED EVIDENCE` 四区；
- Prompt 模板独立版本化并保存版本号。

初始上下文硬上限如下，数值必须可配置并记录实际裁剪结果：

| 区域 | 初始上限 |
|---|---:|
| `CoordinatorContext` 总输入 | `min(16,000 token, 模型上下文上限的 20%)` |
| 用户目标、硬约束、安全策略 | 预留总预算的 25%，禁止摘要删除 |
| `recent_events` | 最近 32 条且不超过 2,000 token，旧事件折叠为阶段摘要 |
| `task_outcomes` | 每项不超过 400 token，合计不超过 4,000 token |
| `evidence_refs` | 最多 32 个，合计不超过 1,500 token |
| Agent、权限、预算与工作区状态 | 合计不超过 2,500 token |
| `user_steering` | 最近一条原文加历史摘要，不超过 1,000 token |

优先使用 Provider 对应 tokenizer 计数；没有可靠 tokenizer 时使用保守估算并预留 20% 安全余量。超过上限时依次压缩已结束任务、旧事件和低风险证据，不得裁掉用户当前目标、开放权限请求、未决高风险写入或 `Uncertain` 副作用。

## 15. 模型路由与预算

### 15.1 路由原则

| 角色 | 优先能力 |
|---|---|
| Coordinator | 高推理、规划、稳定结构化输出 |
| Explorer | 快速、低成本、只读 |
| Coder | 代码与工具执行 |
| Tester | 确定性与证据纪律 |
| Reviewer | 高推理、独立上下文 |
| 摘要与压缩 | 低成本模型或确定性代码 |

运行使用启动快照。切换 Provider 必须获得相应授权，不能因错误静默把用户数据发送给另一个供应商。所有界面显示实际 Provider、模型和推理级别。

Coordinator 不是按模型名称获得权威资格。每个 Provider、模型和推理级别组合必须单独通过能力门禁，至少覆盖 Schema 遵从、依赖规划、失败分类、权限边界、证据引用和收敛判断。未通过或尚未评测的组合只能运行 `shadow`；达到建议门槛后可运行 `advisory`；只有通过安全与质量门禁的组合才能运行 `authoritative`。降级不得静默切换 Provider。

### 15.2 初始预算上限

- 同时运行 Worker：最多 4；
- 同时写入 Worker：默认 1；
- 首版嵌套委派深度：0；
- 基础设施自动重试：最多 2 次；
- Coordinator 格式修复：最多 1 次；
- 同一语义问题返工：最多 2 轮；
- 无进展阈值：3 个等价动作；
- 接近行动上限时要求 Worker 先保存检查点。

所有硬上限由宿主和组织策略钳制，Coordinator 只能申请预算，不能自行提升。

首版保持嵌套深度 0：Worker 通过 `AssistanceRequest` 请求能力，由 Coordinator 创建同级只读 Worker。这样保留单一任务所有权、预算继承和生命周期入口。嵌套深度 1 仅作为权威模式稳定后的独立候选功能评估，不属于首版完成条件。

## 16. 用户运行中追加消息

明显控制命令先由宿主识别，其余交给 Coordinator：

| 用户输入 | 行为 |
|---|---|
| 停止 | 取消运行或紧急停止 |
| 先暂停 | 暂停并保存检查点 |
| 只停测试任务 | 定向停止 Worker 或任务 |
| 别改数据库 | 新增硬约束并重新验证计划 |
| 换一种方案 | Coordinator 重规划 |
| 现在做到哪里了 | 只读状态回答，不打断运行 |
| 顺便增加功能 | 作为范围扩展，重新计算计划、预算和权限 |

用户新要求的优先级高于旧计划，但不能覆盖系统安全策略。

## 17. ACP 与桌面 UI

### 17.1 ACP 事件

新增版本化事件：

```text
run.created
run.state_changed
plan.revised
task.created
task.state_changed
agent.spawned
agent.state_changed
agent.message
approval.requested
checkpoint.saved
run.completed
```

新 UI 不再解析 `CodePro ·` 自然语言标记。旧字段保留一个迁移周期，旧历史通过兼容投影读取。

### 17.2 桌面布局

聊天正文展示用户目标、简短计划、关键重规划、权限请求和最终结论。输入框上方只在运行时显示阶段、活跃 Agent 数、暂停、停止和紧急停止。

右侧任务面板展示：

- 任务依赖和状态；
- Agent、模型、耗时和预算；
- 停止 Worker、取消任务和取消分支；
- 检查点、文件、测试和审查证据；
- 向 Worker 发送方向修正。

完整 Prompt、原始日志和 Token 流仅出现在技术折叠区。

## 18. 测试策略

### 18.1 协议与状态机

- 合法和非法状态迁移；
- 事件序号冲突；
- 重复事件和决策幂等；
- DAG 循环与依赖；
- 取消后迟到结果；
- 暂停、继续和崩溃恢复；
- 未决工具调用和不确定外部写入；
- 旧协议升级；
- 随机事件序列不产生不可能状态。

### 18.2 Coordinator

- Tester 失败后生成 Coder 到 Tester 修复链；
- 429 不创建无意义任务；
- 权限拒绝后不换工具绕过；
- 用户缩小或扩大范围后正确修订计划；
- Worker 协助请求分配正确能力；
- 无证据不得宣布完成；
- 预算耗尽保存检查点；
- Reviewer 阻断问题触发有界返工；
- 连续失败后向用户求助或明确未完成。

### 18.3 生命周期、安全与 UI

- Agent spawn、消息、完成、停止、崩溃和替换；
- Worker、任务、分支、运行和紧急停止；
- 子进程树清理与迟到终态；
- Agent 伪造授权和 Prompt injection；
- 路径穿越、符号链接、命令注入和凭据泄漏；
- 多 Writer 文件冲突；
- 桌面响应式、键盘、屏幕阅读器、多语言和历史恢复。

真实模型评测不能替代确定性合同测试，确定性合同测试也不能替代真实模型评测。每个候选 Provider、模型和推理级别组合都执行同一版本化评测集：

- 至少 30 个场景，覆盖规划、语义修复、权限、安全、证据和收敛；
- 普通语义场景至少重复 3 次，安全对抗场景累计至少 100 次；
- 一次格式修复后的 Schema 遵从率至少 99%；
- Critical 安全越权、伪造批准和未授权 Provider 切换为 0 次；
- 相比旧路径的任务成功率，95% 置信区间下界不得低于 `-5` 个百分点；
- 成本、首 Token 延迟、总延迟和 Coordinator Token 增量全部记录，未测量记为 `NOT_MEASURED`。

达不到门槛的组合保持 `shadow` 或 `advisory`，不得仅凭模型名称进入 `authoritative`。评测数据、判分器版本和失败样本必须随候选版本归档。

## 19. 性能与可靠性目标

| 指标 | 目标 |
|---|---:|
| 简单聊天额外 Coordinator 调用 | 0 |
| 用户停止到取消信号发出 | 不超过 200 ms |
| 子进程树停止 | 通常不超过 5 秒 |
| 状态变化到 UI 可见 | 不超过 500 ms |
| 同类基础设施自动重试 | 不超过 2 次 |
| 同一语义问题返工 | 不超过 2 轮 |
| 默认并发 Worker | 不超过 4 |
| 默认并发 Writer | 1 |
| 10,000 条事件恢复 | 不超过 3 秒 |
| Coordinator 上下文 | 固定上限，不随历史线性增长 |
| 复杂任务协调 Token 增量 | 目标不超过现有总消耗 25% |

未经测量的指标必须标记为 `NOT_MEASURED`，不能用估计值冒充通过。

## 20. 渐进迁移与任务包

现有 U-74 GitHub 日志与制品下载暂停。控制架构拆为：

### U-74F：紧急证据与项目路径基线修复

- 统一 Git 与非 Git 工作区的完整变更基线和本轮增量证据；
- 捕获 Shell、MCP 和外部工具产生的间接写入，不依赖模型声明；
- 所有 CodePro 路径使用会话选择的用户项目，移除影子路径歧义；
- 增加 Git、非 Git、Shell 间接写入、Windows 路径和报告一致性回归测试；
- 独立提交、验证并形成 G0 的首个可恢复基线。

### U-75：冻结基线与协议提取

- 整理现有变化并形成独立提交；
- 固定全量门禁；
- 提取 ID、状态、事件和结果类型；
- 不改变运行行为。

### U-76：权威事件存储与投影

- 追加事件、乐观序号和状态投影；
- 旧状态双读对账；
- 事件重放、损坏检测和版本迁移。

### U-77：Rust Control Plane

- U-77a：状态 reducer、命令校验和 `RunEngine` 骨架；
- U-77b：Worker 生命周期、进程树和细粒度取消；
- U-77c：失败分类、重试策略和 Ready 任务 Dispatcher；
- U-77d：收敛判断及现有 Scheduler、DAG、Worker、权限链适配。

四个子包分别提交和验收；前一子包失败不允许把未验证实现带入下一子包。

### U-78：Coordinator 影子模式

- 结构化上下文、Prompt、Schema 和决策审计；
- 与旧调度结果对比；
- 不执行 Coordinator 决策。

### U-79：Coordinator 建议模式

- 语义失败和协助请求交给 Coordinator；
- 先执行低风险决策；
- 写入范围变化继续使用原安全链；
- 支持快速回退。

### U-80：Coordinator 权威模式

- 动态计划和重规划；
- Worker 替换；
- Reviewer 返工统一；
- Scheduler 退化为 Ready 任务执行器。

### U-81：桌面细粒度控制

- Agent 面板；
- 停止 Worker、取消任务和分支；
- 暂停、继续、紧急停止；
- 运行中方向修正；
- 新 ACP 投影。

### U-82：恢复、迁移与真实验收

- 旧会话迁移；
- 崩溃与未决副作用恢复；
- 真实 Provider、Git 和 MCP；
- Windows 安装、升级、回退和卸载；
- 性能、安全与长时间运行。

## 21. 功能开关与回滚

```text
CODEPRO_COORDINATOR_MODE=off
CODEPRO_COORDINATOR_MODE=shadow
CODEPRO_COORDINATOR_MODE=advisory
CODEPRO_COORDINATOR_MODE=authoritative
```

每个阶段都能切回上一模式。事件协议向前兼容读取，新版本不得破坏旧历史。旧执行路径只有在两个连续候选版本无阻断回归后才能删除。

“阻断回归”定义为以下任一情况：

- 确定性合同、状态机、事件回放、迁移或权限测试失败；
- 未授权写入、权限扩大、重复外部副作用、数据丢失或不可恢复崩溃；
- 取消、恢复、状态投影或 Coordinator 能力指标低于已批准门槛；
- 真实模型评测低于第 18 节门槛；
- 旧会话无法读取、回退后无法继续，或新旧路径产生用户可见的错误目标路径。

只有被测试装置明确归类为 `environment_unavailable`、且没有执行产品逻辑的环境缺失可以不阻断。未知失败默认阻断，不允许为了放行候选版本事后改标环境问题。

## 22. 发布门禁

### G0：可恢复基线

- 当前成果全部进入版本控制；
- 工作区干净；
- 全量门禁绑定固定提交。

### G1：协议稳定

- 状态机、事件、结果和迁移测试通过；
- 用户行为不变。

### G2：影子模式可信

- Coordinator 决策有完整审计；
- 不改变生产行为；
- 能识别目标失败场景。

### G3：建议模式可用

- 测试失败能返回 Coder；
- 单 Worker 可停止；
- 不扩大安全权限。

### G4：权威模式候选

- 动态重规划稳定；
- 可立即回退旧路径；
- 无开放 Critical 或 Required 审查问题。

### G5：Windows RC

- 安装、首次启动、升级、回退和卸载通过；
- 真实 Provider、Git、MCP 和取消场景通过；
- 24 小时稳定性运行通过。

### G6：默认启用

- 两个连续候选版本无阻断回归；
- 新旧质量对比达到目标；
- 成本和延迟达到指标；
- 删除旧主流程得到单独批准。

## 23. 主要风险与应对

| 风险 | 应对 |
|---|---|
| 当前大量变化尚未形成基线 | U-75 前停止外围开发并逐项提交 |
| 新旧状态不一致 | 事件成为最终权威，影子阶段持续对账 |
| Coordinator 不稳定 | 有限动作、Schema、Fixture、一次修复和安全默认 |
| Token 成本增长 | 仅在语义决策点调用，使用有界上下文 |
| 多 Writer 冲突 | 默认单 Writer，后续使用 worktree 隔离 |
| 旧会话无法恢复 | 版本化迁移和只读兼容模式 |
| 模型无证据宣称成功 | 宿主收敛条件拥有最终裁决权 |
| Agent 绕过权限 | 所有执行必须经过 Control Plane |
| 重构长期不收敛 | 每个任务包独立验收、发布和回滚 |

## 24. 完成定义

只有以下条件全部满足，才能宣布本架构完成：

- Coordinator 是唯一语义协调者；
- Control Plane 是唯一权威状态和执行入口；
- Worker 使用独立上下文和结构化结果；
- 可以停止、暂停、修正和替换单个 Worker；
- 语义失败可以动态返回正确角色；
- 权限、预算、审计和幂等无法被 Agent 绕过；
- 崩溃恢复不重复外部副作用；
- 简单任务不增加多 Agent 开销；
- 桌面端能够解释当前状态、阻塞和下一步；
- Windows 安装版完成真实生命周期验收；
- 旧执行路径经过两个稳定候选版本后安全删除。

## 25. 已确认决策

- 采用混合控制架构；
- Windows 优先；
- 渐进迁移，保持历史兼容；
- 主 Coordinator 负责语义决策；
- Rust Control Plane 负责安全和生命周期；
- 首版不开放无限嵌套 Agent；
- 默认单 Writer；
- 先完成 U-75 至 U-82，再继续外围集成。
