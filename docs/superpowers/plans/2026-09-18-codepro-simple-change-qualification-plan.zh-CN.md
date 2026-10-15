# CodePro `simple_change` 资格收紧计划

## 已确认根因

- 语义路由把“明确限制为一个现有文件”近似成“可以直接完成”，并通过 `direct_change_target` 选择 `simple_change`。
- 宿主目前只校验目标文件存在、位于工作区且不是敏感文件，没有校验用户是否要求前置验证、条件式写入或多个有序阶段。
- `simple_change` 的执行提示只承诺一次最后写入后的验证，无法完整覆盖“先测试 → 根据失败分析 → 修改 → 再测试”的任务。
- Windows 用户输入 `npm.cmd test` 时，受限 Shell 不接受该命令；安全的 Host Tester 实际应把它规范化为逻辑命令 `npm test`，再解析到受信任的 npm CLI，而不是直接执行工作区可劫持的 `.cmd`。

## 采用方案

保留 `simple_change` 作为低延迟、单目标、受限写入的快路径，但把资格判断改为结构化执行状态，而不是宿主重新解释自然语言。

1. 语义路由增加内部执行形态：`direct` 或 `staged`。
2. 只有 `intent=change`、执行形态为 `direct` 且存在合法 `direct_change_target` 时，模型结果才有资格进入快路径。
3. 语义路由负责把前置验证、条件式写入、有序多阶段、阶段间决策或修改前后重复验证表示为 `staged`。宿主只消费这个结构化结果，不再用“先/再/最后”、编号或其他字符串规则二次判断意图。
4. 缺失或未知执行形态按非直达处理；宿主仍只校验目标路径、授权和运行状态等确定事实。
5. 将用户明确要求的 `npm.cmd test` 规范化为 `npm test`，只供 Host Tester 的受信任命令解析使用；不把 `.cmd` 加入通用 Shell 白名单。

## 不修改

- 不删除 `simple_change`。
- 不改变 ACP 活动事件、路由证据或 UI 类型协议。
- 不改变普通 `Change` DAG、任务状态或终态状态语义。
- 不放宽工作区写保护、Shell 组合语法或外部命令权限。
- 不修改当前上下文压缩生命周期实现。

## 影响文件

- `crates/goose/src/agents/codepro_intent.rs`
  - 语义路由执行形态；
  - Windows npm 命令规范化；
  - 回归测试。
- `crates/goose/src/agents/agent.rs`
  - 继续只消费语义结果中已获准的 `direct_change_target`，不新增自然语言启发式。
- 现有测试若依赖旧语义 JSON，需要补充 `change_execution` 字段。

## 验收证据

1. 直接单文件修改加一次修改后验证仍路由到 `SimpleChange`。
2. 本次真实请求“初始测试 → 分析 → 修改 → 复读 → 回归测试”路由到普通 `Change`。
3. 缺少 `change_execution` 或返回 `staged` 时，即使同时带有目标文件也不会进入快路径。
4. `npm.cmd test` 被规范化为 `npm test`，但带管道、重定向或命令拼接的输入仍不获得执行授权。
5. 运行 `cargo fmt` 并按项目构建文档完成相关构建；桌面真实行为由后续 E2E 验收。
