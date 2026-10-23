# Windows 安装器界面

安装位置默认显示 `%LOCALAPPDATA%\Programs\CodeBuddy`（通常位于 C 盘当前用户目录），不自动带入上次选择的 D 盘等安装位置。用户仍可通过路径框或浏览按钮选择其他目录；此设置不迁移旧安装或用户数据。

安装器使用 Inno 的原生浅色界面：白色内容区、浅灰底栏，统一字号、内容边界和按钮间距。安装位置页的浏览按钮与路径框等高；进度条上方直接显示当前操作和正在处理的组件，不使用展开链接或日志框；完成页采用左侧 CodeBuddy 标识、右侧说明与选项的双栏布局。

保留桌面快捷方式、开始菜单和完成后启动的原有选择，卸载仍保留用户数据与项目。安装详情显示组件摘要，内部依赖路径只进入诊断日志。

卸载页同样在进度条上方显示当前操作和组件，不使用展开按钮或日志面板。摘要依据安装索引中实际消失的文件更新，删除仍由 Inno 负责。程序图标在卸载开始时读入内存；索引只用于观察，越界项被忽略。运行 `node --test scripts/uninstall-details.test.cjs`，在隔离目录中验证可见及静默卸载、实际组件更新、用户数据与未安装项目文件的保留，并保存卸载窗口截图。

实现位于 `scripts/installer/installer-ui.iss`、`codebuddy.iss` 和 `install-details.iss`。运行 `node --test scripts/installer-ui.test.cjs scripts/windows-wizard-installer.test.cjs`，使用不同 AppId 的隔离小型安装器检查布局、详情和数据保留规则，并通过 PrintWindow 获取该窗口的原生截图。夹具关闭真实快捷方式及应用启动，不接触实际安装。

参考用户提供的安装器截图，仅借鉴排版与视觉层级，保留 CodeBuddy 的标识和行为。Inno 原生样式说明：[WizardStyle](https://jrsoftware.org/ishelp/topic_setup_wizardstyle.htm)。
