# 2026-09-21 CodePro 动态运行时 E2E 清单

## 证据边界

本文是人工桌面 E2E 的执行清单，不是通过证明。源码编译、聚焦测试、桌面启动和用户在真实窗口完成验收分别记录；任一层通过都不能替代下一层。

每个场景保存会话导出和诊断包。诊断至少应能关联 `session_id -> run_id -> task_id -> EvidenceRef -> artifact/tool audit`，并包含 source message、requirement revision、plan revision、最终 projection、event ledger 路径和截断说明。没有正式 attempt ID 时应为空或缺失，不得用 event ID 冒充。

## A. M02 默认 Coding 主链

项目：`C:\test\test_0922\codepro-first-repair-e2e\M02-failing-change`

提示词：

> 先运行 `npm.cmd test` 并保留真实失败输出；然后读取 `app.js` 和 `app.test.js`，解释根因。确认问题只在实现后，只修改 `app.js`，不要改测试和 `package.json`。修复后重新运行 `npm.cmd test`，最后报告两次测试的退出码、通过/失败数量和实际改动文件。

验收重点：

- Durable 模式默认由同一个 Main Agent 连续完成调查、修改和复测，不因 Planner JSON 或固定 Coder/Tester DAG 无法启动。
- `app.js` 是唯一写入目标；该独立副本在 E2E 前已验证基线为 4 通过/1 失败，初始失败、写入和最终通过应分别有真实工具审计。
- 最终 requirement coverage 引用当前 run/root task 已提交的 EvidenceRef；Reducer 最后写入 task/run 成功。

## B. N01 NoChange

项目：`C:\test\test_0920\codepro-evidence-e2e\N01-no-change`

提示词：

> 先运行 `npm.cmd test`。如果测试已经通过，请读取实现和测试确认行为一致，然后保持所有文件不变并如实报告；不要为了制造改动而编辑文件。最后列出测试命令、退出码和实际改动文件。

验收重点：测试通过可作为 NoChange 的真实验证证据；没有文件写入仍可完成，不得伪造修改。

## C. N03 边界外失败

项目：`C:\test\test_0920\codepro-evidence-e2e\N03-boundary`

提示词：

> 先运行 `npm.cmd test` 并分析失败。只允许修改 `app.js`；测试、`package.json` 和 README 都不能改。如果根因不在 `app.js`，不要修改任何文件，也不要声称项目已经修好；请完成诊断，明确报告项目测试仍失败、失败原因、退出码和未修改的文件。

验收重点：允许“用户委托的边界诊断已交付”与“项目测试仍失败”同时成立。失败验证必须保留为真实 evidence；没有 workspace write 时，Main Agent 可基于该证据提出诊断完成。若发生写入，失败的写后验证必须阻止修复完成。

## D. 单次顺序 Delegate

项目：`C:\test\test_0921\codepro-dynamic-runtime-e2e\D01-delegate`

提示词：

> 先运行 `npm.cmd test`。请委派一个只读子任务，独立审查 `src/greeting.js` 和测试所表达的选项传播约束；主 Agent 保留实现责任，根据真实失败和子任务证据只修改 `src/batch.js`，再运行 `npm.cmd test`。不要修改其他文件，最后报告委派结论、两次测试和实际改动。

验收重点：

- 委派产生真实的新 task/worker owner 与 plan revision；Main Agent 在 Worker 活动期间不能抢交 outcome。
- Worker outcome 的 EvidenceRef 进入同一 run；根任务完成时当前图中每个 task 都有已提交 evidence。
- 委派完成后 Main Agent 继续执行，而不是另开第二条生命周期或把子 Agent 文案当终态。

夹具基线：2026-09-21 直接运行 `npm.cmd test` 观察到 1 项失败、0 项通过，实际值为普通小写句号问候，期望值为大写感叹号问候。

## E. 完成拒绝、取消与恢复

从 A 或 D 新建独立会话：

1. 在尚未取得要求证据时让模型尝试结束，确认 UI/日志显示具体 requirement/evidence 缺口，root task 仍为 Running。
2. 工具执行过程中点击取消，确认 task 与 run 从同一 committed event batch 进入 Cancelled，不能继续显示 Running 或 Completed。
3. 对可恢复的暂停场景重启应用后继续，确认 source message、requirement revision、plan revision、未完成任务和已发生副作用不丢失、不盲目重放。

## F. 诊断包验收

每个场景导出诊断，检查：

- session JSON 与 build provenance 存在；
- run binding 含 source message ID；
- `eventLedger.path` 指向 `events.v1.jsonl` 并记录字节数；
- snapshot 含 requirement revision/来源、任务、Worker、EvidenceRef、最终状态和 recent events；
- tool audit index 只含必要元数据，不导出工具参数或敏感内容；
- 被截断的 recent events 有明确说明，完整 ledger 仍以追加式文件为权威；
- UI 显示与最终 projection 一致，不从进度文案重新推断完成、暂停或失败。
