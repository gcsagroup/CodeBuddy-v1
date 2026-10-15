# CodeBuddy 0925-2211 后续实施记录

## 来源与边界

计划：`docs/superpowers/plans/2026-09-26-codepro-conversation-e2e-followup.zh-CN.md`。

基线 `25d4d48c1c2f90ef161f726bc1a76f013cd1ee5f`，分支 `fix/codepro-context-compaction`，目录 `C:\Users\admin\CodeBuddy`；包含此前未提交源码，不创建或切换 worktree，不提交/推送。

本轮没有新增测试，也没有执行测试、回放、自动 E2E 或模型业务请求。已有测试调用点仅同步函数新增的 workspace 参数，不改变断言。编译不代表业务验收。

## 已实施

- `CodeProToolContent.tsx`：计划默认折叠，预览最多三条尚未勾选的 Markdown 清单项；这是模型计划展示，不是权威当前阶段/完成状态。完整计划保留在展开区。
- `ProgressiveMessageList.tsx`：整组摘要仅用真实操作计数，不用最后一项文件名概括全组；继续保留正文、审批及错误边界。
- `ToolCallWithResponse.tsx`、`toolActionPresentation.ts` 及语言目录：命令和任务检查使用本地化标题；内部任务检查失败仍显示失败，但不强制展开内部参数。其余失败保留现有显露方式。
- `GooseMessage.tsx`、`MarkdownContent.tsx`、`styles/main.css`：收窄主要正文与操作组阅读宽度，修复被 initial 清空的字体/字重变量，提供中文系统字体回退；行内路径不再被橙红色强调；技术详情轻量折叠并限高滚动。
- `main_agent_contract.rs`、`agent.rs`：明确现有合同必填字段及 retained/replaced 语义，保留错误原因链，使缺失字段等具体原因可被模型处理。公开沟通指令以用户结果和下一步为先，避免把内部覆盖登记当交付结果；提醒保留有用的诊断日志和验证脚本。
- `codepro_terminal_report.rs`、`tool_task.rs`：未完成报告消费已有动作退出码与文件变化，不新增完成证据；路径清单放进技术详情，工作区内转相对路径。清楚区分非零退出、已发生文件变化及业务验收。

## 暂未改变的核心行为

失败动作伴随 workspace delta 被统一记为 unknown 的门槛尚未改变，有限扩展授权已单独提出。启动后台服务时的输出收集超时，与备份/删除后的已知部分失败必须分别处理；不能用后续测试通过直接抹掉未知副作用。UI 改进不意味着此链已经修通。

未修改权限模式、授权范围、委派生命周期、持久化协议、模型配置或原始 E2E 文件。未增加 Judge、总结 Agent、工具黑名单或第二套事实库。旧会话中的模型原文不会被 UI 自动重写为新报告。

## 编译与交接进度

- `cargo fmt --all`：退出 0。
- 定向 Prettier：退出 0。
- `pnpm.cmd run typecheck`（desktop）：退出 0。
- 标准 `pnpm.cmd run ensure-dev-backend`：正在构建，完成后补记。
- 旧桌面进程 21680 已通过 CloseMainWindow 正常发起关闭，路径核对为本仓库 Electron，不操作其他应用。

最终构建、启动身份及日志交接另见本轮 E2E 交接页；在启动完成前不标记 E2E-ready。

## 用户要求聚焦体验后的继续收尾

完整补看同目录正反例截图后，本轮不以第一批局部排版改动为交付：

- `BaseChat.tsx` 将真实主对话、文件区域与输入区统一为居中的阅读列；直接消费现有 activeToolCallIds，在输入区上方显示正在执行的操作。等待用户输入、压缩等沿用现有状态，删除对旧任务列表有数据才显示进度的依赖。
- 新增纯展示组件 `CodeProConversationFiles.tsx`：从当前会话请求和成功的本地写入审计回执关联文件，不扫描 Git dirty 变更，不解析最终自然语言。摘要显示少量文件名，展开复用已有阅读能力。缺回执、shell-only 变化不假装覆盖。
- `CodeProFileViewer.tsx` 显示工作区内相对路径、限制阅读区高度；读取当前文件而非历史快照。处理读取异常和快速切换文件时迟到结果覆盖的问题。
- 操作采用轻量线条图标；执行中使用运行标识，失败保留独立行和警示，不自动铺开整段 stderr。展开命令后直接读取已有 rawOutput 的退出码，失败详情不因此丢失。
- 历史计划保留原内容，仅最新计划显示短预览，不把最终勾选状态倒灌到过去。
- `MessageUsageStats.tsx` 的工具旁统计改为可悬停/聚焦查看的图标；`CostTracker.tsx` 未获成本值时显示未知占位而非 0.0000。没有改写成本计算事实。
- `LoadingGoose.tsx` 压缩提示使用本地化文案，不暴露内部 task ID，也不承诺未经确认的自动恢复。新增文案提供简繁中文，其他目录新文案暂用英语兜底，未冒充完整人工翻译。

这一批仍未运行测试、视觉自动化、浏览器业务请求或模型 E2E。用户自行体验。前端类型编译继续作为必要编译步骤，不当成体验结论。

最终前端 `pnpm.cmd run typecheck` 退出 0。过程中修正了一处 Array.at 与当前 TypeScript lib 目标不兼容的问题，使用现有目标支持的数组操作，没有调整编译目标。新增和修改代码经定向 Prettier 格式化。

### 构建环境插曲

首次标准后端构建退出 1，底层 llama-cpp-sys-2 构建脚本因找不到 cmake 退出 101。只读检查确认本机 Visual Studio Build Tools 存在；受限进程未正常发现工具环境。没有安装依赖、清缓存或更换配置，使用同一 ensure-dev-backend 入口经授权环境重新构建。该次结果待补录。

### 最终交接

第二次同入口后端构建退出 0，耗时 13 分 52 秒；标准 start-gui 完成 SDK/语言资源/Electron 开发构建，14:22:40 收到 React ready。进程和后端副本来源已核对，候选身份、哈希、日志与用户入口见 `2026-09-26-codepro-conversation-followup-e2e-kit.zh-CN.md`。前端改动期间没有测试；编译只证明可以构建，体验仍由用户判断。

最后补齐操作组内展开的单滚动容器、常见桌面观察/委派动作的本地化标题、切换会话时文件阅读状态隔离。未扩大到侧栏重建或新增主题系统，未擅自修改 unknown 完成门槛。构建脚本按既有流程清理自己的 Vite 生成缓存，不存在为绕过失败手工删除依赖/缓存的操作。
