# 第一版基础能力：当前交付记录

本记录取代早期普通聊天预览说明。工作目录为 `D:\CodeBuddy-v1`；来源是原项目当前文件和未提交修改，逐文件基线见 [source-baseline.json](source-baseline.json)。目标目录未初始化 Git，本批没有创建开发分支、提交或推送。原项目保留。

## 启动和工作区

双击 [start-preview.cmd](../../start-preview.cmd) 打开最新 CodePro 工作台。已保存的 Ollama 云端 `kimi-k3` 配置继续使用，也可在原设置页面切换服务。当前为 Windows 开发预览，尚未交付安装包。

最终实例于 18:57（Asia/Shanghai）启动，18:59 核验窗口标题 `CodeBuddy`、原新任务路由及默认目录，Electron 主进程 29836、后端 29100；窗口留在新任务页。[启动与源码回执](../../.preview-evidence/foundations-preview.json)、[截图](../../.preview-evidence/foundations-preview.png)。PID 仅代表该次快照，后续以 `launch.json` 为准。

新建任务直接输入需求即可。默认容器为 `D:\CodeBuddy-Workspace`，每个新任务分配独立子目录；主动选择已有项目时使用所选目录。重启后打开正在开发的历史任务，原界面会要求重新确认项目绑定；这与每次新建对话选择文件夹不同。

界面、组件、样式、文案和原 SDK 源码保持基线。修改集中在 Electron 启动及通信、Harness 适配、工具和持久化。最新界面中使用输入框的“停止”按钮暂停执行，之后在原会话输入“继续”续作。

## 已接通的基础链路

- 官方 Harness 执行对话、文件编辑、搜索、PowerShell、后台任务及子 Agent。宿主保存计划、依赖、工具回执、审批和任务恢复事实。
- 原设置页可管理自定义模型、默认模型、角色路由、思考强度、上下文压缩、提示模板、AGENTS.md、MCP 和权限；辅助视觉模型在只读会话中处理图片。
- 工具箱接入文件/命令、项目记忆、Git 和独立 MCP 扩展；原内置电脑控制、文档及可视化 MCP 已连接。工具被禁用或拒绝审批后，实际调用受限。
- 项目记忆复用 Harness 的 `storage-domain/storage-json`，支持原界面的查看、编辑、候选审核、过期和导出；批准的项目记录才进入召回。
- 常用任务支持基础参数、模板、模型及扩展；自动任务支持保存、立即运行和暂停。迁入的旧日程保持暂停，逐项验证后再启用。
- 历史、导出/导入、编辑/重试/分叉、项目目录切换和 MCP 资源已接；旧历史以只读方式查看，不恢复旧 Agent 的未完成执行。
- Git 面板接通 7 个读取工具及暂存、取消暂存、提交、创建并切换分支、切换已有分支；Review 使用独立 Harness 审查会话。

详细实现和验收边界见 [完整功能矩阵](v1-functionality.zh-CN.md)。实现、自动测试、受控界面验收和真实模型验收分别记录。

## 已取得的真实证据

| 场景 | 结果与证据 |
|---|---|
| 当前完整后端与启动器回归 | Node.js 24 串行运行 runtime/tests、runtime/harness/test 和 scripts 下测试；286/286，0 失败/取消/跳过，退出码 0；[最终日志](../../.preview-evidence/foundations-all-tests-final.log) |
| 实际 Kimi + 原 Electron + 默认工作区 | 文件和测试工具完成小项目，独立 Node 测试 3/3，退出码 0；[回执](../../.preview-evidence/real-codepro-ui.json) |
| 实际 Kimi 多模块开发 | money/invoice 跨模块开发，独立 8/8；[回执](../../.preview-evidence/real-codepro-latest.json) |
| 实际 Kimi 暂停、服务器重启、同 run 续作 | 独立 15/15，约 233 秒，已完成模块的文件哈希和修改时间不变，原回执唯一；[说明](2026-10-14-real-codepro-resume.zh-CN.md) |
| 原 Electron 停止、关窗、重启、历史恢复、继续 | 受控本机模型 + 官方 Harness + 真实文件/测试工具，页面显示完成与测试通过，独立 3/3，页面及控制台错误均为 0；[回执](../../.preview-evidence/controlled-ui-resume-RnxtKT/receipt.json) |
| 实际内置 MCP | 5 次 list_apps、DOCX 创建/提取、缓存和 Mermaid 调用；[回执](../../.preview-evidence/builtin-execution-latest.json) |
| 原设置页 | 9 个页面打开；记忆开关、个性化开关及全局 AGENTS.md 实际保存和重开验证；[回执](../../.preview-evidence/first-version-I9je8k/settings-ui-receipt.json) |
| 原前端自动测试 | 10 文件、80 测试通过；[日志](../../.preview-evidence/frontend-foundations-tests.log) |

这些结果证明相应基础路径可执行；尚未证明小时级任务、大型生产仓库的持续运行质量、所有桌面工具或全部前端入口。

## 数据迁移与查看位置

旧 profile `C:\Users\jiangrui\.CodeAgentPro\profiles\local` 只读导入到新版。616 条用户/CodePro 历史已迁入，完整 SQLite 快照保留；现有 Kimi 配置保持，其他服务补缺，导入扩展默认停用。1 条自动任务暂停。14 条旧记忆中，3 条映射到仍存在的项目并进入 Harness 存储，另外 11 条对应已消失的历史目录，保存在迁移档案中，不虚构项目目录。

最终重启后再次通过原 Electron 打开 51 消息的旧会话，全部 616 条历史保留、Kimi 配置逐字段一致，页面错误为空。见[历史界面回执](../../.preview-evidence/migrated-history-ui.json)。

- 数据：`.preview-data/backend`；Electron profile：`.preview-data/state/electron-app`。
- 当前进程与端口：`.preview-data/logs/preview/launch.json`；日志：同目录 `runtime.log`、`electron.log`。
- 迁移：`.preview-data/backend/legacy`；映射明细：`.preview-data/validation/legacy-memory-mapping-report.json`。
- 源码冻结检查：`node scripts/create-source-baseline.mjs --verify`，仅核验，不重建基线。

当前原项目 HEAD 为 `dfdc47fb1a8d483fc02293b85d977e87a8969f10`，其 1074 个 UI 文件与捕获基线仍完全相同；新版 1069 个冻结文件也全部匹配。见[来源核对](../../.preview-evidence/source-ui-current.json)与[冻结检查](../../.preview-evidence/frontend-baseline-final.log)。

## 尚待完成

全部前端功能仍是目标。Git 远端操作、还原及冲突处理、GitHub 登录/PR/Issue/CI、Provider OAuth、Nostr、本地 ASR、复杂配方仍有接入项；详细状态以功能矩阵为准。云端语音、真实视觉质量、完整电脑操作、小时级任务、大型项目、Windows 安装包和 macOS 需要各自验收。当前只交付可运行、可检查的基础预览，不标记全功能首版完成。
