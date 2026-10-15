# CodePro Coordinator / Control Plane Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CodePro 渐进迁移为由主 Coordinator 负责语义决策、Rust Control Plane 负责权威状态与执行、独立 Worker 负责有界任务的 Windows 桌面开发 Agent。

**Architecture:** 先关闭当前证据和路径缺陷并冻结可恢复基线，再依次引入版本化协议、事件存储、Control Plane、Coordinator 影子/建议/权威模式、桌面细粒度控制与崩溃恢复。旧路径始终位于功能开关后，只有通过两个连续候选版本的门禁后才允许删除。

**Tech Stack:** Rust、Tokio、Serde、JSON Schema、Agent Client Protocol、React、TypeScript、Electron、Vitest、Cargo test、Windows 进程控制。

## Global Constraints

- Windows 优先；真实安装版是最终验收环境。
- Coordinator 只产生结构化决策候选，不直接执行工具、批准权限、终止进程或修改权威状态。
- Rust Control Plane 是唯一权威状态和执行入口。
- 首版嵌套委派深度为 `0`；Worker 通过 `AssistanceRequest` 请求同级协助。
- 同时运行 Worker 最多 `4`，默认同时写入 Worker 为 `1`。
- 基础设施自动重试最多 `2` 次；Coordinator 格式修复最多 `1` 次；同一语义问题返工最多 `2` 轮。
- 所有协议和持久化格式版本化；未知高版本拒绝写入并进入只读恢复。
- 不静默切换 Provider；未通过能力门禁的模型不得进入 `authoritative`。
- 每个行为变更先写失败测试，再实现最小修复；每个可验收切片独立提交。
- 不把 `agent.rs`、`task_scheduler.rs` 或 UI 大文件继续扩成新的控制中心；新生产文件目标少于 800 行，超过 1,000 行必须拆分。
- 当前 `documentation/` 变化不与控制架构提交混合。

---

## Dependency Graph

```text
U-74F evidence/path repair
  -> G0 recoverable baseline
  -> U-75 protocol extraction
  -> U-76 event store + projections
  -> U-77a reducer/run engine
  -> U-77b lifecycle/cancellation
  -> U-77c failure policy/dispatcher
  -> U-77d convergence/legacy adapters
  -> U-78 shadow coordinator
  -> U-79 advisory coordinator
  -> U-80 authoritative coordinator
  -> U-81 desktop controls
  -> U-82 recovery/evals/Windows RC
  -> G6 default enable
```

## Planned Module Map

| Module | Responsibility |
|---|---|
| `crates/goose/src/agents/protocol/` | IDs、命令、事件、Worker 结果和协议版本 |
| `crates/goose/src/agents/control_plane/` | reducer、RunEngine、生命周期、Dispatcher、失败策略、收敛和恢复 |
| `crates/goose/src/agents/coordinator/` | 上下文构建、Prompt、Schema 校验和决策 |
| `crates/goose/src/agents/workers/` | Worker 合同、注册表、句柄、运行和协助请求 |
| `crates/goose/src/agents/task_graph/` | 图结构、修订、依赖校验和文件所有权 |
| `crates/goose/src/agents/reporting/` | 事件投影、用户报告和技术报告 |
| `crates/goose/src/acp/` | 版本化运行、任务和 Agent 事件输出 |
| `ui/desktop/src/codepro/` | ACP 投影模型和控制命令客户端 |
| `ui/desktop/src/components/codepro/` | 任务、Agent、证据和运行控制 UI |

## Phase 0 — U-74F: Emergency Baseline Repair

Detailed plan: `docs/superpowers/plans/2026-08-05-codepro-u74f-baseline-repair.md`

### Task 0.1: Preserve and qualify the inherited working tree

**Acceptance criteria:**

- [ ] `crates/` 与 `ui/` 的当前成果形成一个明确标记的恢复提交，且不包含 `documentation/`。
- [ ] Rust 格式、目标 Rust 测试、UI typecheck、Vitest、lint 和 distribution tests 全部有新鲜证据。
- [ ] 暂存差异没有凭据样式赋值，提交后可用单个 commit 恢复。

### Task 0.2: Make workspace evidence authoritative for indirect writes

**Acceptance criteria:**

- [ ] Git 与非 Git 项目都能检测未通过文件工具声明的新增、修改和删除。
- [ ] Shell、MCP 或外部工具写入不依赖模型报告即可进入 `files_changed`。
- [ ] 敏感文件只报告路径，不读取到模型上下文。

### Task 0.3: Make the selected project path canonical end-to-end

**Acceptance criteria:**

- [ ] 执行、证据、状态、恢复和最终报告使用同一个规范化项目路径。
- [ ] Windows 路径不暴露 `\\?\` 前缀，不创建 CodePro 影子项目。
- [ ] 路径不匹配的旧检查点拒绝继续，不会写入另一个项目。

### Task 0.4: Freeze G0

**Acceptance criteria:**

- [ ] 工作树中的产品代码和对应文档都有明确归属，未知文件数为 `0`。
- [ ] G0 命令及结果写入基线记录。
- [ ] 从 G0 commit 能重建并重新运行相同门禁。

## Phase 1 — U-75/U-76: Protocol and Event Foundation

### Task 1.1: Extract versioned protocol types

**Files:**

- Create: `crates/goose/src/agents/protocol/{mod.rs,identifiers.rs,events.rs,outcomes.rs,commands.rs,versioning.rs}`
- Modify: `crates/goose/src/agents/mod.rs`
- Test: `crates/goose/tests/codepro_protocol_contract.rs`

**Produces:** `RunId`, `TaskId`, `AgentId`, `EventId`, `RunState`, `TaskState`, `AgentState`, `RunEvent`, `WorkerOutcome`, `CoordinatorDecisionCandidate`.

**Acceptance criteria:**

- [ ] 非法状态转换、未知协议版本和跨 Run 证据引用被拒绝。
- [ ] v1 事件 JSON fixture 可稳定往返序列化。
- [ ] 提取只增加适配，不改变用户可见行为。

### Task 1.2: Add append-only event storage

**Files:**

- Create: `crates/goose/src/agents/control_plane/event_store.rs`
- Modify: `crates/goose/src/agents/codepro_event_log.rs`
- Test: `crates/goose/tests/codepro_run_event_store.rs`

**Produces:** `RunEventStore::append(expected_sequence, events)` and `RunEventStore::load(run_id)`.

**Acceptance criteria:**

- [ ] 单写者序号冲突返回 typed error，不覆盖已有事件。
- [ ] 截断 JSONL、重复事件和未知版本可检测。
- [ ] 10,000 条事件回放耗时被记录，未达标标记 `NOT_MEASURED` 或阻断。

### Task 1.3: Build deterministic projections and dual-read reconciliation

**Files:**

- Create: `crates/goose/src/agents/reporting/projection.rs`
- Modify: `crates/goose/src/agents/codepro_state_store.rs`
- Test: `crates/goose/tests/codepro_projection_replay.rs`

**Acceptance criteria:**

- [ ] 相同事件序列总是产生相同 Run/Task/Agent 投影。
- [ ] 影子阶段记录新投影与旧状态差异但不改变旧路径。
- [ ] 投影删除后可从事件完整重建。

## Phase 2 — U-77: Rust Control Plane

### Task 2.1 — U-77a: Reducer and RunEngine skeleton

**Files:** Create `control_plane/{mod.rs,reducer.rs,run_engine.rs,effects.rs}`.

**Acceptance criteria:** command -> validated event -> projection -> effect 顺序固定；LLM 和 UI 无权直接追加状态事件。

### Task 2.2 — U-77b: Worker lifecycle and cancellation

**Files:** Create `control_plane/lifecycle.rs`, `workers/{mod.rs,handle.rs,runner.rs}`; adapt `subagent_handler.rs`.

**Acceptance criteria:** 支持 StopWorker、CancelTask、CancelBranch、PauseRun、EmergencyStop；迟到成功不能覆盖取消终态；Windows 子进程树被回收。

### Task 2.3 — U-77c: Failure policy and dispatcher

**Files:** Create `control_plane/{failure_policy.rs,dispatcher.rs}`; adapt `task_scheduler.rs`.

**Acceptance criteria:** 只有 `TransientInfrastructure` 自动重试；语义失败等待 Coordinator；权限拒绝不能换工具绕过。

### Task 2.4 — U-77d: Convergence and legacy adapters

**Files:** Create `control_plane/convergence.rs`, `task_graph/{mod.rs,graph.rs,validation.rs,ownership.rs,revision.rs}`; adapt `task_dag.rs` and `result_aggregator.rs`.

**Acceptance criteria:** 完成由证据覆盖和未决风险决定；行动上限只触发暂停/失败，不构成成功；旧 Scheduler 仅执行 Ready 任务。

## Phase 3 — U-78/U-79/U-80: Coordinator Rollout

### Task 3.1: Build bounded CoordinatorContext

**Files:** Create `coordinator/{mod.rs,context.rs,prompt.rs}`.

**Acceptance criteria:** 总输入满足 16k/20% 双上限；裁剪不删除目标、开放权限、未决高风险和 `Uncertain`；裁剪决策可审计。

### Task 3.2: Validate Coordinator decisions

**Files:** Create `coordinator/{decision.rs,validation.rs,coordinator.rs}`.

**Acceptance criteria:** 一次格式修复后仍非法则安全暂停；越权决策无 effect；所有决策引用当前 Run 证据。

### Task 3.3: Enable shadow mode

**Acceptance criteria:** Coordinator 决策写审计但不执行；与旧路径逐场景比较；生产行为保持不变。

### Task 3.4: Enable advisory mode

**Acceptance criteria:** 仅低风险语义修复可执行；写入范围和权限仍走现有安全链；一键切回 shadow/off。

### Task 3.5: Enable authoritative mode

**Acceptance criteria:** 动态计划、Worker 替换和 Reviewer 返工进入统一决策协议；未通过能力门禁的模型被拒绝；旧路径仍可即时回退。

## Phase 4 — U-81: Desktop Control Surface

### Task 4.1: Add versioned ACP run events

**Files:** Modify `crates/goose/src/acp/`; regenerate `ui/sdk/src/generated/`; test ACP schema compatibility.

### Task 4.2: Add desktop projection store

**Files:** Create `ui/desktop/src/codepro/{runProjection.ts,runCommands.ts}`; modify ACP notification adapter.

### Task 4.3: Add Agent/task/evidence panel

**Files:** Modify `ui/desktop/src/components/codepro/`; add Vitest and browser tests.

### Task 4.4: Add fine-grained controls and runtime steering

**Acceptance criteria:** 单 Worker、任务、分支、暂停和紧急停止均可从 UI 发出并显示最终状态；只读状态查询不打断运行。

## Phase 5 — U-82: Recovery, Evals, and Windows Release Candidate

### Task 5.1: Recover incomplete runs and uncertain effects

**Files:** Create `control_plane/recovery.rs`; add replay and crash fixtures.

### Task 5.2: Migrate old sessions and preserve rollback

**Acceptance criteria:** 旧会话可读；不支持的数据进入只读导出；新版本数据不被旧路径错误写入。

### Task 5.3: Qualify provider/model combinations

**Files:** Create versioned eval fixtures and a runner under `crates/goose/tests/fixtures/coordinator/` and `scripts/`.

**Acceptance criteria:** 每个组合独立产生 Schema、语义、安全、成本和延迟报告；不合格组合自动限制模式。

### Task 5.4: Run Windows RC gate

**Acceptance criteria:** 安装、首次启动、真实 Provider、Git、非 Git、MCP、暂停、取消、恢复、升级、回退、卸载和 24 小时稳定运行全部有证据。

## Release Gates

| Gate | Required evidence |
|---|---|
| G0 | 可恢复 commit、干净产品工作树、Rust/UI 全量门禁 |
| G1 | 协议、事件、投影和迁移合同通过 |
| G2 | Shadow 决策完整且不改变旧行为 |
| G3 | Advisory 能修复目标场景且不扩大权限 |
| G4 | Authoritative 达到模型能力、安全和回滚门槛 |
| G5 | Windows RC 生命周期与 24 小时稳定性通过 |
| G6 | 两个连续候选版本无阻断回归，得到删除旧路径的单独批准 |

## Execution Policy

- 每个 Phase 开始前，从本路线图提取一份独立详细计划；详细计划必须包含失败测试、精确接口、运行命令和原子提交。
- Phase 内可并行的只有不共享生产文件的只读研究、fixture 和 UI 原型；协议、状态机、持久化迁移和生成 SDK 必须顺序执行。
- 任一门禁失败立即停止后续 Phase，修复当前切片并重新运行该门禁；不得把失败留给后续任务。
- U-74 GitHub 日志与制品下载在 G5 前保持暂停。
