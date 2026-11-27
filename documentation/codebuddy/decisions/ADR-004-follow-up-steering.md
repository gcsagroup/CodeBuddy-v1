# ADR-004：排队与运行中引导分离

状态：2026-11-27 用户批准实施，随后确认“插话这部分验收”，授权提交和推送。验收范围为本次插话功能，不代表所有桌面恢复、同步工具或流式性能均已验收。

## 问题与决定

用户在任务执行中追加需求，需要在“引导当前任务”和“等待本轮结束”之间选择。用整轮 cancel 再重发无法保住长工具和子任务；仅改前端按钮也无法让模型及时读取输入。

复用固定的 DSH `0.2.1-alpha.2` 执行循环、Inbox、权限及 Session 历史，扩展请求级抢占和既有 Job 等待的安全让出。继续使用现有 InputQueue 交付账本、命令 ID、消息 ID、目标 run 和恢复协议，不建立第二个 Agent、第二份正式历史或通用 Promise 后台执行器。锁版 loader 校验版本和原始源码 SHA，升级不匹配时显式失败，不改写 node_modules。

## 用户行为

| 操作 | 行为 |
| --- | --- |
| 引导（默认） | 通过原生 steer(preempt=true)接纳原消息；只抢占当前模型请求，保留实际在途工具、子任务和已完成历史。 |
| 排队 | 普通消息保留独立身份，等待当前 ACP 执行结算后逐条开始后续原生 turn。暂不合并正文或附件。 |
| 队列纸飞机“优先发送” | 活动执行中走原生 steer(preempt=false)，在步骤边界接入；空闲时用已有 reorder/resume 将所选项提前，其余相对顺序不变。 |
| Enter / Ctrl+Enter | Enter 按当前设置，Ctrl+Enter 使用另一方式；模式变更不改已有消息目的地。 |
| Stop | 保持独立取消操作；暂停宿主未交付队列，实际取消与收尾仍由原 owner 处理。 |

队列为一个限高滚动卡片，普通行 32px，上限 min(104px,20vh)。默认跟随最新消息；向上阅读时不抢滚动位置。每行正常操作只有优先发送、编辑、删除；左侧为拖排把手。不显示 step/turn、展开折叠、批量操作或底部解释。优先发送提示“当前步骤结束后发送，不中断当前任务。”

正常引导在本机持久暂存成功后尽早展示原 ID 用户气泡，不闪出普通排队界面。该气泡是待确认展示，不是模型已读证明；后续原生回显按同一 ID 确认，不能重置正在积累的分块文本。

## 所有权

| Owner | 接收、处理与输出 |
| --- | --- |
| Electron 设置 | 保存新消息的 queue/steer 选择并广播；默认 steer。读取失败保留未知，不悄悄切换模式。 |
| 桌面 useInputQueue | 只持有未确认提交的 v2 FIFO journal；持久化完整不可变请求后 staged，一个 worker 串行 POST。不是执行或消费权威。 |
| runtime/input-queue.mjs | 既有 Session store 中的交付账本 owner；保存命令去重、消息身份、目标 run、接纳与未知状态。 |
| Compat | 校验原 run、准备内容和输入 profile，传递原消息 ID；不根据自然语言决定是否取消、换目标或重放。 |
| Harness driver / 原生循环 | 持有接纳窗口、模型请求抢占、工具信号及执行收尾；原生 user/message 的 agent_input 回执确认消费。 |
| JobRegistry / 媒体 Job | 持有原生产者和真实最终回执；引导只解除本次观察等待，不重提、不杀生产者。 |
| DesktopCoordinator | 持有桌面 lease、窗口范围、串行 tail 和在途动作。未派发等待可撤回，已派发动作继续真实结算。 |
| 原生 Session | 持有正式模型历史。界面显示、ACK、模型自述都不能替代历史提交或工具回执。 |

## 交付、恢复及迁移

- v2 key 包含原窗口身份和会话 ID，记录完整 commandId、revision、消息 ID、正文、附件、模式和 expectedRunId。首个 ACK 慢时仍能追加独立 enqueue；其他控制操作互斥。
- ACK/GET 只结算捕获 owner 的当前队首。持久删除成功后才推进；旧 GET 不得删除 B，离开会话的旧 owner 不得改写恢复记录。
- 冷恢复只 GET 核对已应用前缀，未确认尾部不自动 POST。显式重试原请求不重写 revision、ID 或目的地；明确拒绝后由用户选择改投 queue，保留原消息 ID 和附件、使用新命令 ID。
- v1 完整请求先写入 v2 后删除旧键；双份相同可迁移，冲突保留并报错。现有 sessionStorage 窗口发现范围不扩大。
- pending → dispatching → admitted → consumed 分开。ACK/flush 不表示消费，native 消费不等于已经回答；是否进入模型上下文还需实际请求证据。
- 原生 Inbox 已持有的项不能降回 pending 后重发。未知结果暂停并核对，不通过重试猜测成功；新 run 不能接收过期的非空 expectedRunId。
- 旧 stop-and-send 方案已被用户撤回。未应用旧 send 明确拒绝，已应用命令只返回去重回执，不重新解释为优先发送。
- 回滚前处理完 v2 未确认记录，不能承诺旧版本读取 v2 尾部。Loader、driver、Compat 和消费者必须成组迁移，不能只删加载器。

## 请求中断与等待边界

只把抢占前已闭合的原生输出块、或真正成功 finish 确认的内容提交为正式助手历史。未完成项保留在 attempt 审计及已显示界面中，不进入后续正式助手历史；适配器 abort 清理时补出的块结束不构成成功证据。

已运行工具继续结算；未派发提案用原生 cancellationResult 配对。授权仍由原授权 owner 处理，引导不会替用户回答。前台 PowerShell / job_output 复用已有 Job，只让出 registry wait；promoted 的 releaseReason=steer 与 preparing 区分引导、超时和尚未确认进程启动。

媒体 status 的观察循环和可选已完成图像检查可让出。原提交、共享刷新/下载、取消和持久 job 状态不变；wait_release_reason=steer 只描述本次调用，不持久化、不重置 240 秒预算。未完成的识图不能冒充验证结果。

CU 仅撤回未派发调用在前驱或 lease 上的等待。真实 tail 仍等待前驱；首次窗口范围在真实 MCP 元数据派发边界提交，已提交范围不随引导清空。已派发动作、视觉收尾及普通同步 MCP/Tasks 不作无句柄后台化。

## 两个收尾缺陷的修复

1. 原 run.steers 只跟踪 admission，完成后仍等待 flush 时可能反复等待已完成 Promise，饿死落盘 I/O。现在集合持有包含准备、入箱、preempt、flush 的完整 delivery，不添加 sleep；子进程 watchdog 能识别该饥饿。
2. Compat 先 await 备用识图再找 driver，短任务可先自然结束，随后返回 PROMPT_IDLE。现在 driver 同步校验并保有原 owner，再通过内部 prepareContent 执行原 VisionRouting 和 bindAgentInput；准备后再次校验同 run、acceptingInput、cancelRequested 和原信号。Stop 或准备失败不能晚入箱或另起 prompt。

若识图期间原生 turn 已自然结束，DSH 可以在同 ACP owner 下开启后续原生 turn。不能把“同 ACP 执行”写成“永远同 native turn”，也不能声称已结束的采样仍被抢占。

附件加载中的键盘 Enter 与按钮共用门禁：正文和未就绪附件保持为草稿，准备好后完整发送。控制命令先解析，Stop 独立。

## 参考与取舍

参考本机 Codex `0.171.0-alpha.13.2` 的录屏、协议探针及匹配公开源码；不推断私有服务端实现。[请求中断协议](https://github.com/openai/codex/blob/rust-v0.171.0-alpha.13.2/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L882-L896)、[固定源码 CodeMode](https://github.com/openai/codex/blob/ad9d659a8491fc5169a00dcf7b7e6ca8a87adf69/codex-rs/core/src/tools/code_mode/mod.rs#L140)说明请求抢占、等待让出和任务终止是不同责任。没有将 CodeMode 的持久 cell 合同套到任意同步 MCP。

不采用：整轮取消后重发、第二模型强制“收到”、把任意 Promise 提前返回、用显示文字补正式历史。采用原生循环小范围锁版扩展和已有 Jobs，代价是每次升级须复审源码 hash 与跨层测试。

## 验证与限制

2026-11-27 用户明确验收插话部分。当前真实模型 ACP 验证：GLM-5.3、DeepSeek-v4.1-Flash、Kimi-K2.7-Code 两模式共 60 个原 ID 各消费一次；自然 queue 严格逐条后续 turn。GLM 文件与图文各三路径通过；图像由已真实验证的 Gemma 备用识图读取，主 GLM 收到辅助观察和文件引用。

Node 集中 9 目标为 74 pass、1 子进程入口 skip，另三项媒体测试文件 75 pass；四项主要前端目标 95 pass，补充 ACP/工作状态/设置集成三目标 105 pass。类型、locale 检查和正常源码预览启动均成功。存在一遍媒体共享 refresh 释放后 3 秒仍 queued 的失败，过滤和集中诊断重跑通过，但原因未确诊，未增大超时或声称排除。

真实模型证据来自同一 dirty worktree；此次提交排除了独立导航与 Markdown/滚动性能改动，driver 文件字节 hash 因拆分而变化。静态核对其依赖独立，但不能把原证据 hash 写成拆分提交的字节身份。具体提交范围、验收证据、合并注意事项见同批交接文档。

已知限制：普通 idle 首发接纳前仍保留旧草稿，紧接追加输入可能串接；全新窗口恢复发现范围、全部同步工具让出、冷恢复及跨 Provider 推理项重放未全面验收；滚动/思考动画顿挫不在本提交内根除。没有宣称所有工具即时响应、永久 exactly-once 或 Codex 1:1。

退出条件：上游提供等价请求级抢占与安全等待合同后，以相同跨层场景替换本地变换。独立代码导航连接复用属于另一未提交切片，不包含在本 ADR 的交付范围。
