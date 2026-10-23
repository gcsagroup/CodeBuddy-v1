# 电脑控制入口与进度反馈

## R19：视觉中断与 macOS 点击

2026-10-21 的 Kimi K3 微信会话已取得截图，失败发生在原生鼠标命中检查。现场只读探测中，Dock 矩形覆盖整个显示器，微信 AX 命中接口返回 `-25208`，实际鼠标命中窗口为微信。现改用 [AppKit 鼠标命中接口](https://developer.apple.com/documentation/appkit/nswindow/windownumber(at:belowwindowwithwindownumber:))，按系统鼠标派发规则判断准确窗口，保留真实遮挡、未知窗口和陈旧观察的拒绝行为；不按应用名跳过保护。

电脑控制截图若缺少可用的图片模型或辅助视觉，Harness 在下一步前报出可见错误并停止；已执行动作的原始回执保留，不自动重放。技能说明禁止用新建窗口快捷键代替激活，也不把空输入框当成消息已发送的证据。输入框已移除拼图图标和扩展数量入口，工具箱及斜杠菜单保持可用。

验证分开记录：Windows 视觉/ACP 回归 8 项通过；Mac 原生合同与 Go 测试、Harness 回归、打包及安装烟雾检查通过。Mac ACP 测试在 SSH 的钥匙串环境首次受阻，切换到已登录应用子进程后通过。真实模型发送消息由用户验收，以上结果不等于消息发送成功。

[繁體中文](computer-use-routing.zh-TW.md) · [English](computer-use-routing.en.md)

## 行为与边界

CodeBuddy 通过官方 Harness 的技能提供器内置 `computer-use`。技能目录和轻量 `skill` 加载工具在第一轮可见；具体 MCP 工具仍由 `search_mcp_tools` 按需加载。技能说明不等于连接成功，也不授予输入权限。执行、权限、技能优先级和持久化仍由原有 Harness 链路负责。

桌面任务的指导路径是：加载技能 → 发现电脑控制工具 → 枚举真实窗口 → 观察 → 操作 → 核对结果。不得把可见窗口列表当成已安装应用列表，不得凭英文应用名、旧窗口编号或记忆中的坐标盲操作。允许必要的单纯启动应用命令；启动成功不代表窗口已就绪。

技能明确要求：焦点、陈旧观察或用户接管错误先重新观察；持续失败时报告阻塞，不用 AppleScript、SendKeys 或其他盲操作脚本绕过。消息发送前核对对象与内容，发送后观察界面；退出码 0、输入派发成功和空输出都不是发送完成的证据。这是模型可加载的操作指导，真实模型是否遵循仍需产品验收，未新增按关键词强制路由或第二套执行器。

进度沿用原有结构化状态，仅更新简体、繁体、英文文案：请求等待显示“正在处理你的请求”，收到思考活动显示“正在思考”，正文输出显示“正在撰写回复”，工具返回显示“正在整理工具结果”。确认、取消、真实连接错误继续分别显示，计时保留。没有收到思考活动时不虚构模型正在推理。

## 本次证据与修改

2026-10-21 用户导出的 macOS 会话中，Agent 先执行整段 AppleScript，凭退出码 0 宣称完成；之后首次桌面输入没有先观察，并多次遇到前台 PID 未知的焦点拦截。导出内容不足以证明模型当时的全部工具发现过程或安装包身份。当前 `3126465` 已包含 AppKit PID 无效时使用 AX 前台应用身份的修复，本轮未更改该原生保护。Windows 底层失败原因尚未独立复现。

本轮文件：`runtime/harness/computer-skill.mjs`、`runtime/harness/skills/computer-use/SKILL.md`、`profile.mjs`、`tool-discovery.mjs`；相关 Harness 回归；`useWorkStatus.ts` 与组件测试、三语语言目录；浏览器夹具与测试；`stage-harness-distribution.cjs` 和 `verify-harness-stage.mjs`。打包步骤新增技能资源复制，产物检查新增实际加载技能校验。

## 验证记录

源码来源：`D:\CodeBuddy-v1`，`main`，`3126465` 加本轮未提交修改。保留工作区其他既有修改；未创建分支、提交或推送。没有构建新安装包。

使用现有 Node 24.19.0 执行，以下命令退出码均为 0：

| 工作目录 | 命令（`node` 为现有 Node 24） | 结果 |
| --- | --- | --- |
| 仓库根目录 | `node --test runtime/harness/test/computer-skill.test.mjs runtime/harness/test/tool-discovery.test.mjs` | 8/8；首轮技能目录与加载入口、工具按需发现、权限拒绝 |
| 仓库根目录 | `node --test runtime/tests/library.test.mjs scripts/harness-dependencies.test.cjs` | 14/14；技能管理和现有依赖打包回归 |
| `ui/desktop` | `node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/codepro/useWorkStatus.test.tsx src/components/codepro/CodeProProgress.test.tsx` | 18/18 |
| `ui/desktop` | `node scripts/i18n-compile.js` | 语言资源编译成功 |
| `ui/desktop` | `node ../node_modules/@playwright/test/cli.js test tests/e2e/work-status.browser.spec.ts --reporter=line` | Edge 3/3，实际编译后语言资源，状态切换、确认与错误 |
| `ui/desktop` | `node ../node_modules/typescript/bin/tsc --noEmit` | 类型检查成功 |
| `ui/desktop` | `node ../node_modules/eslint/bin/eslint.js src/components/codepro/useWorkStatus.ts src/components/codepro/useWorkStatus.test.tsx tests/browser-fixtures/work-status.tsx tests/e2e/work-status.browser.spec.ts --max-warnings 0 --no-warn-ignored` | 定向检查成功 |
| `ui/desktop` | `node scripts/i18n-check.js` | 提取目录一致 |

最初调用 `pnpm run test:run …` 意外触发依赖协调和注册表访问，已中止（退出码 1）；日志显示依赖目录有变动，未观察到 tracked 锁文件变更。后续直接调用现有测试运行器，未再次安装依赖。首次测试暴露的夹具、期望值、文案规范化和 lint 问题均已修正后复验。

这些结果不代表真实模型已成功操作微信。Windows/macOS 的真实收件人识别、消息发送、焦点恢复，以及新安装包验证本轮均未执行；未向任何联系人发送消息。打包校验已补入流程，但完整 staging/安装验收尚待执行。
