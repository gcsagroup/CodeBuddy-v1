# CodeBuddy 数据目录

默认根目录为 `~/.CodeBuddy`（Windows：`C:\Users\<用户名>\.CodeBuddy`）。开发版和安装版使用相同默认规则；同一数据根由运行时锁保护，不应同时启动两个写入实例。测试或并行开发请显式指定隔离数据目录。

| 内容 | 根目录内的位置 |
| --- | --- |
| 默认新建工作区 | `workspaces/<任务目录>` |
| 生成的图片、视频 | 对应工作区的 `generated-images`、`generated-videos` |
| 自定义宠物及选中项 | `state/electron-app/pets` |
| 会话、模型配置、自动任务、工具回执 | `backend`，沿用现有 Harness/宿主结构 |
| 配置档、浏览器数据和缓存 | `profiles/local`、`state/electron-app` |
| 启动及运行日志 | `logs`、`state/electron-app/logs` |
| 插件包和迁移记录 | `plugins/packages`、`migrations`（需要时创建） |

文件菜单的“打开 CodeBuddy 数据目录”打开实际使用的根目录。设置 `CODEBUDDY_HOME` 可以整体选择其他磁盘，默认工作区随之变化；显式设置 `CODEBUDDY_WORKSPACE_ROOT` 优先。用户选择的现有项目保留原位置，图片与视频随项目保存，避免项目复制后缺少素材。生成服务自己的模型、工作流和远端缓存仍由该服务管理。

更换默认路径不会移动旧项目，也不会重写历史对话中的绝对路径。旧 `.CodeBuddy-Harness` 和源码旁的 `.preview-data` 不会被自动合并：先停止源应用，将选定数据复制到尚不存在的目标，逐文件校验，再启动目标。原目录作为回退副本保留；若目标已有数据，应先选择来源，避免覆盖两套会话或设置。迁移后回退会丢失切换后在新目录产生的状态，回退前应先备份新目录。

本次本机选择：以现有开发版数据为主，旧安装版独立保留。既有 `D:\CodeBuddy-Workspace` 中的项目仍供历史会话使用；新建任务进入新默认目录。

设计参考：[VS Code 集中数据目录](https://code.visualstudio.com/docs/setup/portable)、[Electron userData/sessionData 分层](https://github.com/electron/electron/blob/main/docs/api/app.md)。复用现有路径解析、工作区权限与 Harness 持久化机制，没有新增数据调度器。

## 空间控制

- 每个浏览器会话的 HTTP 缓存预算为 128 MiB；启动及每 6 小时检查一次，超过预算时通过 Electron 回收。编译脚本缓存超过 64 MiB 时回收。保留登录 Cookie、站点存储、对话和用户文件。这是定期回收阈值，不是整个目录的硬配额。
- 开发启动及安装版运行日志按 10 MiB 分段，保留当前和前一段；桌面主日志沿用 electron-log 的现有 1 MiB 轮转。
- 图片/视频提交前检查工作区和记录所在磁盘，下载保存前再次检查：除输出所需空间外，至少保留 512 MiB。空间不足会提示释放空间或选择其他磁盘；远端已生成的结果可用同一个任务 ID 重试下载，无需重新生成。检查不是磁盘预留，其他程序仍可能同时写入。
- 预览读取已有作品，不复制第二份媒体。对话历史、作品、宠物和回退副本不会自动删除，仍会随使用增长。迁移副本先保留，验收后由用户决定清理时间。可用其他盘上的 CODEBUDDY_HOME 或 CODEBUDDY_WORKSPACE_ROOT 分担空间。
- ComfyUI 服务端模型和输出由服务端管理，本地限额不会清理服务器磁盘。

缓存操作使用 [Electron Session API](https://www.electronjs.org/docs/latest/api/session)，避免删除整个浏览器配置档。

旧目录也可能仍被历史项目引用（例如早期宠物制作工作区）。此时原目录不只是回退副本，先处理项目引用再考虑清理，避免整目录删除导致旧会话素材失效。
