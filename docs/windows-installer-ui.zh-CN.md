# Windows 安装器界面

手动安装先选择范围。“仅为我安装”默认使用 `%LOCALAPPDATA%\Programs\CodeBuddy`。“为此电脑上的所有用户安装”通过 Windows 请求管理员权限，默认使用 `%ProgramFiles%\CodeBuddy`。目录页显示该范围上次登记的位置、所需空间和目标磁盘可用空间。应用内更新沿用正在运行的安装范围和目录。全机卸载保留各账户的个人数据。

打开安装包后选择安装范围。选择所有用户时先确认 Windows 管理员权限，然后选择目录，点“安装”即可看到复制进度。

开始复制前通过 WMI 检查 `CodeBuddy.exe` 以及目标安装目录内的后台进程。发现运行进程时提示用户保存工作并退出后重试；查询失败也阻止安装。禁用 Inno 自动关闭应用，静默安装同样不得强制结束进程。

安装器使用 Inno 的原生浅色界面：白色内容区、浅灰底栏，统一字号、内容边界和按钮间距。安装位置页的浏览按钮与路径框等高；进度条上方直接显示当前操作和正在处理的组件，不使用展开链接或日志框；完成页采用左侧 CodeBuddy 标识、右侧说明与选项的双栏布局。

选择安装位置时检查当前账户能否写入，静默安装也会在复制前检查。目录无权限时提示改用默认位置或联系管理员。卸载个人安装时默认保留个人数据，也可以仅清理应用里的聊天历史，或清理全部受管理的个人数据。后两项均需确认，静默卸载始终保留数据。仅清理聊天时保留模型配置、工作区、诊断日志及单独导出的副本。清理在最终确认后执行，失败时中止程序卸载，详情见 `%APPDATA%\CodeBuddy\uninstall-cleanup.json`。

清理全部个人数据时只处理当前数据位置下的 `backend`、`profiles`、`state`、`logs`、`plugins`、`config` 以及数据位置记录。保留工作区和已登记项目。符号链接、目录联接、损坏元数据或确认后身份变化会阻止清理。

清理期间复用原生 profile 锁，活动运行时会阻止清理；锁文件及卸载报告保留。若某个登记项目覆盖个人数据路径，项目保护优先，相应记录可能保留。运行 `node --test runtime/tests/windows-uninstall.test.cjs` 验证隔离数据夹具；原生窗口、旧目录继承和真实进程拦截仍需要 Inno 编译及产品验收，不能由 Node 测试替代。

卸载页同样在进度条上方显示当前操作和组件，不使用展开按钮或日志面板。摘要依据安装索引中实际消失的文件更新，删除仍由 Inno 负责。程序图标在卸载开始时读入内存；索引只用于观察，越界项被忽略。运行 `node --test scripts/uninstall-details.test.cjs`，在隔离目录中验证可见及静默卸载、实际组件更新、用户数据与未安装项目文件的保留，并保存卸载窗口截图。

实现位于 `scripts/installer/installer-ui.iss`、`codebuddy.iss` 和 `install-details.iss`。运行 `node --test scripts/installer-ui.test.cjs scripts/windows-wizard-installer.test.cjs`，使用不同 AppId 的隔离小型安装器检查布局、详情和数据保留规则，并通过 PrintWindow 获取该窗口的原生截图。夹具关闭真实快捷方式及应用启动，不接触实际安装。

参考用户提供的安装器截图，仅借鉴排版与视觉层级，保留 CodeBuddy 的标识和行为。Inno 原生样式说明：[WizardStyle](https://jrsoftware.org/ishelp/topic_setup_wizardstyle.htm)。
