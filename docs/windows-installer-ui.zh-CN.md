# Windows 安装器界面

首次安装位置默认显示 `%LOCALAPPDATA%\Programs\CodeBuddy`。已存在同一 AppId 的 Inno 安装时，自动沿用注册的旧安装目录，用户仍可更改；不自动迁移 Squirrel 安装。应用内更新继续显式指定当前安装目录。

开始复制前通过 WMI 检查 `CodeBuddy.exe` 以及目标安装目录内的后台进程。发现运行进程时提示用户保存工作并退出后重试；查询失败也阻止安装。禁用 Inno 自动关闭应用，静默安装同样不得强制结束进程。

安装器使用 Inno 的原生浅色界面：白色内容区、浅灰底栏，统一字号、内容边界和按钮间距。安装位置页的浏览按钮与路径框等高；进度条上方直接显示当前操作和正在处理的组件，不使用展开链接或日志框；完成页采用左侧 CodeBuddy 标识、右侧说明与选项的双栏布局。

保留桌面快捷方式、开始菜单和完成后启动的原有选择。普通卸载先显示独立窗口，默认不勾选“清理个人数据”；勾选后另行确认实际数据目录。静默卸载始终保留数据。实际清理只在 Inno 最终确认后开始，使用随包 Node 的 `runtime/windows-uninstall.cjs`；失败中止程序卸载，报告保存在 `%APPDATA%\CodeBuddy\uninstall-cleanup.json`，文件删除过程中失败可能已部分清理。

清理读取现有数据位置，只处理 `backend`、`profiles`、`state`、`logs`、`plugins`、`config` 中的个人配置、凭据记录、聊天、宠物和缓存，以及数据位置记录；保留默认与旧工作区、会话/最近目录/项目元数据登记的项目、数据根下其他文件及历史数据目录。符号链接、目录联接、损坏元数据或确认后身份变化会阻止清理。不提供删除项目的勾选项，不操作 Windows 系统凭据库。安装详情显示组件摘要，内部依赖路径只进入诊断日志。

清理期间复用原生 profile 锁，活动运行时会阻止清理；锁文件及卸载报告保留。若某个登记项目覆盖个人数据路径，项目保护优先，相应记录可能保留。运行 `node --test runtime/tests/windows-uninstall.test.cjs` 验证隔离数据夹具；原生窗口、旧目录继承和真实进程拦截仍需要 Inno 编译及产品验收，不能由 Node 测试替代。

卸载页同样在进度条上方显示当前操作和组件，不使用展开按钮或日志面板。摘要依据安装索引中实际消失的文件更新，删除仍由 Inno 负责。程序图标在卸载开始时读入内存；索引只用于观察，越界项被忽略。运行 `node --test scripts/uninstall-details.test.cjs`，在隔离目录中验证可见及静默卸载、实际组件更新、用户数据与未安装项目文件的保留，并保存卸载窗口截图。

实现位于 `scripts/installer/installer-ui.iss`、`codebuddy.iss` 和 `install-details.iss`。运行 `node --test scripts/installer-ui.test.cjs scripts/windows-wizard-installer.test.cjs`，使用不同 AppId 的隔离小型安装器检查布局、详情和数据保留规则，并通过 PrintWindow 获取该窗口的原生截图。夹具关闭真实快捷方式及应用启动，不接触实际安装。

参考用户提供的安装器截图，仅借鉴排版与视觉层级，保留 CodeBuddy 的标识和行为。Inno 原生样式说明：[WizardStyle](https://jrsoftware.org/ishelp/topic_setup_wizardstyle.htm)。
