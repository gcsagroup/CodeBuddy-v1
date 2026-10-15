# 工作过程与正式回答分离：修复计划

## 目标与证据

当前目录 `C:\Users\admin\CodeBuddy`，分支 `work/codebuddy-next`，起点 `8f1b1ae0757ce4603d7660a7004795b9525654f7`。保留现有三份未提交报告，不吸收进本批改动。

用户希望工作时仍能看到实时过程；进入正式回答后，把此前思考、工具和阶段说明整体收起，回答独立流式展示。结束也可以是失败或受阻，不等于成功。

已核对 `20261006_11` 的 session JSON 与源码：公开交付正文先输出，之后主 Agent 才核验；拒绝以隐藏 user 消息回送，继而产生公开“收到”；受阻 summary 被宿主逐行加 `>`，成为大段斜体引用。主 Agent 路径还缺少已有 TurnTerminal 投影，整轮折叠无法触发。这些是不同落点，不把它们合并解释为模型能力问题。原始记录见 `C:\test\test_1005\repair_1006_final\remaining-retests-1007\01-terminal-check\20261006T171336917261Z\session.json`。

## 参考与取舍

- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)：区分 agentMessage、工具/推理项和 turn/completed；可选 phase 不能假定所有 provider 都支持。
- [Claude Agent SDK streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output)：文本块结束后仍可调用工具；整轮 result 与中间 assistant 消息不同。
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)：函数调用和函数结果具有类型与关联身份，随后模型可以继续回答；不从回答措辞猜控制事实。
- [Vercel AI SDK stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)：step 边界与 message finish 分开，展示消费结构化事件。
- [OpenCode SDK](https://opencode.ai/docs/sdk/)：独立 SSE 事件流。只参考公开接口，不据此断言其私有/未检查的界面行为。

采用：结构化阶段边界、独立流式正文、原始执行记录可回看。不采用：全文结束关键词、额外语义分类器、固定 CU 工作流、第二套任务完成状态。

## 权威与修改边界

| 事实 | owner / 本轮处理 |
| --- | --- |
| 覆盖意图 | 模型现有 propose_coverage；不增加另一个必须调用的完成工具 |
| 覆盖、回执、Unknown、完成资格 | 现有 propose_main_agent_finish / convergence；不放宽条件 |
| 运行完成与暂停 | 原 runtime / reducer；界面不能修改 |
| 展示边界 | 执行器在核验接受后标记“开始回答”；仅展示，不代替 TurnTerminal |
| 历史与回放 | 现有 SessionManager；展示边界随原消息保存，不复制账本 |
| 整轮终止 | 原 runtime 结果投影为已有 TurnTerminal，正文发送完才发送，避免提前封口丢 token |

现有覆盖提案已是完成协议必需部分。本轮将其从“等正文生成后再检查”调整为“提案回执中先核验”，接受后仅开放回答生成，不再派发执行工具。仍由同一个完成入口提交原 runtime。可选 summary 只作完成提案说明，不是事实证据；旧调用可不携带。正式回答不能绕回执行。新要求保留在现有输入通道，不能在已提交完成后暗中作为旧任务继续执行。

在这条新路径上，阻塞式 Stop hook 于提交完成前执行，接收提案摘要；不能把它称为对尚未生成的最终正文进行了审查。普通对话的既有 Stop hook 出口保留。依赖最终回答措辞的自定义 hook 不在本轮自动验证保证内，需明确区分完成提案检查和正文审查。

展示边界使用现有 progress notification 的可选结构化 data，不新增任务状态、终止状态或 ACP 方法。缺字段旧记录不猜迁移；仍可在具有真实 TurnTerminal 时按既有保守规则折叠。

跨层复核发现 ACP 在 prompt 结束时会丢弃尚未接收的 steer，因此不能只把回答期间的新输入留在 Agent 内存中。CodePro 插话接收与完成提交复用现有 pending_steers 锁进行互斥，接收前读取原 runtime 的终态；已结束则明确拒绝接收入旧任务。现有前端在请求失败时保留并暂停待发送消息，回答结束后可作为新消息发送。此处不新增队列、自然语言分类或自动重发，不声称解决了所有历史输入交接问题。

## 实施顺序

1. 调整覆盖提案回执边界：孤立提交、先处理未接收输入/Stop hook，再核验；拒绝保留在工具回执，成功进入无工具回答。保留旧入口作为兼容，不宣称缺边界历史已经修复。
2. 补展示边界保存、ACP 实时/回放和 UI 折叠；回答仍按原 SSE 增量输出。最后补原 runtime 终态投影，不提前 seal。
3. 受阻交接去整段引用；缩减进度说明为阶段变化、重要结果、阻塞，而非每次鼠标动作。失败与不确定性仍可见。
4. 针对真实跨层边界回归：核验前不进入回答；错误/混批不能执行兄弟动作；回答 token 不被终态截断；错误关联不能折叠；工具再次出现要恢复过程；旧记录不伪造 phase；受阻不变成功。

## 验收与未覆盖项

相关 Rust 格式、聚焦测试、适用 Clippy，以及前端类型与相关组件/adapter 测试分别记录结果。遵守 README 构建入口，不安装依赖或改变环境。编译/组件测试不是产品 E2E。

产品验收复用维修工具会话模式与一个正常开发任务：工作时实时可见；回答首 token 开始时过程可展开地收起；成功/受阻分别只有清楚的交付；重新打开历史保持一致。另测停止和中途输入，检查正文持久化及终态。真实 CU 点得准不属于本轮 UX 修复结论，不改被测页面让 CU 通过。

兼容边界：若模型跳过现有覆盖提案，仍保留原保守核验出口，不能承诺其自由正文永不提前声称完成。既不扫描措辞，也不重新缓冲全部过程正文。历史中多个可见用户输入只有 steer 标志而缺少明确归属时，不猜测合并为一轮；特殊结构化输出、simple-change、exact-reply 保持原出口。上述路径需要单独证据才能扩大迁移。
