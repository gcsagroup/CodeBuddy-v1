# 工作过程与正式回答分离：实施与验收记录

日期：2026-10-07。目录 `C:\Users\admin\CodeBuddy`，分支 `work/codebuddy-next`，源码起点 `8f1b1ae0757ce4603d7660a7004795b9525654f7`。本记录不代表桌面 E2E 通过。

计划与公开参考取舍：[修复计划](../plans/2026-10-07-process-final-answer-repair.zh-CN.md)。本批开始前已有的 10/6 进度和 10/7 两份测试报告不属于本批修改，不纳入本批提交。

## 现象与证据

维修工具会话 `20261006_11` 的保存记录中，交付说明先公开，随后宿主拒绝完成，再通过用户角色的内部反馈拉回执行；模型公开回复“收到”。原始证据：`C:\test\test_1005\repair_1006_final\remaining-retests-1007\01-terminal-check\20261006T171336917261Z\session.json`。未确认的旧操作没有因此变为成功，本批也不替它补造证据。

长斜体来自 `main_agent_blocked_handoff` 把模型交接说明逐行加引用前缀，不是另一个总结模型。本批去掉该包装，保留作者归属和 Unknown 提示，不改写模型原文。逐次 CU 播报还与原进度说明要求“每个工作步骤前后解释”有关，本批收缩为阶段变化、重要结果或阻塞；工具活动继续实时显示。这项文案调整不能保证模型从此绝不冗长，需产品验收。

## 实际改动与权责

| 位置 | 改动 |
| --- | --- |
| `crates/goose/src/agents/main_agent_contract.rs` | 复用覆盖提案，增加可省略的提案摘要；减少逐动作公开播报要求；结束提案不得与执行动作混批 |
| `crates/goose/src/agents/agent.rs` | 覆盖回执返回前调用原完成核验，拒绝留在原工具回执，接受后只生成回答；补回答开始的展示标记，回答结束后投影原 runtime 终态；保留中断正文；去整段引用 |
| `crates/goose/src/acp/server.rs` | CodePro 插话入口读取原 runtime；终态后不接收入旧任务，由现有前端保留待发送消息 |
| `ui/desktop/src/types/responsePhase.ts` | 校验可选展示标记与其关联身份，不判定任务完成 |
| `ui/desktop/src/acp/adapter/gooseSessionNotifications.ts` | 实时/历史均消费同一展示标记，不提前封口；使用原时间，避免回放时长漂移 |
| `ui/desktop/src/components/ProgressiveMessageList.tsx`、`BaseChat.tsx` | 回答开始时整体折叠此前过程，回答仍流式；可展开历史，拒绝错误 session/source/run 关联 |
| 对应 Rust、组件、adapter/store 测试 | 验证混批拒绝、无工具回答、部分正文持久化、晚到输入、错误关联、实时/回放和最终正文不被截断 |
| `documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md` | 明确这次展示约定修订及原 owner 不变；不把实施进度写成事实基线已验收 |

接收插话与完成提交复用现有 pending_steers 锁互斥，防止检查通过后仍接收新输入、随后又被 ACP 清理。没有第二套队列或任务状态。观察、权限、Effect、Unknown 与完成资格仍归原 owner；UI 不扫描自由正文决定阶段。

## 验证记录

在本 worktree 执行，未安装依赖、未新建或切换 worktree，未使用旧桌面作验收。

| 命令 | 退出码 / 结果 |
| --- | --- |
| `cargo fmt --all` | 0 |
| `cargo test -p goose --lib completion_storage_fault_is_not_a_model_repair_gap_and_healthy_storage_completes --jobs 1` | 0；最后切片 1 个测试通过，覆盖 3 种健康/回答异常分支及 3 种存储故障；构建 5m02s，测试 2.18s |
| `cargo test -p goose --lib main_agent --jobs 1 -- --test-threads=1` | 0；3 条通过，包含部分正文保存和完成边界 |
| `cargo test -p goose --lib blocked_handoff_preserves_unknown_without_quoting_the_entire_summary --jobs 1` | 0；1 条通过 |
| `cargo test -p goose --lib stop_hook_payload_includes_streamed_assistant_reply_text --jobs 1` | 0；1 条普通对话出口回归通过，不证明新提案摘要等于最终正文 |
| `corepack pnpm run typecheck`（`ui/desktop`） | 0 |
| `corepack pnpm run test:run src/components/ProgressiveMessageList.test.tsx src/acp/__tests__/chatSessionStore.test.ts src/acp/__tests__/gooseSessionNotifications.test.ts` | 0；93 条通过 |
| `corepack pnpm run test:run src/hooks/useChatSession.steer.test.tsx src/components/ChatInput.queue.test.tsx` | 0；42 条通过 |
| `corepack pnpm exec eslint src/types/responsePhase.ts src/acp/adapter/gooseSessionNotifications.ts src/acp/__tests__/chatSessionStore.test.ts src/components/ProgressiveMessageList.tsx src/components/ProgressiveMessageList.test.tsx src/components/BaseChat.tsx --max-warnings 0 --no-warn-ignored` | 0 |
| `corepack pnpm run lint:check` | 1；类型检查通过，未修改的 `src/components/ui/scroll-area.tsx` 中 WheelEvent / Element 各一项 no-undef；HEAD 同样存在 |
| `corepack pnpm run i18n:check` | 1；既有语言目录有缺失/额外键，本批未修改语言目录，复用已有 duration 文案 |
| `cargo clippy -p goose --lib --jobs 1 -- -D warnings` | 1；24 项诊断，见下文；严格检查未通过 |
| `git diff --check` | 0；最后切片已检查 |
| 桌面构建、启动、真实 E2E | 未执行 |

新增后端反例最初失败，调查确认夹具以 assistant 工具请求开头，现有对话修复器删除了该不完整历史，覆盖被正确拒绝。补齐用户消息后原断言通过，没有放宽核验或删除“工具列表必须为空”的断言。过程中还修复了测试代码的类型/所有权编译错误；不把这些误报为产品缺陷。

Clippy 24 项分别为：3 项已有 unused function，6 项已有参数过多，2 项布尔表达式简化，1 项已有 is_some / expect，3 项已有 map_or，2 项字符串切片，1 项嵌套 if，1 项大 enum，1 项相同分支，2 项借用和 2 项 return。诊断位置位于未改动代码；对本批涉及的 agent/server 文件逐项对照了 HEAD 文本与零上下文 diff，其他被诊断文件不在本批修改内。没有运行另一个 checkout 的 Clippy，因此这里是基线源码对照，不冒称额外基线运行结果，也没有通过增加 allow 来压掉诊断。

本批保存为本地候选提交，不推送、不合并 main。测试构建发生在 `8f1b1ae0757ce4603d7660a7004795b9525654f7` 加本批 dirty source 上，与提交的源文件切片一致，但不是带新提交号重建的桌面产物。严格 Clippy、全局前端门禁和真实产品验收未全通过，不能把候选提交标成正式验收版。

## 能证明什么，不能证明什么

自动回归覆盖：混批提案不执行兄弟动作；有效提案通过后请求不提供工具；即使回答中伪造工具调用也不派发；正文分片先于 TurnTerminal，首分片期间的插话不接收入已完成任务；模型流中断不重开执行；原完成入口遇到存储错误仍返回宿主故障而非业务缺口，Unknown 继续阻止完成。存储故障后的整段模型交接尚未做真实产品验收，不能把这个返回类型测试当成完整用户旅程。

前端回归覆盖：工作仍实时可见；回答阶段过程整体收起且可展开；继续到来的正文可见；错误关联不折叠；展示标记不终止 prompt；真实终态之后才封口；重新加载使用原边界时间；插话请求失败时现有队列保留消息，不自动重发。

不保证：模型跳过覆盖提案时自由正文从不提前说“完成”；多个可见 steer 没有明确同轮归属时自动聚合；所有特殊输出出口已迁移；模型的业务结果质量、CU 点击准确性或旧 Unknown 已解决。既有保守出口保留，不添加措辞扫描来制造上述保证。

新完成路径的阻塞式 Stop hook 在提交完成前接收提案摘要，不是尚未生成的最终正文。其裁决仍有效，但不能声称验证了最终回答内容。依赖最终措辞的自定义 hook 需另行验收；普通对话原 Stop hook 的正文 payload 回归通过。

## 待做真实验收

1. 普通开发任务：执行过程持续可见；正式回答开始时收起前文，回答逐步出现；展开可以查回过程。
2. 有真实 Unknown 的受阻任务：交接清楚，不出现整段宿主生成的斜体，不把未知写成成功；结束后不继续重试旧动作。
3. 总结期间发送新消息：不暗中并入旧任务，消息仍在待发送队列；明确发送后作为新消息处理。
4. 中断模型服务 / 停止 / 重开历史：已显示正文保留，终态不截断最后分片，回放折叠与原时间一致。

需要使用本切片构建，记录实际 revision、进程/产物来源、会话 JSON、相关日志与录屏。测试 binary、组件测试和静态源码不能替代以上桌面行为。
