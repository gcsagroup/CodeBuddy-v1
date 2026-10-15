# CodeBuddy 1552 会话体验修复

## 范围与来源

用户八项反馈及 `C:\Users\admin\Desktop\2026-0926-1552教务系统E2E`：会话 `20260926_2`，223 条消息；6 张问题截图、5 张参考截图。文件夹时间不是任务开始时间，消息始于 14:31。本轮在 `C:\Users\admin\CodeBuddy`、`fix/codepro-context-compaction`、`25d4d48c1` 的已有 dirty worktree 实施，保留其他改动；不提交、不推送。用户负责测试，本轮不新增或运行测试。

## 已核对的原因

- 30 次 task_contract、50 次 shell、3 次 publish_progress。开头修订包含错误字段、retained 修改语义，以及超出 bounded validation 支持范围的命令；后段反复引用失效或当前任务不存在的 audit。另有真实的数据库锁、重复种子数据、URL 编码、后台进程与超时问题。不能把所有失败归因于界面，也不能全部归为权限。
- 模型公开说明只有开头、声称验证完成、最后重新提交三次。最后说明否认本会话产生过失败 action，但请求与回执就在同一 JSON 中；该自述不能视为事实。
- Main Agent 对普通文本暂存，避免未经完成门槛审核的最终文案直接成为交付；OpenAI-compatible 工具输入在 provider 解码层累积到完整请求才输出。只改 React 无法得到真实输入流。
- BaseChat 同时渲染浮动进度和输入栏进度；GooseMessage 把用量绝对定位在操作标题右侧，和状态/箭头重叠。
- 前端 ToolAudit 严格字段集合遗漏后端已有 taskScopeDigest，真实 v2 回执被丢弃，文件汇总因而缺失。
- 展开区 overscroll-contain 阻止边界滚动向聊天传递；外层自动跟随和 ResizeObserver 还会抢回阅读位置。这是源码确认的风险点，具体窗口滚动效果由用户验收。

## 本轮实施边界

1. 普通操作用动作与对象呈现；失败先用本地化、事实范围内的短说明，原始参数/英文错误降到诊断记录，不删除回执或把失败染绿。
2. 删除重复浮动状态。用量独立占位，显示输入/输出 tokens，详细数据保留悬浮层。
3. 阅读详情暂停自动跟随，限高区域允许正常滚动及边界传递。
4. 每轮结束折叠过程到最终回复上方；没有可信成功终态就称“本轮记录”，不称“已完成”。最终回复下方列本轮成功写入回执中的文件，保留当前内容查看，不伪造增删行数、撤销或业务完成。
5. 复用现有 SystemNotification 与 ACP ToolCall 通道传输展示专用的生成预览。完整请求仍是唯一执行入口，预览不注册 action、权限、证据或终态，不进入模型历史；中断时不可显示已落盘。按实际收到的参数快照更新，不模拟打字。非流式 provider 不承诺逐字输出。
6. 不在本轮放宽 bounded validation、改变未知副作用收口、修改证据新鲜度/所有权规则。失败根因与体验改善分别报告，未修项不称已解决。

## 验收交接

只执行格式化、类型编译及 README 的标准桌面构建/启动。用户观察新任务生成过程、展开滚轮、失败解释、最终过程收纳和文件汇总。历史记录能获得新布局，但不能补造当时不存在的进度或流式片段。

## 实施结果

- `BaseChat.tsx` 去掉对话布局中重复的浮动等待提示；`GooseMessage.tsx`、`MessageUsageStats.tsx` 将用量独立排布并显示输入/输出。
- `ToolCallWithResponse.tsx`、`toolActionPresentation.ts`、`CodeProToolContent.tsx` 改为动作与对象入口，原始参数、英文错误和审计记录移到二级诊断详情。错误仍可见，不伪装为成功。
- `ToolCallExpandable.tsx`、`scroll-area.tsx`、文件/Markdown 查看器调整限高滚动、边界传递与阅读时的自动跟随。
- `ProgressiveMessageList.tsx` 按用户轮次收纳结束后的执行过程，最终回复留在外面；`CodeProConversationFiles.tsx` 在回复后展示本轮写入回执文件。`toolAudit.ts` 接纳后端已有的可选 taskScopeDigest 并保留字段校验。
- OpenAI-compatible 与 Anthropic 流解码器输出展示专用参数快照，ACP 复用原调用 ID 更新预览，`adapter/tools.ts` 在完整请求抵达时替换预览。未执行的内容标记为草稿，不成为写入或完成证据。
- Main Agent 在持续失败且距上次公开更新已超过 60 秒时收到简洁进度说明提醒；不是保证模型一定解释的强制机制。合同注册错误补充未注册/未执行及普通操作与验收义务的区别，未改变接受范围。
- 相应界面文本已进入语言资源；保留已有其他改动。本轮未修改测试文件，未提交、推送。

## 实际编译与启动

| 项目 | 实际结果 |
| --- | --- |
| `cargo fmt --all` | 退出码 0 |
| 前端改动文件 Prettier | 退出码 0；语言资源修正后重新格式化 |
| `pnpm.cmd run typecheck`（桌面目录） | 最终退出码 0 |
| `pnpm.cmd run ensure-dev-backend`（桌面目录） | 退出码 0，5 分 39 秒；一个已有未使用函数警告 |
| `pnpm.cmd run start-gui`（桌面目录） | SDK、语言资源、Vite 主进程/preload 构建完成；常驻进程，不记退出码 0 |
| 桌面启动 | 17:06:16 收到 React ready；后端来自当前目录 `ui/desktop/src/bin/goose.exe`，PID 11940，端口 59374 |
| 自动测试 / 桌面业务验收 | 均未执行，按用户要求由用户验收 |

启动沿用标准脚本及原有 profile，没有另建工作区、安装依赖或制作安装包。日志中的 Crashpad、缺失 sourcemap 与 Electron API 弃用警告未阻止此次启动；不据此声称没有界面问题。未发送模型业务请求。

候选来源：`fix/codepro-context-compaction`，HEAD `25d4d48c1c2f90ef161f726bc1a76f013cd1ee5f`，包含未提交改动，不能仅凭 HEAD 复现。

- 后端 SHA256：`94FAB99E46EC6B14E1CFE7BE5D75CAECC4C2E51EE5833F44EC4D2CE6FD2CD9A9`。
- 源码指纹：`7c1823923106a9b5d08b8767c608225f0559ce6de8922d27275a341846f739b0`。将 Git 可见的 tracked/untracked 文件去重排序后，依次对路径、NUL、内容、NUL 做 SHA256；范围为 crates、ui/desktop/src、ui/desktop/scripts、ui/sdk/src、Cargo.toml/lock、rust-toolchain.toml、ui/desktop/package.json、forge.config.ts，共 1777 个存在文件。首次沙箱内 Node 调 Git 被拒绝，授权后的只读指纹计算成功。
- 本次后端日志：`C:\Users\admin\.CodeBuddy\logs\cli\2026-09-26\20260926_170610.log`。仍可从会话导出 JSON，与截图一并保留。

## 尚未宣称解决的内容

1. 失败还包括业务代码、进程启动、合同修订与失效证据问题，本轮没有全部修复，不能称整条开发链通过。
2. 实时预览只覆盖真实原生工具参数流与公开进度；普通最终回复仍受完成门槛暂存，非流式或工具文本转译路径不保证持续输出。历史不会补造旧预览。
3. 文件清单仅来自成功的显式写入/编辑回执，不是完整工作区 diff；命令间接修改未纳入，未实现撤销或伪造增删行数。
4. 自然语言失败解释依赖模型实际发出公开更新；界面提供本地化短说明与诊断下沉，不能代替模型对具体原因的解释。
5. 滚轮、预览节奏、长会话收纳与真实窗口观感仍待用户验收。可以复用教务系统任务观察，但旧项目已有产物，不应称为干净的从零 E2E。
