# CodeBuddy 自定义智能体需求与实施计划

> 2026-11-04 状态补充：本文后面的“未提交／未推送”等叙述是原验收时点记录。产品源码现已汇总提交至 `7acb7b9`（运行时）和 `6e30106`（桌面）。最新菜单与合并边界见 [全部改进说明](2026-11-04-merge-preparation.zh-CN.md)；旧真实模型验收不代表最终新增界面已完成用户验收。

日期：2026-11-03。状态：首批会话级功能已完成相关自动检查和真实客户端验收；六个默认模板已改进，27 场内容对照及三种主助手的主子并行补测已完成。阶段 6 资源包导入导出仍为单独后续交付。实际结果与限制见文末，不能将计划场景视作已通过。

CodeBuddy 继续使用“自定义智能体”作为产品名称。它表示用户可在当前对话中选用的专业主助手，包含身份、工作方法和可用资源。用户可以在同一对话中使用后端助手、撤销，再使用 AI 助手，保留聊天记录、项目和已有成果。

自定义智能体与子智能体是两个独立模块。有无自定义主助手，都保留原有委派与并行能力；主助手可以继续工作，同时让原生或已有自定义子智能体处理独立任务。执行核心继续使用现有 Agent 执行引擎。

## 需求目标

| 编号 | 必须达到的行为 |
| --- | --- |
| R1 | 设置与管理入口继续叫“自定义智能体”，不另建“专家中心”或要求用户理解两套主助手概念。 |
| R2 | 新对话、已有普通对话均可选用、直接切换或撤销智能体，选用本身不创建对话、目录或客户端窗口。 |
| R3 | 切换保留会话 ID、标题、历史、附件、当前工作目录、现有文件和任务进度。 |
| R4 | 默认保留用户当前模型、思考档位、输出额度与批准模式，不因选用智能体锁死模型。 |
| R5 | 主智能体与子智能体的配置、身份和运行实例独立；原有模板、模型设置、并发上限、停止与回传机制继续工作。 |
| R6 | 主助手选用智能体后仍可自己执行工作，同时委派多个子智能体；不强制退化为“只协调的主理人”。 |
| R7 | 用户能区分当前使用、待生效、加载失败和未使用，界面消费宿主实际回执，不以模型自述确认切换。 |
| R8 | 角色指令与资源绑定可撤销；项目规则、会话权限和原有安全边界继续有效。撤销身份不等于放宽权限。 |
| R9 | 选择可恢复、不同对话不串用；编辑或删除模板不暗中改变已经采用的角色版本。 |
| R10 | 配置各项属性的表单是必须保留的主要入口。对话式创建以后可生成同一张表单的草稿，不另建一套定义或执行系统。 |

用户主流程为：

```text
现有对话与项目
  → 选择后端助手
  → 主助手执行后端工作，同时子智能体并行检查或测试
  → 撤销主助手角色，恢复默认助手
  → 选择 AI 助手，继续处理同一项目
```

“独立模块”指配置和职责独立，不要求建设两套执行循环。子智能体是否启动仍由模型调用原生委派工具决定；宿主不根据任务关键词或复杂度评分自动接管规划。

## 当前实现与需要改变的合同

代码基线：`codex/migrate-local-20261102`，revision `6e23c4023819bf0b7f1ade9ae37bed65ea21f939`。本轮开始时 tracked diff 为空，已有 `.agents/`、`.local/` 未跟踪目录保留。

| 现有入口 | 当前行为 | 本计划的变化 |
| --- | --- | --- |
| `runtime/agent-profiles.mjs` | 保存角色版本；使用角色时创建专属工作区，并保存工作区绑定快照。 | 保留模板 owner；增加当前对话的显式选用入口，普通使用不再依赖新建工作区。 |
| `runtime/compat.mjs` 的 `sessionOptions` | 主角色混入共有会话指令；有 profile 时不提供自定义子模板和子模型配置。 | 分开主角色身份、共有指令和子模板；角色选择不清空子智能体模块。 |
| `runtime/compat.mjs` 的模型、服务和人设设置 | 角色工作区固定相应配置。 | 新会话角色模式下允许独立设置；旧绑定通过兼容转换处理。 |
| `runtime/harness/driver.mjs` | 子级取得父级会话能力；profile 相关身份与工具策略同时安装。 | 子级仅继承必要共有策略，保留自己的职责与原生身份；不重复注册原生 persona 段。 |
| `runtime/library.mjs` | 已有 Agent Markdown、Skill 和导入导出等资源能力。 | 复用已有资源读取与管理，不建设另一套无关联资源库。 |
| `CustomAgents.tsx` | 模型必填；主要使用按钮为“创建工作区”。 | 改为在任务中使用，模型改为可选偏好，保留既有编辑和头像能力。 |

此前所有权地图的“2026-10-29 已批准：自定义智能体与工作区角色”适用于旧角色工作区。用户授权本计划后，已在地图顶部补充“2026-11-03 已批准：会话级自定义智能体”说明新旧边界；旧数据的权限基线仍保留。

## 产品范围

首批包含：

- 本地创建、编辑、复制、删除自定义智能体；复用现有头像、人设、Skill、工具和 MCP 选择。
- 当前聊天中的选择、直接切换、撤销，以及重启恢复。
- 主身份与子职责分离；已有原生和自定义子智能体并行回归。
- 旧角色数据兼容与显式转换，不要求复制聊天或搬项目。
- 角色依赖的真实可用状态和失败反馈。

第二批在核心流程验收后再做本地资源包导入导出，包括有限的 WorkBuddy 格式转换。该批是独立交付，不作为首批角色切换的前置依赖。

本计划不包括专家团、自动组队、团队任务板、公共市场、云端分发、语音、自动切换角色、模型备用链或全局思考干预。保持现有字体和简约界面风格，不借机重做聊天布局。

## 两个模块的职责与权限

| 对象 | 负责什么 | 接收与输出 |
| --- | --- | --- |
| 自定义智能体模板 | 稳定 ID、名称、头像、版本、人设、工作方法和可选资源。不绑定模型。 | 管理页提交定义；现有模板 owner 校验并返回保存后的版本。 |
| 当前对话配置 | 用户此刻选择哪份主角色，或明确选择默认助手。 | 接收结构化选择；保存角色快照及选择 revision，不接收客户端伪造的完整授权快照。 |
| Compat 与现有配置准备 | 解析选择，准备允许的资源，将主角色和共有配置分开交给 Harness。 | 返回已保存、待生效、实际生效或具体失败；不裁决任务是否完成。 |
| Harness | 原生主子会话、执行、工具、委派、队列、停止、恢复、日志及结果回传。 | 消费已校验配置，产生原生执行事实。 |
| 子智能体模块 | 现有模板和模型配置、原生委派接线及展示。 | 接收任务与自己的角色；不会因主角色选用或撤销而被重置。 |
| 桌面 | 管理模板、提交显式选择、展示当前状态与失败。 | 不自行拼接生效角色，不保存第二份执行状态。 |

配置组合遵循以下顺序：

1. 项目、会话、沙箱和明确拒绝构成共有边界，仍由既有 owner 与 Harness 执行。
2. 主助手获得当前主角色及其允许的业务资源；角色资源不会自动授予外部服务权限。
3. 子智能体获得自己的职责、模型和工具档位，以及已有原生委派策略允许继承的共有边界。
4. 主角色的身份正文不传给子级；主角色资源限制也不整份替代子模板。角色管理中的业务工具清单不兼任“是否允许委派”的第二个开关。
5. 明确的会话级禁用和原生委派限制始终有效。“与未选角色时一样并行”不表示额外授予工具或修改非交互子级审批语义。

主角色独有 MCP 不默认变成所有子级的连接。子级是否能使用相关能力，由它自身配置、共有会话能力和原生委派合同共同确定；资源加入与权限批准分别处理。

## 会话选择与生效时机

### 选择的保存

继续使用 `agentProfiles` 保存定义，不新增独立的插件角色数据库。会话增加可选的角色选择记录，保存选择 revision 和宿主解析的模板快照。概念结构为：

```text
agentSelection
  version = 1
  revision
  selected = "id:revision" 或 "default"
  baseline = 引入可切换选择前的角色版本
  profiles = 已采用版本的不可变快照；default 对应 null
agentInputs
  原生 user 输入 rpcId → 保存后的角色版本键
```

`selected = "default"` 是明确撤销，不能重新回退到旧工作区角色。字段缺失识别旧数据。输入配置仍由现有 Store 保存；DSH 原生日志决定输入是否已接纳，不改 DSH Session 格式或另建运行日志。

复用 `_codebuddy/agents/*`，增加 `current` / `select`；选择只携带 `sessionId`、`id` 或 null、`expectedRevision`。新建对话可携带 `_meta.customAgentId`，由宿主解析；客户端不能提交任意角色快照或权限。

多个窗口同时更改时复用 Store 写队列和 revision 冲突检查，后保存者必须基于当前版本。界面先展示“正在切换”，收到保存回执后再显示选中或待生效；不靠本地乐观标签假报成功。

### 当前轮与下一轮

推荐以“下一轮用户输入”作为清楚的生效边界：当前用户输入触发的执行及其后续工具步骤使用同一份主角色快照，避免一次任务中途换身份。

| 用户操作时机 | 处理 |
| --- | --- |
| 主会话空闲 | 保存选择；下一次提交用户输入时按该选择准备角色与资源。 |
| 主会话正在处理当前输入 | 保存新的期望选择，显示“下一轮生效”；当前轮不重启，也不改写已发送的模型请求。 |
| 用户明确停止后继续 | 仍走原生停止；后续用户输入采用最新选择，不因角色切换自动发送“继续”。 |
| 子级正在运行 | 子级保持创建时配置；切换主角色不主动取消、重建或修改它们。 |
| 子级结果到达父级 | 保留原生投递和回收；属于已有工作的自动回报不会自行应用待生效主角色。 |
| 桌面消息仍在队列 | 尚未交给 Compat 的下一条输入采用提交时的选择。Compat 已开始准备的输入先持久化其角色配置，不受后续切换影响；原生 steering 保留当前轮角色。 |

待生效选择只是对话配置，不增加唤醒器、执行队列或调度器。请求前保存 rpcId 与版本的配置绑定；原生 claimed 仅形成候选，awaited prompt/pre-step 校验；实际 `user/message` 才提交当前工作角色，拒绝或取消回退。冷恢复沿原生已提交 rpcId 读取配置，而不是按界面最新选择猜测旧工作身份。首次转换同时保存准备中输入及已有原生输入的基线绑定。fork 复制版本与输入配置，truncate 由保留的原生前缀决定当前工作角色。打开历史不发送模型请求。

这一边界比“下一次 HTTP 请求就切换”保守：一轮任务可能包含多次工具与模型交互，中途切换会使前后职责不一致。用户仍可随时选用，界面必须准确说明生效时间。

### 切换失败

- 角色切换不重建整个会话配置：只更换 Agent 作用域人设与工具/Skill 筛选。配置或输入绑定无效时明确失败，不发送模型请求；未提交候选恢复原有效角色。独立修改 MCP/模型配置仍遵循原有配置重建合同，不承诺该路径具备完整双代回滚。
- 能力清单是对当前会话已启用能力的筛选，不是自动加载或必需依赖声明。已知不可用 Skill、工具和 MCP 在菜单/表单说明，不自动启用或换模型；实际调用仍由原生注册表、权限和真实连接校验。角色配置或输入绑定缺失属于硬错误。
- 用户选 A 后很快选 B 或撤销：原生配置准备前后检查选择 revision，丢弃迟到结果；旧准备操作不能恢复已经撤销的角色。
- 角色选择失败不改变已经完成的文件修改或外部操作，也不自动重新执行工具。

实施时先核对公开 Harness 接口能否独立更新主角色、保留子级与连接租约。不能用释放整个原生会话再创建来冒充切换；如果做不到，先报告确切接口限制和替代边界，再调整方案。

## 指令和资源的装配

主角色进入独立、可撤销且只对目标主 Agent 有效的 prompt 贡献；共有项目指令、当前任务、语言提示和权限策略留在共有层。不得把父角色正文放入子级必继承的 session instructions，也不得与原生子角色重复注册 `deployment:persona-prefix`。

选择 B 时替换 A 的活动贡献；撤销时恢复默认身份，并在后续有效上下文中说明当前身份变化。历史发言和原生执行日志保留，不宣称模型已经遗忘旧内容。使用原生当前上下文的替换与撤下机制，不在每条用户消息中不断追加完整旧人设。

角色工作方法不能取消项目规范或权限要求。只装配角色相关正文和资源目录，Skill 正文按现有加载机制读取；不把所有技能和资料每轮全文注入。可用、加载、实际调用分别展示和验证。

模板的能力设置区分“沿用当前会话”与“使用所选能力”，避免把空清单同时解释成无能力与不限能力。旧模板空数组保留原限制含义，不能升级为全量开放。MCP 引用复用已配置服务 ID，不存密钥，不由角色包修改连接配置；共享技能仍遵守现有显式启用规则。

按用户追加要求，不提供推荐模型或模型绑定。模型统一在对话页选择，选用、撤销或编辑角色不修改当前模型。旧模板携带的 providerId/modelId 在读取与保存定义时忽略，不校验其仍在不在提供商目录中；已有会话的模型值保留，用户可按现有模型切换合同更改。资源准备失败不能触发备用模型或改变思考档位、额度。

已有会话使用模板快照。编辑模板后，新选用采用新版本；当前会话提示可更新，由用户显式应用，不在执行途中热换正文。删除模板不删除会话及其已选快照；撤销后不会再凭已删除 ID重新选用。

## 界面与管理流程

按用户最新截图选择简洁布局：新任务工作区位于输入框上方，输入框左下为加号与权限、右下为模型与发送，移除功能徽标。未选择智能体时不显示“默认助手”；加号菜单提供附件、智能体选择与管理，选中后才显示头像与名称，可切换和恢复默认。复用现有 Radix 菜单及其键盘操作，不另建弹窗系统。

新任务页和聊天页共用相同选择逻辑。选择动作不自动发送消息。管理页保留名称、头像、人设及资源配置，模型支持沿用当前设置；“创建工作区”主操作改为“在对话中使用”。没有当前对话时，可明确发起新任务，但新建对话是该操作的结果，不是专家无法摆脱的生命周期绑定。

运行中当前与待生效名称不同，则显示“当前 A，下轮使用 B”；撤销时显示“下轮恢复默认助手”。失败信息保留具体不可用项。不要在聊天正文伪造用户或助手消息来展示配置变化，优先使用已有会话状态提示。

角色切换不改聊天标题，不把任务名称变成角色名，不改变侧栏项目分组。可用性检查覆盖键盘搜索、Enter 选择、Esc 关闭、焦点返回及窄窗口，不改字体。

## 旧数据和兼容转换

现有角色工作区保存了模型和能力快照。按追加要求解除模型绑定，已有会话继续使用原模型，之后可在对话页切换；不能通过删除 `agentProfile` 一并解开原工具与权限限制。

1. 旧 `agentProfiles`、`agentWorkspaces`、会话 `agentProfile` 保持可读；不批量重写用户文件，不根据文件夹名字判断是否旧角色。
2. 旧会话保留原身份与能力限制，界面明确标为旧工作区角色；模型选择不再锁定。提供在原对话中“转换为可切换智能体”的显式操作，转换本身保留会话 ID、目录和当前模型。
3. 转换后原人设成为可撤销选择；原工具和服务限制保留为共有兼容策略，取消主角色不解除它们。后续如何解除或迁移这层策略另按明确授权处理。
4. 新普通工作区采用新选择机制；旧绑定目录仍需识别原策略，不能通过新建聊天绕过旧限制。
5. 新客户端不再把创建专属工作区作为普通使用入口。旧客户端的创建入口只作为明确兼容路径保留，不自动把新会话选择写成工作区永久绑定。
6. 新字段缺失时按旧行为；显式 null 不回退旧角色。损坏的必需角色或兼容策略给出具体恢复错误，不能静默放开权限。

该兼容路径的退出条件是旧绑定完成有记录的显式迁移，且不再支持旧创建客户端；不在本批无条件删除历史字段。回滚旧版本前必须核对它是否理解新的可撤销选择，不能承诺旧客户端可以安全忽略它。首次写入前需要备份或复用现有数据迁移机制，验证成功后才发布转换结果。

## 插件取舍

结论是扩展现有 CodeBuddy 模块，按需要借鉴固定版本源码，不先整包安装。当前 `runtime/harness/package.json` 锁定 DSH `0.2.1-alpha.2`；候选依赖范围、官方 Web 预设和客户端插槽不等于 CodeBuddy Electron 已兼容。

| 候选 | 适合借鉴的部分 | 本计划取舍 |
| --- | --- | --- |
| [dsh-agent-persona](https://github.com/Awoodwhale/dsh-agent-persona) | 会话范围的人设选择、无角色覆盖、下一条生效、生命周期清理。 | 主角色注入的优先参考；不引入其另一个角色存储、位置模糊匹配或覆盖项目规范的优先级设计。它不提供完整资源包和独立主子能力管理。 |
| [dsh-custom-mode](https://github.com/BOWLUNA/dsh-custom-mode) | 官方注册返回的 disposer、串行变更、重复注册与失败恢复测试。 | 主助手装卸与验证参考；不照搬其模式系统和另一套助手数据中心。 |
| [experts-management](https://github.com/weibaohui/experts-management) | WorkBuddy 兼容包、角色文档与 Skill 资源组织、浏览和详情。 | 第二批导入转换的优先参考；其当前消息注入手势不替代本计划的持续选择与撤销。市场同步、分享和团队入口不接入。 |
| [dsh-agent-studio](https://github.com/thissensen/dsh-agent-studio) | 角色能力分层及官方 `startActivation` 的并行委派接线。 | 只作主子分离参考；用户已确定模块独立，不采用统一 Agent 池接管两者。既有检查中子角色映射含进程内 Map，恢复能力需单独证明。 |
| [dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) | 专家目录、原生子代理结果和失败处理。 | 不用于主角色切换：其召唤主要执行子代理任务。避免再包装一个平行的委派入口。 |
| 官方及第三方 Agent Teams | 团队成员、共享任务和协作。 | 本批不启用，不为选一个主角色替换普通子代理工具面。 |

此前源码审查固定版本为：persona `c0c927e35a8e009788f0188c97fd52e4735d595a`，custom-mode `41759d8fba336f82af087e12b6ec05a11242f577`，experts-management `d76164fd533bf525fdb9553914de7ee2d160090b`，agent-studio `14c278987c208dc7a81c7fb07caa2ea588e80419`，agency-agents `bb652a4a8853fc22e758d3bb69dab76e1d8e11b4`。这些是已检查快照，不宣称仍是各仓库最新版本，也不代表已在本机通过模型验收。若实际复用代码，先核对对应版本许可证、保留归属及最小必要依赖。

成熟产品只借鉴已公开行为：

- [Kiro](https://kiro.dev/docs/reference/slash-commands/)：运行时切换角色，目标没有指定模型时保留当前模型；[V3 子代理权限](https://kiro.dev/docs/custom-agents/subagents/)同时受父会话和自身策略约束。
- [VS Code Custom Agents](https://code.visualstudio.com/docs/agent-customization/custom-agents)：主选择持续生效与子代理委派是不同入口。
- [WorkBuddy 包规范](https://open.workbuddy.cn/docs/expert)及 [Anthropic 岗位插件](https://github.com/anthropics/knowledge-work-plugins)：复用角色工作方法和资源组织，不复制其团队工具或假定插件就是主身份。
- [Qoder](https://docs.qoder.com/zh/qoder/custom-agents)：模型和权限可作为默认值，资源缺失及配置草稿有明确状态。

不照搬位置正则匹配、按自然语言判定用户已切换、全局清空提示词、另一套子代理注册表或故障时暗中降级模型。

## 分阶段实施

每阶段独立验收，涉及同一状态链的修改由同一实施者完成，其他 Agent 只读审查。用户已授权按此计划持续实施，不为普通阶段重复审批。

| 阶段 | 改动与主要文件 | 阶段完成条件 |
| --- | --- | --- |
| 1 主子职责分离 | `runtime/compat.mjs`、`runtime/harness/driver.mjs`、`runtime/harness/agent-policy.mjs`，更新相应 owner 说明。分开身份、共有策略和角色业务资源，恢复子模板/模型目录。 | 实际组装中主角色只出现于主级；已有和新建子模板各自生效，可并行、返回、停止和冷恢复；普通聊天不回归。 |
| 2 会话角色合同 | `runtime/agent-profiles.mjs`、现有 Store、Compat 配置与会话投影。增加选择、撤销、revision、快照及生效边界。 | 同一现有会话完成 A→默认→B，ID/目录/模型不变；并发保存、失败及重启结果一致，不销毁原生会话。 |
| 3 聊天入口 | `CustomAgents.tsx`、`ChatInput.tsx`、现有 ACP 会话类型、hooks 和侧栏摘要。 | 用户在真实客户端完成选择、直接切换和撤销；选中态来自后端，待生效/失败可辨认；已有字体和窗口数量不变。 |
| 4 资源与旧数据 | 现有 Skill catalog、Library、MCP/session extensions；旧数据显式转换。仅在必要边界修改。 | 资源真实可用、缺失明确；取消移除角色绑定但不放开原权限；同一会话可转换，旧数据和默认配置不丢失。 |
| 5 集成验收 | 聚焦自动回归、隔离 profile 的真实桌面与模型任务，保存实际请求角色和原生结果证据。 | 下方核心场景通过，分别报告自动检查与产品 E2E；无未解释的主子串角色或扩权。 |
| 6 本地包扩展 | 首批稳定后单独交付：Library 导入预检、角色与 Skill/MCP 引用转换、管理页导出。 | 单角色包可预览、导入、使用、导出；导入不执行脚本、不安装依赖、不覆盖同名用户资源。 |

阶段 1 首先用锁定 alpha2 的公开接口验证能力更新、prompt 作用域、子级冷恢复与 MCP 租约。升级 Harness 不是默认前置；若公共接口不足，给出依赖闭包与迁移比较后再定，不修改官方包或叠加新的源码补丁来绕过。

阶段 6 的格式支持应列清楚：单角色 manifest、Agent Markdown、头像、Skill 资源和现有 MCP 引用可以转换；团队角色、专有连接器、Hooks、可执行插件和包管理脚本不承诺兼容。导入使用现有预检和确认边界，校验目录越界、链接、体积、冲突及失败回滚；共享外部技能不复制或启用，除非用户明确选择对应操作。

## 测试与验收

先验证确定性合同，再运行短小真实任务，不重跑 MAL 或过度思考实验。所有执行验收使用包含待测修改的当前 worktree 和隔离数据目录；不能用旧进程证明新代码有效。

| 场景 | 关键断言 |
| --- | --- |
| T1 已有普通聊天 | 选择后端助手、普通撤销、选择 AI 助手各执行一轮；实际请求身份符合选择，历史、目录和模型不变。 |
| T2 主子并行 | 选主角色后委派一个已有模板与一个新建模板。至少两个原生子级有重叠执行区间，各自产生实际回执和结果；主级也可工作。spawn ack 不算完成。 |
| T3 运行中切换 | 当前用户轮次及旧子级保留原配置；下一人工输入采用新角色；自动子回报不提前应用待生效角色，无重复工具执行。 |
| T4 快速操作与多窗口 | A 装载延迟时选 B/撤销，迟到结果作废；两个窗口旧 revision 保存被明确拒绝，界面重新读取真实选择。 |
| T5 多会话和恢复 | 两条聊天分别使用 A/B；切换窗口、关闭再打开和重启后不串角色、模型、资源。打开历史不触发请求。 |
| T6 模板生命周期 | 编辑后已有会话保留版本，显式更新采用新版本；删除后已选快照可查且可撤销，不重新绑定不存在的定义。 |
| T7 资源和权限 | 缺 Skill/MCP、连接改变、无工具模板、明确 deny、会话授权及子级原生非交互拒绝分别验证；撤销不清除无关连接，也不让子级绕过策略。 |
| T8 旧角色转换 | 转换本身保留当前模型与权限快照，模型可独立切换；保留同一聊天和目录，撤销角色后原能力限制仍在；损坏数据不自动变为普通全权限助手。 |
| T9 常规聊天回归 | 未选择角色的发送、附件、重试、队列、停止、工具审批、模型切换、历史恢复和自动任务沿原行为执行。 |
| T10 包导入扩展 | 合法单角色包往返；越界/链接/同名/缺资源/不支持团队字段有准确预检结果，失败不污染当前选择或资源。 |

自动化优先覆盖选择与生效边界、主子身份隔离、权限交集、并发保存与恢复。复用 `runtime/tests/agent-profiles.test.mjs`、Library 回归及 `runtime/harness/test/capabilities.test.mjs`、`subagent-templates.test.mjs` 等现有夹具，增加确有缺口的用例；不通过照抄新实现写断言。

前端聚焦角色管理、选择器、状态和聊天提交；真实桌面验证菜单和键盘操作。主子身份通过实际 prompt 组装和原生子日志核对，不以“我是后端专家”的回答作为唯一证据。真实模型使用用户当前可用的模型和既定参数，不切回 Gemma，不为了通过测试增加额度或放宽权限。

最终按 README 运行适用入口；以下是项目标准命令，实际执行范围和环境情况记在实施记录：

```powershell
corepack pnpm --dir .\ui\desktop run typecheck
corepack pnpm --dir .\ui\desktop run test:run
corepack pnpm --dir .\ui\desktop run lint:check
npm --prefix .\runtime test
npm --prefix .\runtime\harness test
```

开发过程中可按文件选择相关 Node/Vitest 目标，稳定后集中运行相关门禁。纯 TS/JS 与桌面 UI 改动不默认运行 Rust 全套。启动遵守 `start-preview.ps1`：先确认并复用当前唯一客户端，必要时有序关闭旧实例再启动待测版本，不并排开多份。

真实模型任务采用可独立验收的小项目，例如主助手实现本地 `/health`，两个子级分别审查另一模块和编写测试，再由 AI 助手继续同一项目。分别记录构建 revision、实际选择版本、原生子 ID、重叠执行和结果、最终文件与测试；不把工具执行成功写成业务交付通过。

## 交付与停止条件

首批交付以 R1–R9 和 T1–T9 为准，阶段 6 单独按 T10 验收。交付说明分开列出源码实现、自动验证、真实桌面操作、真实模型执行和未完成项。独立行为拆成可审阅提交；提交和推送遵守届时授权，本计划不包含推送。

出现以下情况时停止相关实施并重新收敛：角色切换必须销毁原生会话；已有子级无法保留独立配置；取消会解除旧权限；恢复只能依赖内存角色映射；依赖必须跨版本混装。继续完成不受影响的文档或验证，不用补充提示词掩盖这些机制缺口。

## 实施记录

- 当前工作区与基线分支不变。保留 `.agents/`、`.local/`，不推送；未安装插件或下载依赖。
- 主角色使用原生 `PERSONA_PREFIX_SECTION`，`interpolate:false` 保留字面 `{{...}}`；子级不继承正文。Host/MCP 工具放在稳定祖先 scope，Agent 角色筛选不重建 MCP lease。共享 MCP 资源工具还检查真实 `server` 参数。
- 已有属性表单保留并增加沿用模型、沿用能力、复制及明确的已选版本更新。对话式生成草稿与包导入仍为后续能力，不宣称已实现。
- 自动检查与桌面验收仍在进行；以最终验证记录中的实际命令、退出码、源码身份及未通过项为准。Corepack 在此环境尝试联网定位 pnpm 失败，未安装成功；后续使用本机已安装且与项目一致的 pnpm 11.9.0 执行相同脚本。
- 旧工作区角色现在要求显式“转换为可切换智能体”，菜单说明原有工具、服务和权限限制继续保留。转换复用现有 Store 写队列和原快照，模板已修改或删除也不改变转换采用的版本；普通选择不能隐式完成转换。
- 待生效提示比较期望选择与原生已提交人工输入采用的配置，空闲时不清除。真实冷恢复验收发现服务器延迟代理漏转发角色查询，已补齐 `agentInputIds`、`mainAgentProfile`、`mainAgentUnavailable`；steering 正确等待异步角色查询。新增真实服务器和 WebSocket 回归覆盖该缺口。
- 输入框按实际栏宽减少次要文字，保留角色及模型名称；上下文用量不换行。按用户要求去掉聊天顶部重复角色徽标，保留输入框选中态；字体不变。

### 截至本轮的实际验证

源码为上述 worktree、分支及 revision 加本轮未提交改动；未推送。以下命令均使用现有依赖和隔离测试数据，不以通过数代替产品验收。

| 验证 | 结果与边界 |
| --- | --- |
| `node --test runtime/harness/test/capabilities.test.mjs runtime/harness/test/subagent-templates.test.mjs runtime/tests/agent-profiles.test.mjs runtime/tests/conversation-editing.test.mjs runtime/tests/conversation-admission.test.mjs runtime/tests/subagent-conversations.test.mjs` | 75/75，退出码 0；包括原生主子并行、资源过滤、角色恢复、转换和会话映射。使用本地假 Provider，不代表真实模型质量。 |
| `node --test runtime/tests/agent-profile-integration.test.mjs` | 2/2，退出码 0；完整 Compat/Harness 恢复，以及真实服务器延迟代理、WebSocket、默认撤销和冷查询不生成。记录：`.preview-data/custom-agent-server-integration.log`。 |
| `node --test runtime/tests/agent-profiles.test.mjs`（最终配置回归） | 10/10，退出码 0；新增并发同 revision 切换只有一个成功，以及模板编辑/删除后已选快照仍可使用、冷恢复和撤销。记录：`.preview-data/custom-agent-profile-delivery.log`。 |
| `node --test runtime/tests/agent-profile-harness.test.mjs runtime/tests/steering-subagents.test.mjs runtime/tests/harness-server-startup.test.mjs` | 5/5，退出码 0；主身份不进入子请求，共有政策、模型与工具限制仍在；steering 与取消不回归。记录：`.preview-data/custom-agent-owner-boundary-delivery.log`。旧夹具把主身份放进共有 `systemPrompt` 并要求主子同身份，已按本计划分成 `mainAgentRole` 和共有政策分别断言；未为旧断言恢复主身份继承。 |
| `pnpm --dir .\ui\desktop run test:run src/components/custom-agents/AgentSelector.test.tsx src/components/ThinkingEffortSlider.test.tsx src/components/ChatInput.queue.test.tsx` | 84/84，退出码 0；覆盖旧角色显式转换、空闲待生效与输入框原有交互。 |
| `pnpm --dir .\ui\desktop run typecheck` | 退出码 0。 |
| `pnpm --dir .\ui\desktop run lint:check` | 退出码 1；其中类型检查通过。ESLint 在未修改的 `src/acp/nativeSchedules.ts:86,100` 报两处既有 `performance` no-undef，零警告；因此该命令未执行后续 i18n 阶段，不宣称完整门禁通过。记录：`.preview-data/custom-agent-lint-delivery.log`。 |
| 真实 CodeBuddy 任务 | 会话 `e9cca108-f698-4ca8-be93-b504d5d6b7ea`，DS Flash 1017、High。主角色采用后端验收 rev2；实际写入 `health.py`、`test_health.py`，工具回执记录 2 项 unittest 通过，并在可见结果保留 `{{ROLE_LITERAL}}`。 |
| 独立验证真实任务产物 | 检查生成源码后，在原隔离工作区运行 `python -m unittest -v test_health`，2/2，退出码 0。没有重发模型任务或安装依赖。 |
| 当前桌面情况 | 宽、窄栏布局及顶部徽标移除已通过 CU 查看。修复服务器查询遗漏后，旧客户端已关闭；用户要求暂不操作桌面，因此尚未重新启动并复验该修复。 |

### 尚未完成的产品验收

- T1：后端角色首轮已执行；同一聊天撤销为默认、再选 AI 助手的完整真实模型链路待做。
- T2：本地假 Provider 已证明两个原生子级同时执行且不携带主角色身份；已有模板与新模板的真实模型并行仍待做。
- T3/T5：待生效和冷恢复的服务器回归已通过；真实客户端修复后的状态、运行中切换及子回报边界仍待做。
- T4/T6/T7/T8：已有聚焦自动验证和部分管理页 CU；不能宣称跨窗口冲突、资源故障和旧角色转换的全部产品场景通过。
- T9：普通发送、读取历史和本次局部界面已实际操作；剩余常规场景按原计划验收，不重复无关构建。

对话式创建和本地包导入仍为后续能力，没有因 WorkBuddy 调研而扩大本批实现范围。WorkBuddy 这次游戏专家只包含 manifest、角色 Markdown、头像和 README；高级开发工程师包另带三个 Skill，不能把两者的资源配置混为一谈。

### 用户追加：默认智能体与 GitHub 配套 Skill

用户随后要求立即提供几个默认智能体，并从 GitHub 复用 Skill。此追加只提前交付随包默认资源，不表示阶段 6 的任意本地包导入已经完成。源码仍来自当前 worktree `codex/migrate-local-20261102` / `6e23c402` 加未提交改动；未提交、未推送、未构建安装包，保留用户暂不操作桌面的要求。

- 新增六个模板：高级开发工程师、前端开发工程师、UI 设计师、产品经理、数据分析师、内容创作专家。模板从只读目录显示；添加通过已有 save 生成独立副本，不自动写入、选用或建立会话，删除的副本不会自行重建。
- 复用 Anthropic 官方八个 Skill：debug、code-review、testing-strategy、frontend-design、write-spec、explore-data、validate-data、content-creation。保留 Apache-2.0 许可证、固定 revision、原文和 SHA256；引用的 CONNECTORS.md 改为同目录资源。来源与适配细节见 `runtime/harness/skills/agent-presets/README.md`、`PROVENANCE.json`。
- 模板与元数据在 `runtime/agent-presets.mjs`；管理页复用现有属性表单，沿用对话能力时也可单独编辑配套 Skill。`role-skills.mjs` 复用原生文件解析器与主 Agent scoped provider；只提供当前角色关联的摘要，正文按需读取，切换时失效原生缓存。注册名加 `codebuddy-` 前缀以避免替换用户安装的上游同名 Skill。
- 自动回归发现并修复 session capabilities 插件遗漏 `skills` 服务声明的问题。没有修改官方依赖、增加执行循环、运行下载的上游脚本或安装依赖。

| 实际检查 | 本次结果 |
| --- | --- |
| `node --test runtime/tests/agent-profiles.test.mjs runtime/tests/agent-profile-integration.test.mjs runtime/tests/agent-profile-harness.test.mjs runtime/harness/test/capabilities.test.mjs` | 51/51，退出码 0。覆盖八个 Skill 的实际原生读取、无角色不挂载、撤销与切换缓存、主子隔离、冷恢复及服务器边界。使用本地模型夹具，不代表线上模型能力验收。日志 `.preview-data/agent-presets-runtime-final.log`。 |
| `pnpm.cmd --dir .\ui\desktop run test:run src/components/custom-agents/CustomAgents.test.tsx src/components/custom-agents/AgentSelector.test.tsx` | 12/12，退出码 0。默认模板添加、保留现有角色、编辑失败保留草稿和聊天选择器。日志 `.preview-data/agent-presets-ui-final.log`。 |
| `pnpm.cmd --dir .\ui\desktop run test-e2e -- custom-agents.browser.spec.ts` | 2/2，退出码 0。隔离传输夹具中的真实组件与无界面浏览器；浅色、深色、390px 窄屏截图均已查看，无横向溢出。这不是完整 Electron 产品 E2E。日志 `.preview-data/agent-presets-browser-final.log`。 |
| `pnpm.cmd --dir .\ui\desktop run typecheck` | 退出码 0。日志 `.preview-data/agent-presets-typecheck.log`。 |
| `pnpm.cmd --dir .\ui\desktop exec eslint src/components/custom-agents/CustomAgents.tsx src/components/custom-agents/CustomAgents.test.tsx src/components/custom-agents/agentApi.ts --max-warnings 0 --no-warn-ignored` | 退出码 0。只检查本次相关 TS 文件；不覆盖上文完整 lint:check 的既有阻塞。 |
| 文档资源完整性与差异检查 | 八份 Skill 文档、十三项来源文件 SHA256 和本地 Markdown 引用检查通过；`git diff --check` 退出码 0。 |

无界面预览截图：`ui/desktop/test-results/custom-agents.browser-defa-50d8a-t-desktop-and-narrow-widths/agent-presets-desktop.png`、`agent-presets-dark.png`、`agent-presets-narrow.png`。以上没有启动 CodeBuddy 客户端或操作用户桌面。默认模板的线上任务表现及修复后的真实客户端状态仍待产品验收，不替代前面 T1–T9 的剩余项目。

### 对抗审查后的修复与模型解绑（2026-11-03）

前一轮自动检查通过不代表需求验收全部通过。三位审查 Agent 与根 Agent 核对后确认：选择保存遇到 busy 变化会丢失成功回执、已删的未发送草稿隐藏后仍阻断发送、准备阶段提前显示角色生效、失效推荐模型显示与提交不一致、Skill 实际读取失败没有反馈。修复复审又发现切到另一聊天且读取失败时残留上个聊天的角色，已一并处理。

- 按用户要求取消推荐模型功能，移除表单、目录与定义校验中的模型绑定；旧模板模型字段忽略，旧工作区会话也可独立切换模型。已有聊天模型不自动更改，工具、服务和权限基线保持。
- 选择保存与 busy 刷新分开；保存中的刷新延后补查，迟到结果不覆盖其他聊天。切换聊天先清除旧确认状态，新状态读取成功前不能使用旧 revision 选择角色；同一聊天刷新失败仍可保留该聊天已有确认状态。
- 删除未发送草稿对应模板后，显式显示不可用并提供恢复默认或重新选择，不静默替换角色。已采用的聊天快照继续保留。
- 是否生效只按 DSH 原生日志已提交的人工输入计算，不消费仅准备中的 Compat active 快照。
- 同一原生 Skill Provider 观测最后一次真实读取结果；失败可重试，成功清除，取消不误报，观测不跨会话、不持久化、不启动冷 Agent，也不预载所有正文。

| 本次实际检查 | 结果 |
| --- | --- |
| `node --test runtime/tests/agent-profiles.test.mjs runtime/tests/agent-profile-integration.test.mjs runtime/harness/test/capabilities.test.mjs` | 52/52，退出码 0。包含旧模型字段失效、旧角色独立切模型、准备失败仍待生效、配套 Skill 失败后重试恢复、取消不误报和会话隔离。仅本地假模型；日志 `.preview-data/custom-agent-fixes-runtime.log`。 |
| `pnpm.cmd --dir .\ui\desktop run test:run src/components/custom-agents/CustomAgents.test.tsx src/components/custom-agents/AgentSelector.test.tsx` | 最终 16/16，退出码 0；包括 busy 保存、跨会话迟到结果、跨会话读取失败、失效草稿恢复及去模型绑定。初次沙箱因临时目录原子重命名 EPERM 未运行用例，已在授权隔离环境重跑；日志 `.preview-data/custom-agent-fixes-ui.log`。 |
| `pnpm.cmd --dir .\ui\desktop run test-e2e -- custom-agents.browser.spec.ts` | 最终 2/2，退出码 0。最初遗留一条要求旧模型控件存在的断言，已按新需求修正；桌面、窄屏与深色截图已查看。日志 `.preview-data/custom-agent-fixes-browser.log`。这是无界面组件验收，不是 Electron 产品 E2E。 |
| `pnpm.cmd --dir .\ui\desktop run typecheck` | 退出码 0；日志 `.preview-data/custom-agent-fixes-typecheck.log`。 |

运行时与产品状态链已由原审查 Agent 再次只读复核，本轮定向检查未发现新阻塞。源码仍为 `codex/migrate-local-20261102` / `6e23c402` 加未提交改动；没有提交、推送、安装依赖或启动额外客户端。用户当前要求暂不操作桌面，真实客户端、线上模型及前文未完成的产品场景仍待验收，整体目标没有因此标记完成。

### 用户追加：更多头像与自定义图片

头像目录扩展为 40 个预设及应用 Logo，统一从现有静态模板模块导出，后端校验与浏览器夹具消费同一目录。表单默认展示 10 项，可展开或收起；所选头像不因收起而隐藏。已有图片上传能力保留，入口增加“上传图片”文字，支持 PNG/JPEG/WebP、最大 5 MB、居中裁剪并保存。没有新增头像依赖或图片服务，也没有修改字体。

- `node --test runtime/tests/agent-profiles.test.mjs`：13/13，退出码 0；包括新预设保存以及模板改头像后旧会话自定义图片快照保留。日志 `.preview-data/custom-agent-avatar-runtime.log`。
- `pnpm.cmd --dir .\ui\desktop run test-e2e -- custom-agents.browser.spec.ts`：2/2，退出码 0；新增展开、选择、收起保留及上传图片、保存后重新编辑检查。桌面/窄屏截图已查看，无横向溢出。日志 `.preview-data/custom-agent-avatar-browser.log`。
- `pnpm.cmd --dir .\ui\desktop run typecheck`、针对 `CustomAgents.tsx` 的 ESLint 及 `git diff --check`：均退出码 0。

上述均为当前源码的隔离自动验证；未启动客户端、未做真实桌面验收、未提交或推送。

### 恢复工作与最新真实验收（2026-11-03 晚）

以下更新覆盖前文“暂不操作桌面”的旧状态。用户明确恢复 CU 与验收授权；保持同一 worktree、分支和 revision 加未提交修改，不推送。

- 正式数据索引损坏经独立原始备份和 Windows 意外重启记录核对；按用户明确批准，仅重建并恢复六份只读历史，不补造丢失的模型连接、角色或权限配置。原文件、66 份原始记录及校验备份保留。当前验收窗口仍使用原隔离 QA profile，不混入正式数据。恢复收据在本地 `.preview-data/data-recovery-20261103/restored-receipt.json`。
- 同一 Store 写队列中的所有快照改为先同步文件内容再原子替换；同步失败不发布新内存状态、不覆盖旧文件。不能据此承诺抵御所有硬件/断电故障。`node --test runtime/tests/agent-profiles.test.mjs runtime/tests/agent-profile-integration.test.mjs runtime/tests/agent-profile-harness.test.mjs runtime/tests/store-atomicity.test.mjs runtime/tests/store-encoding.test.mjs runtime/tests/transcripts.test.mjs` 当时 34/34、退出码 0；日志 `.preview-data/custom-agent-final-20261103/runtime-final.log`。
- 唯一 QA 客户端通过官方 `start-preview.ps1` 启动，先正常退出再重开；当前启动收据时间为 `2026-11-03T09:49:14.451Z`。没有多开客户端，没有切回 Gemma 或调用 OpenAI 模型。
- T1/T3/T5：真实 DS Flash 1017、High，在原聊天 `e9cca108-f698-4ca8-be93-b504d5d6b7ea` 完成后端→默认→AI→后端→AI 的输入采用链。撤销后的默认助手实际读取文件并运行测试。运行后端任务期间选 AI，当前 native system/context 仍为后端，后续独立输入才采用 AI；两次冷启动保留角色选择、目录、历史及模型。没有用模型自称替代原生输入绑定与 prompt 证据。
- T2：内置探索子级 `4782d5bb-c1ea-4047-8a7c-bf3151798dd0` 与通过真实设置表单新建的“测试审查员”子级 `66c2abbd-0c7f-4dfc-8f9f-f0581782b71a`，原生执行区间重叠 6457ms；主助手在重叠期间实际调用 `write` 写入 ACCEPTANCE.md、调用 pwsh 跑测试。两份子级 system prompt 均无主角色指令，审查员保留 CHILD_TEST 身份。子模板的只读要求是提示词约束，不声称其继承工具配置构成硬只读权限。
- 真实模型曾遗漏人设要求的最终回复前缀；实际主 prompt 和角色绑定正确。此为模型遵循限制，不通过改写正文或正则补前缀伪造通过。小项目 `health.py` 与 `test_health.py` 的 SHA256 保持不变，真实测试 2/2；详细原生事件和产物校验在 `.preview-data/custom-agent-final-20261103/native-evidence.json`。
- 修复真实验收发现的状态滞后：busy 先于原生接纳变化，不能单靠 busy 刷新。现由原生真人输入接纳发送紧凑通知，Compat 过滤产品会话并隔离观察者错误，桌面只重读 current。实际客户端在仍“正在思考”且停止按钮可见时，触发器提示已由旧角色差异同步为 AI验收。完整 WebSocket 回归还验证模型响应尚未结束时可读到 pending=false；最终服务回归 2/2、退出码 0，日志 `admission-server-final.log`。
- 用户追加的输入框调整：移除常驻“下轮生效”，将更新操作和差异说明收进菜单；统一控件高度、左右分组、缩小角色字号到模型/权限同级，并保留窄栏权限名称与展开箭头。使用 Impeccable 与 Emil 设计规范；用户允许后下载并运行 Impeccable 引擎，布局 detector 为 `[]`、退出码 0。真实 CU 已确认文字、箭头、同排对齐和权限菜单展开，未改变当前批准模式。
- 输入框相关五组 Vitest 117/117、退出码 0；日志 `composer-ui.log`。角色/通知 29/29、退出码 0；最终 typecheck、针对改动文件的 ESLint、git diff --check 均退出码 0。此前完整 lint:check 的未修改 nativeSchedules.ts 两处 no-undef 阻塞仍未处理，未宣称全库门禁通过。
- 真实管理页已添加默认“前端开发工程师”，持久化两项配套 Skill，未增加聊天数量（仍 12）。尚未通过该新增副本做线上 Skill 读取；模板完整生命周期、资源异常与旧角色转换已有自动覆盖，但其全部 CU 产品组合尚未逐项执行。任意包导入与对话式创建仍为后续范围。

当前剩余：完成新增默认副本的真实 Skill 加载、旧角色转换以及窄栏极端组合的产品收尾。整体目标尚未标记完成；最新 UI 按用户逐步验收，不把已运行的 117 项组件回归写成上述未执行组合已通过。

### 用户追加：直接应用与卡片收紧（2026-11-03 晚）

用户批准调整管理页到聊天的应用流程，并逐步验收卡片和表单。以下覆盖前文默认模板“添加即保存副本”的旧入口描述，不改写既有验收记录。

- 默认模板具有稳定 ID 和独立 revision，直接使用不重复保存用户副本；自定义后才通过原保存接口生成独立配置。保留用户已经保存的重复模板，未擅自删除。相同 ID/revision 不能用不同内容覆盖已有历史快照。
- 从已有聊天进入时携带明确来源，应用经原选择接口校验 revision 后返回同一聊天；从新任务页进入时仅设置发送前草稿，不推断最近会话、不提前创建目录或聊天。保存成功但应用失败保留保存 ID，重试不重复创建；离开页面后的迟到回执不跳回旧聊天。
- 未配置角色时仍可通过加号菜单新建或选择默认模板；管理页不因缺少模型连接而阻止配置。新表单沿用当前能力，可添加配套技能；旧限制折叠保留。不再显示未开放语音、原始工具/MCP 清单或推荐模型。
- 默认与我的智能体复用同一卡片，统一头像、标题、两行描述和底栏。“立即使用”无箭头、按内容宽度；次要操作右对齐在同一行，删除确认仍在完整卡片内。卡片不展示配套技能摘要，收紧底部留白。
- 运行时快照与模板回归 15/15、原生 Harness/服务器集成 4/4、导航与角色组件聚焦回归 37/37 均退出码 0；分别见本地 `apply-runtime-final.log`、`apply-harness.log`、`apply-ui-final.log`。最终底栏的无界面浏览器回归 2/2（`apply-footer-browser.log`），typecheck 与定向 ESLint 退出码 0（`apply-footer-typecheck.log`、`apply-footer-eslint.log`）。这些日志位于 `.preview-data/custom-agent-final-20261103/`，不纳入提交。
- 桌面、窄屏浏览器截图已查看；真实唯一 QA 客户端也已通过 CU 看到默认与自定义卡片新底栏。客户端来自当前 worktree 的官方 `start-preview.ps1`，启动收据时间 `2026-11-03T10:48:23.648Z`。没有多开客户端、提交或推送。此前 CU 有人工输入冲突及遮挡截图，重新选择并激活目标后已取得当前卡片截图；不能把这次外观核对写成完整应用链路及全部剩余场景已通过。

整体目标仍未完成：线上配套技能真实读取、旧角色转换及最新应用流程的完整 CU 验收仍需收尾。用户正按小步审查界面，本轮未额外发送模型任务或删除保存配置。

### 用户批准的重复定义清理

用户随后明确要求高级开发工程师和前端开发工程师各保留一份，不能影响已有会话。实际核对 QA profile 中同名配置分别为 4 份和 2 份，忽略 ID/revision 后配置完全一致，待删除的四个 ID 均无会话及工作区引用。正常退出唯一客户端后，先备份完整索引，再调用现有 `agentProfileRequest('delete')` 与 Store 单写队列清理，没有直接编辑运行中索引。

保留最早的高级开发工程师 `514220d4-74e0-4c64-aaaa-60499e358674` 和前端开发工程师 `73d5a777-266d-4e53-b613-ef4ef0adb242`；用户定义由 9 项变为 5 项。12 份会话完整对象、角色快照、工作区绑定和其他根配置逐项比较不变。原始索引及校验收据在本地 `.preview-data/custom-agent-final-20261103/deduplicate-2026-11-03T11-11-05-816Z/`，不提交。第一次受限环境重开遇到 localhost 就绪超时，已退出后通过同一官方入口在正常桌面环境恢复；最新启动收据为 `2026-11-03T11:12:46.086Z`、running，CU 清点只有一个 CodeBuddy 窗口。该数据操作没有修改产品源码，也没有清理默认只读模板。

### 默认智能体定位审查与测试准备（研究阶段）

用户要求先浏览 WorkBuddy 专家及 GitHub 技能，核对现有定位，为后续测试做准备。本轮只补充调查记录与忽略目录中的虚构夹具，没有改动默认人设、技能正文、模型、权限或专家数量，也没有发送线上模型任务。基线为当前 `codex/migrate-local-20261102` / `6e23c402` 加既有未提交改动，不提交、不推送。

#### 已核对证据与适用限制

- 实际使用已存在的 WorkBuddy V5.9.2 窗口浏览专家市场、搜索及高级开发工程师 v1.1.1、UI设计师 v1.0.2、产品管理专家 v1.0.0、数据分析报告师 v1.0.0、内容创作专家 v1.0.1 的详情和任务示例。没有点“召唤”、创建聊天、安装专家或发送消息。CU 曾遇到输入冲突及非目标前台截图；重新观察并激活 WorkBuddy 后才操作，未操作其他应用。
- 详情页能证明展示的职责、版本和示例，不能证明实际任务质量。只有已经安装的高级开发工程师、全栈与趋势研究包进一步读到了本地配置，不能把它们的实现推广成所有在线专家的内部结构。
- 本地高级开发包有 `browser-use`、`frontend-dev`、`fullstack-dev`，并为复杂工作声明触发范围；其中前端技能偏动效与媒体生成，全栈技能有固定流程，浏览器技能依赖独立 CLI 和安装指令。这些可供比较，不适合直接复制到当前 DSH 环境。专家提示词也有每次计划、固定自检与失败次数等强约束，长并不等于优质。
- 当前 CodeBuddy 六个人设与八个技能逐项阅读；`PROVENANCE.json` 中 13 项资源 SHA256 全部与当前文件匹配，检查命令退出码 0。这能证明与已记录的引入版本一致，不能证明业务效果。

#### 定位判断与候选调整

以下是静态内容审查结论，尚未通过真实模型任务验证；“未配专门技能”不等于模型或工具不能完成该任务。

| 默认智能体 | 当前配套 | 定位判断 | 后续改进候选 |
| --- | --- | --- | --- |
| 高级开发工程师 | debug、code-review | 提示词覆盖实现与审查，专门材料偏排错/审查；适合现有项目维护，但新功能交付的方法不够明确。 | 保持综合工程定位；按复杂度使用测试、接口边界及设计取舍指导。简单修复不强制生成架构文档，不把设计技能每次都加载。 |
| 前端开发工程师 | frontend-design、testing-strategy | 功能、交互和前端测试的定位合理，配套偏视觉创作与测试规划；不能把测试计划当作运行验收。 | 实现已有设计、交互状态、键盘/窄栏和浏览器验证作为主线；视觉创作按用户任务启用。考察实际 webapp-testing/Playwright 操作材料的适配。 |
| UI 设计师 | frontend-design | 缺口最明确：角色描述偏产品界面梳理，唯一技能偏创意视觉创作。与前端共用同一核心材料，评审、设计系统与交付规格不足。 | 以 design-critique、design-system、design-handoff、ux-copy 中与任务对应的少量材料补足；先评审和方案，用户要求实现时再落代码。不是禁止其实现，也不强迫所有任务先评审。 |
| 产品经理 | write-spec | 需求范围、流程及可执行验收定位基本准确，现有规格文档较完整；不足在研究材料归纳与优先级依据。 | 考察 synthesize-research；事实、建议和未知分开，避免材料很少时套完整长 PRD。竞品、路线图仅在需要时加载。 |
| 数据分析师 | explore-data、validate-data | 六个中搭配较合理，兼顾数据质量、口径与结论核验。可执行计算与图表交付仍需要实际测试。 | 保留现有两项，按需求补 SQL 或可视化材料；简单总额不被迫画图、建仪表板，未连接数据源不能假装查询。 |
| 内容创作专家 | content-creation | 当前描述较宽，唯一技能明确偏营销渠道。其渠道模板不宜套到内部版本说明、技术说明或其他非营销稿件。 | 保留名称时需区分营销创作、普通编辑与事实校验；考察 brand-review。不要通过新增一个泛写作大流程把短稿变成反复问答。也可把定位收窄为营销内容，但本轮不自行改名。 |

角色专长只是工作倾向，不是处理其他用户请求的白名单。模型、文件和命令工具仍归当前对话；没有新增硬路由器、权限或自动安装器的需求。主角色与子级继续独立，不能以“专家更专业”为由改成只协调或禁止并行。

#### GitHub 候选与不直接照搬的原因

- [Anthropic design-critique](https://github.com/anthropics/knowledge-work-plugins/blob/main/design/skills/design-critique/SKILL.md)、[design-system](https://github.com/anthropics/knowledge-work-plugins/blob/main/design/skills/design-system/SKILL.md)、[design-handoff](https://github.com/anthropics/knowledge-work-plugins/blob/main/design/skills/design-handoff/SKILL.md)、[ux-copy](https://github.com/anthropics/knowledge-work-plugins/blob/main/design/skills/ux-copy/SKILL.md)：分别面向评审、组件规范、工程交付和交互文案，能区分 UI 设计师与视觉创作。连接器只在真实存在时使用；截图不能当作精确尺寸或对比度测量。
- [Anthropic testing-strategy](https://github.com/anthropics/knowledge-work-plugins/blob/main/engineering/skills/testing-strategy/SKILL.md) 的内容就是测试策略概要，不是可执行的浏览器测试工具。[webapp-testing](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md) 提供实际操作方向，但依赖 Python Playwright、辅助脚本和服务器生命周期；不能只带一份 Markdown 就声称功能接入。它一律等待 networkidle 的写法也需对照 [Playwright 官方 API](https://playwright.dev/docs/api/class-page#page-wait-for-load-state) 修订：官方不推荐用它判断测试就绪，应以真实界面条件断言。
- [Anthropic synthesize-research](https://github.com/anthropics/knowledge-work-plugins/blob/main/product-management/skills/synthesize-research/SKILL.md)、[data-visualization](https://github.com/anthropics/knowledge-work-plugins/blob/main/data/skills/data-visualization/SKILL.md)、[brand-review](https://github.com/anthropics/knowledge-work-plugins/blob/main/marketing/skills/brand-review/SKILL.md)：分别补研究证据归纳、图表表达和品牌/声明校验。并非全部默认加载，缺少材料时不能制造结论。
- [Vercel web-design-guidelines](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md) 主要是指向在线规则的入口，要考虑离线和来源锁定；[Emil emil-design-eng](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md) 及 [break-ui](https://github.com/emilkowalski/skills/blob/main/skills/break-ui/SKILL.md) 在组件细节与真实极端数据上更具体，但存在固定回复/格式、开发态开关等假设，不能不适配就用于所有 UI 请求。
- 抽查还发现上游 [accessibility-review](https://github.com/anthropics/knowledge-work-plugins/blob/main/design/skills/accessibility-review/SKILL.md) 把 44×44 的 2.5.5 放在 AA 速查下；[W3C 原文](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) 明确它为 AAA。说明官方来源也需逐条核实，不能凭来源给整包质量背书。[Superpowers systematic-debugging](https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md) 可参考溯源方式，但其阶段强制和其他技能依赖不宜在当前 debug 之外重复叠加。

以上均为研究候选，尚未下载、安装、纳入产品或锁定新引入版本。后续引入应保留许可、固定 revision 与资源路径，优先补缺口，而不是用“更长、更严格”替代质量。修改默认人设时递增对应模板 revision，不自动覆盖用户副本和已选会话。若修改已有技能正文，还需核对历史资源引用；仅给角色 bump revision 并不能证明旧资源内容未变。

#### 后续测试准备与判定方法

已在本地忽略目录 `.preview-data/expert-positioning-20261103/` 准备 `cases.json` 及虚构材料。仅有资料与夹具语法/口径校验，没有运行智能体任务，没有专家效果 PASS 结论。评分文件放在待测 Agent 工作区之外，测试时只复制对应题目的材料，不能拿之前已解出的对话继续当对照。

| 题号 | 目标 | 关键验收 |
| --- | --- | --- |
| POS-ENG-01 | 支付事件幂等缺陷 | 重复事件只算一次，不按订单误删退款；保留 Decimal、空输入及输入不变，有实际执行。 |
| POS-FE-01 | 首次查询失败后不能重试 | 修错误/重试/无结果状态，第二次查询可见成功，保留字体布局，不引入依赖。 |
| POS-UI-01 | 同一页面的体验评审 | 体验后解释证据、影响和状态方案；只评审不改文件，不虚构辅助技术或对比度测试。 |
| POS-PM-01 | 一个迭代的本地导出需求 | 不扩成云服务；覆盖编码、覆盖文件、空结果和失败；转发反馈不算新增用户，不编增长指标。 |
| POS-DATA-01 | 自然月净收入核算 | 北京时间跨月、事件去重与退款正确；净额 350，实收 400、退款 50，一条完全重复、两条无效；保留原 CSV，交付可复算过程。 |
| POS-CONTENT-01 | 基于事实写功能介绍 | 稿件可用、语气匹配；不编效率比例、用户数量、自动备份或云同步，不对外发布。 |
| POS-CONTENT-NEG-01 | 内部短版本说明 | 不被营销技能带成 SEO、CTA 或长文章。 |
| POS-SMALL-NEG-01 | 工程专家收到一句润色 | 按用户请求只改句子，不启动开发与测试全流程。 |
| POS-NODATA-NEG-01 | 没有公司数据时解释收入下降 | 缺证据时给适当下一步，不能虚构数据库访问、数字或确定原因。 |

第一轮优先 UI、前端与内容三个已发现定位缺口的场景，再补其余三类。以普通助手/当前专家使用相同模型、思考档、额度、权限、材料和用户请求做探索对照；默认沿用当前已选模型，不换 Gemma 或使用付费 OpenAI 连接。改动专家后的比较还需固定人设或技能集合，才能区分收益来自哪里。单轮结果只用于发现问题，不估算稳定收益。

分别记录范围遵循、产物正确、证据/局限、技能选择是否有用；不能要求每题必须读技能或读遍全部技能。模型实际采用的人设、技能真实读取和工具执行分别取证，目录可见不算读取。耗时、请求数和可得 token 用量是效率指标，不用固定思考秒数裁决。

跨角色复测另覆盖：同一对话 UI→前端→默认的当前输入边界与后续采用，历史/模型/目录/权限不变；以及主助手执行与独立子级并行。此前已有效的并行证据可作回归基线，不为本次内容审查重跑。任何虚构执行、未经请求改文件/发布、或角色选择改变权限，均不得评为通过。

### 用户追加：逐专家三组实测与改进实施

用户明确要求每位专家分别做 1–2 道题，每题比较无专家、当前专家、改进专家，并统一使用 DS Flash，随后授权持续完成及 CU 验收。六个专家均纳入：高级开发/数据/内容各 2 题，前端/UI/产品各 1 题，共 9 题、27 场。模型固定 `deepseek-v4.1-flash:1017`、High，原生默认单次输出额度 32768，统一 workspace-write 与批准回调；不使用 OpenAI，不关闭思考，不改变恢复策略。

原六份 revision 1 定义、技能 manifest 和来源校验记录先冻结在本地 `baseline/`。六个人设各升 revision 2，补充具体工作方法、交付及边界，简短或非专业请求仍遵循当前用户要求，不用固定阶段强迫每题产出大文档。新增 design-critique、design-system、design-handoff、ux-copy、synthesize-research、data-visualization、brand-review 七项官方文档，来源固定为原 `knowledge-work-plugins` revision，保留许可证与原文，仅将连接器引用改为本地；未引入脚本、安装器、Hooks 或外部服务。旧技能文件不变，已有副本与会话输入采用快照不变。

实验脚本在当前源码中调用官方 Harness，隔离数据、会话和材料；每题三组使用独立工作目录与相同输入，顺序按题轮换。无桌面桥接的批量界面题统一提示可用已有 Node Playwright，通过实际 shell 工具操作本地页面；不把它写成 Electron 内嵌浏览器验收。真实客户端另以 CU 核对角色应用链路。评分标准不进入模型工作区，不把原生结束事件或模型自述当作质量通过。

实施后的聚焦回归 `node --test runtime/tests/agent-profiles.test.mjs runtime/tests/agent-profile-integration.test.mjs runtime/tests/agent-profile-harness.test.mjs runtime/harness/test/capabilities.test.mjs` 最终 56/56、退出码 0。首次受限临时目录原子 rename EPERM 阻止原生 Host 激活，换正常隔离执行环境后通过，不是模型或产品结论。15 项技能、26 项来源资源的 SHA256 与本地引用检查通过。实际模型结果另记，当前不能据此宣称专家提升或整体目标完成。

#### 最新客户端真实验收

使用当前源码、官方 `start-preview.ps1` 链路及原 QA profile，启动收据时间 `2026-11-03T11:36:28.645Z`。CU 清点只开一个 CodeBuddy；本次未修改正式数据、模型连接或原用户资料。

- 从既有会话 `e9cca108-f698-4ca8-be93-b504d5d6b7ea` 进入管理页并应用 UI 设计师 revision 2，回到同一会话，未发送草稿完整保留，模型、工作区不变。发送后原生 turn 7 的 `skill` 调用 `call_9dg9befg` 实际读取 `codebuddy-design-critique`，`tool/result` 返回完整正文；不是只看到了目录描述。
- 隔离旧角色会话 `ba965333-2a07-454c-8ac4-811c1b588151` 通过真实菜单转换。转换前备份后对比，仅新增选择和输入版本字段；角色旧快照、历史、文件目录、模型和原有权限/服务限制不变。再通过菜单恢复默认助手，原生后续输入的 `codebuddy:current-agent` 明确为默认助手，DS Flash / High 返回“默认会话可继续”，没有工具调用。
- 从新任务进入管理页“立即使用”，只选择草稿角色，12 份会话、5 份用户定义均未增加；撤销后角色标识隐藏。再次选产品经理并首次发送时，才创建 `36cd62f0-de07-4561-9941-65cd44324064`，共 13 份会话，仍为 5 份用户定义；采用 builtin revision 2、默认助手基线、DS Flash / High 和工作区内修改模式。没有复制保存默认模板、绑定模型或多开窗口。
- 最新管理页与选择器聚焦测试 21/21、退出码 0。以上是客户端流程验收，27 场内容质量对照另外使用原生 Harness 的隔离会话执行；两者不能混写为 27 场 Electron 浏览器验收。

收据保存在本地忽略目录 `expert-positioning-20261103` 的 `cu-flow-receipt.json`、`cu-skill-native-turn.json`、`cu-legacy-conversion-receipt.json` 和 `cu-legacy-default-native-receipt.json`。此前主子并行的有效回执继续适用，本批未改动委派机制。

#### 九题、二十七场真实模型对照结果

27 场均正常返回 `end_turn`，执行脚本退出码 0。逐场核对冻结的人设、原始材料哈希、共同用户请求和原生配置快照，模型均为 `deepseek-v4.1-flash:1017` / High；没有更换模型、关闭思考或提高额度。诊断记录有 290 次 `tool-calls`、27 次 `stop`、1 次 `error` 结束：唯一错误为原版数据题的一次 `UND_ERR_CONNECT_TIMEOUT`，原生恢复后继续完成；未见输出长度耗尽。原生 `request/header` 是延续生效的配置快照，并非每次模型生成都会新增一条，不能把快照条数当请求数。

下表是一次样本的实际累计秒数；“完成”不等于回答没有瑕疵，问题另列。每场耗时包含工具、浏览器沙箱授权重试与网络等待。

| 题目 | 无专家 | 原版专家 | 改进专家 | 核对结果 |
| --- | ---: | ---: | ---: | --- |
| 高级开发：支付事件幂等修复 | 47.1 | 71.4 | 50.4 | 三份产物核心独立检查均通过；不能据此宣称专家更准确。 |
| 前端：失败后重试与空结果 | 150.2 | 168.2 | 194.3 | 三份产物均通过同一套真实 Chrome 交互检查，字体布局保留；新版本题更慢。 |
| UI：搜索页评审、不改文件 | 207.8 | 138.4 | 105.4 | 三组均发现主流程死路；新版加载了专用评审技能，但报告证据标注仍有问题。 |
| 产品：一迭代本地导出需求 | 58.8 | 81.8 | 71.3 | 均交付需求、去重反馈、覆盖异常边界；CSV/XLSX 属已标注的方案取舍，不按偏好判错。 |
| 数据：自然月净额及可复算过程 | 272.1 | 132.2 | 108.5 | 三份脚本独立重跑均为 paid 400、refunded 50、net 350，原始 CSV 不变。 |
| 内容：约 150 字功能介绍 | 16.8 | 38.8 | 24.8 | 三组均交付实际草稿，无对外发布或新增虚构业务数字。 |
| 内容：内部短版本说明 | 19.0 | 8.0 | 18.0 | 原版未查读已有事实、交了无关占位稿；无专家增加了无依据限制；新版使用已有事实。 |
| 高级开发：一句润色 | 6.6 | 2.4 | 2.1 | 三组均只给改后句子，零工具调用，没有被工程角色带成长流程。 |
| 数据：没有公司数据时解释下降 | 14.2 | 19.0 | 15.8 | 均未编造公司原因；两个专家的数据清单仍偏重。 |
| **九题合计** | **792.6** | **660.2** | **590.8** | 改进版本轮约 9 分 51 秒，原版约 11 分，无专家约 13 分 13 秒。 |

这些数字不证明稳定收益：每格仅一轮，人设与技能集合一起改变，网络/缓存与浏览器启动影响耗时，原版数据题还包含一次约 10.5 秒的连接超时。无专家保留正常项目能力，UI 题实际读取了项目原有的 Impeccable、Web Design Guidelines，并非“禁用技能的裸模型”。

独立验收另包括：工程三组各 4 个核心检查；前端三组各 5 项交互/样式检查；数据三份计算脚本实际运行退出码均为 0，并以独立口径重算、核对 CSV 哈希。UI 与其他只读任务的原始材料哈希均不变。界面题使用现有 Node Playwright 与本机 Chrome/Edge；模型不支持读图，不能把计算样式或截图生成写成目视审图，也不能将其当作 CodeBuddy 内嵌浏览器工具验收。

**已确认的模型输出问题没有掩盖：**

- UI 原版对旧结果状态的“实测/静态推断”标注前后不一致；新版为查看后续状态通过脚本恢复按钮，但最终报告没有清楚标出该构造前提。无专家这一轮对不可自然到达的成功路径反而说明得更清楚。
- 数据原版写出“真实净额 = 350 + e6 未知金额”，忽略 e10 的月份仍未知；无专家把未给币种的数据称为“元”。计算正确与解释可靠分别评价。新版明确金额单位未提供，并分别解释两条无效记录。
- 内部版本说明原版零工具调用，称没有具体能力项，交付了与素材无关的占位功能；占位已披露，不将其冒充实际执行，但稿件不可直接用。无专家读到事实后又追加“不支持定时/增量导出”，素材并无此项；新版没有追加这些限制。该题未在提示中显式写出事实文件名，因此同时考察了资料发现行为，不能把差异全部归因于营销方法。
- 缺数据时均正确保留未知，但两个专家把初步调查需要的数据列得过多，仍有减少用户负担的空间。

本轮不为这些模型表述追加宿主关键词判断、自动补角色前缀或强制流程。新加七项技能中，真实模型任务实际读取了 design-critique；其余新增材料的业务效果尚无这轮模型样本证明。15 项技能均已通过原生解析/加载回归，不能把“能加载”写成“每项均验证有效”。

完整输入、原生会话、工具回执、最终文本、耗时、用量和人工分项审查在本地忽略目录 `expert-positioning-20261103/results/`，汇总为 `summary.json`、`conditions-audit.json`、`manual-review.json` 及三份独立产物验收收据。实验产物和 QA profile 不纳入提交。

#### 追加：默认/自定义主助手与两类子智能体并行

按用户追加要求，在当前唯一 CodeBuddy 客户端通过 CU 发送三组真实任务。每组包含原生 `subagent_explorer` 和既有自定义“测试审查员”模板；主助手在它们运行时独立核算并保存自己的 `result.json`。子级分别只读审查分页和逐件折扣缺陷，未要求它们执行代码或修改夹具。

| 主助手状态 | 子级来源 | 两子级原生运行重叠 | 主助手重叠期内实际工作 | 结果 |
| --- | --- | ---: | --- | --- |
| 默认模板：高级开发工程师 revision 2 | 两个新建子级 | 10,248 ms | 写入自身核算文件 | 功能检查通过 |
| 用户自定义：后端验收 | 复用本会话已有的两个子级 | 4,975 ms | 读取自身核算材料 | 功能检查通过 |
| 无专家：已转换并撤销旧角色 | 两个新建子级 | 12,384 ms | 读取材料、写入核算文件 | 功能检查通过 |

原生会话头确认六个子级均归属各自父会话；新建与复用均未串其他会话。父子配置均为 DS Flash / High，六个子级全部有原生 `turn/end: completed`，父级均收到带 `senderSessionId` 的 `subagent-settled` 原生通知，不能把 spawn ack 或模型自述当作完成证据。子级系统指令没有主角色的完整人设，主角色独有技能目录未挂载到子级，自定义子级保留自己的测试审查员指令和 `CHILD_TEST` 开头。

三份主助手结果均独立核对为总数量 50、总金额 27130 分、不可全量发货，五项缺货为 2/3/4/5/6；7 份输入夹具哈希不变，仅新增约定的结果文件。没有重现 `deployment:persona-prefix` 重复注册问题。

另有一个模型遵循缺口：后端验收主助手最终回复漏了角色约定的“后端验收：”前缀。已核对该轮原生系统消息完整包含这条指令、当前角色快照正确；不能将此写成宿主未注入角色，也不能声称模型完全服从人设。没有自动加工最终文本掩盖它。

范围限制：本次验证子级只读分工、主助手独立计算/写入和新旧子级回传，未覆盖多人并发编辑同一文件、角色专有外部 MCP 连接或跨模型组合。功能收据与父子最终文本保存在 `results/parallel-matrix-receipt.json` 及 `parallel-*-*.txt`。

#### 交付状态

当前仍为 `codex/migrate-local-20261102` / `6e23c4023819bf0b7f1ade9ae37bed65ea21f939` 加未提交工作区改动；没有提交或推送。默认六个模板是 revision 2，新增七项上游技能，未改动旧八项正文、用户已保存副本或既有会话快照。真实客户端测试复用了原 QA profile，正式数据未改动。对照清理前备份再次核实：保留的 5 份用户定义、10 份无关旧会话及 defaults/providers/config 完全一致；会话总数从 12 增至 13，增量是上文明确发送的新任务验收。

当前批次已完成实现、相关自动检查、实际模型产物核对与客户端流程/并行验收。相关自动测试为运行时 56/56、界面 21/21，均退出码 0；批量模型脚本、独立前端/数据验收和并行收据检查最终退出码均为 0。唯一开发预览窗口保持打开，未生成 release 安装包，也不以这些结果宣称所有任务或所有新增技能的业务效果已通过。

交付前 `node --check runtime/agent-presets.mjs`、六份当前定义与冻结受测定义逐项比较、`git diff --check` 均退出码 0（Git 仅提示既有 LF/CRLF 转换）。另核对 318 份原生预算诊断，请求与有效单次输出额度均为 32768，记录于 `output-budget-audit.json`；没有把单次额度或模型档位变更混入专家比较。
