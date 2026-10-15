# Computer Use 消息安全修复实施记录

## R1 当前有效结论：基础设施重做，完整安全发送尚未完成

用户要求复盘后重新修改。**本节覆盖下面所有旧实施结论。旧记录作为历史保留，不代表当前代码能力。**

源码基于 `fix/codepro-context-compaction` 的 `d3004edf0` 加本切片；该提交仅修复 VS 已安装 CMake 的发现。之前 CU 补丁没有提交，没有用旧候选替换运行中的桌面。

### 撤回的内容

- 删除本批发送意图字段、精确收件人硬名单、整任务固定工具白名单及额外插话分类；不改原路由与合同的职责。
- 删除专门的 `computer_select_conversation` 和要求模型遵循固定导航路线的提示。
- 删除 `external_message` 协议枚举及相关会话写入/家族查询，恢复原协议；本批未运行产品会话，无新增该枚举的产品数据迁移。
- 删除观察/视觉调用一失败就清空其他有效观察的补丁。
- 删除把独立视觉返回 JSON 当作视觉发送资格的补丁。独立视觉仍只返回非权威观察，沿用原 `source_expired` 与输入时效检查。
- 删除依赖上述限制的自主发送免确认逻辑；原 `explicit_user_confirmation` 检查保留。不是新增确认策略，也不等于拦住了通用脚本旁路。
- 撤回本批对冻结事实地图的扩展，实施变化只记在本记录及计划 R1。

### 当前实际改动

| 位置 | 前后差异与责任 |
| --- | --- |
| `agents/agent.rs` | 删除按模型名判断后剔除工具图片的输入投影；主调用与摘要调用保留原图片，交由原 Provider 序列化和错误返回 |
| `platform_extensions/computer.rs` | `include_image=true` 实际返回 PNG，不静默降为 metadata；false 明确说明无像素。附图不是服务接受、识别正确或送达证明 |
| `agents/task_scheduler.rs` | 删除“任务文字出现视觉关键词 + 模型名不匹配 → 等待用户”的图片能力猜测；既有宿主工具可用性检查不变 |
| `platform_extensions/tool_registry.rs` | 同步截图工具说明，不再宣称安全降级删图 |
| `computer.rs` 的执行与消息适配器 | 内置 PS 使用进程级 Bypass，保持 BOM/隐藏窗口；Unicode 每字符及提交前检查前台；UIA 当前控件属性复核；检查点绑定 run；对账使用真实 session 与 attempt |
| `computer.rs` 的消息正文限制 | 当前键盘适配器不能安全输入控制字符，输入前明确拒绝，不静默删改正文；这是适配器限制，不规定用户只能发单行消息 |
| `goose-providers/src/openai_compatible.rs` | 添加未知模型名下工具图片仍进入请求 payload 的离线回归用例；本轮未运行 |
| `agents/tool_audit.rs` | 移除图片名称猜测删除后不再使用的字符串访问方法；模型审计值的校验与存储不变 |

模型负责决定观察、导航、工具组合与业务下一步；宿主负责执行实情、权限、作用对象、错误、证据关联和有效期。不新增搜索菜谱、应用专用路由或第二个任务 owner。

### 证据与未完成项

- 格式、构建与 E2E 结果见本节交付补记，不能使用下方旧构建证明本切片。
- 静态追踪：OpenAI-compatible 的 `build_request` 使用原 `formats::openai`，工具图片被序列化为携带 data URL 的图片消息。尚未发起真实模型请求，不能证明当前服务实际收到、接受或正确识别。
- 不支持图片的服务可能拒绝请求，这是可见的真实能力错误；不自动删图重试、不自动换厂商。历史图片的上下文体积也需真实 E2E 观察。
- 原 shell/第三方/委派旁路仍存在，尚不满足“所有等价发送都受统一校验”。没有开放安全自主发送，没有以白名单或提示词假装修复。
- 焦点检查与操作之间仍有 OS 竞争窗口，不承诺原子防抢焦点。脚本乱码未通过修改通用文件写入掩盖；自定义脚本仍须正确编码。
- 独立视觉摘要没有被提升为视觉消息检查点的资格；主模型不能看图时，完整发送能力仍有缺口。
- 旧事故中的 exit 0 不等于业务成功、非业务操作推动续跑等问题未在本切片改动，保留为未修复项。
- 前轮 Computer Use 原生管道不可用；隔离夹具已有但没有跑产品 E2E。真实联系人和外部发送均未操作。

### R1 静态复核

- `git diff --exit-code --` 对路由、统一派发、合同、ToolCallContext、任务关联、协议、会话、独立视觉、通用读图、权限检查和事实地图共 12 个文件退出 0：已与本轮 HEAD 一致，没有残留本批的越权方案。
- 源码搜索未发现本批的 `outbound_recipients`、`check_outbound_message_policy`、`computer_select_conversation`、`ExternalMessage` 或原图片名称猜测函数的残留引用。
- 消息准备在写入 durable intent 之前检查 trace；对账的 origin_session_id 与 prepare 写入的 ctx.session_id 一致，另核对发送 attempt_id。
- `cargo fmt --all` 与本批 `git diff --check` 退出 0。这里只证明格式/差异检查，不证明行为通过。

### R1 构建与交付补记

- 原入口：在 `ui/desktop` 运行 `pnpm.cmd run ensure-dev-backend`。首轮退出 0（4m22s），期间静态复核补了 trace 前置检查并移除新增 unused 方法，所以首轮产物不作为最终证据。
- 源码收尾后再次使用同一入口，退出 0（4m16s）；仅 3 个既有 unused 警告：`main_agent_blocked_message`、`render_main_agent_incomplete`、`explicit_user_validation_invocation`。没有新依赖安装、清缓存或修改系统 PATH。
- 最终产物：`C:\Users\admin\CodeBuddy\target\debug\goose.exe`；2026-09-29 13:38:55 本地时间；331565056 字节；SHA256 `9799d67beb64a9e720e8b78670b27631b3e247ab093a748ce9345422bc6d67ec`。源码为本次提交中的 6 个源码改动，构建结束后未再改源码。
- 旧后端仍占用 `ui/desktop/src/bin/goose.exe`，构建入口未覆盖它。没有重启桌面或宣称运行中的应用已加载新代码。
- 按用户约定未运行单元测试、Clippy 和中间聚焦测试；新增回归用例也未运行。没有执行本轮产品 E2E、真实上游读图或微信发送验收。
- 只提交本批 6 个源码文件及本计划/记录，其他 dirty 改动与本地夹具不纳入；只做本地阶段提交，不推送、不合并。完整安全发送不在本阶段完成声明内。

## 历史记录：R1 前的候选已撤回

以下保留旧调查、构建和实现轨迹，仅用于追溯；其中的实现表与完成判断不能用于当前交付。

## 身份与状态

- 目录：`C:\Users\admin\CodeBuddy`；分支 `fix/codepro-context-compaction`；基准 `ca1d7eefe` 加本批改动。
- 本文不是产品 PASS。没有操作真实联系人，没有发送外部消息，没有修改系统执行策略。
- 用户约定：不跑中间聚焦测试；必要格式、原入口构建、最后隔离 E2E。未运行单元测试及 Clippy。
- 用户追加批准：修复已安装 CMake 的工具发现；执行中插话复用现有语义路由，失败时暂停新动作，不新增状态机。

## 改动与责任

| 文件 | 变化 |
| --- | --- |
| `agents/codepro_intent.rs`、`agent.rs`、`tool_task.rs` | 现有语义入口产生发送限制与收件人，绑定现有任务；缺少执行所需分类进入既有协议修复。插话先保存、分类等待时置为未知，成功后条件更新；问答不修改任务合同或清单 |
| `session/session_manager.rs` | 仅条件更新当前 source/turn 的发送限制，不覆盖其他会话元数据 |
| `agents/extension_manager.rs`、`tool_execution.rs` | 后端及前端工具派发共用限制读取；阻断 shell、通用输入、未知扩展及委派替代发送；传入宿主绑定的收件人交集。只读与内部清单继续可用 |
| `agents/protocol/events.rs`、`main_agent_contract.rs` | 增加明确的 external_message 效果，复用现有需求与完成证据，不根据工具标题判定发送 |
| `session/computer_message_effects.rs` | 读取当前会话家族未结清发送；复用原账本，无新增数据库表或状态机 |
| `platform_extensions/computer.rs`、`tool_registry.rs`、`permission_inspector.rs` | 增加精确 UIA 会话项选择；新旧控件身份复核；准备与发送绑定 run；自主发送仍需派发层的非空目标范围；失焦检查；控制字符正文拒绝；观察失败失效旧依据；进程级 PS 设置 |
| `platform_extensions/computer/vision.rs`、`developer/mod.rs`、`agent.rs` | 独立视觉结果绑定仍有效的截图；主模型不能收图时读图明确报错，去掉误导的 historical 描述；不把视觉结果当送达证明 |
| `ui/desktop/scripts/ensure-dev-backend.cjs` | 复用 VS 安装路径查找已有 CMake，仅设置构建子进程 CMAKE；保留显式配置；发现程序启动失败直接报错 |

## 原事故逐项回溯

来源是前轮核对的 `C:\test\test_0929`、`C:\Users\admin\Desktop\2026-0929-1116cu` 和对应模型请求日志。这里只记录修复对应关系，不把旧证据用于证明新版本通过。

| 原现象 | 当前处理 | 状态与限制 |
| --- | --- | --- |
| 内置 PS 被执行策略拒绝，转而改 CurrentUser 策略 | 宿主临时桥接使用进程级 Bypass，保留 BOM、隐藏窗口、取消 | 已实现，未产品验证；不恢复未知的历史策略值 |
| 截图保存但实际请求没有图 | 读图在能力未确认时明确失败，替换提示说明未提供图片；可用指定独立视觉 | 已实现部分；主模型能力仍依赖既有名称规则，未完成能力元数据迁移；工具附图也不等于上游实际收到图片的网络证据 |
| 无 BOM 中文脚本解码损坏 | 受保护发送不能转任意脚本；宿主桥接已有 BOM 与 UTF-8/base64→Unicode | 未改变通用文件写入编码语义；没有重放事故脚本 |
| 估算坐标、错误窗口、未核对联系人 | 只接收当前观察中的精确会话项；检查点绑定目标与 run；Unicode 每字符输入前和提交前复核前台 | 未产品验证；检查与 OS 输入之间仍有竞态，不能承诺绝对原子性 |
| shell exit 0 被当成消息完成 | 消息覆盖仍要求可信发送回执；shell 路径在保护范围内拒绝 | 不改通用 shell 退出码含义；不是依据错误文本重判 shell |
| 反复写脚本延长执行 | 发送范围内先阻断这些替代路径；unknown 只允许观察与对账 | 通用进展预算未重构，不能称所有无效续跑都解决 |
| 原任务未发送，执行中插话要求发送 | 现有语义路由先处理插话并更新宿主限制，再交主 Agent 行动 | 已实现待验证；已派发的操作不可追溯撤回 |
| unknown 重对账出口 | 保留账本；修复把 session ID 与 trace.run_id 错比的问题，改为当前 session 加真实 attempt 绑定 | 已实现待验证；没有足够历史证据时继续 unknown，不以用户口头确认改成功 |

## 成熟公开实现对照

核对日期：2026-09-29。

1. [Anthropic 官方 Computer Use 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)：宿主依序执行，截图作为工具结果返回；动作失败后停止该批后续动作；建议隔离环境和重大副作用人工确认。采用真实观察、失败停止和隔离验收原则。不把示例中的通用 shell 能力照搬为真实 Windows 消息发送的豁免，也不将其视为全自主收件人安全保证。
2. [官方 quickstarts loop.py](https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/computer_use_demo/loop.py)：本次读取 main 快照，未固定 commit，因此只是公开设计参考，不是依赖升级依据。可核对顺序执行、失败后跳过剩余成员及仅裁剪较旧截图。不能用这些机制替代宿主目标绑定与未知副作用账本。
3. 本地已移植 CUA 0.28.1 合同：`computer_provider/assets.rs` 固定七个文件摘要，`cua_mcp.rs` 固定工具 schema、观察代次与取消后未知处理。本批未改驱动版本、schema 或下载资源。消息桥接仍有宿主 PowerShell 路径，不能宣称所有 CU 输入都已迁到驱动。驱动 MCP 连通不等于收件人验证完成。

有意差异：CodeBuddy 在用户明确授权的 Auto 模式下允许宿主绑定的发送免例行确认；这比隔离演示中的一般输入更严格，也不能由上游示例替本项目背书。最终需要可用性和安全阻断两类真实隔离验收。

## 未完成的证据与限制

- 新增导航仅覆盖当前 UIA 中名称精确一致的 ListItem，没有微信专用搜索适配器；不能因找不到目标回退到通用点击/脚本，也不能据此宣称真实微信全流程可用。
- 当前发送限制在整个含发送目标的任务内保守生效，不是逐阶段的能力沙箱。“开发程序后发消息”等混合任务的早期 shell 也会受限；普通不含发送目标的开发任务不应受限，但这一对照尚未产品验证。不能把这种保守拒绝称作完整可用性修复。
- UIA 控件角色并不是任意第三方应用无副作用的完整保证；截图、语义识别也可能出错。不得拿真实联系人试错。
- 任意已启动后台程序、宿主预配置 hooks 不等于受本次工具派发门禁控制的未来调用；未实现 OS 沙箱或追溯撤销。
- 当前派发读取与 Runtime 动作准入不是跨会话数据库/事件存储的原子事务，严格并发修订边界仍需要隔离 E2E 检查；不能声称消除了全部竞态。
- 新字段/新枚举的回滚边界见事实权威地图；无归属旧记录不猜测迁移。

## 实际验证记录

- `cargo fmt --all`：已运行，退出 0。
- `git diff --check`：已运行，退出 0；仅 CRLF 提示，没有 whitespace 错误。
- `pnpm.cmd run ensure-dev-backend`：前两次在沙箱内失败，入口退出 1、Cargo 101，尚未验证改动编译。进一步只读诊断证明 `vswhere` 在 Node 子进程中被 EPERM 拒绝，旧脚本将其吞掉，最终表现为找不到 CMake。
- 用户授权修复路径发现后，按原入口在获准的沙箱外重建；结果待补记。不清缓存、不安装依赖、不修改系统 PATH。
- 按 computer-use 技能初始化后，`sky.list_apps()` 报 native pipe 不可用（os error 2）。没有执行桌面操作，没有采用脚本点击等替代链路，隔离产品 E2E **未执行**。
- 已准备忽略提交的本地夹具 `.local-e2e-fixtures/cu-message-20260929/index.html`：两名虚构联系人、本地正文/次数回执、错误目标切换和 JSON 导出；CSP 禁止网络请求、没有真实账号。只创建了文件，未启动或验收。验收时要求对“文件传输助手”发送单行中文，检查恰好一次本地回执；然后覆盖失焦、错误目标、缺图、替代工具拒绝及执行中插话，不接触真实微信。
- 尚未启动新桌面；构建成功也不代表 E2E-ready 或产品验收通过。

## 提交边界

只提交本批源码、构建入口及本计划/记录/授权后的所有权说明；不吸收既有 AGENTS、.workbuddy、历史夹具、缓存和其他 Agent 改动。构建入口已独立提交 `d3004edf0`（仅本地）。其余提交与构建结果在完成后补记。没有 push 或分支合并。
