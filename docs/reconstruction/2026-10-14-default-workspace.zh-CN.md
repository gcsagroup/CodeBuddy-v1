# 默认工作区与项目绑定

本批实现位于 `D:\CodeBuddy-v1`，沿用原项目当前文件的冻结基线；该目录没有 Git 仓库，未创建分支、提交或推送。基线来源见 `source-baseline.json`。

新版启动器默认准备 `D:\CodeBuddy-Workspace`。Windows 没有 D 盘以及 macOS/Linux 时使用用户目录下的 `Documents/CodeBuddy Workspace`。开发及隔离验收可通过 `CODEBUDDY_WORKSPACE_ROOT` 指定绝对目录。启动器不再把应用源码目录作为默认任务目录。

最新 CodePro 前端已有自动目录分配流程。本批只调整 Electron 宿主和启动器：没有显式选择项目时，每个新会话在默认容器下取得唯一子目录；用户直接输入任务即可沿现有流程创建会话。手动选择已有项目仍使用该项目。默认容器和会话项目是两个不同目录，模型的工作目录是会话项目。

`runtime/workspaces.mjs` 是新版工作区租约和项目元数据的唯一管理模块。它沿用现有 ACP 方法与响应：

- `workspace/lease/acquire` 重新检查真实绝对路径、目录状态、规范路径和祖先文件身份。新目录只用非递归创建，已有目标按冲突处理。
- `consumeLease` 检查连接归属、五分钟有效期、单次消费及会话目录一致性；`validateSession` 在任务入口重新核验目录身份。
- `releaseSession` 只释放进程内绑定，保留项目文件。未消费的租约断连、过期或释放时，仅清理仍属于原创建且仍为空的目录；没有递归删除。
- 租约不持久化。重启后原前端通过检查、重新获取和确认租约来恢复项目绑定。
- `sources` 的项目增删改查和导入导出使用独立数据目录内的真实 Markdown 文件。删除项目元数据保留工作目录和源文件。导出遵循原 `version: 1`、`type: project` 格式。

集成入口：`new WorkspaceService(store, { projectDirectory })`；兼容层调用 `handles`、`request`、`consumeLease`、`validateSession`、`releaseSession`、`disconnect`、`close`。`projectDirectory` 必须指向本版数据中的项目元数据目录；也可使用 `store.directory/projects`。

本实现通过规范路径和 `dev/ino/birthtime` 观察目录身份，拒绝符号链接及目录联接祖先。它不持有旧 Rust 实现的平台目录句柄，不宣称具备操作系统沙箱或持续防重命名保证。根容器创建子项目的特殊交互和原生目录句柄级强化仍应独立验收。

自动化命令为 `node --test runtime/tests/workspaces.test.mjs scripts/default-workspace.test.cjs scripts/start-harness-preview.test.cjs`，使用既有 Node.js 24，14 项通过、0 失败，退出码 0。覆盖真实目录创建、原前端宿主检查/确认合同、目录替换、目录联接、跨连接使用、过期、重启续绑、项目源 CRUD/导出导入及默认目录启动。测试使用临时目录，没有操作用户当前桌面进程。真实桌面与完整 CodePro 运行验收由集成批次记录；这些测试不代表整个首版已验收。

参考：[Node.js 文件系统 API](https://nodejs.org/docs/latest-v24.x/api/fs.html)、[ACP 会话设置](https://agentclientprotocol.com/protocol/v1/session-setup)。采用现有 ACP 合同与 Node 内置文件系统能力，没有新增依赖；旧 Rust Agent 执行核心没有参与。
