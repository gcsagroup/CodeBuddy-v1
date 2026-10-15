# CodePro 动态运行时重构实施记录

日期：2026-09-21
分支：`fix/codepro-context-compaction`
性质：追加式实施账本，不是架构计划，也不拥有事实裁决权。

## 冻结基线

- Final Plan：`docs/superpowers/plans/2026-09-20-codepro-dag-runtime-refactor-plan.zh-CN.md`
- 事实权威与模块职责：`documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md`

除非用户目标变化、E2E 推翻核心不变量，或源码约束证明目标架构无法实现，否则不得用实施问题反向改写上述基线。需要重新打开基线时，先在本文记录触发条件、证据、影响范围和拟议 revision。

## 记录规则

每项实施记录至少包含：

- 日期与变更标识；
- 对应 Final Plan 阶段或事实权威项；
- 修改前的源码/运行证据；
- 实际修改及明确未修改范围；
- 编译、测试、E2E 和人工验收的真实结果；
- 未验证项、兼容债务和下一断点。

实现失败、局部命名调整、类型拆分、测试夹具问题和普通代码 Bug 只记在这里或独立 issue，不构成修改 Final Plan 的理由。

新增协议概念前还必须记录并回答：原有哪个概念被错误复用；新概念覆盖哪些跨角色通用场景；它替代并删除哪条旧分支或第二写者；未来会收敛到哪个统一抽象。只服务单个角色、工具或 E2E 症状且不减少旧职责的概念不得加入。

## 2026-09-21 初始冻结点

- 目标架构确定为：动态 Main Agent 循环、统一可靠运行时、按需 PlanGraph/DAG、结构化 Action/Attempt/Evidence、宿主权限与完成门槛。
- 已静态修复计划随任务完成自动缩水的问题：完整计划图在同一 revision 内保持稳定；无显式 revision/audit 的拓扑变化会被拒绝；Durable TaskInput 与 Worker evidence 绑定 control-plane 当前正式 revision。
- 已完成 `cargo fmt --all`、`cargo check -p goose --lib` 和 `git diff --check`；尚未运行该 revision 不变量的单元测试、桌面构建或产品 E2E。
- 当前已知迁移债务包括：host retest resume 暂用 plan revision 表达 retry、调用方仍可携带 CompletionRequirements、Durable 路径仍有本地 DAG 生命周期写入、EvidenceRef 尚未由 Evidence Store 完整实证、Coordinator 尚未替换为 Main Agent Decision Loop。
- 本记录建立后，新的源码发现和 E2E 结果继续向下追加，不回写 Final Plan 的实施细节。

## 2026-09-21 任务重试与计划 revision 解耦

- 对应基线：Plan revision 只表达拓扑、合同或义务变化；任务重试和恢复属于运行生命周期，由 Reducer 提交事实。
- 修改前证据：`SchedulerRuntimeBridge::commit_host_retest_resume()` 会把原任务、原依赖和原合同重新安装为下一 plan revision，仅借 `PlanRevised` 的副作用把 `WaitingForCoordinator` 推回 `Ready`。同一计划的恢复因此污染 revision，并让计划层间接拥有任务生命周期。
- 实际修改：
  - 新增确定性的 `ControlCommand::RetryTask` 和 `TaskRetryAuthorized` 事件；Reducer 只在运行处于 `Running/Recovering`、目标任务处于 `WaitingForCoordinator` 且已有结构化失败结果时接受命令。
  - retry event 记录递增 attempt、原失败及其 evidence refs；Projection 从事件恢复 `retry_attempts`，随后任务由 `WaitingForCoordinator` 转为 `Ready`。
  - host retest 恢复继续校验原始 host receipt、命令、工作区、依赖、预算和当前 PlanGraph，但提交阶段改为任务重试，不再安装新计划。
  - ACP 事件投影和 Coordinator evidence snapshot 显式识别该事件，避免消费者遗漏新增事实。
- 实施时发现的相邻根因：完整 PlanGraph 在同一 revision 内保持稳定后，上游任务成功不再触发旧式“重装计划”，暴露出下游 `Proposed -> Ready` 原本依赖该副作用。现已由 worker outcome Reducer 在提交 `TaskSucceeded` 时，根据当前权威 TaskGraph 和投影状态确定性推进刚满足依赖的任务；未修改 Planner 语义，也未重建图。
- 明确未修改：没有改 Final Plan、事实权威表、Planner/Coordinator 模型提示、用户授权、任务合同、自动 transient retry 策略或桌面 UI。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 51.42 秒；存在 3 条此前代码路径的 warning。
  - 首次运行 `cargo test -p goose durable_bridge_resumes_the_same_host_retest_from_coordinator_wait --lib -- --nocapture`：退出码 1；4 分 34 秒完成链接后，在夹具第二个依赖任务仍为 `Proposed` 处失败。该结果用于定位上述依赖推进缺口，不是新 retry 命令失败。
  - Reducer 接管依赖就绪推进后，重跑同一命令：退出码 0；1 个通过、0 个失败、3327 个过滤，用时 1 分 43 秒（用例执行 0.49 秒）。
  - `cargo test -p goose durable_bridge_host_retest_resume --lib -- --nocapture`：退出码 0；2 个通过、0 个失败、3326 个过滤，用时 3.12 秒（用例执行 1.45 秒）。覆盖无效 receipt、未完成依赖、预算耗尽、无显式恢复意图以及过期计划提交拒绝。
- 未验证项：尚未做桌面构建和产品 E2E；没有扩大到完整 `goose` 测试集。旧的自动 transient retry 仍使用 `TaskRetryScheduled + RetryTask effect`，其调度 lease 语义尚未在本阶段合并到新的显式重试命令。
- 收敛约束：`RetryTask / TaskRetryAuthorized` 是从错误 plan revision 语义迁出的过渡桥，后续必须被统一 `ActionAttempt` 的 attempt/retry 事实吸收；不得派生 `RetryTester`、`RetryReviewer` 等角色专用协议。
- 下一断点：把其他“通过 InstallPlan/plan revision 推动任务状态”的路径逐一迁回 Reducer/ActionAttempt；随后再接 Main Agent Decision Loop，避免新循环建立在旧生命周期副作用上。

## 2026-09-21 Reviewer 前置条件阻塞进入权威运行时

- 对应基线：Reducer 是任务生命周期唯一裁决者；Scheduler 只提交结构化事实；环境问题不能被重新解释成用户输入问题。
- 修改前证据：Reviewer 决策为 `WaitingForEnvOrPermission` 时，Scheduler 会绕过 Worker outcome 与 Reducer，直接把兼容 `TaskDAG` 写成 `WaitingForUser`。该分支既形成第二个生命周期 writer，也把“缺少可执行产物或桌面环境”错误表达为“需要用户回答”。当前决策输入中的 `permission_available` 固定为真，因此该分支的真实缺口可以确定为 artifact/desktop environment，而不是从提示词推断。
- 实际修改：
  - Durable 模式仍为 Reviewer 建立正式 task attempt，并把检查点写成 task evidence。
  - 使用现有 `WorkerOutcome::Blocked(BlockReason { kind: Environment, ... })` 提交事实，由 runtime/reducer 决定 `WaitingForCoordinator`，再由 projection 单向回填兼容 DAG。
  - 抽出“提交显式 Worker outcome 并按 projection 对账”的桥接方法；普通 Worker outcome 继续复用同一路径。
  - Legacy 与 Shadow 的主行为暂不改变，避免迁移阶段同时改变旧主路径和只读镜像语义。
- 明确未修改：没有新增任务状态、没有让 Scheduler 判断技术方案、没有修改 Reviewer 验收策略、Planner、权限合同、Final Plan、事实权威表或 UI 文案。
- 概念审查：本阶段没有新建 Reviewer 专用 command/event；`Blocked(Environment)` 是既有、跨角色的通用 Worker outcome，替代并删除了 Scheduler 将环境缺口直接写成 `WaitingForUser` 的旧分支。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 19.71 秒；仍为 3 条既有 warning，没有新增编译错误。
- 未验证项：尚无覆盖“真实桌面不可用 → 结构化 environment block → 恢复”的产品 E2E；本阶段没有运行完整 `goose` 测试集。Run 级 `WaitingForEnvironment` 仍未与并行 task outcome 提交语义统一，本阶段刻意只修 task 事实，避免仓促引入全局暂停。
- 下一断点：继续盘点 Durable 路径中 cancellation、依赖阻塞和 `Running` 兼容回填的直接 DAG 写入；优先把可由既有 reducer/effect 表达的状态迁移掉，再设计无法表达的 action-level 状态。

## 2026-09-21 Run 取消从本地 DAG 迁入 Reducer

- 对应基线：用户取消属于运行事实；Reducer 唯一提交 task/run 终态，事件仓库持久化，兼容 DAG 只读取 projection。
- 修改前证据：Scheduler 在批次选择前观察到 prompt cancellation token 后，只调用 `dag.cancel_non_terminal_tasks()` 并退出。Durable event stream 可能仍显示 `Running`，任务也可能在恢复时重新出现；如果改用现有 `EmergencyStop`，又会把正常用户取消与系统紧急停机混为同一个命令入口。
- 实际修改：
  - 新增 `ControlCommand::CancelRun`，保留独立的协议名称、校验和命令审计语义。
  - Reducer 将 `CancelRun` 与 `EmergencyStop` 都归约为相同的可靠停工事实：停止仍活跃的 Worker、把全部非终态 task 转为 `Cancelled`、追加 `RunCancelled`；两者只复用执行机制，不混淆入口意图。
  - Durable Scheduler 观察到 prompt cancellation 后提交 `CancelRun`，随后从 projection 对账兼容 DAG；只有 Legacy/Shadow 主行为继续直接取消本地 DAG。
  - 现有“任务已选但派发前状态发生变化”回归用例改用 `CancelRun` 覆盖正常取消入口。
- 明确未修改：没有改变 task/branch cancellation、紧急停止策略、Worker 强停 effect、UI 取消入口或 Coordinator 的技术决策权限。
- 概念审查：`CancelRun` 补齐既有 `CancelTask/CancelBranch` 的作用域层级，适用于任何角色与任务；它删除 Durable 的本地 `cancel_non_terminal_tasks` 第二写者，并与 `EmergencyStop` 共用 reducer、`RunCancelled` 事件和停工 effect，没有复制另一套取消状态机。未来 ActionAttempt 负责外部动作的 Cancelled/Unknown，`CancelRun` 只保留运行级用户意图。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 46.92 秒；3 条既有 warning。
  - `cargo test -p goose checkpoint_input_dispatch_rechecks_state_after_selection --lib -- --nocapture`：退出码 0；1 个通过、0 个失败、3327 个过滤。首次增量链接 2 分 55 秒，用例执行 1.36 秒。
- 未验证项：尚未从 Electron 点击取消执行真实 E2E；正在运行的外部副作用能否被工具层确认为 `Cancelled` 或 `Unknown` 仍属于后续 ActionAttempt 合同，不由本阶段假定。
- 下一断点：移除 Durable 在 Worker 正式启动后再次直接写 `TaskStatus::Running` 的反向控制，并核对依赖失败/手工审查传播是否已有 reducer 可表达的正式事实。

## 2026-09-21 Worker 启动状态改为 Projection 单向回填

- 对应基线：`ControlCommand → Reducer → RunEventStore → RunProjection` 是 Durable 生命周期唯一写链；兼容 `TaskDAG` 不得在同一事实已提交后再次裁决状态。
- 修改前证据：`prepare_worker_with_input_waits()` 已通过 `StartTask` 和 `RegisterWorker` 让 reducer 提交 task/agent 运行状态，但返回后 Scheduler 又无条件调用 `dag.update_task(... Running ...)`。正常路径结果通常一致，但异常恢复、并发取消或未来动态计划下，本地写入可能覆盖较新的 projection 事实。
- 实际修改：Durable 模式在 Worker 准备完成后重新读取 projection，并以权威 task state 回填兼容 DAG；Legacy/Shadow 继续使用原本的本地 `Running` 写入。任务故障标签清理和进度展示保持不变。
- 明确未修改：没有改变 Worker 注册顺序、租约、并行限制、模型调用、TaskInput、证据提交或 Legacy 调度。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 19.88 秒；3 条既有 warning。
  - 针对本阶段相关文件的 `git diff --check`：退出码 0；只有 Git 的 LF/CRLF 工作区提示。
- 未验证项：尚未做并发取消恰好发生在 Worker 注册后的竞态 E2E；本阶段依赖 reducer/lease 已有校验，没有新增只为实现细节存在的测试。
- 下一断点：分析 `skip_tasks_blocked_by_failure/manual_review` 的业务语义，先区分“确定性依赖不可执行”和“可以 replan/recovery”，再决定 reducer 事件；不得把旧 DAG 的 blanket skip 原样搬进新运行时。

## 2026-09-21 Durable 停止推断性跳过依赖任务

- 对应基线：Graph 是当前承诺与依赖的账本，不是不可变剧本；技术失败后是否 revise/recover 属于 Main Agent 语义决策，Scheduler 不得把暂时不可运行静默改写成永久 `Skipped`。
- 修改前证据：每轮 Worker 完成后，Scheduler 无条件调用 `skip_tasks_blocked_by_manual_review()` 与 `skip_tasks_blocked_by_failure()`。这两个旧方法只修改本地 DAG：依赖 `Paused/Failed/Cancelled/Skipped` 就把所有 `Pending` 下游直接设为 `Skipped`，不提交 reducer/event，也不区分未来可恢复、可替代或应重规划的任务。
- 实际修改：Durable 模式不再执行这两个推断性写入，只从 projection 对账。上游的真实 outcome 保留，下游仍是 `Proposed`，因此不会被调度；后续可由 Main Agent 基于证据选择 recovery、revise plan 或 propose finish。Legacy/Shadow 主路径继续旧传播行为。
- 概念审查：没有新增 dependency-specific command、event 或 state；本阶段通过删除 Durable 的隐式行为减少职责。若后续确有“用户明确放弃整个分支”的需求，应使用已有 branch cancellation 或正式 plan revision，而不是恢复 blanket skip。
- 明确未修改：没有改变 PlanGraph 依赖判定、ready 推进、task outcome、recovery policy、最终 convergence 或旧模式兼容。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 18.44 秒；3 条既有 warning。
  - 针对本阶段相关文件的 `git diff --check`：退出码 0；只有 Git 的 LF/CRLF 工作区提示。
- 未验证项：当前动态 Main Agent 尚未接入，因此 Durable 遇到这类阻塞时仍可能停止并报告未完成；这是诚实但暂时较弱的可用性，不声称已经具备自动 replan。尚未做该路径产品 E2E。
- 下一断点：完成本轮生命周期 writer 盘点，区分剩余直接写入是 Worker 局部候选结果、兼容 projection 镜像，还是 Durable 权威违规；然后进入 Main Agent 最小决策合同，避免继续在旧 Scheduler 上打补丁。

## 2026-09-21 可派发任务收敛为 Projection 派生事实

- 对应基线：运行状态来自 RunProjection；Scheduler 选择候选与 Reducer 授权 `StartTask` 必须消费同一结构化事实，不得分别推断。
- 修改前证据：Reducer 已允许两类非 `Ready` task 启动——依赖已成功的 `RepairPending` retest，以及 Run 处于 `Recovering` 时的 `Paused` checkpoint；Scheduler 却只把 projection 中精确等于 `Ready` 的 task 放入候选。与此同时，Coder 成功后 Scheduler 会短暂把本地 retest 从 `RepairPending` 改成 `Pending`，下一次 projection 对账又会覆盖它，导致正式运行时允许但调度器永远选不到。
- 实际修改：
  - 在 `RunProjection` 增加纯派生查询 `dispatchable_task_ids()`，统一表达 `Ready`、依赖已成功的 `RepairPending`、以及 Recovering 状态下 `Paused` 的派发条件。
  - Reducer 的 `StartTask` 门禁改为消费该查询，删除自身重复的 repair/recovery 判定。
  - Durable Scheduler 的 scheduling view 和候选选择消费同一查询，不再先局限于兼容 DAG 的 `ready_tasks()`。
  - Coder 成功后，Durable 不再把本地 retest 改成 `Pending`；只保留 repair context 元数据更新。Legacy/Shadow 继续旧兼容行为。
- 概念审查：没有新增 enum、command、event 或持久化状态；新增的是 RunProjection 上的派生查询，它替代两处重复规则并删除一处本地生命周期写入。未来 Main Agent、Convergence 或 UI 如需“现在能执行什么”，应消费此查询而不是再定义一套条件。
- 明确未修改：没有改变 repair phase、PlanGraph 依赖、RetryTask、Worker outcome、测试命令或角色职责。
- 验证事实：
  - 首次 `cargo fmt/cargo check` 发现 Rust 2021 不支持 let-chain，以及候选集合借用类型不匹配；均为实现错误，未改变设计后修正。
  - 修正后 `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 14.94 秒；3 条既有 warning。
  - `cargo test -p goose dispatchability_uses_projection_state_for_retest_and_recovery --lib -- --nocapture`：退出码 0；1 个通过、0 个失败、3328 个过滤。链接 2 分 14 秒，用例执行 0.00 秒。覆盖 retest 依赖成功/失败和 Recovering checkpoint 三个边界。
- 未验证项：尚未在真实“Tester 失败 → Coder 修复 → 原 Tester 重测”E2E 中验证调度闭环；projection 查询目前未替换 Convergence 的 `ready_task_ids` 诊断字段，因为该字段表达的是“尚未被 reducer 推进的 Proposed ready”，语义需在 Main Agent 阶段统一命名后再迁移。
- 下一断点：对本轮改动做一次静态生命周期 writer 复盘与 diff 审查；若没有新的 P0/P1 第二写者，再开始最小 Main Agent Decision 合同，而不是继续扩充固定角色 Scheduler。

## 2026-09-21 Durable 生命周期第二写者收口复盘

- 对应基线：阶段 E“先收敛唯一生命周期写入者”。
- 修改前证据：Durable 在 plan 同步失败、Worker setup 失败、runner attach 失败、Worker completion 基础设施失败及 checkpoint input cancellation 后，均已先让 control plane 提交终止/取消事实，却又调用本地 `cancel_non_terminal_tasks()`；checkpoint 对账还只同步少数终态，可能遗留旧的 Ready/Running/Wait。
- 实际修改：
  - 上述 Durable emergency/error 分支在正式 `EmergencyStop` 后统一读取 projection 回填，不再 blanket-cancel 本地 DAG。
  - checkpoint input dispatch error 使用收到的正式 projection 完整映射所有 task state；若 run 已取消，只联动 cancellation token，不再第二次裁决 task。
  - 因迁移退出生产路径的宽松 `task_status_from_runtime(fallback)` 已删除；无 evidence 的 outcome helper 和快捷 submit helper 仅保留给测试，生产只使用带 EvidenceRef 的显式提交路径。
- writer 分类结果：
  - Durable 权威写入：control command/Worker outcome → Reducer → event store → RunProjection。
  - 兼容镜像：projection 回填 `TaskDAG`，以及已提交 outcome 返回后保存用户可见 output/预算/repair metadata。
  - Legacy/Shadow 主行为：仍允许旧 DAG 的 Ready、Running、cancel、skip 写入；它们是明确兼容债务，不属于 Durable 权威。
  - Worker 内部对 `TaskNode` 的 Done/Failed/Paused 构造只是待提交候选结果，不能在 reducer 接受前成为运行事实。
- 概念审查：本阶段只删除重复 writer 和过期 helper，没有新增协议概念。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 18.65 秒；warning 从 3 条降为 1 条，剩余为既有局部 `unused_mut`。
  - 针对本轮相关文件的 `git diff --check`：退出码 0；只有 Git 的 LF/CRLF 工作区提示。
- 未验证项：阶段 E 尚不能宣称整个旧 `TaskDAG` 已是纯只读投影；合同、output、repair metadata 和 Legacy/Shadow 仍依赖它。这里只能确认 Durable task/run 生命周期的已知 Scheduler 第二写者完成本轮静态收口，真实 E2E 仍待构建后验证。
- 下一断点：进入阶段 F 前先定义最小 `AgentDecision` 与 action/attempt owner，要求复用当前 runtime/event/evidence，不引入第三套 session 或终态；第一切片优先落只读数据合同与宿主校验，不立即切换产品默认执行路径。

## 2026-09-21 Runtime mode 迁移脚手架审查

- 审查触发：用户质疑 `Legacy / Shadow / Durable` 是否属于无必要的复杂度。由于调整这些模式会改变运行、回滚和状态权威边界，本阶段先完成方案比较，不直接删除或改写模式语义。
- 当前源码事实：
  - 未配置 `CODEPRO_RUNTIME_MODE` 时默认 `Durable`；生产 ACP 使用带 effect executor 的 `initialize_production()`。
  - 非法配置值会静默选择 `Legacy`；请求 `Durable` 但没有 effect executor 时也会把 effective mode 改成 `Legacy`。前者会把配置错误伪装成可运行的旧语义，后者主要存在于非生产构造入口。
  - `Legacy / Shadow / Durable` 并非三套隔离实现。模式判断已进入 Agent、ACP、Control service 和 Scheduler；仅这四处就有 41 个显式判断，其中大部分位于 Scheduler 主循环。取消、Ready、Running、失败传播、Worker setup、outcome、terminal commit 都会按模式分叉。
  - `Shadow` 当前仍让旧 DAG 主路径决定并执行实际 Worker，新运行时镜像 start/outcome/terminal；镜像失败被记录但不改变旧结果。它不是第二次执行副作用，但也不是完全独立、可随时删除的旁路 observer。
  - `Durable` 下 Coordinator 仍被投影为 `Shadow`，表达的是“Coordinator 仅观察、宿主控制执行”，与 runtime shadow 使用同一术语但不是同一权力边界，增加了认知歧义。
- 方案比较：
  1. 立即删除 Legacy/Shadow：代码表面最简单，但会同时移除当前回滚入口、旧数据兼容和迁移对照；在 Durable 尚未完成真实 E2E 前风险不可接受。
  2. 长期保留三模式并继续逐处分支：短期改动最少，但每个新状态、取消、恢复和终态都要实现三遍，必然形成多套业务语义；拒绝。
  3. **收敛为单一 Durable 产品路径，Legacy/Shadow 只作有退出期限的边界脚手架**：保留迁移安全网，但禁止它们继续渗入新 Main Agent/ActionAttempt 设计；这是当前采用方案。
- 采用边界：
  - `Durable` 是唯一目标生产语义和唯一允许新增能力的路径。
  - `Shadow` 只允许在组合根启用旧执行 + 新事实镜像；不得拥有副作用、正式终态或用户报告。后续应把深层 `if mode` 上移为边界适配器，而不是继续散落在 Scheduler。
  - `Legacy` 只承担明确选择的应急回滚/旧记录读取；配置非法不得长期静默降级为 Legacy。生产构造缺 executor 应失败并暴露原因，不能换一套状态语义继续运行。
  - Legacy/Shadow 不再获得新 command、event、recovery 或 Main Agent 特性；修复仅限阻止其破坏迁移或保护已声明的兼容边界。
- 退出门槛：Durable 至少通过普通修改、失败后修复重测、NoChange、边界外故障、取消、暂停恢复和 Unknown 副作用 E2E；之后先删除 Scheduler 深层 Shadow 分支和 Shadow 产品开关，再把 Legacy 收缩为离线兼容/显式应急入口。未达到门槛前不声称三模式已经可以删除。
- 概念审查：本阶段没有新增 enum、command、event 或状态。相反，目标是把现有 mode 从业务层移回组合根，并最终删除两个迁移分支。它符合“新增概念必须减少旧职责”的门槛。
- 实际修改：仅追加本审查和施工边界；冻结架构基线未修改，产品代码未修改。
- 下一断点：先做一个不改变旧模式行为的收口切片——把 Scheduler 内重复的 mode 判断集中为“权威 Durable 或兼容执行”能力查询，并禁止阶段 F 的 Main Agent 合同依赖 `Legacy/Shadow`。随后单独处理非法配置静默回退；该行为改变启动语义，需要配套可见错误和构造入口核对。

## 2026-09-21 Main Agent 统一循环去除 `tool_action` 绑定

- 对应基线：阶段 F 应复用现有 provider/tool observation loop；Main Agent 是否持续行动、复核失败和提出完成，不能被某个历史意图名称决定，也不能再复制一套执行器。
- 修改前证据：`UnifiedExecutorOptions.tool_action` 是一个布尔开关，控制完成复核、失败复核、动作预算延长、Unknown 阻塞和最终文本校验。现有 `ReadOnly/Conversation/ToolAction/SimpleChange` 都走同一循环，但只有名为 ToolAction 的路径能启用这些通用主 Agent 能力。若直接接入 Change/Test，只能错误冒充 ToolAction 或再增加一组平行布尔。
- 实际修改：
  - 删除 `UnifiedExecutorOptions.tool_action`。
  - 让 options 保存已有的 `CodeProTaskKind`；统一由 `uses_main_agent_completion()` 从任务种类派生是否启用持续行动与完成复核。
  - 将专用 `codepro_tool_action()` 构造器替换为 `codepro_main_agent(task_kind)`；当前产品仍只用它构造 ToolAction，尚未切换 Change/Test。
  - action budget 直接按传入 task kind 选择，不再写死 ToolAction policy。
  - unified turn 持久化 intent 改由 task kind 生成，并补齐 `change/test` 的恢复解码，为后续同一循环承载 Coding 保留原始意图，不把继续执行误记成 ToolAction。
- 概念审查：
  1. 被错误复用的旧概念是 `tool_action` 布尔，它实际承载的是“开放式主 Agent 任务需要动作和完成复核”。
  2. 新规则服务工具操作、项目测试、缺陷修复和复杂修改，不依赖具体角色或工具名。
  3. 它删除了旧布尔、专用构造器和写死的预算类别，没有新增 command/event/持久化状态。
  4. 后续会由阶段 F 的 Main Agent decision/attempt 合同消费；不会扩散成 `change_action/test_action` 等平行开关。
- 明确未修改：执行路由仍保持原样；一般 Change/Test 仍走现有多 Agent 路径，SimpleChange 仍使用自己的单文件证据与终态。没有改变权限、工具清单、终态、DAG、Runtime mode 或用户可见报告。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 33.32 秒；仅剩 1 条此前已有的 `task_scheduler.rs` 局部 `unused_mut` warning。
- 未验证项：未运行单元测试、桌面构建或产品 E2E；本阶段只是共享循环的内部合同收口，不声称动态 Coding 已启用。
- 下一断点：把 Main Agent 所需的写入/命令 capability 与角色工具列表拆开，确认现有主 Agent 在工作区授权下能安全取得 edit + 聚焦 shell；然后为 Change/Test 建立受控切换，不先添加新的完成状态或 Planner 协议。

## 2026-09-21 工具权限作用域从 Agent 角色实例解绑

- 对应基线：阶段 G 要求能力来自当前 Action、用户授权与 workspace scope，而不是 `AgentRole`；阶段 F 又要求同一个 Main Agent 可在不同任务中取得不同的最小 capability。
- 修改前证据：`CodeProTaskScope` 只能存放在 `AgentConfig`。Worker 因为每个角色创建独立 Agent，能够取得 scope；共享 Main Agent 的一次 unified turn 却无法把自己的 scope 传到权限提示、拒绝审计、用户确认后的 dispatch 和权限缓存。若直接切换 Change/Test，只能让主 Agent 没有 guard，或伪装成 Coder。
- 实际修改：
  - `UnifiedExecutorOptions` 可携带既有 `CodeProTaskScope`，但没有新增 CapabilitySet、command、event 或持久化状态。
  - 工具调用上下文、自动批准、拒绝审计、用户确认与 scoped permission cache 均消费同一个 per-turn scope；未提供时仍兼容 AgentConfig 中的 Worker scope。
  - 已有 SimpleChange 作为首个真实消费者：宿主把当前工作区绑定为 read scope，把唯一目标文件绑定为 write scope，并使用现有 run identity。直接 `write/edit` 到其他文件会在统一 `CodeProWorkspaceWriteGuard` 失败。
  - validation shell 的自动允许条件改为“存在有效 task scope”，角色只保留 Tester 的只读失败处理差异；能力本身不再由 Coder/Tester 名称授予。
  - 用户选择 AlwaysAllow/AlwaysDeny 时，决定只缓存到本轮可信 task scope，不会因为 Main Agent 复用而泄漏到会话或其他任务。
- 概念审查：
  1. 被错误复用的是 `AgentConfig + AgentRole`，它同时承担 Agent 身份和单次动作授权。
  2. per-turn scope 服务 SimpleChange、普通修改、测试、恢复后的继续执行及将来的委派，不绑定某个夹具或角色。
  3. 它复用并贯通现有 `CodeProTaskScope`，替代“必须创建角色 Agent 才能获得 workspace guard”的隐式分支；没有增加平行权限系统。
  4. 后续由冻结计划中的宿主 CapabilitySet/Authorization Policy 统一生成该 scope；本切片只是把已有授权对象送达正确边界。
- 明确未修改：一般 Change/Test 仍走旧多 Agent 路由；没有扩大 SimpleChange 的唯一文件范围，没有改变外部写入、高风险工具、自然语言意图、完成权或 Runtime mode。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 31.44 秒；仅剩 1 条此前已有的 `task_scheduler.rs` 局部 `unused_mut` warning。
  - 针对 4 个相关 Rust 文件的 `git diff --check`：退出码 0；只有 Git 的 LF/CRLF 工作区提示。
- 未验证项：没有运行单元测试、桌面构建或产品 E2E；一般 Main Agent 路由尚未启用，所以不能据此声称动态 Coding 可用。
- 下一断点：不能直接把 Test/Change 指向 unified executor。当前 unified 完成检查仍只知道“至少一个成功工具”，非零测试退出码会被误当成没有证据，普通读取又可能被误当成足够完成修改。下一阶段先把模型的 `ProposeFinish` 与宿主的动作/工作区/验证事实分开，再接路由。

## 2026-09-21 完成检查停止解析用户自然语言工具名

- 对应基线：运行中的技术决策由 Main Agent 提出；宿主只消费结构化动作、授权、回执和证据。自然语言原文不能被下游字符串规则重新裁决为完成门槛。
- 修改前证据：`ToolTaskProgress::require_named_tools()` 扫描用户原文中的“调用 / call / use”和否定词，再把匹配到的工具名写成硬性完成条件。这既会漏掉自然表达和多语言变体，也会把提示词字符串变成第二套 Requirement Registry。与此同时，完成检查主要读取工具返回正文；已有宿主 `ToolAuditReceipt` 虽然为每次 dispatch 持久化授权、结果和 Unknown 类别，却没有进入该检查。
- 实际修改：
  - 删除 `require_named_tools()`、`required_tools`、`successful_tool_names` 及 unified loop 的调用；模型仍阅读用户目标决定是否调用工具，宿主不再通过关键词重判技术步骤。
  - 为已有可信审计元数据增加只读反序列化入口；`ToolTaskProgress` 优先读取由宿主放入 `__goose_tool_update_meta.toolAudit` 的 `ToolAuditReceipt`。
  - 审计结果为 `Ambiguous` 或 `ReplaySuppressed` 时进入既有 Unknown/不可盲重放门槛；审计结果不是 `Success` 时不能仅因工具正文看似成功而累计成功动作。工具自身结构化 postcondition 仍负责表达业务结果，两者不互相替代。
- 概念审查：没有新增 ledger、event、command、状态或结果枚举；复用已有 `ToolAuditReceipt/ToolAuditOutcome`，并删除自然语言硬门禁这一第二裁决者。工具审计是动作事实，未来由 ActionAttempt/Observation 投影消费，不新建平行动作记录。
- 明确未修改：没有把工具成功等同于用户任务完成；没有切换 Change/Test 路由，没有改变 Provider 工具协议、用户授权、Computer 业务回执、Convergence 或最终报告。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 24.23 秒；仅剩 1 条此前已有的 `task_scheduler.rs` 局部 `unused_mut` warning。
- 未验证项：未运行单元测试、桌面构建或产品 E2E；旧历史中没有 audit receipt 的工具响应仍按原兼容逻辑读取，不能据此证明所有存量会话已具备完整动作审计。
- 下一断点：把现有 `successful_tools` 单一计数拆成宿主可核对的动作事实投影，至少区分成功动作、失败但已观测的验证、工作区写入和 Unknown；该投影只提供事实，不能自行判断用户语义已交付。

## 2026-09-21 当前任务授权作用域贯通权限检查入口

- 对应基线：Capability/Authorization 必须由宿主依据当前动作、用户授权和 workspace scope 生成；权限检查、确认、执行和缓存只能消费同一份结构化事实。
- 修改前证据：上一阶段已把 per-turn `CodeProTaskScope` 送到最终 dispatch、workspace write guard、用户确认和 scoped permission cache，但 `ToolInspectionManager` 仍只读取 `PermissionInspector` 构造时保存的 Agent 级 scope。共享 Main Agent 因此可能在检查阶段被当作无 scope，在真正执行阶段又被 guard 当作有 scope，形成两种授权视图和不一致提示。
- 实际修改：
  - `ToolInspector::inspect` 与 `ToolInspectionManager::inspect_tools` 接受当前调用的只读 `CodeProTaskScope`；所有 inspector 共享同一调用上下文，但只有 permission inspector 解释授权语义。
  - `PermissionInspector` 以 per-turn scope 优先、AgentConfig scope 兼容兜底；scoped permission session、workspace write、validation shell 和缓存读取使用同一有效 scope。
  - Agent 在 inspection 入口传入与 dispatch、确认和缓存完全相同的 `codepro_permission_scope`。
- 概念审查：没有新增权限枚举、状态、事件或缓存；只是让已有 `CodeProTaskScope` 到达最早的授权检查边界，消除检查与执行之间的第二视图。Security、egress、adversary、repetition inspector 只接收上下文而不据此创造权限规则。
- 明确未修改：没有扩大任何 read/write scope，没有让 Planner 或模型签发权限，没有改变外部写入和高风险工具的审批底线，也没有启用一般 Change/Test 的 Main Agent 路由。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 38.20 秒；仅有 1 条此前已有的 `task_scheduler.rs` 局部 `unused_mut` warning。
- 未验证项：本阶段没有运行测试目标、桌面构建或产品 E2E；共享 Main Agent 尚未用于一般 Coding，因此这里只能确认静态接口与编译闭合。
- 下一断点：审查 `CompleteRun` 的完成要求来源。当前调用方仍可携带 `CompletionRequirements`，但在 Reviewer blocker、用户要求和高风险写入事实全部进入权威 Projection 之前，不能通过简单删除该参数来降低门槛；应先明确哪些事实由运行投影生成、哪些语义仅能由 Main Agent/Reviewer 提议。

## 2026-09-21 `CompleteRun` 硬门槛改由 Reducer 从 Projection 重建

- 对应基线：Main Agent/Reviewer 只能提出语义完成；Convergence 的事实门槛由宿主构造；Reducer 是唯一终态 writer。申请完成者不能选择 plan revision、证据覆盖范围或 evidence authority。
- 修改前证据：`ControlCommand::CompleteRun` 携带整份 `CompletionRequirements`，Reducer 直接交给 Convergence。虽然当前 Agent 通常使用 `for_dag()` 构造，但协议本身允许调用方传空 task coverage、其他 evidence authority 或缺失 revision，相当于申请者可选择验收范围。
- 实际修改：
  - 增加 `CompletionRequirements::host_derived()`：Reducer 收到完成提案后，以当前 `RunProjection` 重建任务集合、每任务证据覆盖、已提交 goal evidence 和固定 control-plane evidence authority。
  - 调用方暂时提供的 Reviewer blocker、高风险写入 blocker、Unknown effect 和未验证 requirement 只作为附加限制保留，不能覆盖或缩小投影事实。
  - 缺失 plan revision 与 revision 不匹配统一视为 stale，不能通过 `None` 绕过绑定。
  - effect ledger 仍在 runtime 边界把 `Claimed/Uncertain` 追加为 blocker；Reducer 随后与 Projection 一起构造最终门槛。
- 概念审查：没有新增 command、event、状态枚举或第二套完成系统；复用既有 `CompletionRequirements` 作为迁移载体，但改变其权力方向——外部对象是提案，Reducer 内部对象才是硬门槛。该切片减少调用方权力，未增加 Planner/Coordinator 责任。
- 明确未修改：Reviewer blocker、UserRequirement Registry 和 high-risk authorization 尚未全部进入 Projection，因此本阶段没有删除兼容提案字段；也没有让 Convergence 判断“用户委托语义上是否交付”，没有启用 planless Main Agent 的正式 Completed。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 18.49 秒；仅有 1 条此前已有的 `task_scheduler.rs` 局部 `unused_mut` warning。
- 未验证项：没有运行 control-plane 测试、桌面构建或 E2E；旧序列化字段仍为迁移兼容面，尚未完成正式 `ProposeFinish` 合同替换。
- 下一断点：不能直接删除兼容提案字段。下一阶段应把普通 Main Agent 的可信动作事实绑定到现有 run/task identity，并让 Context/Completion 读取同一 Observation；在此之前 Test/Change 不切换到 planless unified executor。

## 2026-09-21 Main Agent 动作事实绑定当前 run/task scope

- 对应基线：动作 Observation 必须绑定 operation/attempt 与当前授权版本；压缩或恢复后只能恢复属于当前任务的事实，不能从自然语言摘要或相邻任务借用成功记录。
- 修改前证据：`ToolAuditStore` 已把 `run_id + task_id` 计算为 `task_scope_digest` 并写入 started/completed journal，但注入工具响应的 `ToolAuditReceipt` 只暴露 `task_scoped: bool`。`ToolTaskProgress::from_history()` 会扫描当前 goal 后的全部回执，因此只能证明“某个任务范围内曾成功”，不能证明“属于本轮当前 scope”。
- 实际修改：
  - `ToolAuditReceipt` 携带 journal 中既有的可选 `task_scope_digest`；旧回执字段缺失时按未知处理，不从模型参数生成身份。
  - `MainAgentActionFacts` 保存当前宿主 `CodeProTaskScope` 的期望摘要，只接纳摘要完全一致的审计回执。无 scope 的 ToolAction 只接纳无 scope 回执；有 scope 的 Coding/Test 不接纳其他 task 或旧版仅有布尔标记的回执。
  - unified executor 从历史恢复动作事实时传入与 inspection/dispatch/guard 相同的 per-turn scope。
- 概念审查：没有新建 Action store、event 或身份协议；恢复既有 audit journal 已持久化但在 receipt 中丢失的关联键，并删除“布尔 scoped 即等价于当前 task”的宽松解释。未来 control-plane ActionAttempt 可直接引用同一 audit ID/scope digest，不需复制 ledger。
- 明确未修改：没有把 tool audit success 当作用户语义完成，没有改变工具业务 postcondition、权限或 evidence store；旧 scoped receipt 因缺摘要不会为新 Main Agent 完成提供证据，但仍保留在历史中供人工审计。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 17.13 秒；仅有 1 条此前已有的 `task_scheduler.rs` 局部 `unused_mut` warning。
- 未验证项：没有运行 audit/recovery 测试、桌面构建或 E2E；当前只是建立可信动作事实的身份边界，尚未把它提交为 control-plane task evidence。
- 下一断点：定义最小、非自然语言的 Main Agent decision 映射：工具请求是 `Act`，直接聊天是 `Respond`，工作任务无工具输出是 `ProposeFinish`；宿主核对 `ProposeFinish` 的 scope-bound Observation 后才能进入正式完成提案。不得把最终文案关键词解析成决策。

## 2026-09-21 删除报告自证与可选 Evidence Authority

- 对应基线：最终报告由已提交事实反向构造，不能先创建 `complete()` 覆盖率再证明自身完整；Completion 只有 control-plane evidence 一条正式权威链。
- 修改前证据：`FinalReportCoverage::complete()` 可在报告生成前预设四个 section 全部完成，但 Convergence 实际又不读取它，形成既误导又无约束力的循环证明字段。`CompletionEvidenceAuthority` 仍允许在 `ControlPlaneRefs` 与 `DagVerificationLedger` 之间选择，后者没有生产消费方，却保留了绕过正式 evidence 检查的协议分支。
- 实际修改：
  - 删除 `FinalReportCoverage`、`FinalReportSection` 及 `IncompleteFinalReport` blocker；报告继续由 `CodeProReportFacts` 根据已提交终态和证据生成，不进入完成资格输入。
  - 删除 `CompletionEvidenceAuthority` 及 `DagVerificationLedger` 分支；task coverage、每任务 evidence、跨 run evidence 和未提交 evidence 检查始终执行。
  - 更新现有 convergence 集成测试夹具，保留其真正的断言：Reviewer 放行不能替代执行 evidence，goal evidence 缺失仍阻止完成。
- 概念审查：本阶段只删除两个无权威或可误用的兼容概念及条件分支，没有新增协议。它让 `CompletionRequirements` 更接近 Reducer 内部硬门槛，而不是“可选择验收后端”的 DTO。
- 明确未修改：没有运行该集成测试，没有改变报告内容、Reviewer 策略、UserRequirement 语义或 planless 运行支持。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 1 分 26 秒；仅有 1 条此前已有的 `task_scheduler.rs` 局部 `unused_mut` warning。
- 未验证项：测试目标尚未编译执行，桌面与 E2E 未运行；移除字段对外部历史命令反序列化的兼容边界尚未做产品恢复验证，但 control command 不属于 event-store 权威事件。
- 下一断点：继续沿最小 decision 边界推进，但先核对当前 unified loop 的 response shape、question/delegate 工具与 final-output 机制，避免再造一套与 provider tool protocol 平行的 JSON 决策协议。

## 2026-09-21 `CompletionProposal` 与宿主硬门槛类型分离

- 对应基线：`ProposeFinish` 只是 Main Agent/Reviewer 的语义申请；宿主从 Projection、Evidence、Authorization 与风险事实构造 `CompletionRequirements`；Reducer 只在两者都成立时提交终态。
- 修改前证据：上一切片已在 Reducer 中重建硬门槛，但协议类型和字段名仍叫 `CompletionRequirements`。调用方、runtime 与 Reducer 因而在类型层仍共享同一可序列化 DTO，后续开发者仍可能把宿主字段重新塞回完成申请。
- 实际修改：
  - 新增精简 `CompletionProposal`，只携带 proposal 所绑定的 plan revision，以及尚未迁入权威 Projection 的兼容 blocker：Reviewer、高风险写入、Unknown effect、未验证 requirement。
  - `CompletionRequirements` 改为非序列化的宿主内部事实对象；它的 task coverage 与 goal evidence 只能由 `host_derived(projection, proposal)` 构造。
  - `ControlCommand::CompleteRun` 字段由 `requirements` 改为 `proposal`；Reducer 接收 proposal 后生成硬门槛，runtime 只向 proposal 追加 effect ledger 的 `Claimed/Uncertain` blocker。
  - Agent 终态路径先构造 proposal，再用当前 Projection 进行只读预评估；提交时只发送 proposal。Scheduler/ACP 夹具同步使用 proposal，不再创建可发送的完整 requirements。
- 概念审查：
  1. 被错误复用的旧概念是 `CompletionRequirements`，它同时代表申请者陈述和宿主硬门槛。
  2. `CompletionProposal` 服务 Main Agent、Reviewer、旧 DAG 兼容路径和未来人工验收，不绑定某个角色或夹具。
  3. 它从 `CompleteRun` 删除了调用方可发送的 evidence coverage/goal evidence，不是额外叠一层；完整 requirements 不再可序列化传入。
  4. 后续正式 `AgentDecision::ProposeFinish` 会直接承载该 proposal；兼容 blocker 迁入各自 owner 后，proposal 还会继续缩小，而不会扩散成第二套状态。
- 明确未修改：没有新增完成事件、终态或 Reviewer/Judge；没有让模型生成 evidence authority，也没有切换 Change/Test 路由。`CompletionProposal` 目前仍由旧 DAG 终态路径构造，属于迁移入口。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 1 分 23 秒；仅有 1 条此前已有的 `task_scheduler.rs` 局部 `unused_mut` warning。
- 未验证项：没有编译集成测试目标、桌面构建或 E2E；持久化旧 command JSON 不是 event store 的权威事实，但真实恢复兼容尚未验证。
- 下一断点：以 provider 已有结构作为 decision 载体：工具请求天然是 `Act`，问题/委派通过已注册工具能力表达，无工具的工作结果才进入 `ProposeFinish`。先在统一循环建立这个类型边界并复用现有 final-output/工具协议，不要求模型再输出一份巨型 JSON。

## 2026-09-21 主 Agent 模型选择与旧角色计划解绑

- 对应基线：Main Agent 持续拥有当前任务的技术决策；角色与 Planner 只在真实委派、独立验收或高风险复核时启用，不能成为共享主循环的隐式控制面。
- 修改前证据：统一执行入口在进入 Main Agent loop 前，会读取旧 `role_plan.roles.first()`，再通过 `ModelRouter` 解析并覆盖当前 provider。普通 ToolAction 的空角色列表通常掩盖了这一行为；高风险 SimpleChange 一旦带有 Planner/Coder/Tester/Reviewer 计划，共享主循环便可能仅因“需要审查”而被静默切换成 Planner 模型。角色计划因此同时承担了委派拓扑与主 Agent 模型选择两项职责。
- 实际修改：
  - 删除 UnifiedExecutor 与 SimpleChange 入口从首个角色解析并覆盖 provider 的分支；共享主循环继续使用当前会话已经选定并校验的 provider。
  - 删除仅服务该覆盖分支、现已无调用的 `with_prevalidated_provider()` builder；底层 options 仍保留显式 provider 字段，供真正需要预校验 provider 的既有命令执行/测试入口使用。
  - 真实 Worker/Delegate 路径仍可按角色调用现有 ModelRouter；本修改没有把 Planner、Tester 或 Reviewer 模型路由删除。
- 概念审查：
  1. 被错误复用的是旧 `role_plan`：它既描述“需要哪些角色”，又暗中决定“当前主循环由哪个模型接管”。
  2. 修正后的规则适用于 Conversation、ReadOnly、ToolAction、SimpleChange 以及未来的动态 Coding 主循环，不绑定某个 E2E 夹具。
  3. 本阶段删除一条 provider 覆盖分支和一个死 builder，没有新增 enum、command、event、模式或状态。
  4. 后续模型选择继续由会话 provider 与真实 Delegate/Worker 的 ModelRouter 两个既有边界承担，不建立第三套 selection protocol。
- 明确未修改：没有切换 Change/Test 路由，没有改变角色计划生成、Worker 模型选择、授权 scope、动作事实、完成语义、DAG 或 Runtime mode。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：第一次退出码 0，用时 31.76 秒，暴露出本阶段遗留的 dead-code warning 及同批控制面改动中的一个 `unused_mut`；删除死 builder 和无效 `mut` 后再次退出码 0，用时 26.98 秒，无 warning。
- 未验证项：未运行单元/集成测试、桌面构建或产品 E2E；当前只确认主 Agent 不再因旧角色列表静默换模型，尚未证明一般 Coding 已走动态主循环。
- 下一断点：在不增加巨型 `AgentDecision` JSON 的前提下，明确统一循环如何把 provider response 投影为宿主可消费的 `Act / Respond / ProposeFinish`。必须复用现有 tool request、question/delegate 工具与 final-output 边界，并让 `ProposeFinish` 引用 scope-bound action facts；在此之前不把一般 Change/Test 切到 unified executor。

## 2026-09-21 Plan task 与 Worker role 解耦

- 对应基线：PlanGraph 记录当前承诺的工作与依赖；Coder/Tester/Reviewer 是按需 Worker 策略，不是每个任务必须拥有的身份或安全边界。普通 Main Agent 根任务不能为了进入 Durable runtime 而伪装成某个旧角色。
- 修改前证据：`TaskCreated` 事件和 `TaskProjection` 已将 role 定义为 `Option<AgentRole>`，`register_worker()` 也只在任务声明 expected role 时校验；但上游 `PlannedTask.role` 仍强制为 `AgentRole`。这使计划协议无法表达“由当前 Main Agent 持续执行、暂不委派”的任务，逼迫宿主填写 Coder/Tester 等业务身份。
- 实际修改：
  - `PlannedTask.role` 改为可选并保持 serde 向后兼容；缺失 role 表示任务尚未绑定专用 Worker 策略，不表示绕过权限或没有 owner。
  - plan 安装把可选 role 原样提交到既有 `TaskCreated` 事件；同一 task 跨 revision 的 name/role 身份继续要求完全一致，不能通过修订静默换角色。
  - 旧 TaskDAG、Scheduler、ACP 和现有测试夹具的构造点全部显式使用 `Some(role)`，当前固定多角色路径的行为不变。
  - Worker 注册仍必须提供真实 `AgentRole`；role 为 `Some` 时继续执行精确匹配，role 为 `None` 时允许未来由正式 Delegate 动作选择 Worker，但不会由计划字段预先冒充主 Agent。
- 概念审查：
  1. 被错误复用的是 `AgentRole`：它同时表示真实 Worker 身份和“所有计划任务必须有一种旧角色”。
  2. 可选 role 服务 Main Agent 根任务、后续按需委派、人工任务和动态 replan，不绑定单个 E2E。
  3. 本阶段没有增加 MainAgent 伪角色、command、event 或状态；反而删除了计划层的强制角色假设，并复用 Projection 已存在的可选字段。
  4. 后续由真实 `RegisterWorker/Delegate` 绑定执行者；权限继续来自 Capability/TaskScope，而不是把 role 再扩张成权限系统。
- 明确未修改：尚未创建 Main Agent Durable run/task，未改变 Scheduler 的 Worker 启动、角色模型路由、权限、完成门槛或旧 DAG 路由。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：第一次因旧 Scheduler 一致性检查对已可选 role 重复包裹 `Some` 而退出码 1；改为直接比较 `Option<AgentRole>` 后，第二次退出码 0，用时 25.73 秒，无 warning。
- 未验证项：未运行协议/Reducer 集成测试、桌面构建或产品 E2E；serde 读取旧计划 JSON 的兼容性只由字段形态静态保证，尚未用历史记录恢复验证。
- 下一断点：让 Main Agent 使用现有 Durable run、单一无角色根任务和 scope-bound tool audit，而不是继续依赖 `codepro_unified_turn.v1` 作为第二套生命周期。接入前先审计 run 创建、task start、主 Agent outcome/evidence 提交与提问/取消恢复的最小闭环，不能把每次 provider turn 伪造成新 plan revision。

## 2026-09-21 Worker outcome 提升为通用 task outcome

- 对应基线：Main Agent 与按需 Worker 必须共享同一 RunProjection、Evidence 和终态链；WorkerRegistry 负责专用 Worker 的进程/claim 可靠性，但不能成为“任务结果只能来自旧角色 Agent”的业务限制。
- 修改前证据：ACP 已为每个 CodePro prompt 创建或恢复 Durable run；统一 Main Agent loop 却无法向控制面提交任务结果，因为唯一命令是 `SubmitWorkerOutcome`，Reducer 强制要求已注册的 `AgentId`。若把 Main Agent 注册成 Coder，会重新把执行身份、权限和业务角色混在一起；若为 unified turn 另建 lifecycle，则形成第二权威状态。
- 实际修改：
  - `SubmitWorkerOutcome` 收敛为 `SubmitTaskOutcome`，提交者 `agent_id` 可选；旧命令名保留 serde alias，只用于读取兼容，新序列化名称为通用 task outcome。
  - `WorkerOutcomeAccepted` 收敛为 `TaskOutcomeAccepted`，事件 envelope 与 payload 中的 `agent_id` 同步可选；Projection 对有提交者的结果继续验证 Worker scope/state，对无提交者的内联结果只更新同一个 task projection。
  - Reducer 只允许无提交者结果进入 `role=None` 的运行中任务；任何已绑定 Coder/Tester/Reviewer 的任务仍必须由已注册且作用域匹配的 Worker 提交。`NeedsHelp` 仍要求真实 Worker，因为其 AssistanceRequest 包含 worker identity；Main Agent 后续通过正式 replan/ask-user 决策表达该语义。
  - 现有 `OutcomeIngress` 仍先经过 WorkerRegistry 的 claim/suppression，再用 `Some(agent_id)` 提交通用命令；新增 runtime 内联提交入口直接使用同一 Reducer/事件/Projection，不复制注册表或状态机。
  - 旧测试与源码模式名同步到新协议；`WorkerOutcome` 数据类型暂时保留为迁移壳，本阶段不做纯命名扩大。
- 概念审查：
  1. 被错误复用的是 Worker registration：它既保证专用 Worker 结果只提交一次，又被当成“所有任务结果都必须来自角色 Worker”。
  2. 通用 task outcome 服务 Main Agent、专用 Worker、未来人工/宿主执行器，并统一进入相同 Reducer 和 Projection。
  3. 它替换并兼容旧 command/event，而非并列增加 `MainAgentOutcome`；没有新状态、ledger 或 convergence 分支。
  4. 后续可把仍叫 `WorkerOutcome` 的迁移类型重命名为 TaskOutcome；是否重命名取决于实际迁移收益，不为命名本身扩散改动。
- 明确未修改：尚未让 unified loop 安装/启动无角色根任务，也未提交 Main Agent evidence 或完成 run；Worker registry、重试、失败分类、取消和完成门槛保持原语义。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 30.94 秒，无 warning。
- 未验证项：未运行 command/event serde 兼容测试、Reducer/Projection 集成测试、桌面构建或产品 E2E；旧 event log alias 的真实恢复尚未验证。
- 下一断点：在 unified 主循环开始前，把 ACP 已创建的 run 安装为 revision 1 的单一 `role=None` 根任务并启动；结束时把 scope-bound tool audit 形成 evidence artifact/ref，先提交 task outcome，再由 `CompletionProposal` 请求终态。暂停、取消和 AskUser 必须提交对应 task/run 状态，不能只更新 `codepro_unified_turn.v1`。

## 2026-09-21 Task 启动、Worker 派发与 outcome 所有权闭环

- 对应基线：Plan task 与 Worker role 已解耦，但 Reducer 仍必须是任务生命周期和提交资格的唯一裁决者；Projection 只从已提交事件重放相同不变量，不能新增一份可写 owner 状态。
- 修改前证据：`StartTask` 把“任务进入 Running”与“派发 Worker”绑定为同一个无条件 effect，因此未来 `role=None` 主任务也会误触发旧 Scheduler。另一方面，`role=None` 任务注册真实 Worker 后，Reducer 和 Projection 仍允许 `agent_id=None` 的内联 outcome；Main Agent 因而可能抢先结束已委派任务。
- 当前执行所有者不变量：
  - `role=None`、任务 Running 且没有 Starting/Running/Idle/Stopping Worker 时，当前任务可由内联 Main Agent 提交。
  - 一旦为任务注册活动 Worker，该 Worker 是唯一 outcome 提交者；内联提交、其他 Worker 提交和第二个活动 Worker 注册全部拒绝。
  - `role=Some(...)` 表示预指定 Worker 策略，即使 Worker 尚未注册也不允许内联提交。
  - 所有权由 `TaskProjection.role + AgentProjection.task_id/state` 确定性派生，不新增 owner 字段、事件、ledger 或第二套生命周期。
- 实际修改：
  - `StartTask` 始终只提交 Ready/Paused/RepairPending 到 Running 的既有状态迁移；仅 `role=Some(...)` 的任务产生 `DispatchTask` effect。`role=None` 任务可在同一运行时内联执行，之后仍可通过既有 `RegisterWorker` 正式委派。
  - `register_worker()` 在 Reducer 中拒绝同一任务的第二个活动 Worker；Projection 重放 `AgentSpawned` 时同时验证任务处于 Running、预指定 role 匹配且不存在活动 owner。
  - `SubmitTaskOutcome` 在 Reducer 中要求 Worker 提交者等于当前活动 owner；内联提交要求任务未预指定 role 且无活动 Worker。Projection 重放 `TaskOutcomeAccepted` 时执行同一校验，异常历史不能绕过在线命令边界。
  - 聚焦回归集中写入现有 `codepro_worker_outcome_reducer.rs`：覆盖 `role=None` 未委派任务允许内联提交、注册 Worker 后拒绝内联提交、异常事件重放拒绝，以及 `StartTask` 只为 Worker-owned task 产生 dispatch effect。
- 概念审查：
  1. 被错误复用的是 `StartTask` 与 `role=None`：前者同时承担状态迁移和 Worker 派发，后者同时被解释成“未预指定角色”和“永远由 Main Agent 拥有”。
  2. 修正后的派生所有权适用于 Main Agent、动态 Delegate、专用 Coder/Tester/Reviewer、恢复和 Worker 替换，不绑定某个测试夹具。
  3. 本阶段没有新增 command/event/state；它从 `StartTask` 删除无条件 dispatch，并关闭 outcome 双提交者分支。
  4. 后续 Main Agent 根任务直接复用同一 Start/Register/Outcome 生命周期；ActionAttempt 落地时只补动作级 owner，不复制 task owner。
- 冻结基线收口：Reducer 仍是唯一迁移 writer；RunEngine/EventStore/Projection 职责未变化。所有权是 Projection 的派生查询，不是新的事实库；权限、CapabilitySet、write scope 和 completion 门槛均未扩大。普通 Coding 尚未切换路由，因此没有新增用户可见门禁或额外模型调用。
- 验证事实：
  - `cargo fmt --all`：通过。
  - `cargo check -p goose --lib`：退出码 0，用时 1 分 21 秒，无 warning。
  - 曾在用户收紧验证节奏前启动一个聚焦测试目标，随后立即中止，退出码 1；没有取得测试结果，不能作为通过或失败证据。
- 未验证项：上述四个聚焦回归已写入但按当前阶段要求未执行；没有运行全量测试、Clippy、桌面构建或 E2E。
- 兼容债务：结果数据类型仍名为 `WorkerOutcome`，只是命名迁移壳；是否重命名不影响当前 owner 不变量。`role=None` 任务从 Worker 崩溃/停止后重新进入 Running，必须经过既有恢复与 `StartTask`，此时才重新成为未绑定执行者的任务，不能靠旧 Worker 记录继续提交。
- 下一断点：再接 unified Main Agent 根任务时，必须按 `InstallPlan(role=None) -> StartTask(no dispatch) -> scope-bound evidence -> SubmitTaskOutcome(agent_id=None) -> CompletionProposal` 顺序接入；若中途 Delegate，先 `RegisterWorker`，后续内联 outcome 会由本阶段不变量拒绝。

## 2026-09-21 Unified Main Agent 根任务接入 Durable runtime

- 对应基线：普通 Main Agent 与按需 Worker 必须共享同一个 RunProjection、EvidenceRef、Reducer 和终态链；宿主只负责权限、事实提交和完成硬门槛，不能替模型规划技术步骤，也不能继续把 `codepro_unified_turn.v1` 当成任务生命周期权威。
- 修改前证据：ACP 已在 prompt 开始前创建 Durable run，统一 Main Agent loop 也已有 scope-bound `ToolAuditReceipt` 与结构化完成检查；但该 run 没有 PlanGraph/task，工具事实只影响会话本地 `ToolTaskProgress`，执行结束也不会提交 task outcome 或 `CompletionProposal`。因此 UI 可结束一次回复，而权威 Projection 仍停在 Planning/Running。
- 实际修改：
  - Durable 模式下，现有 unified Main Agent 入口把 ACP 已创建的 run 安装为 revision 1、单个 `role=None` 的 `main-agent` 根任务并执行 `StartTask`。若 run 已有不同计划、根任务已绑定 Worker、角色不为空或状态不可恢复，则关闭执行，不覆盖既有权威事实。
  - 根任务使用与工具 inspection、permission 和 audit 相同的 `CodeProTaskScope`，scope 只覆盖当前已授权工作区；它不授予新权限，也不能越过 PermissionManager、工具策略或工作区绑定。`run_id + task_id` 摘要继续作为审计回执归属键。
  - `ToolTaskProgress` 新增确定性的 `completion_evidence_satisfied(task_kind)`：ToolAction 需要成功工具回执，Test 需要带退出码的验证回执，BugFix/ComplexChange 需要成功工作区写入或验证回执；完成资格不解析最终自然语言。相同判断同时驱动用户文案保护和 durable outcome，避免两套规则漂移。
  - scope-bound audit facts 被序列化为 `MainAgentTaskEvidenceBundleV1` 并写入既有 CodePro artifact/event log；artifact 只引用真实 audit ID、scope digest、成功写入/验证集合和 Unknown 数量，不把模型摘要当作工具成功证明。生成的 `EvidenceRef` 随 `SubmitTaskOutcome(agent_id=None)` 进入同一 TaskProjection。
  - task 成功后以当前 Projection 构造最小 `CompletionProposal` 并交给既有 Reducer/Convergence；证据缺失、动作结果未知、无最终响应或预算边界会提交 Paused task/run，不会伪装 Completed；取消使用既有 Cancelled outcome 与 `CancelRun`。
  - 显式“不要使用工具”会把语义降为 Conversation/Respond，但仍收口已创建的同一个 durable 根任务；它不要求伪造工具动作，也不会遗留无人管理的 Planning run。
  - 在既有 `codepro_worker_outcome_reducer.rs` 增补“第二个活动 Worker 注册被拒绝”回归，与上一阶段四个 owner 场景一起等待统一执行。
- 概念审查：
  1. 被错误复用的是 `codepro_unified_turn.v1` 和最终文字：前者承担会话继续但不能证明 task 生命周期，后者不能证明动作成功。
  2. `MainAgentControlTask` 只是现有 run/task ID 的进程内绑定；`MainAgentActionEvidenceV1` 只是已提交 tool audit facts 的 artifact DTO。两者适用于 ToolAction、未来 BugFix/Test 根任务和恢复，不是某个 E2E 的分支。
  3. 本阶段没有新增 command、event、run/task state、owner store、权限来源或完成引擎；它接通并消费此前已经存在但彼此断开的 Start/Outcome/Evidence/Complete 链。
  4. 后续正式 `AgentDecision::Act/Respond/Delegate/ProposeFinish` 只需要引用该 task 和 evidence；当前 DTO 不应扩张成第二套决策协议。
- 冻结基线收口：Reducer 仍是任务/run 状态唯一裁决者；RunEngine 提交、EventStore 持久化、Projection 派生、ToolAudit 记录动作事实、artifact log 生成 EvidenceRef、Convergence 校验完成门槛。PlanGraph 只声明一个根任务，不拥有 Capability；scope 由宿主基于既有会话工作区授权生成。没有扩大工作区、shell、网络或外部副作用授权，也没有增加 Planner/Tester/Reviewer 模型调用或普通 Coding 的语义门禁。
- 验证事实：
  - `cargo fmt --all`：最终通过。
  - 第一次 `cargo check -p goose --lib`：退出码 0，用时 1 分 53 秒；仅报告一个只在单元测试使用的旧查询方法 dead-code warning。
  - 将该方法明确限制为 `cfg(test)` 后，最终 `cargo check -p goose --lib`：退出码 0，用时 16.84 秒，无 warning。
- 未验证项：按当前阶段约定没有执行任何单元/集成测试、Clippy、桌面构建或 E2E；新增及上一阶段聚焦测试均未运行。当前只证明代码静态闭环并通过库级编译，不能宣称产品动态 Main Agent 已可用。
- 兼容债务：当前只把已经走 unified executor 的 Main Agent 路径接入根任务；一般 Change/Test 仍走旧 DAG，尚未切换。Main Agent evidence bundle 引用 tool audit ID/scope digest，但真实恢复与跨进程 artifact/receipt 对照仍需 E2E。用户可见 TurnTerminal 报告与新的根任务 Completed projection 还需在后续 ACP/UI 阶段统一，不能再造第二终态。
- 下一断点：把 provider 现有响应边界正式投影为最小 `Respond / Act / Delegate / ProposeFinish` 决策：工具请求继续天然表示 Act；无工具响应只在当前 task evidence 满足时表示 ProposeFinish；Delegate 必须先走 `RegisterWorker` 并停用内联 outcome。完成该切片后，再统一运行 `codepro_worker_outcome_reducer` 聚焦测试目标。

### 本阶段收口修正：证据提交不再冒充任务完成

- 收口审查发现：`commit_task_evidence()` 与新接入的 `commit_main_agent_task_evidence()` 都把 artifact 写入记录标成任务生命周期事件；旧活动日志迁移会把 `TaskCompleted` 确定性转换为控制面 `TaskSucceeded`。证据保存因而可能在恢复时成为第二个任务终态写者。
- 新增稳定事实类型 `EvidenceCommitted`，并让两类 task evidence artifact 统一使用它。旧迁移只把它投影为非生命周期的 `LegacyActivityObserved`；真正的任务成功仍只能由 `SubmitTaskOutcome -> Reducer -> TaskOutcomeAccepted` 写入。
- 这个类型不是针对单一 E2E 的分支：它区分了“证据 artifact 已持久化”和“任务生命周期已完成”两种长期存在的事实，并替换两处错误复用。没有新增 command、task/run state、store、owner 或完成路径。
- 聚焦回归写入既有 `codepro_event_migration.rs`，验证证据提交只迁移为观察事实；按本阶段约定暂未执行。
- 收口验证：首次 `cargo check -p goose --lib` 暴露 ACP 展示阶段的穷举缺口；将 `EvidenceCommitted` 映射为非权威的 Completing 展示阶段后，`cargo fmt --all` 退出码 0，最终 `cargo check -p goose --lib` 退出码 0，用时 25.33 秒，无 warning。

## 2026-09-21 Main Agent 权限、历史证据与旧 unified 状态收口

- 对应基线：权限必须来自用户授权、系统策略和当前任务合同；Evidence 只证明实际发生的动作；Reducer 是 Durable task/run 终态唯一裁决者。兼容记录可以辅助恢复和界面展示，但不能反向覆盖 Durable 终态。
- 修改前证据：
  - unified Main Agent 根任务在没有既有 scope 时自动获得 `read_scope=["**"]` 与 `write_scope=["**"]`；PermissionInspector 又会把任何带 task scope 的 workspace write 或 shell 默认提升为 `AlwaysAllow`，将“进入根任务”扩大成“整个工作区可写”。
  - 新 evidence 已改用 `EvidenceCommitted`，但历史 artifact 仍可能保存为 `TaskCompleted`；通用迁移会把它转换成 `TaskSucceeded`。
  - `completion_evidence_satisfied()` 对 ToolAction 只要求至少一次成功工具调用且没有 Unknown/未核实发送，名称和阶段报告容易误解为已经覆盖完整用户目标。
  - `codepro_unified_turn.v1` 在 Durable 根任务完成前后分别写入 finished/paused；兼容写入失败可能阻止 Durable outcome/finalization，或在 Durable 已完成后让整轮返回错误。
- 实际修改：
  - Main Agent 无显式合同 scope 时默认保留工作区读取，`write_scope` 为空；SimpleChange 等已有明确目标路径的入口继续使用其窄化 write scope，不扩大既有授权。
  - PermissionInspector 只对非空的宿主委派 write scope 自动放行 workspace write；shell 只有在任务具备非空委派 write scope，或命令与宿主绑定的 validation command 完全一致时才可免二次确认。仅有只读 scope 不再让任意 shell/workspace write 获得 `AlwaysAllow`。
  - 历史迁移在兼容边界按宿主生成的 `.task-evidence.txt` / `.main-agent-task-evidence.txt` 文件名约定保守识别旧 artifact；若旧记录类型为 `TaskCompleted`，迁移为 `EvidenceCommitted` 观察事实，并输出 `LegacyTaskEvidenceDemoted` 审计 warning。旧记录没有独立 artifact-kind 字段，因此这不是读取完整版本化 schema；匹配只用于降级、防止误报成功，不解析用户文本、模型文本或任务语义。
  - 完成证据方法更名为 `minimum_completion_evidence_satisfied()`。当前保证被限定为：零成功证据、已知 Unknown、未核实发送以及缺失任务类型所需的最低写入/验证观察时不能完成；它不证明用户要求已经逐项覆盖。结构化目标覆盖属于后续 `ProposeFinish`/Convergence 切片。
  - 删除 action budget 边界处对旧 unified turn 的提前 finish。Durable 根任务先由 outcome/Reducer 完成或暂停；之后旧 unified 状态只做兼容索引更新，失败记录 warning，不得反向否决已提交的 Durable 事实。非 Durable 旧路径暂时保留原错误语义。
- 兼容定位与退役路线：`codepro_unified_turn.v1` 当前仍保存旧会话的原始目标、intent、暂停/继续索引和 Computer Use 操作方式，因此还不是纯只读 UI cache。迁移期间它只能作为 active compatibility index；任务生命周期与终态冲突时以 Durable Projection 为准。后续应把目标/约束/能力方式迁入正式 requirement/capability projection，并让继续执行从 Durable run/revision 重建；完成真实旧会话恢复验证后停止写入该扩展状态。本阶段没有另建 replacement store。
- 外部架构对照：OpenAI Agents SDK 把模型编排与每次工具调用的 guardrail 分开；Claude Code 公开安全设计以只读为默认，编辑和命令执行需要额外权限；LangGraph 建议持久状态保存不可重建的原始事实，派生信息按需计算。本阶段采用动作边界的确定性授权、单一 Durable 终态和兼容投影；未照搬框架角色或新增工作流类型。
- 验证事实：
  - `cargo fmt --all`：最终退出码 0。
  - `cargo check -p goose --lib`：退出码 0，用时 43.53 秒。
  - `cargo test -p goose --test codepro_worker_outcome_reducer --test codepro_event_migration`：第一次因新增回放夹具借用后移动同一 `TaskId` 而未进入断言；只修正测试 `clone` 后原命令退出码 0。事件迁移 7/7、Worker outcome/启动派发/所有权 12/12 通过。
  - `cargo test -p goose --lib permission_inspector::tests::`：第一次暴露旧 Scheduler 单元断言未适配 `Option<AgentRole>`，未进入权限断言；修正两条测试预期后原命令退出码 0，用时 4 分 31 秒，权限组 45/45 通过，3284 项被过滤。
- 事实 owner 收口：CapabilitySet/task scope 仍由宿主根据现有授权与合同生成；PermissionInspector 只裁决当前工具动作是否可执行；ToolAudit/Evidence artifact 记录真实回执；Reducer 写 task/run 状态；EventStore 追加保存；Projection 只重放。没有新增第二状态库、第二终态 writer 或由自然语言触发的权限规则。
- 明确未完成：尚未实现结构化 `Respond / Act / Delegate / Replan / ProposeFinish` 决策循环，尚未登记并逐项核对用户要求，也未把普通 Coding 主路径迁入 Durable Main Agent。未运行全量测试、Clippy、桌面构建或产品 E2E。
- 下一断点：底层事件名和状态名到此停止继续打磨。下一阶段进入最小动态决策循环，优先建立 `ProposeFinish` 的要求覆盖与真实 evidence 引用，再接 `Act/Respond`；`Delegate` 复用已经通过聚焦测试的 task owner 不变量。除 E2E 证明核心不变量错误外，不再为旧固定 DAG 样例新增特殊命令、状态或字符串规则。

### 权限边界复审修正：write scope 不再授权无路径守卫的工具

- 复审证据：上一版只检查 `write_scope` 是否非空，随后把所有 `WorkspaceWrite` 工具提升为 `AlwaysAllow`；但 `CodeProWorkspaceWriteGuard` 当前只对 developer `write/edit/shell` 生效。Git 等 WorkspaceWrite 工具没有把参数与该 task write scope 做同一层校验，因此可以借用无关文件的授权免审批。
- 修正后的不变量：
  - developer `write/edit` 只有在 task write scope 非空时可免二次审批；真实执行仍由参数级 `CodeProWorkspaceWriteGuard` 校验目标路径。
  - shell 只有在命令与宿主绑定的 validation command 完全一致时可免二次审批；非空 write scope 本身不再放行 shell。
  - 其他 `WorkspaceWrite` 工具继续要求审批，直到各自具备并接入参数级 scope validator。Permission class 只描述风险类别，不能替代资源授权。
- 聚焦回归：授权范围只有 `app.js` 时，`developer__write(path=app.js)` 仍为 Allow，而 `git__git_stage(paths=[other.txt])` 为 RequireApproval；这同时防止“修漏洞时把合法窄范围写入全部禁用”的假修复。
- 验证事实：`cargo fmt --all` 退出码 0；`cargo check -p goose --lib` 退出码 0，用时 18.06 秒；`cargo test -p goose --lib permission_inspector::tests::` 退出码 0，用时 1 分 48 秒，权限组 46/46 通过，3284 项被过滤。
- 收口结论：本修正没有增加权限类型、状态、事件或自然语言规则，只删除了“任意非空 write scope 等价于全部 WorkspaceWrite 授权”的错误推导。底层权限切片到此封板；后续新增可自动执行的写工具，必须先提供与其参数模型匹配的 scope validator。

## 2026-09-21 Durable Main Agent `ProposeFinish + UserRequirement + EvidenceRef` 闭环

- 对应基线：模型只能提出“当前用户委托已完成”；宿主必须核对权威要求来源、真实 EvidenceRef、run/task 归属、逐项覆盖和未知副作用；Reducer 是 task/run 终态的唯一写入者。当前切片只覆盖已经接入 Durable runtime 的 unified Main Agent 根任务，不迁移普通 Change/Test。
- 修改前证据：Main Agent 结束回复时先用 `SubmitTaskOutcome(Succeeded)` 把根任务写成终态，再调用 `CompleteRun`。如果 Convergence 随后拒绝完成，根任务已经不可继续，模型也拿不到结构化缺口。这使“提议完成”和“提交完成”不是一个原子状态迁移。
- 权威 requirement 边界：
  - 当前根任务只把既有 `RunProjection.goal` 视为一个版本内权威要求，稳定 ID 为 `run-goal`；没有从模型文本、Planner 输出或报告文案重新抽取第二份要求。
  - `CompletionProposal` 只携带模型提出的完成 task 和 `requirement -> EvidenceRef[]` 覆盖关系；宿主根据当前 Projection 构造完成要求，并拒绝空目标、未知 requirement、缺失 EvidenceRef、跨 run 引用、未提交到当前 task result 的引用和旧 plan revision。
  - 该单项 requirement 是当前切片的明确限制，不等价于已实现多条用户要求的独立版本化登记；普通 Change/Test 仍沿用旧路径。
- 实际修改：
  - `CompleteRun` 对 Main Agent 根任务先在内存中的 prospective Projection 里复用既有 `SubmitTaskOutcome` 规则生成 task 成功事实，再执行 Convergence；只有通过时，task outcome、`TaskSucceeded` 与 `RunCompleted` 才在同一个 Reduction 中提交。验收失败不产生任何终态事件，根任务保持 Running。
  - `RunCompleted` 在既有 event stream 中持久化已接受的 requirement/evidence 覆盖关系，`RunProjection` 只从该事件重放派生视图；没有新 store 或可写 completion 状态。
  - Main Agent 的无工具最终响应在已有最低工具证据检查和 pending user steer 处理之后形成完成提案。宿主先通过既有 CodePro EventLog 核对 EvidenceCommitted 事件、run/task、artifact ref 和 artifact 文件，再调用 atomic `CompleteRun`。
  - 验收失败通过 typed `CompletionBlocked(Vec<ConvergenceBlocker>)` 返回；每个 blocker 被转换为具体缺口观察并送回同一个 Main Agent loop。原完成文案不会展示，模型可继续使用工具、委派或报告阻塞；宿主不替模型选择业务动作。
  - stop hook 在终态提交前执行，避免 run 已 Completed 后又因 hook 拒绝而向用户报告失败。
- 事实 owner 收口：
  - 用户目标来源：现有 RunProjection goal；本切片没有新增 requirement registry。
  - 动作事实与 artifact：现有 ToolAudit、CodePro EventLog 和 EvidenceRef；新增的 `verify_task_evidence` 只是读取并核验既有记录，不写第二份证据。
  - 语义完成提议：当前 Main Agent 最终响应。
  - 完成硬门槛：现有 ConvergenceEngine，只消费结构化 projection/proposal/evidence。
  - task/run 正式终态：Reducer 唯一提交；EventStore 追加保存，Projection 只重放。
- 概念审查：本阶段新增的是 requirement 与既有 evidence 的覆盖关系，不是新生命周期。它消除了“先把 task 标成成功、再问能否完成”的错误顺序，并把已接受覆盖关系写回现有 `RunCompleted` 事实。没有新增强制 Judge、第二完成引擎、第二 Evidence Store、自然语言关键词裁决或普通 Coding 门禁。
- 聚焦回归：在既有 `codepro_worker_outcome_reducer.rs` 覆盖原子完成、空 evidence 拒绝且 task 保持 Running、非权威 requirement 拒绝、跨 run evidence 在协议边界拒绝；同时继续覆盖 Start/Dispatch/outcome ownership 相邻不变量。
- 验证事实：
  - `cargo fmt --all`：阶段开发时已通过；本记录追加后再次执行最终格式化。
  - `cargo check -p goose --lib`：退出码 0，用时 35.99 秒。
  - 首次集中命令 `cargo test -p goose --test codepro_worker_outcome_reducer --test codepro_convergence --test codepro_control_reducer --test codepro_protocol_contract --test codepro_event_migration` 在未加载 Visual Studio 环境时退出码 1，链接器找不到 Windows SDK `ucrt.lib`，没有进入测试断言。SDK 文件实际存在，随后使用官方 `VsDevCmd.bat` 初始化同一工具链环境。
  - 初始化工具链后，同一集中命令成功编译并进入测试，但在 `codepro_control_reducer` 的 5 条旧断言处退出码 1：1 条仍假定没有 CompletionProposal 也能进入旧 completion-blocked 分支，4 条构造的 Projection 没有当前 TaskGraph，却期待 StartTask/恢复成功。它们与本切片前已存在的“完成提案必需、拓扑缺失 fail-close”语义不一致，未为通过本切片而改写。
  - `cargo test -p goose --test codepro_worker_outcome_reducer`：退出码 0，16/16 通过，直接覆盖本切片与相邻所有权切片。
  - `cargo test -p goose --test codepro_convergence --test codepro_protocol_contract --test codepro_event_migration` 在 `codepro_convergence` 的 2 条旧断言处退出码 1：夹具声明 goal evidence 为 `goal`，task result 仅提交 `test`，而现有 Convergence 已要求 goal evidence 必须真实提交。未改写旧断言。
  - `cargo test -p goose --test codepro_protocol_contract --test codepro_event_migration`：退出码 0；协议 7/7、迁移 7/7 通过。
- 证据边界：当前证据证明最新代码可编译、原子 finish/ownership 聚焦回归通过、协议与迁移兼容回归通过；两组旧测试债务被真实暴露且未掩盖。尚未运行 Clippy、桌面构建或产品 E2E，不能宣称用户可见动态决策循环已经验收。
- 兼容债务与下一断点：当前只登记整条 run goal，尚不能逐条表达“修改文件、不改测试、解释根因”等多要求及其撤回/替代。下一阶段若继续扩展要求模型，必须先把既有用户目标/约束的正式 owner 和版本提交入口闭合，不能从 Planner/DAG 反推或另建并行 requirement store；在此之前先做当前 Durable 根任务的真实 E2E，验证拒绝完成后模型确实继续 Act/Delegate/报告阻塞。

## 2026-09-21 Main Agent 失败终止与运行诊断同步收口

- 对应基线：运行事实必须随状态迁移提交，诊断日志只能描述已经提交或明确被拒绝的命令；实施记录只是开发账本，不能证明产品状态。当前切片只收 Durable Main Agent 根任务的预算/重复失败暂停和用户取消，不扩展验证分类、普通 Change/Test 或 Worker 交接。
- 修改前证据：
  - action budget 耗尽、重复工具失败和最大轮次分支已经向用户输出“已暂停”，但没有保存明确的 `terminal_pause_reason`。末尾又根据最低证据和最终文字推算是否暂停；一旦已有最低证据，可能得到 `pause_reason=None`，随后既不能 `CompleteRun`，也不能正式暂停，根 task/run 留在 Running。
  - Main Agent 暂停/取消先提交 `SubmitTaskOutcome(Paused/Cancelled)`，再单独提交 `PauseRun/CancelRun`。第二次提交失败时会留下 task 与 run 半状态。`CancelRun` 原本已经能在单个 Reduction 中取消全部非终态 task，因此前置 outcome 是重复 writer；`PauseRun` 原本只暂停 run，不处理未委派的内联 Running task。
  - runtime 已记录 command 的加载、reduction 和 append 阶段，但缺少 session ID、完成提案的 task/requirement/evidence IDs、Reducer 拒绝原因，以及提交后 task/run 状态的关联字段。
- 实际修改：
  - action budget 边界在产生用户文案前保存结构化的内部原因代码：`repeated_tool_failure`、`action_budget_exhausted`、`maximum_turns_exceeded` 或 `action_budget_boundary`。最终收口优先消费该明确决定，不再靠“是否已有最低证据”覆盖它。
  - Main Agent 取消直接调用既有 `CancelRun`；Reducer 在同一个 Reduction 中产生 task Cancelled 与 RunCancelled，删除前置 `SubmitTaskOutcome` 两步链。
  - `PauseRun` 复用现有命令和事件，在同一个 Reduction 中先把没有活动 Worker 的 Running task 转为 Paused，再提交 RunPaused。已委派 Worker 的停止/检查点语义保持原状，避免当前切片擅自改变 Worker 协议；当前 role=None 根任务因此获得原子 task/run 暂停。
  - runtime command 边界补充必要诊断字段：`session_id`、`run_id`、完成提案 `task_id`、command、requirement IDs、evidence event IDs、expected/actual sequence、已提交 task IDs、事件序列范围、EvidenceRef 数量与最终 run state。Reducer/协议/存储拒绝在 append 前记录 rejection；成功日志只在 event store append receipt 校验后产生。
  - 日志不记录用户目标、工具参数、artifact 内容或原始暂停文本。当前 control-plane 尚没有统一的 action/attempt identity，因而没有伪造字段；工具动作继续以现有 ToolAudit `audit_id`/request identity 持久化，后续 ActionAttempt 落地时再通过正式引用串联。
- 权威事实与日志顺序：Reducer 仍是状态迁移唯一裁决者；RunEngine 先校验、preview 并原子 append 事件；runtime 只根据 `CommandReceipt` 输出 committed 诊断。RunPaused/RunCancelled 事件中的原因和 task 状态是恢复依据，diagnostic log 不是恢复输入，实施记录也不被运行时读取。
- 聚焦回归：在既有 `codepro_worker_outcome_reducer.rs` 增加 `PauseRun` 同批产生内联 task Paused 与 RunPaused 的断言；相邻的 finish、ownership、retry/cancel 语义继续由同一测试目标保护。
- 验证事实：
  - `cargo fmt --all`：退出码 0。
  - `cargo check -p goose --lib`：退出码 0，用时 2 分 38 秒；首次产生 1 条已删除导入的 warning，删除不再使用的 `CancellationReport/Checkpoint/WorkerOutcome` 后，后续测试重新编译最新 lib 时无该 warning。
  - 第一次聚焦测试命令因 PowerShell 错误解析 Visual Studio 路径中的 `(x86)` 而退出码 1，未进入 Cargo 或测试断言。
  - 使用官方 `VsDevCmd.bat` 初始化工具链后执行 `cargo test -p goose --test codepro_worker_outcome_reducer`：退出码 0，用时 4 分 08 秒，17/17 通过。
- 证据边界：本阶段证明明确预算终止原因不会在末尾丢失、当前内联根任务的暂停与 run 暂停同批提交、取消不再两步提交，并且 control command 成功/拒绝日志遵循 event commit 顺序。尚未做桌面 E2E，未验证 UI 是否正确展示暂停原因或重启后是否从该 task 继续。
- 未完成但未掩盖：
  - 当前只保证 ToolAudit 记录“验证命令运行过及真实退出码”；尚未实现 validation evidence 对某条 UserRequirement 的 `satisfied/failed/unrelated` 语义绑定。不能把本阶段解释为“失败测试已经不会冒充目标满足”。
  - 已委派 Worker 的 PauseRun 仍只暂停调度，不在本切片中改写 Worker checkpoint/stop 协议。
  - `session -> run -> task -> attempt -> action` 的完整查询链尚缺正式 ActionAttempt；当前能可靠串联 session/run/task/control event 与 ToolAudit action，但 attempt 不能靠日志文本补造。

## 2026-09-21 默认 Coding 动态主链与 E2E 诊断切片

- 对应冻结基线：普通 Coding 默认由 Main Agent 读取真实 Observation 后持续 `Act/Delegate/ProposeFinish`；DAG 只在真实委派时表达已承诺工作；用户要求、PlanGraph、RunProjection、Evidence/Event Store 与 Authorization 分别维持原 owner。未修改冻结的 Final Plan 或事实权威表。
- 默认入口迁移：Durable 模式下的 `SimpleChange`、`Test` 和 `Change` 不再进入旧 `multi_agent_reply`/首次 Planner 固定流水线，而是复用已经接入 control plane 的 unified Main Agent loop。Legacy/Shadow 的旧路径保留为迁移兼容；没有新增第四种运行模式。
- 用户要求来源：ACP 在创建 prompt run 时把真实 source user message ID 与一个稳定 `run-goal` requirement 作为 revision 1 提交。Reducer 校验连续 revision 并产生 `UserRequirementsCommitted`；EventStore 追加，Projection 重放。Main Agent/Planner、报告和 UI 都不能直接写 requirement revision。当前仍是“整条用户目标一个 requirement”，尚未实现子要求的独立撤回/替代状态。
- 完成收敛：`CompletionProposal::for_main_agent` 从当前 Projection 的 requirement 集合生成 coverage；宿主要求引用当前 run、当前 completion task 已提交的 EvidenceRef，并要求当前 PlanGraph 中每个任务都有 evidence。缺失、伪造、跨 run、旧 plan revision 或 Unknown 副作用继续 fail closed；Reducer 仍是 task/run 正式终态唯一 writer。
- NoChange/边界诊断与写后失败：对于 change 类任务，无 workspace write 但存在真实 validation observation 时，Main Agent 可以提出“NoChange 或边界诊断已交付”，即使项目测试仍失败；一旦发生 workspace write，已有 validation 的最新结果必须通过，否则不能完成修复。该规则只消费 ToolAudit 的写入类别和真实退出码，不解析自然语言；失败与用户目标是否相关仍由 Main Agent 的语义完成提议负责，当前没有新增强制 Judge。
- 顺序委派：同步 `summon` 在 Durable scoped Main Agent 下把子任务安装为同一 PlanGraph 的新 revision，复用 `StartTask -> RegisterWorker -> SubmitTaskOutcome` 与现有 Worker owner 不变量。异步委派暂时拒绝，避免多个 event-log handle 并发写入和未知 owner；成功/失败都提交结构化 outcome，根任务完成前要求委派 task evidence 已进入同一 Projection。拓扑真实变化才增加 plan revision。
- 权限边界：只有宿主已识别的单文件 SimpleChange 会从现有目标绑定窄化 write scope；一般 Change/Test 默认不制造 `write_scope=["**"]`，写动作仍经 PermissionInspector/工具参数 guard/用户审批。委派不能扩大父任务授权。
- 运行诊断：ACP 诊断包新增 Durable run binding、source message、requirement projection、task/worker/evidence、recent events、effects/recovery 和完整 event ledger 的路径/字节数；会话导出额外生成脱敏 ToolAudit 索引。ActivityEvent 没有正式 attempt identity 时，公共进度的 `attempt_id` 留空，不再用 event ID 冒充。诊断数据只读取权威账本，不成为恢复或完成输入。
- 聚焦回归修正：旧 reducer/convergence 夹具仍假设 role=None 自动派 Worker、缺失 PlanGraph 也能启动、未提交的 goal evidence 可验收；夹具现已显式声明 V2 PlanGraph/Worker role，并要求 goal evidence 属于 task result。没有为通过测试放宽生产状态机。
- 验证事实：
  - `cargo fmt --all`：退出码 0。
  - `cargo check -p goose --lib`：本切片开发中退出码 0，用时 17.54 秒；后续最终收口将再执行一次。
  - 聚焦测试最终结果：`codepro_control_reducer` 12/12、`codepro_convergence` 5/5、`codepro_worker_outcome_reducer` 17/17、`codepro_cancellation_reducer` 6/6、`codepro_protocol_contract` 7/7，通过 47 项、失败 0。首次集中运行真实暴露 5 条 control reducer 与 2 条 convergence 旧夹具不符合新不变量；修正夹具后原范围通过。
  - `cargo test -p goose --lib change_completion_distinguishes_diagnosis_from_a_failed_post_write_validation`：退出码 0，用时 5 分 09 秒，1/1 通过，3330 项被过滤；随后 `cargo check -p goose --lib` 退出码 0，用时 17.70 秒。
  - 新增 D01 顺序委派夹具位于 `C:\test\test_0921\codepro-dynamic-runtime-e2e\D01-delegate`；直接运行 `npm.cmd test` 真实观察到 1 项失败、0 项通过，符合预置缺陷。
- E2E 清单：`docs/superpowers/reports/2026-09-21-codepro-dynamic-runtime-e2e-checklist.zh-CN.md`。本记录只证明源码和聚焦门禁，不证明桌面产品链已通过；Electron 拉起后由用户在真实窗口执行 M02/N01/N03/D01 与取消/恢复、诊断导出场景。
- 与冻结基线的当前差异：
  - 没有另建完整 `AgentDecision` enum；当前 `Respond/Act/AskUser` 仍由既有模型响应/工具调用循环表达，`Delegate` 与 `ProposeFinish` 已进入结构化宿主边界。若 E2E 证明隐式决定无法可靠恢复或审计，再按冻结计划引入最小 decision envelope，而不是预先复制一套生命周期。
  - `UserRequirement` 已有来源、稳定 ID 与 revision，但当前只登记整个 run goal；逐子要求的 `Satisfied/NotApplicable/Blocked/Withdrawn` 尚未落地。
  - ActionAttempt 仍未统一；ToolAudit 是 action 事实，control event 是 task/run 事实。缺失 attempt ID 时保持未知，不做伪关联。
  - 一般 Change 的最小 CapabilitySet 尚未从语义合同自动收窄到文件列表；当前选择空默认 write scope + 动作审批，安全但可能增加一次用户确认。
  - `codepro_unified_turn.v1` 仍是旧会话/界面兼容索引，冲突时 Durable Projection 优先；尚未完成退役。
- 收口判断：本切片没有新增第二事实 owner、第二 Evidence Store、第二完成引擎或普通 Coding 的强制 Planner/Tester 门禁；反而删除 Durable 默认入口对固定 DAG 的依赖。尚不能宣布整个 Final Plan 完成，尤其多 requirement revision、通用 ActionAttempt、压缩后结构化 Context Assembler、并行委派和旧兼容状态退役仍是后续迁移项。当前目标是让新的默认顺序 Coding 链获得真实 E2E 证据，而不是继续在底层事件命名上打磨。
- 公开架构复核（2026-09-21）：Anthropic 的 agent 模式强调模型依据环境反馈循环决定下一步，并把 orchestrator-workers 用于无法预先确定子任务的复杂工作；OpenAI Agents SDK 明确区分 LLM 编排与代码编排，并建议在 manager 需要保留最终答案所有权时把子 Agent 作为工具调用。本切片采用“Main Agent 保留用户会话与最终提议、同步委派只提供有界 evidence、宿主管权限/状态/终态”的组合；没有照搬固定角色链，也暂不开放并行委派。参考：[Anthropic Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)、[OpenAI Agent Orchestration](https://openai.github.io/openai-agents-python/multi_agent/)、[OpenAI Agents as Tools](https://openai.github.io/openai-agents-python/tools/)。

## 2026-09-21 E2E-ready 构建、启动与冻结基线收口

- 构建对象：工作树 `C:\Users\admin\CodeBuddy`，分支 `fix/codepro-context-compaction`，HEAD `1d9a60af0f543fa7f160b87a9904cd7440a9c444`。构建前后均为 dirty 工作树；构建后统计 156 个 status 条目，因此 HEAD 只能标识基线提交，不能单独证明二进制包含哪些未提交改动。
- 锁文件与产物：`Cargo.lock` SHA-256 为 `FCCB77F1F98AFD50CD909B3A8AE02B6ACB5AC0ED55EF6A438F15251D2EEBA4CE`。实际桌面后端为 `C:\Users\admin\CodeBuddy\ui\desktop\src\bin\goose.exe`，大小 327,843,840 字节，修改时间 `2026-09-21T20:06:17.8845941+08:00`，SHA-256 为 `ED3A46DD2302A6C44C5B3C6F8992B8A14202FE9948583F07A68FBAF743221575`，`--version` 返回 `1.43.0`。
- 官方入口：在 `ui/desktop` 执行 `node .\scripts\prepare-platform-binaries.js` 成功；`corepack pnpm run typecheck` 成功；随后仅执行一次 `corepack pnpm run start-gui`。未运行 `cargo clean`，未切换 profile、target 或 features，未并发启动第二个 Cargo 构建。
- 构建与启动时间：`start-gui` 对应 Node 进程开始于 `2026-09-21T19:55:35+08:00`；后端增量构建在 10 分 39 秒后完成，随后复制上述 `goose.exe`。Electron 主进程于约 `2026-09-21T20:07:07+08:00` 启动，新的 Vite 进程监听 `[::1]:5173`，桌面子进程与 `goose.exe` 均保持运行。此证据只证明开发桌面成功构建并启动，不证明任何产品 E2E 场景已经通过。
- 最终门禁：`cargo fmt --all` 退出码 0；`cargo check -p goose --lib` 退出码 0；五个聚焦集成目标共 47/47 通过；change completion 聚焦 lib 回归 1/1 通过；桌面 TypeScript typecheck 退出码 0；`git diff --check` 退出码 0，仅有 Git 的 LF/CRLF 工作树提示。
- E2E 交接：执行清单位于 `docs/superpowers/reports/2026-09-21-codepro-dynamic-runtime-e2e-checklist.zh-CN.md`。桌面 E2E 按用户要求保留给真实窗口手工执行；当前产品证据状态为 **E2E-ready / NOT_RUN**，不能写成 PASS。

### 冻结 Final Plan 与事实权威表对照

- **无新的第二权威。** requirement revision 通过现有 control-plane command 进入 Reducer，随后由 EventStore 追加并由 RunProjection 重放；PlanGraph、EvidenceRef、ToolAudit、Authorization 和正式终态仍各自沿用冻结表指定的职责。诊断包只是收集索引，不参与恢复、验收或终态裁决。
- **冻结表的一处进度描述已过时，但核心不变量未变。** `CODEPRO_FACT_AUTHORITY_ZH_CN.md` 仍写 UserRequirement 提交组件“尚未落地”；当前实现已经由 control-plane Reducer 承担唯一提交、EventStore 持久化、Projection 派生。没有为了文件名与实现位置回改冻结文档；若 E2E 证明该 owner 不变量错误，才重新打开基线。
- **完成权链路符合基线。** Main Agent 只能提出完成；宿主从当前 requirement、PlanGraph、task result 和 EvidenceRef 构造并验证门槛；Convergence 拒绝缺口；Reducer 原子提交 task/run 终态。报告、UI、旧 unified 状态均不能反向宣告完成。
- **默认动态链已接入，但没有伪称完整 `AgentDecision` 已落地。** `Respond/Act/AskUser` 仍由既有模型响应与工具循环表达；同步 `Delegate` 和 `ProposeFinish` 已有结构化宿主边界。若真实 E2E 证明隐式 decision 无法可靠恢复或审计，再引入最小 envelope；当前没有为追求类型齐全而复制状态机。
- **验证语义的当前边界。** 工具层保留真实 passed/failed 结果；有写入后的失败验证会阻止完成；无写入且存在真实失败验证时允许 Main Agent 提议“诊断已交付、项目仍不健康”。`unrelated` 尚不是独立持久化枚举，而是 Main Agent 的语义判断与最终 limitation；因此必须由 N03/无关失败 E2E 验证，不能凭聚焦测试宣称完全闭环。
- **已知兼容债务未被日志掩盖。** 当前仅有整条 run goal 一个 UserRequirement；通用 ActionAttempt、逐子要求状态、压缩后的统一 Context Assembler、并行委派、一般 Change 的自动最小 CapabilitySet、旧 `codepro_unified_turn.v1` 退役均未完成。缺少正式 attempt 时公共进度保持空值，不以 event ID 伪造。
- **没有扩大权限或增加普通 Coding 的固定门禁。** SimpleChange 仅绑定明确目标文件；一般 Change/Test 默认写范围为空并走既有审批。Durable 默认入口移除了强制 Planner→Coder→Tester，顺序委派只在模型显式调用 `summon` 时生成新任务。Legacy/Shadow 仍是迁移兼容路径，不获得新链事实的写入权。
- 收口结论：本轮已达到“可由真实桌面场景检验默认顺序 Coding 链”的 E2E-ready 水平，而不是宣布 Final Plan 的全部迁移完成。下一条有效证据应来自清单中的 M02、N01、N03、D01、取消/恢复与诊断导出；若失败，应先按 session→run→task→EvidenceRef→ToolAudit 链定位事实 owner，再决定是实现缺陷、兼容债务还是冻结不变量需要重开。

## 2026-09-22 第一修复批次：验证调用、失败隔离、幂等与完成义务

- 有效范围：只处理 Failure Card 的“当前有效实施范围”和“第二轮源码复核与修订”。未实现完整 `ActionAttempt`，未处理 `turnTerminal`/复制/UI，未修改 intent、Planner、DAG 路由或权限上限。
- 修改前首个偏离：受限 shell 以整条命令字符串和前缀白名单判断验证能力，Windows `npm.cmd test` 不在白名单；含 `&&` 的 compound shell 被拒绝后，宿主还会清空同轮 sibling、进入强制静态收尾并输出全局 `NOT_RUN`。失败 fingerprint 只删除 trace/request ID，`timeout_secs` 会把同一操作拆成多个身份；同一 request 的重复 ToolResponse 也会重复计数。
- 验证调用合同：新增无副作用值对象 `ValidationInvocation`，在 guard 前解析 `executable + argv + cwd + validation_identity`。`npm`/`npm.cmd`、`pnpm`/`pnpm.cmd`、`yarn`/`yarn.cmd` 使用相同 capability identity，但保留 exact executable 供用户指定义务核对；只允许受信 Node 安装目录中的绝对 `npm.cmd` wrapper。原有 `./gradlew test` 能力在收口审查中发现会被误缩窄，已在同一解析器中恢复并补回归。
- 失败隔离：compound shell 仍 fail closed，但只返回当前 action 的结构化、可恢复错误（含稳定 error code、message、recoverable），不再压制同轮无关 read，不再触发 bounded-validation 专用全局 finalization、优化建议或全局 `NOT_RUN`。Main Agent 可消费该 observation 后选择新的简单命令。
- 响应与 operation 幂等：持久化前每个 request 只保留第一个 terminal response，重复项记录协议异常日志并删除；`ToolTaskProgress` 再以 request ID 做 first-wins 边界保护。跨 request 的失败 identity 排除 `timeout_secs`、trace 和 request ID，保留真正影响语义的工具名与参数。没有新增持久化 ActionAttempt 状态机。
- 完成义务：沿用 `UserRequirementsCommitted` 事件，在既有 `UserRequirement` 中附带来源相同的 `ExecutionObligation`；`EvidenceRequirement` 的协议与 Convergence 支持“观察到真实退出码”和“必须退出码 0”。原始用户明确点名的命令在 ACP run 注册边界形成 obligation，保留 literal executable，等价命令不会自动满足。ToolAudit receipt、规范化 invocation 与 exit code 写入现有 Main Agent evidence artifact；CompletionProposal 引用现有 EvidenceRef，Convergence 校验权威 obligation 集合、当前 task 已提交 evidence、exact/equivalent 策略和 exit 条件，Reducer 仍是唯一 `RunCompleted` writer。当前 ACP 产品入口统一登记 `ExitCodeObserved`；`SuccessfulExitCode` 尚只有协议、Convergence 和测试支持，不能表述为已经接入真实修复/验收入口。
- N03 边界：诊断任务的执行义务可以要求“指定命令真实执行并记录退出码”，所以退出码 1 能证明诊断事实；它不等于项目健康或修复成功。当前修复任务写入后的失败验证主要仍由既有 `minimum_completion_evidence_satisfied()` 门槛阻止，不是由真实入口登记的 `SuccessfulExitCode` obligation 阻止。当前仍只有整条 `run-goal` 一个语义 UserRequirement；CompletionProposal 仍将整包 EvidenceRef 投影到该综合 requirement，尚未实现用户目标的逐项语义覆盖。
- 权威与权限复核：没有新 requirement store、evidence store、completion evaluator 或生命周期。EventStore 只持久化；Projection 只派生；Convergence 只判硬门槛；Reducer 只写终态。shell 权限没有扩大：compound 仍拒绝、绝对 wrapper 需信任校验、非验证命令仍走既有审批。普通 Coding 只有原始用户明确点名验证命令时才增加 obligation，没有强制 Planner/Tester/Judge。
- 成熟方案对照：采用 OpenAI Agents SDK tool guardrail 的 `reject_content` / error-to-model 思路，让单工具拒绝成为模型可恢复 observation；采用 LangGraph“保存原始事实、派生提示/展示”和“LLM 可恢复工具错误返回 Agent”的状态原则。未照搬框架或新增编排层。参考：https://openai.github.io/openai-agents-python/guardrails/ 、https://openai.github.io/openai-agents-python/running_agents/ 、https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph 。
- 验证事实：
  - `cargo fmt --all`：最终退出码 0；`cargo fmt --all -- --check`：退出码 0。
  - `cargo check -p goose --lib`：退出码 0，用时 1 分 30 秒。
  - `cargo check -p goose --tests`：退出码 1；被既有 `adversary_inspector_tests.rs` 六处旧调用签名阻断（`inspect` 缺少第五个 `Option<&CodeProTaskScope>` 参数），与本批次改动无关，未越界修改。
  - 首次聚焦命令 `cargo test -p goose --lib first_repair_batch_ -- --nocapture`：退出码 0，11/11 通过，3329 filtered；收口发现 `./gradlew test` 兼容回归后只修该解析分支。
  - 最终同一聚焦命令：退出码 0，12/12 通过，0 failed，3329 filtered，用时 1 分 39 秒。
  - `git diff --check`：退出码 0，仅输出工作树 LF/CRLF 提示。
- 未验证：未运行全量测试、Clippy、桌面构建或产品 E2E；未证明真实 Electron 中 N01/M02/N03/D01 已修复。持久化字段采用 serde default 读取旧 V2 事件；旧二进制降级读取新 obligation 字段未验证。现有整个工作树在本批次前已包含大量未提交重构，HEAD 不能单独证明 candidate 内容。
- 阶段标签：**第一修复批次源码与聚焦验证完成，存在已知语义覆盖债务；可以进入 E2E qualification。** 这不是“完成义务设计已经彻底收口”或“产品修复完成”。

## 2026-09-22 Candidate 构建与 E2E qualification 启动

- 源码身份：分支 `fix/codepro-context-compaction`，HEAD `1d9a60af0f543fa7f160b87a9904cd7440a9c444`，工作树包含本轮前已存在的大量未提交重构；因此 candidate 是“该 HEAD + 当前工作树”，不能表述成该提交的干净构建。
- 标准入口：从 `ui/desktop` 执行 `pnpm.cmd run start-gui`。`ensure-dev-backend` 检测到 Rust 源码更新，完成 debug 后端构建并同步到 `ui/desktop/src/bin/goose.exe`；Rust 阶段用时 13 分 54 秒。
- 标准入口首次未完成：随后 SDK 生成阶段的 Prettier 瞬时无法写入 `ui/sdk/src/generated/client.gen.ts`，命令退出码 2。文件属性与 ACL 正常、没有残留仓库生成进程；只重跑失败的 `pnpm.cmd run build-goose-sdk` 后退出码 0，`pnpm.cmd run i18n:compile` 退出码 0。没有重复编译 Rust。
- 非交互 Forge 启动报告 `Launched Electron app` 后回收了 Vite/子进程，按既有 runbook 的 fallback 分离启动 renderer 与 Electron。核对发现 Vite 安装在 `ui/node_modules`，因此将 runbook 的 Windows 命令修正为根级 `.bin` 路径；没有改变产品代码或依赖。
- 当前存活实例：Vite 监听 `127.0.0.1:5173`；Electron 与 `ui/desktop/src/bin/goose.exe` 均来自当前仓库。candidate 后端 SHA-256 为 `68DF449312BAB3EB9B8BBC2C8376CD1DA08DCA304D4F24BB54E0D7B9C9BC99BE`，文件时间 `2026-09-22 12:53:17`。
- 当前证据边界：桌面 candidate 已构建并启动，尚未执行 N01/N03/M02/D01 产品行为。阶段状态为 **E2E qualification ready**，不是 PASS。
- E2E 夹具预检：N01 直接运行 `npm.cmd test` 为 4/4 通过；N03 为指定 `missing.test.js` 不存在、退出码 1；原 M02 已被历史测试修复，已复制为独立的 `C:\test\test_0922\codepro-first-repair-e2e\M02-failing-change` 并只恢复 options 未传播缺陷，基线为 4/5 通过、退出码 1；D01 在非受限环境基线为选项传播断言失败、退出码 1。以上仅证明夹具起点，不替代 Electron E2E。

## 2026-09-22 第二修复批次：交付效果、受阻退出、目标修订与委派边界

- 对应 Failure Card：只实施第 9 节的完成真实性/合法受阻、当前有效要求 revision、资源授权、委派权限交集与取消收口；没有新增 requirement/evidence store、Judge、工具黑名单、Planner 路由或按自然语言关键词裁决完成。
- 完成真实性：`WorkspaceWrite` permission class 不再直接成为软件交付证据。developer `write/edit` 执行前后由现有 scope guard 对目标文件做摘要，只有真实文件差异才写入宿主可信的 `workspaceDelta.changedPaths`；`ToolTaskProgress` 只消费这项可信元数据。`project_memory_remember` 即使工具成功且被分类为 WorkspaceWrite，也不能在空项目中冒充代码产物。反向保护仍保留：显式“保存记忆”的 ToolAction 可由真实工具成功完成；N01 的通过验证和 N03 的失败诊断不要求伪造代码写入。对“文件已变化但工具返回 error”的部分副作用，宿主仍提交可信 delta，同时把该 action 保持为未核实，禁止以工具错误掩盖已发生写入或把部分写入当成成功。
- 合法受阻退出：Convergence/最低证据拒绝现在总能返回非空、去重的具体 gap；同一 gap 与同一 evidence fingerprint 连续出现而没有新事实时，现有 Main Agent 根任务通过既有 PauseRun/Reducer 保存可恢复暂停，不再把空 gap 反复注入几十次。未新增 Blocked 生命周期或第二完成引擎。
- 授权效果：一般 Change 根任务仍默认空 write scope。developer `write/edit` 若模型提出具体安全工作区路径，既有 permission card 的一次用户批准只授权该次精确路径，scope guard 继续阻止路径逃逸；批准不再出现“用户允许了但动作仍必然被相同 guard 拒绝”。无路径守卫的其他 WorkspaceWrite 工具没有因此自动放行。
- 委派能力：`summon.delegate` 新增可选的显式 `write_scope` 请求，默认只读。子 task scope 由既有 `CodeProTaskScope` 计算为父 write scope 与委托请求的交集；越父 scope 在创建子会话和注册 Worker 前失败。角色名不再隐含扩大权限。同步委派收到取消时，复用现有 WorkerOutcome::Paused/Checkpoint 提交唯一 outcome，保留子 task ID 与“可能已有副作用，恢复前需对账”的事实；没有建立平行子任务生命周期。
- 当前要求 revision：宿主标记的 active-run user steer 只有在没有结构化 `task_continuation_of` 关系时，才通过既有 `CommitUserRequirements` 形成新 revision，并以该消息 ID 作为当前会话解释边界；同时清空旧目标的动作证据和写能力，防止 A 的 evidence/Capability 直接满足 B。结构化续接保留当前 requirement、evidence 与 capability，不把“继续”另立成字面目标。这里没有在本链新增自由文本判断；语义仍由 Main Agent 在完整对话中判断，宿主只消费已经绑定的消息关系。更细粒度的 supersession 关系仍是已知语义债务，不能把本切片表述为任意 A→B 已完全证明。
- 恢复控制注入修正：ACP prompt run identity 不再扫描自由文本中的 `run_*/run-*`、`继续/恢复/checkpoint`。只有严格反序列化并校验的 `codebuddy/turn-retry` metadata 可复用 source run；粘贴 JSON、日志或源码中的 `run_id` 永远只是内容。旧 multi-agent 路径的恢复候选也收窄为精确 plain continuation，不再因一段文本同时包含“检查点”和“继续”而读取旧状态。
- Pause/Stop 与 UI：Durable `PauseRun`/`EmergencyStop` 先由现有 Reducer/EventStore 提交，再只中断同 session 且 run ID 匹配的 active prompt token。内存 `ActivePromptRun` 只记录本次 transport 停止来源，用于防止 Pause 在 prompt 收尾时被二次解释成 Cancelled；它不是持久状态或恢复权威。桌面在宿主明确发布非空 `activeRunId` 时只解封同一 run，因此 resumed same-run 的新 activity 不再被旧 terminal seal 丢弃，其他旧 run 仍保持 sealed。
- 新增诊断日志只描述已提交或已观察事实：真实 workspace delta 记录 session/run/task/action ID 和路径数量；requirement revision、委派 scope、委派取消 outcome、完成拒绝 gap、control→prompt interruption 均带已有 identity。日志不成为恢复或完成输入。
- 验证事实：
  - `cargo fmt`：最终退出码 0。
  - `cargo check -p goose --lib`：最终退出码 0；中间两次分别暴露缺失类型限定和三个旧调用点未切换可变 active-run map，均在本切片内修正后重跑通过。
  - `cargo test -p goose --lib repair_batch -- --nocapture`：退出码 0，18/18 通过，0 failed，3329 filtered，用时 4 分 21 秒；覆盖第一批验证合同/幂等/obligation 及第二批交付效果、精确授权、父子 scope、具体 gap。
  - `cargo test -p goose --lib third_repair_batch -- --nocapture`：首次因旧 fixture 仍传入已删除的自由文本 resume 参数而未进入断言；fixture 改为只接结构化 retry 后，重跑退出码 0，3/3 通过，0 failed，3345 filtered，用时 4 分 18 秒。
  - `cargo test -p goose --lib fourth_repair_batch -- --nocapture`：第一次加入结构化续接回归时因项目 Rust edition 不支持 let-chain 在编译阶段退出码 1；改为等价嵌套判断后重跑退出码 0，2/2 通过，0 failed，3348 filtered，用时 3 分 03 秒。两项分别证明工具报错但真实文件已变化时 completion 仍被阻止，以及结构化续接不会覆盖当前 requirement。
  - `pnpm.cmd run test:run src/acp/__tests__/chatSessionStore.test.ts`：沙箱内 esbuild `spawn EPERM` 未启动；第一次沙箱外命令误把 `--` 作为 Vitest 字面参数且未结束，人工终止。纠正参数后退出码 0，1 个文件、49/49 通过，用时 1.57 秒。
  - `pnpm.cmd run typecheck`：退出码 0，`tsc --noEmit` 无错误。
- 尚未实施/验证：没有构建本批 candidate，没有产品 E2E，没有证明迟到的真实子进程在取消确认后绝不继续写；没有完成逐条语义 requirement/supersession、旧 unified 退役、注册后前置失败 orphan 收口、stale activeRun polling、steer 入队 TOCTOU 或半注册 reconcile。上述均不得由本批聚焦测试推断为已解决。
- 新现场的证据边界：1.1MB 单条输入不是自动压缩验收夹具；源码确认当前输入、history localStorage 和 compaction 对单条巨型最新用户消息缺少合适边界，但 Ctrl+A 卡顿热点仍需性能复现，本批未修改 UI 输入预算或压缩算法。大仓库“读着读着停”可能先触发独立 Action Budget；具体一次运行仍需对应 session/run ledger，未据描述提高预算。
- 阶段标签：**P0 事实转换的源码切片与聚焦回归已完成；candidate 尚未构建，真实 N01/N03/M02/D01/X01 与目标切换/停止/恢复仍为 NOT_RUN。**

## 2026-09-22 第二修复批次 Candidate 构建

- 静态收口：`cargo fmt -- --check`、`pnpm.cmd run typecheck`、`git diff --check` 均退出码 0；`git diff --check` 只有共享工作树既有 LF/CRLF 转换提示。最终第四批聚焦回归为 2/2 通过。
- 构建命令：在 `ui/desktop` 运行 `pnpm.cmd run start-gui`，退出码 0。`ensure-dev-backend` 检测源码更新，Rust debug 后端构建用时 10 分 04 秒；SDK schema 生成、SDK `tsc`、i18n、Electron main/preload bundle 均成功。
- 非交互 Forge 报告 `Launched Electron app` 后回收运行进程，符合现有 runbook 已记录行为；没有重新编译，改用 runbook 的分离 Vite/Electron 启动。当前 renderer 监听 `127.0.0.1:5173`，当前后端监听 `127.0.0.1:50886`。
- candidate 后端：`ui/desktop/src/bin/goose.exe`，大小 328187904 bytes，时间 `2026-09-22 17:00:59 +08:00`，SHA-256 `B822A9F27FFC259C16EB07AF273C09AEDE5A249D93C716E83F4B069A03134781`。
- 源码身份：HEAD `1d9a60af0f543fa7f160b87a9904cd7440a9c444`，tracked binary diff Git blob `18064838a6b42e4820a4aa5b4d4a6610abeb5fa4`，构建前 untracked manifest Git blob `0af46077c251a9818617fa29f5e4003bb33ed2fe`，Cargo.lock SHA-256 `FCCB77F1F98AFD50CD909B3A8AE02B6ACB5AC0ED55EF6A438F15251D2EEBA4CE`。完整记录见 `2026-09-22-codepro-candidate-source-manifest.json`；不能用 HEAD 单独代表本 candidate。
- 当前状态：candidate 已构建并启动，**五组产品 E2E 尚未执行**。这一步只证明构建与启动，不证明 N01/N03/M02/D01/X01 通过，也不证明委派子进程取消后的真实文件副作用已经完成对账。
- 桌面自动化边界：启动后 Windows Computer Use 连续两次枚举都返回 `apps: []`，无法选中唯一 CodeBuddy 窗口；按人工 E2E 证据规则停止恢复，本轮 N01/N03/M02/D01/X01 均记为 `NOT_RUN`。存活 Electron/goose 进程、renderer/backend 端口和构建成功只能证明 candidate 在运行，不能替代真实窗口交互与结果核对。

## 2026-09-22 Candidate 构建后的 P0 复核修正与 E2E 夹具冻结

- 独立复核发现前一版 workspace delta 仍有真实缺口：`CodeProWorkspaceWriteGuard::after_execution()` 位于 bounded tool operation 内部，MCP transport error 会在 `call_result?` 提前返回，host timeout/cancel 也由外层结束，因此“工具已经写文件，但回执错误或超时”的路径可能丢失 delta。这正是 M02/D01 历史中“子任务超时但文件已变化”的同类事实转换错误；此前 candidate 不得继续使用。
- 最小修复复用现有 guard、ToolAudit 和 ErrorData：执行前快照仍在 dispatch 边界创建；执行后的对账统一移到 bounded operation 返回后，覆盖 success、tool/transport error、host timeout 和 cancel。真实差异附着到同一个成功或错误回执，后续 ToolAudit 注入会合并而非覆盖；`ToolTaskProgress` 同时读取成功与错误回执中的可信 delta。失败/超时即使观察到文件变化仍保持 unverified，不会被升级为成功。没有新增 ActionAttempt、evidence store、完成引擎或生命周期。
- 聚焦回归使用真实 mock 工具先写入 `app.js`，随后分别返回 transport closed 和等待 host timeout。`cargo test -p goose --lib fifth_repair_batch -- --nocapture` 退出码 0，2/2 通过，0 failed，3350 filtered，用时 3 分 09 秒（其中测试执行 1.08 秒）；证明两类错误回执都保留 `workspaceDelta`，Audit outcome 分别仍为 `tool_error` 与 `timed_out`。`cargo fmt --all` 退出码 0；`cargo check -p goose --lib` 退出码 0，用时 2 分 04 秒；相关 `git diff --check` 退出码 0，仅有 LF/CRLF 提示。
- 目标修订边界复核：旧 `codepro_unified_turn.v1` 推导的 `task_continuation_of` 仍不应成为 Durable requirement 的长期语义裁决者；同时，所有 active steer 也不能被宿主固定解释为 replace，因为“顺便不要改测试”是 amend，“改做 B”才是 replace。该语义需要 Main Agent 提出结构化 amend/replace/withdraw 候选、宿主做来源与 CAS revision 校验，本批没有伪造完成。X01 因其真实步骤是“确认停止 A 后再发送 B”，本轮只验收旧 run 终止、新 prompt 创建新 run、最后一个 run 的压缩恢复；不声称 active-run steer 已解决。
- 新夹具根目录为 `C:\test\test_0922\codepro-second-repair-e2e`，生成脚本为 `scripts/prepare_codepro_second_repair_e2e.ps1`，提示词与人工验收清单见 `2026-09-22-codepro-second-repair-e2e-kit.zh-CN.md`。fixture manifest SHA-256 为 `6CCD140C33EC021BBE0013D797D059FC9B3418D142910F3161DF334C941563BF`。基线：N01 `npm.cmd test` exit 0、4/4；N03 exit 1、缺少 `missing.test.js`；M02 exit 1、4/5；D01 在当前 Codex 沙箱内 `npm.cmd test` 因 Node 子进程 `spawn EPERM`，等价 `node --test --test-isolation=none` exit 1、0/1，正式桌面仍必须记录产品内字面命令回执。
- 最新构建：`pnpm.cmd run start-gui` 完成后端增量构建，Rust 阶段用时 9 分 37 秒，SDK schema/TypeScript/i18n/Electron bundle 均成功；Forge 父进程退出后复用既有 `127.0.0.1:5173` renderer，直接启动可见 Electron，没有重复 Rust 编译。后端 `ui/desktop/src/bin/goose.exe` 大小 328199168 bytes，时间 `2026-09-22T17:52:29.3087867+08:00`，SHA-256 `0C996055E0E040003E5CC3F4F7B38199B625E838323A18A416B93A43C3EE721A`，PID 16192，监听端口 50913；Electron 主进程 PID 12224。
- 当前证据边界：最新 candidate 已构建并启动，夹具与提示词已冻结；N01/N03/M02/D01/X01 的产品 E2E 仍为 `NOT_RUN`。timeout 后记录的 delta 是取消/收尾时刻的本地快照，不证明失控外部子进程此后绝无副作用，因此该 action 保持 unverified 且恢复前仍需只读对账。

## 2026-09-22 第六修复批次：Platform Developer 正式审批与 task-scoped 授权

- 直接证据：第二轮产品 E2E 中，M02、D01 与 X01 的 Main Agent 写入均先被空 `write_scope` 拒绝；随后普通 `ask_user` 虽返回“授权/允许”，同一 task scope 下的写入仍被相同 guard 拒绝。源码链同时确认：Durable 根任务默认 `write_scope=[]`；`ask_user` 只返回业务回答，不提交 capability；Developer 实际注册为 `ExtensionConfig::Platform`，但 Platform permission classifier 未给 `developer` 工具分配 `WorkspaceWrite`，导致原生 `action_required` 审批从未出现。问题不是用户不会选，而是权限事实没有进入唯一正式审批链。
- 修复边界：复用既有 `PermissionInspector -> action_required -> handle_approval_tool_requests -> explicit_user_confirmation -> CodeProWorkspaceWriteGuard` 链，不新增授权事件、权限存储、AskUser 语义或第二套 capability。Platform 与 Builtin Developer 共用同一个 host permission classifier：`tree/search/read_document` 为 `ReadOnly`，`write/edit` 为 `WorkspaceWrite`。实际 Platform 裸工具名 `write/edit` 与前缀形式均按所属 profile 识别。
- 一次审批：空或不覆盖目标路径的 `write_scope` 不再被 policy 预先放行后交给 guard 必然拒绝，而是进入正式 permission card；`AllowOnce` 只给原始 request 注入 `explicit_user_confirmation=true`。随后仍由 workspace root、canonical path 与 symlink guard 检查目标，批准不能写出工作区。
- task-scoped 持续批准：只有当前 session、完整 `CodeProTaskScope`、当前 tool name 下由原生 `action_required` 的 `AlwaysAllow` 写入现有 scoped `PermissionManager` 的事实，才会让后续同 scope/tool 的 dispatch 携带 `explicit_user_confirmation=true`。全局 `permission.yaml`、SmartApprove/Auto、宿主 policy allow 和由非空 delegated scope 合成的 allow 均不能冒充用户确认；不同 session/task/scope 不继承。
- 精确委派范围：已有窄 `write_scope` 只自动放行真实落在范围内且具备路径守卫的 developer `write/edit`；同工具的越界路径改为正式审批，其他无路径守卫的 `WorkspaceWrite` 工具仍需审批。没有扩大 shell、Git、外部副作用或工作区外权限。
- 与冻结权威职责一致：用户/原生审批拥有授权事实；`PermissionManager` 仅保存当前进程内 task-scoped 决议；Inspector 只计算当前调用是否需审批；dispatch 只携带已确认 provenance；workspace guard 仍是路径安全边界。Intent、UserRequirement、Reducer、Delegate、Completion 与 UI 本批均未修改。AskUser 继续只负责业务澄清，不再被当成通用权限修改器。
- 成熟方案对照：采用 OpenAI Agents SDK HITL 的“审批绑定具体 tool call，恢复同一 run，always approval 只作用于同一工具身份”以及 guard 在批准后、执行前继续校验的边界；采用 Anthropic Managed Agents 中 permission decision 与 `user.tool_confirmation` 分离的做法。没有照搬新的编排框架，也没有把全局配置升级为任务授权。参考：https://openai.github.io/openai-agents-python/human_in_the_loop/ 、https://openai.github.io/openai-agents-python/guardrails/ 、https://platform.claude.com/docs/en/managed-agents/permission-policies 。
- 验证事实：
  - `cargo fmt --all`：退出码 0。
  - `cargo check -p goose --lib`：最终退出码 0；修正实际 Platform 裸工具名与全局配置边界后重跑用时 1 分 49 秒。
  - `cargo test -p goose --lib sixth_repair_batch -- --nocapture`：最终退出码 0，2/2 通过，0 failed，3352 filtered，用时 3 分 18 秒。覆盖 Platform/Builtin 分类一致、AskUser 不进入权限分类、空 scope 正式审批、全局配置不冒充 task approval、task-scoped AlwaysAllow 仅同 session/scope/tool 生效。
  - `cargo test -p goose --lib delegated_write_scope_only_auto_allows_path_guarded_developer_tools -- --nocapture`：退出码 0，1/1 通过；覆盖 exact scope 自动允许、同工具越界进入审批、Git 等无路径守卫写工具不自动放行。
  - `cargo test -p goose --lib second_repair_batch_one_time_approval_authorizes_only_the_requested_path -- --nocapture`：退出码 0，1/1 通过；保护一次批准仍只授权该 request，canonical workspace 边界未放宽。
  - 四个相关源码文件的 `git diff --check`：退出码 0，仅有共享工作树 LF/CRLF 转换提示。
- 已知边界：原始用户明确授权写文件目前仍不会自动生成写 scope，第一次实际写入会显示一张原生 permission card；这是 fail-closed 的迁移行为，不应由 AskUser 静默代替。task-scoped `AlwaysAllow` 当前只存在于进程内，重启后会再次询问；同进程压缩/继续应保留，但尚未由产品 E2E 证明。本批没有宣称逐项 UserRequirement、委派超时副作用或目标修订债务已经解决。
- 阶段标签：**第六批权限边界源码与聚焦验证完成；桌面 candidate 尚未重新构建，M02/D01/X01 原生审批链仍为产品 E2E `NOT_RUN`。**

## 2026-09-22 第六修复批次终审修正、Candidate 构建与 E2E 准备

- 双向终审发现并修正一个构建前 P0：既有 `PermissionManager::get_scoped_permission()` 会在精确 task key 未命中时回退到同 session 的 `task_scope=None`。若直接用于新授权链，历史 session-level `AlwaysAllow` 会被误当成完整 task 确认。新增只读 `get_exact_task_scoped_permission()`，只查询 session + 完整 `CodeProTaskScope` + scoped tool key；`task_scoped_user_permission()` 与 task-scoped `WorkspaceWrite` inspection 使用精确查询，其他兼容场景保留旧层级读取。本次没有删除旧行为或新增状态。
- 回归追加 session-level 反例：先写入 `task_scope=None` 的 `AlwaysAllow`，task A/B 的 confirmed 查询仍为 `None`，空 task write scope 仍进入审批；只有精确 task A entry 才放行。修正后 `cargo fmt --all` 与 `cargo check -p goose --lib` 均 exit 0，check 用时 1 分 50 秒；`cargo test -p goose --lib sixth_repair_batch -- --nocapture` exit 0，2/2 通过、3352 filtered、用时 3 分 19 秒。
- Clippy 门禁真实结果：`cargo fmt --all -- --check` exit 0；`cargo clippy -p goose --lib -- -D warnings` exit 1，被本批权限文件之外的 7 个既有 dirty-worktree 告警阻断：`agent.rs` needless `as_deref`、`codepro_terminal_report.rs` 复杂布尔式、`summon.rs` UTF-8 string slice、`task_dag.rs` 相同 if 分支、`tool_execution.rs` 参数过多、`validation_invocation.rs` 两处 needless return。本批没有为通过门禁越界改写这些逻辑。
- 构建：关闭上一个已核对路径的 Electron/goose/Vite 实例后，在 `ui/desktop` 执行 `pnpm.cmd run start-gui`，exit 0。Rust debug 后端用时 9 分 43 秒；SDK schema/生成代码、SDK TypeScript、i18n、Electron main/preload bundle 均成功。Forge 在非交互终端报告启动后回收进程，按既有 runbook 分离启动 Vite 与已编译 Electron，没有重复编译。
- 新 candidate：`ui/desktop/src/bin/goose.exe` 版本 `1.43.0`，大小 328204288 bytes，时间 `2026-09-22T20:31:35.9630094+08:00`，SHA-256 `FF49A16BC9AB1C37C33CC522E28D3F1FC239B7C89FF7CFABC55135D01B8F9995`。renderer PID 14804 监听 `127.0.0.1:5173`；Electron 主进程 PID 14576 连接后端 PID 24444，后端监听 `127.0.0.1:53706`。源码与运行身份见 `2026-09-22-codepro-sixth-repair-candidate-source-manifest.json`。
- 新夹具：独立根目录 `C:\test\test_0922\codepro-sixth-repair-e2e`，manifest SHA-256 `9F57E95B51854C6BC5CA971C0B8C01808102629F256CAF3D339DB0F5111B82EF`。生成后字面基线：N01 exit 0、4/4；N03 exit 1；M02 exit 1、4/5；D01 exit 1、0/1。新增 P01 AlwaysAllow 与 AllowOnce 两个双 edit 夹具，分别验证同 task/tool 复用和单 request 不扩散。完整提示词见 `2026-09-22-codepro-sixth-repair-e2e-kit.zh-CN.md`。
- 构建后独立复核未发现新的 P0/P1 task-scope 泄漏。保留一个不阻断当前工作区 E2E 的 P1：工作区外绝对路径若不在外部文件 scope，可能先显示一次性审批、随后仍被 canonical workspace guard 拒绝；当前策略继续 fail closed，本批没有扩大外部路径权限，也不能声称所有外部路径审批已经闭环。
- 当前证据边界：**Candidate 已构建并从新二进制启动，夹具与提示词已冻结；P01-A/P01-B/N01/N03/M02/D01/X01 产品 E2E 均为 `NOT_RUN`。** 因 Computer Use 不可用，真实窗口交互、权限卡选择、持久化状态和日志导出必须由用户回来后人工执行；构建/进程/端口证据不能替代产品 PASS。

## 2026-09-23 第七批进行中：委派收口与自主写入授权诊断

- 新 E2E 直接证据：X01 第二个有效教务 run 的委派结果因中文摘要按字符截断、协议按 UTF-8 字节校验而被拒；D01 的首次异步委派被拒，主 Agent 先改文件，成功的只读委派反而在修改之后。P01-once / P01-alws 导出只记录 `user_confirmed`，不含用户选择的 ACP `option_id`；预批准的 task-scoped `AlwaysAllow` 也会记为 `user_confirmed`，故不能据此认定缓存失效。截图只证明界面为“自主”，源码确认 CodePro `WorkspaceWrite` 默认仍为 `AskBefore`。
- 已修改但尚未 E2E：委派摘要改用 UTF-8 字节预算，证据 artifact 保留子会话 ID、回复摘要/长度/哈希；无法提交 outcome 时尝试在同一 Durable 链将子任务和 run 暂停并返回具体 task ID。Convergence 对 Running/Ready/Proposed task 生成明确 blocker。Durable 委派工具说明不再建议其不支持的异步模式。曾试做分阶段 Change 的单文件目标透传，但对抗检查发现模型目标不能独自成为写入授权、且恢复后没有持久授权事实，故该未闭环改动已撤下。
- 为下一轮 P01 定位增加最小诊断：ACP permission 响应记录 `option_id`、session/request/tool、授权作用域；缓存结果记录 session/run/task/tool 与级别，不记录文件内容。新增同一 task 的 `AlwaysAllow` 第二次 edit 与另一 task 隔离回归，尚未执行。
- 验证事实：`cargo fmt -p goose` exit 0；`cargo check -p goose --lib` 首次因新增日志使用已移动的 ACP session ID 退出码 1，修正后重跑 exit 0（37.30 秒）；相关 `git diff --check` exit 0，仅 LF/CRLF 提示。新增聚焦测试**未运行**，桌面构建与新一轮产品 E2E **未执行**。
- 当前待收口：任务级用户选择的 typed 约束、同一 Durable run 的续接/替代、授权范围随 requirement revision 持久化、D01 的前置证据顺序，以及项目级“自主写入”与窄文件限制的安全边界。不能把本段当作第七批完成证明。
- 第七批追加：委派子任务在 `StartTask` 后若 `RegisterWorker` 失败，先从当前 Projection 确认 owner；无 owner 或 owner 为本次 Worker 时经现有 `SubmitTaskOutcome(Paused)` 与 `PauseRun` 收口；若发现其他 Worker owner，不冒名提交结果，只暂停 run 并暴露 task ID 供对账。此路径尚无运行时回归。`cargo fmt -p goose` 与随后 `cargo check -p goose --lib` 均 exit 0（后者 18.27 秒），但不代表产品 E2E。
- 用户反馈“自主模式每写一个文件都授权一次”。源码首偏离：staged Change 未带根任务写范围；Main Agent 生成 `write_scope=[]`，一般写入默认 AskBefore。另当前 `AllowOnce` 与 `本任务允许` 的 ACP 选择未被 P01 导出，不能以 `user_confirmed` 判定是否缓存失效。方案比较已提交独立审查：不采纳模型临时字段、TaskContract 或 UserRequirement 冒充授权；倾向在现有 Durable 事件账本中记录有来源、工作区、精确范围和修订号的任务授权，Projection 派生当前 Capability，无法确定范围时只问一次明确资源授权。此跨协议方案尚未实施，不能写成已修复。

### 第七批待决的任务级写入授权方案比较

- 首偏离：`agent.rs` 只为直接单文件 Change 设置 `permission_scope`；staged Change 进入根任务时 scope 为空。当前 `PlannedTask` 不保存授权，steer 又重建空 scope；因此把模型的临时目标字段直接接到 Inspector 既不具备用户授权权威，也不能跨恢复维持。
- 方案 A：把可写路径塞入 `UserRequirement`、`TaskContract` 或内存 `options`。改动少，但把目标、计划和权限混为一项；模型改计划可能扩大权限，重启/steer 后也会漂移。**拒绝**。
- 方案 B：在现有 Durable 事件账本/Projection 中提交有 source message、run、工作区绑定、路径集合与 CAS revision 的任务级写入授权。模型只提出候选范围；宿主校验 canonical 工作区和路径，对不确定或较宽范围向用户作**一次**可见的任务级资源确认，确认才提交授权事实。root `CodeProTaskScope` 每次从当前 Projection 派生，delegate 取父范围与委托范围交集；改目标/撤回使授权失效，旧 run 无事件则保持空范围。路径守卫继续按每次工具参数执行，越界仍需新授权；Git、shell 和外部副作用不从文件授权继承。**推荐，但跨协议，尚待拍板与实施**。
- P01 对照证据仍必需：原始 `option_id`、ACP RequestPermission 次数与 scope identity；`AllowOnce` 两次 edit 应两次请求，`本任务允许` 同 scope/tool 第二次不请求。只有本次新诊断日志落到下一 candidate 后才能从产品日志验证，不能由历史 ToolAudit 的 `user_confirmed` 推断。
- 用户明确补充：未特别要求时，她实际会选择“本任务允许”。因此不能把其日常逐文件弹窗归因于用户习惯性选择 `AllowOnce`；下一候选应优先检查该选择是否被映射并缓存、两次请求的 session/run/task/tool/scope identity 是否漂移，以及 staged/steer/resume 是否重建空授权。既有 P01-alws 导出缺 ACP option_id，不能把用户习惯反向填作那一次的原始回执。
- 静态补核：桌面 `ToolApprovalButtons` 的“本任务允许”调用 `always_allow`，ACP adapter 选择 `allow_always` option；后端 `tool_execution.rs` 收到 `Permission::AlwaysAllow` 会用当前 session、tool name、task scope 写入精确缓存，同 scope/tool 的预批准路径会读取它。故目前没有发现按钮标签到后端决议的直接映射错误；真实重复弹窗更需用新日志判别工具名、task/scope/permission-session 身份变化、缓存未更新或恢复后丢失，不能先指定一种根因。

### 与桌面版 Codex 的公开行为对照（仅采纳可观察/官方事实）

| 维度 | 官方 OpenAI Docs 可确认的行为 | CodePro 当前差距与取舍 |
| --- | --- | --- |
| 工作区内普通编辑 | `workspace-write` + `on-request` 可在工作区内读写、运行常规本地命令；跨出边界才请求，降低低风险逐次审批。 | CodePro Auto 的 `WorkspaceWrite` 默认 `AskBefore`，且 staged Change 丢掉具体写范围。目标是在已确认的任务/工作区边界内连续 path-guarded 编辑；不把 Auto 升级为无限文件系统访问。 |
| 一次或任务级批准 | 审批可以按一次或当前 chat 等范围生效，官方建议选能推进任务的最窄范围。 | CodePro 已有“本任务允许”，但 P01 导出缺选择与缓存命中证据，用户报告选择后仍受打扰。应先核身份与作用域，再判断缓存 bug；宽授权须让用户看得见对象与范围。 |
| 工具/进展展示 | 官方更新记录提及 tool activity styling、progress indicators、task progress updates；没有公开具体分组算法。 | CodePro 应保留工具原始回执与失败突出，同时把例行活动默认紧凑呈现；自然语言阶段汇报与工具审计分层。当前 UI 尚未实施本轮 UX 改造，不能声称对齐。 |

来源：https://learn.chatgpt.com/docs/sandboxing 、https://learn.chatgpt.com/docs/permission-modes 、https://learn.chatgpt.com/docs/changelog 。这里只借鉴公开产品边界与可观察 UX，不推断 Codex 内部权限键、事件结构或活动归组算法。

### 2026-09-23 用户可理解进展与活动密度：独立前端验收项（未实施）

- 用户截图显示 CodePro 在同一时间段连续呈现五张“读取文件”卡；Codex 桌面截图显示若干文件编辑在一处可展开活动内。两张图只能证明可见体验差异，不能据此推出 Codex 的内部归组条件，也不能单凭 CodePro 图片判定是消息插入、task ID、事件结构或运行版本造成未合并。
- 源码核对：`codeProActivityModel.ts::canGroupRead` 只对有结构化 `file_read`、run ID、已完成/失败且相邻并同 run/task 的活动合并；`ProgressiveMessageList.tsx` 只把连续 `codeProActivity` 通知（可跨已有代表性工具 transport）送入这个模型，其他消息会断组。当前按输出条目逐项渲染为卡片/读取组，尚未实现默认折叠的阶段活动容器；存在的 `CodeProActivityGroup` 没接入这条主消息路径。
- 取舍：后端 P0 的权限、要求、证据、完成语义继续先收口。前端作为单独切片，复用现有活动事件与模型阶段文字：开始前一句当前意图；有新发现、转入实现/验证或受阻时简短更新；常规工具活动按实际阶段或连续工作段默认折叠，可展开查原始回执/退出码/路径。审批、失败、等待和重复次数在折叠状态仍突出。不得按固定调用次数生成模型摘要，也不得把后台上百张卡仅用 CSS 隐藏而继续全部渲染。
- 验收分别判断：执行正确性看权威账本和文件/工具结果；使用顺畅性看阶段文字是否有真实依据、活动密度、展开/导出完整性、失败可见性与长会话渲染性能。当前前端切片**未编码、未测试、未做桌面 E2E**。

### 2026-09-23 活动呈现切片：紧凑折叠与编辑操作回执

- 依据用户后续截图的观感要求，只借鉴“过程轻量、可折叠、阶段可见、改动另列”的信息层级，不复制 Codex 文案或推断其私有归组规则。没有改后端事件、ToolAudit、权限、收敛或最终报告权威。
- `ProgressiveMessageList` 现在跳过不可见的内部 assistant 消息与已有活动代表的 transport，再按相邻活动及相同 run/task 分段；`CodeProActivityTimeline` 将读取、命令、测试、编辑等混合操作放入无边框的紧凑记录。运行中可展开，操作结束默认折叠；失败、取消、中断、未知结果保持显著提示，不被一个“已完成”标题掩盖。展开后仍可查看逐条活动、命令输出和退出码。
- 每段折叠区只汇总已有事件的操作种类/次数，不宣称用户目标已完成。成功的结构化 `file_changed` 编辑工具回执另列简洁“编辑操作已完成”记录，点击可回到原操作详情；没有 diff 时明示“依据编辑工具回执，未核对文件差异”，不伪造增删行数、审查或撤销能力。整轮业务总结仍由现有 Agent 报告提供，前端不新增完成判断。
- 用户补充的长列表约束：展开后的操作区最大高度 16rem，超出时在该区域滚动，键盘可聚焦；不会因几十条命令把整个聊天页面拉得很长。折叠区仍保留总数和异常提示。
- 证据来源复核发现 `PublicProgressEvent(coding, completed)` 也映射为前端 `file_changed` 展示类型，但它不是编辑工具回执。活动 ViewModel 现显式标注 activity event / public progress / test progress / legacy 来源；“编辑操作已完成”只消费成功的结构化 activity event。失败的编辑与纯进度通知均不得生成修改记录。类别小结使用“读取/编辑操作”而非“文件已变化”，避免把尝试次数当成果。
- 验证：`pnpm run typecheck` exit 0；四个受影响 TS/TSX 文件局部 ESLint exit 0；两份相关组件测试 36/36 通过。首次 Vitest 在沙盒内因 esbuild 子进程 `spawn EPERM` 未进入断言，随后相同聚焦命令在受控执行环境通过。Prettier 已格式化本切片文件；相关 `git diff --check` exit 0，仅 LF/CRLF 提示。
- 未验收：没有在真实 Electron 窗口进行视觉/交互 E2E，没有验证长会话滚动性能；模型是否在有意义的阶段输出简短自然语言更新仍属独立后端/提示行为，不由这次界面归组保证。此切片不能替代第七批权限/委派 P0 的完成与 candidate 构建。
- 来源收紧后的最终局部门禁：`pnpm run typecheck` exit 0；七个受影响 TS/TSX 文件的 ESLint exit 0；四份 UI 测试文件 74/74 通过。上述结果仍不是桌面窗口验收。
- 同日独立静态审查指出残余误计：编辑回执卡已按 `source=activity_event` 过滤，但折叠区的“编辑操作”计数仍只看 `eventType=file_changed`，会把 `PublicProgressEvent(coding, completed)` 算作一次编辑。现已让摘要计数消费同一来源边界，并在既有组件回归中同时断言真实编辑计数保留、纯进度不计编辑。局部 `CodeProActivity.test.tsx` 27/27 通过；`pnpm run typecheck` 与两个相关文件的 ESLint exit 0。自然语言阶段汇报、长会话观感和真实桌面 E2E 仍未由此证明。

### 第七批权限缓存新增 P0 边界：方案比较（实施前）

- 静态调用链：空根任务 `write_scope` 使第一次 Developer edit 走原生审批；选择 `AlwaysAllow` 后，`tool_execution.rs` 仅以 session/task/tool 缓存。`PermissionInspector` 下一次同工具可预批准，`agent.rs` 将该缓存转换为 `explicit_user_confirmation=true`，而 `CodeProWorkspaceWriteGuard` 对工作区内不在 `write_scope` 的路径接受该确认。因此批准编辑 A 文件可能使 B 文件免审，这不是单纯“减少弹窗”的 UX 问题。
- 方案 A：禁用空范围下 Developer edit 的任务级缓存。立即保守，但同一文件第二次编辑也重新询问，P01-alws 与用户“本任务允许”的明确预期失败；只可作为短暂 fail-closed 回退。
- 方案 B：对带路径守卫的 Developer write/edit，把现有任务级缓存键细化为工具＋经规范化的目标文件身份；同一路径复用，路径变化再审批。守卫在每次执行前仍独立检查 canonical 工作区，不让缓存替代路径检查。不新增权限 store；但多文件开发仍可能逐文件询问，不能称作完整自主体验。
- 方案 C：在既有 Durable 事件账本保存经用户确认的任务资源范围，Projection 派生当前能力。可一次批准清楚显示的文件/目录集合，恢复和委派仍可校验；这是此前推荐的终态，涉及协议与前端审批表达，不能把普通 `AlwaysAllow` 工具按钮暗中解释成 `**`。选择先以 B 堵住扩大权限，再按 C 解决多文件任务授权；二者都不能由模型目标字段独自签发。

### 第七批局部实现与验证：资源绑定审批、显式暂停续跑

- 将 Developer `write/edit` 的现有 task-scoped permission 缓存键绑定到规范化后的目标文件身份。审批同一文件可复用；目标换成另一个文件不会因同一 task/tool 的 `AlwaysAllow` 自动取得 `explicit_user_confirmation`。原 `CodeProWorkspaceWriteGuard` 仍在执行前独立检查 canonical 工作区边界；没有扩大 shell、Git 或外部副作用权限。`NeverAllow` 仍可按工具级任务范围拒绝。多文件任务的一次资源授权及重启后持续有效尚未实现，此处不宣称完整自主写入体验。
- ACP 显式续接一个 Paused Durable run 时，现在提交已有 `ResumeRun` 命令，经 Reducer 进入 Recovering；有仍为 Running 的委派 task 时按 task ID 拒绝续跑、保留 Paused 与事件序号，等待对账。旧 unified `status=finished` 不再独自裁决纯“继续”的完成状态，也不再用兼容 DAG 的 checkpoint 校验反向阻止已定位 Durable run；完成与否以当前 Projection 为准。带条件的新输入仍未完成语义绑定及 requirement 修订。
- 验证：`cargo fmt -p goose` exit 0；`cargo check -p goose --lib` exit 0。首次 `cargo test -p goose --lib seventh_repair_batch -- --nocapture` 编译成功、断言 3/5，暴露 Windows 普通根路径与 canonical 目标路径基准不一致；统一规范化根路径后重跑同一过滤器 exit 0，5/5 通过，覆盖中文委派摘要、同文件复用/跨文件阻断、Paused run 恢复、未收口 child 阻断。没有运行全量测试、桌面构建或产品 E2E。
- 阶段仍未闭环：任务资源范围的 Durable 授权事件、条件续跑/目标替代、typed `ask_user` 用户选择、D01 顺序委派的真实产品因果、委派超时后的副作用对账及新版桌面验收均待实施或验证。当前二进制仍是旧 candidate，不能用于判断本段源码行为。

### 2026-09-23 `ask_user` 当前轮最小收口：未回答语义与权限边界

- 源码首偏离：`developer` 工具说明把“缺少授权”列为 `ask_user` 触发理由，并要求用户显式要求编辑前询问时调用它；主 Agent 指令却要求对具体动作走宿主权限卡。`ask_user` 只返回模型工具结果，不能提交工具授权。另 `ActionRequiredManager` 与桌面表单各以 300 秒结束等待，前者原先返回普通工具错误，后者返回 `cancel`；根任务此前没有稳定的“未回答不得完成”门槛。
- 本轮复用原有表单与权限链：工具说明改为仅在不可安全推断、无合理低风险默认的用户自有实质决定时调用；已授权工作、技术方案、scope 修改、可恢复工具故障与“是否继续”不属于此类。`Decline`/`Cancel` 映射为无答案的结构化结果，服务端超时保留 typed cause 并映射为无答案；均不给权限。由于现有 ACP 表单把客户端超时与取消都映射为 `cancel`，`cancelled_or_expired` 暂无法再细分，不伪造用户意图。
- Durable Main Agent 在当前轮记录未回答问题的 tool request ID：再次调用 `ask_user` 不再弹第二张表单，完成提议被具体 gap 拒绝，退出时经既有 `PauseRun` 写入 `awaiting_user_answer:<request-id>` 原因。同批结构化、非 shell 的只读文件操作可继续；依赖问题的其他 sibling 仍标 `NOT_RUN`。没有改权限审批、Reducer、UI 协议或新增状态库。
- 验证：`cargo fmt -p goose` exit 0；`cargo check -p goose --lib` exit 0；`cargo test -p goose --lib ask_user_flow -- --nocapture` exit 0，4/4；复用测试二次确认 `cargo test -p goose --lib ask_user -- --nocapture` exit 0，11/11，及 `cargo test -p goose --lib action_required_manager::tests -- --nocapture` exit 0，9/9。首次聚焦测试因新增测试夹具传入非 `'static` 的借用字符串编译失败，修正测试夹具后通过；相关 `git diff --check` exit 0，仅 LF/CRLF 转换提示。
- 明确未完成：提问等待期间模型仍被同步工具调用挂起，不能持续作新决策；桌面视觉与真实 E2E 未做。`PauseRun` event 有原因，但当前 RunProjection 不保留待答 question binding，`ResumeRun` 也不要求原问题的回答；因此超时后的晚答、跨轮/重启续跑及对该问题的持久完成拦截**没有闭环**，不能用本轮 transient ID 冒充持久合同。若要实现，须另行比较在现有 Durable event/Projection 中保存和解析问题身份的最小迁移，不能新增第二套 pending store。本段不是第七批整体完成或新版 candidate 已构建的证明。
- 收尾门禁：首次 `cargo clippy -p goose --lib -- -D warnings` 查出本批新增的完成函数参数过多；已合并同属一次完成核对的输入并清除该处告警，同时清理同一退出分支的无效 `as_deref`。复跑 Clippy 后本批触及逻辑无新增告警，但命令仍 exit 1，被 `codepro_terminal_report.rs`、`summon.rs`、`task_dag.rs`、`task_evidence.rs`、`tool_execution.rs`、`validation_invocation.rs`、`utils.rs` 合计 8 处共享工作树既有告警阻断；未为清零门禁越界改动无关模块。
- 上述收尾修改后的 `cargo test -p goose --lib ask_user_flow -- --nocapture` 再跑 exit 0，4/4 通过（用时 2 分 02 秒，断言阶段 <1 秒）。没有构建 Electron/`goose.exe`，未启动桌面，也没有产品 E2E。

### 2026-09-23 新 Candidate 构建与人工 E2E 交接

- 在当前 dirty worktree（HEAD `1d9a60af0f543fa7f160b87a9904cd7440a9c444`，**不是干净提交**）按 `ui/desktop/BUILD_AND_E2E_RUNBOOK.md` 执行 `pnpm.cmd run ensure-dev-backend`。首次因当前 PATH 找不到 `cmake` 在 `llama-cpp-sys-2` 构建脚本退出 1；复用 Visual Studio BuildTools 已安装的 `cmake.exe`，仅为构建进程设置 `CMAKE` 后重跑，Rust dev 后端构建 exit 0，用时 9 分 41 秒。未清理 Cargo 缓存、未修改依赖或业务源码。
- 停止已核对路径和 PID 的 2026-09-22 旧 Electron/goose 进程后，重跑 `ensure-dev-backend` 将新版同步到 `ui/desktop/src/bin/goose.exe`。`target/debug/goose.exe` 与桌面内置版 SHA-256 均为 `6436C20862B101374A0D38ED29A5CE468882482DBD7611B651EF617D0A5CC735`，版本 `1.43.0`；构建后二进制时间晚于 `crates/goose/src`、`crates/goose-cli/src` 全部 Rust 源码。
- 从 `ui/desktop` 执行 `pnpm.cmd run start-gui`：后端最新检查、SDK schema/TypeScript、i18n、Electron Forge 和 React ready 均完成；新 Electron 进程与内置 `goose.exe` 持续运行，renderer `127.0.0.1:5173` 与后端 `127.0.0.1:56108` TCP 可连。启动日志显示窗口初始工作目录继承旧 `C:\test\test_0922\codepro-sixth-repair-e2e`，**不能把该目录当新一轮干净夹具**。
- 用现有夹具生成脚本在新目的目录 `C:\test\test_0923\codepro-current-candidate-e2e` 创建隔离副本，没有覆盖旧目录。manifest 列 19 个文件；基线命令后文件哈希 19/19 与 manifest 相符。`npm.cmd test` 基线：N01 exit 0、4/4；N03 exit 1（`missing.test.js` 不存在）；M02 exit 1、4/5；D01 在非沙盒执行 exit 1、0/1（受限 shell 首次得到 `spawn EPERM`，不是夹具缺陷）。P01 与 X01 夹具也已创建，但未执行产品 E2E。
- 状态：**新版桌面 Candidate 已构建并启动，干净夹具已准备，可开始人工 E2E qualification；产品 E2E 尚未运行，不能标 PASS。** 需在桌面明确切换到上述新目录的各用例后执行，保存 session/run/ToolAudit 与权限卡真实选择。`ask_user` 超时后的晚答或跨重启绑定、本任务多文件一次授权，以及前述 Clippy 8 处共享工作树告警仍为已知边界；本次构建与启动不构成这些行为的通过证据。

### 2026-09-23 教务系统自由任务对抗复核与有界工具反馈收口

- 证据：`20260923_12` 的 56 次工具请求中，26 次写入有成功回执、12 次 shell 均未执行；唯一 `delegate` 在全部写入之后才请求安装依赖、测试及可写修复，并在创建子会话/注册 Worker 前因请求写域不被父任务覆盖而拒绝。用户中途外出吃饭的等待不计为 Agent 执行耗时。没有成功的子 Agent 运行，也没有产品测试通过的证据。
- 对抗结论：复杂任务不等于必须委派。该实现把主要路由集中在同一 `app.py`，并行写同文件可能增加冲突；早期只读独立审查可以按价值委派，但当前 Durable 委派仅同步执行，不能据此宣称并行省时。父权限与委托范围的子集检查是正确边界，不因这次失败而扩大权限。冻结计划中的按需并行工作图仍是未完成迁移，不把过渡能力写成已经实现。
- 首个可修复偏离：`agent.rs` 曾把不符合有界验证合同的简单 shell 请求送入用户审批，但 `tool_execution.rs::CodeProWorkspaceWriteGuard` 即使在用户批准后仍拒绝同一命令。现删除该无效审批分支与其遗留的只读模式参数，逐 action 返回已有结构化、可恢复的拒绝；同轮其他工具不被连坐。`ValidationInvocationError::Unsupported` 不再建议一个无法越过执行守卫的审批。没有扩大可执行命令、文件写域或子 Agent 权限。
- 委派提示改为如实说明：活动 Durable 任务只能同步委派；无父写域时仍可请求只读子任务，写入子任务不得借委派绕过 shell 或文件权限。仅修改既有工具描述与预检错误，不新增状态、事件、store 或默认委派门槛。
- 验证：`cargo fmt -p goose` exit 0；`cargo check -p goose --lib` exit 0。首次 `cargo test -p goose --lib bounded_worker -- --nocapture` 编译成功、7/8 通过，新断言把普通未知命令与不可信绝对路径包装器误当同一种拒绝；按实际分类修正断言后重跑同一目标 exit 0、8/8。既有同轮 compound shell 拒绝而 read 继续的单项回归 exit 0、1/1；移除遗留参数后再跑 `bounded_worker` exit 0、8/8。`git diff --check` 对本切片 tracked 文件 exit 0，仅提示未来 LF/CRLF 转换。尚未运行全量测试、Clippy、桌面构建或产品 E2E。
- 未闭环：Main Agent 尚未接入足以安全运行此项目 Python 冒烟脚本的有界执行/副作用审计；本次不通过新增字符串白名单放行任意脚本。`ComplexChange` 有真实写入但没有验证观察时仍可能达到最低完成门槛；不能将本次反馈修正说成完成真实性已修复。复杂任务是否委派、是否提高质量与效率需同夹具对照父子总调用、token、关键路径、产物与真实回执；不能用一次委派计数判定架构优劣。当前 HEAD `1d9a60af0f543fa7f160b87a9904cd7440a9c444`，工作树含既有未提交改动，本切片未提交/推送。
