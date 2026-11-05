# CodeBuddy Harness 运行时

锁版预算兼容修复由 `sdk-budget-contract.mjs` 校验并在原生模块加载时应用，不改写 `node_modules`。最终请求的同一投影用于估价与派发；输出空间不足在 HTTP 前报 `LOCAL_OUTPUT_BUDGET_EXHAUSTED`，异常短 length 报 `OUTPUT_TRUNCATED`。本地预算／异常截断恢复每个原生 turn 最多尝试一次，且必须实际缩减并改善 fit 才重试；普通压力压缩仍按上游策略执行，网络 `always` 不能补充恢复次数。Completions 的合法 cap 1/128、普通 stop、原始 usage 和 Session v4 保持原语义。`index.mjs` 串行完成合同加载后再加载原 `driver.mjs` 实现；元数据与 schedule 入口同样先建立合同。版本或 SHA 变化会明确拒绝启动，升级须复审并优先采用等价上游合同，见 PROVENANCE.json。压力显示仍由原生 tokenMeter 负责，与 adapter 最终预算估计不同。

已由模型目录识别的 vLLM Chat Completions 在同一部署的聊天分词端点核算消息、工具和模板参数，再为输出预留空间。不支持的模板或计数失败时采用本地估算。服务端明确报告摘要超限时缩小到完整的工具调用分界；在同一次恢复中，只有服务端计数持续下降才继续分段。

远程 MCP 通过官方 `agent-preset-registry` 的长期作用域和租约跨会话复用；配置一致时仅首次连接，配置变化隔离新修订，既有会话保留原连接。最多保留 8 组可复用配置，仍被租用的旧修订由 Harness 继续保留。stdio 保持会话/工作目录隔离。工具列表变化会同步继承工具限制，执行仍逐会话审批；详见设计与真实窗口验收（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-mcp-reuse.zh-CN.md`）。

长目标由官方 `goal`、`goal-round-driver`、`tool-goal` 管理，包含目标 CAS、自动续轮、轮数上限和暂停。`prompt` 在原生目标 active + armed 时保持打开，等待官方续轮结束；普通无目标会话正常结束。返回值的 `goal` 为官方 GoalView。Stop 取消本次执行并 disarm；重启保持 disarmed，不自行重放工作。显式暂停目标的恢复使用结构化 `prompt(...,{resumeGoal:{goalId,revision}})`，先建立权限和事件承载再调用官方 resume。`getGoal` 只读；`controlGoal` 支持 pause，以及已承载执行中的 resume；空闲时直接 resume 被拒绝。

模型请求默认使用官方有界重试（5 次，500ms 起退避，最多 10 秒间隔），不再强制关闭重试。`llm/retry`、`goal/change`、`turn/start` 和 `todo/write` 通过 `harness_event` 保留原生身份；todo 清单仅属于当前 turn。`model_diagnostic` 仅记录首片/结束耗时、HTTP 状态、块数和白名单网络错误代码，不记录内容、凭据、请求头或 URL。观测不修改 fetch、流或重试结果。

Host 固定使用官方 `maxActiveSubagents: 3`、`maxDepth: 1`：每个主会话的原生子 Agent 树最多同时运行 3 个子 Agent，子 Agent 不能再派发下一层。旧 `roleModels`、`maxParallelSubagents` 和 `maxParallelCoders` 不参与执行；旧角色路由不能覆盖主会话当前所选模型。

官方 npm @deepseek-ai/dsh 及插件精确锁定 0.2.1-alpha.2；采用 MIT，仍为 developer preview。profile 组合官方 boot、Session Controller、AgentLoop、JSONL、MCP、skills、subagent、jobs 和 compaction，不另建模型循环。来源与完整性见 PROVENANCE.json；npm 与参考源码的字节等价未证实。[上游仓库](https://github.com/deepseek-ai/deepseek-harness)。

使用 Node 24+。已批准的依赖准备入口为 `npm ci --ignore-scripts --no-audit --no-fund`；本批没有安装、下载或升级依赖，也没有修改系统 PATH。

length 恢复及依赖零输出的溢出判定只使用服务明确报告的输出计数（包含 0）。缺 usage 或缺输出字段时保持未知，保留原 `max-tokens` 终态，不从正文猜 token 数，也不将 SDK 默认 0 当成真实用量。

Responses 启用输出上限时最少需要 16 token（[官方约束](https://developers.openai.com/api/reference/ruby/resources/responses/methods/create)）。显式 cap 小于 16 会在 HTTP 前以 `INVALID_OUTPUT_BUDGET` 结束，不抬高上限、压缩或重试；剩余空间不足 16 则交原生有界预算恢复。Completions 的合法 cap 1 仍保留。显式关闭 `supportsMaxOutputTokens` 继续表示不发送服务端上限。

## 适配接口

摘要本身也消费 adapter 的实际 fit。完整请求经现有中间件和投影准备后，若放不下所请求的摘要输出（默认 4,096 token），LLM 服务在 HTTP 前返回 `COMPACTION_OUTPUT_BUDGET_EXHAUSTED`。原生压缩在同一事务内按工具配对边界几何缩短选区，同步重建输入与 shadow 集合；未摘要的尾段仍为原 surface 事件。有限次本地准备只寻找一个可用区间，不保证最长或穷尽所有区间。最终候选复用已绑定的连接快照与配置并只发一次摘要 HTTP；实际 length 或取消不再触发第二次摘要。找不到可用区间时不提交检查点，保留原失败。普通压力路径的单检查点保护也覆盖缩区后的实际摘要输入。

原生工具图片引用仅由附件存储校验读取，再由适配层生成合法 ACP 展示块。预览读取失败只降级图片展示，工具的真实终态和原回执仍保留；旧记录只在回放投影中修复，不重放工具或改写历史。可选图片 I/O 完成后重新读取当前历史与实时高水位，再同步重置和回放。

`createHarnessDriver({dataDir,cwd,instructionsHome})` 必须指定隔离数据根。调用 `createSession({sessionId,cwd,provider,model,options})`、`prompt(sessionId,content,{onEvent,onToolPolicy,onPermission,onToolStart,signal})`，退出调用 `close()`。provider 支持 baseUrl（API 根）、apiKey、protocol、headers、compat、contextWindow、maxTokens、inputModalities、reasoningEfforts。模型及 MCP 凭据仅在驱动内存；磁盘 Host providers 为空，不发现旧版或环境密钥。

`configureSession(sessionId,options)` 在空闲时生效；应用保存并在重启后重新传入。参数：

- systemPrompt、maxTokens、temperature、thinkingEffort 进入真实模型请求；思考档位须由 provider 声明。
- 自定义连接按模型列表的 `owned_by` 选择预览接口：vLLM 使用 `/v1/chat/completions/render`，SGLang 使用 `/v1/tokenize`，保留 API 基础路径和连接鉴权。预览仅渲染实际聊天模板，不生成回答；只有实际改变模板的档位才显示，等效档位合并，并保留服务默认值。结果复用现有能力缓存，刷新模型列表后重新验证。旧服务缺少预览、调用失败或参数被忽略时不推断强度，模型详情显示“尚未确认可用档位”；不以通用参数枚举或模型名称判断支持情况。依据：[vLLM reasoning controls](https://docs.vllm.ai/en/stable/features/reasoning_outputs/)、[SGLang tokenization](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/serving_tokenize.py)。
- maxTurns 限制本次 prompt 主／子 Agent 的官方步骤数；到达后返回 max_turns，历史保留，不标记业务完成。
- autoCompactThreshold（0 到 1）、autoCompact 使用官方 token-meter／compaction-basic；`compact(sessionId,{signal})` 手动压缩，原事件证据保留。
- 压缩兼容层为同一路由补齐当前对话的思考档位，避免摘要请求切换聊天模板而失去前缀缓存；显式摘要档位、独立摘要模型或已变更的会话配置不覆盖。摘要保持官方原有指令与所选区间的完整输入，输出预算从 1,024 提升至 4,096 token，容纳思考和完整检查点；不是要求输出更多文字。锁版选区修复保留最新 `source.kind=user` 的原始事件，后续生成的 runtime-context／skill-catalog 不会取代它。遵守原有 tail 预算，在用户事件两侧选择工具配对完整、估价较大的连续区间，优先非单检查点区间；长任务仍能压缩后续工具历史，不复制或重排用户输入。只有旧检查点可选时保留超限恢复和手动压缩能力，普通压力路径仍略过它。后半区摘要可能无法复用完整前缀缓存。截断拒绝、取消及检查点事务仍归官方引擎；摘要本身不是任意任务无损的保证。升级 Harness 后复查此兼容层。
- tools 为 `[{name,description,inputSchema,execute}]`。execute 接收 `(args,{sessionId,signal,callId})` 并返回 JSON 对象，仍经官方 registry、校验和审批。
- mcpServers 使用官方 stdio／streamable-http 配置；工具名为 mcp__server__tool。独立服务并行连接，保留各项 ready／error 状态及配置顺序；失败连接释放，其他能力仍可用，重配重试。`extensionStatus(sessionId)` 返回状态；`testExtension(server)` 临时连接、发现、释放，失败直接报错。连接、工具发现、同步调用及每次 Tasks 请求默认 300 秒，显式 `toolCallTimeoutMs` 优先。扩展设置的 `timeout` 以秒计，测试和正式会话共用转换；保存后由既有会话重配置机制应用。版本协商可能有多个请求，因此该值不是全部服务的总启动期限。
- 首次连接／重连从协议能力与工具定义探测异步：2025 Tasks 同时要求服务端 `tasks.requests.tools.call` 和工具 `execution.taskSupport` 为 optional／required；2026 Tasks 使用 `io.modelcontextprotocol/tasks` 扩展，由服务端决定是否返回任务。未声明支持的工具走同步，不猜工具名、不执行探测业务动作。`mcp-tasks.mjs` 在适配层轮询并将最终 MCP 回执交回 Harness，已受理的调用不重放；300 秒限制单次请求，不限制异步任务总时长，用户仍可取消。取消回执不证明远端已停止。当前不支持 Tasks 内的交互输入或进程重启后的自动恢复。SDK 2.2.0 尚无 Tasks 运行时，新版扩展使用锁定版本的内部 codec 兼容适配，升级依赖时须重新验证并优先移除该适配。设计参考：[MCP Tasks](https://tasks.extensions.modelcontextprotocol.io/)。
- toolFilter:{allow?,deny?} 只过滤继承工具；同 scope 的 MCP／宿主注册工具须由应用统一审批入口执行精确 allowlist。
- 通用原生 `subagent` 接收 `{description,prompt,cwd?}`，默认继承主 Agent 实际请求使用的 provider、model 和 reasoning effort；不注册 `subagent_<role>` 或开放子模型选择。创建、并发、深度和结果回传由 Harness 管理；子 Agent 在创建时捕获原生沙箱权限并固定 `approval:never`，后续主会话切换权限不更新既有子 Agent。

onEvent 支持 Promise 并串行等待；前工具回执处理完才进入下一个审批或宿主 execute。事件带 sessionId，子 Agent 内容须独立投影。tool_result.structuredContent／error 来自官方回执；shell 前台结果含 exitCode、aborted、timedOut，background 句柄不等于验证完成。流式 attemptId 与持久 messageId 不同。

权限使用官方 `permission-presets`、`sandbox-local`、沙箱 shell 和 `user-approval`。`permissions(id,{cwd,initialPreset?,preset?})` 读取原生状态或通过官方 setter 切换；初始化仅在无原生权限事实时生效，不覆盖恢复或 fork 历史。新建聊天可通过 ACP `session/new._meta.initialPermissionPreset` 提交用户草稿，返回值以 DSH 已提交的预设为准。旧产品模式不能静默转换成完全权限；没有原生事实的旧聊天先按只读初始化。

`onToolPolicy` 只把工具启用、明确规则、现有会话授权和安全扫描结果交给原生工具 gate；文件和命令仍由原生沙箱约束。`onPermission` 仅回答 DSH `approval/request`；子级和完全权限的 `approval:never` 不弹用户审批。没有模型 turn 的直接界面工具调用保留显式确认，不能伪造模型审批审计。`onToolStart` 观察实际工具分派，不能用审批次数推断执行次数。Windows 沙箱属于上游的部分约束实现，其已知兼容限制不由 CodeBuddy 绕过。

取消停止活跃子 Agent 和所属 jobs，返回实际 jobs 状态；running／stopping 仍待确认。Jobs 为进程内任务，重启后基于持久会话核对、续作，不复活原 OS 进程。

另有 listTools、callTool（空闲维护窗口）、steer（活跃 inbox）、history、listSessions、rename、fork、follow、upload。

图片直接作为 prompt part `{type:'image',mediaType,data:<base64>,name?}` 传入，模型 inputModalities 需声明 image；官方 admission 验证、归一化并持久化引用。普通文件先 `upload(sessionId,{data:<base64>,name})`，再把 `{type:'file',receiptId}` 放入同会话 prompt；回执消费一次，模型收到按需读取的文件句柄。

`../transcripts.mjs` 仅保存 ACP 显示投影，不接管 Harness 执行历史。`openTranscriptJournal(store)` 在启动恢复未完成 NDJSON；`begin({sessionId,turnId,users,title?})` 返回 append、appendUsage、finalize。各追加等待 fsync 后才返回；finalize 在 store 原子更新中合入片段和回放高水位，再清理 journal。应在 UI 通知前 await 追加；恢复既有片段不新增完成结论。

ACP `session/cancel` 是取消请求。兼容层在首个异步校验前登记占用；真实终态发送给原请求及同会话观察连接，收尾路径退出时先删除占用，再同步发送现有 `session_info_update` 的 `activeRunId: null`。终态、宿主释放和原 prompt RPC 返回各有明确时点，取消通知写出不能替代它们。

## 技能与记忆

AGENTS.md 读取使用官方 agent-instructions 插件。`instructionsHome` 指定本版全局目录，默认隔离数据根；产品传入 CODEBUDDY_HOME。项目及嵌套目录遵循官方发现规则。固定版本在 apply 时同步读取环境路径，包装器只在同步初始化期间设置并立即恢复 Process 变量，不触碰 User/Machine 环境。

官方 spawn 创建平级 scope，宿主通过已验证 parent ownership，在 child 的 agent/created 阶段显式重建工具、MCP、系统指令和压缩配置；执行及审批仍使用真实 child sessionId，模型与思考档位由原生委派继承，不注入角色 override。

官方技能根为项目 .dsh/skills／.agents/skills，以及数据根 skills／agents/skills；提供 listSkills、refreshSkills 和官方 /skill-name 显式注入。

固定版本没有独立内置 memory provider。第三方记忆走官方 MCP；CodeBuddy 本地记录复用 storage-domain／storage-json 的 codebuddy_memory。memory.get(scope,key)／list(scope) 同步读取，set(scope,key,JSONvalue)／delete(scope,key) 异步持久化。应用拥有记录 schema、项目 scope、候选激活与检索语义，不增加第二个记忆模型或数据库。

## 验证边界

2026-10-16 MCP 异步／超时批次：在 `D:\CodeBuddy-v1`、`main`、`01610d03764570282eee439cd2bfb49fcd373e98` 加既有及本批未提交改动上，使用已有 Node 24.21.0 执行以下命令，均退出 0。新增 21 项验证包括两代 Tasks 的 HTTP／stdio、权限、取消、失败、输出 schema、模型收到最终结果后续轮，以及同步调用真实等待约 65 秒成功；相关回归 35、19、4 项通过。无依赖安装、分支切换、提交或推送；没有构建／安装新版，没有真实 HexStrike 或桌面 E2E，本结果仅为源码及隔离集成验证。以下旧批次验证记录另行保留。

```powershell
# D:\CodeBuddy-v1\runtime
node --test tests/mcp-task-execution.test.mjs
node --test tests/session-extensions.test.mjs tests/extension-resolution.test.mjs tests/harness-integration.test.mjs tests/mcp-apps-harness-integration.test.mjs
node --test tests/builtin-extensions.test.mjs
# D:\CodeBuddy-v1\runtime\harness
node --test test/mcp-apps.test.mjs test/mcp-metadata.test.mjs test/mcp-startup.test.mjs test/capabilities.test.mjs
```

`node --test test/driver.test.mjs test/capabilities.test.mjs`：Windows 28/28、退出码 0。真实官方 Harness、原生 PowerShell、隔离临时目录和本机受控模型／MCP 服务，覆盖参数真实请求、异步回执、MCP 隔离及离线降级、技能、子 Agent 路由／审批／取消、后台任务、步骤上限、压缩、图像重启复用、文件回执隔离、记忆重启和凭据不落盘。`node --test tests/transcripts.test.mjs`（runtime 目录）4/4，含跨进程强制终止、截断尾行与提交后清理失败恢复。这不代表真实模型大项目质量、全部 UI、桌面 E2E、macOS 或旧数据迁移验收。


输入框 `@` 按文件／对话分组，文件复用工作区面板目录与搜索，对话复用 ACP 列表。来源通过官方 `dsh-session-reference`（锁定版本、MIT）作为只读、不受信任背景捕获；最多 3 个来源，每来源预览 24 KiB。长引用会按官方策略截断并带省略提示，不能承诺全文无损；未配置 spill 时不提供全文回取。支持原生会话；不迁移旧的非原生历史。引用不恢复旧任务，也不继承旧授权。采用官方服务而非前端复制全文，避免第二套投影与持久化；无需新依赖。
