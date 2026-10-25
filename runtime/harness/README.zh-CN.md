# CodeBuddy Harness 运行时

远程 MCP 通过官方 `agent-preset-registry` 的长期作用域和租约跨会话复用；配置一致时仅首次连接，配置变化隔离新修订，既有会话保留原连接。最多保留 8 组可复用配置，仍被租用的旧修订由 Harness 继续保留。stdio 保持会话/工作目录隔离。工具列表变化会同步继承工具限制，执行仍逐会话审批；详见设计与真实窗口验收（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-mcp-reuse.zh-CN.md`）。

长目标由官方 `goal`、`goal-round-driver`、`tool-goal` 管理，包含目标 CAS、自动续轮、轮数上限和暂停。`prompt` 在原生目标 active + armed 时保持打开，等待官方续轮结束；普通无目标会话正常结束。返回值的 `goal` 为官方 GoalView。Stop 取消本次执行并 disarm；重启保持 disarmed，不自行重放工作。显式暂停目标的恢复使用结构化 `prompt(...,{resumeGoal:{goalId,revision}})`，先建立权限和事件承载再调用官方 resume。`getGoal` 只读；`controlGoal` 支持 pause，以及已承载执行中的 resume；空闲时直接 resume 被拒绝。

模型请求默认使用官方有界重试（5 次，500ms 起退避，最多 10 秒间隔），不再强制关闭重试。`llm/retry`、`goal/change`、`turn/start` 和 `todo/write` 通过 `harness_event` 保留原生身份；todo 清单仅属于当前 turn。`model_diagnostic` 仅记录首片/结束耗时、HTTP 状态、块数和白名单网络错误代码，不记录内容、凭据、请求头或 URL。观测不修改 fetch、流或重试结果。

Host 固定使用官方 `maxActiveSubagents: 3`、`maxDepth: 1`：每个主会话的原生子 Agent 树最多同时运行 3 个子 Agent，子 Agent 不能再派发下一层。旧 `roleModels`、`maxParallelSubagents` 和 `maxParallelCoders` 不参与执行；旧角色路由不能覆盖主会话当前所选模型。

官方 npm @deepseek-ai/dsh 及插件精确锁定 0.2.1-alpha.2；采用 MIT，仍为 developer preview。profile 组合官方 boot、Session Controller、AgentLoop、JSONL、MCP、skills、subagent、jobs 和 compaction，不另建模型循环。来源与完整性见 PROVENANCE.json；npm 与参考源码的字节等价未证实。[上游仓库](https://github.com/deepseek-ai/deepseek-harness)。

使用 Node 24+。已批准的依赖准备入口为 `npm ci --ignore-scripts --no-audit --no-fund`；本批没有安装、下载或升级依赖，也没有修改系统 PATH。

## 适配接口

`createHarnessDriver({dataDir,cwd,instructionsHome})` 必须指定隔离数据根。调用 `createSession({sessionId,cwd,provider,model,options})`、`prompt(sessionId,content,{onEvent,onToolPolicy,onPermission,onToolStart,signal})`，退出调用 `close()`。provider 支持 baseUrl（API 根）、apiKey、protocol、headers、compat、contextWindow、maxTokens、inputModalities、reasoningEfforts。模型及 MCP 凭据仅在驱动内存；磁盘 Host providers 为空，不发现旧版或环境密钥。

`configureSession(sessionId,options)` 在空闲时生效；应用保存并在重启后重新传入。参数：

- systemPrompt、maxTokens、temperature、thinkingEffort 进入真实模型请求；思考档位须由 provider 声明。
- 自定义连接按模型列表的 `owned_by` 选择预览接口：vLLM 使用 `/v1/chat/completions/render`，SGLang 使用 `/v1/tokenize`，保留 API 基础路径和连接鉴权。预览仅渲染实际聊天模板，不生成回答；只有实际改变模板的档位才显示，等效档位合并，并保留服务默认值。结果复用现有能力缓存，刷新模型列表后重新验证。旧服务缺少预览、调用失败或参数被忽略时不推断强度，模型详情显示“尚未确认可用档位”；不以通用参数枚举或模型名称判断支持情况。依据：[vLLM reasoning controls](https://docs.vllm.ai/en/stable/features/reasoning_outputs/)、[SGLang tokenization](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/serving_tokenize.py)。
- maxTurns 限制本次 prompt 主／子 Agent 的官方步骤数；到达后返回 max_turns，历史保留，不标记业务完成。
- autoCompactThreshold（0 到 1）、autoCompact 使用官方 token-meter／compaction-basic；`compact(sessionId,{signal})` 手动压缩，原事件证据保留。
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
