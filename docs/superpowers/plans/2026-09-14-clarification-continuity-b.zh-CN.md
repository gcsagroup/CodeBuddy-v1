# 普通澄清对话的目标连续性：B 批次方案

## 当前状态：v40，自动化通过，发布验收未完成

2026-09-14 13:37：完整 ACP 测试 55 通过，控制指令集成测试 3 + 11 通过，核心完整库测试 3286 通过、0 失败、2 忽略，fmt 通过。纯“继续”回归覆盖暂停/取消、同运行标识和完整目标、预算保留、完成后不重放，以及跨工作区/跨会话拒绝。此前暂停来自测试夹具在服务启动后另行写入历史运行，未初始化该服务的调度入口；改为正式启动恢复和 LoadSession 后已通过，未放宽生产权限。

按主管最新安排，资源交还用于网关模型连接修复。Clippy 自动衔接后已中止，未计通过或失败；本批后端构建、独立真实桌面验收、安装包仍未完成。以上通过结果属于网关修复前的冻结源码，不能代替后续集成验收。证据见 `.cargo/evidence/clarification-continuity-b-20260914/gates-v40-summary.json`、`source-v40.json`、`handoff-v40-paused-for-gateway.json`。原 B 完成现场未修改。

## v33 历史状态

2026-09-14：源码冻结，共享编译和桌面窗口交还主管，优先进行 Git 合入验收。v26 的相关定向测试、fmt、完整 all-targets clippy 和 CLI 构建均通过，精确命令及结果见证据目录中的 `gates-v26-summary.json` 和 `control-integration-v26.json`。

原 B 会话 20260914_6 真实输入“继续”后，原 Node 测试命令 exit 0，原 DAG 完成；原 Coder 输出、契约、预算、三个项目文件均未改变。真实关闭重开后仅有一份新的完成报告，未重复执行。但 ACP 错误注册了新的执行标识，控制目标仅为“继续”，旧澄清仍绑定原标识。因此本批尚未全部通过；原 B 完成现场已封存。

v29 的真实 ACP 请求回归复现了重复注册（预期 1 个，实际 2 个）。v30 修复后，原执行标识、完整目标和注册数量断言通过；v33 整项测试仍 exit 101（0 通过、1 失败），后续执行为 Paused，未满足 Completed。只读审计发现测试夹具缺少明确动态验证描述和可发现的项目测试入口；这尚不能解释全部暂停原因，需修正夹具并核对持久事件，不降低完成断言或放宽生产权限。

主管归还资源后继续回归、ACP/控制门禁、clippy、构建及独立受控中断任务的真实桌面验收，包括完成后再次“继续”不重放动作。现有后端仍为 v26，尚不包含 v30 修复，安装包未更新。本批不代表所有工具箱工具已逐项实测通过。

当前证据：`.cargo/evidence/clarification-continuity-b-20260914/source-v33-frozen-for-git.json`、`handoff-v33-paused-for-git.json`、`native-v8/b-v26-acceptance-incomplete.json`。A/C 原有证据保留。

## 历史状态与原方案（以下不是当前验收结论）

日期：2026-09-14。当前仍在验收，未完成。v19 的 DAG 80、修复 37、连续性 19 项测试全部通过（筛选存在重叠，不相加）；fmt、完整 all-targets clippy 与 CLI 构建 exit 0。实际 qwen3.5:397b / v19 桌面验收：A 会话 20260914_1 仅答“邮箱”后保留原目标并完成源文件、测试修改，宿主真实测试 exit 0；界面报告重复显示的问题由独立前端任务修复，不能据此宣布整体通过。B 会话 20260914_6 经真实关闭重开后，仅答“继续”仍追问原渠道，答“短信”后进入原目标；测试失败修复已实际继承原 src 与 test 授权并补齐源文件，但复测被自身保存的 Windows Node 绝对路径拒绝，任务仍暂停。C 会话 20260914_13 将原修改目标替换为只读查看 package.json：旧澄清关联 closed，新目标 read_only/finished，真实 read_document 1 次，测试执行 0 次，3 个基线文件哈希未变。C 后已关闭 Electron/backend 并释放界面。命令恢复已取得有效 RED（0 通过、1 失败，错误与现场一致），v21 最小修复与相关门禁进行中；保留原 B 会话待恢复验收。证据目录为 `.cargo/evidence/clarification-continuity-b-20260914/`；v9 完整库 3274 通过、2 忽略以及 ACP/控制 123 通过仅属较早源码门禁，不冒充 v21 全量验收。以下方案及行号为历史记录。

[繁體中文（默认版本）](2026-09-14-clarification-continuity-b.md) · [English](2026-09-14-clarification-continuity-b.en.md)

## 目标与范围

用户提出目标，Agent 询问关键选项，用户简短回答后，继续完成原目标并采用新约束。例如“为当前登录加入验证码，先问我要哪种”→“短信还是邮箱？”→“邮箱”：执行器与 Planner 应收到原登录需求及邮箱约束，不能把“邮箱”当作独立项目目标。

本批仅处理普通 `CodeProExecutionRoute::Clarify` 的连续性；不重做已验收的 A 检查点输入、测试命令授权与 UI 回放。取消后旧运行状态投影不同步留作紧随批次。本批的 `cancel` 仅取消待澄清关联，不能顺便改写既有运行取消协议。工具箱、流式展示与其他模块不在本批。

## 已核实的现状

以下行号为本次只读快照，实现前重新核对。

| 位置 | 事实与影响 |
|---|---|
| `crates/goose/src/agents/agent.rs:8444` | Clarify 保存助理问题文字后返回，没有保存问题与源目标的结构化关联。 |
| `crates/goose/src/agents/agent.rs:8668` | 意图模型取得最近 6 条消息、每条至多尾部 2000 字；提供历史不等于持久保存待回答目标。 |
| `crates/goose/src/agents/agent.rs:8117` | 执行目标取当前用户消息；新 DAG 与运行状态也使用此目标。 |
| `crates/goose/src/agents/agent.rs:2409` | 源消息还原只处理 `ResumeAfterWorkspace`，不是普通澄清回答。 |
| `crates/goose/src/agents/agent.rs:13702` | 现有测试只证明意图路由收到历史，没有断言 Planner/DAG 取得完整目标。 |
| `crates/goose/src/agents/codepro_intent.rs:678` | 决策包含 intent、clarification、public_summary，没有回答与问题的关系。 |

尚未执行本批 RED，以上为代码证据，不当作新的实机复现结果。

## 最小实现方向

1. 保存有类型、带版本的待澄清记录，绑定 session、源用户消息 ID、助理问题消息 ID、工作区及当前状态。源目标从已验证的真实用户消息读取，保留其附件及可见性语义；模型不能用自述的“原目标”替代来源。
2. 在下一轮执行路由前读取有效记录，将输入关系分为 `answer`、`new_task`、`cancel`、`clarify`。只有已核实的问题关联与答复才能形成内部执行上下文。仍有歧义时继续询问；新目标或取消使旧关联失效，不自动夹带旧工作。
3. 原始用户目标及回答分别保存一次，不改写聊天历史。内部上下文由原目标、问题及原始回答组成，贯穿意图、实际 Planner、DAG、控制面目标与报告；不要只修路由提示词。
4. 先持久化问题/回答关联与可恢复的消费状态，再允许执行。保存失败必须报告未执行并保留恢复线索；不能先跑工具再补写。重送相同消息 ID 不再次消费，同样文字但不同消息 ID 不以文字去重。消费已记录但尚未启动的中断不能丢失原目标。
5. 优先复用既有会话存储；若用 extension data，采用严格类型解析及带预期版本/问题 ID 的局部更新，避免覆盖其他模块的 extension data。验证源消息角色、工作区、问题状态及答案 ID；不建立通用的新目标子系统。

预期落点：`agent.rs` 的 Clarify 与执行入口、`codepro_intent.rs` 的关系判定、必要的独立澄清数据模块、`session/session_manager.rs` 的原子局部持久化，以及 `acp/server.rs` 的控制目标一致性。只有 RED 证明需要时才修改该位置；不预先扩充公开 SDK 协议。

## 先建立可复现失败的测试

以下名称为拟新增，不宣称目前存在或通过。以 `clarification_continuity` 作为定向筛选前缀。

| 测试 | 输入与必要断言 |
|---|---|
| `clarification_continuity_answer_reaches_planner_and_dag` | 用受控 Provider 依次提供 Clarify 与 Change 决策，经正式回复入口跑两轮，截取实际 Planner 请求并读取真实临时运行存储。原目标、问题及“邮箱”都须传入，DAG 不能只以回答为目标；原始用户消息各一条。不能手动把合成目标送进 Planner 让测试自行通过。 |
| `clarification_continuity_reload_preserves_pending_source` | 问题保存后重建 Agent/SessionManager，再回答；使用较长历史验证不依赖最近 6 条消息。 |
| `clarification_continuity_new_task_and_cancel_do_not_resume` | 回答“算了，先只分析 README”与明确取消；不恢复原写入目标，取消不执行工具。 |
| `clarification_continuity_rejects_stale_or_foreign_bindings` | 不同 session/工作区、已失效问题、非用户源消息、损坏数据；不能继承或执行错误目标。 |
| `clarification_continuity_duplicate_and_commit_failure` | 同一答案 ID 重送、保存前/保存后启动前故障；执行计数不增加两次，保存失败时为零，重载后仍能识别待处理答案。 |
| `clarification_continuity_ambiguous_answer_stays_pending` | 仅“继续”且关键选项尚未回答；不猜选项，不假报完成。 |
| ACP 路径 | 在 `crates/goose/tests/acp_server_test.rs` 核对控制面 goal、用户原文、Planner/DAG 的来源一致性及重载后不重送。 |

优先将测试放在 `crates/goose/tests/codepro_clarification_continuity.rs`；若正式入口的私有路由无法在集成测试中截取，可在 `agent.rs` 既有测试区加入最小 Provider 辅助，但不可为测试绕过真正入口。RED 的失败必须由错误目标或缺失关联断言造成；编译失败、环境阻塞、模型行动上限不算有效 RED。

## 门禁与真实验收

取得资源后先核对 dirty diff 所有权、磁盘及活动构建；串行执行 Cargo。下列命令均计划在 `D:\CodeBuddy` 执行，目前 NOT_RUN。

```powershell
cargo test -p goose --features code-mode --jobs 1 clarification_continuity -- --test-threads=1
cargo test -p goose --lib --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --test acp_server_test --features code-mode --jobs 1 -- --test-threads=1
cargo fmt --all --check
cargo clippy --all-targets --features code-mode --jobs 1 -- -D warnings
cargo build -p goose-cli --features code-mode --jobs 1
```

按最终修改范围补齐相关集成测试与工作区构建门禁；若修改前端，再跑相关组件、类型、lint、完整前端与构建。若按功能规则更新 `goose-self-test.yaml`，需重建后执行 `goose run --recipe goose-self-test.yaml`，不得把未完成项标成通过。

真实 Electron 验收使用隔离项目与真实模型：提出小型、本地可验证的修改目标并要求先询问一个关键选项；真实键盘简答后，检查实际修改、测试输出、目标及报告。另一次在问题出现后正常关闭并重开，再回答；完成后刷新、重开历史，确认无内容丢失及重复副作用。以磁盘产物与执行记录核对结果，不只看“完成”卡。真实模型未走到 Clarify 路径时记为该路径未覆盖，不能以其他成功流程替代。

## 与公开 Codex 行为的对照

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 公开了 thread/resume、turn/interrupt 与 requestUserInput/resolved：会话可重开、停止轮次以 interrupted 结束、输入请求以 ID 关联解决状态。采用分离会话/轮次/问题身份与保留历史的原则；不推断 Codex 私有存储，也不复制整套协议或新增全局 goal API。B 的具体类型与事务设计是本项目提案，不是 Codex 内部实现事实。

## 完成判定

RED 有效、最小修复及必要门禁通过、真实两轮与重开流程通过、主管独立复核后，才报告 B 完成。报告列出源码版本、命令/cwd/退出码、通过/失败/跳过、真实操作与产物位置。取消 raw state 投影修复仍另列后续，不混入本批完成声明。
