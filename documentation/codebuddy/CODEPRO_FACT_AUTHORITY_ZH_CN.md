
# CodePro 事实权威与模块职责

## 2026-10-18 已批准：默认子 Agent 模板与聊天内职责复用

全局 `config.subagentTemplates` 仅保存 explorer、browser 和通用职责的默认模型选择（未指定则由 DSH 在创建时继承父 Agent 的实际模型）。设置入口经已有 ACP config API 校验并保存，不存储子会话 id、历史或凭据，也不恢复旧五角色路由。explorer/browser 是两个按需实例化的默认模板，不预启动、不占用并发名额；其他职责经通用 `subagent.role` 声明，仅在当前主聊天中创建和继续。

CodeBuddy 适配层把模板、职责、已配置模型转换成 DSH 公开 `SubagentService.startActivation` 的 persona、toolFilter 与 agentOptions；默认 explorer 收窄原生文件/命令工具，browser 使用当前已启用的浏览器/网页能力。宿主现有权限检查和能力停用边界保持优先。原生描述符持有实际 persona、模型、直系归属和历史，后续使用原生 send_message 继续，冷恢复不重新按新设置改写旧实例。主模型负责按语义选择职责与是否复用；不通过名称、关键词或月份作第二次宿主业务裁决。

相同模板在不同主聊天中创建独立原生子会话，配置可共用，聊天历史不共享。浏览器 cookie、标签页与账号资源的隔离不由聊天上下文隔离推导。活跃轮次沿用本轮已准备的模型配置，下一轮准备后用于新建实例；已有实例不热切换。冷恢复只重建与原生描述符路由完全匹配的现有连接，无法匹配时明确拒绝，不偷换模型或实例。连接删除时提示修正该新建请求，不替换成另一模型。并发上限仍由 DSH Host 持有，不是每轮创建配额。

## 2026-10-17 已批准：会话内单工具授权

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

## 2026-10-16 同事分支合并：原生子 Agent 与只读投影

本次按用户要求合并 `codex/dsh-frontend-ux`。当前会话选择的模型和思考强度是实际请求来源；原生子 Agent 继承父 Agent 的实际模型与强度，旧角色路由配置保留可读但不再覆盖执行选择。Host 的子 Agent 插件限制为同时 3 个、深度 1；旧配置中的角色并发值不修改原生 Host。此条覆盖下方历史角色路由执行约定，不删除保存的配置或历史。

子 Agent 状态、目录和对话由原生记录持有；适配层验证归属路径并投影只读视图。文件变更面板仅展示已保存的工具回执，不宣称覆盖 shell/MCP/子 Agent 的全部修改。取消完成与请求释放分开处理，队列只在已有请求释放后继续；不从显示文案判定完成。工具权限先绑定远端组合再施加筛选，工具 schema 仍按需发现，保留本地主分支的 MCP 复用与异步任务适配。

繁體：子 Agent 繼承父模型與強度，原生 Host 限制為 3 個並行、深度 1；舊路由仍可讀但不介入執行。目錄、對話及變更僅投影已保存事實，取消後須等請求釋放，權限與按需工具發現保持。

English: native children inherit the parent's actual model and effort; the Host admits three concurrent children at depth one. Saved legacy role routes remain readable but do not override execution. Catalogs, transcripts and change views project durable facts. Queues wait for request release after cancellation; permission filtering and deferred tool discovery remain intact.

## 2026-10-16 修复：GitHub 账户设置沿用官方 CLI

GitHub 账户授权、登录和凭据继续由现有 GitHub CLI 负责，Electron IPC 仅提供受限状态/设备流程/登出适配；移除旧 Rust OAuth 卡片调用，不恢复旧核心。`gh auth status` 的结构化验证结果是账户事实来源，MCP 独立连接配置不由账户卡片自动修改。Harness Agent 的执行、审批、完成所有权不变。见[修复验收](../../docs/reconstruction/2026-10-16-github-account-fix.zh-CN.md)。

繁體：帳戶由官方 CLI 驗證和管理，MCP 連線獨立，移除舊 OAuth 呼叫。English: the existing official CLI owns account authentication; MCP configuration remains independent and retired OAuth UI calls are removed.

## 2026-10-16 已批准：移除旧 Office 编辑工具并合并工具箱入口

用户批准将旧 DOCX/XLSX 能力迁移到现有 Harness `dsh-skill-office`、`dsh-tool-workspace-dependencies` 和原生 shell。Rust 的 `docx_tool`、`xlsx_tool` 注册、实现及专属依赖删除，不新增同名 Python 编辑服务。工具箱按注册技能身份将 Word、Excel、PowerPoint 归入 Office 文档组，技能详情及覆盖顺序仍由原注册表决定。`computercontroller` 的配置键保持，以兼容现有启用状态及保留的 PDF、网页保存、缓存；不迁移权限、不改写旧对话工具回执、不重放历史动作。已完成的历史可查看，恢复后的调用使用当前工具清单；硬编码旧工具名称的外部配方需按迁移文档修改。

公网文本读取优先复用上游 `web_fetch`；锁定版本不提供等价的二进制保存和私网抓取，旧 `web_scrape` 暂保留这些独有用途。外部 MCP 配置与凭据保留，安全 MCP 本批按用户要求不测试。迁移边界与同事合并步骤见 [Office 工具合并记录](../../docs/reconstruction/2026-10-16-office-consolidation.zh-CN.md)。

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

压缩中进程退出后，只有不存在活跃操作的历史加载才核对原生 `compaction/end`：有结束记录就恢复其结果，没有则仅将显示投影置为“中断、结果未确认”，不写入 Harness 完成事实、不改原始日志，也不重放摘要请求。繁體：重啟僅核對原生結束記錄，缺失時清除失效進度但不宣告完成。 English: idle replay reconciles missing notifications with durable Harness end events; absent evidence clears a dead spinner as interrupted/unconfirmed, without changing native history or replaying work.

本日夜间补充：上下文计量、压缩范围、摘要事务与重试归官方 `tokenMeter` / `compaction-basic`；`runtime/context-updates.mjs` 只转换现有 UI 通知，当前占用不得与累计账单混同。压缩不等于长期记忆，摘要不证明需求无损；多次压缩后的独立验收另留证。MCP 截图按实际执行 Agent 的图像能力原生准入，缺能力时复用 `VisionRouting` 的零工具辅助观察；原始工具回执归 MCP，视觉失败不得重放已执行动作。

锁定版本的已知压缩缺陷适配：`runtime/harness/compaction.mjs` 继承官方引擎，在普通压力路径仅略过官方已选中的单个 `compact-checkpoint`，避免无新增事实时反复摘要；不重新选区，不拦截手动压缩或超限恢复。升级官方依赖时复查并在官方修复后撤除此补丁。回归与实际证据见[夜间跟踪](../../docs/reconstruction/overnight-acceptance.zh-CN.md)。

**繁體補充**：上下文計量及壓縮由 Harness 持有，CodeBuddy 只投影現有通知。摘要不是無損記憶；反覆壓縮另驗。MCP 圖片優先交實際執行模型，缺能力時輔助視覺只觀察，保留原始回執且不重放動作。

**English addition:** Harness owns context metering and compaction transactions; CodeBuddy only projects existing notifications. Summaries are not lossless memory, so repeated compaction requires independent acceptance. MCP images use the executing model's native capability first, then a tool-free visual observer when configured. Original receipts remain authoritative; observation failures never replay actions.

**繁體補丁界線**：薄子類只延後普通壓力下的單一既有 checkpoint；不另選範圍，不攔截手動或超限恢復，官方修復後撤除。 **English patch boundary:** the thin subclass defers only an upstream-selected singleton checkpoint under normal pressure. Manual and overflow recovery remain unchanged; remove this guard after an upstream fix.

本日追加的远程 MCP 复用授权：长期组合、作用域租约、修订保留和回收由官方 `agent-preset-registry` / `dsh-scope` 持有；CodeBuddy 仅按完整配置选择组合、投影状态和维持每会话权限/Apps 适配。stdio 保留工作目录与会话边界。详见[复用验收](../../docs/reconstruction/2026-10-14-mcp-reuse.zh-CN.md)。

**繁體補充**：遠端 MCP 長期組合、作用域租約及修訂回收由 Harness 持有；CodeBuddy 選擇設定組合並維持每會話權限與 Apps 適配。stdio 保留工作目錄與會話邊界。

**English addition:** Harness owns standing remote MCP compositions, scope leases and revision retention/collection. CodeBuddy selects the configuration and retains per-session permissions and Apps adaptation. Stdio retains its workspace/session boundary.

适用范围仅为 `D:\CodeBuddy-v1` 新版运行时。用户基于普通问候正常结束却被新版门禁标为中断的真实会话，批准将执行、调度及完成生命周期交官方 Harness，CodeBuddy 保留必要适配，并允许前端为原生后端调整。此修订覆盖本目录旧表中关于新版自造计划/调度/完成门禁的职责，不改写原 Rust 产品或旧历史事实。

官方 Session Controller / AgentLoop / subagent 负责执行；goal/tool-goal/goal-round-driver 负责目标、自动续轮、CAS 与进程内激活；todo/write 仅为当前轮清单，turn/start 清空。CodeBuddy 的 codepro 只投影原生状态、实际工具回执及 UI 控制引用，不再注入 codebuddy_task，也不要求模型提交第二套计划或证据 ID。harness_turn 仅表示一轮结束；harness_goal 仅表示原生目标已完成；两者都不等于独立测试通过。原工具效果、未知副作用及旧事件前缀保留，恢复不自动重放。

**繁體修訂摘要**：此修訂僅適用新版執行時。官方 Harness 擁有執行、排程、目標與續輪；CodeBuddy 只做投影及必要權限/設定適配。原生完成不替代真實測試證據，舊歷史及未知效果保留。

**English revision summary:** This revision applies only to the new Harness runtime. Official Harness owns execution, scheduling, goals and continuation; CodeBuddy adapts presentation, permissions and settings. Native completion is distinct from independently verified tests. Historical events and uncertain effects remain intact.

实施、替代方案、锁定版本/许可证与验证边界：[简体中文](../../docs/reconstruction/2026-10-14-harness-authority.zh-CN.md) · [繁體中文](../../docs/reconstruction/2026-10-14-harness-authority.zh-TW.md) · [English](../../docs/reconstruction/2026-10-14-harness-authority.en.md)。当前仅自动夹具已验，最终产品证据单独记录，不由权威地图宣布产品通过。

## 2026-10-12 已批准：常用只读查询与每轮时间

新版接线：runtime store 仍持有查询设置；独立 commonqueries MCP 每次消费宿主生成的请求元数据，不持有第二份设置。Harness 主导调用、审批及完成，原 Rust 查询实现只提供结构化工具回执。繁體：設定由 runtime store 持有，每次經宿主 MCP 中繼資料傳入，無設定副本。 English: the runtime store owns query settings; host MCP metadata carries them per call, with no mirrored state. 详见[接线边界与验收](../../docs/reconstruction/2026-10-15-common-queries.zh-CN.md)。

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
