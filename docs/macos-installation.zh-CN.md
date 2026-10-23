# Mac 安装、更新与卸载

## 安装与更新

打开 DMG，将 CodeBuddy 拖入 Applications（应用程序），弹出磁盘映像后从“应用程序”启动。安装窗口包含拖放箭头与操作说明。更新时退出旧应用并替换应用副本；不要先运行清理卸载。数据仍位于 `~/.CodeBuddy`，已有自定义数据位置继续有效，不做目录迁移。Windows 安装器不受影响。

## 卸载

安装版菜单“CodeBuddy → 卸载 CodeBuddy…”提供两个选项：

- **保留数据（推荐）**：仅删除当前应用副本，保留聊天、配置、宠物、项目、钥匙串和系统授权。
- **清理应用数据**：展示当前数据根下的应用目录、偏好与位置记录；项目默认保留。只有额外勾选后，才删除当前数据根的 `workspaces` 和 `backend/workspaces`。

最终确认显示路径及预计逻辑大小。程序退出、运行服务结束后才执行删除；文件身份或父目录发生变化时停止。清理只针对已知应用目录，不遍历删除外部项目，不追踪符号链接；未知文件、历史数据目录、其他安装副本和迁移备份保留。逻辑大小不等于实际释放磁盘空间。

清理模式还尝试移除本应用专用钥匙串项 `local.codebuddy.credentials.v1 / aes-gcm-master-v1` 和重置 `local.codebuddy.desktop` 隐私授权；检测到仍保留的凭据存储时保留共享密钥。系统拒绝或文件残留会报告为部分完成。结果写入系统临时目录 `codebuddy-uninstall-*/result.json`，结束窗口显示准确位置。直接把应用拖入废纸篓不调用此清理流程。

该入口仅在打包的 Mac 应用中提供，不作为 Agent/MCP 工具，不改变 Harness 执行权威。公开分发仍需合适的签名与公证。

## 验证

逻辑测试：`node --test runtime/tests/macos-uninstall.test.cjs`。桌面组件测试沿用 `ui/desktop` 的 Vitest 入口，目标为 `src/storage/macosUninstall.test.ts`。Mac 构建沿用 `node scripts/build-harness-macos.cjs --arch arm64 --node-license <Node LICENSE>`，只使用既有原生依赖。

隔离测试覆盖保留数据、项目默认保留、显式删除工作区、符号链接、路径替换、部分失败与取消；系统钥匙串/TCC 在逻辑测试中使用替身。真实安装版的界面、卸载与重装验收结果应另行记录，不由自动化通过推导。

## 设计参考

[Apple 卸载应用](https://support.apple.com/en-ie/102610)、[VS Code 清理卸载](https://code.visualstudio.com/docs/setup/uninstall)、[Homebrew zap](https://docs.brew.sh/Cask-Cookbook#stanza-zap)。采用应用和数据分离、项目单独确认的方式；DMG 使用系统 Finder、AppKit 与 hdiutil，未引入新的安装依赖。

Mac 打包校验使用随机命名的临时钥匙串项，验证加密、解密、篡改拒绝及 Unicode 后自动删除；不访问用户正式主密钥。
