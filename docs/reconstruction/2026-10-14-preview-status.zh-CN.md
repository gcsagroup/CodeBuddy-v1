# Harness 首版预览：使用与验收说明

> 历史记录：本文描述早期普通聊天阶段，已由[第一版基础能力当前记录](2026-10-14-foundations-status.zh-CN.md)和[功能矩阵](v1-functionality.zh-CN.md)取代。本文的待接能力、进程号和测试数量不表示当前状态。

日期：2026-10-14。目录：`D:\CodeBuddy-v1`。本版是 Windows 开发预览，完整能力迁移继续按[总体方案](2026-10-14-harness-refactor.zh-CN.md)推进。

## 版本与源码

- 源项目：`D:\Users\jiangrui\Desktop\CodeBuddy`；基线 HEAD：`964bbeb1587f1c5551ee17907e0b26632c4163ce`，包含复制时的未提交文件。逐文件记录见 [source-baseline.json](source-baseline.json)。
- Harness 包固定为 `@deepseek-ai/dsh@0.2.1-alpha.2` 和 `@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2`；上游源码标识：`d743267388641bc76f17c45ce8b4c231aed1d32c`。
- 原 renderer 界面、样式、文案、交互与 SDK 源码冻结。Electron `main.ts` 调整启动与隔离；专用启动器将原 ACP 客户端连接到新版服务。已接通的普通聊天任务通过真实 Harness 执行循环运行。
- 使用 Node.js 24、Electron 41.1.0。当前交付形式为开发启动；尚未制作独立安装包，未创建分支、提交或推送。

## 本版范围

| 能力 | 当前范围与验收边界 |
| --- | --- |
| 模型配置 | 使用原设置界面管理 OpenAI 兼容、Ollama 连接和默认模型；首次启动打开原配置页面。 |
| 普通文本对话 | 原普通聊天 ACP 路径连接 Harness；正文、上游实际提供的思考增量和工具结果映射到原消息界面。默认 CodePro 工作台任务尚未接通。 |
| 文件与 PowerShell 工具 | 在普通会话路径接入 Harness 文件和 Windows PowerShell 工具；执行前经过原界面的权限询问，拒绝后不执行。CodePro 工具链另行迁移。 |
| 取消 | 在生成进行中处理停止请求，不等待整轮完成后才取消。 |
| 历史 | 新版会话及配置独立持久化；重启后可列出并回放新版历史。旧版历史导入仍待实施。 |

这些是首版实现范围。原界面的全部菜单和默认 CodePro 入口仍保留；菜单可见或模型配置成功不代表 CodePro 新任务已完成迁移。另提供可选普通聊天入口，通过 `CODEPRO_UNIFIED_MODE=false` 打开原有普通模式，默认入口保持原值。用户已亲自配置 `https://ollama.com` 的 `kimi-k3` 并明确同意保留配置、继续验证；真实无工具对话共 3 轮成功，重启历史回放及 6 条用户/助手消息顺序通过。完整任务、真实模型工具执行和取消及其他能力仍待专项验收。

## 启动与配置

当前机器已准备项目本地依赖，两个入口共用新版数据，启动器会选择可用的 Node.js 24：

| 入口 | 用途 |
| --- | --- |
| `D:\CodeBuddy-v1\start-preview.cmd` | 保持原默认 CodePro 工作台路由；可查看原配置和页面，CodePro 新任务仍待迁移。 |
| `D:\CodeBuddy-v1\start-chat-preview.cmd` | 可选的原普通聊天模式；用于当前已接通的 Harness 文本对话。 |

双击所需入口即可。也可在 PowerShell 显式指定已验证的运行时启动默认入口：

```powershell
Set-Location 'D:\CodeBuddy-v1'
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' 'D:\CodeBuddy-v1\scripts\start-harness-preview.cjs'
```

启动器编译已有 SDK 和语言资源，启动认证的本机兼容服务，再启动原 Electron 界面。它不运行旧 Rust Agent 的构建或启动入口。

1. 首次启动在原模型配置页面添加自定义服务，选择 OpenAI 兼容或 Ollama，填写自己的地址、密钥和模型。
2. 保存会读取模型列表，并发送一条简短模型验证请求；请求发往填写的服务，可能按该服务规则计费。
3. 选择真实默认模型并检查保存结果。用户已配置 `kimi-k3` 并授权保留；后续普通聊天可从 `start-chat-preview.cmd` 打开。预览不自动连接源码中的默认 LAN 地址。原默认 CodePro 新任务仍待接通。
4. 普通模式的专项验收顺序为：普通文本 → 专用工作目录中的文件读取、写入和 PowerShell → 停止操作；逐项核对权限提示、工具结果与实际文件。
5. 退出并重新启动，核对模型配置，以及专项测试中已生成的新版历史。不要将普通模式结果扩展为 CodePro 验收通过。

Windows 退出所有窗口会结束本次桌面进程；启动器随后回收自己启动的后端。也可在启动终端按 `Ctrl+C` 退出。macOS 的生命周期和发行验收另行进行。

## 数据、日志和隔离

- 新版默认数据：`D:\CodeBuddy-v1\.preview-data`；后端状态：`.preview-data\backend\state.json`。
- Electron profile：`.preview-data\state\electron-app`；Harness 持久化：`.preview-data\backend\harness`。
- 启动记录：`.preview-data\logs\preview\launch.json`，包含本次 PID、端口、路径和退出状态，不含认证密钥。
- 日志：同目录 `prepare.log`、`runtime.log`、`electron.log`；Electron 主进程日志在 `.preview-data\state\electron-app\logs\main.log`。
- 保持原项目及旧版数据独立；本轮不自动迁移历史、配置、记忆、凭据或定时任务。新版保存的密钥由 Windows 当前用户 DPAPI 保护。
- 候选版禁用旧更新渠道、旧协议注册、旧版 shim 覆盖和默认 LAN 注入。调试端口默认关闭；受控验收可通过 `CODEBUDDY_PREVIEW_DEVTOOLS_PORT` 仅在 `127.0.0.1` 开启。
- 自动验收通过启动器的绝对 `dataDirectory` 参数使用独立目录。用户在该窗口亲自配置真实服务后，已明确授权保留；新版后端配置及 Harness 会话已保存至默认 `.preview-data`，原验收 profile 同时保留。重启后的配置读取、历史回放和继续对话均通过。这是本轮新版数据保留，旧版数据导入仍待实施。

## 验证记录

整合命令 `node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/start-harness-preview.test.cjs` 已通过 40/40，日志见 `.preview-evidence\automated-tests.log`；下表分组计数包含在这 40 项中，原 UI 的 40 项单独运行。源码冻结检查匹配 1069 个文件。

| 验证层 | 当前记录 |
| --- | --- |
| SDK、语言资源、桌面类型检查 | 已通过，退出码 0。 |
| 修改文件 ESLint | `ui/desktop/src/main.ts` 已通过，退出码 0。原文件既有 Prettier 告警未做全文件格式清理。 |
| 原 UI/连接/路由测试 | 40 项通过：模型配置/Onboarding 24，连接/路由 16。 |
| 新启动器 | 4 项通过，包含真实子进程、隔离 profile、首次导航、故障退出和进程回收。 |
| ACP/provider 兼容服务 | 整合回执：20 项通过，含 ACP 14、provider 6。 |
| 真实 Harness driver | 主 Agent 整合回执：9 项通过，使用受控模型协议；含密钥/header 实际发送与落盘无明文检查。 |
| ACP → Harness 整链 | 主 Agent 整合回执：7 项通过，含父测试 1、子测试 6；真实供应商效果另验。 |
| Windows 真实 Electron 界面 | 原设置和普通聊天路径通过：模型配置、3 轮真实对话、重启历史回放，以及实时用户/助手 6 条消息顺序。原 renderer 保持冻结。 |
| 用户真实模型服务 | `https://ollama.com` / `kimi-k3` 返回 `CODEBUDDY_HARNESS_REAL_OK`、`CODEBUDDY_HARNESS_RESTART_OK`、`CODEBUDDY_HARNESS_ORDER_OK` 及 token usage；3 轮均未调用工具。完整任务、真实模型工具执行和取消尚未验收。 |
| macOS、安装包 | 尚未验收。 |

真实界面回执见 `.preview-evidence\real-model-ui.json`，截图见 `.preview-evidence\real-model-restarted.png`。最终交付回执 `.preview-evidence\final-validation.json` 记录于 2026-10-14 16:11:52（Asia/Shanghai）：已使用 Windows PowerShell 5.1 执行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\CodeBuddy-v1\start-preview.ps1 -OrdinaryChat`，窗口标题为 `CodeBuddy`；Electron 主进程 PID 2196，启动器 PID 28420，后端 PID 30200，Forge PID 10456。交付实例使用默认 `.preview-data`，调试端口关闭；用户/机器环境变量、进程 PATH 和旧协议注册指纹与启动前一致。PID 是该次验收快照，后续启动以 `launch.json` 为准，其中 `desktopPid` 指 Forge 启动进程。

## 后续迁移

- 旧版聊天历史可读导入、配置和记忆迁移；未完成旧任务在新版重新发起。
- 定时任务迁入后默认暂停，逐项验证，核对旧版对应日程停用后再启用。
- MCP 与插件执行、CodePro 执行和调度、视觉与电脑控制、记忆、技能、配方等完整能力迁移。
- macOS 凭据、工具、真实桌面流程及发行构建；顺序保持 Windows 验收后再完成 macOS 验收。
- 正式打包、升级和回滚验证。

遇到未接通的能力应报告明确协议错误；不得将空结果、菜单存在或自动测试通过当作完整产品验收通过。

补充状态：该次交付实例于 2026-10-14 16:14:00 正常退出，桌面退出码为 0，启动器及后端均已回收，配置与历史仍保留。再次试用请双击 `start-chat-preview.cmd`。退出核验见 `.preview-evidence\shutdown-validation.json`。
