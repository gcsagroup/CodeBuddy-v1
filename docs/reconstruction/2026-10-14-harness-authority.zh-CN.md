# Harness 执行与目标权威迁移

日期：2026-10-14。目录：`D:\CodeBuddy-v1`，无 Git 仓库、分支、提交或推送；来源基线保存在 [source-baseline.json](source-baseline.json)。本记录对应当前未提交源码，不把此前预览的测试或旧桌面进程当作本次产品验收。

[繁體中文](2026-10-14-harness-authority.zh-TW.md) · [English](2026-10-14-harness-authority.en.md)

## 证据与批准边界

用户报告新对话慢、答案集中出现及普通问候被标为中断，并批准由官方 Harness 主导执行和调度，CodeBuddy 保留必要适配。原始会话 `c4117cd6-e198-4d7a-8ada-6ffdbd15ea85` 在北京时间 19:07:30 与 19:09:27 的原生 `turn/end` 均为 `completed`，旧适配却因缺少 `codebuddy_task(answer)` 把该轮标成中断。19:13:26 的同会话是独立的 `TRANSPORT / Connection error.`，不归入同一完成协议缺陷。

本次移除新会话对自造 `submit_plan/start_task/task_result/propose_finish/answer` 的依赖，采用已安装的官方 `0.2.1-alpha.2` 插件。用户后续明确前端可为后端权威让路；本切片不增加第二套调度协议。

## 事实来源与实现

| 事实 | 唯一执行或记录来源 | CodeBuddy 的职责 |
|---|---|---|
| 接受消息、模型循环、工具与子 Agent 调度 | Harness Session Controller、AgentLoop、subagent | ACP 与旧前端字段转换、模型路由和权限适配 |
| 长目标及自动续轮 | 官方 goal、tool-goal、goal-round-driver | 消费 `goal/change` 与最终原生状态；不自己排续轮 |
| 当前轮清单 | 官方 `todo/write` 全量快照；`turn/start` 清空当前清单 | 转为旧 UI 清单；显示 ID 只标识该快照，不发明 DAG 依赖 |
| 工具效果 | 原生工具实际结构化回执 | 保存展示/恢复引用；没有任务登记也可记录，不用展示层阻止调度 |
| 暂停、恢复、重启 | Harness 原生生命周期与进程内 activation | 将已有按钮和消息操作接到原生控制，保留用户会话 ID 与历史 |

`codepro.mjs` 为新运行记录 `executionOwner: harness`。`beginAttempt` 可显式迁移旧运行 owner，旧事件前缀原样保留；未知工具效果仍展示，继续前可以先检查当前文件，不自动重放旧调用。旧门禁实现只保留历史合同及兼容回归用途，不注入新会话。

`finishHarnessAttempt` 区分：无目标的原生正常轮次是 `harness_turn`；已完成原生目标是 `harness_goal`；仍 active 的目标、取消及行动/输出限制保留暂停；真实模型传输错误保留失败及错误代码。`harness_turn`、`harness_goal` 均不等于 `verified_task`，也不证明全部测试通过。验证结果只来自真实命令回执及独立测试。

原生 goal 的 durable phase 与进程内 `armed/disarmed` 分开。重启不会自动恢复执行权；继续由用户输入和原生工具恢复。goal-round-driver 等待空闲与持久化 checkpoint，管理同会话续轮及竞争条件。完成一轮不表示整个长目标完成。并发限制使用官方所有子 Agent 的总上限，角色模型选择仅作适配，不另造 coder 调度器。

旧 UI 的 `cancel_task/cancel_branch` 对原生 todo 快照没有对应执行概念，现明确返回协议错误；单 worker 旧控制入口也在接入官方控制前返回错误，不先停整个 root 或伪造 worker 已停止。整个运行的暂停、恢复和紧急停止仍保留。新 run 不会把会话内上一项已完成目标再标成这次目标完成。

## 选择依据

采用 [官方 goal](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/goal)、[todo](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/todo/tool-todo) 和 [Session Controller](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/api/session-controller)，复用现有会话事件、CAS revision、取消和持久化机制。项目采用 [MIT 许可证](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/LICENSE)，仍处 developer preview；固定当前版本，不在本次自动升级。npm 与参考源码 revision 的对应边界见 [PROVENANCE.json](../../runtime/harness/PROVENANCE.json)。

没有采用“看到回答结束就宣布整个项目完成”，也没有增加按“你好”等词判断业务模式的例外。纯聊天直接回答；长任务用上游目标生命周期。

## 本切片验证

在当前目录使用已安装 Node 24 执行：

```powershell
node --test --test-concurrency=1 runtime/tests/codepro.test.mjs runtime/tests/codepro-harness-projection.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/tests/roles-harness-integration.test.mjs runtime/tests/harness-authority-acp.test.mjs
```

31/31 通过，退出码 0，约 9.86 秒；这是一个重叠子集，不与其他回归相加。包含旧历史合同、新完成投影，以及官方 Harness + 本机 HTTP 模型夹具 + 真实文件和 PowerShell：跨模块写入、原生续轮、用户取消、重启、同 run 继续、原文件 mtime/内容不变、真实 Node 测试、原生总并发限制和实际角色模型路由。模型外网、用户 profile、桌面窗口未由此切片操作。

随后针对旧控制越权与目标作用域补充回归：`node --test runtime/tests/codepro-harness-projection.test.mjs` 为 10/10、退出码 0；旧控制修复后 legacy + projection 子集为 26/26、退出码 0。这些是各次运行记录，不作为后续全部变动的累计验收。

主任务集成运行曾遇 Windows `state.json` 原子替换 `EPERM`。角色夹具原来每 10ms 打开文件观察子 Agent 终态，确认存在与生产写入重叠，但精确持锁方未证实。现使用真实 Harness 事件的透明观察器，等 compat 完成持久化后再计数；最终仍独立读盘核验全部生命周期与回执。修改后单次相关回归 1/1、退出码 0、约 2.94 秒；保留并行上限和真实文件断言，不据此归因外部扫描器。

这不是本次真实云端模型、桌面端到端、小时级任务或大型生产仓库验收。其他首版接入项与验证缺口继续保留在[功能矩阵](v1-functionality.zh-CN.md)，本批全套与后续变动的最终运行证据由独立验收报告补充。
