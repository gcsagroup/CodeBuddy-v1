# 首版 Harness 预览实施计划

> 执行：采用 writing-plans 拆分任务，在已批准的 D:\CodeBuddy-v1 内并行实施，按任务测试与审查；不创建分支或提交。

**目标：** 原 CodeBuddy 界面连接真实 Harness，交付可启动、可查看且明确能力边界的 Windows 开发预览。

**架构：** 原界面和 SDK 合同保持；Node ACP 兼容服务连接固定版本的 Harness driver；新版独立存储，旧核心不承担新任务。

**技术栈：** Electron/React/TypeScript、Node、WebSocket JSON-RPC、deepseek-harness。

**2026-10-14 进度：** 首版实现与交付已完成：整合测试 40/40、原 UI/连接/路由测试 40/40，冻结文件 1069 个匹配。原 Electron 配置与普通聊天路径完成真实模型验收，并已启动无调试端口的用户实例（Electron PID 2196）。默认 CodePro 新任务、MCP、旧数据迁移、macOS 和完整产品验收仍待完成。运行、证据与边界见[首版说明](2026-10-14-preview-status.zh-CN.md)。

**真实模型与交付：** 用户亲自配置 `https://ollama.com` 的 `kimi-k3`，并明确同意保留配置、继续验证。普通聊天 3 轮均返回指定文本与 token usage；重启历史回放及实时用户/助手 6 条消息顺序通过，均未调用工具。新版配置与 Harness 会话已保存到默认 `.preview-data`。`start-chat-preview.cmd` 可选打开原普通模式；默认 `start-preview.cmd` 的 CodePro 路由保持不变。完整任务、真实模型工具执行和取消、CodePro 等能力继续单独验收。

## 全局约束

- 界面、交互、文案、样式冻结；仅宿主启动、连接与打包可改。
- 基线包含原项目未提交修改；原项目只读。
- 上游调研 SHA：d743267388641bc76f17c45ce8b4c231aed1d32c；安装必须记录实际包版本与源码身份。
- 独立数据、进程和应用身份；不抢旧协议、修改系统 PATH 或自动迁移凭据。
- 本轮先提供已验证预览；其余整体方案功能继续列入迁移清单，不以占位成功冒充接通。

## 任务 1：源码基线

文件：scripts/create-source-baseline.mjs、docs/reconstruction/source-baseline.json。

- [x] 以 git ls-files -z --cached --others --exclude-standard 取得源文件，复制到新版；排除构建产物、依赖及私人文件。
- [x] 逐文件记录 SHA256；前端复制后哈希必须与源一致；拒绝覆盖已存在的不同内容。
- [x] 记录源 HEAD、dirty 状态及实际复制文件清单。

验证：node scripts/create-source-baseline.mjs --verify；要求所有冻结文件匹配。

## 任务 2：真实 Harness driver

文件：runtime/harness/index.mjs、runtime/harness/package.json、runtime/harness/test/。

接口：

```js
const driver = await createHarnessDriver({ dataDir });
await driver.createSession({ sessionId, cwd, provider, model });
await driver.prompt(sessionId, content, { onEvent, signal });
await driver.cancel(sessionId);
await driver.close();
```

- [x] 固定上游依赖并验证可加载，使用上游执行循环。
- [x] 对接会话、实时正文/思考、工具调用回执和取消。
- [x] 用受控模型协议夹具验证真实 Harness 路径；真实供应商验证另外记录。

验证：node --test runtime/harness/test/*.test.mjs；记录使用的 Node 绝对路径。

## 任务 3：ACP 兼容与持久化

文件：runtime/server.mjs、runtime/compat.mjs、runtime/store.mjs、runtime/tests/。

- [x] 实现本机认证和 initialize、会话新建/加载/列表、prompt、cancel，以及原界面启动必需配置/provider接口。
- [x] 映射真实 driver 事件，独立控制连接可在 prompt 进行中停止执行。
- [x] 保存新会话历史及设置；未接通的方法返回明确协议错误。
- [x] 测试错误凭据、未知方法、工具/思考顺序、取消、重启历史与状态隔离。

验证：node --test runtime/tests/*.test.mjs。

## 任务 4：Electron 接线

文件：ui/desktop/src/main.ts、scripts/start-harness-preview.cjs、start-preview.ps1、start-preview.cmd、start-chat-preview.cmd。gooseServe.ts、preload.ts、renderer 无须修改。

- [x] 启动新版 Node 服务，沿原 ACP 客户端连接。
- [x] 隔离 userData、协议注册和自动更新；保留原界面。
- [x] 运行组件/类型检查，再使用真实 Electron 入口启动。

验证：使用原项目现有 typecheck、聚焦组件测试及新版文档明确的 preview 启动命令。

## 任务 5：交付

- [x] 核对冻结文件和允许变更清单，审查兼容服务不调用旧核心。
- [x] 运行首版真实界面关键路径：配置、3 轮普通文本对话、重启历史与消息顺序；记录模型、进程 PID、日志、源基线与启动命令。
- [x] 更新简体、繁体、英文运行说明及已完成/待迁移清单。
- [x] 启动首版供用户查看；自动化、受控模型、真实模型、产品验收分别报告。完整迁移待办保留在首版说明和总体方案中。
