## 2026-10-30 已批准：仅自动任务迁移到 DSH 原生 Schedule

删除或归档聊天通过官方 `workspace/session-stop` 停止其活动原生提醒；取消归档不会重新创建提醒。修改标题或内容不附加时序变更，保留官方已计算的下次运行时间。

范围以用户最终澄清为准：仅自动任务模块，保留 CodeBuddy 其余前端；暂停与继续采用下方已批准的原生队列扩展，不把删除或改频率称作暂停。新建入口进入一条待发送的聊天草稿，由模型通过官方 `dsh-tool-schedule` 创建；`dsh-schedule` 是唯一的新任务持久化、计时、原始聊天绑定、收件箱投递及历史保留 owner。界面目录、卡片、右栏、侧栏时钟只消费原生记录和精确工具的成功结构化回执；不从模型自述提取任务。管理请求沿用原生生成的 Typert codecs 校验，不重新实现时间规则。

提醒由原生 Host 直接 followup 到原始 Session，不中断、steer 或重新发送一条人工 query。CodeBuddy 仅在投递前准备该聊天已有模型、工具与权限，并为其原生轮次接通现有流式、授权、记录和取消观察通道；已有人工轮次接收提醒时继续使用同一通道。子 Agent 不暴露四个提醒工具。投递记录只确认持久化收件箱交付，不能作为模型完成或外部动作成功的证据。

旧 `runtime/schedules.mjs` 规则和历史保留可查，原生接通时停止旧计时器，并拒绝通过退役入口继续创建或启用旧规则，避免双调度。旧版每次新建会话与原生固定聊天投递不等价，不自动改写绑定或悄悄迁移为另一种执行方式；用户可在聊天中重建所需提醒。旧记录不删除。以下早期任务级模型、表单及两种会话方式说明仅描述旧配置，受本节覆盖。

## 2026-10-30 已批准：自动任务界面与任务级模型设置

自动任务的新会话模型选择继续保存在既有 Recipe.settings.goose_provider/goose_model；可选 goose_thinking_effort 仅覆盖该 Recipe 会话的请求，不修改全局或其他聊天。省略或 null 沿用既有模型默认规则，运行前仍由现有模型能力与协议校验拒绝不支持的档位。当前聊天跟进继续继承该聊天的模型、强度及权限，不能附带 Recipe.settings。界面只显示已配置模型和实际可用档位。

自动任务页也可关闭每次新聊天开关；无当前聊天时，必须由用户从既有聊天列表明确选择跟进目标。界面只调用已有会话列表/元信息接口，不加载历史、不切换当前聊天；提交仍使用原有 targetSessionId，目标有效性与运行校验仍由调度器负责。创建时按任务内容首行或 Recipe 标题自动命名，不再显示名称、来源切换及更多设置；既有 Recipe 链接入口保持兼容。

重复菜单将每天、工作日、每周映射到原有 cron；其他旧周期仍可编辑或保留为自定义表达式。Harness 的 cron 解析和调度仍是时间事实 owner。本批不接入系统通知，不新增通知策略、完成状态或原生调度替代实现。


## 2026-10-29 已批准：自动任务的两种会话方式

`runtime/schedules.mjs` 继续持有唯一的自动任务时间调度、暂停、运行记录和持久化配置；日期计算复用锁定 DSH schedule 的现有助手，不加载第二个调度器。任务增加可选 `executionMode` 和 `targetSessionId`，旧数据缺省为 `new_session`。`new_session` 每次通过现有 CodeBuddy `session/new` 创建会话；`current_session` 绑定用户明确选择的当前聊天，通过同一 `Compat.prompt` 和 Harness driver 执行，消费该聊天的实时模型、权限、工具及历史，不覆盖它们，也不改变普通聊天分类。

兼容层提供会话存在、只读、归档及活动状态；调度器据此校验绑定并跳过忙碌聊天的本次自动触发，不抢占手动执行。同一聊天已有调度尝试时也不再启动另一份。跟进 runner 仅取消自己登记的 turn，不能因任务停止而取消随后进入的手动 turn。删除聊天先暂停绑定任务并撤销已测试状态；删除新会话模式的某次结果不删除自动任务。重启后的中断及错过次数沿用现有规则，不重放。运行结束只消费结构化结果，不从模型文字判断成功。

桌面移除常用任务导航入口；旧 Recipe 数据、链接和定时任务快照继续兼容。创建自动任务默认直接填写指令，默认每次新会话；只有确有当前聊天时才能选择跟进。跟进只接受任务指令，模型与工具配置仍归聊天自身所有。测试执行仍使用隔离数据；源码、自动回归与真实桌面验收分别记录。


# CodePro 事实权威与模块职责

## 2026-10-29 已批准：外部源码链接的单次只读预览

同日用户批准统一模型选择入口：聊天输入框中显式选择模型成功后，通过现有 ModelAndProviderContext 同步保存当前会话选择与新会话默认选择；打开旧会话本身不重写默认值。设置页移除独立的当前模型切换卡片。默认提供商不是“正在执行”的事实，前端不再据此阻止删除连接；删除仍须用户确认，运行时 checkProviderMutation 保留对活跃主会话、识图、审查等实际使用的保护。删除默认连接时由现有 runtime 清空默认值，前端刷新默认状态；历史会话不自动改写为其他模型。

同日用户追加批准：点击会话中的外部源码链接直接在右侧只读预览，取消二次确认框。Electron 主进程仍校验真实路径、常规文件、大小和文本类型，读取期间路径、会话或窗口变化则拒绝。renderer 只接收本次只读内容，以会话作用域内的临时标签显示，不生成编辑、保存或执行入口。预览不扩大工作区根目录，不授权 Harness 或模型读取该文件，不持久化目录许可；工作区内文件以及原有写入、终端、媒体和脚本打开路径保持原权限边界。

用户最终批准：左键右侧预览并定位行号；Ctrl/Meta 左键将源码交给全局默认代码编辑器，媒体和普通文档继续使用系统默认应用。首次使用或已选编辑器失效时，Electron 主进程检测常见安装目录及 PATH，弹出选择菜单；取消或无编辑器时返回右侧预览。用户可在右键“打开方式”中更换默认代码编辑器。主进程经显式选择及启动成功后，通过现有 settings.json 的 defaultCodeEditor 保存程序路径、显示名及有限的行号参数类型；通用 renderer set-setting 不接受此键。旧设置缺失时默认为 null，不迁移或修改 Windows 文件关联。启动前校验当前窗口、会话、目标文件及程序路径；不使用 vscode://、命令拼接或 shell。源码启动使用选定程序及参数数组，支持的编辑器携带行号，普通文档仅传真实路径。原有外部目录枚举、Agent 读取、文件原路径保存边界不变；编辑器偏好不授予模型外部文件权限。参考官方 https://learn.chatgpt.com/docs/app/windows 的 Preferred editor：只采用明确选择默认编辑器的行为，不新增项目级覆盖，不宣称复制 Codex 内部实现。

## 2026-10-28 已批准：媒体业务展示元数据

主 Agent 在原生图片/视频生成请求中给出可选 `display_name`，表示用户可识别的业务名称。`comfyui-tool.mjs` 校验、保存并经原任务回执与 `/jobs` 发布；无效或缺失名称只降级展示，不阻断生成。名称不进入执行输入、权限范围、幂等参数比较或完成判断，重试保留已存名称。旧记录无需迁移，前端不从思考、编号、文件名或提示词片段另造业务名称。

提交期间可展示该次 `generate` 请求的显式名称；任务关联仍须已有真实回执，随后优先使用 owner 确认的名称。回执缺少可选名称时可保留原提交名称，不能用 `status`/`cancel` 请求改名。用户确认本批只修新任务，旧会话不补名，不增加后台命名或历史迁移。

同一 owner 在现有错误分支发布可选 `failure_info` 或临时 `observation_error_info`，区分提交、远端执行、状态查询、结果获取、校验和保存阶段。该元数据只解释既有状态或观察异常，不改变 throw/return、取消、重试与状态转换。没有稳定错误码时不从错误文字推断共同根因；原始回执完整保留。

聊天只对已确认采用该合同的原生工具，按会话、媒体种类和任务 ID 聚合多次调用。状态继续由原生任务 owner 确认；工具调用成功及 Agent 结束均不表示生成完成。普通工具与未经适配的外部 MCP 保留原展示和执行语义，思考留在原过程位置。产物仍通过现有工作区文件能力打开，不按业务名改路径。

## 2026-10-27 已批准：业务能力的会话授权

电脑操作、图片生成和视频生成分别申请会话授权，不隐含彼此权限。受信工厂声明业务范围；内置电脑操作只绑定已校验的固定 MCP 驱动、连接及已登记工具定义，远端注解、同名自定义 MCP 和模型文字不能制造业务授权。当前电脑操作范围为桌面读取及鼠标键盘能力，不承诺按应用隔离或只读；不升级或替换驱动。媒体沿用现有服务、工作区、会话和任务记录绑定，不扩展文件访问、输出目录或取消范围。

Harness 继续持有执行策略、审批请求、取消和审计。兼容层复用现有 owner 与工具身份授权存储，只有明确支持业务范围展示的客户端才能申请业务授权；旧客户端保留逐工具选择。每次调用仍先经过启用状态、明确禁止、逐次确认和安全检查；会话许可不能越过它们。同业务并发请求共享待决选择，允许一次仍只批准当前调用；工具重连、定义或范围配置变化，以及原生会话 owner 释放或进程重启使相关许可失效。renderer 只展示宿主提供的准确范围和返回选择，不保存执行授权。撤销后续访问不表示已经派发的输入被撤回，未知结果仍由原执行回执与后续观察核对。

繁體：三種業務分別取得明示會話許可，沿用 Host 身分與既有安全檢查；舊客戶端仍逐工具詢問，不更換驅動、不承諾應用隔離。English: Computer use, image generation and video generation have independent explicit session grants. Trusted factories and live definitions own scope; Harness retains execution policy and approval audit. Older clients keep per-tool grants, and existing safety checks remain authoritative. No driver upgrade or app-isolation claim is introduced.
## 2026-10-30 已批准：素材删除、分组与容量

本节扩展 2026-10-29 素材库的只读范围：用户已批准通过素材库主动删除选中素材。生成工具仍唯一写入生成任务回执；`runtime/media-library.mjs` 根据会话和回执解析素材 ID，只删除生成目录内经过逐级普通路径检查的文件，不接受客户端文件路径，不递归删除目录或改写生成回执。成功删除或已缺失的输出将其稳定 ID 写入现有 store 的 `mediaLibraryDeleted` 根字段，由素材库独占写入；后续投影排除该 ID。删除仅由显式确认请求触发，逐项返回真实结果，失败项不标记成功；持久化失败可安全重试。

容量来自当前可访问文件的逻辑字节数，同一路径去重、缺失文件不计入；不声称文件系统实际分配空间或生成目录全部占用。全库容量、筛选结果容量、工作区筛选结果容量均在分页前计算。时间视图全局从新到旧；工作区视图按目录分组、区内从新到旧，游标与视图保持一致。桌面消费统计与回执，确认框列出待删除文件，不从模型文字推断删除授权。

素材全选通过列表的可选 `all: true` 查询取得全部匹配项，分页不决定选择范围；删除仍以逐项真实 ID、显式确认和单请求最多 500 项为边界。容量来自每次查询的文件元数据，回执解析缓存只用于性能，不成为持久事实来源。工作区显示名称继续由 `projectAliases` 持有，素材库只消费并监听名称更新。

## 2026-10-29 已批准：自定义智能体与工作区角色

`runtime/agent-profiles.mjs` 持有角色模板校验、版本及工作区绑定快照，存于现有 store 的 `agentProfiles`、`agentWorkspaces`；不保存模型或 MCP 凭据。创建工作区复用 WorkspaceService 租约，新的同目录及子目录会话从规范路径绑定继承角色，模板编辑或删除不改变既有快照。兼容层持有会话投影、固定模型、人设和服务选择，不接受客户端替换角色快照；普通工作区保持原行为。角色能力取配置与全局可用能力的交集，不能提升原有审批或沙箱权限。

Harness 官方包保持不变。宿主 `runtime/harness/agent-policy.mjs` 继承公开 SkillRegistry 接口过滤 list/snapshot/get，宿主适配器通过原生 scoped toolFilter 与 monotonic guard 约束工具执行；原生子智能体继承同一宿主能力配置。延迟工具发现只展示已准入能力。角色提示词约束模型表达，但不作为授权、完成或执行事实；角色 Skill 清单不是文件访问隔离。桌面只编辑模板、请求创建及展示角色摘要；语音本期不实现。

## 2026-10-29 已批准：跨会话素材库

图像与视频工具继续持有生成任务回执和作品发布，文件仍位于对应会话工作区。`media-library.mjs` 只读聚合当前产品会话（含归档会话）的完成回执，按类型、工作目录和文本筛选并分页；不调用 ComfyUI、不刷新任务、不创建第二份持久索引。桌面素材库消费该投影，文件预览和打开位置复用现有工作区访问边界。缺失文件显示不可用，损坏或越界记录不授予文件访问；已删除会话或已清除回执不能仅凭散落文件重建来源。读取列表不改变执行、审批或完成状态。

## 2026-10-29 已批准：Inno 历史目录、进程检查与可选数据清理

Inno 使用同一 AppId 的安装记录恢复默认程序目录；不承担 Squirrel 安装迁移。安装和卸载通过只读进程检查要求用户退出 CodeBuddy 及当前安装目录内的后台进程，检查失败停止，不强制结束任务。

交互式卸载窗口持有本次“清理个人数据”的选择，默认关闭；静默卸载始终保留数据。数据位置仍由既有 storage-management 定位规则持有。用户确认后、Inno 删除程序前，随包 `windows-uninstall.cjs` 取得原生 profile 锁、校验位置及文件身份，只清理已知数据子目录，保留工作区、已登记项目、其他根目录文件和历史数据。锁文件及诊断报告可保留；链接、损坏元数据、活动会话或身份变化阻止清理，IO 失败可能部分清理并中止程序卸载。此操作不暴露为 Agent/MCP 工具，不改变 Harness 任务状态或 Mac 卸载规则。实现与原生安装验收分别记录。
## 2026-10-27 已批准：共享技能发现与启用

`runtime/harness/skill-catalog.mjs` 统一提供文件系统技能发现、真实路径去重、同名优先级及诊断；Harness 注册表消费可调用候选，Library 消费同一目录快照展示待启用、已启用和被覆盖的来源。保留原有 Harness 根目录顺序，用户共享 `~/.agents/skills` 排在应用自有目录之后。已有应用技能不迁移、不复制；旧客户端缺少新增字段仍可展示基础信息。

共享技能默认仅出现在工具箱。用户通过现有技能管理确认通道启用后，选择持久化在当前 profile 的 `backend/harness/shared-skills.json`，键为真实文件路径；其他应用的技能文件保持原样。启用只允许加载该技能说明，工具执行继续由 Harness 权限与沙箱处理。禁用阻止后续加载，不追溯删除已有会话消息。目录、文件元数据和策略变化使缓存失效；工具箱打开/重新获得焦点、发送下一轮及加载技能时核对目录。未知或损坏文档报告诊断，不把安装成功表述为实际调用已通过。

繁體：共用技能目錄由同一個 catalog 提供給工具箱與 Harness。共用技能預設待啟用，確認後將選擇儲存在目前 profile；不修改來源檔案。真實路徑去重、同名優先序、變更失效及診斷由 catalog 負責，執行權限仍屬 Harness。

English: One filesystem catalog supplies toolbox inventory and Harness candidates. Shared skills start pending consent; profile-local invocation choices never modify shared source files. The catalog owns canonical-path deduplication, precedence, invalidation and diagnostics. Harness remains authoritative for execution and permissions. Existing conversation messages are not retroactively erased by disabling a skill.

## 2026-10-27 已批准：公开网页读取会话授权与真实工具发现

本节覆盖下文网页读取的 origin 范围。原生 `web_fetch` 按根 Agent、实际工具定义及 Web 服务身份共享“本会话允许网页读取”；仅适用匿名公开 HTTP(S) 读取。Compat 仍持有内存授权，Harness 仍负责执行，ACP 使用 `authorizationGroup: web_read` 和 `permissionClass: read_only` 展示范围。保留单次允许、拒绝、明确禁止和逐次询问。重启、根会话销毁、对应能力失效或同名实现替换不继承授权；旧源站审批历史仍按原范围显示。原生公网地址、DNS、重定向、凭据、超时和大小限制不变。

扩展已有 `available_tools` 选择传入同一 MCP 注册层，按服务端原始工具名过滤，再与角色过滤相交；空选择保留既有全量语义。断线期间注销工具，重连后由注册层恢复清单，不重放动作。模型发现和界面都消费真实注册表。查找可用工具作为可见只读动作展示；相邻思考仅在界面合并，不修改原生会话、模型请求和工具边界。

繁體：原生公開網頁讀取共用根對話的明確授權，保留單次允許、拒絕與原有網路限制。工具清單遵循擴充功能既有選擇與連線狀態。介面顯示工具查找並合併相鄰思考，執行與記錄仍由 Harness 持有。

English: Explicit public web-reading consent is bound to the root agent and native implementation/service identity, with once, reject, explicit rules and network restrictions preserved. Existing tool selections filter the actual MCP registry; disconnected tools are removed until recovery without replay. Discovery becomes visible, and adjacent reasoning is combined only in presentation. Harness retains execution and history authority; Compat retains in-memory grants. Legacy origin cards retain their original scope.

## 2026-10-27 已批准：统一 MCP 会话授权与局部失效

本节扩展下方电脑控制方案。内置和用户自建 HTTP/stdio MCP 均以真实连接、当前工具清单为授权单元，共享该模块工具及资源访问的会话授权。界面显示“本会话允许使用〈模块名〉”，保留单次允许和拒绝。Harness MCP 适配层创建 `mcp_module` 身份，提供配置来源的 `authorizationModule` 名称；Compat 持有原有内存授权，桌面只消费结构化范围。不同模块、聊天及重启后不继承授权，破坏性工具、明确禁止、逐次询问和安全检查仍优先。无关提示词或扩展设置不清空授权；修改、停用对应扩展时立即撤销该模块身份，晚到答复作废。现有连接组合确实被重建时仍按重连重新确认。

宿主内置能力沿用各工厂既定范围（浏览器、图像、视频、桌面宠物、项目记忆），网页读取仍限当前源站，不把整个开发者工具组作为可复用权限。旧审批卡片保持原范围；无结构化模块标记时不推断整组授权。

繁體：內建及自訂 HTTP/stdio MCP 以目前連線與工具清單共用模組會話授權，涵蓋工具與資源存取。保留單次允許、拒絕與個別規則。無關設定保留授權；修改或停用該擴充時撤銷其身分及待答覆，重連、清單變更與重啟後重新確認。宿主能力和匿名網站讀取沿用原有範圍，介面只顯示結構化授權。

English: Built-in and custom HTTP/stdio MCP tools and resources share explicit session consent bound to the live module and current catalog. Allow-once, reject and individual rules remain authoritative. Unrelated settings preserve grants; changing or disabling the affected extension revokes its identity and pending answers. Reconnects, catalog changes and restarts require new consent. Host capabilities and anonymous web reads retain their existing tool/origin boundaries. The renderer only presents structured permission metadata.

## 2026-10-27 已批准：电脑控制按模块授予本会话权限

用户选择“本会话允许电脑控制”后，当前聊天及其所属子 Agent 复用当前电脑控制模块全部可复用工具的授权。“仅此次允许”仍只覆盖当前调用。Harness MCP 连接适配层持有真实注册定义、连接代次及工具清单身份；`qwen_computer` 的整组身份只由该层建立，不能由模型参数、工具名字前缀、远端注解或界面文案创建。Compat 继续使用既有会话授权缓存与 ACP 审批答复；桌面消费结构化 `authorizationGroup: computer_control` 展示授权范围，不另存权限事实。

授权仅在内存中存活，不写全局规则、不扩展到其他聊天或模块。连接替换、重连、清单增加/删除/定义变化或会话身份释放后失效；相同清单刷新保留。明确禁止、逐次询问规则及安全检查优先于整组授权，标记为破坏性的工具不进入可复用授权。旧审批卡片缺少整组标记时继续显示单工具范围。Harness 的执行、取消和完成权威不变。

繁體：使用者選擇「本會話允許電腦控制」後，同一聊天及其所屬子 Agent 共用目前模組的可重用工具授權；僅此次允許仍只涵蓋當次呼叫。MCP 適配層持有連線與清單身分，Compat 沿用現有記憶體授權與 ACP 答覆，介面只顯示結構化範圍。重啟、重連、清單或會話身分變更後重新確認；明確禁止、逐次詢問與安全檢查優先，其他模組與舊卡片不擴權。

English: An explicit “Allow computer control for this session” choice covers reusable tools in the current module for that conversation and its owned agents. Allow-once remains call-specific. The MCP adapter owns live connection, registered definition and catalog identities; Compat reuses the existing in-memory grant and ACP reply, while the UI only renders structured scope. Restart, reconnection, catalog changes and released session identities invalidate the grant. Explicit deny, ask-before and safety checks take precedence; destructive tools, other modules and legacy cards do not inherit broader authority.

## 2026-10-27 已批准：新任务草稿跨重启保存

2026-11-02 更新：设置页、新任务及已有对话共用本机配置 gooseMode。用户显式选择后，Compat 将预设应用到已打开和后续加载的可执行根会话。Harness 负责实际执行权限，逐工具授权仍按原范围保存。

繁體：設定、新任務及既有對話共用本機 gooseMode。明確選擇後套用到目前及後續載入的可執行根會話。Harness 裁決實際權限，個別工具授權維持原範圍。

English: Settings, new tasks and existing chats share this device's gooseMode preference. An explicit choice applies to open and subsequently loaded executable root sessions. Harness enforces the effective preset and tool grants retain their scope.

用户批准将新任务文字、目录及附件保存到本地并在重启后恢复。Electron `drafts/DraftStore` 持有按窗口槽位和聊天模式隔离的草稿文件及附件副本；renderer 仅缓存已恢复内容、提交字段更新并显示保存错误，不以草稿恢复启动任务。普通/CodePro 会话创建成功回执触发草稿清空，失败保留；已发送历史引用的附件副本继续存在。正常退出等待已接收的草稿写入。该缓存不更改 Harness 的任务、会话、权限或完成权威。最近目录文件继续由 `utils/recentDirs` 写入，原生菜单订阅保存通知刷新。

繁體：Electron 擁有按視窗與模式隔離的本機草稿及附件副本，介面恢復草稿不啟動任務；會話建立成功清空草稿，失敗保留，正常結束等待寫入。最近目錄儲存後通知原生選單刷新。Harness 執行權責不變。

English: Electron owns local draft files and attachment snapshots isolated by window slot and chat mode. Hydration never launches a task. Session creation acceptance clears the draft; rejection retains it, and normal exit drains admitted writes. Sent-history attachment copies remain valid. Recent-directory persistence notifies the native menu. Harness execution authority is unchanged.

## 2026-10-26 已批准：桌面更新与确认后停止任务

Electron 主进程的 `update/` 持有更新频道、GitHub Release 与文件身份、下载状态和安装调度。用户自己的 GitHub CLI 登录提供瞬时凭据；不使用 GitHub MCP 凭据、不复制到设置或安装包，不向 renderer 或 CDN 转发 Token。renderer 只发起检查、下载、取消和确认安装，消费主进程状态。Windows Inno 负责安装目录中的程序更新，Mac Squirrel.Mac 负责签名应用替换；更新器不迁移、清空聊天、配置、工作区或凭据。

Harness 仍持有任务与持久化权威。下载不要求任务空闲；桌面明确提示重启会停止对话和自动任务、关闭终端，并保留已保存的数据。选择“稍后”不停止工作。用户确认后，运行服务阻止新请求及调度，调用原生取消、等待任务和已接收的设置请求收尾，再 flush/close；桌面收到保存确认及正常退出后才交给安装器。停止或保存失败不启动安装，也不以超时强制终止代替保存成功。原有未确认调用仍使用空闲检查。被中断的工作不由更新器自动续跑，调度后续运行继续遵循原有配置。桌面阻止新终端，已有终端按应用退出生命周期关闭。安装成功后由新版启动确认实际版本。正式频道不接收预发布，源码预览不执行安装。

繁體：下載不受執行中的工作阻擋。使用者確認中斷後，Harness 封鎖新工作與排程、取消執行、等待已接收請求並儲存關閉；停止或儲存失敗不安裝。稍後更新不停止工作，中斷工作不自動續跑，後續排程仍依原設定。Electron 管理確認、終端與更新；Inno 與 Squirrel.Mac 負責程式升級，不變更聊天、設定或工作區。

English: Electron owns release selection, transient CLI credentials, downloads, confirmation and installation. Downloading does not require idle tasks. After explicit interruption consent, Harness fences new work and schedules, cancels tasks, drains admitted requests and flushes before acknowledging shutdown. Installation requires that acknowledgement and a clean exit, never a timeout or forced kill. Choosing Later does not stop work. Interrupted attempts are not resumed by the updater; future scheduled runs follow existing settings. Inno and Squirrel.Mac replace application files without deleting conversations, configuration, credentials or workspaces. The renderer receives state, never tokens.

## 2026-10-23 已批准：子 Agent 完整只读会话展示

DSH alpha2 的原生会话日志、父子 catalog 和 session controller 持有子会话身份、历史与实时 assistant stream。CodeBuddy 只通过原生 `subagent` 地址的 `follow` 观察已验证的父子关系，不使用普通 session 地址激活子 Agent，不改变调度、停止、恢复、审批与完成语义。兼容层按连接管理只读观察订阅；断开或关闭面板只取消观察，不取消子任务。切换或 fork 后旧根地址失效，不能向新聊天发布旧子会话内容。

桌面复用主聊天的消息、Markdown、思考和工具回执渲染。公开委派、思考、文字和文件差异完整呈现；事件分页仍限制批次数量与通常体积，单个较大的原生事件保持完整。provider/replay 状态、认证信息、系统及注入上下文不进入展示。观察数据仅用于展示，不能作为工具执行、授权或完成判断。断线后只读重连以原生快照替换展示，不重放模型或工具动作。

工具输入准备态复用锁定 DSH 的 `PartialArguments`，只投影调用身份、工具名、完整且解码有效的路径和已接收内容大小。大小按解码后UTF-16长度换算KB，是生成进度而非落盘字节数。主聊天通过已有临时 execution_activity 通道接收，子级通过只读 follow 接收；均不写入聊天历史、不计为实际修改或审批。原生 `tool/call` 才发布调用展示，block-end 不代表执行；停止、失败、重试或失去当前会话身份会清除准备态。正文中的路径和修复后的部分JSON不得充当真实参数。

桌面 locale 作为可选的当前语言提示随 prompt 传入，兼容层只传递规范化语言代码，原生 scoped system prompt 为主子 Agent 设置默认回复及委派语言。用户明确要求其他语言仍优先；历史记录、代码和原始工具输出不翻译，模型实际遵循情况需单独验收。此提示不持有执行状态或权限，也不替换现有持久化设置。

繁體：子會話使用原生唯讀 follow，關閉僅停止觀察；完整顯示公開記錄，權限與執行仍由 Harness 持有。English: Native read-only child follow owns synchronization; closing a viewer never stops or resumes execution, and display projections cannot authorize actions.
## 2026-10-26 已批准：GitHub 默认连接与简化入口

本节补充并覆盖下方 2026-10-23 的入口限制：首次配置默认启用官方 GitHub，已有本人 CLI 登录时自动调用同一凭据验证与加密保存流程；保留已有连接、自定义地址和明确停用选择。设置和工具箱共用简洁账号连接界面；代码仓库卡片展示在技能的内置技能区，展示分组不改变底层工具身份、配置或执行权威。未登录仍需用户完成自己的 GitHub 授权，安装包不包含共享 Token。并发连接合并为同一在途操作。

繁體：首次設定預設啟用官方 GitHub，已有本人 CLI 登入時沿用同一驗證流程自動連線；保留既有連線、自訂位址與停用選擇。儲存庫卡片位於內建技能區，分組不改變工具身分與執行權責，安裝包不含共用 Token。

English: Fresh configuration enables official GitHub and reuses the user's existing CLI login through the same verified encrypted-credential flow. Existing connections, custom endpoints and explicit opt-outs are retained. The repository card appears under built-in skills; grouping does not change tool identity or execution ownership. Concurrent connection requests share one operation. Packages contain no shared tokens.

### 2026-10-23 原连接协议与所有权（入口由上节覆盖）

用户明确点击“连接 GitHub”后，runtime 核对 GitHub CLI 当前账号，仅对固定官方 MCP 地址验证凭据，验证成功且配置未变化时原子保存加密凭据与启用状态。新登录在浏览器授权完成后继续同一次连接流程；打开页面和检查状态不复制凭据。CLI/系统凭据库继续持有登录凭据，CodeBuddy store 持有独立加密副本；退出 CLI 不删除该副本。凭据不返回界面、不进入诊断或日志，失败不覆盖已有配置。安装包不携带此凭据。

工具箱与账号设置复用“代码仓库”连接界面，仅在显示层合并本地 Git 与官方 GitHub。原配置身份、执行职责和会话选择不变；两个启用开关分别影响新任务默认配置，已有聊天保留其选择。旧详情链接转入统一界面，自定义远端地址仍保留独立配置。启用状态不等于 Git 命令已验证成功。

繁體：工具箱與帳號設定共用「程式碼儲存庫」介面；新登入在明確授權後繼續驗證 GitHub。保留原設定身分與執行權責，啟用開關只變更新任務預設，既有聊天選擇不變；自訂遠端不併入官方連線。

English: Toolbox and account settings share Code repositories controls. An explicitly started sign-in continues into GitHub verification. Grouping changes presentation only; configuration identities and execution owners remain unchanged. Toggles affect new-task defaults, existing chats retain their selection, and custom endpoints retain separate controls. Enabled does not imply verified Git command execution.

繁體：明確連線 GitHub MCP 時，核對 CLI 帳號與固定官方位址，驗證成功且設定未變才儲存獨立加密副本；登出 CLI 不刪除此副本，憑據不回傳介面、不納入安裝包。

English: Explicit GitHub MCP connection verifies the current CLI account and fixed official endpoint before atomically saving a separate encrypted credential copy. CLI logout leaves that copy unchanged. Credentials never reach the renderer, diagnostics, logs, or distribution packages. Harness retains execution and terminal-state authority.

## 2026-10-22 已批准：双入口浏览器控制

Harness 继续持有工具发现、审批、执行与完成判断。browser_control 经现有 ACP 请求连接到 Electron 工作台；Electron 持有当前窗口、会话、真实工作区路径和 WebContentsView 身份，只接受有限操作，不暴露全局调试端口。页面观察与输入回执分别返回；派发成功不等于页面行为已成功。后台会话的浏览器标签由现有工作台状态保存，不能转移到另一会话。

独立浏览器与用户浏览器使用锁定版本的 Microsoft Playwright MCP，分别消费隔离配置和官方扩展连接；用户浏览器由用户选择并确认标签页，不复制日常浏览器 profile。工作区 HTML 预览只服务选中文件同目录的公开网页资源，关闭标签或宿主时释放服务。旧配置和历史不迁移；设置中移除“工具与连接”入口不删除用户数据或改变工具箱配置。

繁體：Harness 持有執行與審批；Electron 管理會話內嵌頁面，Playwright MCP 管理獨立或使用者選擇的瀏覽器。English: Harness owns execution and approval; Electron owns embedded session pages and Playwright MCP owns isolated or user-selected browsers.

## 2026-10-22 已批准：Mac 原生卸载与安装界面

Electron 主进程持有原生菜单选择、最终路径确认和退出流程；独立卸载 worker 在主进程与 Harness 服务退出后，重新校验应用身份、目录身份及清理白名单并记录逐项结果。该流程不暴露为 Agent/MCP 工具，不改变 Harness 执行与完成语义。普通卸载只移除当前应用副本；清理模式删除已知应用数据，项目默认保留，应用管理工作区需要单独勾选。外部项目、未知文件、其他安装副本和旧迁移目录保持原样。

数据根继续消费既有 storage-management 位置结果，不恢复存储管理页面或迁移操作。清理专用钥匙串及 TCC 仅发生于用户确认的清理卸载；更新不触发。系统拒绝和残留由真实回执判定，逻辑容量不视为实际磁盘释放量。DMG 布局由打包脚本负责，验收状态另行记录。

繁體：原生選單確認後由卸載 worker 執行，專案預設保留，更新不清理資料。English: Native menu confirmation authorizes a dedicated uninstall worker; projects remain by default and updates never run cleanup.

## 2026-10-21 已批准：子 Agent 停止交接与只读终态上下文

DSH 继续持有子 Agent 生命周期、原生收件箱和 `turn/start`、`turn/end` 事实。CodeBuddy 在取消所属运行后，使用同步的原生 `turn/start` 边界阻止后续取消息，不在已经 claim 的 `pre-step` 阶段假定 `keepInbox` 能恢复消息。当前取消请求自身尚未处理的人工输入，使用原生队列移除接口清理；不删除其他人工排队输入或子 Agent 通知。

根 Agent 空闲且待处理 next-turn 项全部为原生 `subagent-settled` 时，新人工输入通过公开 `steer` 投递。2026-10-22 经用户授权接入补充：适配层使用原生 `agent/pre-step` 将余下原始通知纳入同一人工输入步骤，保留各自 id、source 和完整内容；先由 DSH 记录原生 `user/message`，再通过原生 Inbox 接口移除精确匹配的待处理项，不采用先移除再插入的队列搬移。重启后的核对仍只读取原生日志和原生 Inbox，不持久化第二份待交付或已交付状态。接入仅限当前根执行，混合人工队列保留原生 FIFO，不过滤完成、失败或停止通知，也不修改子 Agent 调度、权限和终态语义。宿主正常关闭仍遵守原生销毁与队列清理语义，不重放已清除通知。恢复及后续模型请求通过原生运行上下文读取本聊天 catalog 和对应子会话的实际末轮边界；缺失终态保持未知，不从 inactive、模型报告或进度文字推断停止或成功。该上下文是只读快照，没有独立状态或完成判定。

审批中的调用参数按原生 Agent ID 和 call ID 共同关联，不能只以模型 call ID 跨会话索引。既有精确工具授权和连接失效规则保留，不把 MCP 开关、远端注解或其他聊天的审批视为授权。

文件卡片与工作台复用同一只读工具回执投影。子级文件操作按原生日志中的人工输入 admission 与 rpcId 划分显示轮次，不用兼容层秒级时间排序，也不把显示归属当作子任务因果或完成事实；无法确定的归属不计入主轮次。只读预加载缓存独立失效，主聊天子树与后台连接不能因切换缓存而重挂。

## 2026-10-21 已批准：alpha2 原生权限预设与审批接线

保留官方 `0.2.1-alpha.2` 依赖与现有桌面，仅调整权限选项及必需接线。DSH 的 `permissionPresets`、`sandboxPolicy`、`approval` 持有当前 Agent 的预设、文件/命令沙箱与审批事实；会话原生日志负责持久化及恢复。ACP `session/set_mode` 调用原生 setter，再发布确认后的 `current_mode_update`。产品聊天 ID 到原生 ID 的转换只在 conversation driver 进行。全局默认只属于新会话的创建输入，不覆盖已保存的原生选择。

选项为 `read-only`、`workspace-write`、`danger-full-access`。旧 `approve/smart_approve/auto/chat` 不能解释成同名原生授权；缺少原生权限记录的旧会话以只读方式初始化，不自动把旧放行扩为原生完全权限。已有原生记录和 fork 继承记录优先，读取不按产品旧字段重设权限。

DSH 子 Agent 保留原生创建时捕获的沙箱范围及非交互 `approval: never`；父级后续切换不广播覆盖已有子级。这一条覆盖 2026-10-17、2026-10-18 章节的“子级实时消费根会话旧三态”约定。适配层不再按旧模式拒绝子级，也不把原生拒绝改写成产品成功。

CodeBuddy 继续持有连接鉴权、凭据保护、工具启用与明确禁用、可信工具定义及已有显式授权绑定。`tools/pre-execute` 仅把这些边界和用户启用的安全检查编译为原生 allow/deny/ask；需要 Agent 审批时交给 DSH 的请求、非交互拒绝、取消和审计，现有 ACP 表单仅提供答复。远端 MCP 注解不自动授予权限，非沙箱能力不能因移除旧审批模式而静默放开。原生 `tools/execute` 只为既有审计提供派发观测，不代表实际副作用成功。

直接 UI 操作没有模型 turn，沿用原有的显式用户确认和原生 maintenance/工具执行；不伪造原生 Agent 审批审计，也不把一次 UI 确认写成模型长期权限。原生 Windows 沙箱的已知兼容问题本轮仅记录，不修补官方包；实施和实际验收结果另行记录。
## 2026-10-21 用户修订：移除存储管理

设置中的存储管理页面、导航、手动缓存清理、空间统计和迁移 IPC 及 worker 已移除。runtime/storage-management.cjs 只保留已有数据位置和旧迁移记录的兼容读取与启动占用检查；安装器不选择、迁移或覆盖数据位置。默认 ~/.CodeBuddy，已保存位置优先，不因功能移除重置或删除数据。Harness 继续拥有会话、执行和任务状态；既有 Electron 自动缓存维护不变。

繁體：儲存管理入口與操作已移除，保留既有資料位置相容讀取，不刪除資料。English: Storage management actions are removed; existing data locations remain compatible and no user data is deleted.

## 2026-10-19 已批准：安装版手动配置与模型能力读取

安装版默认使用 `~/.CodeBuddy`，不再重命名或沿用旧 `~/.CodeBuddy-Harness`，也不导入预览版 `.preview-data`。旧目录保持原样；显式数据目录覆盖仍有效，安装版自身的已保存配置在后续启动和升级时保留。预览版继续沿用其现有数据目录。此条覆盖此前自动更名及占用时回退旧目录的规则，不删除或清空任何用户数据。

模型连接由用户在设置中创建，runtime store 持有记录；首次引导只读取配置清单，不再发现、创建内网连接或写入默认模型。保存连接仍实际验证所选聊天模型，成功后关闭配置表单；当前模型由用户在聊天栏通过原有事务选择，不再自动弹出第二个选模窗口。

连接卡片读取已保存的本地清单，不等待远端逐模型能力请求；保存表单在该本地清单刷新后关闭，避免出现仅剩“添加提供商”的假空状态。聊天模型列表按需读取服务清单并过滤已声明的非聊天模型，具体思考与上下文能力继续按现有缓存读取。未选择默认模型是正常状态，设置页显示选择入口；只有非空但不存在的提供商身份才保留未知配置错误。

runtime Provider 适配层消费 Ollama 公开能力，区分聊天与决策、嵌入模型，不按模型名称猜测；本地及云端 Ollama 的模型清单使用 `/api/tags`。未知能力仍可尝试现有聊天协议，已声明不支持 completion 的模型不进入聊天选择或验证请求。此处不新增决策、嵌入执行协议。思考能力允许布尔开关与命名档位混合；失效的可选默认值、旧保存档位不再阻断整组模型读取或被发送到不支持它的模型，读取不改写旧偏好，新的显式选择仍按当前能力校验。认证失败和真实接口失败继续报告，不能因模型列表可读就宣布连接可用。

模型请求、能力读取和切换使用同一套源码逻辑；预览版与安装版只在启动环境、数据目录和交付形态上区别。自动回归、源码桌面验收与安装包验收分别记录，本表不宣布产品通过。

## 2026-10-19 已批准：按模型保存思考强度与能力选项

现有 provider 配置持有 `thinkingEfforts[modelId]`，只保存用户明确选择的档位，不保存思考文本、凭据或会话上下文。模型能力来自既有服务商发现缓存及锁定版 DSH/pi-ai 公开目录；界面与执行器消费同一解析结果。Ollama 兼容接口使用其公开 `reasoning_effort` 控制，其他 Gemma 模板部署保留原有 chat-template 传输。此处覆盖下方将所有 Gemma 部署统一视为模板协议的旧说明，不修改 DSH 安装包。

已确认具备思考能力且没有用户选择的模型默认开启，优先使用模型推荐档位或 medium；旧全局偏好仅在该模型明确支持时作为兼容回退。单模型偏好优先，不把模型 A 的新选择写入模型 B 或全局默认。未知能力使用服务默认，不通过模型回复或是否出现思考文字推断支持情况。原有全局偏好保持可读，不迁移、删除或覆盖。

用户界面的思考卡片只呈现真实可选档位；仅有开关的显示无／开启，只有一个档位时不提供展开箭头。模型切换菜单与当前模型入口复用同一展示组件。保存沿用现有 provider config API 和原子 store 更新；只有明确的思考偏好更新可在运行中保存，当前已准备轮次和已有子 Agent 保留原生配置快照，后续准备轮次使用新偏好。适配层继续将档位交给 DSH 序列化和流解析，不改执行循环、权限或完成语义。

旧原生子会话的冷恢复保留升级前的思考 profile 候选，只在原生记录的完整连接身份精确匹配时使用；不据此切换已有子 Agent 的模型或强度。2026-10-22 已批准补充：若创建时采用默认上下文容量，冷恢复可消费 DSH 原生 `requestContext()` 与子 Agent 固定思考档位，重建该已知 fallback 候选；仍须完整路由精确匹配，当前明确容量较小时拒绝，不持久化第二份恢复状态、不改写原生记录或全局能力。此兼容路径仅用于已有记录，待旧 profile 的子会话全部不再需要恢复后可移除。聊天模型入口直接列出已配置模型，点击后沿用现有会话切换事务；失败保留原选择。Agent 模板模型仍在设置页配置，聊天切换不再写入模板或全部 Agent 默认值。

## 2026-10-18 已批准：默认子 Agent 模板与聊天内职责复用

2026-10-23 已批准补充：通用职责不再提供单独模型设置，新建通用子 Agent 继承主 Agent；旧 `models.generic` 保持可读但不用于新建，保存时归一为空。自定义模板的显式模型、已有子 Agent 的原生记录及冷恢复不受影响。`config.subagentLimits` 只保存用户选择的最大深度和并行数量，缺省仍为 1 和 3；下一轮会话准备将配置交给 DSH 原生 volatile 配置，深度检查、活跃后代计数、拒绝、停止与恢复仍由 DSH 负责，不增加第二套调度或授权。降低上限不取消现有子 Agent。

2026-10-22 已批准补充：`config.subagentTemplates.custom` 保存自定义模板的稳定标识、名称、适用场景、职责说明、可选模型和工具档位；旧的 `version: 1` 模型设置保持可读，不迁移执行记录。简化后的界面只编辑名称、模型和提示词，模型默认继承，适用场景摘要随提示词更新。配置兼容继承、仅阅读与检索、不使用工具三档，界面编辑会保留已有工具限制；后两档复用默认 explorer 的原生允许列表或空允许列表，不代表授权。工具发现沿用现有只读接线，仅返回原生限制后的子级目录；无工具档位也不安装工具发现。

子级装配时通过原生 sessionQuery 与 foldSubagentDescriptor 读取 DSH 已持久化的 toolFilter。宿主工具和会话本地 stdio MCP 在重新注册及目录刷新前消费同一限制，避免作用域内重新注册绕过原生继承过滤。共享远端 MCP 仍由原生作用域过滤，不改写共享目录。此消费规则不增加批准、执行或恢复状态，也不改变普通主聊天的工具配置。

主 Agent 根据模板目录选择通用 `subagent` 工具的精确 `template` 标识，不能同时用 `role` 覆盖该职责。模板职责经公开 persona 参数交给 DSH，本次任务单独经 prompt 传入；模型和工具允许列表仍经公开 agentOptions、toolFilter 传入。DSH 原生描述符持有创建时的实际配置，编辑或删除模板不改变已有实例和冷恢复记录。模板不得存储权限预设、批准结果、子会话标识、历史或凭据；原生停止、恢复、非交互审批和父级限制优先，不修改 alpha2 核心。

全局 `config.subagentTemplates` 仅保存 explorer、browser 和通用职责的默认模型选择（未指定则由 DSH 在创建时继承父 Agent 的实际模型）。设置入口经已有 ACP config API 校验并保存，不存储子会话 id、历史或凭据，也不恢复旧五角色路由。explorer/browser 是两个按需实例化的默认模板，不预启动、不占用并发名额；其他职责经通用 `subagent.role` 声明，仅在当前主聊天中创建和继续。

CodeBuddy 适配层把模板、职责、已配置模型转换成 DSH 公开 `SubagentService.startActivation` 的 persona、toolFilter 与 agentOptions；默认 explorer 收窄原生文件/命令工具，browser 使用当前已启用的浏览器/网页能力。宿主现有权限检查和能力停用边界保持优先。原生描述符持有实际 persona、模型、直系归属和历史，后续使用原生 send_message 继续，冷恢复不重新按新设置改写旧实例。主模型负责按语义选择职责与是否复用；不通过名称、关键词或月份作第二次宿主业务裁决。

相同模板在不同主聊天中创建独立原生子会话，配置可共用，聊天历史不共享。浏览器 cookie、标签页与账号资源的隔离不由聊天上下文隔离推导。活跃轮次沿用本轮已准备的模型配置，下一轮准备后用于新建实例；已有实例不热切换。冷恢复只重建与原生描述符路由完全匹配的现有连接，无法匹配时明确拒绝，不偷换模型或实例。连接删除时提示修正该新建请求，不替换成另一模型。并发上限仍由 DSH Host 持有，不是每轮创建配额。

## 2026-10-17 已批准：会话内单工具授权

2026-10-22 已批准补充：宿主内置生图工具接入同一 Compat 会话授权缓存和 ACP 选项。授权绑定原生根 Agent、可信生图实现、工作区、任务记录目录、所属聊天和规范化服务地址；同配置的逐轮重装配可复用，替换服务、移除工具、重启或替换实现后失效。子级只能消费匹配上述范围的已有根授权，不能改变原生非交互审批规则。查询或取消旧任务时，原始任务回执中的服务地址必须匹配当前授权服务，否则仍需单次审批。工具实例与实际注册定义由宿主代码核对，不采信模型参数或同名工具声明。仅此次允许、停止、明确禁用和安全检查继续走原有审批链路，不新增全局权限、授权持久化或 DSH 执行状态。

生图授权不绑定单次参数；在上述范围内更换提示词、尺寸、种子和任务编号，或从生成转为查询、取消本会话任务，均可复用已明确授予的会话权限。conversation driver 仅提供调用上下文的产品 ID 投影，Harness 宿主适配层在实际调用时应用，保留原始工具定义身份；子 Agent ID 不改写。此接线不改变原生命令的沙箱或审批边界。

2026-10-18 已批准补充：当前嵌入 profile 的 `load_workspace_dependencies` 仅配置 source，不配置安装目标 root；原生工具只验证现有载荷并返回路径。适配层将实际已注册定义纳入只读能力，同名覆盖不继承，不授予依赖下载、安装或复制权限。

原生 `web_fetch` 的会话授权复用下述 Compat 内存缓存与 ACP 选项，不新增审批 owner 或持久化协议。授权按原生根 Agent 身份、实际工具定义、Web 服务身份与规范化 origin（协议、主机、端口）绑定；不同路径与查询可复用，同名替换、不同根身份和重启不继承。审批正文明确展示目标站点与匿名读取范围。子 Agent 只能消费已有根授权，不能自行弹审批。DSH 原生匿名 GET、URL/DNS、公网地址、重定向、超时和大小限制仍负责实际网络执行；会话允许不绕过这些检查。未改变 PowerShell 审批，也未挂载实验性 Auto 或另建隔离执行器。

模型思考仍由已有模型 profile 与 Harness/pi-ai 适配器负责序列化和流解析。已声明思考档位且未显式选择时，默认选择 medium（无 medium 时选择已声明的可用开启档位）；显式关闭优先。未知模型不凭历史保留或默认偏好推断能力，不统一强塞请求参数。Gemma 4 的界面能力与执行配置消费同一已存在的 chat-template profile；使用 `enable_thinking`，不伪造思考文字，也不把思考搬成正文。

界面三态统一为“请求批准／智能批准／完全访问”，模式 id 与原检查语义不变。重复查询采用会话内单工具明确授权，不按用户或模型自由文本判定“同类任务”。参考 Codex 对命令、文件、网络和 MCP 分别限定授权对象的公开设计；本次只处理外部 MCP 单工具：Codex MCP Auto 模式按服务器／连接器／工具记忆，Prompt／Writes 模式则把会话批准降为单次。本产品允许在请求批准模式显式选择本会话单工具授权，并且对明确破坏性工具更保守，不声称三态与 Codex 预设完全相同；当前安装的 DSH `dsh-user-approval` 仅有单次 `allowed-once`，不含记住规则，因此不另挂原生审批服务。

`Compat.approveTool` 仍为唯一人工批准 owner。MCP 桥绑定实际在线定义、连接代次及原生根 Agent 的不透明身份，显式破坏性工具不提供会话放行；其他 MCP 工具必须先由用户选择“本会话允许此工具”，远端只读注解本身不授予权限。现有 ACP `allow_always` 选项使用已有 `authorizationScope: session` 元数据准确呈现本次会话范围，不再从聊天审批写入全局工具规则。原全局配置保留且不迁移。原生命令、文件和无可信绑定的工具仍走已有单次批准边界。

临时授权由 Compat 在内存持有，跨轮有效并按同一根身份供原生子 Agent 消费；不持久化、不跨会话／根重绑，应用重启、设置重新配置或工具连接／定义替换后失效。同工具并发请求先等待已有选择：会话批准可覆盖后续调用，单次批准仍只覆盖原请求。每次继续及迟到回答均重新检查当前策略、能力启用、取消与实际绑定；明确禁止、只聊天、安全升级和工具停用优先。已存在的权限 RPC、原生拒绝与回执持有执行事实，不新增审批服务或以模型解释作为授权。

## 2026-10-17 已批准：子 Agent 非交互委派与回执分离

本节补充下方三态权限章节：子 Agent 的权限判定仍归根会话的现有 `Compat.approveTool`，每次工具检查读取当前授权；不会把手动自动提升为智能，也不创建独立子 Agent 权限设置。执行中的模式变更继续在下一次权限检查生效。DSH 的实际在线归属链识别子调用（不比较可能已 fork 的产品会话 id，也不信任模型参数）。权限足够则执行；不足时通过 DSH 原生 `tools/pre-execute` 的 deny 和工具错误回执结束该操作，不向用户打开子会话审批 RPC。子 Agent 可继续权限内工作，由原生委派结果／父子通信把限制交回主 Agent；父 Agent 无权自行放宽用户授权。

原生会话日志持有完整工具与拒绝回执，现有子会话详情继续读取它们；适配层不复制日志、不另建审批队列或完成状态。按原生／宿主实际工具定义标记的委派、父子通信、状态查询和工具 schema 发现回执不投影为主聊天工具消息或活动行；普通同名替代工具不继承此标记。审计事件保留可选内部展示标记，结果沿用对应调用的标记，审计事实与回执不删除。子 Agent 自身的文字和工具仍按原生会话身份分流，主 Agent 的用户可见进展、结论、必要的失败与权限说明保留。历史保存记录不重写，恢复后新产生的回执遵守同一规则。

采用 DSH 的非交互拒绝、原生持久化、原生跨轮继续及结果递交机制；不照搬其创建时固定的独立权限快照，以保留已批准的根会话实时三态切换。未挂载第二套 permission presets／审批服务，也未改变 Windows 命令沙箱、ACL 或既有明确禁止规则。

## 2026-10-17 已批准：会话审批模式与工具检查边界

现有 runtime store 继续持有会话 `mode` 和显式工具权限，ACP `session/set_mode` 写入并发布 `current_mode_update`；UI 只消费确认后的选择。`Compat.approveTool` 在每次工具权限检查、异步安全检查后及人工审批返回后读取当前事实；原生子 Agent 通过原父会话审批回调消费同一选择。切换不回滚已运行动作，不自动回答待处理审批；明确禁用、只聊天和工具停用不得被旧审批绕过。旧会话字段、全局默认和协议不迁移，不新增持久化状态。

只读能力由适配层对锁定版原生工具的已审查定义绑定，以及宿主注册工具的明确只读/非破坏性声明提供。按实际执行的工具定义匹配，同名替换不继承；远端 MCP 注解、模型参数、工具名称或命令文字本身不授予权限。手动和智能均自动放行已核实只读且未触发安全升级的调用；手动对其余动作逐项批准，保留明确长期授权。

智能进一步复用已挂载的原生 `fs-sandbox`：仅已确认可写项目、实际原生 write/edit 定义、当前原生 workspace-write 策略且未申请提权的调用可自动进入文件执行。实际路径、规范化、项目/临时目录可写集合及越界拒绝仍由原生文件系统持有，宿主不另造路径白名单。Shell 未受沙箱约束，命令、Git 写入、MCP 和未知动作仍请求批准。完全访问保留显式拒绝、能力可用性与既有安全升级；Harness 仍负责实际工具执行和取消。原 `smart_approve` 标识保留，界面同步说明项目文件自动批准语义；本功能分支尚未发布，不迁移旧权限字段，不启用实验性逐调用模型审查。

原生委派、直系父子消息和中断属于受原生所有权约束的内部控制，适配层按实际已注册定义识别，在手动/智能档免重复确认；明确禁止、工具停用、只聊天仍优先。`SubagentService` 校验实际 sender、直系归属和生命周期，子 Agent 每次文件/命令调用仍单独检查当前父会话权限。原先前端按原生工具名自动批准委派的规则移至后端；前端收到请求必须等待明确答复，不再自行放行。此变更不授予跨会话通信或更宽目录权限。

本批参考原生审批的单次请求和调用边界设计，不挂载 `permission-presets` 或 Windows ACL 沙箱；不宣称现有模式等同于原生沙箱预设。验证结果单独记录，不由本表宣布产品通过。

## 2026-10-19 桌面宠物展示消费者

本批补充（用户已要求）：侧栏完成绿色未读点与宠物完成勾选共同消费 Electron 提醒快照，由真实可见且聚焦的会话确认已读，不维护两份完成未读裁决。宠物暂停按钮委托现有会话 controller.stop，继续跟进打开对应会话；不引入第二套暂停或恢复状态。官方 Harness `userQuestions` 与 `ask_user_question` 通过 ACP `elicitation/create` 接到现有表单，待回答事实仍来自实际输入请求，宠物仅展示摘要。媒体工具沿用 ComfyUI 服务端队列和历史回执，图像与视频使用独立任务收据目录，不改变 Harness 完成语义。

2026-10-22 提问卡片补充（用户已批准接入原生 timed，并限定补答窗口）：保持 alpha2，`tool-ask-user` 使用官方 timed 模式与默认 120 秒等待；模型根据缺失决定对目标、范围和结果的影响选择等待，关键问题用 `timeout: -1`，次要偏好未答或跳过可说明假设后继续。DSH `userQuestions` 拥有等待计时、pending、空答案与补答准入，桌面只显示原生剩余时长，不另设原生问题超时。超时仍为待回答，不是跳过或授权。适配层只允许当前仍运行的原生轮次中的问题补答，以原生 turn/start、turn/end、工具调用标识及当前取消信号限定；轮次结束、主动停止、断连或进程重启后旧卡片不可触发新轮次，原生历史不删除、不伪造答案。补答经 `userQuestions.answer` 进入原生 inbox，同一问题重复排队由 DSH 拒绝；跨聊天或 native fork 身份变化时拒绝旧卡片，迟到提交在实际准入前重新核对轮次。单选、多选、自填与跳过仍映射到官方答案形态。恢复继续使用原生执行路径，旧卡片不重新授权。

人工授权 `session/request_permission` 没有倒计时，持续等待明确允许或拒绝；主动停止、连接关闭、工具结束仍撤销实际请求，之后的旧回复无效。不改变会话授权范围或缓存失效规则，不把提问跳过、超时和静默当作许可。通用扩展表单保持原有行为，网络请求及实际工具执行的超时不变。

繁體：側欄未讀點與寵物勾選共用提醒快照；暫停委託現有 controller，提問由官方 Harness 經 ACP 表單傳遞。English: sidebar unread dots and pet checks share the notification snapshot; pause delegates to the existing controller, and official Harness questions use the existing ACP form channel.

桌面宠物复用现有 ACP 会话快照、输入请求、错误及 `turnTerminal` 结构化记录，仅选择展示动作和提醒优先级，不解析对话文字、改变任务终态或驱动 Agent。Harness 的执行、审批与完成所有权保持。Electron `petMain` 持有宠物选择、显示、尺寸、位置、素材校验缓存及本次运行的提醒已读状态；提醒已读不修改会话。悬浮窗口属于辅助窗口，不成为会话事件的宿主。

自定义创建通过现有 CodeBuddy Agent 会话提出请求，图像工具的可用性与权限仍由该会话决定；文件生成后由本地素材加载器验证，最后发布有效素材。静态内置素材及 Codex 的制作工具不授予产品图像生成能力。用户确认小熊猫为默认，奶油猫和白狐作为其他内置选择。详见[宠物说明](../../docs/desktop-pets.zh-CN.md)。

繁體：寵物僅消費 ACP 結構化狀態；Harness 保留執行與完成權威。Electron 持有顯示偏好、素材驗證及提醒已讀，不改寫聊天。建立寵物沿用實際 Agent 與既有工具權限。

English: pets only consume structured ACP state. Harness retains execution and completion authority. Electron owns display preferences, validated art and local notice acknowledgements, without rewriting sessions. Pet creation uses the real Agent chat and its existing tool permissions.

## 2026-10-16 Mac 独立工具接入（实现待统一测试）

用户明确要求补齐 Mac 电脑控制和独立 MCP，并在开发完成后统一测试。平台适配复用 Go/Swift `qwen_computer` 与 Rust `codebuddy-tools`，不恢复旧 Agent/CLI。Mac `computercontroller` 与 Windows 一样只公开 PDF、网页文件、缓存；桌面操作唯一入口是现有九工具合同，权限仍由 Harness 回调与 macOS 屏幕录制/辅助功能实际授权共同约束。

工具原生构建、来源和载荷身份由打包脚本持有；`runtime/builtin-artifacts.mjs` 只解析固定文件名的包内清单，运行时校验二进制大小/哈希/普通文件与执行权限。电脑控制前端和同目录 Swift helper 一起校验；配置、环境变量及外部同名 MCP 不取得内置信任。签名回调在所有内部代码签名后、外层应用封装前写入最终工具哈希，保留签名前来源；不在已签名应用启动时修改资源。Windows 原固定身份和配置键保留。清单有效只表示产物可用，不代表 MCP 发现、TCC 授权或桌面 E2E 通过。

繁體：Mac 共用既有 Go/Swift 電腦控制及 Rust 工具，Harness 持有執行與核准，系統持有 TCC 授權。封裝持有固定工具檔案身份，內部簽名後、外層封裝前更新雜湊；啟動不修改已簽名資源。文檔工具不另公開桌面動作，實機驗收尚未執行。

English: Mac reuses existing Go/Swift computer control and Rust tools. Harness owns execution/approval; macOS owns TCC grants. Packaging owns fixed artifact identities and refreshes hashes after child signing but before the outer seal. Startup never rewrites signed resources. Document tools expose no second desktop route. Artifact validation is distinct from discovery, permissions and desktop acceptance; tests remain deferred.

## 2026-10-16 同事分支合并：原生子 Agent 与只读投影

本次按用户要求合并 `codex/dsh-frontend-ux`。当前会话选择的模型和思考强度是实际请求来源；原生子 Agent 继承父 Agent 的实际模型与强度，旧角色路由配置保留可读但不再覆盖执行选择。Host 的子 Agent 插件限制为同时 3 个、深度 1；旧配置中的角色并发值不修改原生 Host。此条覆盖下方历史角色路由执行约定，不删除保存的配置或历史。

子 Agent 状态、目录和对话由原生记录持有；适配层验证归属路径并投影只读视图。文件变更面板仅展示已保存的工具回执，不宣称覆盖 shell/MCP/子 Agent 的全部修改。取消完成与请求释放分开处理，队列只在已有请求释放后继续；不从显示文案判定完成。工具权限先绑定远端组合再施加筛选，工具 schema 仍按需发现，保留本地主分支的 MCP 复用与异步任务适配。

繁體：子 Agent 繼承父模型與強度，原生 Host 限制為 3 個並行、深度 1；舊路由仍可讀但不介入執行。目錄、對話及變更僅投影已保存事實，取消後須等請求釋放，權限與按需工具發現保持。

English: native children inherit the parent's actual model and effort; the Host admits three concurrent children at depth one. Saved legacy role routes remain readable but do not override execution. Catalogs, transcripts and change views project durable facts. Queues wait for request release after cancellation; permission filtering and deferred tool discovery remain intact.

## 2026-10-16 修复：GitHub 账户设置沿用官方 CLI

GitHub 账户授权、登录和凭据继续由现有 GitHub CLI 负责，Electron IPC 仅提供受限状态/设备流程/登出适配；移除旧 Rust OAuth 卡片调用，不恢复旧核心。`gh auth status` 的结构化验证结果是账户事实来源，MCP 独立连接配置不由账户卡片自动修改。Harness Agent 的执行、审批、完成所有权不变。见修复验收（历史文件，见 Git 历史：`docs/reconstruction/2026-10-16-github-account-fix.zh-CN.md`）。

繁體：帳戶由官方 CLI 驗證和管理，MCP 連線獨立，移除舊 OAuth 呼叫。English: the existing official CLI owns account authentication; MCP configuration remains independent and retired OAuth UI calls are removed.

## 2026-10-16 已批准：移除旧 Office 编辑工具并合并工具箱入口

用户批准将旧 DOCX/XLSX 能力迁移到现有 Harness `dsh-skill-office`、`dsh-tool-workspace-dependencies` 和原生 shell。Rust 的 `docx_tool`、`xlsx_tool` 注册、实现及专属依赖删除，不新增同名 Python 编辑服务。工具箱按注册技能身份将 Word、Excel、PowerPoint 归入 Office 文档组，技能详情及覆盖顺序仍由原注册表决定。`computercontroller` 的配置键保持，以兼容现有启用状态及保留的 PDF、网页保存、缓存；不迁移权限、不改写旧对话工具回执、不重放历史动作。已完成的历史可查看，恢复后的调用使用当前工具清单；硬编码旧工具名称的外部配方需按迁移文档修改。

公网文本读取优先复用上游 `web_fetch`；锁定版本不提供等价的二进制保存和私网抓取，旧 `web_scrape` 暂保留这些独有用途。外部 MCP 配置与凭据保留，安全 MCP 本批按用户要求不测试。迁移边界与同事合并步骤见 Office 工具合并记录（历史文件，见 Git 历史：`docs/reconstruction/2026-10-16-office-consolidation.zh-CN.md`）。

繁體：舊 DOCX/XLSX 實作移除，Office 由 Harness 技能與原生 shell 執行；保留 PDF、網頁檔案、快取及原配置鍵。歷史不重播，權限不擴張。English: Harness Office skills and native shell replace the retired Rust DOCX/XLSX tools. PDF, web-file saving, cache and the existing configuration key remain. Historical actions are not replayed and permissions are not broadened.

## 2026-10-16 已批准：复用官方 Office 技能与公网网页工具

Harness 的 `dsh-skill-office` / `dsh-skill` 负责内置 Office 技能注册、加载及同名覆盖顺序；`dsh-tool-workspace-dependencies` 提供官方锁定的独立 Python 载荷位置。CodeBuddy 只准备、打包载荷并将注册表投影到现有工具箱只读条目，不维护第二套 Office 编辑引擎。公网正文抓取由 `dsh-tool-web` / `dsh-web-fetch-http` 执行，保留官方地址、内容类型和返回长度限制；工具发现仍按需加载，权限走现有 Harness 回调。原 Rust 文档、PDF、缓存、图表及天气工具保留，尚未验证的替代能力不提前删除。

繁體：Office 技能與 Python 載荷查詢、公網抓取均復用 Harness；CodeBuddy 僅準備載荷與投影工具箱。舊獨立工具保留，不新增第二套編輯或抓取引擎。

English: Harness owns Office skill resolution, bundled Python discovery and public web fetch. CodeBuddy prepares the pinned payload and projects read-only toolbox entries. Existing standalone tools remain until their replacement capabilities are verified; no duplicate Office or web engine is introduced.

## 2026-10-16 已批准：MCP 异步探测与 300 秒默认超时

扩展配置继续由 runtime settings 持有；`mcp-settings.mjs` 统一秒到毫秒的转换。`mcp-bridge.mjs` 在连接／发现时读取服务端能力与工具声明，`mcp-tasks.mjs` 仅适配已协商的 Tasks 提交、轮询及取消，将最终 MCP 回执交给 Harness。远端服务拥有任务状态与执行结果，Harness 仍拥有审批、工具执行及 Agent 生命周期；不新增 Agent 调度器或任务持久化副本。同步及单次协议请求默认 300 秒，明确配置优先；异步轮询不因累计达到 300 秒结束。任务句柄不等于完成，取消请求不等于停止，失败或断线不重放原调用。当前 Tasks 交互输入、跨进程自动恢复未实现。

繁體：設定歸 runtime settings，遠端任務狀態歸 MCP 服務；適配層探測能力並輪詢，最終回執交給 Harness。預設單次請求 300 秒，明確設定優先；不新增 Agent 排程或持久化副本，不重送已受理動作。

English: runtime settings owns configuration and the MCP server owns task state/results. The adapter detects capabilities and polls; Harness retains approval and execution authority. Requests default to 300 seconds with explicit overrides. No duplicate Agent scheduler, task store or replay of accepted actions is introduced.

## 2026-10-16 已批准：移除旧 Rust Agent 源码

用户明确要求清理剩余旧核心并保留工具与前端功能。旧 Agent、CLI、Provider 和其专用 SDK/推理 crate 已移除，Cargo 只保留独立 MCP 工具。前端兼容协议 schema 从旧 crate 原样迁至 `ui/sdk/schema`；名称与通知格式不变，继续由 Harness 适配实现。后续历史章节中的旧路径不是新实现入口。执行、调度、完成、上下文与压缩的事实 owner 仍为官方 Harness，不新增 CodeBuddy 裁决循环。

繁體：舊核心原始碼移除，協議原樣保留於 SDK，工具獨立保留，Harness 權威不變。English: retired Rust Agent sources are removed; compatibility schemas and independent tools remain, with Harness retaining execution and compaction authority.

## 2026-10-14 已批准：新版 Harness 执行与目标权威

2026-10-28 异步工具显示核对：现有临时 `execution_activity` 可携带 `active_tool_call_ids`，由适配器投影本轮原生工具调用/结果及下一模型流的批次边界。Harness 在进入下一模型流前等待当前工具批次结束；桌面只核对同一 run、同一用户输入的运行标记，保留并行及直接工具调用。缺失回执的结果仍为未知，不补造成功或失败，不修改持久会话。媒体观察超过时限或断联时仅将显示降为“状态待确认”，保留远端任务和查询；不据此取消、重复提交或改变已确认终态。

繁體：工具活動核對僅清除失效顯示，缺失回執保持未知；媒體觀察失效不改變遠端任務。 English: ephemeral native activity reconciles display occupancy only; missing receipts remain unknown, and stale media observations do not cancel or resubmit remote work.

2026-10-20 用户明确要求通过输入框 `/` 菜单提供长期目标、暂停/继续和计划入口，取代常驻目标表单：桌面通过结构化 `codebuddy/goal` prompt 元数据和原生目标读/暂停适配接入 GoalService。Harness 仍是目标日志、revision、轮次、激活及完成的唯一 owner；UI 只读取投影、提交用户操作并展示实际回执。创建/继续绑定普通 prompt 的批准和取消通道；暂停先提交原生 CAS，再取消当前执行。新任务批准选择先完成现有 ACP set_mode，再发送首条消息，不修改全局默认。计划使用锁定上游 `PlanModeController` 的日志与投影，`codebuddy/plan` 仅传递显式选择；不改变批准模式，不新增调度器。没有目标或计划元数据的旧会话保持原行为。三语说明见 `docs/long-term-goals.*.md`。

繁體：斜線命令沿用原生目標與計畫狀態，長期目標 UI 沿用 Harness 唯一狀態與續輪權威，結構化控制綁定原有核准、取消及 revision 檢查。English: Slash commands consume native Harness goal and plan state; structured controls retain existing approval, cancellation, and revision checks without adding a second scheduler.

压缩中进程退出后，只有不存在活跃操作的历史加载才核对原生 `compaction/end`：有结束记录就恢复其结果，没有则仅将显示投影置为“中断、结果未确认”，不写入 Harness 完成事实、不改原始日志，也不重放摘要请求。繁體：重啟僅核對原生結束記錄，缺失時清除失效進度但不宣告完成。 English: idle replay reconciles missing notifications with durable Harness end events; absent evidence clears a dead spinner as interrupted/unconfirmed, without changing native history or replaying work.

本日夜间补充：上下文计量、压缩范围、摘要事务与重试归官方 `tokenMeter` / `compaction-basic`；`runtime/context-updates.mjs` 只转换现有 UI 通知，当前占用不得与累计账单混同。压缩不等于长期记忆，摘要不证明需求无损；多次压缩后的独立验收另留证。MCP 截图按实际执行 Agent 的图像能力原生准入，缺能力时复用 `VisionRouting` 的零工具辅助观察；原始工具回执归 MCP，视觉失败不得重放已执行动作。

锁定版本的已知压缩缺陷适配：`runtime/harness/compaction.mjs` 继承官方引擎，在普通压力路径略过已选中的单个 `compact-checkpoint`，避免无新增事实时反复摘要。2026-10-28 真实宠物历史回归另确认：原生选区可吞掉最新人工输入，摘要遗漏限制后回到旧任务。锁版 `sdk-budget/compaction-patch.mjs` 在共享选区函数内保留最新 `source.kind=user` 原事件，不把后续 runtime-context／skill-catalog 当成人工输入；遵守原有 tail 预算，只在其两侧选择工具配对完整的连续区间，优先非单检查点区间中的估价较大者。只有旧检查点可选时保留超限恢复与手动压缩能力，普通压力路径仍略过它。压力、超限／本地预算恢复和手动压缩共用人工输入保留边界；长 turn 后续工具历史仍可压缩，不复制、重排或补造人工消息。选区估价不替代 adapter 的真实 fit 门槛，后半区摘要可能损失前缀缓存；摘要事务、取消与 Session 格式仍归官方引擎。升级官方依赖时复查并在等价上游修复后撤除相应补丁。早期回归与实际证据见夜间跟踪（历史文件，见 Git 历史：`docs/reconstruction/overnight-acceptance.zh-CN.md`）。

2026-10-28 用户批准锁定 SDK 的请求预算与恢复合同修复：`runtime/harness/sdk-budget-contract.mjs` 在内存中对精确版本及 SHA 校验后的原生模块实施兼容变换。Pi adapter 持有同一请求的最终规范化投影、拟发送预算（fit）与派发；LLM 服务只以既有 `requestId` 关联一次性的进程内 fit 和原请求重测闭包。`tokenMeter` 的服务用量锚及压力估计保持原职责，不强行与最终投影估价写成同一数字，也不重写历史 usage。`LOCAL_OUTPUT_BUDGET_EXHAUSTED` 在 HTTP 前拒绝没有输出空间的请求；`OUTPUT_TRUNCATED` 表示原始 length 的实际输出小于本请求 clamp 前所需上限，不冒称服务端上下文溢出。`compaction-basic` 消费该 fit，沿原安全选区与摘要事务每轮最多尝试恢复一次，只有真实 surface 替换且同路由预算改善后才返回原生 retry；取消、无进展、摘要失败或第二次截断保留明确失败。通用网络重试不接管这两个错误。没有新宿主循环、持久事件、Session v4 版本或工具重放；升级及撤除边界见 `runtime/harness/PROVENANCE.json`。

繁體：最終請求 fit 歸 adapter，暫存關聯歸 LLM 服務，單輪有界壓縮恢復仍歸原生引擎；歷史用量與 Session 格式不變。English: The adapter owns final request fit; the LLM service carries a transient association; native compaction owns the single recovery attempt. Historical usage and Session format are unchanged.

输出用量证据同样由 adapter 在 Pi 公开的结构化 provider-stream 回调处读取：明确报告的输出计数（包含 0）才可参与 length 恢复与依赖零输出的 length 溢出判定；缺字段时保持未知，不用规范化后的默认 0 替代真实回执，不从正文猜 token 数。未知用量的 length 保留原 `max-tokens` 终态；显式服务错误仍由原分类处理。此观察不改变 usage、原始停止原因或持久化字段。

协议的最小输出也属于 adapter fit：Responses 启用 `max_output_tokens` 时最小值为 16，用户显式上限小于该值以 `INVALID_OUTPUT_BUDGET` 在 HTTP 前拒绝，不抬高用户上限，不摘要或网络重试；可用上下文小于最小输出则走有界的本地预算恢复。恢复重测须满足同一最小值，且可用空间和有效输出均达到它。显式 `supportsMaxOutputTokens=false` 继续表示该连接不发送上限，不把它冒称成服务端强制预算。[官方 Responses 参数约束](https://developers.openai.com/api/reference/ruby/resources/responses/methods/create)。

2026-10-28 真实回归补充：摘要自身也必须消费 adapter 最终 fit，完整摘要输出空间不足时由 LLM 服务在 HTTP 前以 `COMPACTION_OUTPUT_BUDGET_EXHAUSTED` 拒绝。原生压缩事务持有缩区：按工具配对边界有限地几何缩短选区，同步重建摘要输入、计量及 shadow 集合，未摘要的尾段仍为原 active surface 事件；不以“只裁输入、仍替换整段”丢弃事实。本地准备不增加摘要 HTTP 重试，最终候选复用已绑定连接快照及配置，只发一次摘要；实际 length、取消或未找到可用选区不提交检查点。候选搜索不是最长或穷尽保证，普通压力的旧单检查点保护覆盖缩区后的实际输入。没有新宿主循环、持久字段或 Session 迁移。

同日工具状态展示补充：原生附件存储仍持有图片对象的读取与校验，driver 只将已验证图片转换为 ACP 展示块，compat 消费真实工具终态。可选预览读取失败只降级图片展示，不丢弃完成通知或更改工具事实。旧记录只修复回放投影，不改写持久回执或重放工具。图片 I/O 后统一重新读取当前历史与实时高水位，再同步重置并发布回放，避免旧图读取期间的新消息丢失。

**繁體補充**：上下文計量及壓縮由 Harness 持有，CodeBuddy 只投影現有通知。摘要不是無損記憶；反覆壓縮另驗。MCP 圖片優先交實際執行模型，缺能力時輔助視覺只觀察，保留原始回執且不重放動作。

**English addition:** Harness owns context metering and compaction transactions; CodeBuddy only projects existing notifications. Summaries are not lossless memory, so repeated compaction requires independent acceptance. MCP images use the executing model's native capability first, then a tool-free visual observer when configured. Original receipts remain authoritative; observation failures never replay actions.

**繁體補丁界線**：薄子類只延後普通壓力下的單一既有 checkpoint；不另選範圍，不攔截手動或超限恢復，官方修復後撤除。 **English patch boundary:** the thin subclass defers only an upstream-selected singleton checkpoint under normal pressure. Manual and overflow recovery remain unchanged; remove this guard after an upstream fix.

本日追加的远程 MCP 复用授权：长期组合、作用域租约、修订保留和回收由官方 `agent-preset-registry` / `dsh-scope` 持有；CodeBuddy 仅按完整配置选择组合、投影状态和维持每会话权限/Apps 适配。stdio 保留工作目录与会话边界。详见复用验收（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-mcp-reuse.zh-CN.md`）。

**繁體補充**：遠端 MCP 長期組合、作用域租約及修訂回收由 Harness 持有；CodeBuddy 選擇設定組合並維持每會話權限與 Apps 適配。stdio 保留工作目錄與會話邊界。

**English addition:** Harness owns standing remote MCP compositions, scope leases and revision retention/collection. CodeBuddy selects the configuration and retains per-session permissions and Apps adaptation. Stdio retains its workspace/session boundary.

适用范围仅为 `D:\CodeBuddy-v1` 新版运行时。用户基于普通问候正常结束却被新版门禁标为中断的真实会话，批准将执行、调度及完成生命周期交官方 Harness，CodeBuddy 保留必要适配，并允许前端为原生后端调整。此修订覆盖本目录旧表中关于新版自造计划/调度/完成门禁的职责，不改写原 Rust 产品或旧历史事实。

官方 Session Controller / AgentLoop / subagent 负责执行；goal/tool-goal/goal-round-driver 负责目标、自动续轮、CAS 与进程内激活；todo/write 仅为当前轮清单，turn/start 清空。CodeBuddy 的 codepro 只投影原生状态、实际工具回执及 UI 控制引用，不再注入 codebuddy_task，也不要求模型提交第二套计划或证据 ID。harness_turn 仅表示一轮结束；harness_goal 仅表示原生目标已完成；两者都不等于独立测试通过。原工具效果、未知副作用及旧事件前缀保留，恢复不自动重放。

**繁體修訂摘要**：此修訂僅適用新版執行時。官方 Harness 擁有執行、排程、目標與續輪；CodeBuddy 只做投影及必要權限/設定適配。原生完成不替代真實測試證據，舊歷史及未知效果保留。

**English revision summary:** This revision applies only to the new Harness runtime. Official Harness owns execution, scheduling, goals and continuation; CodeBuddy adapts presentation, permissions and settings. Native completion is distinct from independently verified tests. Historical events and uncertain effects remain intact.

实施、替代方案、锁定版本/许可证与验证边界：简体中文（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-harness-authority.zh-CN.md`） · 繁體中文（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-harness-authority.zh-TW.md`） · English（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-harness-authority.en.md`）。当前仅自动夹具已验，最终产品证据单独记录，不由权威地图宣布产品通过。

## 2026-10-12 已批准：常用只读查询与每轮时间

新版接线：runtime store 仍持有查询设置；独立 commonqueries MCP 每次消费宿主生成的请求元数据，不持有第二份设置。Harness 主导调用、审批及完成，原 Rust 查询实现只提供结构化工具回执。繁體：設定由 runtime store 持有，每次經宿主 MCP 中繼資料傳入，無設定副本。 English: the runtime store owns query settings; host MCP metadata carries them per call, with no mirrored state. 详见接线边界与验收（历史文件，见 Git 历史：`docs/reconstruction/2026-10-15-common-queries.zh-CN.md`）。

用户批准 COMMON_QUERY_TOOLS_PLAN 三语方案的开发与测试。现有平台工具注册与执行边界负责 `time_now`、`location_resolve`、`weather_get` 的结构化回执；时钟来源是执行主机，指定时区只影响展示，不作为实际地点证据。城市由用户参数或设置中的默认查询城市提供，地理编码返回候选，模型负责追问歧义。天气与数据时间来自供应商；宿主标记缓存、过期、限流及缺值，查询时间不提升为观测时间。

沿现有配置 owner 保存常用查询设置，工具每次调用读取；联网关闭在命中缓存之前检查。普通聊天沿原意图分类及执行器，只开放本轮已启用的常用查询工具；明确禁止工具时保留空工具面，原权限拒绝优先。时间上下文由现有 MOIM 请求投影刷新，不写入历史或恢复摘要；保留缓存检测需要的结构。无新增任务终态、完成裁决者或回执库。实施及平台验收结果见三语实施记录。

## 2026-10-05 已批准：Mac worker 强制停止的既有 owner 接线

用户在 MACOS_PARITY 三语方案与批准问题后回复“继续”。`SystemProcessGroupOwner` 仍是 OS 进程组操作和退出观测的唯一 owner；`WorkerRegistry` 在 worker generation 内保留 PID 与 `SessionProcessOwner` 的同一引用，scheduler tracker 负责注册／消费，lifecycle 负责停止流程。强制清理取快照和关闭注册原子完成；终止与退出确认在锁外；未确认对象保留以供重试，直到生命周期确认成功后清除。新 generation 拒绝旧 handle，冲突 owner 不覆盖现有记录。仅运行时引用，不增加 ACP 或持久化格式，不授予重启后的 PID 回收权限。Windows 无 owner 的既有终止入口保留；Mac 缺 owner 保持未确认。`SessionProcessOwner::is_empty` 缺省报不支持确认，不把未知退出状态转成成功。


本文是 CodePro 跨模块事实所有权地图。它回答的是“谁有权写入和裁决某项事实”，不是当前实现已完全达成的证明。修改相关链路前，应从根目录 `AGENTS.md` 或 `documentation/codebuddy/CURRENT.md` 进入本文，再用当前源码、日志和运行证据核对迁移状态。

> **架构基线冻结声明（2026-09-21）**：本文与 `docs/superpowers/plans/2026-09-20-codepro-dag-runtime-refactor-plan.zh-CN.md` 共同构成冻结的架构基线。实现过程中发现的双写、兼容债务、测试失败和迁移进度写入独立实施记录，不因文件名、类型名或模块拆分变化而修改本文。只有用户目标变化、E2E 推翻核心不变量，或源码约束证明所有权设计无法实现时才修订，并必须留下原因、证据和 revision。

### 2026-10-03 Mac 项目父目录的已批准扩展

用户在可写父目录方案后要求继续实施。新增 `codepro_workspace_binding.v1` 的 `project_container { path }` 变体，由 ACP 宿主在确认创建后记录；父目录不获得项目工具写权限。旧 `root_container` 仍只表示文件系统根，旧 `writable_project` 及租约语义保持不变。旧后端遇到未知变体应拒绝读取，不得降级成可写。

新端点 `_goose/unstable/workspace/project-container/v1/allocate-child` 要求双方 `projectContainers: 1`。Agent 只提出子目录名，宿主签发关联 session/run/sourceMessage 的有时效令牌，前端选择并确认准确路径；Mac 用已持有的父目录 fd 创建直接子目录，冲突拒绝，不自动换名。共用既有分配令牌、租约归属、幂等收据和失败回滚。宿主持久化容器后，由既有 session/load 消耗同会话子目录租约并提交 writable_project；前端沿既有回调继续原消息/run，不创建新会话。

重启后仅恢复容器状态，不恢复创建令牌；继续创建须新请求、新令牌和重新确认。关闭/归档/删除会话撤销令牌及收据。文件清理权限不由创建权限派生。Mac 新通知 `codepro.needs_project_workspace_v1` 与旧通知区分，避免旧客户端把父目录当根目录或自动执行。实现和验证进度见 MACOS 三语记录。


## 已批准修订（2026-10-04）：项目确认刷新

用户在三语方案后回复“继续”，批准 `_goose/unstable/workspace/confirmation/v1/refresh`，双方协商 `workspaceConfirmationRefresh: 1`。ACP 宿主在既有会话生命周期屏障内，读取既有 RunBinding、控制面 Projection、原用户消息和宿主工作区通知，验证未终结运行及受限绑定；只通过现有 capability registry 取得有效确认。重复调用复用同一有效令牌；已分配租约、已绑定、已关闭／归档、终态或身份不匹配均拒绝。刷新不调用模型、不创建目录、不绑定租约、不执行原任务，不新增持久化事实或权限 writer。前端重新展示路径，经明确确认后使用既有分配、绑定、结构化续行。旧客户端不调用；旧后端由新客户端提示升级。

修订原因：bundle16 的自然语言重发曾改变 run 身份，bundle17 的结构化续行虽保留身份，但绑定后会执行任务，不适合作为只刷新确认的 UI 入口。基于 `00a6656` 与现有未提交合并；实施与验证见 MACOS 三语记录。

## 已批准修订（2026-10-05）：Mac 清理分阶段适配

用户在 MACOS_CLEANUP_DESIGN 三语具体方案及批准问题后要求继续开发以对齐 Windows。批准范围为沿用既有清理语义，抽取共用策略，并分阶段验证 Mac 只读审核、原生对象操作及恢复；不由项目创建令牌派生清理权限。ACP 宿主、cleanup registry/journal 与 UI 投影的 owner 不变。

当前阶段只加入内部只读 Inspection：复用保守目标范围及项目排除，用持有的目录链/文件描述符读取摘要并检测源替换、祖先变化、内容/硬链接变化。它不签发权限、不开放 Mac 清理 RPC、不修改目标、隔离或恢复日志；Windows 日志格式和原生操作保持既有语义。隔离/恢复/永久删除须先通过方案中的精确对象及故障恢复门禁，再接通产品；通过只读审核不授权后续按路径 rename/unlink。具体实现与未完成项记在 MACOS 三语实施记录，候选 FSRef 不视为已经证明满足合同。

### 2026-10-10 本地融合验收中的失败计划归档（用户批准）

Tester 失败经原计划修订边界保存原快照；当前图由独立复测承担原验证责任，旧失败状态与原工具回执留在历史中，不改写为成功。宿主 TaskInput 仅为 RecoveryEvidence 解析同一 DAG 已安装旧版本的精确节点、合同及失败证据，并核对原 run / task 身份；普通执行依赖仍只引用当前图。归档不改变授权、未结副作用、完成证据或重试上限的原 owner。缺历史身份的旧数据保持原行为，不猜测补造。实施与验收结果见 MERGE_LOCAL_REPAIR_20261010 三语记录。

## 使用规则

### 2026-10-09 停止执行与受阻交接修复边界

用户基于 `20261009_12` 授权计划与实施，起点 `08a440604 + 保留 dirty`。ACP Stop 只停止本次 prompt：由 ACP 原执行入口确认当前 prompt 已实际 register/resume 的 durable run，先经原 runtime 提交 PauseRun，再取消本次 token；临时分类、问答或提示请求引用历史 run ID 不构成执行绑定。该请求内标志不持久化、不裁决业务成果。明确取消业务仍走原 Cancel/EmergencyStop；已 Failed/Cancelled 的同目标续作建立带原始要求版本的新 run，不复活旧 run，不继承授权。模型仅分类需求是否变化，不再承担终态能否原地恢复的裁决。

重复相同完成缺口复用既有 Paused 后无工具答复，不提前退出丢弃交接。已经接受的新输入先被消费；取消与真正失败仍优先。要求修订的 continuation_source 由已提交要求关系保留，模型不填写任意来源。无正式 answer phase 的旧记录，UI 保留最后工具后的全部公开正文，不能用最后一条宿主提示吞掉此前交付说明。以上不把模型正文、可运行成品或部分测试通过提升为 Completed，也不把平台证据缺口提升为业务整体失败。实施与验证状态以实施记录为准。

2026-10-10 补充授权：用户批准续作引用原文件回执。原 ACP 绑定 owner 验证会话/工作区，runtime 验证原终态与要求版本，ToolAuditStore 验证原调用身份与回执；ToolTaskProgress 沿原 source 引用当前版本一致的文件事实。可选 continuation 不伪造 delegation，旧记录不补造来源；不转移权限、动作预算或成功 shell/外部证据。已认证原 scope 的未结动作、原 runtime 未确认效果和原审计缺终止回执，一并进入原完成检查的临时可重建投影；原 owner 对账后重建消除缺口，不写第二账本、不清除或遮蔽旧 Unknown。平台来源不可用不是业务效果失败。此批准扩展的是证据可寻址范围，不改变原事实裁决 owner。

### 2026-10-09 超时清理回执与终态后的流式交接

用户批准基于综合题 `20261009_1` 修复，起点 `4c984d799 + 保留 dirty`。进程终止、命令结果和业务副作用保持独立。工具执行边界在原超时/取消 ErrorData 的可选 `codepro_bounded_execution` v1 中保留同一次 operation 在清理窗口返回的原结果；审计仍记录 TimedOut/Cancelled，不写 Success。原任务投影只在 Platform `developer::shell`、原回执明确确认终止且输出管道收集未超时的条件下消除执行终止未知；部分文件变更保留，不进入成功写入或通过验证集合，不证明远端副作用成功。缺回执、无身份的旧 Unknown 不迁移、不追猜 PID；任意 Shell 的远端效果不可绕过保证不在本修复能力范围内。

`report_blocked.summary` 是模型提出的交接材料，不再直接充当已结束的用户回答。原 runtime 先提交 Paused，执行器将已提交状态及原未结动作投影给主模型，关闭执行派发，沿现有消息增量通道生成正式回答。最后才发 TurnTerminal，不再重放原 summary；并发取消/失败不被暂停覆盖。此投影仅在当前请求装配，不新增生命周期或持久状态；正文仍由模型负责，不以关键词或第二模型判决。旧会话原样回放，旧消费者忽略新的可选错误详情；实施、兼容与 E2E 结果见实施记录，不由本文宣称通过。

补充授权：回放反例发现原 `ToolResponse` 错误序列化仅存字符串，无法保留清理回执或原审计。用户批准在原记录的 `toolResult` 增加可选 `errorData`，由 `goose-provider-types/conversation/tool_result_serde.rs` 无损序列化原执行错误，SessionManager 沿原消息存储；工具事实消费者恢复原数据，不新增 owner。原 `status/error` 字段不变，旧读取器可忽略新增字段；缺失或损坏的可选字段退回原错误文字，不从文字补造事实。旧记录不迁移。回滚到旧 writer 后重新保存可能丢失可选数据，不宣称旧版具有新版恢复能力。

### 2026-10-09 委派文件事实的带来源引用

用户批准父任务消费子任务原始文件证据，起点 `ab8338527 + dirty`，原因是 R02 子任务已有写入回执而父 scope 过滤后无法引用，导致无业务意义的重写。原委派事件与 SessionManager 负责 run/task/parent/child 身份；原 ToolAuditStore 核验原始 started/completed、请求和参数摘要。父 ActionFacts 只投影已核验的文件写入，现有证据条目增加可选 `source`（子会话、子任务、原 scope 摘要和委派 EvidenceRef），不将子回执改为父回执，不新增账本。

当前文件版本仍现场核验；子运行状态、未结效果、显式接手仍归原 runtime/plan。`task_scope_digest` 仅绑定 run/task 身份，不是完整权限或工作区能力摘要；原授权结果来自原执行边界，不在引用时重新推断。导入文件不改变子状态，也不增加父执行预算、成功计数或提供外发/命令验证证据。普通任务和其他父的委派不导入；旧审计、委派容器或子会话不可读只使对应引用不可用，不能让其他完整引用失效。来源查询只读，不恢复或截断原日志；最终未结审计核验仍覆盖全 run 的任务。旧证据不推断来源、不迁移。来源字段只扩展当前写出的证据快照，原回执/事件格式不变；旧消费者可忽略该可选字段，但不保证旧执行器具备子证据重建能力。实现与 E2E 状态仍见实施记录，本文不代表验收通过。

### 2026-10-09 审计查找索引（不新增结果 owner）

用户批准由原审计模块维护可重建的位置索引，起点 `7ceeae2c9 + dirty`。`ToolAuditStore` 仍唯一写入/校验 started/completed 原回执；新增旁路文件 `tool-audit-locations-v1.json` 仅保存会话目录内容指纹及其中出现的 task scope 摘要，不保存执行结果或完成资格。Completion 仍读取原回执和原 effect ledger。

查询枚举会话目录与记录元数据（文件名、长度、修改时间），对照派生索引；仅未变化且不包含目标 scope 的会话免读记录正文。命中的会话始终重读并校验原回执；未索引或发生变化的会话先重建。索引版本无效、损坏或丢失时回读源数据，写索引失败只影响下次查找性能，不使任务失败或变为成功。索引以临时文件原子替换；并发更新丢失只导致后续重建，不能覆盖原事实。

原审计格式不变，旧版忽略这个旁路文件，旧版写入的记录仍因目录内容变化被发现；不迁移、删除或重写历史回执。该优化依赖宿主既有的不可原地改写回执约定，元数据也检测通常的外部修改，但不宣称能防止具备文件写权限者同时伪造源文件、时间戳与索引。它是可失效的查找优化，不是新的权限边界。实施及真实性能验收见现有实施记录。

### 2026-10-08 撤回普通多轮入口重构

用户明确要求恢复删除分类器前的多轮入口，只处理分类器超时。TaskEntry 按需登记、自动关联、完成门槛迁移及 answered 新终态全部撤回；原 resolve_codepro_run_input、conversation_only 和既有完成核验恢复。只读正文修复、子 Agent 和独立 UI 修复保留。实验会话不迁移、不将 answered 当 completed；实验记录仅作为失败证据保存。具体备份、差异与验收见实施记录。

### 2026-10-08 只读回答与查证事实分离

用户确认“调整职责，边调边确认”。源码起点 `63a6d5a38 + dirty`，失败样本 `20261008_8`：普通方案咨询被只读工具记录门槛强制重试并吞掉两次正文。原记录列表包含失败动作，既不能证明查证成功，也不代表用户每次回答都需要新资料。

本项修订 9/30 “只读有证据才流式”的限制：只读是当前动作能力边界，不是工具调用义务。原执行器沿 Message/SessionManager/ACP 发布和保存模型公开回答，零工具记录不再单独触发重试或替换正文；收尾和结构化输出不通过固定项目报告模板产生“已核实”判断。工具回执继续由工具边界产生并保留失败事实，活动展示不能替代验收证据。

Main Agent 决定如何回答、是否需要查资料，并对缺失资料作说明；宿主不保证自由文本的每项主张正确。明确结构化验收义务、权限、真实副作用和 Unknown 仍由原 owner 校验。只读回合 finished 表示本次响应结束，不写入业务 Completed。无新增 owner、状态机、持久字段或自然语言分类器，旧会话不迁移；实现与验收进度见现有实施记录。

### 2026-10-08 未完成委派的显式接手（计划审计扩展）

源码起点 `63a6d5a38`。子 Agent E2E Case3 发现预算退出被 String 包装丢失，而当前完成检查又要求当前图所有节点成功。用户明确批准“接手／替换，保留原事实”。新增入口只提出一次带 `reassigned_to` 的既有计划修订：Main Agent 选择是否接手；Summon 核对 SessionManager 的父子关系和已提交委派证据的 run/task/parent/child 身份；原 runtime 在同一运行锁内检查效果、回执与并发版本，原 plan reducer 校验已停止的部分结果节点及拓扑，再提交修订。它不是新的任务终态或第二份账本。

原 Paused/outcome/evidence 留在 RunProjection 历史，当前图不再要求该次委派自身成功；剩余责任绑定当前主任务，由模型决定自己补做还是再次委派。用户要求不变，Completion 继续消费原 owner，包括全部历史任务的未结回执，不把接手当完成。旧证据缺身份不猜测迁移。审计字段可选，新版读取旧历史保持原样；含新字段的事件不保证旧版 strict reader 能读，回滚不得把新运行数据交给旧版写入。实施及产品验收状态见 10/8 子 Agent 计划，不由本文宣称通过。

ACP 的可选 `inCurrentPlan` 只投影原 TaskGraph 的成员资格；UI 据此区分当前进度和历史详情，不能改变旧任务状态。旧快照无此字段沿用旧展示，不猜测哪些任务已转交。执行器遇到旧 max_turns 上限或撤回工具进入限额交接时，通过原消息通道记录 `codepro.execution_limit_reached`；子 runner 消费此事实，不从总结文案判断是否耗尽。

### 2026-10-07 工作过程与正式回答分离（展示约定修订）

用户明确要求执行时实时展示、正式回答开始时整体折叠此前过程，并授权按公开协议比较后实施。源码起点 `8f1b1ae0757ce4603d7660a7004795b9525654f7`，计划见 `docs/superpowers/plans/2026-10-07-process-final-answer-repair.zh-CN.md`。这不是产品 E2E 通过声明。

原 `propose_coverage` 提案在工具回执返回前调用同一个完成核验入口；拒绝保留为该工具的错误回执，接受仍由原 runtime 提交完成。之后只有回答生成，不再开放执行派发；新输入不因此获得授权，也不作为已完成任务的暗中续执行。可选 summary 是提案说明，不是证据。未使用该提案的旧客户端仍保留既有出口，不推断旧文本用途。

为表达回答开始，9/30 的“仅 Message 与 TurnTerminal”展示约定增加现有 ProgressMessage data 内的可选 `codepro_response_phase` 标记。执行器是该展示标记的 writer，SessionManager 保存，ACP 传输/回放，UI 消费；它不写入控制面、不证明业务成功，不是新的任务状态。旧历史缺失时不补猜。TurnTerminal 仍只投影原 runtime 的事实，正文发送结束后才发布，不能提前 seal 截断正文。此修订不改变权限、观察、Effect、Unknown 或完成资格的 owner。

10/7 后续缺材料 E2E（`20261007_2` / `tser5vss`）证实交接正文、宿主包装、空终态兜底重复。用户授权继续修复结束判定和内部对话割裂，起点 `cb5914e0d`：`report_blocked` 的原交接正文由既有 TurnTerminal 同一消息携带，先由原 runtime 记录 Paused，再发布回答边界与交接消息；不再先发独立交接、后发空终态。不覆盖并发 Cancelled/Failed，不清除 Unknown，不将暂停解释为业务完成。旧历史不迁移。旧兼容结束出口的核验拒绝不再伪装成 user 消息：执行器只在进展指纹仍匹配时将原核验结果作为本次模型请求的事实上下文，指纹变化后不复用旧缺口；上下文明示为上次检查，不将该指纹提升为全部事实的版本。工具提案的拒绝仍是原工具回执。此处修订传播与展示方式，不新增事实 owner；实施和产品验收状态见现有实施记录。

### 2026-09-30 公开正文与完成核验分离（展示约定修订）

用户在对照公开协议及 WorkBuddy 分享材料后选择体验优先，并明确批准实施。修订原因是 9/30 网页会话已有上游 Text 分片，却被宿主缓冲到结尾才展示；下面 9/28 约定中“Main Agent 普通文本分片仍先缓冲”对普通公开正文不再适用。源码起点为 `4e6b3ae1f`，实现及验收状态见 `docs/superpowers/reports/2026-09-30-codepro-ux-repair-progress.zh-CN.md`，不是产品验收通过声明。

模型仍是公开正文作者。Agent 保留原 audience/visibility 边界，沿现有 Message/ACP 发送普通正文增量；没有 provider message ID 时由宿主分配当前响应的展示 ID。SessionManager 仍唯一保存会话，显示过的正文在响应结束、取消或 provider 流错误边界保存，不因完成提案被拒绝改为仅模型可见。这里不承诺进程崩溃前逐 token 落盘，也不修改旧历史。

完成提案、证据、权限和终态仍由原控制面负责；正文生成结束不能提交 Completed。核验拒绝时保留模型原文，另发明确的未通过说明；继续执行或交接仍走既有路径。核验通过不重放已经流式发送的同一正文；宿主依原事实替换出的核验说明使用独立消息。只读有证据的普通回答沿原消息路径流式；finalize、结构化 final-output、simple-change 和 exact-reply 等特殊出口不在此约定中强行放开。

ACP 和 UI 仅消费消息与原 TurnTerminal，不新增持久协议、完成 owner、正文分类器或状态机。取消后 ACP 不再转发正文，但为原 Agent 的保存和取消处理保留有界收尾消费；收尾超时只能记录历史可能不完整，不能宣称保存成功。本文修订的是展示与保存语义，不授予任何执行权限，也不把模型文字变为业务事实。

### 2026-09-28 高级模型路由停用保留组合

用户明确批准将“关闭并保存清空组合”改为“停用但保留组合”。`GOOSE_CODEPRO_MODEL_ROUTING` 仍是唯一配置来源，ACP 专用配置接口负责结构校验与持久化；前端只编辑草稿并显式保存，不新增偏好存储或状态机。`advancedRoutingEnabled` 决定是否使用 `routes`，不决定是否记住它们。`ModelRouterConfig` 只在启用时将角色选择转换为执行配置；停用时忽略保留组合及其并发数，主 Agent 沿用会话模型、其他角色沿用既有默认路由。

停用时允许保留完整的厂商/模型对（可以只有部分角色），仍拒绝重复角色、空标识和未知字段，但不联系厂商检查可用性；再次启用必须具备原有必需角色并通过既有实时模型校验。厂商删除/模型移除导致自动停用、以及用户切换普通默认模型时，也只停用而不清空角色选择。保留旧标识不恢复厂商、凭据或执行权限。

这是现有版本 1 配置形状的语义扩展，旧的空配置和四角色配置继续可读；旧后端不能读取含非空 `routes` 的停用配置，新前端必须配套新后端。降级前需备份组合并将停用配置的 `routes` 显式置空，不能把拒绝读取解释为默认配置或静默清空。具体实现与验收状态见 `docs/superpowers/reports/2026-09-28-main-agent-model-routing.zh-CN.md`；源码身份为 `18753e430` 加本批未提交改动。

### 2026-09-28 输入关系与计划归属的有限扩展

用户明确批准将普通追问边界纳入原方案并实现计划关联。普通下一轮沿用 `resolve_codepro_run_input` 的一次语义判断，增加 `question`：只回答上下文/常识问题，不注册、恢复、取消或终结旧运行，不提交要求或清单。要求项目事实检查的请求不属于此无工具分支；执行中 steer 仍由现有 Main Agent 接收解释，没有新增分类请求或旁路并发问答。

ACP 在已接受执行的原始用户消息上保存 `taskRunId`，统一执行的既有 `codepro_unified_turn.v1` 同时保留 `run_id`，用于压缩后的来源恢复。消费者必须重新校验原 `RunBinding` 的 session/workspace 与 runtime；Todo 不得反向选择任务。无关联历史沿用既有拒绝歧义行为，不按文件时间猜归属。这里只新增关联记录，不改变控制面生命周期或权限。

CodePro 清单使用同一会话数据库的 `todo.v1`，键为宿主运行 ID 与要求版本，binding 额外含 session ID；模型只提交 `content`，宿主工具上下文绑定来源与 request ID。SessionManager 事务只更新这一命名空间，选中版本与写入版本不符时拒绝该次清单写入。同一运行/要求版本继续时复用；新运行隔离；要求修订保留旧版本供同任务核对，不把旧勾选当作新版当前计划。`todo.v0` 原样保留，不迁移或猜测绑定；非 CodePro 的旧 Todo 行为不变。

模型上下文和 UI 消费同一绑定清单。旧 Todo 调用只从 provider 输入投影移除，不从持久会话删除；未绑定历史仍可在聊天记录查看。UI 通过原进度消息通道的 `codepro_plan_context` 展示投影和成功工具回执更新卡片，重放末尾从持久状态恢复；动效需匹配实际活动运行，不按最新用户消息推断。清单没有新增状态机，也不决定完成或授权。

公开进度允许可选 `stage`（至多 100 字）作当前阶段标题；异常可选标题降级，不阻断有效正文。标题与经过校验的回执沿现有工具通道保存，UI 只展示，不当执行证据；不增加标题润色请求。过程计时只表示当前提示持续时间，不表示网络已收到分片或工作完成。实施与未验收边界见复盘第 22 节。

### 2026-09-28 执行中插话的有限修正

用户批准去掉“插话即要求修订”，复用 Main Agent 语义理解和既有合同提交，不增加分类请求或计划状态机。执行器接收的原始插话仍由 `SessionManager` 保存；接收本身不提交要求、不清除完成覆盖、不授予权限。当前执行内的来源索引仅供 `codepro__task_contract inspect/revise` 使用：Main Agent 判断确属要求变化后提出修订，宿主核对该输入来自当前执行或已有合同，再由原控制面提交版本。普通提问通过公开说明回答，不因传输标记自动成为要求。

索引不另建持久存储，不从整个会话历史反推运行归属；已提交要求按原协议保存，未提交插话在执行结束后只保留原消息历史，不自动迁移。`inspect` 的补充 `followup_inputs` 是原始输入，不是已接受要求或授权。修订须单独提交，混有其他调用的整批不执行，以保留修订后的原有授权校验。停止/授权入口和完成门槛不变；普通下一轮续接分类、历史插话恢复和 Todo 归属不在本次扩展内。依据及验证边界见 9/27 全链路复盘第 21 节。

### 2026-09-28 消息与清单展示修复

用户批准按 9/27 全链路复盘逐步修复。Main Agent 普通文本分片仍先缓冲；同次响应出现真实工具请求时，将之前的公开说明按原消息通道发送并保存，不再丢弃。无工具最终答复仍走原完成门槛，特殊只读/simple-change/exact-reply 出口不放宽。没有新增消息协议或完成权威，普通说明和 `publish_progress` 都不能充当执行证据。

Todo 的既有 `content` 文本补充 `[-]` 进行中展示约定，兼容原 `[ ]`/`[x]`；唯一作者仍是模型，原请求/成功回执和 `todo.v0` 仍是存储来源。UI 只对当前执行轮次最新成功计划中的显式进行中项显示动效，停止/等待/历史不转动，不从待办顺序推执行事实。清单不是控制面的任务状态，不改变权限、恢复或终态。实施与未验收边界继续记在 `docs/superpowers/reports/2026-09-27-codepro-end-to-end-retrospective.zh-CN.md` 第 17 节。

### 2026-09-27 用户旅程与进程归属有限扩展

用户在 1504 E2E 对照分析后批准实施。新增 `developer::shell` 可选 `process_action=start/status/stop`、`process_handle`、`port`，仍经过原 shell 权限和审计入口；有任务 scope 时仅全访问 Main Agent 可保留长进程，受限 worker 不获得后台权限。工具复用 `SystemProcessGroupOwner` 作为进程组生存与终止的唯一 owner，工作目录、session、原命令与随机 handle 绑定；Windows 端口归属由 OS Job 成员核对。`managed_process.schema_version=1` 回执随原会话工具结果持久化，活句柄只在当前后端有效，重启后拒绝拿旧 PID 替代。运行/端口归属不是网页或业务就绪证明。旧无句柄 unknown 不回填、不根据 HTTP 200 或用户回答消除；仅同 owner 对同 handle 的进程组退出回执可结清该组此前不确定的 stop。

`codepro__task_contract report_blocked` 是 Main Agent 提出的用户可读受阻交接，不是 Completed 或授权。宿主复用原 Pause/终态路径提交暂停，原 unknown 与未完成要求保留。正常预算 Finalize 保留一次无执行工具的交接机会；自然语言不反向改变控制事实。相关实施及未验收边界见 `docs/superpowers/reports/2026-09-27-codepro-1504-journey-repair.zh-CN.md`。

展示侧仍从原 todo/工具回执消费计划和修改记录；工具输入预览只按 call ID 展示，不能作为执行或文件已写入的证据。

### 2026-09-25 公开进度有限扩展

用户批准统一对话体验实施，并要求直接完成到 E2E-ready。本次增加展示专用 `codepro__publish_progress` v1：Main Agent 是公开说明的作者，宿主仅校验结构与长度并写入现有会话请求/回执，桌面按同一 call ID 消费成功回执后显示正文。它不产生授权、要求修订、执行证据、失败计数重置或终态。旧会话无此请求时保持原呈现；失败请求保留错误，不当作成功说明。没有新增状态库或控制事实 owner。原因及迁移边界见 `docs/superpowers/reports/2026-09-25-codepro-conversation-experience-implementation.zh-CN.md`。

1. 每项事实只有一个业务裁决者；其他模块只能校验边界、执行动作或建立展示投影。
2. 原始输入、候选解释、已验证合同、运行事件、证据和报告是不同对象，不能相互冒充。
3. 新增跨层字段时同时写清 owner、唯一 writer、consumer、持久化位置、版本及失效规则。缺少任一项时，该字段不能成为新的硬门禁。
4. 子目录 `AGENTS.md` 可以细化局部实现方式；与仓库级协作规则冲突时以更深目录为准。若局部规则改变本表的事实所有权，必须连同本文和跨层协议一起修改。
5. 表中的“迁移断点”是当前需要核对的已知双轨位置，不应被当作长期允许的第二权威。

## 权威来源与消费边界

| 事实 | 权威 owner 与唯一 writer | 持久化或版本 | 合法 consumer | 禁止的第二裁决 |
| --- | --- | --- | --- | --- |
| 原始用户输入与会话历史 | `crates/goose/src/session/` 的 `SessionManager` 及会话写入入口 | 会话消息 ID、顺序和持久化记录 | 路由、Planner、恢复、报告引用原文 | 任何下游改写原文来证明不同目标或授权 |
| 入口模式与初始安全路由 | `agents/codepro_intent.rs` 生成；`agents/codepro_routing_evidence.rs::CodeProRoutingEvidence` 提交当前消息进入普通回答、CodePro 或拒绝/澄清等入口决定 | `schema_version`、来源消息、build provenance | ACP 分流、执行入口、诊断 UI | 把入口 intent 枚举当成运行中每一步业务动作，或由 Planner、报告、UI 再从自然语言重分类 |
| 运行中的语义决策 | 目标 owner 是 Main Agent；它基于已提交 Observation 提出版本化 `AgentDecision`，决定 `Respond/Act/Delegate/RevisePlan/AskUser/ProposeFinish/Stop`。当前 Coordinator 仅是旧 DAG 管理协议，不代表该目标已落地 | requirement/plan revision、decision ID、引用的 evidence IDs | Action binder、Planner/Worker 委派、完成评估 | 入口路由、Scheduler 或字符串规则替模型决定具体技术下一步 |
| 用户要求的版本化解释 | 原始用户输入始终保留；Main Agent/Planner 只提出 `UserRequirement` 候选，用户修正可覆盖；目标唯一提交者是宿主 `RequirementReducer/Registry`，负责来源绑定、revision 和授权边界，不负责发明语义。该提交组件尚未落地 | 来源消息、requirement ID、解释 revision、不确定项、用户修正、状态 | Main Agent 决策、计划提案、完成语义评估 | 把模型候选、Planner JSON、TaskDAG 或报告文字直接当作已提交用户目标 |
| 计划拓扑 | 目标 owner 是宿主校验并提交的 `PlanGraph`；Main Agent/Planner 只提出语义候选。当前 `TaskDAG` 仍同时承载拓扑和运行字段，是待拆分的过渡控制源 | `plan_revision`、修订审计、task/edge identity；task 状态变化不得产生新 revision，只有显式 `RevisePlan` 可替换拓扑 | Scheduler、恢复、TaskInput 绑定、验收映射 | 把完成节点从当前图删掉、用 retry/resume 冒充 replan，或让兼容 DAG 静默改图 |
| 任务执行合同 | 宿主校验后的 `TaskContract`；模型可提出目标、输入、行为和验证建议，宿主只做结构、安全和引用校验。当前 scope 字段仍混有权限兼容语义，属于迁移债务 | task/contract revision、requirement 来源、input/evidence 类型 | Worker 输入、验证策略、完成义务 | 从任务文案补造合同，或把合同目标等同于权限授予 |
| 动作授权与 CapabilitySet | 目标 owner 是宿主 Authorization/Execution Policy；根据原始用户授权、系统策略、工具策略、工作区和当前 Action 生成最小 `CapabilitySet`。当前工具权限仍分散在角色、TaskContract 和工具层，尚未统一 | authorization revision、action/attempt ID、scope、有效期、撤回/失效原因 | Action dispatcher、工具边界、审计与恢复 | PlanGraph、Planner、AgentRole 或 `RevisePlan` 扩大权限；旧 capability 跨授权 revision 复用 |
| 任务间结构化输入 | 正式 `InputEdge` / `TaskInputRef` 声明来源关系；普通 Dependency 与 `RecoveryEvidence` 等关系分别验证。当前 `TaskDAG.depends_on`、`TaskInputRefV1` 和 `TaskInputEnvelopeV1` 是兼容实现 | run、plan revision、consumer/source task、input kind、producer attempt 与 evidence ref | Scheduler 和对应 Worker | 把失败摘要拼进 description，或由 Worker 根据“参考 task-1”自行找上游事实 |
| 运行与任务生命周期迁移 | `agents/control_plane/reducer.rs` 是唯一业务裁决者：校验 `ControlCommand` 相对当前 Projection 是否允许，并产生事件意图 | command、当前 sequence、plan revision、状态迁移规则 | `RunEngine` | EventStore、Projection、Scheduler、报告或 UI 独立决定状态迁移 |
| 运行事件提交与持久化 | `RunEngine` 负责命令校验、调用 Reducer、物化事件和原子提交；`RunEventStore` 只按 sequence 追加/读取事件，不作业务判断 | append-only event、sequence、command receipt | 恢复、重放、Projection rebuild、审计 | EventStore 根据内容重新解释业务语义，或绕过 Reducer 写入生命周期事件 |
| 运行状态派生视图 | `reporting::RunProjection::rebuild` 从已提交事件确定性重建；它是派生视图，不是 writer | 最后 event sequence、plan revision、task/agent/effect projection | 调度、恢复、收敛、报告、ACP/UI | 直接修改 Projection，或用本地 DAG/UI 状态覆盖已提交事件 |
| 动作尝试与未知结果 | 目标 owner 是 control-plane Action reducer + durable action/effect ledger；统一提交 `Proposed -> Authorized -> Dispatched -> Succeeded/Failed/Unknown/Cancelled`。当前 attempt/effect 记录分散在 Scheduler、Tester、Computer 和 effect ledger，尚未形成通用合同 | operation ID、attempt ID、plan/authorization revision、幂等/可重试属性、工具回执 | 恢复、重试、证据、进度和完成门槛 | 根据自然语言或进程退出猜测是否执行；Unknown 外部副作用自动重放 |
| 模型、动作、replan 与委派预算 | 目标 owner 是宿主 Budget Policy 与 control-plane reducer；模型只能申请额外预算。当前 action budget 仍部分保存在 `TaskDAG`，属于迁移实现 | run/task/action、budget revision、消耗事件、上限和耗尽处置 | Main Agent loop、Scheduler、报告 | 模型自行重置预算，或在压缩/恢复/replan 后丢失已消耗额度 |
| 原始工具执行事实 | 工具边界产生的结构化回执 | tool call/result ID、命令、退出码、时间、作用域、结果未知标记 | evidence normalizer、审计、恢复 | Agent 自述或关键词替代真实回执 |
| 规范化验收与工作区证据 | 最终目标为控制面引用的版本化 evidence；过渡期验证事实由 `TaskDAG::VerificationEvidenceV1` 保存，工作区 delta 只允许宿主在 implementation 完成门槛处根据真实文件观测确定性派生，并随 task evidence bundle 提交 | run/task/plan revision、产物或文件版本、evidence ref、失效状态 | `CompletionRequirements`、Reviewer、terminal report | Worker 自述 delta、通用输出 DTO 的可漂移副本，或 DAG ledger 与 control-plane refs 各自证明不同完成结论 |
| 独立审查结论 | `reviewer_agent.rs::ReviewVerdict` 的结构化 verdict，由宿主提交到控制面审查事实 | run、plan revision、review round、issues/remediation、approved | 收敛门禁、返工、报告 | Reviewer 任务自然语言或“任务成功”自动等价为 approved |
| 暂停、用户输入与恢复 | `agents/protocol::{Checkpoint, UserInputResolution}` 与控制面事件；文件恢复事务由 `CheckpointTransactionStore` 提交 | checkpoint ID、event sequence、待完成任务、未知结果动作、用户决议 | 恢复调度、ACP/UI、报告 | 从最终文案猜 checkpoint 存在、恢复策略或用户授权 |
| 语义交付判断 | Main Agent 默认根据权威 Observation 提出 `ProposeFinish`；风险策略、用户要求或证据冲突时由独立 Reviewer 复核。它只能提出语义结论，不能提交终态 | requirement/plan revision、语义结论、引用 evidence IDs | ConvergenceEngine、报告事实构造器 | Scheduler、Convergence 或报告自行解释用户委托是否已交付 |
| 完成硬门槛 eligibility | `ConvergenceEngine` 根据宿主从 Projection、Evidence Store、Authorization 和风险策略构造的要求判定 Eligible/InProgress/Blocked；当前 `CompleteRun` 仍可携带调用方 requirements，是待修复边界 | 当前 requirement/plan/authorization revision、evidence refs、blockers | Reducer、报告事实构造器 | 申请完成者自行选择门槛/evidence authority，或 Convergence 改写语义交付判断 |
| 正式运行终态 | control-plane Reducer 是唯一 writer；仅接受通过语义提议和硬门槛校验的完成 command/event | terminal event、sequence、run state | Projection、恢复、terminal report、UI | legacy run state、Scheduler、Reviewer 文案或报告自行宣布 Completed |
| 最终报告事实 | `codepro_terminal_report.rs::build_report_facts(ReportFactsInput)` 是当前宿主 Builder/Projector；`CodeProReportFacts` 只是不可反向写状态的数据结构 | 终态 event sequence、引用 evidence、limitations/recovery action | `ReportDraftV1`、确定性 renderer、ACP/UI | Report Writer 或报告文字反向改变 outcome、验证、权限或恢复动作 |
| 压缩/恢复后的 Main Agent 上下文 | 目标 owner 是宿主 Context Assembler；从已提交 requirement revision、plan revision、RunProjection、未完成/Unknown action、blocker、EvidenceRef 和不可重复副作用装配一次模型输入。当前仅有部分会话压缩与 checkpoint 机制，尚未形成统一装配器 | context assembly revision、来源 event/evidence IDs、压缩 operation ID | Main Agent/Planner/Reviewer 模型调用 | 自然语言摘要成为状态权威，或模型从旧对话自行猜测当前授权和动作结果 |
| 父会话上下文占用 | 父会话实际 provider usage/update；未知时保持未知 | session/message usage 记录和 context limit | 输入栏容量提示、自动压缩预算 | 把子 Agent 多次请求累计量当父上下文占用 |
| 子 Agent 单次请求用量与压缩生命周期 | 共用 subagent/provider 边界写入带 origin 的 `worker_usage`、`compaction_lifecycle` | parent session、run/task/role、worker session、operation ID | 任务面板、诊断记录、对应 worker 的状态视图 | UI 把不同 worker 相加为某一请求上下文，或从进度文案推断压缩 |
| 用户界面状态 | 后端 ACP 结构化事件经前端 store/reducer 形成 projection | session/run/task/operation identity 与重放状态 | React 组件只读展示 | 组件局部状态、文本关键词或动画反推后端控制状态 |

## 当前迁移断点

这些位置在收敛完成前必须显式标注“谁暂时提供数据、谁最终裁决”，不得用兼容桥掩盖双写或双判定。

| 断点 | 当前风险 | 收敛方向 |
| --- | --- | --- |
| `TaskDAG` evidence ledger 与 control-plane `evidence_refs` | 两边覆盖范围可能不同；一个评估放行后，另一个提交阶段仍可拒绝 | 将规范化证据一次写入并引用；过渡期的 authority 枚举必须被 assessor、reducer 和持久化层一致解释 |
| `TaskDAG` Ready/依赖/状态 与 `PlanGraph + RunProjection` | Durable 批次选择的 Ready、全局生命周期 blocker 和 repair 依赖已改由同 revision 的 `RuntimeSchedulingView` 提供；完整 PlanGraph 在任务完成后保持不变，TaskInput/evidence 使用 runtime 当前 revision；Scheduler 仍从 DAG 读取任务描述、合同、恢复上下文、结果账本及其他兼容状态 | 继续迁移剩余依赖输入与状态迁移；全部切换前明确称为过渡控制源，不称为只读镜像 |
| host retest resume 与 plan revision | 当前 `commit_host_retest_resume()` 用同拓扑的新 revision 使验证任务重新入队，plan revision 暂时代替了 retry/resume attempt | 建立通用 Action/Task Attempt 状态机后，恢复只新增 attempt；仅拓扑、合同或义务变化才 `RevisePlan` |
| TaskContract scope 与动作 CapabilitySet | 当前 TaskContract、角色工具列表和工具自身策略都携带部分权限语义，撤回与失效规则不统一 | Authorization Policy 生成绑定 action/attempt 和 authorization revision 的最小 CapabilitySet；计划和合同只能申请/消费，不能授予 |
| `CodeProRunState` 与 `RunProjection` | legacy 状态先得到 Completed/Paused，control plane 再给出不同终态 | legacy 仅作兼容快照；control-plane reducer 是最终提交者，报告读取已提交投影 |
| DAG 中的 Reviewer 任务与独立 `ReviewVerdict` | 通用 Planner 已不再创建 Reviewer 节点，宿主 Reviewer 消费 `TaskDAG::verification_disposition()`；专用桌面验收 DAG 仍保留 Reviewer 节点 | 只保留一个结构化审查提交入口；专用 DAG 的复核结果也必须显式产生或引用同一 verdict |
| task-level checkpoint 与 run-level checkpoint | 任务已保存局部检查点，但终端事件可能没有可恢复 checkpoint ID | 用一次事务提交运行暂停、checkpoint 和恢复策略；UI 只展示已提交 ID |
| 父会话 usage 与 worker usage | 父会话无 usage 时 UI 显示未知，worker 已有用量却只存在于旁路消息 | 保持口径分离，但在同一状态模型中明确显示当前 worker 请求，不伪造父上下文总量 |

## 修改路由

| 要修改的行为 | 先查 owner | 主要 consumer 或相邻边界 |
| --- | --- | --- |
| 意图、只读/修改分流 | `codepro_intent.rs`、`codepro_routing_evidence.rs` | ACP server、执行入口、路由证据 UI |
| 用户要求解释、计划、任务合同与验收义务 | 原始会话 + 主 Agent/Planner proposal + 宿主 PlanGraph/contract 校验边界；当前兼容入口在 `planner_agent.rs`、`task_dag.rs` | `task_scheduler.rs`、恢复、Completion Evaluator 与 convergence |
| 工具回执、命令和文件变更证据 | `task_scheduler.rs` 的结构化采集/normalizer | DAG evidence bridge、control-plane event/result |
| 任务/运行状态与终态提交 | `control_plane/{runtime,reducer,convergence}.rs` | `agent.rs` bridge、checkpoint、terminal report |
| 审查与返工 | `reviewer_agent.rs` 的结构化 verdict | DAG 修订、control plane、report facts |
| 暂停/继续/用户确认 | protocol、runtime、checkpoint transaction | ACP server、session store、任务面板 |
| 最终用户报告 | `codepro_terminal_report.rs::CodeProReportFacts` | report writer、确定性 renderer、UI |
| token/压缩显示 | provider/subagent 结构化事件 | ACP adapter、chatSessionStore、任务面板与输入栏 |

任何模块发现上游事实缺失时，应返回“缺少哪个结构化事实、来自哪个 owner、绑定哪个版本”，而不是重新解析自然语言补造事实。安全边界可以拒绝危险动作，但不能借安全兜底改写用户目标或伪造完成。

### 2026-10-05 Mac 桌面验收先决条件接线

在用户继续对齐 Windows 功能的范围内，修复 Scheduler 的非 Windows 恒 false 门槛。现有原生电脑助手是 OS 环境事实的唯一读取者，doctor 新增内部版本 1 desktopEnvironment；Scheduler 只消费结构化 desktopAvailable/permissionAvailable，不解析 text，不改变 Reviewer 决策、Checkpoint、ACP 或持久化格式。事实仅用于当前 Reviewer 启动，不缓存、不授予任务权限、不构成验收证据。每次动作仍由原生工具执行既有权限与目标校验。

相比在 Rust 再读一套 TCC／Quartz 或放开所有 Mac，调用已打包的 Swift 助手保持同一 OS 读取实现；直接启动助手使 3 秒超时可结束并回收唯一探测子进程。输出上限 64 KiB；旧助手／非法结果保持等待，Windows OpenInputDesktop 保留。版本随同包部署，不新增模型可调用工具、公开 ACP 接口或状态库。锁屏补充信号的非公开键兼容限制及真实桌面待验收边界见 MACOS_PARITY_ZH_CN.md 的 stage26。


### 2026-10-07 stage28：已批准先交付 Mac 只读审计与取消

用户在 stage27 具体方案后回复“允许”，批准调整 MACOS_CLEANUP_DESIGN 第 5 步：原有 workspace_lease 继续拥有 root/session/run/sourceMessage/nonce 校验与生命周期；cleanup::Inspection 读取目标摘要。Mac 仅连接 audit/cancel，明确返回 executionAvailable=false；Agent 通知也携带同一平台能力，UI 只消费该结构化字段。Windows 回应新增 true，旧 Windows 无该字段仍保留原语义；非法字段拒绝显示动作。

Mac 审计回执仅在内存中保存持有的 Inspection 与原能力。审计提交、取消和会话撤销按同一 receipt→capability 锁序串行，撤销期间的检查不得重新插入回执。取消令 audit token 失效，只在原有效期内释放原只读能力以便重新选择；过期不续期、不恢复权限，重启不载入回执。五个其余清理入口继续由后端返回 cleanup_read_only；通过检查不授予隔离、删除或恢复权限。没有新增持久化库、修改 Windows 日志或降低精确对象写入保证。

### 2026-10-16 已批准：Mac 凭据保护

`runtime/secrets.mjs` 继续拥有配置密文的保护/解封调用边界。Mac 独立 `codebuddy-credentials` helper 通过 Security Keychain 持有随机主密钥，以 CryptoKit AES-GCM 处理版本化密文；打包流程拥有 helper 的固定路径、哈希和签名身份。解密只读取已有密钥，缺失或无权访问时失败；不改变 Harness 执行或 MCP 权限所有权。Windows DPAPI 数据不迁移。

繁體：Mac 獨立憑證 helper 擁有 Keychain 主金鑰與加解密，既有設定與 Harness 權威不變。English: The standalone Mac credential helper owns its Keychain master key and encryption; existing settings and Harness authority remain unchanged.


## 2026-10-20 已批准：媒体实时预览消费者

`comfyui-tool.mjs` 继续独占任务收据、状态确认与产物落盘；`comfyui-live.mjs` 只缓存该任务 WebSocket 的节点进度和最近预览帧，不裁决任务或 Agent 完成。认证后的 `_codebuddy/media/jobs` 根据宿主持有的会话目录读取收据并复用原发布逻辑，不接受客户端指定服务或文件目录，不提交、取消或重放生成。帧数据不进入模型工具回执或对话持久化。前端右侧仅消费结构化观测，断线保留提示并重试；已完成产物通过原工作区媒体协议播放。旧收据无需迁移，关闭窗口后生成仍归 ComfyUI，关闭宿主清理观测连接。

繁體：工具持有收據與落盤，WebSocket 快取僅供預覽；右側透過認證 RPC 消費，不重新提交生成。English: media tools retain receipts and publication ownership; WebSocket observations are transient, and the authenticated side-panel consumer never resubmits generation.

## 2026-10-26 已批准：桌面路径打开与桥接复用

用户批准在既有电脑控制 MCP 增加 Windows `open_path`，接受明确的本地文档／文件夹路径，不接受命令、URL、网络路径、脚本、可执行文件或快捷方式。独立 Go MCP 校验路径和前台输入启用状态，经系统默认应用打开；Harness 继续拥有工具启用、审批与执行事实。此能力不调整原生 Shell 沙箱，也不通过保活任务延长 Shell 子进程寿命。启动受理与画面验证分别报告，旧九工具及 macOS 合同保持兼容。

### 2026-10-27 已批准：电脑控制提示与取消连接

**2026-10-28 用户追加修订：移除全局状态条。** 下述紧凑状态条及恢复按钮方案撤回。Electron 不再渲染全局电脑控制卡片或状态条；Esc 保留暂停，原因在原对话工具结果和回复中说明。新的显式用户 prompt 在无在途动作及无有效活 lease 时解除旧暂停（含旧文本及 owner_lost 标记），只开始新输入对应的任务，不复活旧对话。已受理的原对话插话可以解除自己的本进程暂停；其他活对话和在途动作仍受隔离保护。内部 desktop/control 协议保留兼容，后台任务与压缩不自动恢复。当前实际产品验收以本轮报告为准。

繁體：使用者要求移除全域狀態列；透過對話新訊息繼續，沒有在途動作或有效活 lease 時解除舊暫停，不復活舊任務。English: The user requested removal of the global status bar. Explicit chat input releases idle pauses without restarting old tasks; live ownership and in-flight actions stay protected.

**2026-10-28 用户批准简化交互，覆盖下文鼠标基准及永久接管语义：** 鼠标移动不改变暂停状态；点击、滚轮、键盘输入由原生 MCP 记录为瞬时输入版本变化，旧观察随即失效。安静 600 ms 后允许重新观察，等待超过 3 s 返回本次输入冲突；不自动重放动作，也不写永久暂停。Esc 与暂停按钮保留明确暂停。协调器继续独占桌面 lease、队列、暂停与恢复事实；原轮次结束且无 live lease 时，原对话的新显式 prompt 可以解除自己的 Esc/manual 暂停，后台任务和压缩不触发。旧 mouse/keyboard/cancelled 标记在无占用的新显式 prompt 前退役，未知或 owner_lost 标记保留。停止等待原生动作收尾后释放自己的暂停；不续接已停止任务。Electron 消费结构化状态，显示紧凑状态条和所属对话入口，空闲时隐藏。Harness 的执行、审批与完成权威保持不变。此为本项目经批准的实现；Codex 截图仅提供交互参考，不据此推断其私有算法。

繁體：移動滑鼠不暫停；實際輸入使舊觀察失效並要求重新觀察。Esc／按鈕明確暫停，原輪次結束後可由原對話新訊息繼續；停止收尾後釋放暫停。介面使用緊湊狀態列。English: Pointer movement does not pause. Input invalidates observations; fresh observation is required. Escape/button pauses explicitly; a new prompt in the original chat may resume an ended turn. Stop releases its pause after cleanup. UI projects a compact status bar; Harness authority is unchanged.

**2026-10-28 用户批准修订，覆盖下段旧 Esc 语义：** Harness 仍是任务执行、审批与完成的唯一 owner。`runtime/desktop-coordinator.mjs` 只拥有共享桌面控制权、等待队列及接管闸门；独立内部 `desktop/control` 请求负责 pause/resume/withdraw/state，Esc 不再调用整轮取消。旧客户端携带 desktop token 的 session/cancel 也只暂停桌面；普通 session/cancel 保留整轮停止。用户接管闸门在本机用户目录持久化，阻止其他 profile 自动抢占；活 lease、窗口与元素不作为可恢复输入保存。原生 MCP 检查宿主 lease/generation，恢复后清空旧 UIA 观察；底层输入钩子写接管标记，原生动作在输入与观察边界检查。Electron 只投影状态和提交用户明确恢复，模型无解除闸门工具。暂停首次返回工具级受阻结果，独立非桌面步骤可继续；重复桌面提案等待恢复后作废，不重放。待测状态及未覆盖平台以本批验收报告为准。

繁體：Esc 僅暫停桌面控制；使用者接管後須明確恢復，多對話共用桌面控制權，恢復後重新觀察。Harness 保有任務與核准權威。English: Escape pauses desktop control only. Human takeover persists until explicit resume; conversations share one desktop lease and re-observe after resumption. Harness retains task and approval authority.

**2026-10-28 恢复交接修订：** 原接管标记兼容扩展为 revision/reason/at JSON，旧纯文本标记仍保持暂停，原因显示未知。原因由原生输入钩子或协调器写入，展示层不解析报错或模型文字推断。协调器的 paused/stale/withdrawn 结果经 Harness 适配、ACP 元数据投影到工具行，不改任务完成判定。恢复请求核对用户看到的占用会话；已停止任务只解除暂停，不自动续接。原生输入新 lease 重新建立鼠标基准。Electron 提示层暂停时隐藏复用，断连/退出销毁；加载完成时再次检查活动状态，加载失败明确提示。

繁體：接管標記相容舊純文字並加入結構化原因；原因及工具受阻狀態由宿主提供，介面只顯示。恢復核對佔用對話，已停止任務不自動續接；新 lease 重設滑鼠基準，提示層暫停時隱藏重用、斷線時銷毀。

English: Pause markers add structured reasons while retaining legacy text compatibility. Host-owned outcomes are presented through Harness/ACP without changing completion authority. Resume checks the displayed owner and never restarts cancelled work. A new lease resets the pointer baseline. Overlays are hidden and reused on pause, disposed on disconnect, and checked again after loading.

用户批准完整控制提示方案。Harness 实际工具开始与 prompt 结束驱动仅实时的内部 `desktop_control` 展示事件；Electron 只投影顶部提示，不从自然语言或历史回放判断正在控制。Esc 复用 `session/cancel`，附当前 prompt token；Compat 校验 token 与现有活动轮次一致后交给 Harness 取消，延迟消息不得取消新轮次。展示事件、动画和 token 不持久化、不新增 MCP 工具、不改变审批权限。传输断开、渲染器关闭或任务结束清理展示。

原生 Go/PowerShell/C# 层只绘制鼠标微光和短暂余光，既有目标校验、输入派发和 after-state 仍为执行事实。动画不阻塞动作、不抢前台、不消费点击。按用户确认，每块显示器拥有独立的 Electron 静态透明表面，顶部提示固定、边缘保持淡蓝微光；仅状态与显示器配置事件更新，不轮询鼠标、不逐帧重绘整屏。原生鼠标动画仍限于小窗口。用户明确选择保留当前模型思考设置，优化仅减少重复发现、重复观察和不必要的叙述。

繁體：Harness 的實際工具開始及 prompt 結束驅動即時提示，Electron 僅負責顯示。Esc 沿用 session/cancel 並核對當前輪次 token；舊取消不影響新輪次。原生層繪製微光與餘光，維持既有審批、輸入及觀察合同，不新增公開工具或持久化狀態，保留使用者模型思考設定。

English: Harness tool dispatch and prompt settlement own live control presentation. Electron only renders it; Escape uses session/cancel with the current prompt token, checked before native cancellation. Stale cancellation cannot affect a replacement turn. Native control renders pointer glow and afterglow without blocking input. Existing approvals, execution evidence and model reasoning preferences remain unchanged; no public MCP tool or persisted state is added.

同一 MCP 连接复用一个 Windows PowerShell 桥接进程，仅复用代码初始化，每次重新获取窗口／UIA／截图；窗口快照和元素索引继续由原有服务管理。桥接中断使本次动作结果未知，不自动重放，下一次显式观察可重新启动桥接。模型成功加载内置 computer-use 技能后，适配层从当前受限工具注册表展示入口工具，不启用关闭的扩展、不授予输入权限、不解析用户文本裁决意图。

繁體：既有 MCP 增加本機文檔／資料夾開啟入口；Harness 仍持有審批，橋接僅重用初始化，動作結果未知時不重放。English: The existing MCP opens explicit local documents/folders; Harness retains approval ownership. The bridge reuses initialization, not observations, and never replays an uncertain action.


### 2026-10-28 用户澄清：Esc 仅打断电脑控制，任务继续

Esc 不取消 Harness 轮次、模型请求或非桌面工具，不强制插入任务结束提示。原生输入先隔离桌面动作；DesktopCoordinator 根据结构化 escape 原因禁止本轮继续派发电脑工具，重复调用立即返回 desktopOutcome=stopped，不进入等待恢复的循环。工具回执仅显示电脑控制已停止；不把它提升为任务取消或完成。已派发动作可能部分完成，用户显式新消息允许重新控制后先观察核对。轮次 token 和桌面 lease 仍决定影响对象，旧通知不影响替代轮次。普通停止按钮仍通过 Harness 取消整个任务。

繁體：Esc 僅打斷電腦控制，保留模型思考與獨立非桌面工具；重複電腦呼叫立即回傳 stopped，不等待恢復，也不強制結束任務。顯式新訊息後重新觀察，不重播未知動作。

English: Escape interrupts computer control only, preserving reasoning and independent tools. Repeated desktop calls return stopped immediately rather than waiting for resume. No task-cancel terminal is generated. A new explicit message permits fresh observation without replaying uncertain actions. Harness retains whole-task cancellation authority for the normal Stop button.


### 2026-10-28 用户要求补充：反复打断与多对话桌面仲裁

正常电脑操作继续由 DesktopCoordinator 独占租约和串行队列管理，Harness 持有任务执行权。Esc 撤回当前所有已排队的电脑提案，其他工具继续；原生动作清理完即可释放租约，不必等待整个任务结束。共享暂停标记仍阻止其他旧轮次自动接管。只有已接纳的用户新消息重新允许对应 token；恢复不得重置其他轮次的停止状态。复用共享 epoch 识别其他进程错过的中断，旧轮次也要等待新的用户输入。已派发动作结果未知时先观察核对，不重放。无全局暂停／恢复条，无强制任务结束提示。

繁體：正常操作依租約串行排隊。Esc 讓既有電腦提案退出，非桌面工作繼續；清理完即釋放租約。僅新訊息的對應 token 可再次控制，其他舊輪次保持停止，共享 epoch 防止跨程序漏看中斷。

English: Desktop leases serialize normal operations. Escape withdraws existing desktop proposals while other work continues, and releases the lease after native cleanup. Only the admitted new message's token regains desktop access. Other interrupted turns remain stopped; the shared epoch prevents missed interruption across processes. No global resume UI or forced task-end notice is added.

电脑工具审批使用 DesktopCoordinator 的局部取消信号：Esc 只撤回电脑审批，Harness 记录工具停止结果并继续任务；文件等其他审批仍使用原任务信号。RPC 的通用 AbortError 由局部适配还原成结构化 desktopOutcome，不提升为任务取消。繁體：局部訊號僅撤回電腦審批，保留任務與其他審批。English: A desktop-local abort signal withdraws only desktop approvals; Harness retains task and other approval lifetimes. Transport AbortError is mapped back to the structured desktop outcome.

前端排队消息保存入队时的桌面 generation，自动发送通过 ACP 可选元数据 codebuddy/desktop-generation 透传。DesktopCoordinator 比较共享中断版本，旧排队消息仅限制电脑工具，独立任务继续；显式“立即发送”重新取当前版本。generation 不构成工具授权，原审批仍生效。共享 epoch 在 Esc 时持久化，暂停标记清理后仍有效。旧队列缺少字段按空版本处理，不删除数据；旧客户端缺少元数据维持原行为，因此升级验收需配套桌面与运行时。繁體：入隊版本隨訊息保存，舊訊息不因自動發送取得新的電腦控制權。English: Queued inputs retain the desktop generation captured at enqueue time; automatic delivery cannot renew a revoked desktop episode. The optional ACP metadata is a fence, not authorization. Legacy queues remain readable and conservative; older clients retain previous semantics and should be upgraded with the runtime.

### 2026-10-29 用户批准：连续三次输入冲突退出本轮电脑控制

原生 C#/PowerShell 判定输入冲突，Go 在 MCP 可选 desktop_control 回执中输出 schema_version=1 与 outcome=input_conflict/action_completed；Harness 适配层按调用透传，包括错误回执，不解析自然语言。DesktopCoordinator 独占计数：每个冲突回执加一（含仅刷新画面而未输入），实际动作成功回执清零；观察、排队及其他错误不清零也不计冲突。第三次复用共享 epoch 隔离本轮及既有排队的电脑请求，清理后释放租约；Harness 任务和非桌面工作继续。不新增恢复提示，不重放旧动作。新用户输入只允许对应 token 开启新轮次；旧排队消息保留原 generation。旧原生客户端缺少字段时不推测冲突，需配套新版工具验收。

繁體：原生層提供版本化結構回執，Harness 逐次透傳，DesktopCoordinator 累計三次輸入衝突後撤回本輪及既有排隊電腦請求。成功輸入才清零，觀察不清零。任務與非桌面工作繼續，無恢復提示、不重播；新訊息只重新允許對應 token，舊客戶端不從文字推測狀態。

English: Native code owns input-conflict facts, supplied through optional version-1 desktop_control MCP receipts and preserved by Harness even on errors. DesktopCoordinator counts once per receipt, including refresh-only outcomes; successful input resets the streak, observations and unrelated failures do not. Three conflicts fence the episode and previously queued desktop requests via the shared epoch, then release the lease after cleanup. Harness and independent tools continue. No resume UI or automatic replay is added. New input renews only its own token; legacy clients without receipts are not classified from prose and require a matched tool upgrade.

### 2026-10-30 已批准：当前聊天自动任务暂停与继续

原生 DSH Schedule 继续独占定时器、任务表、同一串行管理/投递队列、会话绑定和投递历史。CodeBuddy 对锁定 0.2.1-alpha.2 的内存加载扩展新增 `paused` 状态和 CAS 暂停/恢复操作；不引入 MichengAI 调度器、不删除重建任务、不复制任务状态。按钮与 `schedule_pause` / `schedule_resume` 共用此入口，`schedule_status` 只读本根聊天的任务；不额外增加批准弹窗，不授予文件、网络或子 Agent 权限。暂停仅阻止尚未进入原生投递的次数，已经投递到 Inbox 或开始运行的任务不取消。恢复保留原周期/时区并跳过已错过的次数；已过期的一次性任务结束且不补发。暂停任务保留 ID、历史及会话绑定，可编辑但不自动恢复；归档会话时暂停任务同样纳入原生停止处理。

现有 active/inactive 数据无需迁移。暂停状态使用同一任务表；不支持把含 paused 行的数据交给未扩展的旧版本（旧版严格解码会拒绝，不会暗中执行）。回滚前先恢复/结束或明确删除所有暂停任务，并保留原数据备份。升级 DSH 时版本与源码哈希门禁要求重审本扩展；上游提供等价暂停接口后删除本扩展，不能静默混用。兼容层只传输实际回执，前端只展示提交后的状态。测试通过不等同真实桌面验收。
