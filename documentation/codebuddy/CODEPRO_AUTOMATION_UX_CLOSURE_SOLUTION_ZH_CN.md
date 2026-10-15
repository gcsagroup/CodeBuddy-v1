# CodePro 自动化执行与用户体验闭环方案

[繁體中文（預設）](CODEPRO_AUTOMATION_UX_CLOSURE_SOLUTION_ZH_TW.md) · [简体中文](CODEPRO_AUTOMATION_UX_CLOSURE_SOLUTION_ZH_CN.md) · [English](CODEPRO_AUTOMATION_UX_CLOSURE_SOLUTION_EN.md)

## 一句话结论

目前看到的“停止、失败、根目录报错、设置稍后才出现、只有部分步骤有进度、报告格式不一致”不是几个互不相关的小问题，而是执行状态、恢复动作、公开进度和最终报告尚未使用同一份数据合同。解决办法不是隐藏错误文字，而是建立一条可持久化、可恢复、可观察且由后端事实驱动的完整执行链。

## 范围与边界

本方案解决四类问题：

1. 普通验证失败、缺少工具或权限不足时，任务过早显示“失败/停止”。
2. 用户在磁盘根目录创建对话或要求创建新项目时，系统没有自动创建并绑定项目子目录。
3. 打开“高级模型路由”时，选项先不完整，稍后才突然出现。
4. Planner、Coder、Tester、Reviewer 的公开工作进度和最终报告格式不一致。

本方案不承诺“永远没有错误”。真正不可恢复的程序崩溃、数据损坏或重试预算耗尽仍必须如实告知用户。要消除的是把可恢复情况错标为终止性失败，以及让用户长时间看不到进度。

## 已核对的当前事实

- `task_scheduler.rs` 已能产生 `VerificationFailed`、`WaitingForUser`、`InfrastructureFailed` 等结果，但仍有路径把基础设施问题收敛为一般 `Failed`，或把无进展转成不可恢复人工审查。
- `worker_activity_callback` 转发原始 Agent 消息时只保留确认与询问内容；工具活动能另外产生摘要，但并非每个角色、每个阶段都有一致的公开进度事件。
- `codeProActivityModel.ts` 仍保留依靠“已停止/stopped”等文字猜测状态的旧路径，UI 可能与后端真实状态不一致。
- 根目录目前被视为项目分组与默认工作目录，允许继续执行；但新项目子目录的创建与绑定只在部分 `NeedsWorkspace` 流程中完成，合同不一致。
- `CodeProModelModal.tsx` 先加载 Provider、设置和默认值，再等待多个 Provider 的模型发现；慢 Provider 会延后完整选项的呈现。
- 分析、简单修复、DAG 聚合、终态和 Report Writer 仍有多个报告入口，虽然部分已共享结构化事实，但用户可见版式尚未完全统一。

## 统一目标模型

```text
用户请求
  -> Intent + WorkspaceDecision
  -> RunState + RecoveryAction
  -> PublicProgressEvent
  -> UserReport
```

### 1. 状态和恢复动作分离

统一状态：`Running`、`VerificationFailed`、`Repairing`、`Retesting`、`WaitingForUser`、`WaitingForEnvironment`、`Succeeded`、`Cancelled`、`Exhausted`、`Fatal`。

统一恢复动作：`RetrySameStep`、`RepairThenRetest`、`AskUserThenResume`、`DiagnoseEnvironment`、`Replan`、`Finish`。

规则：

- 命令无法启动先诊断工具、PATH、运行时和权限，不直接标成项目测试失败。
- 测试退出码非零时保存命令、cwd、输出引用和失败测试，进入 Coder，再重跑完全相同的命令。
- 权限、登录、下载或范围扩大时保存检查点并询问；批准后恢复原步骤。
- 只有用户取消、预算耗尽或无法安全恢复时才显示终止状态。

### 2. 根目录自动创建项目子目录

根目录（如 `D:\`）只是项目容器。当用户要求创建项目时：

1. 生成安全且无冲突的子目录，例如 `D:\academic-management-system`。
2. 原子完成建目录、workspace lease、绑定和检查点保存。
3. 在新目录续跑原始消息，不再要求第二次工作区确认。
4. 只有多个候选会导致不同实质结果时才询问用户。
5. 权限不足时进入 `WaitingForUser`，说明路径和所需操作，不显示项目失败。

“分析并给优化方向”必须保持只读，不得被当作修改请求。

### 3. 每个角色统一发布公开进度

每个 Planner、Coder、Tester、Reviewer 都发布同格式 `PublicProgressEvent`：角色、阶段、任务与尝试 ID、公开摘要、当前命令或文件、开始/最近活动时间、耗时、完成数、下一步和等待原因。

UI 默认显示一句摘要、耗时和心跳；展开后显示公开步骤、命令进度、增量输出和等待原因。10 秒没有新输出只显示“仍在执行”，不能自行判定卡死。旧文字事件只能兼容展示，不能驱动新任务状态。

不直接展示私有思维链、系统提示词、密钥或模型草稿。OpenAI 官方文件支持在工具调用前使用简短、用户可见的 preamble，并提供 reasoning summary；CodePro 采用“公开摘要 + 工具进度”而非隐藏推理全文。参考：[OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model#preambles)。

### 4. 高级模型设置渐进式加载

- 弹窗打开后立即使用持久化快照显示四个角色和上次选择。
- Provider 列表、默认设置和各 Provider 模型列表分别加载。
- 每个 Provider 完成后立即更新自己的下拉框，不等待最慢项。
- 每个下拉框独立显示 `loading / ready / unavailable / retrying`。
- Provider 列表完成前可先显示已保存组合；完成后如 Provider、连接或模型失效，立即清空整组旧覆盖并回到当前模型。
- 使用 generation id 丢弃过期请求结果，避免旧结果覆盖新选择。
- 新建但尚未保存的高级组合可按 Provider 单独重试；已持久化组合只要一个角色失效，就不再声明该组合有效。

### 5. 单一模型权威与切换事务

- 默认界面只显示一个“当前模型”，普通切换会关闭高级路由，让所有角色跟随同一 provider/model。
- 高级模式必须显式开启；每个角色只显示“实际模型”和“独立设置”，不再并列默认、推荐或另一当前值。
- 普通切换使用单调修订号串行化；过期提交标记为 superseded，最终由最新提交决定。若会话已切换但默认配置保存失败，则补偿回滚会话和高级路由。
- 每个 CodePro 任务开始时创建路由快照，所以运行中的任务不换模型；新配置从下一个任务生效。
- `ActivityEvent.effective_model` 是执行审计权威，活动详情直接显示该值。
- Provider 删除或模型列表更新会在后端清除引用失效项的高级路由；UI 发现失效连接时执行同一回退。

### 6. 统一最终报告

建立唯一的 `UserReportV1`，固定顺序：

1. 一句话结果。
2. 做了什么（最多五条）。
3. 验证结果。
4. 需要用户做什么（没有则隐藏）。
5. 技术详情（折叠）：命令、cwd、退出码、证据引用和运行 ID。

测试失败、缺少工具或等待权限不能写成“限制”；内部错误码不能进入正文；模型自述不能覆盖宿主验证；没有运行测试时不能声称“已通过”。

## 实施顺序

- **P0 自动修复主链：** 失败证据 → Coder 修改 → Tester 原命令重测；区分缺少工具、权限和取消。
- **P1 结构化 UI 状态：** ACP/SDK/UI 使用同一状态与进度事件，移除新任务的文字猜测。
- **P2 根目录原子建项目：** 统一 RootContainer、NeedsWorkspace、lease 和续跑合同。
- **P3 渐进式模型发现：** Provider 独立加载、重试、缓存和取消过期请求。
- **P4 报告收敛：** `UserReportV1` 成为唯一用户可见渲染合同，旧入口仅提供结构化事实。

## 必须验收的用户场景

1. 测试首次退出 1，显示“正在修复”，Coder 修改后原命令退出 0。
2. Node 不存在时说明依赖/PATH 问题并给恢复入口，不标成项目 Bug。
3. 读取工作区外文件时保存检查点并询问，批准后原地续跑。
4. 在 `D:\` 创建项目时自动建立安全子目录，不进行第二次工作区确认。
5. “分析并给优化方向”全程不写文件。
6. 四种 Agent 每一步都有可展开进度，长命令持续显示心跳和最近输出。
7. 一个 Provider 很慢或失败时，其他模型选项仍可立即使用。
8. 分析、修复、测试报告使用同一结构和直白状态词。
9. 只有修复预算耗尽后才显示“未能自动修好”，并保留续跑入口和证据。
10. API、持久化事件、SDK、UI 与报告对同一 run 的状态解释一致。

## 完成标准

- 后端状态机和真实自动修复链测试通过。
- ACP Schema/SDK 重新生成并通过兼容性检查。
- UI 组件测试覆盖进度、等待、模型加载和报告。
- 在真实 Windows 桌面完成全部用户场景。
- 重启后仍能恢复等待状态、修复轮次、模型选择和公开进度。
- 新任务不再通过本地化文字猜测状态。
