# CodeBuddy 1.43.4 品牌与交付记录

## 修改范围

工作目录 `D:\CodeBuddy-v1`，分支 `main`，基线 `743bb5fbffd8592b900a93478df8b56f984957be`，加本批修改。没有切换分支。

- 桌面、安装包显示名称统一为 CodeBuddy；安装程序名为 `CodeBuddy-Setup.exe`，版本为 `1.43.4`。
- 使用现有 system-prompt 配置设置 CodeBuddy 身份；真实 HTTP 请求回归确认身份文本生效。执行、调度、完成与压缩仍由原有运行引擎负责，没有替换模型循环。
- 上下文来源提示、账户连接描述和任务状态文案使用产品名称；不修改用量数值、容量来源或完成状态语义。
- 简体、繁体、英文产品指南更新为当前启动和构建流程；桌面指南删除失效的启动命令。
- `CodeBuddyHarness` 安装识别、`.CodeBuddy-Harness` 数据路径、协议引擎值、依赖包名和来源记录保留兼容性。许可证、版权及历史验收记录未改写。本批未改变独立工具或下载依赖。

## 验证

使用已有 Node 24.21.0。以下命令退出码均为 0：

```powershell
node --test runtime/harness/test/driver.test.mjs runtime/tests/codepro-harness-projection.test.mjs scripts/windows-installer-tools.test.cjs
node --test runtime/tests/providers.test.mjs runtime/tests/harness-integration.test.mjs runtime/tests/codepro-harness-integration.test.mjs
node --test --test-name-pattern="desktop package identity|Harness stage" ui/desktop/scripts/codebuddy-distribution.test.cjs
# ui/desktop
node ../node_modules/vitest/vitest.mjs run src/components/bottom_menu/ContextWindowIndicator.test.tsx src/components/settings/models/ModelContextSettings.test.tsx
node ../node_modules/typescript/bin/tsc --noEmit
node ../node_modules/eslint/bin/eslint.js src/components/bottom_menu/ContextWindowIndicator.tsx src/components/settings/models/ModelContextSettings.tsx
```

对应 22、20、2、3 项通过，共 47 项。公开指南本地链接检查通过。原有 661 个会话、提供商和偏好配置保留检查通过。

初次扩展运行旧品牌/发行测试集合为 42 通过、10 失败。其中本批包描述不一致已修复并复测；其余 9 项涉及旧 TLS/遥测/默认模型断言、旧构建脚本和已删除的迁移模块，尚未清理，整套旧集合不标记通过。原始结果保留于本地 `.preview-evidence/h19-brand-tests.log`。

运行载荷检查通过：原生会话、PowerShell 子进程、Office 载荷及兼容服务。最长安装路径为 246 字符。首次桌面封装中断；使用相同已验证载荷重新执行完整桌面构建，未采用跳过源码构建的模式。

## 合并说明

合并本批源码和三语文档；不纳入 `.preview-evidence`、`target`、用户配置或凭据。保留现有安装 ID 与数据目录，避免改名造成另一套空白用户数据。不要全局替换依赖标识或许可证内容。

## 安装包验收

本次包内应用的真实界面已通过：窗口标题 CodeBuddy；Kimi K3 对话原生 `end_turn` 结束，会话出现 701 ms、助手内容出现 6809 ms、界面稳定 10285 ms（单次样本，不是延迟保证）。GitHub 账户连接、MCP 已停用、旧错误缺席均通过。

首次尝试受到测试目录中已启用但缺少 `CODEBUDDY_GITHUB_MCP_TOKEN` 的连接阻挡；通过真实工具箱开关停用该未配置连接后重测通过。未修改默认用户目录。该结果不等于 GitHub MCP 工具已验收。

本地证据：`.preview-evidence/h19-ui-receipt.json`、`h19-ui.png`、`h19-hello.json`。包内程序启动验收与实际安装／覆盖升级不同；本批未执行后者，也未重跑长项目、全部技能或 macOS。

安装器生成成功（退出码 0），完整 NuGet 与已测试应用的 app.asar / manifest 指纹相符。文件保留于 `target/codebuddy-1.43.4-before-merge/CodeBuddy-Setup.exe`，363784192 字节，SHA256 `865f58c2631dc4bf0c740e42f199d8bbf4a3d4482ac8f0af96d6bb977a3fcdc1`。此包仅含本批品牌修改，尚未合并同事的前端分支；不要作为合并后候选交付。
