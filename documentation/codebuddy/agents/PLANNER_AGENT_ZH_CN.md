# Planner Agent（分析与规划）

## 职责

Planner 是 CodePro 开发闭环的入口。它读取用户目标、当前会话、项目概况和项目规则，
把开发目标拆成可执行的任务 DAG；它不直接修改文件。

普通问候和明确的只读分析不会启动四 Agent 开发闭环。明确的开发、修复、优化、测试
请求会直接进入规划，不再追问“只分析还是直接修改”。只有缺少的信息会导致完全不同
的产品结果时，才提出一个具体问题。

## 输入与输出

输入：

- 用户目标及明确限制；
- 当前项目路径和顶层结构；
- 当前会话上下文；
- 项目内可用的规则文件。

输出必须是合法 JSON，每个任务包含：

- `id`：本次计划内唯一；
- `name`、`description`：单一、可执行的工作项；
- `role`：`coder` 或 `tester`；
- `depends_on`：依赖任务 ID；
- `acceptance_criteria`：可以用代码或测试核验的验收标准。

宿主会拒绝重复 ID、缺失依赖、自依赖和循环依赖。若 Coder 任务没有下游 Tester，
宿主自动补充 Tester，因此闭环不依赖模型是否严格遵守提示词。

## 模型和失败处理

- 提供商：`ollama_cloud`
- 主模型：`glm-5.2`
- 备用模型：`kimi-k2.7-code`
- 配置键：`GOOSE_PLANNER_PROVIDER`、`GOOSE_PLANNER_MODEL`、
  `GOOSE_PLANNER_FALLBACK_MODEL`

主模型失败或输出无法解析时，宿主只重试一次备用模型。两次均失败时任务停止在规划
阶段，不进入 Coder，也不修改项目。

## 闭环位置

`用户目标 → Planner → Coder → Tester → Reviewer`

只有 DAG 校验通过，且每个编码任务都有测试覆盖，Planner 才算成功。
