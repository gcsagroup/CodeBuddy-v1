# 2026-10-25 桌面交互与历史加载开发说明

[繁體中文](2026-10-25-desktop-ux-and-history.zh-TW.md) · [English](2026-10-25-desktop-ux-and-history.en.md)

## 范围与职责

本批接续已合入的 10 月 23 日整合结果，包含图片操作、相对文件链接、历史加载、滚动、等待反馈、浏览器审批、插话队列及 Windows 工具运行库。执行、权限、取消、压缩和原生日志继续由现有 Harness 链路负责；没有改依赖锁文件、官方核心或持久化协议。

| 位置 | 接收、处理与输出 |
| --- | --- |
| `runtime/compat.mjs` | `session/load` 读取会话快照并做原有工作区校验，投影历史，输出 ACP 通知；只在历史重放中合并相邻、同消息 ID、同类型且全部元数据相同的助手文字或思考，新增合并帧不超过 64 Ki 字符。原来已经超大的帧不拆分。用户、工具、图片和元数据变化都是边界；不修改原始日志或实时输出。`session/info` 按字段投影元数据。 |
| `ui/desktop/src/acp/adapter/{messages,shared}.ts` | 适配器保留内部可变状态，对已知单条更新或插入只复制该消息，复用已隔离的其他快照；未知或批量变更仍完整发布。 |
| `ui/desktop/src/acp/chatSessionStore.ts` | 每条历史通知仍应用到状态；聊天 React 订阅在加载期间发布首次加载态和最终快照，其他控制与权限订阅不跳过。 |
| `ui/desktop/src/components/ChatInput.tsx` | 管理待发输入、编辑、发送及接受回执；沿用取消后等原生轮次和请求通道释放的屏障，不并行提交第二个 prompt。 |
| `ToolCallExpandable.tsx`、`ui/scroll-area.tsx`、`BaseChat.tsx` | 保留阅读锚点和显式展开，观察自然内容高度；确认本会话显式发送成功后回到最新。 |
| `runtime/work-status.mjs`、`ToolCallConfirmation.tsx` | 前者消费模型诊断投影真实等待阶段；后者展示收到的浏览器动作与对象，不决定权限、不修补模型参数。 |
| `ImagePreview.tsx`、`ui/desktop/src/main.ts` | 前者使用现有对话框实现键盘可达的放大与关闭；Electron 原生菜单负责复制图片和下载原图。 |
| `workspace-panel/workspaceFilePanel.ts` | 将合法相对文件链接交给既有主进程工作区路径校验；不按打包后 renderer 的位置解析。 |

## 交互合同

- 普通插话按先后顺序，在当前轮完整结束且发送通道释放后逐条执行。
- “立即发送”只冻结点击时明确未发送的队列项，按顺序合并文字和图片；不带走输入框草稿，不混入后来追加的消息，不重放接收状态未知的输入。
- 发送只在接受回执后从队列移除；拒收保留内容。主动停止撤销待执行的立即发送并保留队列；恢复、存储失败及未知回执继续走既有核对路径。沿用原存储格式。
- 只有多条普通待发消息才有展开入口；未知回执的核对操作保持可见。前端停止出队不等于 Agent 已暂停。
- 用户上翻阅读时，结算折叠尊重阅读状态；只有本会话确认接收的显式发送触发返回最新。拒收、切换会话、自动队列投递不触发这一滚动。
- HTTP 响应头仍表示等待；首个实际文字、思考或工具参数才表示收到内容。响应头不重新开始等待计时。
- 浏览器审批中的 URL、路径、标签、元素和输入以纯文本展示；缺少目标明确提示，不推断或自动批准。

## 加载计时与性能

后端 `[Session load timing]` 记录读取、工作区校验、投影、通知发送、恢复、问题、权限、配置和扩展等阶段。`updateCount` 包含历史与 usage 更新；`dispatchedUpdates` 只计历史 session 通知，二者不是相同分母。

前端 `session_load_timing` 串起 `open`、`initial_metadata`、`replay_response`、`final_metadata`、`store_ready`、`history_dom_committed` 和 `visible_commit`，并记录缓存命中及失败。观测最多保留 16 个会话；只记 ID、数量和时间，不记消息、工具参数或凭据，日志失败不阻断打开。

`visible_commit` 是渲染提交及绘制机会的观测点，不是操作系统合成器首帧；前后端阶段会重叠，不能直接相加。首次加载指当前 renderer 尚无该会话缓存，不代表清空操作系统文件缓存。

| 同场景首次打开，单次观测 | 基线 | 优化后 |
| --- | ---: | ---: |
| 1000 条消息、400000 字符 | 5164 ms | 2124 ms |
| 300 条消息、28800 个碎片 | 9469 ms | 3306 ms |
| 300 条复杂 Markdown | 4810 ms | 4211 ms |

这些是受控夹具，不含模型生成；不能外推全部真实会话。短会话未显示稳定收益。仅 renderer 的三组重复中位数中，1000 条消息的重放处理由 935.7 ms 降为 45.3 ms；这也不是整机打开耗时。

## Windows 工具依赖

`scripts/stage-harness-distribution.cjs` 从已有 `runtime/py/dependencies/python` 复制正式版 `vcruntime140.dll` 到暂存工具的 `runtime/tools/bin`，保留上游许可证。缺少文件时构建失败，不借用 System32、不下载或安装依赖。`scripts/verify-harness-stage.mjs` 验证副本与 Python 载荷一致并检查许可证；`scripts/windows-tool-runtime.test.cjs` 覆盖分发及缺失载荷拒绝。

## 验证与已知边界

本次合入复核：64 个前端文件、842 项测试通过；运行时、历史恢复、问题、默认模型与打包共 45 项通过；实际 Edge 中 24 项受控浏览器回归通过；TypeScript、相关 ESLint 和语言资源检查通过。第一次沙箱执行遇到临时文件 rename 的 EPERM，前端没有执行用例，运行时也未通过；保留记录后用相同命令在宿主隔离夹具复核。最初日志路径错误的两次命令未启动检查，不计通过。

聚焦复跑入口（仓库根目录）：

```powershell
node --test runtime/tests/history-replay-compaction.test.mjs runtime/tests/history-list-latency.test.mjs runtime/tests/harness-integration.test.mjs runtime/tests/work-status.test.mjs runtime/tests/questions.test.mjs runtime/tests/distribution-model.test.mjs scripts/windows-tool-runtime.test.cjs scripts/distribution-credentials.test.cjs scripts/windows-wizard-installer.test.cjs
```

桌面使用 README 的 typecheck、test:run 和 lint:check；相关用例涵盖 `src/acp`、`BaseChat`、`ChatInput.queue`、发送接受、图片、Markdown、审批和滚动。浏览器夹具为 `tests/e2e/scroll-area.browser.spec.ts`。既有 Windows 真实流程验证了图片复制/保存、上翻后发送、停止续聊、三条自动接续及显式合并发送；36 次滚动复现矩阵从 6 次空白变为 0 次。自动测试、受控浏览器和真实产品证据分别记录，不互相替代。

Win10、Mac 本批未实机验收；不把 Win11 的升级与运行检查外推到所有机器。模型原始协议串、错误参数及长时间无输出仍需独立跟进。压缩继续使用现有引擎，本批未实现摘要模型切换，也未完成真实同输入 A/B。

## 凭据与提交边界

只提交源码、最小回归和开发文档。周报、profile、原始会话、诊断脚本、截图、构建产物、安装登记和本地审计记录不提交。源码和分发均不恢复共享 Ollama Key 或旧 `distribution-credentials.json`；新用户自行配置凭据，已有用户配置不得覆盖。

提交前检查新增 diff、当前文件和基线之后新增的历史 blob；已知历史凭据的比对只在内存中进行，不打印或写入匹配内容。模式扫描和已知值比对均有范围限制；浅克隆不能证明远端所有历史、其他分支和以前安装包没有凭据。曾经分发的有效凭据应由持有人轮换或撤销，本批不擅自执行。
