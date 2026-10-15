# CodePro 完整开发执行 Implementation Plan（Codex 版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. If the user explicitly authorizes parallel sub-agents, `subagent-driven-development` may be used only for independent tasks. Steps use checkbox (`- [ ]`) syntax for tracking.

> **2026-08-07 修订：** MVP 已收缩为核心可安装演示闭环；完整 Git/gh 迁移、Provider/MCP 全矩阵和 24 小时浸泡移至 Beta/RC。补充 Planner 容错、宿主文件事实、结构化终态报告、分析报告占位符、Coordinator 渐进切换和默认稳定组合门禁。Codex 当前 Windows 桌面环境可访问项目并执行真实桌面验收，不把工具能力误判为外部平台限制。

> **2026-08-07 仓库治理决定：** 当前为单人开发，唯一开发主线为 `main`。Codex 不得自行创建分支或 worktree；只有用户明确批准后才能创建。历史候选分支在生成仓库外恢复包后清理，后续功能按“实现—验证—小提交”直接进入 `main`。

> **2026-08-07 Codex 对标修订：** Codex 的公开事实是跨 CLI、App、IDE 与 Cloud 的产品体系，并具备沙箱、审批、diff、终端日志、测试结果和可选 sub-agent；这些产品行为不能反推 OpenAI 私有研发流程。CodePro 采用“核心闭环、成熟工具复用、按风险分级的 Agent 流程和自然证据”，拒绝“为了提速删除安全/证据”以及“所有任务固定四角色/固定并行度”两种极端。

> **2026-08-10 GitHub 交付体验修订：** CodePro 不再把自建 GitHub PR 表单、直接 GitHub API 客户端和 GitHub App 注册作为 MVP 主路径。桌面端保留用户可见的“交付”入口、Diff、PR/检查状态、确认与恢复提示；本地执行复用官方 `git`/`gh` CLI，可选 GitHub MCP 只作为扩展；GitHub App、Webhook 和 Actions 自动化后置到有明确云端触发需求的版本。旧实现按“适配器接管—观测回退—弃用—物理删除”迁移，禁止直接删除仍被 CI/workflow/artifact 共用的类型和辅助函数。

**Goal:** 将 `D:\CodeBuddy` 从当前工程基线持续开发为可安装、可恢复、可审计的 Windows 编程 Agent 产品，并依次交付 MVP、稳定 V1、并行 Agent、高级工具与企业级发布能力。

**Architecture:** CodePro 采用 Electron/React 桌面端、Rust Agent/ACP 后端和持久化控制平面。所有系统操作都通过类型化适配器进入权限、路径边界、审计和脱敏链路；Git/GitHub 主路径复用官方 `git` 与 `gh` CLI，浏览器、桌面、凭据存储、更新与测试优先复用成熟方案。开发按纵向用户功能切片推进，每个切片必须完成自动化验证和与功能级别匹配的真实用户验收后，才能进入下一切片。

**Tech Stack:** Rust 2021、Tokio、serde、ACP/MCP、Electron 41、React 19、TypeScript 5.9、Vite 7、Vitest 4、Playwright 1.58、Node.js 24、pnpm 10、Windows、Git CLI、GitHub CLI。

## Global Constraints

- 项目根目录固定为 `D:\CodeBuddy`；执行任何命令前先确认 `git rev-parse --show-toplevel` 返回该目录。
- 单人开发阶段只维护 `main`；不得自行创建分支或 worktree。确有隔离、并行或高风险实验需要时，先向用户说明目的、生命周期和清理方式并取得明确批准。
- 本文档是唯一的开发总控清单；Codex 每次只执行“执行队列”中第一个未完成任务，不跳过失败门禁。
- 当前工作区包含用户已有修改；不得执行 `git reset --hard`、强制检出、批量删除或覆盖未知修改。
- 非机械设计变更必须先比较当前 Codex 的可观察行为与 OpenAI 官方资料，记录采用项、拒绝项和理由；不得推测 Codex 私有实现。
- Codex 的公开产品行为、开源实现和 OpenAI 内部研发流程是三个不同概念；只能把前两者作为可验证参考，不得把产品发布时间、技术栈或界面行为写成内部团队开发事实。
- 遇到非简单设计或技术问题，先查官方文档、GitHub 活跃项目和项目现有实现；核对许可证、维护状态、Windows 兼容性、安全边界和集成成本后再选择。
- 成熟能力优先复用。Git 用 `git` CLI，GitHub 用 `gh` CLI，可选 GitHub MCP；禁止因为已有自建代码而继续扩大重复实现。
- 禁止把模型生成的字符串直接交给 shell。所有外部命令必须使用固定 executable、结构化 argv、allowlist、超时、取消、输出上限、脱敏和审计。
- 后端逻辑必须先写失败的单元或集成测试；API/CLI 先自动化再手动验证；UI 先组件测试再真实桌面验收；跨模块功能必须完成完整用户流程。
- 只有功能本身涉及桌面操作时才使用电脑控制验证底层动作；其他模块在用户可见纵向切片完成后，用真实窗口、鼠标和键盘做端到端验收。
- 每个行为变更至少保存候选提交、changed files、实际测试命令、退出码、结论、限制和回滚点；截图、完整日志、独立 Reviewer 和完整 manifest 按风险分级要求采集。环境不可用写为 `ENVIRONMENT_UNAVAILABLE`，不得伪造通过，也不得为低风险修改机械生成空证据文件。
- 同一模块的新回归未解释、自动化门禁未通过或真实验收未完成时，不得开始下一模块。
- 自动继续是默认行为；只有账号/Token/证书、付费或对外发布、远端推送、重要数据删除、重大产品分歧、三轮排查仍无法推进、或必须由用户完成的验收才暂停询问。
- 模块内部默认自动继续；完成 Windows MVP 后必须生成经理演示证据并暂停一次，由用户决定进入 Beta/RC、调整范围或发布。Beta/RC 和 GA 对外发布前同样必须确认。
- 每个任务开工前写明行动预算、外部 API/模型预算和回滚点；执行结束更新“当前任务指针”，使后续 Codex 无需依赖完整对话历史即可续跑。
- 每个独立功能通过后在 `main` 创建一个小提交；不得积累长期分支，不得提交凭据、构建缓存、用户数据或测试仓库中的秘密。
- 文档中的历史测试数字不能代替当前候选提交的重新执行结果；`NOT_MEASURED` 不能解释为通过。
- 任何“完成/通过/已修复”声明必须由宿主状态、退出码、文件快照或审计事件支持；模型措辞不能改变事实。
- 任何写入工具（shell、Python、编辑器、脚本、MCP）都必须进入统一文件事实采集；不能只依赖内置 `write/edit` 事件。
- 公开开发预览、Windows MVP、Windows Beta、RC 和 GA 是不同发布级别；README、UI、报告和发布记录必须使用同一枚举，不得把源码预览写成 Beta。

---

## 1. 给 Codex 的启动指令

将下面这段话与本文档一起交给 Codex：

```text
你负责持续完成 D:\CodeBuddy。先完整读取：
1. D:\CodeBuddy\AGENTS.md
2. D:\CodeBuddy\documentation\AGENTS.md
3. D:\CodeBuddy\documentation\codebuddy\CodePro完整开发执行文档-Codex版-2026-08-06.md

从“执行队列”第一个未完成任务开始。先重新采集事实和建立失败测试，再做最小实现。
一个模块只有在自动化测试、真实用户验收和证据记录都完成后才能标记完成并进入下一模块。
不要重复造轮子；非简单设计先查官方资料、GitHub 成熟项目和当前 Codex 的公开/可观察做法。
默认连续执行，不要每完成一步就询问我；仅在文档列出的暂停条件出现时提问。
不得破坏或覆盖工作区中不属于当前任务的修改。
```

## 2. 执行状态与事实口径

### 2.1 状态定义

| 状态 | 含义 |
|---|---|
| `DISCOVERED` | 代码或分支存在，但尚未证明可用 |
| `IMPLEMENTED` | 已进入当前分支，发布证据不完整 |
| `HISTORICAL_PASS` | 过去在特定提交通过，当前候选提交尚未重跑 |
| `VERIFIED_CURRENT` | 在当前候选提交重新执行并取得证据 |
| `ENVIRONMENT_UNAVAILABLE` | 缺少凭据、设备、网络或外部服务，未形成产品结论 |
| `BLOCKED` | 已满足暂停条件，必须获得用户或外部输入 |
| `RELEASED` | 候选提交、签名产物、证据清单和发布记录一致 |

只有 `VERIFIED_CURRENT` 可以关闭开发任务，只有 `RELEASED` 可以关闭发布任务。

### 2.2 2026-08-07 重新采集的当前快照

| 项目 | 事实 | 使用限制 |
|---|---|---|
| 分支 | `main` | 唯一开发主线；执行时重新确认 |
| HEAD | `868b9698cb179704be9a241ce59aaf3aa5da0e8c` | 快照事实；任务开始时重新采集，不使用本文值代替当前 HEAD |
| 相对 `origin/main` | 快照时一致 | 推送前重新计算，且必须为可解释的线性更新 |
| 工作区 | 快照时 clean | 任务开始和提交前都重新执行 `git status --short` |
| Windows 安装包 | `ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Setup.exe`，253,443,584 bytes，2026-08-06 09:00:28 | 仅证明存在产物，不证明可发布 |
| Rust 聚焦门禁 | `cargo check -p goose --tests` 曾在 `787b4f2e68` 通过并有 8 个 dead-code 警告 | `HISTORICAL_PASS` |
| 桌面聚焦门禁 | workspace 相关 2 个文件、7 个测试曾在 `787b4f2e68` 通过 | `HISTORICAL_PASS` |
| U-82 Slice 1～7 | 主要实现已进入分支 | 安装态、恢复和发布证据仍需重跑 |
| U-82 Slice 8 | Provider、24 小时浸泡、安全审查、RC manifest 未闭环 | `NOT_MEASURED` |
| 附加 worktree | 3 个历史 detached worktree，均位于 `D:\CodeBuddy-Workspaces\`；其中 `202607275` 和 `202607275-eee...` 含未提交修改，`202607275-9ce...` clean | 不属于当前 MVP 开发主线，但两处仍含教务系统相关代码；必须先生成可恢复清单，未经用户授权不删除 |

### 2.3 已确认的主流程问题

真实用户从 D 盘会话输入“开发一个教务管理系统到 E 盘”时，曾被路由成只读分析；策略拒绝又被展示成“用户拒绝”。现有证据指向意图标记、分类失败降级、绝对路径 workspace 契约和错误语义四个环节。E 盘曾被成功写入，因此不得把“E 盘不可写”当作已证实根因。

### 2.4 已确认问题与本轮处理顺序

以下不是“以后再优化”的一般建议，而是当前 Windows Beta 之前必须收敛的可靠性缺口：

| 优先级 | 已观察问题 | 根因边界 | 本文档中的处理门禁 |
|---|---|---|---|
| P0 | Planner 输出带 `json` 前缀、Markdown fence、截断或空内容时直接失败 | 过度依赖一次严格 JSON，缺少受控修复和降级 | CP-03 Step 2～4：多形态提取、schema 校验、单任务降级、失败证据 |
| P0 | shell/Python/外部脚本写入没有稳定产生 `FileChanged`，报告因此自相矛盾 | 文件事实绑定了少数工具事件，而不是宿主工作区 | CP-01、CP-03：前后快照、Git diff、非 Git 路径扫描和路径归一化 |
| P1 | Tester 失败只能重试 Tester，不能把根因交回 Coder 或 Coordinator | 固定重试替代了主 Agent 的恢复判断 | CP-03、CP-09：失败分类、修复回路、预算和终态收敛 |
| P1 | 终态报告把命令聚合当成事实；普通项目分析仍可能出现“详见技术证据”占位符 | 报告管线和分析管线未共享明确的事实/渲染契约 | CP-03：`ReportFacts`、结构化 payload、占位符禁止门禁 |
| P1 | 取消粒度过大，容易整次运行一起停 | cancel token 未绑定 run/task/worker 作用域 | CP-02、CP-09：任务级取消、分支取消、late outcome 和恢复测试 |
| P2 | Git/GitHub 能力与主流程脱节 | 先做了大量自建能力，缺少成熟 CLI 的最小闭环 | CP-04A 先做最小 `gh`，CP-04B 再迁移完整矩阵 |

顺序固定为：先修事实和终态可靠性，再扩展 GitHub、并行 Agent、电脑控制和企业能力。任何扩展不得绕过 P0/P1 门禁。

### 2.5 Project、Session、Run 与 Worktree 边界

当前 `createCodeProProjectWorkspace` 在会话工作目录是磁盘根目录时，会按提示词和时间戳创建新的 `CodeProProjects/<name>-<timestamp>`。如果每次提交后会话仍停留在 `D:\` 或 `E:\`，就会把每个任务误认为新项目，导致目录膨胀和历史混乱。这不是用户需要的默认行为。

参考 Codex 的公开产品模型：Project 绑定一个用户选择的真实文件夹或 Git 仓库；多个 thread/session 复用同一个 Project；Worktree 只用于并行或隔离任务。CodePro 采用以下四层模型：

| 对象 | 语义 | 默认行为 |
|---|---|---|
| `Project` | 用户真实项目根目录和稳定身份 | 用户选择已有目录或明确选择“新建项目”时创建；同一规范化路径只能有一个 Project |
| `Session/Thread` | 一次对话、上下文和显示历史 | 可以复用已有 Project；创建新对话不创建新目录 |
| `Run` | 一次执行尝试、状态、证据和报告 | 每次任务创建 Run，但默认复用 Project 根目录 |
| `Worktree` | Git 分支隔离或并行执行目录 | 只有用户开启隔离/并行或策略要求时创建；完成后归档，不自动污染 Project 列表 |
| `Scratch` | 临时构建、下载或测试产物 | 放在受控临时目录，不能冒充 Project，也不能进入最近项目列表 |

必须遵守：

1. 普通任务提交不得自动创建新的项目目录；`prepareCodeProSubmission` 只绑定已选 Project 和 Run。
2. 当前目录是磁盘根目录时，首次 CodePro 操作应显示“选择已有项目 / 新建项目 / 暂不绑定项目”，而不是静默创建目录。
3. `D:\CodeProProjects\<name>-<timestamp>` 只能作为用户明确选择“新建项目”时的默认建议路径。
4. Project 注册表持久化 `id`、显示名、规范化绝对路径和最近使用时间；最近项目按规范化路径去重。
5. 已存在的 `CodeProProjects` 子目录不得自动删除；提供“导入为项目”和“归档”操作，物理删除必须另行确认。
6. 默认稳定组合使用当前 Project 直接执行；Worktree 放入高级设置，并在任务卡中显示隔离路径、分支和清理状态。

该模型与 Codex 的公开工作流一致：项目是稳定的文件夹边界，thread 是会话边界，worktree 是可选的并行隔离边界；不得把三者合并成“每条消息一个工作区”。

### 2.6 MVP 风险分级与 Agent 拓扑

MVP 不把角色数量当作质量本身。角色表示能力和责任边界，不等于每次都必须启动一个独立模型会话。宿主先根据写入范围、外部副作用、跨模块程度和发布影响确定最低执行级别；模型只能建议升级，不能降低宿主判定的级别。

| 级别 | 典型任务 | 默认 Agent 流程 | 最低验证与证据 |
|---|---|---|---|
| `L0_READ_ONLY` | 解释代码、项目分析、查状态 | 主 Agent 直接调用只读工具 | 引用实际文件/命令；没有写入、测试或完成声明时不创建任务证据目录 |
| `L1_REVERSIBLE_CHANGE` | 单文件、小配置、局部 Bug 修复 | 主 Agent 或单 Coder → 自动测试 → diff 自审 | changed files、聚焦测试命令与退出码、diff 摘要、限制和回滚点 |
| `L2_FEATURE` | 多文件功能、API/CLI、后端与 UI 纵向切片 | Planner/Coordinator → Coder → 独立 Tester；按风险增加 Reviewer | 失败测试、聚焦与回归门禁、用户场景；用户可见功能做真实应用验收 |
| `L3_HIGH_RISK_RELEASE` | 权限、凭据、删除、远端写入、更新、安装包、发布 | Planner → Coder → Tester → 独立 Reviewer，由宿主强制门禁 | 完整审计、独立审查、安全/回滚证据、真实环境或安装态 E2E、发布 manifest |

升级规则：写范围未知、出现跨项目路径、远端副作用、权限边界、凭据、迁移、安装/更新或发布时至少升一级；任何发布动作固定为 `L3_HIGH_RISK_RELEASE`。降级规则只允许在宿主确认任务范围缩小且没有已发生的高风险 effect 时执行。用户始终可以要求更严格流程。

固定四角色不是 MVP 的默认成本。`Planner/Coder/Tester/Reviewer` 仍作为兼容协议和高风险能力保留，但简单任务不得为了“看起来完整”重复调用模型、生成空报告或创建无价值 worktree。无论采用哪一级，文件事实、退出码、权限和最终状态始终由宿主掌握。

## 3. 成熟方案复用与研究规则

### 3.1 默认技术选择

| 需求 | 默认复用方案 | CodePro 仍需实现的部分 | 禁止做法 |
|---|---|---|---|
| 本地版本控制 | 官方 `git` CLI | 类型化参数、路径保护、权限、审计、错误映射 | 重写 Git 协议或让模型拼接 shell |
| GitHub PR/CI/Workflow | 官方 `gh` CLI；可选 GitHub MCP | CLI 探测、登录状态解析、JSON 模型、授权、脱敏、迁移 | 因 GitHub App 注册受阻继续扩大自建 API |
| 浏览器自动化 | Playwright；诊断用 DevTools | 安全代理、权限卡、用户可见进度、审计 | 自写浏览器协议或依赖 DOM 强改模拟用户 |
| Windows 桌面验收 | Codex computer-use/Windows UI Automation | 安全测试账户、截图、日志、恢复脚本 | 用组件测试冒充真实桌面验收 |
| 密钥保存 | Windows Credential Manager/现有安全存储 | 生命周期、作用域、脱敏、撤销 | 明文配置、日志输出 Token |
| JSON/协议校验 | Rust serde、TypeScript zod、现有 ACP/MCP 类型 | 版本化契约、未知字段策略、迁移 | 手写脆弱字符串解析 |
| 更新与安装 | Electron Forge、Squirrel、electron-updater | 签名、升级/回滚、残留策略、证据 | 自建更新协议 |
| 隔离开发 | `git worktree` | 会话所有权、锁、清理、冲突和恢复 | 复制整个仓库作为并行隔离方案 |
| 监控 | Rust tracing、electron-log、结构化事件 | 统一关联 ID、脱敏、指标和导出 | 无界日志或把用户源码写入遥测 |

### 3.2 非简单设计的研究记录

每次非简单设计前都要完成下列研究记录。默认把简短结论内联到任务 `summary.md` 的“研究与复用”小节；只有内容较长、需要独立审阅或涉及外部工具/协议选型时才单独创建 `research.md`，避免同一结论重复成文档。

```markdown
# Research record
- 问题：一句话描述设计问题
- 当前项目证据：文件、函数、测试和运行结果
- Codex 对比：公开文档或可观察行为；明确哪些只是观察
- 候选方案：名称、官方链接、许可证、最近维护情况、Windows 支持
- 采用：选中方案与理由
- 拒绝：未采用方案与理由
- 风险：安全、迁移、维护和回滚
```

优先参考：

- OpenAI Codex app-server：[官方仓库说明](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- OpenAI Codex MCP interface：[官方接口文档](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)
- GitHub CLI：[PR](https://cli.github.com/manual/gh_pr)、[Actions](https://cli.github.com/manual/gh_run_list)、[认证](https://cli.github.com/manual/gh_auth_status)
- Git 官方文档：[git-scm.com/docs](https://git-scm.com/docs)
- MCP 官方规范：[modelcontextprotocol.io](https://modelcontextprotocol.io/)
- Playwright 官方文档：[playwright.dev/docs](https://playwright.dev/docs/intro)

博客只能帮助发现方案，最终接口和安全判断必须回到官方文档、源码或可重复实验。

### 3.3 Codex 对比的使用边界

参考 Codex 时只采用公开且可重复观察的产品行为，不假设其私有调度器、团队结构、后端技术栈或发布决策。当前可验证资料包括：[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)、[Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)、[Codex 的可验证输出](https://openai.com/index/introducing-codex/)和[Codex App 的沙箱与授权](https://openai.com/index/introducing-the-codex-app/)。这些资料证明产品能力，不证明 OpenAI 内部“如何开发 Codex”。

因此 CodePro 的实现选择如下：

| 公开且可观察的 Codex 行为 | CodePro 采用 | CodePro 拒绝/不推断 |
|---|---|---|
| CLI 在本地仓库检查、编辑并运行已安装工具 | 优先复用 `git`、`gh`、测试框架和包管理 CLI，并通过类型化适配器治理 | 不重写成熟协议，也不把模型字符串直接交给无限制 shell |
| 主 Agent 根据工具结果继续、改计划或停止 | Coordinator 先以 advisory mode 提供恢复建议，再按资格门禁切 authoritative mode | 不声称复刻 Codex 私有 planner 或内部提示词 |
| sub-agent 用于可独立拆分的复杂工作 | 只有依赖已满足、write scope 不重叠且预算允许时并行 | 不把 sub-agent 当每个任务的必经步骤，不固定启动数量 |
| 用户可以查看 diff、终端日志、测试和失败信息 | 宿主生成最小 `ReportFacts`，Git diff、命令和退出码作为自然证据 | 不接受“Codex 没证据”这一错误前提，也不为低风险任务复制整套空证据 |
| Codex 有沙箱、审批、规则和工作区边界 | 保留 CodePro 权限、路径、脱敏和审计硬边界，同时压缩普通用户看到的授权复杂度 | 不以追求速度为由删除安全层，不把 UI 简单误解为底层没有治理 |
| Codex 覆盖 CLI、App、IDE 和 Cloud | MVP 只选择 Windows 桌面核心闭环，接口为以后扩展保留 | 不在 MVP 同时追逐所有 Codex 产品表面，不推断其私有后端技术栈 |
| 真实应用行为需要真实验收 | Electron 窗口、鼠标、键盘和磁盘结果一起验收 | 不用组件测试冒充桌面完成 |

任何设计记录必须写明“公开观察”“项目实测”或“推测”，三者不能混写。

### 3.4 GitHub 交付能力：保留体验，复用成熟执行层

#### 3.4.1 事实、观察与项目判断

| 类别 | 可验证依据 | 对 CodePro 的结论 |
|---|---|---|
| 公开事实：GitHub CLI | `gh pr create` 已覆盖 base/head、title/body、body file、draft、模板、reviewer 和 maintainer edit；`gh pr checks --json` 可返回检查状态；`gh run` 覆盖 workflow 查询与操作 | 不再自建同等 GitHub API 表单和协议客户端；用类型化 CLI 适配器消费稳定输出 |
| 公开事实：Codex | Codex 官方资料把本地 diff/review、终端结果和 Git 仓库状态作为主要交付界面；GitHub 集成用于云端 PR review | 采用“本地工作区审查 + 远端状态入口”，不推断 Codex 私有 GitHub 实现 |
| 公开事实：Claude Code | 官方命令和技能示例使用 `gh pr view`、`gh pr diff` 等本地命令；Web/GitHub Actions 路径另用 GitHub App/Action | 本地与云端分层，MVP 不因未来云端自动化引入 GitHub App 阻塞 |
| 公开事实：Hermes | 官方 PR review 教程要求安装并认证 `gh`；MCP 文档把 GitHub 作为外部工具服务器，强调无需先写原生工具 | CLI 为默认依赖，MCP 为可选能力，不把 MCP 变成 MVP 硬依赖 |
| 项目实测 | 当前 `GitHubPullRequestPanel.tsx`、ACP GitHub 请求和 `github_auth/pull_requests.rs` 已形成自建 PR 链路；其中部分类型/辅助函数被 CI、workflow 和 artifact 路径复用 | 可以替换 PR 专属 UI/API，但物理删除前必须先提取共享依赖并完成调用图和回归验证 |
| 环境实测（2026-08-10） | 当前开发终端执行 `gh --version` 返回 command not found，尚不能进行真实 GitHub CLI 验收 | 这是 CP-04A 的环境前置条件，不是 CodePro 项目 Bug；先提供安装/定位/登录引导，再执行 fixture 与用户授权的远端验收 |
| 项目判断 | 用户仍需要看见“是否已推送、PR 在哪里、检查是否通过、下一步怎么做” | 删除重复表单不等于删除用户能力；保留轻量“交付”页和自然语言入口 |

采用：

- 本地 Git 统一调用官方 `git` CLI；GitHub PR、checks 和 workflow 统一调用官方 `gh` CLI。
- CodePro 只实现产品差异化层：任务上下文、Diff/Review、受控命令、风险确认、状态投影、错误恢复、审计和中文用户体验。
- GitHub MCP 作为用户显式安装的可选适配器；只有 CLI 不适用且 MCP 通过资格验证时使用。
- 未来云端事件触发、组织级自动审查或无桌面在线运行需要 GitHub App/Webhook/Actions 时，建立独立 Cloud 模块和 ADR，不回填进 MVP 本地适配器。

拒绝：

- 拒绝继续扩展自建 PR 创建表单、OAuth/GitHub App 注册依赖和直接 GitHub API 功能矩阵。
- 拒绝把 PR/CI 区域整个删除后只留下聊天文本；这会让用户无法快速确认远端状态和恢复失败。
- 拒绝同时运行 CLI、MCP 和旧 API 三套默认主路径；同一能力必须有唯一默认适配器和明确 fallback。
- 拒绝用 Shell 字符串拼接标题、正文、分支名或远端 URL；所有命令必须使用固定 executable 和结构化 argv。

官方参考：

- [OpenAI Codex Code Review](https://learn.chatgpt.com/docs/code-review)
- [OpenAI Codex GitHub Integration](https://learn.chatgpt.com/docs/third-party/github)
- [Claude Code commands](https://code.claude.com/docs/en/commands)
- [Claude Code IDE integration](https://code.claude.com/docs/en/ide-integrations)
- [Hermes GitHub PR Review Agent](https://hermes-agent.nousresearch.com/docs/guides/github-pr-review-agent)
- [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [GitHub CLI PR create](https://cli.github.com/manual/gh_pr_create)
- [GitHub CLI PR checks](https://cli.github.com/manual/gh_pr_checks)

#### 3.4.2 用户体验与界面边界

现有“拉取请求”和“持续集成”标签逐步合并为一个轻量“交付”页。该页面不是 GitHub 网页的复制品，只展示用户完成当前任务所需的信息：

```text
交付

当前分支：feature/example
远端状态：已推送 / 未推送 / 无远端
Pull Request：#128 已打开 / 尚未创建
检查状态：5 通过 / 1 失败 / 2 进行中

[预览并创建 PR]  [查看失败检查]  [在 GitHub 打开]
```

交互规则：

1. 没有 PR 时，Agent 根据实际 `git diff`、提交和项目上下文生成标题与说明；用户可在执行预览中修改或取消，不要求先填写固定大表单。
2. 点击“预览并创建 PR”只生成本地预览，不产生远端副作用；最终确认后才允许 push 和 `gh pr create`。
3. 已有 PR 时默认展示编号、标题、状态、URL 和检查摘要；详细讨论、reviewer、labels、merge queue 等高级操作打开 GitHub 处理。
4. `gh` 未安装、未登录、无 remote、无权限或网络失败时，页面必须显示具体恢复动作；不得隐藏整块功能，也不得误报为 CodePro 无权访问文件系统。
5. CI 的 MVP 范围只读：展示 required checks 和失败链接；rerun、cancel、dispatch 和 artifact 下载进入 CP-04B，并按远端副作用要求确认。
6. 键盘焦点、屏幕阅读标签、窄屏布局和中英文文案必须与任务/文件页一致。

#### 3.4.3 类型化命令映射

| 用户能力 | 默认命令 | 输出策略 | 风险级别 |
|---|---|---|---|
| 判断仓库/分支/远端 | `git rev-parse --show-toplevel`、`git branch --show-current`、`git remote get-url origin` | 解析确定性文本；路径和 remote 脱敏 | 只读，默认允许 |
| 查看工作区和 Diff | `git status --porcelain=v2`、`git diff --no-ext-diff` | 有界输出；大 Diff 保存受控临时文件并生成摘要 | 只读，默认允许 |
| 检查 GitHub 环境 | `gh --version`、`gh auth status` | 退出码 + 结构化错误模型；不得记录 Token | 只读，默认允许 |
| 查询当前 PR | `gh pr view --json number,title,state,url,headRefName,baseRefName` | serde 解析 JSON；未知字段向前兼容 | 只读，默认允许 |
| 查询 PR checks | `gh pr checks --json bucket,name,state,link,workflow` | 使用 `bucket` 区分 pass/fail/pending/skipping/cancel | 只读，默认允许 |
| 推送当前分支 | `git push -u origin HEAD` | 记录 remote、ref、退出码和不确定副作用 | 远端写入，必须确认 |
| 创建 PR | `gh pr create --base <base> --title <title> --body-file <file>`，按需增加 `--draft`/`--no-maintainer-edit` | 正文使用受控临时文件或 stdin；成功提取 URL | 远端写入，必须确认 |
| 打开 GitHub | `gh pr view --web` 或打开已验证的返回 URL | 只允许 `https` 和已确认 GitHub host | 外部应用跳转，用户触发 |
| 重跑/取消 CI | `gh run rerun`、`gh run cancel` | CP-04B 实现幂等键、超时和 uncertain effect | 高风险远端写入，必须确认 |

执行器必须以 `Command::new(executable).args(argv)` 等价方式调用，禁止经过 `cmd /c`、PowerShell 字符串或模型生成脚本。分支名、base、repo、host 和 URL 先经 allowlist/格式校验；标题和正文不得进入日志；临时正文文件使用受管目录、最小权限并在确定终态后清理。

#### 3.4.4 迁移与删除边界

迁移分四步进行：

1. **接管：** 新 CLI 适配器覆盖 auth、PR 查询、PR 创建和只读 checks，旧路径保留 feature flag，仅用于可观测回退。
2. **收缩 UI：** 用“交付”页替换自建 PR 表单；保留状态、预览、确认、失败恢复和 GitHub 跳转。
3. **迁移共享能力：** CP-04B 把 CI/workflow/artifact 迁到 `gh`，并从 `github_auth/pull_requests.rs` 提取仍被复用的 repository、Git 探测、错误和常量。
4. **退役：** 至少两个候选版本无回退、遥测/本地审计无旧路径调用且回归通过后，单独删除 PR 专属 ACP contract、React 表单和直接 API 客户端；历史 ADR 保留并标记 superseded/deprecated。

禁止直接删除整个 `github_auth/pull_requests.rs` 或 `github_*.rs`：必须先用 `rg`/调用图确认 CI、workflow、artifact、测试和序列化契约已迁移。删除属于独立任务，必须有编译、契约测试、桌面验收和可恢复提交。

## 4. 测试与真实用户验收总门禁

### 4.1 分级测试矩阵

| 变更类型 | 必须执行 | 是否要求鼠标验收 |
|---|---|---|
| Rust 算法、状态机、协议、校验 | 失败单测 → 最小实现 → 聚焦测试 → crate 回归 | 不要求；除非形成用户可见纵向切片 |
| ACP/API/CLI | 契约/集成测试 → 真实命令关键路径 → 错误映射 | 用户可见工作流完成时要求 |
| React UI | 组件测试、typecheck、lint → 真实 Electron | 要求真实窗口、鼠标、键盘 |
| 后端 + UI + 系统交互 | 上述全部 → 安装态端到端 | 必须要求 |
| 电脑控制功能 | 权限与适配器测试 → 隔离桌面真实动作 | 必须要求，且验证真实鼠标/键盘结果 |
| 文档 | 链接、命令、路径、编码和 Markdown 检查 | 不要求 |

### 4.2 每个用户可见模块的桌面验收流程

- [ ] 关闭或记录所有由 `D:\CodeBuddy` 启动的旧 Electron/goose 进程，避免连错后端。
- [ ] 从当前源码重新构建后端和桌面端；发布候选任务必须使用当前候选安装包。
- [ ] 启动真实 CodeBuddy 窗口，记录版本、commit、后端 PID 和日志目录。
- [ ] 用 computer-use 或 Windows UI Automation，通过真实鼠标点击和键盘输入完成任务卡规定的用户场景。
- [ ] 验证界面结果、磁盘结果、Git 状态、重启恢复、错误信息和审计记录一致。
- [ ] 截取开始、关键确认、成功/失败终态和重启后状态；截图不得包含 Token 或私密源码。
- [ ] 把命令、退出码、截图、日志摘要和结论写入 `documentation/codebuddy/evidence/<task-id>/<candidate-commit>/`。
- [ ] 若电脑控制工具不可用，标记 `BLOCKED` 或 `ENVIRONMENT_UNAVAILABLE`；不得仅凭组件测试关闭模块。

### 4.3 通用自动化门禁

按变更范围选择聚焦门禁，阶段候选必须执行完整门禁：

```powershell
cargo fmt --all -- --check
cargo check -p goose --tests
cargo test -p goose --lib --jobs 1
cargo test -p goose --tests --jobs 1
pnpm --dir ui/sdk lint
pnpm --dir ui/sdk test
pnpm --dir ui/desktop typecheck
pnpm --dir ui/desktop lint:check
pnpm --dir ui/desktop test:run
pnpm --dir ui/desktop test:distribution
pnpm --dir ui/desktop test-e2e
git diff --check
```

失败必须分类为 `PROJECT_REGRESSION`、`PRE_EXISTING_FAILURE`、`ENVIRONMENT_FAILURE` 或 `FLAKY_UNCONFIRMED`，并附复现证据。不能把环境故障写成产品 Bug，也不能用“历史上通过”覆盖当前失败。

### 4.4 结果报告与分析报告的事实契约

终态报告和普通项目分析报告必须分开验收，但共享同一套宿主事实原则：

1. 宿主先生成 `CodeProReportFacts`，至少包括 `terminal_outcome`、run/task 状态、changed files、verification summary、命令退出码、review 状态、limitations、recovery action 和 evidence IDs。
2. 前端消费结构化 `TurnTerminal` payload 渲染徽章、计数、路径和过滤项；Markdown/自然语言只是展示层，不能成为下游唯一数据源。
3. LLM 只负责受约束的措辞改写：不得改变状态、数字、路径、命令、退出码、证据 ID 或 limitation。一次 bounded call 失败、超时或校验失败时，回退到同结构的宿主模板。
4. 严格校验结构化字段和禁止性声明：`completed/通过/全部通过/已修复` 等完成语言必须对应宿主状态；所有 limitation 必须保留；证据 ID 必须真实存在。
5. 普通项目分析不得输出 `【详见技术证据】`、`详见技术证据` 或空的技术证据占位符。若没有证据，直接写“未采集到技术证据”并给出下一步；若有证据，必须在当前报告中内联摘要或提供真实可展开引用。
6. 失败报告必须带用户可执行的恢复动作：规划失败、调度失败、评审失败、环境失败和用户取消不能共用一句泛化错误。

验收样例至少覆盖：成功、部分完成、暂停、取消、规划失败、调度失败、评审失败、普通分析无证据、普通分析有证据，以及 LLM 改写失败回退。报告中任何事实矛盾都属于 `PROJECT_REGRESSION`，不能以“模型表达差异”关闭。

## 5. 文件与模块边界

| 责任 | 主要位置 |
|---|---|
| 意图分类与单/多 Agent 执行 | `crates/goose/src/agents/codepro_intent.rs`、`agent.rs`、`task_dag.rs`、`planner_agent.rs` |
| authoritative workspace | `crates/goose/src/agents/codepro_workspace.rs`、`ui/desktop/src/codepro/projectWorkspace.ts`、`prepareCodeProSubmission.ts` |
| 控制平面 | `crates/goose/src/agents/control_plane/`、`crates/goose/src/acp/server/codepro_control.rs` |
| 终态报告与证据 | `crates/goose/src/agents/codepro_terminal_report.rs`、`codepro_report.rs`、`result_aggregator.rs` |
| 权限与审计 | `crates/goose/src/permission/`、`crates/goose/src/tool_inspection/`、`ui/desktop/src/acp/adapter/toolAudit.ts` |
| Git 工具 | `crates/goose/src/agents/platform_extensions/git.rs`、`crates/goose/tests/codepro_git_tools.rs` |
| 现有 GitHub 能力 | `crates/goose/src/github_auth/`、`crates/goose/src/acp/server/github_*.rs`、`ui/desktop/src/components/codepro/GitHub*.tsx` |
| 记忆 | `crates/goose/src/agents/platform_extensions/codepro_memory.rs`、`project_memory.rs`、`chatrecall.rs` |
| 电脑与浏览器工具 | `crates/goose/src/agents/platform_extensions/computer.rs`、`crates/goose/tests/codepro_computer_tools.rs` |
| 桌面 CodePro UI | `ui/desktop/src/codepro/`、`ui/desktop/src/components/codepro/` |
| Windows 构建/生命周期 | `scripts/build-codebuddy-windows.ps1`、`scripts/test-codebuddy-windows-*.ps1`、`.github/workflows/codebuddy-windows.yml` |
| 发布证据 | `documentation/codebuddy/evidence/`、RC manifest 与验证报告 |

新增文件必须围绕一个责任组织；禁止把 CLI、权限、审计、UI 和业务状态继续堆进单个大文件。

## 6. 执行队列

严格按以下顺序执行。方框只在任务卡全部门禁通过并记录证据后勾选。MVP 只追求可安装、可演示、可回滚的核心闭环，完整迁移和发布级资格不得反向阻塞 MVP。

**Windows MVP：**

- [x] CP-00 冻结最小可解释代码基线
- [x] CP-01 修复自然语言变更意图与跨盘 workspace 主流程
- [x] CP-02 拆分拒绝、越界、取消和环境错误语义
- [x] CP-03 资格化分级 Agent 开发—测试—评审—报告闭环
- [x] CP-04A 用最小 `gh` CLI 路径解除 GitHub App 阻塞
- [x] CP-05A 资格化一个默认 Provider
- [ ] CP-06A 完成 Windows MVP 安装态冒烟与重启恢复
- [ ] CP-07 生成 Windows MVP 与经理演示证据

**Beta/RC：**

- [ ] CP-04B 完成策略控制的 `git` / `gh` CLI 全量迁移
- [ ] CP-05B 完成 Provider、模型和外部 MCP 支持矩阵
- [ ] CP-06B 完成升级、回滚、24 小时浸泡、安全审查和 RC 证据

**稳定 V1 与企业能力：**

- [ ] CP-08 整合 session/worktree 隔离能力
- [ ] CP-09 整合并行 Agent 协议、调度、取消和恢复
- [ ] CP-09A 将并行度改为主 Agent 自主决策
- [ ] CP-10 交付并行 Agent 桌面体验
- [ ] CP-11 完成长短期记忆、上下文预算和隐私控制
- [ ] CP-12 完成受控电脑与浏览器操作
- [ ] CP-13 完成稳定性、性能、可观测性和故障恢复
- [ ] CP-14 完成安全加固和供应链治理
- [ ] CP-15 完成企业 RBAC、SSO、策略和审计导出
- [ ] CP-16 发布稳定 V1/GA 并建立持续发布机制

### 6.1 当前任务指针

每次交接只更新这一小节和对应证据包；Codex仍需遵守全局约束，但续跑时首先读取此处，不必依赖上一段对话。

| 字段 | 当前值 |
|---|---|
| 当前阶段 | Windows MVP |
| 当前任务 | CP-07（CP07-0/1/2 候选冻结与证据初始化） |
| 状态 | `P0_GREEN_44_OF_44 / REVIEWER_PENDING / CP07_AUTOMATION_PARTIAL / FORMAL_BUILD_NOT_RUN`；精确 win32-x64 package 与 x64 Squirrel installer 选择 P0 已修复并通过 fresh distribution gate。CP-06A live 安装验收仍为 `USER_ACCEPTED_RISK_WAIVER / DEFERRED_NOT_RUN`，不是 `PASS`；缺少前一安装包回滚件，当前未授权公开发布 |
| Candidate commit | 尚未创建；当前候选为 `f9b1119f53e93e17fb8d8486d5d0374dc458695d` + `candidate-file-manifest.tsv` 的 237 个精确记录（184 tracked diff + 53 approved untracked）；权威哈希只记录在 CP-07 manifest，避免 tracked 文档形成自引用 |
| 最近证据 | `documentation/codebuddy/evidence/CP-07/1.43.0-working-tree/source-freeze.md`、`mvp-evidence-manifest.json`、`automated-tests.md` 与 `release-decision.md`（草案） |
| 下一动作 | 等待第二 P0 的独立 reviewer verdict；`APPROVE` 前不得给最终 GO。获批后以重建后的精确 allowlist 完成其余 CP-07 自动化门禁，再决定是否执行一次正式 build/package。正式 build 当前 `NOT_RUN`；禁止自动进入 Beta/RC 或公开发布 |
| 回滚点 | `main` / `origin/main` 均为 `f9b1119f53e93e17fb8d8486d5d0374dc458695d`；仓库外恢复包位于 `D:\CodeBuddy-Recovery\CP-00-2026-08-08` |
| 行动/API 预算 | CP07-0/1/2 仅执行本地只读审计、哈希与证据写入；真实 Provider 请求 0，凭据读取 0，外部 GitHub/API 写入 0，branch/commit/push/PR/Release 0。CP-07 自动化门禁尚未执行 |

## 7. 逐模块可执行任务卡

### Task CP-00: 冻结最小可解释代码基线

**Files:**
- Modify only after audit: `.gitattributes`
- Create: `documentation/codebuddy/evidence/CP-00/<candidate-commit>/baseline.md`
- Update: `documentation/codebuddy/CodePro完整开发执行文档-Codex版-2026-08-06.md`

**Interfaces:**
- Consumes: 当前 Git 工作区、候选分支、锁文件、构建工具链。
- Produces: 唯一 candidate commit、代码影响差异表、文档汇总清单、工具链清单和可重复测试基线。

- [x] **Step 1: 采集无副作用基线。** 执行 `git status --short --branch`、`git rev-parse HEAD`、`git rev-list --left-right --count main...HEAD`、`git diff --stat`、`git ls-files --others --exclude-standard`，保存原始输出。
- [x] **Step 2: 只逐项审计会影响编译、运行、测试、打包和提交的差异。** tracked 代码/配置及 untracked 代码/配置逐项标记；`documentation/codebuddy` 只保留 `CURRENT.md` 指向的权威文档和角色契约，重复历史文档在外部备份后清理。
- [x] **Step 2A: 审计现存 worktree。** 对 3 个 `D:\CodeBuddy-Workspaces\202607275*` detached worktree 分别记录 HEAD、工作区状态、相对 `main` 的独有提交和可恢复内容；已确认其中两处含未提交的教务系统代码，不得因目录数量多而批量删除。完成 Git bundle/patch/文件清单等仓库外恢复包后，向用户提交逐项保留或清理建议并等待授权。
- [x] **Step 3: 保护用户修改。** 未知归属内容不得删除、覆盖或纳入功能提交；若它阻止建立候选基线，满足暂停条件后请求用户决定。
- [x] **Step 4: 验证换行问题。** 对显示变化的 ACP 文件比较 `git diff --ignore-space-at-eol`；仅在证据证明为换行噪声时修订 `.gitattributes`，不得重写语义文件。
- [x] **Step 5: 记录工具链。** 保存 `rustc -Vv`、`cargo -V`、`node -v`、`pnpm -v`、`git --version`、`gh --version` 和锁文件哈希。
- [x] **Step 6: 建立当前失败基线。** 执行通用自动化门禁，逐项分类失败，保存完整退出码；不在本任务顺手修复无关失败。
- [ ] **Step 7: 选择 candidate commit。** 只有所有代码影响差异都有归属，且运行源码能追溯到该提交时，才记录 canonical baseline；未跟踪历史文档保持只读保留状态即可。
- [ ] **Step 8: 提交。** 若仅修复换行规则，提交 `chore: freeze CodePro integration baseline`；证据文件与任务清单状态一并提交。

**Rollback:** 不修改未知用户文件；若 `.gitattributes` 调整引入额外差异，只回退该独立提交。文档与历史分支清理前生成仓库外 Git bundle、补丁和文档压缩包。

**Acceptance:** 不存在未知的代码影响修改；当前源码、测试结果和候选提交可追溯；同一门禁连续两次结果一致或波动已有可复现实验；本地和远端开发分支收敛为 `main`；3 个历史 detached worktree 均有保留/恢复/清理结论且没有未经授权删除；CodePro 顶层文档只有权威集合。

### Task CP-01: 修复自然语言变更意图与跨盘 workspace 主流程

**Files:**
- Modify: `crates/goose/src/agents/codepro_intent.rs`
- Modify: `crates/goose/src/agents/agent.rs`
- Modify: `ui/desktop/src/codepro/projectWorkspace.ts`
- Create: `ui/desktop/src/codepro/startCodeProSession.ts`
- Create: `ui/desktop/src/components/codepro/WorkspaceConfirmationCard.tsx`
- Modify: `ui/desktop/src/components/BaseChat.tsx`
- Test: 同目录 Rust 测试、`projectWorkspace.test.ts`、`startCodeProSession.test.ts`、`WorkspaceConfirmationCard.test.tsx`
- Modify: `ui/desktop/tests/e2e/codebuddy-user-journey.spec.ts`

**Interfaces:**
- Consumes: 用户文本、当前会话目录、可选绝对目标路径。
- Produces: `conversation | read_only | test | change | clarify` 意图，以及经用户确认的 authoritative workspace。

- [x] **Step 1: 写失败意图测试。** 覆盖“开发一个教务管理系统到 E:\AcademicManagementSystem”“创建/新建/搭建/实现一个”等中文表达，期望 `change`，同时保留“分析为什么失败”为 `read_only`。
- [x] **Step 2: 运行聚焦测试确认失败。** 执行 `cargo test -p goose codepro_intent --lib --jobs 1`，保存失败用例名称。
- [x] **Step 3: 最小修复确定性标记。** 只扩充有边界的 change 词组和路径信号；显式只读约束仍必须优先。
- [x] **Step 4: 写分类器失败测试。** 模型输出无效时，要求返回透明 `clarify` 或带原因的受控降级，禁止无提示伪装成正常只读任务。
- [x] **Step 5: 写跨盘路径测试。** 覆盖盘符根、目标目录不存在、已存在空目录、非空目录、相对路径、UNC、junction、junction 下不存在子目录、大小写和尾随分隔符。
- [x] **Step 6: 实现 Project 选择和持久绑定。** 选择已有目录时复用同一个 Project；当前目录为磁盘根目录时显示“选择已有项目 / 新建项目 / 暂不绑定项目”，不得因提交一条消息自动创建新目录。
- [x] **Step 7: 实现 workspace 预览和一次确认。** 标准化后展示 Project 根目录、解析后的真实位置、是否新建、是否隔离、权限范围和 Run ID；确认后会话、任务、工具和恢复都绑定同一个 Project/workspace ID/path。
- [x] **Step 8: 建立统一文件事实采集。** 在运行前后记录 authoritative workspace 的文件清单和摘要；Git 项目使用 `git status/diff`，非 Git 项目使用受限目录扫描；shell、Python、脚本和 MCP 写入必须通过同一采集器归并，禁止只依赖 `FileChanged` 事件。
- [x] **Step 9: 验证路径归一化和项目去重。** 事件、报告、审计和前端全部使用同一绝对路径；同一规范化路径只能有一个 Project；不存在目标使用“最近存在父目录 realpath + 剩余片段”生成 identity，确认时必须在创建前复核并在创建后再次比较；禁止用 session working directory 覆盖工具实际写入路径；跨盘、junction、UNC 和大小写差异必须得到一致结果。
- [x] **Step 10: 运行 Rust 与前端聚焦门禁。** 执行 Project registry、文件事实测试及对应前端测试；结果已收敛到 CP-01 `summary.md`。
- [x] **Step 11: 运行真实用户验收。** 从 D 盘项目启动候选开发桌面；因机器没有 E 盘，使用 C 盘精确目标完成等价跨盘场景。连续任务复用同一目录，并验证现有 Git、间接写入、任务结果、测试证据、路径不漂移、junction alias/canonical 一致性和重启恢复。
- [x] **Step 12: 验证新建、隔离和拒绝路径。** 组件/E2E 覆盖新建与隔离契约；真实鼠标确认 Worktree 保持关闭，取消时 alias 与 canonical 目标均零写入，只有确认后才创建并绑定解析后的精确目标目录。
- [ ] **Step 13: 提交。** 使用 `fix: bind CodePro runs to persistent projects`。

**Acceptance:** 原始用户语句在真实 Windows 桌面完成端到端写入；未确认前零写入；junction 别名不能绕过预览 identity 或在确认时漂移；重启后 authoritative workspace 不漂移。

### Task CP-02: 拆分拒绝、越界、取消和环境错误语义

**Files:**
- Modify: `crates/goose/src/acp/server.rs`
- Modify: `crates/goose/src/permission/`
- Modify: `ui/desktop/src/acp/adapter/toolAudit.ts`
- Modify: `ui/desktop/src/acp/adapter/permissions.ts`
- Modify: `ui/desktop/src/acp/adapter/legacyCodeProActivityAdapter.ts`
- Modify: `ui/desktop/src/components/codepro/codeProPresentation.ts`
- Test: 对应 Rust 与 TypeScript 测试

**Interfaces:**
- Consumes: 宿主事实 `policy_denied | user_denied | outside_workspace | forbidden | cancelled | environment_failure`。
- Produces: 协议终态、用户文案、审计结果三者一一对应。

- [x] **Step 1: 建立失败契约表测试。** 每个宿主事实断言唯一状态码、是否可重试、用户动作和中文展示。
- [x] **Step 2: 运行测试并确认当前混用。** 分别执行权限、ACP terminal、toolAudit 与 presentation 聚焦测试。
- [x] **Step 3: 在后端建立封闭枚举。** 禁止通过自由文本推断拒绝原因；legacy 文本只能在兼容适配器中转换并标记来源。
- [x] **Step 4: 更新前端投影。** `policy_denied` 显示策略阻止，`user_denied` 显示用户未授权，`outside_workspace` 显示工作区越界，`cancelled` 显示任务已取消。
- [x] **Step 5: 验证审计一致性。** 同一 run ID 的后端事件、卡片、终态报告和审计详情必须显示相同原因。
- [x] **Step 6: 真实桌面验收。** 用鼠标分别触发允许、用户拒绝、越界、取消；验证文案和磁盘副作用。
- [ ] **Step 7: 提交。** 使用 `fix: preserve CodePro denial and cancellation semantics`。

**Acceptance:** 不再出现“策略阻止”被显示为“用户拒绝”；每个失败都给出准确、可操作且不泄漏敏感信息的说明。

### Task CP-03: 资格化分级 Agent 开发—测试—评审—报告闭环

**Files:**
- Modify as defects require: `crates/goose/src/agents/task_dag.rs`
- Modify as defects require: `crates/goose/src/agents/planner_agent.rs`
- Modify as defects require: `crates/goose/src/agents/result_aggregator.rs`
- Modify as defects require: `crates/goose/src/agents/codepro_terminal_report.rs`
- Test: `crates/goose/tests/codepro_task_graph.rs`、控制平面与结果收敛测试
- Test: `ui/desktop/src/components/codepro/*.test.ts*`

**Interfaces:**
- Consumes: change 任务、authoritative workspace、工具权限。
- Produces: 宿主判定的 `L0`～`L3` 执行级别、与风险匹配的 Agent 任务图、最终项目修改和事实型终态报告。

- [x] **Step 1: 固定风险分级失败测试。** 覆盖只读分析、单文件可逆修改、多文件功能、权限/凭据/远端写入和发布任务；证明 `L1` 不会无意义启动四角色，`L2` 至少有独立 Tester，`L3` 必须有独立 Reviewer，模型输出不能降低宿主级别。同时覆盖空 `read_scope` 不等于缺失项目、空 `write_scope` 表示不写入且不与其他任务重叠。
- [x] **Step 2: 添加 Planner 解析测试。** 覆盖合法 JSON、`json` 前缀、Markdown fence、前后解释文本、截断、空响应、未知字段和恶意附加文本；每种失败都要记录原始响应摘要、解析阶段和结构化错误，禁止把空结果伪装成正常分析。
- [x] **Step 3: 实现分层解析与受控降级。** 依次做 fence/前缀剥离、首个完整对象/数组提取、schema 校验和字段默认值填充；仍失败时用更简单的 fallback prompt；连续失败后只能降级为宿主允许的单任务 change 流程或 `clarify`。涉及 `L3` 风险时禁止因为 Planner 失败而降为单 Agent 直接执行。
- [x] **Step 4: 做最小实现修复。** 保持宿主掌握任务状态、测试退出码、文件事实和审计事实；LLM 只生成计划、代码建议和受约束报告文案。任何模型输出不能决定“完成/通过”。
- [x] **Step 5: 验证取消、失败恢复与预算。** 在 Coder、Tester、Reviewer 阶段分别取消、超时、重试和重启；Tester 失败时允许 Coordinator 判断“修复 Coder/重跑测试/改变方案/停止”，但受重试、Token、时间和工具调用预算约束。
- [x] **Step 6: 运行分级端到端。** 在 fixture 中分别执行“修改一个按钮文案”与“增加一个带验证和测试的用户注册接口”：前者验证 `L1` 单 Agent/单 Coder 快速闭环，后者验证 `L2` Planner/Coordinator、Coder、独立 Tester，以及触发风险条件后增加 Reviewer。两者都验证间接文件写入、测试和事实报告。
- [x] **Step 7: 验证两条报告管线。** 终态报告必须引用 `ReportFacts` 和结构化 payload；普通项目分析不得出现 `【详见技术证据】` 占位符，LLM 改写失败必须稳定回退到模板。
- [x] **Step 8: 用真实桌面查看活动卡。** 鼠标展开任务、证据、评审和报告；文案不得宣称未执行的测试通过，失败必须给出恢复动作。
- [ ] **Step 9: 提交。** 使用 `fix: qualify CodePro risk-tiered delivery loop`。

**Acceptance:** 简单可逆修改不会承担固定四角色成本；跨模块功能具有独立测试，高风险/发布任务具有独立审查；一个普通用户需求能完成修改、验证、事实报告和恢复，终态报告中的每个结论都能追溯到宿主证据。

### Task CP-04A: 用最小 gh CLI 路径解除 GitHub App 阻塞

**Files:**
- Create: `crates/goose/src/github_cli/mod.rs`
- Create: `crates/goose/src/github_cli/models.rs`
- Modify: `crates/goose/src/acp/server/github_auth.rs`
- Modify: `crates/goose/src/acp/server/github_pull_requests.rs`
- Modify: `ui/desktop/src/components/codepro/CodeProTaskPanel.tsx`
- Replace or reduce: `ui/desktop/src/components/codepro/GitHubPullRequestPanel.tsx`
- Test: 新增 `gh` 探测、认证、PR 查询/创建、只读 checks 和错误 fixture 测试
- Test: 新增“交付”组件测试和真实桌面用户流程

**Interfaces:**
- Consumes: authoritative workspace、Git diff/提交、仓库 remote、用户执行预览和远端写入授权。
- Produces: `gh` 可用性、登录状态、当前 PR/required checks 摘要、PR 创建结果和可操作恢复建议；MVP 不实现 rerun/cancel/dispatch/artifact。

- [x] **Step 1: 写最小 ADR 和旧实现调用图。** 明确 CLI 为本地主路径、MCP 为可选扩展、GitHub App 为未来 Cloud 路径；列出 PR 专属代码和仍被 CI/workflow/artifact 共用的依赖，禁止按文件名整块删除。
- [x] **Step 2: 先写失败测试。** 覆盖 `gh` 未安装、未登录、权限不足、无 remote、非 Git 仓库、没有当前分支、已有 PR、网络失败、输出非 JSON、命令超时和用户拒绝；不能只看退出码。
- [x] **Step 3: 实现受控 CLI 适配器。** 固定 executable/argv，支持超时、取消、输出上限、Token/remote 脱敏、审计和 uncertain effect；正文使用 `--body-file` 或 stdin，不把模型文本拼接进 shell。
- [x] **Step 4: 实现只读交付状态。** 调用 `gh pr view --json ...` 和 `gh pr checks --json ...`，输出“无 PR/已打开/已关闭/已合并”和 pass/fail/pending 摘要；只读失败不影响本地编程主流程。
- [x] **Step 5: 用“交付”页替换自建 PR 表单。** 保留分支、远端、PR、检查状态、执行预览、恢复提示和“在 GitHub 打开”；删除标题/正文/base/draft/maintainer edit 的固定大表单，必要选项进入确认预览。
- [x] **Step 6: 接入 PR 创建最小闭环。** Agent 从实际 Diff/提交生成标题与正文，用户可修改；确认前零远端副作用，确认后依次执行受控 push 和 `gh pr create`，重复执行必须识别已有 PR。
- [x] **Step 7: 本地 fixture 与组件验证。** 所有错误必须映射为具体恢复动作；用户拒绝、预览取消和无 remote 必须保持零远端副作用；验证键盘、屏幕阅读标签和窄屏布局。
- [x] **Step 8: 真实桌面/GitHub 验收。** 只有用户提供测试仓库并分别授权 push 与创建 PR 时，才通过真实窗口、鼠标和键盘完成一次创建、刷新状态和打开 GitHub；否则记录 `ENVIRONMENT_UNAVAILABLE`，但 fixture 和本地 MVP 主流程可继续。
- [x] **Step 9: 观测旧路径并提交。** 新路径默认开启，旧路径只作为 feature flag 回退并记录调用；使用 `feat: replace GitHub PR form with gh delivery flow`。本轮已完成旧路径观测；提交因用户明确禁止而记为 `NOT_PERFORMED_BY_POLICY`，未提交或推送。

**Rollback:** 一个独立 feature flag 切回旧 PR 路径；CP-04A 不物理删除仍被复用的 U-67～U-73/CI/workflow/artifact 代码。若交付页失败，回到原任务/文件页且不影响本地编辑和测试。

**Acceptance:** GitHub App 注册不再阻塞 MVP；用户不填写重复表单也能预览并创建 PR；分支、PR URL 和 required checks 在“交付”页可见；确认前零远端副作用；`gh` 缺失或未登录时显示安装/登录动作且本地 Git 核心流程始终可用。

### Task CP-05A: 资格化一个默认 Provider

**Files:**
- Modify only for reproduced defects: `crates/goose/src/providers/`
- Modify only for reproduced defects: `crates/goose/src/agents/model_router.rs`
- Test: `crates/goose/tests/providers.rs`
- Test: `ui/desktop/tests/integration/test_providers*.test.ts`
- Create: `documentation/codebuddy/evidence/CP-05A/<candidate-commit>/qualification.json`

**Interfaces:**
- Consumes: 用户现有且明确授权的一个默认 Provider/model 组合。
- Produces: MVP 核心场景资格记录。

- [x] **Step 1: 选择一个默认组合。** 优先使用用户当前已经配置且 CodePro 实际依赖的 Provider；若没有任何可用凭据则暂停询问，不扩展到全矩阵。默认组合优先成功率和稳定性：稳定模型、保守上下文/工具预算、单 Agent、串行执行、自动模板报告回退；速度、并行 Worker 和实验性模型放入高级设置。
- [x] **Step 2: 写错误分类测试。** 至少覆盖 401、429、超时和断网，确保用户文案可操作且不泄漏秘密。
- [x] **Step 3: 执行 MVP 场景。** 只读分析、单文件修改、测试执行、取消和结构化终态报告必须通过；至少重复三次，记录成功率、首个可见结果延迟、失败分类和是否触发 fallback，不能只记录一次成功截图。
- [x] **Step 4: 验证安全存储。** 重启后 Provider 可用，日志、UI 和报告中没有 API Key。
- [x] **Step 5: 真实桌面验收。** 用鼠标选择默认模型并完成一个 fixture 修改任务；高级设置关闭时验证不会自动并行、不会切换未资格化 Provider，也不会因为报告重写失败阻断任务结论。
- [x] **Step 6: 提交资格记录。** 资格记录已生成于 `documentation/codebuddy/evidence/CP-05A/cdf12eeb470b08f92b050e4ba6ccea5f52a0df87cdc1b787fa7fe89cf574dbe4/`，结论为 `VERIFIED_CURRENT`；Git commit 依当前策略记为 `NOT_PERFORMED_BY_POLICY`。

**Rollback:** 代码缺陷修复使用独立提交；失败时恢复上一已知可用 Provider 配置，不删除用户凭据。

**Acceptance:** 至少一个默认 Provider 在当前候选提交完成 MVP 全流程；其他 Provider 不作为 MVP 阻塞项，也不得被表示为已资格化。

### Task CP-06A: 完成 Windows MVP 安装态冒烟与重启恢复

**Files:**
- Modify: `scripts/test-codebuddy-windows-installer.ps1`
- Modify: `scripts/test-codebuddy-windows-packaged-runtime.ps1`
- Create: `documentation/codebuddy/evidence/CP-06A/<candidate-commit>/mvp-install-smoke.md`

**Interfaces:**
- Consumes: 当前候选安装包、CP-01～CP-05A 核心能力。
- Produces: 安装、首次启动、核心任务、取消和重启恢复证据。

- [ ] **Step 1: 非破坏性检查安装包。** 记录版本、commit、SHA-256、签名状态和包含的 backend；不得卸载或覆盖用户现有安装。
- [ ] **Step 2: 在隔离应用数据目录安装并首次启动。** 验证窗口、默认语言、Provider 配置入口和项目选择。
- [ ] **Step 3: 执行经理核心路径。** 创建项目 → 一句话修改 → 自动测试/评审 → 查看 diff/报告。
- [ ] **Step 4: 验证取消。** 在运行中点击取消，确认无继续写入和孤儿进程。
- [ ] **Step 5: 验证重启恢复。** 关闭并重新启动，确认项目、任务终态和报告可恢复且无重复写入。
- [ ] **Step 6: 保存截图和日志。** 所有证据脱敏并绑定候选 commit/安装包哈希。
- [ ] **Step 7: 提交。** 使用 `test: verify CodeBuddy MVP installed journey`。

**Rollback:** 测试使用隔离应用数据目录；失败时关闭候选进程并保留日志，不清理用户现有数据。安装包升级、回滚和卸载演练留给 CP-06B。

**Acceptance:** 干净测试环境可安装、首次启动并完成核心任务；取消和重启恢复无数据损坏。24 小时浸泡、升级/回滚和完整安全审查不阻塞 MVP。

### Task CP-07: 生成 Windows MVP 与经理演示证据

**Files:**
- Modify: `ui/desktop/package.json` 版本
- Modify: `CHANGELOG.md` 或项目现有发布说明
- Modify only if packaging requires: `.github/workflows/bundle-windows.yml`
- Create: `documentation/codebuddy/evidence/CP-07/<version>/release-decision.md`

**Interfaces:**
- Consumes: CP-00、CP-01、CP-02、CP-03、CP-04A、CP-05A、CP-06A 全部通过的候选提交。
- Produces: 可安装的内部 MVP、经理演示包、校验值和回滚入口。

- [ ] **Step 1: 冻结 MVP 范围。** 安装/启动、选择或创建项目、自然语言变更、`L1/L2` 分级闭环、权限/取消、Git、`gh` PR、终态报告必须可用；并行、长期记忆、电脑控制和企业功能不作为 MVP 阻塞项。
- [ ] **Step 2: 执行 MVP 相关完整门禁。** Rust、SDK、桌面、分发和核心 E2E 必须在同一候选提交执行；不等待完整 Provider 矩阵或 24 小时浸泡。
- [ ] **Step 3: 执行经理演示路径。** 真实安装 → 选择项目 → 一句话改功能 → 自动测试/评审 → 查看 diff → 提交 → 创建测试 PR → 重启恢复。
- [ ] **Step 4: 核对产物。** 版本、commit、安装包 SHA-256、签名状态和 MVP evidence manifest 一致；内部 MVP 可记录未签名限制，但不得冒充公开 RC。
- [ ] **Step 5: 生成一页经理结论。** 清楚列出能演示什么、尚未进入 MVP 的能力、已知风险和下一阶段选择。
- [ ] **Step 6: 暂停里程碑。** 向用户展示经理演示证据，由用户决定内部试用、补缺陷、进入 Beta/RC 或授权公开发布。
- [ ] **Step 7: 获得授权后发布并冒烟。** 使用实际分发产物在干净账户重做安装和核心流程。
- [ ] **Step 8: 提交发布记录。** 使用 `release: prepare CodeBuddy Windows MVP`；实际公开发布另附授权记录。

**Rollback:** 保留前一安装包和候选 commit；经理演示失败时停止分发，回到最近通过 CP-06A 的候选提交。

**Acceptance:** 新用户无需开发环境即可安装并完成核心编程任务；经理可以复现演示；出现问题可回滚到明确版本。完成后必须暂停一次，不自动进入 Beta/RC。

### Task CP-04B: 完成策略控制的 git/gh CLI 全量迁移

**Files:**
- Create: `crates/goose/src/git_cli/mod.rs`、`command.rs`、`models.rs`
- Extend: `crates/goose/src/github_cli/`
- Modify: `crates/goose/src/agents/platform_extensions/git.rs`
- Modify: `crates/goose/src/acp/server/github_ci.rs`
- Modify: `ui/desktop/src/components/codepro/CodeProTaskPanel.tsx` 与交付状态组件
- Extract shared dependencies from: `crates/goose/src/github_auth/pull_requests.rs`
- Deprecate/delete after migration: PR 专属 ACP contract、直接 GitHub API 客户端和旧 React 表单
- Test: `crates/goose/tests/codepro_git_tools.rs` 与 CLI fixture 测试

**Interfaces:**
- Consumes: CP-04A 最小路径和现有 U-63～U-73 安全逻辑。
- Produces: status/diff/clone/push、auth/PR/CI/workflow/artifact 的完整类型化 CLI 适配器，以及唯一的“交付”状态投影。

- [ ] **Step 1: 固定完整接口、调用图和迁移矩阵。** 对每个旧能力记录新 CLI 命令、JSON 模型、权限级别、审计事件、fallback 和删除条件；特别标记 `pull_requests.rs` 中被 CI/workflow/artifact 共用的类型、常量和辅助函数。
- [ ] **Step 2: 实现 Git 只读与写入路径。** status/diff/clone/push 使用结构化 argv，并保留敏感路径、冲突和 force-push 强确认。
- [ ] **Step 3: 实现 GitHub CI/workflow/artifact。** 使用 `gh --json` 可控输出，覆盖 checks、run list/view、rerun、cancel、dispatch 和 artifact metadata；只读状态可自动刷新，远端写入逐次确认。
- [ ] **Step 4: 统一交付投影。** UI 只消费一个宿主权威模型，不能分别从旧 API、CLI 输出和聊天文本猜测 PR/CI 状态；高级详情优先打开 GitHub。
- [ ] **Step 5: 做等价迁移测试。** 允许、拒绝、未登录、冲突、网络失败、企业 SSO、重复请求、超时后不确定副作用和重启恢复的功能、安全、审计必须等价。
- [ ] **Step 6: 运行真实测试仓库验收。** 用真实窗口、鼠标和键盘完成查看 PR、查看失败 checks、授权 rerun/cancel 和刷新结果；所有远端写入均需用户授权。
- [ ] **Step 7: 分阶段弃用旧实现。** 新路径连续两个候选版本无回退且审计中无旧路径调用后标记 deprecated；先提取共享依赖，再用独立提交物理删除 PR 专属 ACP contract、直接 API 客户端和旧表单，历史 ADR 不删除。
- [ ] **Step 8: 提交。** 按 Git 适配器、GitHub CI、交付投影和旧路径退役四个可恢复小提交落地。

**Rollback:** 保留 CP-04A 和旧路径 feature flag，任何等价测试失败立即切回。

**Acceptance:** 全部 Git/GitHub 能力通过 CLI 或经资格验证的可选 MCP 工作；普通用户只看见一个“交付”入口；旧 PR 表单和直接 API 主路径已退役；共享依赖没有被误删；权限、审计、错误语义和重启幂等性不退化。

### Task CP-05B: 完成 Provider、模型和外部 MCP 支持矩阵

**Files:**
- Modify: `crates/goose/src/providers/`、`model_router.rs`、`mcp_client.rs`
- Test: `crates/goose/tests/providers.rs`
- Test: `ui/desktop/tests/integration/test_providers*.test.ts`
- Modify: Provider 资格脚本
  
**Interfaces:**
- Consumes: UI 实际提供的 Provider/model/reasoning 组合与 MCP Server。
- Produces: 当前支持矩阵、资格记录和透明降级策略。

- [ ] **Step 1: 固定支持矩阵。** 默认 Provider、本地 Ollama、Ollama Cloud、OpenAI 兼容 Provider 和公开支持的 MCP 逐项列出。
- [ ] **Step 2: 扩充故障测试。** 401、403、429、500、超时、断网、上下文过长和无效工具调用全部映射。
- [ ] **Step 3: 对每个组合运行完整场景。** 分析、修改、测试恢复、取消、报告和 MCP；无凭据写环境不可用。
- [ ] **Step 4: 验证模型路由与降级。** 不兼容模型不得进入对应角色，降级必须可见、可审计。
- [ ] **Step 5: 从 UI 逐项真实验收并生成宿主资格记录。** 未资格化组合不得显示为已支持。
- [ ] **Step 6: 提交。** 使用 `test: qualify CodePro provider and MCP matrix`。

**Rollback:** 新增 Provider 逐项 feature flag；单一组合失败不影响 CP-05A 默认 Provider。

**Acceptance:** 产品声明支持的每个组合都有当前证据或明确不可用状态，秘密不泄漏。

### Task CP-06B: 完成升级、回滚、浸泡、安全审查和 RC 证据

**Files:**
- Modify: `scripts/test-codebuddy-windows-lifecycle.ps1`
- Modify: `.github/workflows/codebuddy-windows.yml`
- Create: `documentation/codebuddy/evidence/CP-06B/<candidate-commit>/rc-manifest.json`
- Create: 同目录 `security-review.md`、`soak-report.md`、`rollback.md`

**Interfaces:**
- Consumes: MVP、CP-04B、CP-05B 和冻结的 Beta/RC 安装包。
- Produces: append-only RC manifest 与发布级 Windows 生命周期证据。

- [ ] **Step 1: 验证升级与回滚。** 从前一有效安装包升级到候选包，再回滚，核对会话和用户数据。
- [ ] **Step 2: 验证卸载与残留策略。** 清理保留数据必须是独立授权动作。
- [ ] **Step 3: 验证 crash/restart 和 uncertain effect。** 不得重复 push、PR、写文件或电脑动作。
- [ ] **Step 4: 用自动化 harness 执行 24 小时浸泡。** 对话不必保持；脚本持续记录心跳、资源、任务、失败和恢复，Codex按检查点读取结果。
- [ ] **Step 5: 完成安全审查。** 凭据、日志、外部内容、路径边界、远端 URL 和供应链全部检查。
- [ ] **Step 6: 生成 RC manifest。** 包含 commit、版本、SHA-256、签名、资格、浸泡、性能、安全和回滚说明。
- [ ] **Step 7: 暂停 RC 决策。** 任何必需项为 `NOT_MEASURED` 不得发布。
- [ ] **Step 8: 提交。** 使用 `docs: record CodeBuddy Windows RC evidence`。

**Rollback:** 保留 MVP 稳定通道和前一安装包；RC 失败不影响已验证 MVP。

**Acceptance:** 升级、回滚、卸载、恢复、完整 Provider/MCP、24 小时浸泡和安全审查都有当前证据。

### Task CP-08: 整合 session/worktree 隔离能力

**Files:**
- Audit branch: `feat/session-worktree-contract`
- Audit branch: `feat/session-worktree-git-manager`
- Modify: `crates/goose/src/agents/codepro_workspace.rs`
- Modify: Git/worktree 管理模块实际落点
- Modify: `ui/desktop/src/components/codepro/WorkspaceSwitcher.tsx`
- Test: workspace、Git 和恢复测试

**Interfaces:**
- Consumes: Project ID/root、session ID、repository、base ref 和用户隔离选择。
- Produces: 可选 worktree 的生命周期状态、冲突与清理结果；普通 Run 继续复用 Project 根目录。

- [ ] **Step 1: 生成分支差异与冲突图。** 使用 `git log HEAD..branch`、`git diff --stat HEAD...branch` 和补丁审查，禁止直接 merge。
- [ ] **Step 2: 固定契约。** Project 是稳定用户目录；同一 Project 下普通 Run 不重复创建目录；只有显式隔离/并行才创建 worktree。同一 worktree 只能有一个写所有者；路径必须在受管根内；创建、复用、关闭、恢复和清理都有持久状态。
- [ ] **Step 3: 写失败测试。** 覆盖重复所有权、脏工作区、分支已占用、跨盘、崩溃残留、用户文件存在和清理失败。
- [ ] **Step 4: 按提交重放最小代码。** 先契约和后端，再 Git manager，逐个解决冲突并保持当前控制平面接口。
- [ ] **Step 5: 真实桌面验收。** 用鼠标在同一 Project 创建两个普通会话，验证复用同一项目根且没有新增项目目录；再显式开启 Worktree，验证独立 diff、重启恢复、关闭一个会话不影响另一个。
- [ ] **Step 6: 验证软清理。** 默认只归档/解除绑定；物理删除 worktree 前必须确认无用户修改并获得授权。
- [ ] **Step 7: 提交。** 分别使用 `feat: bind CodePro sessions to managed worktrees` 和 `feat: manage CodePro worktree lifecycle`。

**Acceptance:** 普通会话复用同一 Project 根目录；隔离会话不会写入同一 worktree；崩溃后不产生未知所有权；任何清理都不会丢失用户修改或删除 Project 根目录。

### Task CP-09: 整合并行 Agent 协议、调度、取消和恢复

**Files:**
- Audit branch: `feat/agent-parallel-protocol`
- Audit branch: `design/codepro-agent-owned-parallelism`
- Modify: `crates/goose/src/agents/protocol/`
- Modify: `crates/goose/src/agents/control_plane/`
- Modify: `crates/goose/src/agents/task_graph/`
- Test: `crates/goose/tests/codepro_task_*.rs`、worker、control 与 convergence 测试

**Interfaces:**
- Consumes: validated TaskDAG、workspace ownership、并发/成本预算。
- Produces: 有界并行 Worker、结构化 outcome、确定性取消与恢复。

- [ ] **Step 1: 审计候选分支。** 记录当前 HEAD 独有与分支独有提交，拒绝重复状态机、UI 先行和绕过 durable runtime 的实现。
- [ ] **Step 2: 写并行不变量测试。** 依赖未完成不能启动；write scope 重叠不能并行；只读任务可并行；每个 Worker 有 generation 和取消 token。
- [ ] **Step 3: 写故障测试。** 覆盖一个 Worker 失败、父任务取消、分支取消、late outcome、超时、进程树残留和恢复重放。
- [ ] **Step 4: 先接入 advisory mode。** Coordinator 只能输出带证据引用的恢复建议，不直接改变任务状态；记录建议、采纳/拒绝和结果，用于资格化。
- [ ] **Step 5: 整合 authoritative mode。** 只有达到预设成功率、恢复正确性和回放一致性门槛后，Coordinator 才能提交受 schema 约束的 `retry_worker | repair_coder | change_plan | stop_run` 决策；宿主仍拥有最终状态转换权。
- [ ] **Step 6: 整合协议。** 所有启动、完成、失败、恢复和取消先形成 durable event，再执行物理 effect；in-flight 外部 effect 默认标记 uncertain，禁止盲目重复。
- [ ] **Step 7: 加预算。** 限制并发 Agent、Token、时间、重试和工具调用；预算耗尽产生可解释终态，并显示剩余恢复动作。
- [ ] **Step 8: 运行多 Agent fixture。** 两个独立文件并行修改，一个共享文件串行修改；验证最终 diff、测试、无冲突、分支取消和重启重放。
- [ ] **Step 9: 提交。** 按协议、调度、恢复三个小提交落地。

**Acceptance:** 并行只发生在依赖和写范围允许时；取消后无孤儿进程；重启不重复外部 effect；单 Agent 路径保持兼容。

### Task CP-09A: 将并行度改为主 Agent 自主决策

**产品决策：**

普通用户只描述开发目标，不再配置“最多并行编码 Agent”。主 Agent 是唯一的全局调度者，根据任务依赖、文件写范围、资源预算、取消状态和宿主策略自动决定实际 Worker 数量。底层保留不可突破的安全上限，但它是宿主/企业策略而不是普通产品选项。
**当前事实状态（2026-08-07，禁止把候选工作树写成已交付）：**

- 集成分支已有 `a24cd0123 fix: make coder concurrency host-managed` 和 `10cc53501 fix: address coder concurrency review`。`CodeProModelModal` 已不再读取、显示或写入并行度键；聚焦组件测试曾执行 `11/11` 通过。用户截图仍出现数字输入，说明截图来自未包含这些提交的旧构建，不应在新分支重复删除同一控件。
- 独立审查发现一个真实后端缺口：legacy 路径使用 `router.max_parallel_coders()`，但 durable 与 shadow 路径曾直接使用 `TaskScheduler.max_parallel`，未来启用隔离 Worker 工作区后可能突破隐藏的管理上限。仅删除 UI 不等于调度权已经正确迁移。
- 隔离工作树 `agent-owned-parallel-ui-config` 中已有候选修复：把有效 Coder 上限统一为 `min(router ceiling, host max_parallel)`，并补充 durable lease 与 shadow 审计模式级测试；前端 `11/11`、i18n 15 个 locale 共 `1933` 条、ESLint、Prettier、TypeScript 均通过。
- 上述候选在最后一次把测试和生产 helper 改为直接接收真实 `ModelRouter` 后，尚未重新执行 Rust 门禁，也未合并到集成分支。状态必须保持 `IN_PROGRESS`，不能标记完成。
- 曾启动正确工作树的 Electron 新实例并确认进程路径；桌面验收中点击目标区域后出现白屏/坐标与 DPI 不确定性，用户随后要求停止运行测试。因此真实桌面结果为 `NOT_COMPLETED`，不是失败定论，也不是通过。

**Files:**
- Modify: `ui/desktop/src/components/codepro/CodeProModelModal.tsx`
- Modify: `ui/desktop/src/components/codepro/CodeProModelModal.test.tsx`
- Modify: `ui/desktop/src/i18n/messages/*.json`
- Verify: `crates/goose/src/agents/model_router.rs`
- Modify: `crates/goose/src/agents/task_scheduler.rs`

**控制权矩阵：**

| 决策 | 主 Agent / Coordinator | 宿主控制平面 | Worker / 子 Agent | 普通用户 |
|---|---|---|---|---|
| 是否拆任务、依赖关系、需要哪些角色 | 提议并动态调整 | 校验 schema、持久化和预算 | 不得改全局 DAG | 只描述目标，可暂停/取消 |
| 是否并行及并行哪些任务 | 在已就绪任务中提出选择 | 最终准入；检查依赖、write scope、资源和策略上限 | 只执行已签发 lease | 不配置 Agent 数量 |
| 实际 Worker 数 | 选择需求量，可主动少用 | 取所有硬约束的最小值，禁止超限 | 不得自行无限 spawn | 不承担调参责任 |
| 失败后的重试、修复、改计划或停止 | 基于证据提出决策 | 执行预算、状态迁移、幂等和审计 | 回报结构化 outcome，不决定全局终态 | 可查看原因并覆盖高层目标 |
| 取消 | 决定取消 task、branch 或 run 的语义 | 发放分级取消 token、清理进程、拒绝 late outcome | 响应自己的 token 并回报 | 提供暂停、取消当前任务、停止全部 |
| “已完成/测试通过” | 可以总结，不得自证 | 只依据退出码、文件事实、测试和审计形成终态 | 提供证据引用 | 查看可追溯报告 |

**有效并行度规则：**

`actual_coders = min(agent_requested, independent_ready_coders, router_ceiling, host_resource_cap)`

其中：

- `agent_requested` 是主 Agent 当前认为有价值的 Worker 数量，不是固定配置；允许为 `0` 或 `1`。
- `independent_ready_coders` 只包括依赖已满足、write scope 已知且互不重叠的 Coder。
- `router_ceiling` 是兼容现有配置和企业策略的隐藏上限，默认 `2`，归一化范围 `1..=4`。
- `host_resource_cap` 是宿主基于 CPU、内存、Provider backpressure 和全局副作用计算的上限。
- 任一任务 write scope 未知时按有冲突处理；Cargo 构建/测试、Git 合并、迁移、发布和最终桌面验收默认走全局串行通道。
- 上限只限制准入，不强制创建 Worker；任何路径都不得把 `max_parallel` 当成“必须启动数量”。

**权威和迁移规则：**
- 模型设置弹窗不再读取、显示或保存 `GOOSE_CODEPRO_MAX_PARALLEL_CODERS`。
- 现有配置不删除、不覆盖，只作为隐藏的管理上限；缺省上限为 `2`，允许范围仍为 `1..=4`。
- 上限不等于强制启动数；主 Agent 可以选择更少 Worker，或在存在写冲突、依赖、资源风险时完全串行。
- 同文件或写范围重叠的编码任务必须串行；Cargo 编译、Git 合并和最终验收使用全局串行通道。
- legacy、shadow 和 durable 三条运行路径必须调用同一个 `coder_admission_policy(&ModelRouter)`；禁止各自重新计算上限。
- durable 模式只有宿主签发的 `SchedulingLease` 能启动 Coder；主 Agent 的文字决定不能绕过 lease、预算或权限。
- shadow 模式必须把候选任务、准入任务、有效上限和拒绝原因写入审计，不能只记录“评估成功”。
- 迁移期间保留旧键是兼容策略，不代表继续向普通用户暴露；企业版若需要覆盖，只进入管理员策略面。

**明确非目标：**

- 不让 LLM 无上限自行 spawn 子 Agent；自主指“在宿主硬约束内做语义决策”，不是取消控制平面。
- 不把 Coder/Tester/Reviewer 永久固化为唯一角色；当前角色只是兼容层，后续可由主 Agent 按任务动态描述能力。
- 不因为并行理论上更快就默认并行；小任务、共享文件、昂贵构建和高失败成本任务应优先串行。
- 不在本任务删除隐藏配置、数据库字段或旧事件；清理需单独迁移任务、遥测证据和回滚方案。

- [ ] **Step 1: 固定失败的 UI 契约。** 测试必须先等待模型异步加载完成，再断言不存在任何 `spinbutton` 和旧标签；同时证明不读取、不写入、不删除 `GOOSE_CODEPRO_MAX_PARALLEL_CODERS`。在异步稳定点之前断言“不存在”属于假绿。
- [ ] **Step 2: 最小前端修改。** 删除数字输入、冲突警告、本地并行度 state 和配置读写；删除全部 locale 中三个废弃消息键；不改变模型选择、推荐组合和保存流程。
- [ ] **Step 3: 建立唯一 policy 入口。** `TaskScheduler` 通过真实 `&ModelRouter` 构造 `AdmissionPolicy`，统一计算 `min(router ceiling, host max_parallel)`；durable 与 shadow helper 直接接收 `&ModelRouter`，避免调用点传字面量或错误来源。
- [ ] **Step 4: 写模式级 Rust 测试。** durable：临时启用隔离工作区能力，构造两个互不重叠 Coder，设置 host=`4`、router=`1`，断言只签发一个 lease；shadow：host=`4`、router=`2`，断言真实审计中的有效上限为 `2`；legacy：整个 batch 同时受 router 与 host 约束。
- [ ] **Step 5: 跑自动化门禁。** 精确执行上述 3 个 Rust 用例并确认每个实际运行 `1 test`；执行 `CodeProModelModal.test.tsx`、i18n check、ESLint、Prettier、TypeScript。Cargo 输出中的其它 `0 tests` 只是过滤结果，不能代替目标用例。
- [ ] **Step 6: 独立审查。** 用全新上下文检查：把 durable、shadow 或调用点改回 `max_parallel` 是否会使测试失败；把 UI 控件延迟到异步加载后渲染是否会使测试失败。不能只静态确认当前代码“看起来正确”。
- [ ] **Step 7: 正确构建的真实桌面验收。** 先记录 Electron 可执行路径、branch、commit 和工作目录；鼠标打开 CodePro 模型设置，确认输入框和冲突警告消失；修改模型、保存、关闭、重开并确认持久化。白屏、旧构建或 DPI/坐标不确定时保存截图和日志并标记 `NOT_COMPLETED`，不得凭组件测试关闭任务。
- [ ] **Step 8: 多任务验收调度语义。** 两个独立文件允许并行；同文件/未知范围串行；Cargo、Git 整合与最终验收串行；用户全程不提供数量。分别检查 task/branch/run 取消和重启恢复无孤儿 Worker。
- [ ] **Step 9: 小提交与集成。** UI/i18n、policy 接线、模式级测试分别形成可审查提交；只合并到指定集成分支，不向存在未知修改的主工作树直接写入；合并后重跑门禁和桌面验收。

**Acceptance:** 普通用户界面不再出现并行 Agent 数量输入；保存模型组合不读取或修改隐藏上限；legacy、shadow、durable 都从真实 `ModelRouter` 进入同一 policy；主 Agent 只在依赖、写范围、资源和宿主上限内自主选择 Worker；文件冲突、未知范围和全局副作用自动串行；目标 Rust 用例、前端门禁、独立反变异审查和正确构建的真实桌面流程全部有当前证据。

### Task CP-10: 交付并行 Agent 桌面体验

**Files:**
- Audit branch: `feat/agent-parallel-ui`
- Modify: `ui/desktop/src/components/codepro/CodeProTaskPanel.tsx`
- Modify: `ui/desktop/src/components/codepro/CodeProControlPlanePanel.tsx`
- Modify: `ui/desktop/src/codepro/runProjection.ts`
- Test: 对应组件和 projection 测试
- Create: `ui/desktop/tests/e2e/codepro-parallel-agents.spec.ts`                                   

**Interfaces:**
- Consumes: authoritative run/task/worker projection。
- Produces: 用户可理解的并行拓扑、进度、预算、暂停、取消和恢复操作。 

- [ ] **Step 1: 写组件失败测试。** 覆盖并行、阻塞、等待依赖、取消中、恢复中和失败状态，不允许 UI 自行推断后端状态。
- [ ] **Step 2: 按当前设计系统整合候选 UI。** 保留现有 CodePro 活动卡、中文、本地化和键盘可访问性。
- [ ] **Step 3: 实现控制动作。** 任务/分支/整次运行的暂停取消必须调用 authoritative backend，按钮等待确认结果后更新。
- [ ] **Step 4: 真实鼠标验收。** 启动三任务 DAG，展开各 Agent，暂停、恢复、取消一个分支，验证其他分支和最终报告。
- [ ] **Step 5: 进行窄屏和缩放验收。** 100%、125%、150% 缩放下无裁切，焦点顺序和屏幕阅读标签正确。
- [ ] **Step 6: 提交。** 使用 `feat: expose controlled parallel agents in CodePro desktop`。

**Acceptance:** 用户能看懂谁在做什么、为什么等待、消耗多少、如何停止；UI 与 durable projection 始终一致。

### Task CP-11: 完成长短期记忆、上下文预算和隐私控制

**Files:**
- Modify: `crates/goose/src/agents/platform_extensions/codepro_memory.rs`
- Modify: `crates/goose/src/agents/platform_extensions/project_memory.rs`
- Modify: `crates/goose/src/agents/platform_extensions/chatrecall.rs`
- Modify: `crates/goose/src/agents/prompt_manager.rs`
- Test: `crates/goose/tests/codepro_memory_tools.rs`、`codepro_project_memory_tools.rs`
- Add desktop settings/tests in existing settings structure

**Interfaces:**
- Consumes: 会话事实、项目事实、用户显式保存项、上下文预算。
- Produces: 有来源、作用域、过期和删除能力的检索上下文。

- [ ] **Step 1: 定义三层记忆。** 当前任务临时上下文、项目级事实、用户显式长期偏好；默认不得把源码、秘密或模型猜测写入长期记忆。
- [ ] **Step 2: 写来源与隔离失败测试。** 项目 A 不得召回项目 B；删除后不得返回；未经证实的 LLM 结论不得升级为事实。
- [ ] **Step 3: 实现预算与摘要。** 上下文接近上限时由宿主选择、去重、压缩，并保留原始证据引用；禁止无界拼接历史。
- [ ] **Step 4: 实现查看、编辑、导出、删除。** 每条记忆显示来源、时间、范围和保存原因。
- [ ] **Step 5: 真实桌面验收。** 保存一个项目约定，重启后在同项目召回，在另一项目不召回，再通过设置删除并验证消失。
- [ ] **Step 6: 提交。** 使用 `feat: add scoped and auditable CodePro memory`。

**Acceptance:** 记忆提升连续开发体验，但不会跨项目泄漏、无限增长或把推测固化成事实；用户拥有查看和删除权。

### Task CP-12: 完成受控电脑与浏览器操作
 
**Files:**
- Modify: `crates/goose/src/agents/platform_extensions/computer.rs`
- Test: `crates/goose/tests/codepro_computer_tools.rs`
- Integrate Playwright/DevTools through existing MCP/extension boundaries
- Add desktop permission and activity presentation tests

**Interfaces:**
- Consumes: 截图、窗口/浏览器目标、结构化鼠标键盘动作、权限决定。
- Produces: 有界操作结果、截图证据和审计记录。

- [ ] **Step 1: 固定能力边界。** 截图/读取、点击/输入、打开 URL、下载/上传、凭据输入和高风险系统动作分级；密码框和系统安全界面默认禁止。
- [ ] **Step 2: 写权限失败测试。** 覆盖未授权点击、窗口切换、坐标越界、截图脱敏、重复动作、取消和紧急停止。
- [ ] **Step 3: 浏览器优先复用 Playwright/DevTools。** DOM 可定位时使用语义选择器；只有功能本身要求桌面控制时才使用坐标动作。
- [ ] **Step 4: 实现观察—计划—动作—验证闭环。** 每个动作前后截图或结构化状态对比；失败不得无限重试。
- [ ] **Step 5: 在隔离桌面真实验收。** 用鼠标打开本地测试网页、填写无敏感信息的表单、提交并验证结果；再测试用户取消和紧急停止。
- [ ] **Step 6: 提交。** 使用 `feat: add policy-controlled computer and browser actions`。

**Acceptance:** 电脑控制只在明确授权和边界内执行；每个动作可停止、可审计、可验证；不会触碰密码、付款或系统安全界面。

### Task CP-13: 完成稳定性、性能、可观测性和故障恢复

**Files:**
- Modify: `crates/goose/src/agents/control_plane/recovery.rs`
- Modify: `crates/goose/src/agents/control_plane/runtime_storage.rs`
- Modify: `crates/goose/src/agents/control_plane/effect_ledger.rs`
- Modify: Rust tracing 与 Electron logging 配置
- Add benchmark/soak scripts under `scripts/`

**Interfaces:**
- Consumes: run/session/task/worker/effect 事件和系统资源数据。
- Produces: 脱敏日志、指标、故障分类、恢复动作和 SLO 证据。

- [ ] **Step 1: 定义并测量指标。** 启动时间、首个可见活动、停止延迟、恢复时间、10,000 事件重放、内存/句柄增长和失败恢复率；基线未知时记录实测值，不编造目标。
- [ ] **Step 2: 建立关联 ID。** session/run/task/worker/effect 在 Rust、ACP、Electron 和报告中一致，日志默认不含 prompt、Token 和源码正文。
- [ ] **Step 3: 写故障注入测试。** 网络断开、Provider 429/500、磁盘满、数据库尾部损坏、子进程挂起、应用 crash 和 Windows 重启。
- [ ] **Step 4: 实现确定性恢复。** pending 可重试，in-flight 外部 effect 进入 uncertain 并等待裁决；禁止盲目重复 push、PR、文件写入或电脑动作。
- [ ] **Step 5: 建立性能回归门禁。** 与冻结基线比较；显著退化必须有 profile 和批准，不能用增加超时掩盖。
- [ ] **Step 6: 真实长任务验收。** 运行至少 2 小时混合任务并主动制造断网、取消和重启，验证 UI、日志、资源和恢复。
- [ ] **Step 7: 提交。** 按 observability、recovery、performance gate 分开提交。

**Acceptance:** 生产问题能由关联日志和事件解释；恢复不重复危险动作；资源增长有边界；性能退化可检测。

### Task CP-14: 完成安全加固和供应链治理

**Files:**
- Modify: 权限、工具审计、路径规范化和凭据模块
- Modify: `.github/workflows/recipe-security-scanner.yml`
- Modify: Windows 构建与签名脚本
- Create: `documentation/codebuddy/security/threat-model.md`
- Create: `documentation/codebuddy/security/release-checklist.md`

**Interfaces:**
- Consumes: 用户输入、仓库内容、MCP/网络内容、外部命令、更新包。
- Produces: 策略决定、安全事件、签名/依赖证据和可回滚发布。

- [ ] **Step 1: 建立威胁模型。** 覆盖 prompt injection、恶意仓库、symlink/junction/UNC、命令注入、Token 泄漏、MCP 供应链、更新劫持和多会话越权。
- [ ] **Step 2: 写攻击回归测试。** 路径穿越、shell metacharacter、恶意 Git remote、超大输出、秘密文件、伪造工具注解和外部内容诱导。
- [ ] **Step 3: 收紧默认策略。** 未知工具、未知协议字段、未知 runtime flag 和未知目标默认 fail closed，并提供明确恢复办法。
- [ ] **Step 4: 扫描依赖与许可证。** Rust、npm、捆绑二进制和 MCP Server 记录版本、来源、许可证、已知漏洞和升级决策。
- [ ] **Step 5: 验证签名和更新链。** 安装包、更新清单和下载产物校验签名与哈希，失败时停止安装并可回滚。
- [ ] **Step 6: 独立代码审查。** 对权限、命令、路径、凭据、更新和电脑控制做 fresh-context review，所有高危问题关闭后才能发布。
- [ ] **Step 7: 提交。** 使用 `security: harden CodePro execution and release chain`。

**Acceptance:** 关键威胁有防护和回归测试；秘密不进入日志/报告；未知输入 fail closed；发布链可验证。

### Task CP-15: 完成企业 RBAC、SSO、策略和审计导出

**Files:**
- Create after architecture review: `crates/goose/src/enterprise/identity.rs`
- Create: `crates/goose/src/enterprise/policy.rs`
- Create: `crates/goose/src/enterprise/audit_export.rs`
- Add ACP contracts and desktop admin UI in focused files
- Test: enterprise identity/policy/audit integration tests

**Interfaces:**
- Consumes: 经验证身份、组织/角色、管理员策略、审计查询。
- Produces: 本地有效权限、策略版本、不可抵赖审计导出和离线/过期行为。

- [ ] **Step 1: 先做身份与部署研究。** 明确目标 IdP/协议、单机或组织部署模式、数据驻留和日志保留；这些属于产品决策，未得到用户选择时暂停，不得猜测供应商。
- [ ] **Step 2: 定义最小角色。** 管理员、开发者、审计员和只读用户；服务端/宿主策略是权威，前端隐藏按钮不是权限控制。
- [ ] **Step 3: 写策略测试。** 覆盖本地与组织策略合并、离线、Token 过期、时钟漂移、角色变更、策略回滚和紧急吊销。
- [ ] **Step 4: 实现 SSO 和会话生命周期。** 凭据使用 OS 安全存储；注销、过期和撤销后立即失效。
- [ ] **Step 5: 实现审计导出。** 支持按时间、用户、项目、工具和结果导出结构化记录；默认脱敏源码和秘密，导出操作本身也审计。
- [ ] **Step 6: 真实桌面验收。** 分别以四种角色登录测试环境，验证允许/拒绝、策略更新、注销和审计导出。
- [ ] **Step 7: 提交。** 按 identity、policy、audit 三个独立提交落地。

**Acceptance:** 企业权限由可信身份和宿主策略决定；策略变更可追溯、可撤销；审计导出完整且不泄漏秘密。

### Task CP-16: 发布稳定 V1/GA 并建立持续发布机制

**Files:**
- Modify: 发布 workflows、版本、changelog 和用户文档
- Create: `documentation/codebuddy/evidence/CP-16/<version>/ga-manifest.json`
- Create: `documentation/codebuddy/operations/release-runbook.md`
- Create: `documentation/codebuddy/operations/incident-runbook.md`

**Interfaces:**
- Consumes: Windows MVP、Beta/RC、CP-08～CP-15 的全部当前证据与发布候选。
- Produces: 稳定 V1/GA、更新通道、回滚和持续质量门禁。

- [ ] **Step 1: 冻结 GA 范围和兼容矩阵。** Windows 版本、CPU 架构、Provider、Git/gh、MCP、升级来源和数据迁移版本全部明确。
- [ ] **Step 2: 执行全量自动化和安装态矩阵。** 每个支持组合都用同一候选提交和签名产物；不支持组合在 UI/文档中明确阻止或警告。
- [ ] **Step 3: 执行 72 小时发布候选浸泡。** 覆盖单 Agent、并行 Agent、GitHub、记忆、电脑控制、升级和故障恢复；记录资源趋势与全部失败。
- [ ] **Step 4: 完成迁移与回滚演练。** 从 MVP/前一 V1 候选升级到 GA，再回滚；验证会话、记忆、worktree、凭据和审计数据。
- [ ] **Step 5: 完成发布评审。** 产品、工程、安全和运维结论进入 GA manifest；任何阻塞项未关闭都不得发布。
- [ ] **Step 6: 请求对外发布授权。** 展示候选版本、风险、已知限制、回滚版本和证据链接。
- [ ] **Step 7: 发布、下载回验和分阶段放量。** 先内部/小比例，再扩大；错误率或恢复失败越过基线阈值立即停止并回滚。
- [ ] **Step 8: 建立持续机制。** 每次变更必须经过聚焦测试、合并门禁、夜间 E2E、周期安装态测试和发布前浸泡。
- [ ] **Step 9: 提交。** 使用 `release: publish CodeBuddy v1`。

**Acceptance:** GA 安装包、源提交、签名、证据和发布记录一致；升级与回滚已演练；生产问题有监控、响应和可恢复路径。

## 8. 阶段里程碑与边界

| 里程碑 | 必须完成 | 明确不提前加入 |
|---|---|---|
| Windows MVP | CP-00、CP-01、CP-02、CP-03、CP-04A、CP-05A、CP-06A、CP-07 | 完整 GitHub 迁移、Provider 全矩阵、24 小时浸泡、并行 Agent、长期记忆、电脑控制、企业 SSO |
| Beta/RC | CP-04B、CP-05B、CP-06B | 并行 Agent、长期记忆、企业能力 |
| 稳定 V1 候选 | CP-08～CP-14 | 未确认目标 IdP 的企业实现 |
| 企业/GA | CP-15～CP-16 | 未经过资格验证的 Provider、MCP 或平台 |

MVP 的目标是尽快形成可安装、可演示、可回滚的核心闭环，而不是把完整迁移和发布级资格塞进首版。CP-07 完成后必须向用户交付经理演示证据并暂停一次；获得方向确认后再进入 Beta/RC。后续能力必须建立在 MVP 的真实用户证据上。

## 9. 每个任务的证据包格式

证据目标是让结论可复核和可恢复，不是制造文档数量。Git 仓库优先把 commit、diff、测试命令和退出码作为自然证据；CodePro 结构化证据只补充 Git 无法表达的运行状态、限制、授权和用户结果。

每个发生行为变更的任务在 `documentation/codebuddy/evidence/<task-id>/<candidate-commit>/` 至少保存一个 `summary.md`：

```text
summary.md              # 目标、实际变更、结论、剩余风险
```

`summary.md` 可以直接内联短命令、退出码和测试摘要。只有内容较长、需要独立审阅或达到下表条件时才创建附件，禁止预先生成空模板：

| 附件 | 触发条件 |
|---|---|
| `commands.txt` / `automated-tests.md` | 命令较多、输出需要独立保存、发生失败分类，或处于阶段完整门禁 |
| `user-journey.md` / `screenshots/` | React UI、跨模块用户流程、电脑控制、安装态或发布任务 |
| `logs/` | 需要复现故障、性能/稳定性分析或发布审计；默认保存有界脱敏摘要或哈希与受控路径 |
| `research.md` | 非机械设计、外部工具/协议选型或 Codex 对标 |
| `review.md` | `L2` 中触发 Reviewer 的任务，以及所有 `L3_HIGH_RISK_RELEASE` 任务 |
| `rollback.md` | 数据迁移、权限/凭据、远端副作用、安装/更新、不可自动恢复的变更 |
| `handoff.md` | 跨会话长任务、暂停/阻塞任务或阶段里程碑；短任务直接在 `summary.md` 记录下一动作 |
| manifest/资格报告 | MVP、Beta/RC、GA、Provider 资格或企业审计等发布级任务 |

`summary.md` 必须包含：

```markdown
# <Task ID> evidence summary
- Candidate commit:
- Risk level: L1_REVERSIBLE_CHANGE | L2_FEATURE | L3_HIGH_RISK_RELEASE
- Workspace status before/after:
- Changed files / Git diff:
- User outcome:
- Verification commands and exit codes:
- Desktop acceptance: REQUIRED | NOT_REQUIRED | PASS | NOT_COMPLETED
- Security/privacy check:
- Action/API budget used:
- Rollback point and procedure:
- Context handoff / next action:
- Known unrelated failures:
- Remaining risks:
- Verdict: VERIFIED_CURRENT | ENVIRONMENT_UNAVAILABLE | BLOCKED
```

只读 `L0_READ_ONLY` 请求没有写入、没有测试完成声明时，可以直接在会话中引用文件和命令，不创建任务证据目录。其他级别的必填字段不允许为空；不适用必须写 `NOT_REQUIRED` 并说明原因，无法采集时写明原因和状态。

## 10. 提交、评审与继续规则

1. 开始任务前保存 `git status --short`，确认不会覆盖无关修改。
2. 每个行为变更先出现能解释问题的失败测试。
3. 实现只覆盖当前任务，不顺手重构无关区域。
4. 聚焦测试通过后做代码质量、安全和简化审查。
5. 用户可见功能启动真实应用，用鼠标和键盘走完任务卡场景。
6. 按风险级别更新最小证据和本文档方框，再创建小提交；禁止为了满足目录形状生成空日志、空截图或空审查文件。
7. 重新运行 `git status --short`，确认提交未夹带未知文件。
8. 更新“当前任务指针”和 `handoff.md`，记录下一动作、回滚点以及实际行动/API 预算，避免依赖完整对话上下文。
9. 当前任务状态为 `VERIFIED_CURRENT` 后，Codex自动进入执行队列下一项；CP-07、CP-06B 和 CP-16 属于强制里程碑确认点，不自动跨越。

不得自动执行以下动作：向远端 push、创建真实 PR/Release、发布安装包、购买服务、删除用户数据、强制推送、修改生产组织策略。这些动作必须在展示目标、影响和回滚方案后取得用户授权。

## 11. 失败恢复与暂停模板

满足暂停条件时只问一个能解除阻塞的问题，并提供已经完成的排查：

```markdown
当前任务：CP-xx
阻塞事实：可复现现象与命令/日志
已排除：至少列出已验证的替代原因
已尝试：三轮不同方向的排查或修复
不会继续猜测的原因：继续操作可能造成的风险
需要你的决定/材料：账号、Token、证书、产品选择或人工动作
安全的默认状态：当前代码、数据和回滚点
```

取得输入后从同一任务继续，不重做已经有当前证据的步骤。

## 12. 最终完成定义

项目只有同时满足以下条件才可称为“开发完成”：

- Windows MVP、稳定 V1 和目标企业范围均有明确发布版本，而不是只有源码。
- 所有支持功能均有当前自动化测试和真实用户验收；历史数字不充当当前证据。
- 安装、首次启动、升级、回滚、卸载和残留数据策略经过干净账户验证。
- 单 Agent 与并行 Agent 的计划、写入、测试、评审、取消、恢复和报告可追溯。
- Git/GitHub 复用 `git`/`gh` CLI 或结构化 MCP，并始终经过 CodePro 权限、审计、路径和脱敏边界。
- 电脑/浏览器控制可授权、可停止、可审计，不触碰禁止界面和敏感输入。
- 记忆有来源、范围、过期、查看和删除能力，不跨项目泄漏。
- Provider、模型、MCP、Windows 版本和升级路径都有支持矩阵与资格记录。
- 无已知的未授权写入、重复外部 effect、孤儿进程、凭据泄漏或不可恢复数据丢失。
- 终态报告和普通项目分析没有占位符、路径矛盾或把未执行/未验证内容写成通过；结构化 payload 可被前端直接消费。
- Planner 在格式异常、模型失败和空响应下有可解释的 fallback，不会因为一次 JSON 解析失败让用户丢失任务上下文。
- 发布产物有签名、哈希、commit、测试、浸泡、安全审查和回滚证据。
- CI、夜间 E2E、安装态测试、依赖扫描和发布门禁可持续运行。

完成并不意味着“以后不再开发”，而是目标范围已经形成可安装、可验证、可运营和可回滚的产品闭环。

## 13. 文档自检清单

- [ ] 当前 HEAD、分支、工作区和测试结果在执行时重新采集。
- [ ] CP-00～CP-03、CP-04A/B、CP-05A/B、CP-06A/B、CP-07～CP-16 每项都对应用户结果、文件、测试、提交，以及按测试矩阵判定为 `REQUIRED` 或 `NOT_REQUIRED` 的桌面验收。
- [ ] 没有把候选分支或历史通过误写为当前可用。
- [ ] 没有把电脑鼠标测试强加给纯后端函数，但所有用户可见纵向切片都有真实桌面验收。
- [ ] Git/GitHub 明确优先复用成熟 CLI/MCP，且保留 CodePro 安全适配层。
- [ ] 非简单设计明确要求查官方资料、GitHub 和 Codex 对比，并检查许可证与维护状态。
- [ ] 自动连续开发与必须暂停的边界清楚。
- [ ] MVP 范围保持精简，完整项目能力按后续阶段推进。
- [ ] Agent 流程按 `L0`～`L3` 风险分级；简单修改不固定四角色，高风险/发布任务不能省略独立 Reviewer。
- [ ] 证据以 Git diff、命令和退出码为核心，附件按触发条件生成；没有空模板和重复快照。
- [ ] Codex 对比明确区分公开产品行为、开源实现和不可验证的内部研发流程；没有把“无证据/无权限”当作事实。
- [ ] Planner 异常输出、模型失败和单任务降级均有测试与证据，不能只验证理想 JSON。
- [ ] shell/Python/MCP 等间接写入进入统一文件事实；报告路径不依赖 Worker 自述或 session working directory 兜底。
- [ ] 终态报告与普通分析报告都经过占位符、完成语言、数字、路径、限制和 evidence ID 校验。
- [ ] 默认组合优先成功率和稳定性，高级设置才能启用并行、实验模型和高风险工具。
- [ ] Project、Session、Run、Worktree 和 Scratch 边界清楚；普通任务不会按消息创建新项目目录。
- [ ] 所有发布声明都有当前证据和回滚方案。
