# 首版功能接入与验收矩阵

最新上下文真实UI：4次成功自动压缩、用量/进度更新、重启后事实正确保留；阈值边界已修，相关53/53。 [详情 / Details](2026-10-15-context-ui.zh-CN.md)。

最终真实复验：当前组合修复的独立预览 runtime20864 中，参数表单等待316.149秒后提交并信任执行，成功创建会话 `cb3b1a34-46f4-4e33-ad2e-3d727412d473`。Kimi准确返回 `FORM_81b69bca-b127-48b9-9c9c-be8a88cdb5d1`，26个消息增量、零工具；Harness原生 `completed/harness_turn`，持久化参数与界面一致。第一次323.508秒租约过期仍保留为失败对照。 安装包静态边界：`forge.config.ts`仍打包旧Rust后端资源，`main.ts`无外部后端时仍启动`startGooseServe`。Harness资源与启动接线尚未完成；本次是`start-preview.ps1`开发预览，非安装包交付。

最新后端367/367、相关前端99/99、Node24子集45/45，均exit0。见 [recipe parameters](2026-10-15-recipe-parameters.zh-CN.md)。

最新附件补验：窄布局附件入口、识图能力设置、执行前路径展示已修复；真实Kimi图片/中文文件/修正/重载四轮通过，另验拒绝分支。前端112/112，后端未改复用360/360。见[附件专题](2026-10-15-attachments.zh-CN.md)。拒绝操作顶部汇总误报已修复并真实重载复验。

最新补充：时间与天气三工具已接入Harness，真实Kimi/设置即时生效/连接复用/工具箱/历史已验；当前后端全集360/360。见[本批查询验收](2026-10-15-common-queries.zh-CN.md)。其他条目的范围限制保留。

最新夜间证据见[验收跟踪](overnight-acceptance.zh-CN.md)：全集357项、真实模型十二模块31次成功压缩、中文MCP配置保存及两会话连接复用/工具箱计数。下方较旧条目以跟踪文档的新证据为准。

**本批最新验收：[Harness 主导执行验收记录](2026-10-14-harness-acceptance.zh-CN.md)。** 已补入真实模型流式对话、六模块 33/33 停止/后端重启/同 run 续作及真实 Electron 两轮聊天；最终全集、受控桌面恢复和交付启动见报告独立栏。下方旧预览回执保留原有范围，286 项不计为本次替换的全套通过。

审计日期：2026-10-14。对象为 `D:\CodeBuddy-v1` 当前文件，原项目 revision 为 `964bbeb1587f1c5551ee17907e0b26632c4163ce`，含未提交文件的复制清单见 [source-baseline.json](source-baseline.json)。目标目录未初始化 Git；本批没有分支、提交或推送。原 renderer 布局和交互保持，允许的 Electron 启动、桥接、打包配置另列。最新页面不等于全部接口已接通。

**I** 已实现；**P** 部分实现；**N** 待接。**A** 自动化隔离夹具；**R** 实际配置模型的 ACP 验收；**U** 真实 Electron 用户流程；**T** 实际内置 MCP 工具调用；**D** 此行完整桌面流程待验。证据仅覆盖实际场景，均未包含 macOS、发布安装包或持续高负载。

**2026-10-14 后续权威修订**：执行、调度、目标完成转由官方 Harness goal/todo/subagent 主导；CodeBuddy 仅适配展示、权限与设置。用户已允许前端为原生后端调整。下面标有新权威的行以[本次实施记录](2026-10-14-harness-authority.zh-CN.md)为准；此前真实模型/桌面回执保留为历史证据，不证明这次替换已经通过同样产品验收。

## 基础任务与工具

| 功能 | 实现及事实 owner | 状态 / 证据 | 边界 |
|---|---|---|---|
| 默认工作区、项目选择 | Electron 默认容器 + `workspaces.mjs` 目录身份及租约 | I / A、U | Windows 为 `D:\CodeBuddy-Workspace`，每新任务独立子目录；显式项目保留。其他平台待实机 |
| 对话、流式输出、取消、历史加载 | `compat.mjs` → 官方 Harness Session Controller / AgentLoop / JSONL | I / A、U | 实际 Kimi 对话及 CodePro 小项目通过；其他服务逐项验 |
| 目标、清单、暂停恢复、重启续作 | 官方 goal/tool-goal/goal-round-driver + todo；`codepro.mjs` 只投影 | I / A、D | 新官方 ACP 夹具跨模块、原生自动续轮、取消/重启/同 run 续作通过；旧文件 mtime/内容保持，真实命令与独立测试退出 0。新版本真实模型/桌面、小时级及大型仓库待验；todo 是当前轮快照，不伪造 DAG |
| 角色模型、多 Agent | 官方 subagent 调度；CodeBuddy 只选 planner/coder/tester/reviewer 模型 | I / A、D | 新 HTTP 夹具验证官方总并发上限跨角色生效、双 coder 写入、reviewer 独立模型与真实跨模块测试；不再保留第二个 coder 调度门禁。云端质量及完整桌面待验 |
| 工具回执、崩溃恢复 | 原生工具结构化结果、Harness JSONL + transcript/UI 投影 | I / A | 真 exitCode，未知效果保留但允许先检查；不会自动重放旧调用。正常轮次/目标完成分别为 harness_turn/harness_goal，均不替代独立测试通过证据 |
| 文件、搜索、PowerShell、后台任务 | 官方 fs/shell/jobs，developer 开关参与工具限制 | I / A、R、U | 重启不复活 OS 进程；目录验证不是系统沙箱 |
| MCP 配置、测试、调用、资源 | settings / session-extensions + 单连接 MCP SDK 桥 + 官方工具定义 | I / A、D | stdio、streamable-http；失败可见；实际 stdio 关闭重连、活跃会话资源读取、取消和权限隔离已验 |
| 工具审批 | 宿主唯一审批入口；主子 Agent 同权限边界 | I / A、D | chat 禁动作，auto/approve 生效；smart_approve 保留询问，不宣称独立自动批准器 |
| 内置电脑控制、可视化 | 旧独立 computercontroller / qwen_computer / autovisualiser MCP 适配 | I / A、T、D | 22 个工具发现；实际 5 次 list_apps/docx/cache/render_mermaid 调用通过。鼠标键盘操作、全工具及 macOS 待验；二进制未重新构建证明源码一致 |
| 技能、显式技能调用、远程下载 | 官方 filesystem skill provider + library / skill-download | I / A、D | 本地 CRUD/启停/恢复；HTTPS SKILL.md、固定 commit GitHub tree 与 blob 校验、预览后完整发布；真实外网/桌面未验 |
| 常用任务 / 配方 | library + recipe-execution，统一 Harness 会话 | P / A、R、U；高级 D | 参数表单、模板、模型温度、max_turns 与扩展已接；HTTP envs 实际解析 URL/header 并保护凭据；retry/sub_recipes/response.json_schema 在保存/执行前明确拒绝，保留旧资料可读 |
| 自动任务 | `schedules.mjs`，官方 cron/时区 | I / A、D | 默认暂停、成功立即运行才允许启用；失败和重启暂停，不补跑；非零秒/七字段 cron 待接 |
| 图片与文件附件 | 官方 image admission / 本地文件读取 / upload receipt | I / A、D、真实模型 | 主Kimi图片、原生中文文件选择、批准读取、四轮修正与重载已验；既有辅助视觉专项复用；上传副本回执及其他模型质量不由本次证明 |

## 设置

| 页面 | 已接行为 | 状态 / 证据 | 边界 |
|---|---|---|---|
| 通用、快捷键 | 原 Electron 外观、语言、通知、输入偏好和快捷键保存 | I / D | 系统冲突、所有开关、重启及打包更新入口待逐项桌面验 |
| 模型与运行环境 | 自定义 OpenAI 兼容/Ollama，发现验证、保护凭据、默认模型、角色路由、模型能力配置 | P / A、U | reasoningEfforts/contextWindow/maxTokens/compat 映射生效；六种 effort 有 HTTP 验证。未知能力不伪造；独立 visionRoute 已有只读辅助描述与取消/重启验证；OAuth 待接 |
| 行为与回答 | 模式、maxTurns、压缩阈值、提示模板、全局及项目 AGENTS.md | I / A、D | 使用官方 instructions/compaction；模型能力须匹配设置 |
| 记忆 | 项目开关、审核、CRUD、过期、导出、工具调用、已批准记录召回 | I / A、D | 复用 Harness storage-domain/storage-json，非上游专门 memory provider。个性化开关控制原主模型主动提议候选；关闭仍接受用户明确 retain。候选须 UI 审核；无跨项目画像；本地字词检索 |
| 工具与连接、账号凭据 | MCP CRUD、保护存储、API key 编辑/删除；原外部 ACP 设置 | P / A、D | 外部 ACP 服务逐项验；provider OAuth、GitHub 登录待接 |
| 输入 / 语音 | dictation 配置、凭据、取消及 OpenAI/Groq/ElevenLabs 转写请求 | P / A、D | 7 个真实 HTTP 夹具；真实麦克风、云端服务未验；本地 ASR 及下载待接 |
| 安全与权限 | 显式开启的专用分类器实际消费，接在 always_allow 前 | I / A、D | 7 项分类测试及审批集成；未配置、错误、覆盖不足明确本次询问。只按开启配置发送所需上下文，无关键词替代分类、无未检测即安全 |

## 历史与保留入口

| 功能 | 状态 / 实现 | 证据及剩余范围 |
|---|---|---|
| 搜索、重命名、归档、删除 | I / compat + 原 ACP 适配 | 真实 Electron 搜索/改名/归档/重载/恢复、删除取消保留及确认删除通过，持久化一致；漏传 includeArchived 导致归档列表为空已修。32 项组件/ACP 回归与 TS/lint 通过；批量操作仍待验 |
| JSON 导出/文件导入 | I / history + 只读投影 | 真实 Electron 导出、Kimi 操作 Windows 保存/打开对话框、独立核对4条原消息及随机标记、导入重载通过；只读事实漏投影已修，输入/编辑/重试/工作区入口关闭，无旧执行或凭据继承 |
| 工作区文件、终端、内置浏览器 | I / 原 Electron 面板 | 36项自动基线；真实中文文件预览/保存、外部冲突保留草稿与磁盘、重载确认；终端cwd与落盘、Ctrl+C和关闭确认；本机页面链接/后退/前进及原生窗口像素已验。远程站点、安装包与macOS待验 |
| 旧资料迁移 | I / legacy-migration | 实际落地 616 会话元数据及完整 SQLite 归档、1 暂停日程、3 条现存项目记忆写入官方 storage；11 条来自已删除目录的记忆完整归档。真实 Electron 打开旧 51 消息历史且 Kimi 配置不变；空历史导入保护已修，最终重启后 616 条全部保留，见 [实际界面回执](../../.preview-evidence/migrated-history-ui.json) |
| 项目源、Agent 模板 | I / workspaces、library | 文件 CRUD、导入导出、范围验证；无第二模型循环 |
| 普通聊天工作目录切换 | I / 官方 fork + working-directory | 产品 ID 稳定、原日志保留、新 sandbox 根/MCP cwd/记忆 scope 同步，原 renderer/ACP 及重启验证；活动、只读、CodePro 会话拒绝切换。实际 Electron 选择器和 macOS 待验 |
| Git 面板 | P / git-extension | 8 个只读、6 个本地写工具；新增 restore preview/confirm 复用旧界面合同，完整 diff 与索引绑定过期校验。23/23 相关自动测试；真实 Electron 暂存、无 HEAD 取消暂存、预览后变化拒绝及重新预览还原已通过，暂存内容与无关文件保留。冲突继续/中止、pull/push/preflight、外部 filter/签名及 macOS 待接或待验 |
| Review | I / codepro-review + 官方独立 Harness session | snapshot/start/get/cancel；真实 Electron + Kimi 在隔离样本准确指出 a+b 被改成 a-b 的行号与问题，文件/索引不变；不代表所有审查质量。证据见 overnight-acceptance.zh-CN.md |
| GitHub issues/PR/CI/登录 | N | 待接；未执行外部写入 |
| MCP miniapps | I / mcp-apps、单连接桥、隔离代理 | 自动合同及真实Electron+Kimi：打开、guest握手、按钮调用/审批/拒绝、全屏/画中画保状态、展开历史恢复通过。直接UI调用聊天历史缺口已用现有journal修复并实测；多应用/外部网络/复杂交互另验 |
| 编辑、重试、普通会话分叉 | I / conversation-editing + 官方 immutable fork | 原地编辑 A→B、真实模型回复 B、重试及重载持久化已验；产品 ID 稳定、原生 fork 留痕。旧 run/文件副作用保留；普通分叉所有桌面路径仍待验 |
| Nostr 分享导入 | N | 显式未接；CodePro 原 UI 禁 fork 保留 |
| 本地推理下载、内置厂商目录 | N | 保留 secondary/legacy 入口，原第一方模型“开发中”；未作为已交付功能 |

## 既有预览证据（2026-10-14，本次权威替换前）

- [此前预览集中回归](../../.preview-evidence/foundations-all-tests-final.log)：当时 runtime/tests、runtime/harness/test 和 scripts 测试串行完整运行，286/286，通过、失败 0、取消 0、跳过 0，退出码 0。包含该次配方参数与会话生命周期修复；不是本次 Harness 权威替换后的全集。旧子集计数不再相加。

- [真实 Electron CodePro](../../.preview-evidence/real-codepro-ui.json)：Kimi-k3、默认目录、原生文件/测试工具，独立 3/3 测试退出 0；仅该小项目用户流程。
- [真实模型多模块 ACP](../../.preview-evidence/real-codepro-latest.json)：money/invoice、4 次文件写入、原生测试退出 0，独立 8/8；主 Agent 顺序执行，约 108 秒，不等同长时间大项目或真实重启验收。
- [真实 Kimi 重启续作](2026-10-14-real-codepro-resume.zh-CN.md)：首个模块完成后 pause_run，关闭并新建服务器、重新 lease/load、resume_run 同 runId；233 秒内完成，独立 15/15、原文件哈希/mtime 不变、原回执唯一，无 pending/uncertain effects。不是 Electron 重启或强杀进程验收。
- [实际 Electron 停止与重启继续](2026-10-14-electron-resume.zh-CN.md)：原界面可见控件、受控 HTTP 模型、同 run、真实工具、独立 3/3，pageErrors/consoleErrors 为空，两轮进程全部回收；与真实 Kimi ACP 验收分开。
- [内置工具实际调用](../../.preview-evidence/builtin-execution-latest.json)：5 次真实调用通过；不等同物理桌面控制。
- [前端基础测试](../../.preview-evidence/frontend-foundations-tests.log)：10 文件 / 80 测试通过。自动测试不替代各设置页面的用户操作。
- 自动化子集分别通过：MCP 桥/资源/应用/原 capabilities/内置发现 30；Git 只读/本地写/Review 19 及真实 ACP Git 写入 1；普通聊天目录/Harness/MCP 组合 14；技能下载与 library 19；library ACP 4；语音 7；visionRoute 11；legacy 10；会话编辑 6 与 ACP 1。子集可能重叠，禁止相加为独立全套总数；集中运行以最终主任务日志为准。
- 其他既有通过记录：Harness driver/capabilities、记忆 6、safety 7、journal 4（含真实 SIGKILL 与残尾）、history 4、workspace/launcher 14、recipe 7、schedule 8、roles/CodePro 组合。设置 runtime 9 项包含生效参数与故障询问；以各测试与专题记录界定覆盖。

用户要求的全部前端功能仍为最终目标。剩余 Git 远端/冲突操作、GitHub 账号/PR/CI、Nostr、本地 ASR、复杂配方、OAuth，以及尚未执行的桌面完整流程、真实长时间项目、macOS 和安装包验收必须保留。真实旧 profile 已实际迁入；最终重启已核实完整保留 616 条，历史 dry-run 不作为该事实依据。

参考：[官方 Harness](https://github.com/deepseek-ai/deepseek-harness)（精确锁定 0.2.1-alpha.2，MIT，developer preview）；[默认目录](2026-10-14-default-workspace.zh-CN.md)；[配方与日程](2026-10-14-library-schedules.zh-CN.md)；[会话编辑](2026-10-14-conversation-editing.zh-CN.md)；[远程技能](2026-10-14-skill-download.zh-CN.md)；[旧数据迁移](2026-10-14-legacy-migration.zh-CN.md)。
