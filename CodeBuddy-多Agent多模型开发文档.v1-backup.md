# CodeBuddy 多 Agent 多模型开发文档

## 1. 项目目标

在现有 CodeBuddy 基础上，实现**主 Agent 做规划、子 Agent 按角色用不同模型**的协作模式，核心目标是在保证代码质量的前提下降低 token 总消耗。

### 1.1 核心指标

| 指标 | 目标 |
|------|------|
| 角色划分 | Planner / Coder / Reviewer 三个角色 |
| 并发模型槽位 | 最多 5 个并发子任务（Ollama Max 套餐支持 10 个并发，保留余量） |
| 任务拆分 | 自动识别开发任务，Planner 拆分为可执行子任务 |
| 失败处理 | 单任务失败自动重试 1 次，仍失败则标记并汇总 |
| 闭环 | 需求 → 规划 → 编码 → 审查 → 报告 |

### 1.2 约束

- 子 Agent 不能创建子 Agent（现有机制已限制）。
- 每个子 Agent 只处理一个边界明确的任务。
- 主 Agent 依据任务执行结果和 Reviewer 结论判定完成，不只看文本声明。
- 所有模型选择、工具调用、失败重试必须记录日志。

---

## 2. 模型分配策略

### 2.1 角色与模型

| 角色 | 主力模型 | 备选模型 | 用途 |
|------|----------|----------|------|
| Planner | `gpt-oss:120b` | `gemma4:31b` | 需求理解、任务拆分、DAG 构建 |
| Coder | `kimi-k2.7-code` | `deepseek-v4-flash` | 具体编码，token 消耗大头 |
| Reviewer | `glm-5.2` | `minimax-m3` | 独立审查，必须与 Coder 不同模型家族 |

### 2.2 成本逻辑

```
Planner（1 次，小 token）
        │
        ▼
   Coder 1 ── Coder 2 ── Coder 3（高频、大 token）
        │       │       │
        └───────┼───────┘
                ▼
        Reviewer（1 次，小 token）
```

- **Coder 是 token 消耗大头**：一个编码任务可能几千到几万 token，使用代码专用模型最划算。
- **Planner 和 Reviewer 调用次数少、token 量小**：可以承担使用更大但更强模型的成本。
- **Reviewer 必须与 Coder 异模型家族**：避免“自己审自己”的确认偏误。

---

## 3. 整体架构

### 3.1 架构图

```
┌─────────────────────────────┐
│       Electron 桌面 UI       │
│        （现有，不改）          │
└──────────────┬──────────────┘
               │ ACP 协议
               ▼
┌─────────────────────────────┐
│         Main Agent          │
│  ┌───────────────────────┐  │
│  │   TaskDetector        │  │
│  │   判断是否为开发任务    │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │   ModelRouter         │  │
│  │   角色 → Provider/模型 │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │   PlannerAgent        │  │
│  │   dense 模型拆 TaskDAG │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │   TaskScheduler       │  │
│  │   按 DAG 调度子 Agent  │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │   ResultAggregator    │  │
│  │   汇总最终报告         │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 类型 | 职责 |
|------|------|------|
| TaskDetector | 新增 | 判断用户输入是否为开发任务，决定走单 Agent 还是多 Agent 流程 |
| ModelRouter | 新增 | 根据角色返回对应的 Provider 和 ModelConfig |
| PlannerAgent | 新增 | 用 dense 模型分析需求，输出结构化 TaskDAG |
| TaskScheduler | 新增 | 按 DAG 依赖调度子 Agent，控制并发和重试 |
| ResultAggregator | 新增 | 汇总所有子 Agent 输出，生成最终报告 |
| 子 Agent 执行层 | 复用 | `run_subagent_task` 保持不变，由调度层传入已选好的 Provider 和 ModelConfig |

**关键设计决策**：角色信息不侵入 `TaskConfig`，而是停留在调度层。调度层根据角色调用 `ModelRouter` 生成 `TaskConfig`，子 Agent 执行层只负责消费 `TaskConfig` 中已有的 `provider` 和 `model_config`。

---

## 4. 完整执行流程

### 4.1 用户输入触发

用户输入："给这个项目加一个用户登录功能"

```
        │
        ▼
┌─────────────────────────────────────┐
│  TaskDetector 判断                   │
│  开发关键词 + 涉及代码功能             │
│  → 判定为开发任务                     │
└─────────────────────────────────────┘
        │
        ▼
```

### 4.2 Phase 1：规划

Planner Agent（`gpt-oss:120b`）输入：
- 用户原始需求
- 当前仓库结构摘要

输出：结构化 TaskDAG，例如：

```json
{
  "tasks": [
    {
      "id": "task-1",
      "name": "创建用户模型和数据库迁移",
      "description": "...",
      "role": "coder",
      "depends_on": [],
      "acceptance_criteria": "模型文件存在且测试通过"
    },
    {
      "id": "task-2",
      "name": "实现登录 API 路由",
      "description": "...",
      "role": "coder",
      "depends_on": ["task-1"],
      "acceptance_criteria": "API 返回正确状态码"
    },
    {
      "id": "task-3",
      "name": "编写登录单元测试",
      "description": "...",
      "role": "coder",
      "depends_on": ["task-2"],
      "acceptance_criteria": "所有测试用例通过"
    }
  ]
}
```

### 4.3 Phase 2：编码

TaskScheduler 按 DAG 依赖顺序执行：

1. 第 1 轮执行 `task-1`（无依赖）。
2. 第 2 轮执行 `task-2`（依赖 task-1 完成）。
3. 第 3 轮执行 `task-3`（依赖 task-2 完成）。

每个 Coder Agent 使用 `kimi-k2.7-code`，失败时重试 1 次，仍失败则标记为 `Failed`。

### 4.4 Phase 3：审查

Reviewer Agent（`glm-5.2`）输入：
- 原始需求
- 所有 Coder Agent 的 Patch 和 Change Report
- 测试结果

Reviewer 必须直接读取源码 diff 和测试输出，不读取 Coder 的文本结论，保证独立判断。

### 4.5 Phase 4：汇总

ResultAggregator 生成最终报告：

```
📋 任务执行报告
├── ✅ task-1: 创建用户模型和数据库迁移
├── ✅ task-2: 实现登录 API 路由
├── ✅ task-3: 编写登录单元测试
├── 📝 Review: 通过（2 个建议）
└── 📊 统计
    ├── 总耗时: 45s
    ├── Planner: ~3K tokens (gpt-oss:120b)
    ├── Coder x3: ~45K tokens (kimi-k2.7-code)
    └── Reviewer: ~5K tokens (glm-5.2)
```

---

## 5. 数据模型

### 5.1 AgentRole

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentRole {
    Planner,
    Coder,
    Reviewer,
}
```

### 5.2 ModelRouterConfig

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRouterConfig {
    pub planner_provider: String,      // 例如 "ollama"
    pub planner_model: String,         // 例如 "gpt-oss:120b"
    pub planner_fallback_model: String, // 例如 "gemma4:31b"

    pub coder_provider: String,        // 例如 "ollama"
    pub coder_model: String,           // 例如 "kimi-k2.7-code"
    pub coder_fallback_model: String,  // 例如 "deepseek-v4-flash"

    pub reviewer_provider: String,     // 例如 "ollama"
    pub reviewer_model: String,        // 例如 "glm-5.2"
    pub reviewer_fallback_model: String, // 例如 "minimax-m3"
}
```

### 5.3 TaskNode 与 TaskDAG

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNode {
    pub id: String,
    pub name: String,
    pub description: String,
    pub role: AgentRole,
    pub depends_on: Vec<String>,
    pub acceptance_criteria: String,
    pub status: TaskStatus,
    pub output: Option<TaskOutput>,
    pub retry_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    Ready,
    Running,
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskOutput {
    pub patch: String,
    pub change_report: String,
    pub test_results: Option<String>,
    pub files_changed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDAG {
    pub tasks: Vec<TaskNode>,
    pub overall_goal: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl TaskDAG {
    pub fn ready_tasks(&self) -> Vec<&TaskNode> { ... }
    pub fn validate(&self) -> Result<(), String> { ... }
    pub fn topological_order(&self) -> Vec<&TaskNode> { ... }
    pub fn update_task(&mut self, id: &str, status: TaskStatus, output: Option<TaskOutput>) { ... }
}
```

### 5.4 ReviewVerdict

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewVerdict {
    pub verdict: Verdict,
    pub issues: Vec<ReviewIssue>,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Verdict {
    Pass,
    PassWithWarnings,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewIssue {
    pub level: IssueLevel,
    pub file: String,
    pub line: Option<u32>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IssueLevel {
    Error,
    Warning,
    Suggestion,
}
```

---

## 6. 关键代码逻辑

### 6.1 TaskDetector

```rust
impl TaskDetector {
    pub fn is_dev_task(input: &str) -> bool {
        let dev_keywords = [
            "加", "添加", "实现", "开发", "写", "改", "修改",
            "修复", "重构", "创建", "新增", "增加", "删除",
            "add", "implement", "create", "fix", "refactor",
            "build", "develop", "write", "change",
        ];

        let has_dev_keyword = dev_keywords
            .iter()
            .any(|kw| input.to_lowercase().contains(kw));

        let chat_patterns = ["你好", "hello", "谢谢", "什么是", "解释"];
        let is_chat = chat_patterns
            .iter()
            .any(|p| input.to_lowercase().contains(p));

        has_dev_keyword && !is_chat
    }
}
```

### 6.2 ModelRouter

`ModelRouter` 的职责是：根据角色，返回已实例化的 Provider 和对应的 ModelConfig。

```rust
use crate::providers;
use crate::model_config::model_config_from_user_config;

pub struct ModelRouter {
    config: ModelRouterConfig,
    extensions: Vec<ExtensionConfig>,
}

impl ModelRouter {
    pub fn new(config: ModelRouterConfig, extensions: Vec<ExtensionConfig>) -> Self {
        Self { config, extensions }
    }

    /// 根据角色返回 provider 名称和模型名称
    pub fn role_to_model(&self, role: AgentRole) -> (&str, &str) {
        match role {
            AgentRole::Planner => (&self.config.planner_provider, &self.config.planner_model),
            AgentRole::Coder => (&self.config.coder_provider, &self.config.coder_model),
            AgentRole::Reviewer => (&self.config.reviewer_provider, &self.config.reviewer_model),
        }
    }

    /// 根据角色创建 Provider 和 ModelConfig
    pub async fn resolve(
        &self,
        role: AgentRole,
    ) -> Result<(Arc<dyn Provider>, goose_providers::model::ModelConfig)> {
        let (provider_name, model_name) = self.role_to_model(role);

        let provider = providers::init::create(provider_name, self.extensions.clone()).await?;
        let model_config = model_config_from_user_config(provider_name, model_name)?;

        Ok((provider, model_config))
    }
}
```

**注意**：实际 Provider 创建接口为 `providers::init::create(name, extensions)`，返回 `Arc<dyn Provider>`；ModelConfig 通过 `model_config_from_user_config(provider_name, model_name)` 构造。

### 6.3 PlannerAgent

```rust
impl PlannerAgent {
    pub async fn plan(
        &self,
        goal: &str,
        repo_context: &str,
    ) -> Result<TaskDAG> {
        let system_prompt = self.build_system_prompt(repo_context);
        let user_message = format!(
            "请分析以下开发需求，并将其拆分为可执行的子任务：\n\n{}",
            goal
        );

        // 调用 Planner 模型
        let response = self.run_llm(&system_prompt, &user_message).await?;

        // 解析为 TaskDAG 并校验
        let dag: TaskDAG = serde_json::from_str(&response)?;
        dag.validate()?;

        Ok(dag)
    }
}
```

### 6.4 TaskScheduler

```rust
use tokio::sync::Semaphore;

pub struct TaskScheduler {
    max_parallel: usize,
    max_retries: u32,
}

impl TaskScheduler {
    pub async fn execute(
        &self,
        dag: &mut TaskDAG,
        router: &ModelRouter,
        parent_session_id: &str,
        parent_working_dir: &Path,
    ) -> Result<Vec<TaskNode>> {
        let semaphore = Arc::new(Semaphore::new(self.max_parallel));
        let mut results = Vec::new();

        loop {
            let ready: Vec<_> = dag
                .ready_tasks()
                .into_iter()
                .cloned()
                .collect();

            if ready.is_empty() {
                break;
            }

            let mut handles = Vec::new();
            for task in ready {
                let permit = semaphore.clone().acquire_owned().await?;
                let router = router.clone();
                let session_id = parent_session_id.to_string();
                let working_dir = parent_working_dir.to_path_buf();

                handles.push(tokio::spawn(async move {
                    let result = Self::execute_single_task(
                        task,
                        &router,
                        &session_id,
                        &working_dir,
                        self.max_retries,
                    )
                    .await;
                    drop(permit);
                    result
                }));
            }

            for handle in handles {
                let task = handle.await??;
                dag.update_task(&task.id, task.status, task.output.clone());
                results.push(task);
            }
        }

        Ok(results)
    }

    async fn execute_single_task(
        task: TaskNode,
        router: &ModelRouter,
        session_id: &str,
        working_dir: &Path,
        max_retries: u32,
    ) -> Result<TaskNode> {
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            match Self::run_subagent_for_task(&task, router, session_id, working_dir).await {
                Ok(output) => {
                    return Ok(TaskNode {
                        status: TaskStatus::Done,
                        output: Some(output),
                        retry_count: attempt - 1,
                        ..task
                    });
                }
                Err(e) if attempt <= max_retries => {
                    tracing::warn!(
                        "任务 {} 第 {} 次失败，准备重试: {}",
                        task.id, attempt, e
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                Err(e) => {
                    return Ok(TaskNode {
                        status: TaskStatus::Failed,
                        output: Some(TaskOutput {
                            patch: String::new(),
                            change_report: format!("失败原因: {}", e),
                            test_results: None,
                            files_changed: vec![],
                        }),
                        retry_count: attempt - 1,
                        ..task
                    });
                }
            }
        }
    }

    async fn run_subagent_for_task(
        task: &TaskNode,
        router: &ModelRouter,
        session_id: &str,
        working_dir: &Path,
    ) -> Result<TaskOutput> {
        let (provider, model_config) = router.resolve(task.role).await?;

        let task_config = TaskConfig::new(
            provider,
            model_config,
            session_id,
            working_dir,
            vec![], // 由上层传入实际 extensions
        );

        // 复用现有子 Agent 执行能力
        let params = SubagentRunParams {
            config: /* AgentConfig */,
            recipe: /* 包含 task.description 和 acceptance_criteria 的 Recipe */,
            task_config,
            return_last_only: false,
            session_id: session_id.to_string(),
            cancellation_token: None,
            on_message: None,
            notification_tx: None,
        };

        let result = run_subagent_task(params).await?;
        // 从 result 中解析 patch、change_report、test_results
        Ok(TaskOutput { ... })
    }
}
```

### 6.5 子 Agent 执行层无需修改

现有 `run_subagent_task` 接收 `SubagentRunParams`，其中 `task_config` 已包含 `provider` 和 `model_config`：

```rust
pub async fn run_subagent_task(params: SubagentRunParams) -> Result<String, anyhow::Error> {
    let agent = Arc::new(Agent::with_config(params.config));

    agent
        .update_provider(
            params.task_config.provider.clone(),
            params.task_config.model_config.clone(),
            &params.session_id,
        )
        .await?;

    // ... 后续逻辑保持不变
}
```

**关键点**：调度层在构造 `TaskConfig` 时已经按角色选好了 Provider 和 ModelConfig，子 Agent 执行层不需要知道“角色”概念，保持解耦。

### 6.6 Agent 主入口

```rust
impl Agent {
    pub async fn smart_reply(
        &self,
        user_message: Message,
        session_config: SessionConfig,
        cancel_token: Option<CancellationToken>,
    ) -> Result<BoxStream<'_, Result<AgentEvent>>> {
        let text = user_message.as_concat_text();

        if TaskDetector::is_dev_task(&text) {
            self.multi_agent_reply(user_message, session_config, cancel_token).await
        } else {
            self.reply(user_message, session_config, cancel_token).await
        }
    }

    async fn multi_agent_reply(
        &self,
        user_message: Message,
        session_config: SessionConfig,
        cancel_token: Option<CancellationToken>,
    ) -> Result<BoxStream<'_, Result<AgentEvent>>> {
        let goal = user_message.as_concat_text();
        let sid = session_config.id.clone();

        // 1. 获取仓库上下文
        let repo_context = self.gather_repo_context(&sid).await?;

        // 2. Planner 拆分任务
        let (planner_provider, planner_config) =
            self.model_router.resolve(AgentRole::Planner).await?;
        let planner = PlannerAgent::new(planner_provider, planner_config);
        let mut dag = planner.plan(&goal, &repo_context).await?;

        // 3. TaskScheduler 调度 Coder
        let scheduler = TaskScheduler::new(3, 1); // max_parallel=3, max_retries=1
        let task_results = scheduler
            .execute(&mut dag, &self.model_router, &sid, &self.working_dir)
            .await?;

        // 4. Reviewer 审查
        let (reviewer_provider, reviewer_config) =
            self.model_router.resolve(AgentRole::Reviewer).await?;
        let reviewer = ReviewerAgent::new(reviewer_provider, reviewer_config);
        let verdict = reviewer.review(&goal, &task_results).await?;

        // 5. 汇总报告
        let report = ResultAggregator::build_report(&dag, &task_results, &verdict);

        Ok(Box::pin(stream::once(async move {
            Ok(AgentEvent::Message(Message::assistant().with_text(report)))
        })))
    }
}
```

---

## 7. 配置项

### 7.1 模型路由配置

```yaml
model_roles:
  planner:
    provider: "ollama"
    primary: "gpt-oss:120b"
    fallback: "gemma4:31b"
  coder:
    provider: "ollama"
    primary: "kimi-k2.7-code"
    fallback: "deepseek-v4-flash"
  reviewer:
    provider: "ollama"
    primary: "glm-5.2"
    fallback: "minimax-m3"

task_execution:
  max_retries: 1
  max_parallel_coders: 3
  task_timeout_seconds: 600
  planner_timeout_seconds: 120
```

### 7.2 环境变量

| 变量 | 说明 |
|------|------|
| `GOOSE_SUBAGENT_MAX_TURNS` | 子 Agent 最大轮数，默认 25 |
| `GOOSE_MAX_TOKENS` | 全局最大 token 限制 |
| `GOOSE_CONTEXT_LIMIT` | 全局上下文限制 |

---

## 8. 分阶段实施计划

### Phase 1：基础设施

| 任务 | 产出 | 验证方式 |
|------|------|----------|
| 新增 `AgentRole` 和 `ModelRouterConfig` | 数据结构就绪 | 编译通过 |
| 实现 `ModelRouter` | 按角色返回 Provider + ModelConfig | 单元测试 |
| 实现 `TaskNode` / `TaskDAG` | 任务依赖图数据结构 | 单元测试：DAG 校验、拓扑排序、ready_tasks |
| 验证调度层可不改动子 Agent 执行层 | 子 Agent 用不同模型 | 集成测试 |

### Phase 2：核心流程

| 任务 | 产出 | 验证方式 |
|------|------|----------|
| 实现 `TaskDetector` | 自动识别开发任务 | 单元测试 |
| 实现 `PlannerAgent` | 输出合法 TaskDAG | 集成测试 |
| 实现 `TaskScheduler` | 按 DAG 调度，含并发和重试 | 集成测试 |
| 改造 `Agent::smart_reply` | 端到端多 Agent 流程 | 手工测试 |

### Phase 3：闭环完善

| 任务 | 产出 | 验证方式 |
|------|------|----------|
| 实现 `ReviewerAgent` | 独立审查 | 集成测试 |
| 实现 `ResultAggregator` | 汇总报告 | 集成测试 |
| 端到端测试 | 完整闭环 | 真实仓库 5 个任务 |

### Phase 4：优化与试运行

| 任务 | 产出 | 验证方式 |
|------|------|----------|
| 日志和审计 | 决策可追溯 | 检查日志 |
| 错误处理完善 | 边界情况覆盖 | 异常测试 |
| 性能优化 | 并行 Coder | 对比串行 vs 并行 |
| 文档完善 | 使用手册 | 可复现 |

---

## 9. 测试计划

### 9.1 单元测试

| 测试项 | 内容 |
|--------|------|
| TaskDetector | 开发输入返回 true，聊天输入返回 false |
| ModelRouter | 各角色返回正确 provider 和 model |
| TaskDAG | 循环依赖检测、拓扑排序、ready_tasks |
| TaskScheduler | 依赖顺序执行、失败重试、最终标记 Failed |
| 序列化 | TaskNode / TaskDAG / ReviewVerdict 的 JSON 正反向 |

### 9.2 集成测试

| 测试项 | 内容 |
|--------|------|
| Planner 拆分 | 输入真实需求，输出合法 TaskDAG |
| Coder 执行 | 子 Agent 用指定模型完成编码任务 |
| Reviewer 审查 | 输入 patch 和需求，输出独立审查意见 |
| 完整流程 | 需求 → 规划 → 编码 → 审查 → 报告 |

### 9.3 验收测试

1. 给项目添加一个简单的 API 端点。
2. 修复一个已知的 bug。
3. 重构一个函数，保持功能不变。
4. 给现有功能添加单元测试。
5. 添加一个新的配置项。

---

## 10. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Planner 拆分质量差 | 后续任务无法执行 | 提供示例格式提示词；拆分后校验 DAG |
| 模型输出格式不稳定 | JSON 解析失败 | 加 Schema 校验；解析失败时重试一次 |
| Coder 修改了不该改的文件 | 代码被破坏 | 权限系统控制文件范围；Reviewer 检查 diff |
| 多个 Coder 并发修改同一文件 | 冲突 | 写同一文件的任务串行或工作树隔离 |
| Ollama Cloud 配额用尽 | 流程中断 | 监控配额；接近上限时切换备选模型 |
| 单次任务耗时过长 | 体验差 | 设置超时；流式返回进度 |

---

## 11. 提示词设计要点

### 11.1 Planner 系统提示词

- 角色：需求分析专家。
- 输入：用户需求 + 仓库结构。
- 输出：JSON 格式 TaskDAG。
- 要求：
  - 每个任务边界明确，只做一件事。
  - 依赖关系最小化，能并行尽量并行。
  - 每个任务附验收标准。
  - 拆分粒度：一个任务对应一个文件或一个模块。

### 11.2 Reviewer 系统提示词

- 角色：独立代码审查员。
- 输入：原始需求 + 所有 Patch + 测试结果（不读 Coder 文本结论）。
- 输出：JSON 格式 ReviewVerdict。
- 检查项：
  - 需求是否完整覆盖。
  - 代码正确性（逻辑错误、边界条件）。
  - 安全性（注入、权限、敏感信息）。
  - 可维护性（命名、结构）。
