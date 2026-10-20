# CodeBuddy 图标

选定原图保存在 `codebuddy-selected.png`。正式母版 `codebuddy-master.png` 使用内置 imagegen 去除原图外部浅色背景，保留石墨黑圆角底与两条交错的白色括号；macOS 单色模板为 `codebuddy-template-master.png`。其他尺寸和格式由现有 Pillow 工具链等比导出。`concepts/` 仅保留候选方案，不参与构建。

在仓库根目录运行 `python ui/desktop/scripts/generate-codebuddy-icons.py`，一次更新应用内标识、favicon、PNG、Windows ICO、macOS ICNS、Linux SVG 容器和托盘资源。`src/images/prepare.sh` 调用同一脚本。SVG 嵌入同源 PNG，不是真正矢量图；更新提示仅叠加状态圆点。请同时提交母版和导出文件。

应用内统一使用 `CodeBuddyMark`；旧 `GooseLogo`/`Goose` 导入是兼容入口。托盘初始化和更新状态共用 `trayIconFileName`。第三方服务图标及历史文档插图不属于软件品牌资源。

Windows 托盘使用包含 16、20、24、32、40、48、64、128、256 像素图层的 ICO，避免系统从 1024px PNG 二次缩小。窗口通过 `setAppDetails` 指定任务栏图标，安装版 AppUserModelID 与 Squirrel 快捷方式一致；开发预览使用独立 ID。比例适配使用 contain，不拉伸非正方形原图。

已安装程序及旧安装包须重新构建、安装后更新；Windows 快捷方式缓存也可能延迟刷新。Windows、macOS 安装包的系统外观需分别在对应平台验收。

2026-10-19 Windows 本机验证：在 `D:\CodeBuddy-v1` 的 `main`、`732113504de3601ab087a609ce20827b814db2c2` 加当前未提交修改上构建 1.43.6。工作区还包含独立的运行时/macOS 修改，本次未提交或推送。

- `python ui/desktop/scripts/generate-codebuddy-icons.py`、图标/组件 Vitest 5 项、TypeScript `--noEmit`、分发配置测试 4 项与相关 `git diff --check` 均退出 0。完整 branding 测试此前为 4 通过、1 失败，失败项是 HEAD 已存在的 TLS 指纹断言，与图标无关；未把该套件标为通过。
- 使用既有 Node 24.21.0 运行 `node scripts/build-harness-windows.cjs`，退出 0。产物 `out/make/squirrel.windows/x64/CodeBuddy-Setup.exe` 的 SHA-256 为 `baeabdecb6df02a8ea456ae9e6e037e5f04465a27330e9bbb5c1391aa7d78e70`。
- 在本机执行该安装器 `--silent`，退出 0；通过安装目录启动入口打开程序，菜单显示 1.43.6。打包 EXE、安装器、安装后的主 EXE 和启动入口 EXE 的全部 9 层图标均与源 ICO 一致；6 项安装后图标文件哈希也一致。开始菜单快捷方式 ID 为 `com.squirrel.CodeBuddyHarness.CodeBuddy`，桌面快捷方式工作目录为 `app-1.43.6`。
- 真实窗口标题图标、版本菜单和资源管理器中的新快捷方式图标预览已观察，预览比例正常。桌面工具没有返回任务栏/托盘弹出区，故两处实际外观仍待直接确认；macOS 系统外观未验收。未清理 Windows 图标缓存。

本地证据位于仓库 `.preview-evidence/branding/`，不纳入提交。旧版 1.43.5 安装器保存在该目录；现有用户配置与历史未主动清除。

同日桌面图标复核：用户截图显示桌面仍使用旧图。确认桌面快捷方式目标与 EXE 图标正确后，备份该快捷方式，将其图标来源从固定路径的启动 EXE 改为已安装 `app-1.43.6/resources/images/icon.ico`，保留启动目标及 AppUserModelID。用户随后确认桌面已显示新图标；证据支持旧图标缓存引用是原因。此项为本机快捷方式修复，未修改安装器，后续重新安装会重新创建快捷方式。

生成提示词见 [English](README.en.md)。繁體版见 [README.zh-TW.md](README.zh-TW.md)。
