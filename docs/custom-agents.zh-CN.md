# 自定义智能体

## 当前会话级用法（2026-11-03）

打开“自定义智能体”，可新建角色，也可直接使用六个默认模板：高级开发工程师、前端开发工程师、UI 设计师、产品经理、数据分析师、内容创作专家。“立即使用”直接选用只读模板，不保存重复副本；“自定义”进入属性表单，保存时才生成自己的独立配置。两类卡片保持一致的结构与紧凑底栏；默认模板右侧为“自定义”，我的智能体右侧为编辑、复制和删除。

默认模板沿用对话的模型与能力。编辑时可调整名称、头像、人设及“配套技能”；新增角色不要求逐项选择底层工具或连接服务，配套技能作为可选补充。旧配置已有的能力限制保留在高级设置中，不会静默扩大。配套文档随应用提供，模型按任务读取；原生审批与会话权限仍有效。来源、固定版本、许可证和适配说明见 [配套技能说明](../runtime/harness/skills/agent-presets/README.md)。

智能体不配置推荐模型或绑定模型，统一在对话页选模型。旧模板的模型字段在读取、保存定义时忽略；已有聊天保留当前模型，旧工作区角色也可以独立切换模型，原工具与权限限制仍保留。

头像可选 40 个预设与应用 Logo。默认展示前 10 项，“更多头像”可展开；收起后保留当前选中项。也可点“上传图片”自定义头像，支持不超过 5 MB 的 PNG、JPEG、WebP，自动居中裁剪后保存；重新编辑仍保留已上传图片。

删除了尚未发送的角色后，输入框显示“智能体不可用”，可以重新选择或恢复默认助手，不会悄悄换角色。配套 Skill 真实读取失败时显示“上次加载失败，可重试”；重试成功后清除提示。该提示是最后一次加载结果，不表示启动时已经检查了全部资源。

未选角色时，输入框不显示角色占位，可从加号菜单的“自定义智能体”选用模板或新建。从已有聊天进入管理页时，“应用到当前对话”使用明确的来源会话并返回该聊天；从新任务页进入时，“立即使用”仅准备下一次发送，不创建会话或目录。编辑页提供“保存并应用”与“仅保存”；保存成功但应用失败会保留已保存的 ID，重试不会重复新建。已有聊天可切换或撤销主角色，保留模型、目录和历史，选择在下一次用户输入生效。主角色及其专属技能不自动传给子智能体。完整合同和验收状态见 [会话级实施计划](reconstruction/2026-11-03-custom-agents-session-plan.zh-CN.md)。

输入框只显示角色头像与名称，不常驻显示“下轮生效”或更新按钮；“应用更新”位于角色菜单。2026-11-04 菜单收紧：顶部搜索全部智能体，默认助手保留；最近选择的最多五个角色排在前面，同时保留默认模板，重复项合并。选中项使用灰底，不显示黑点或勾号。底部为“管理自定义智能体”。列表适当加高，超过窗口可用空间时滚动；去除“当前工作／后续消息”的文案，宿主实际生效规则不变。

以下保留旧工作区角色的使用与实施记录，仅适用于对应历史版本；旧会话需显式转换，原有权限限制继续保留。

## 旧工作区角色的需求与使用

左上角菜单 → **自定义智能体** → **新建智能体**。可选择应用 Logo、预设头像或上传图片，配置名称、已添加的模型、人设提示词、Skill、内置工具及已启用的 MCP 服务。语音显示未开放，本期没有语音存储或播报。

保存后点击 **创建工作区**，系统创建独立目录与 CodePro 会话并跳转。聊天展示角色头像与名称。能力默认不勾选；选择文件写入、命令等能力仍需遵守现有权限。编辑或删除模板只影响之后创建的工作区，旧工作区保留创建时的配置。

勾选 Skill 会开放其受限加载器，无需再次在工具中勾选。加载器只能读取所选 Skill，仍受全局工具权限约束。

## 设计与边界

- 模板及工作区快照由 `runtime/agent-profiles.mjs` 管理，复用现有 state.json 原子存储。模板有递增 revision，防止旧表单覆盖新修改。
- 选择方案：宿主角色配置＋既有工作区租约＋会话快照。未采用官方 Harness 内部改写或原生 agentPreset 作为持久身份，避免改变原生执行、压缩与工作目录 fork 合同。
- 模板删除保留绑定；普通工作区无需迁移。绑定按规范目录查询，并覆盖其子目录。新建会话不能用客户端参数覆盖固定模型或服务。已有会话的模型、人设和扩展修改接口拒绝修改角色配置。
- Skill 服务仅在上层继承公开 Registry，覆盖 list/snapshot/get。工具在宿主策略及原生 scoped guard 两处消费同一角色事实；子智能体沿用配置。全局禁用仍生效，不复制执行循环或权限系统。
- MCP 选择引用全局服务名称，不复制凭据。全局连接配置更新仍生效。头像支持 `app-logo`、预设 Emoji 和受限 PNG data URL，不接受远程 URL 或 SVG。上传入口位于头像列表末尾，以虚线框与加号呈现；应用 Logo 排第一且默认选中。用户可上传不超过 5 MB 的 PNG/JPEG/WebP，前端居中裁剪为 128×128 PNG 后保存，后端校验 PNG 标识、尺寸和编码大小（上限 256×256、256 KB）。旧 Emoji 配置继续兼容，无需迁移。
- Skill 白名单控制技能发现与加载，不阻止已授权文件/命令工具读取文件。模型对人设文字的遵循属于模型行为，不能承诺绝对遵循。
- 工作区默认在 `CODEBUDDY_WORKSPACE_ROOT` 或后端数据目录 `workspaces/agent-<UUID>` 下，创建失败只清理本次空目录租约与未提交绑定。

## 实施与验收

实现范围：菜单/路由、角色编辑页、聊天角色摘要、模板 CRUD、工作区绑定、会话固定配置、Skill 与工具限制、父子继承。未变更官方 Harness 包、Rust、依赖或构建环境。

测试覆盖：模板编辑并发冲突、删除后快照保留、重开与子目录继承、客户端模型/人设/MCP 覆盖拒绝、全局关闭交集、实际 Harness Skill 加载与本地注册工具阻断、实际父子模型请求配置、界面保存/错误/删除/导航以及浏览器响应式布局。浏览器测试使用真实组件与隔离传输夹具，不代表完整 Electron 产品 E2E。

全部来自 `D:\Projects\CodeBuddy-v1`，分支 main / revision `78f199aaa3d044d37f65b8dcf2889fcfe0e7960b` 加当前未提交改动。未提交、未推送；原有安装器、素材库等改动保留。

### 2026-10-29 验证记录

| 实际命令 | 最终结果 |
| --- | --- |
| `node --test runtime/tests/agent-profiles.test.mjs runtime/tests/agent-profile-harness.test.mjs` | exit 0，5 项通过，包括真实 Harness 父子请求；使用本地模型夹具，不调用线上模型 |
| `node --test runtime/tests/agent-profiles.test.mjs runtime/tests/session-extensions.test.mjs runtime/tests/session-lifecycle.test.mjs runtime/tests/harness-architecture.test.mjs` | 当时 exit 0，19 项通过，包含当时 2 项角色用例及 17 项既有回归；后续新增的回滚用例与角色最终修改已在上一行重测 |
| `npm.cmd --prefix ui/desktop run test:run -- src/components/custom-agents/CustomAgents.test.tsx src/components/Layout/NavigationPanel.test.tsx src/acp/__tests__/sessions.test.ts` | exit 0，39 项通过 |
| `npm.cmd --prefix ui/desktop run test-e2e -- custom-agents.browser.spec.ts` | exit 0，1 项浏览器夹具测试通过；浅色、深色、390px 窄屏截图已人工查看 |
| `npm.cmd --prefix ui/desktop run typecheck` | exit 0 |
| `npm.cmd --prefix ui/desktop run i18n:compile` | exit 0 |
| `git diff --check` | exit 0 |

过程中发现并修复：语言条目格式、模型选择框可访问名称、首次打开时不存在默认工作区目录，以及创建后回执失败时误解绑的风险。最初部分测试因沙箱禁止系统临时目录写入而失败，改为已授权的隔离测试执行后通过，没有安装依赖或更改构建环境。

**产品 E2E 未执行，安装包未构建。** 调用官方启动器导出的 `checkPreviewArtifacts(process.cwd())` 返回 exit 1：缺少 `runtime/tools/bin/codebuddy-tools.exe` 与 `qwen-computer-use.exe`，尚未启动后端或 Electron。没有绕过校验、借用旧二进制或宣称完整桌面验收通过。

浏览器截图位于 `ui/desktop/test-results/custom-agents.browser-crea-8bd66-y-desktop-and-narrow-layout/`。隔离测试日志位于忽略目录 `environment/custom-agents-policy-tests.log`、`environment/custom-agents-runtime-tests.log`。

### 本次文件范围

- 角色持久化与策略：`runtime/agent-profiles.mjs`、`runtime/compat.mjs`、`runtime/session-extensions.mjs`、`runtime/tool-policy.mjs`。
- 宿主适配：`runtime/harness/agent-policy.mjs`、`index.mjs`、`profile.mjs`。官方依赖包未改。
- 页面与导航：`ui/desktop/src/components/custom-agents/CustomAgents.tsx`、`App.tsx`、`hooks/useNavigationItems.ts`、`utils/navigationUtils.ts`、16 份语言目录。
- 聊天角色摘要：`ui/desktop/src/acp/sessions.ts`、`types/session.ts`、`components/BaseChat.tsx`。
- 回归：两个 `runtime/tests/agent-profile*.test.mjs`、页面测试、导航测试、`tests/browser-fixtures/custom-agents*` 和 `tests/e2e/custom-agents.browser.spec.ts`。
- 文档：本说明、README、事实权威地图。

### 2026-10-30 头像扩展

聊天侧栏通过现有会话元数据传递工作区智能体头像，替换该组文件夹图标；普通工作区保留文件夹。角色卡片和工作区标签统一渲染 Logo、Emoji 或上传头像，上传图片随角色及工作区快照持久化，不依赖原始图片路径。已有工作区的执行配置继续使用创建时的快照；工作区标签头像跟随当前模板更新。

本轮改动文件：`runtime/agent-profiles.mjs`、`ui/desktop/src/components/custom-agents/AgentAvatar.tsx`、`CustomAgents.tsx`、`ui/desktop/src/acp/sessions.ts`、`ui/desktop/src/components/Layout/NavigationPanel.tsx`、`ui/desktop/src/components/BaseChat.tsx` 及对应测试。

验证：`node --test runtime/tests/agent-profiles.test.mjs`（4 项）、`npm.cmd --prefix ui/desktop run test:run -- src/components/custom-agents/CustomAgents.test.tsx src/components/Layout/NavigationPanel.test.tsx`（15 项）、`npm.cmd --prefix ui/desktop run test:run -- src/acp/__tests__/sessions.test.ts`（25 项）、`npm.cmd --prefix ui/desktop run test-e2e -- custom-agents.browser.spec.ts`（1 项，真实文件上传及重新编辑）、`npm.cmd --prefix ui/desktop run typecheck`、`git diff --check` 最终均退出 0。用户已授权重启，使用 `start-preview.ps1 -SkipOptionalToolCheck` 从本工作目录启动新版，未打包安装、未提交或推送。完整 Electron 产品头像交互未执行。

### 标签头像同步

仅工作区分组标签显示头像，对话列表行和聊天顶部角色名称标签不显示头像。侧栏启动及窗口重新聚焦时读取当前智能体列表；模板保存或删除成功后发送刷新事件，按绑定的智能体 ID 更新头像。模板已删除或请求失败时保留已有头像作为回退。显示层的最新头像不修改工作区中的人设、模型、技能或权限快照。

本次标签同步修改仍来自 main / 78f199a 加当前未提交改动。涉及 CustomAgents、NavigationPanel、BaseChat、useNavigationSessions、AppEvents 及组件回归。自定义智能体与导航组件测试 16 项通过，类型检查和差异检查退出 0；未执行完整 Electron 头像更新 E2E，无后端或 Harness 改动，无需重启后台。

子对话图标补充修复：旧版会话创建将头像直接拼进 title（如“🤖 My”），并非 SessionRow 独立图标。新建默认标题改为角色名；SessionRow 仅在标题与角色快照的旧默认格式完全相等时显示角色名，不改写历史数据或一般自定义 Emoji 标题。导航组件回归 14 项、后端角色回归 4 项通过，类型检查退出 0；当前子标签显示修复可由前端热更新生效，新后台命名逻辑在下次后台启动时加载。未执行真实 Electron 页面视觉验收。

### 自定义身份与公共行为分离

`runtime/harness/profile.mjs` 将默认 CodeBuddy 软件工程助手身份与公共行为分开；`runtime/harness/index.mjs` 使用 Harness 公开的会话级 `PERSONA_PREFIX_SECTION` 覆盖接口，仅对绑定自定义智能体的会话屏蔽默认身份。执行、验证、真实回执、语言及工具政策仍保留。官方 Harness 包无修改，无历史数据迁移。普通会话身份不变，自定义人设仍使用工作区创建时的快照；历史对话里已出现的自我介绍不被删除。

源码来源：main / 78f199a 加本工作目录未提交改动。`node --test runtime/tests/agent-profile-harness.test.mjs runtime/tests/agent-profiles.test.mjs` 退出 0，6 项通过，使用真实 Harness 和本地模型夹具检查父/子请求保留角色与行为、去除默认身份，并检查同一 Host 中普通会话不受污染。此次未调用线上模型、未执行完整产品对话验收；运行中的旧后台需下次重启加载修改。
