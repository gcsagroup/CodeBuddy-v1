# 1504 E2E 用户旅程修复实施记录

## 授权与来源

- 用户批准按 2026-09-27 1504 E2E 对照分析实施；本批不运行测试，完成构建后交用户 E2E。
- 工作区 `C:\Users\admin\CodeBuddy`，分支 `fix/codepro-context-compaction`，基点 `25d4d48c1c2f90ef161f726bc1a76f013cd1ee5f` 加已有及本批未提交改动。未切分支、提交或推送。
- 原始证据：`C:\Users\admin\Desktop\测试汇总\2026-0927-1504教务系统E2E`；产物 `C:\test\test_0927\edu_sys2`。不修改这些原始记录及项目。

## 用户以前困惑在哪里，本批如何改变

1. 计划长期 0/14 后变成 11/11，但还在执行：删除误导性完成比例，默认显示当前未勾选步骤和剩余项；完成清单在详情内。展开使用 Radix 浮层，不参与聊天区布局、不将正文顶走。计划仍由 Agent 更新，前端不从文件数量猜测完成；要求在阶段转折更新同一用户交付清单。
2. 文件列表重复：每个文件只有一个入口，当前文件预览与该文件的逐操作差异在同一条目下；Windows 大小写、分隔符、工作区相对路径归一匹配。不将累加操作行数冒充净 diff。
3. 进展突然整段弹出：ACP 无消息 ID 的工具预览原会并入之前匿名消息，使公开进展不能独立显示；改为每个 call ID 独立稳定展示，再原位合并增量。没有新增打字动画。实际模型增量时序仍需用户 E2E。
4. 底部重复“CodePro 正在处理中”：常规对话不再显示该额外加载标签；等待用户输入和压缩仍保留必要状态。
5. 未完成时只剩笼统否定：新增受阻交接提案 report_blocked，Main Agent 解释具体成果、实际检查、当前影响和下一步；宿主仍提交 Paused，不把文本当完成证据。预算正常 Finalize 不再直接跳过预留总结机会。重复相同未知结果时，新的无关检查不算核实进展。
6. 背景进程导致输出管道超时、可能查到上一轮服务：在原 shell 入口增加会话绑定的受管进程模式，复用已有 OS 进程组 owner。启动/状态/停止由随机 handle、session、cwd 和原命令定位；拒绝以任意 PID 替代。日志写入独立文件并提供有限尾部；Windows 端口归属必须属于该进程组，HTTP 就绪与业务验证仍另行确认。不会按端口杀掉其他服务。关闭后端会释放受管进程组。

## 不变的边界

- 旧会话没有进程 owner handle 的未知操作无法补造证据；仍保留，交接清楚说明。
- 用户回答 ask_user 不是执行证明，不用于清除 unknown；不再建议用户点击一个“确认完成”来修复内部状态。
- 仅同一个可信 owner/handle 确认整组退出，可结清该组未知的 stop；不消除历史写文件、外部副作用或其他 unknown。
- 进程已启动、端口归属、HTTP 响应、业务可用是不同结论；不能只凭 HTTP 200 宣称完整交付。
- 本批不制造新的通用任务状态库、服务部署平台或权限等级。原权限、审计、控制面、终态 owner 保持；有限扩展记录在事实权威地图。

## 验收重点（由用户执行，不由本轮自动测试替代）

- 在独立工作目录提出自然开发需求，观察开场、阶段文字是否实际增量显示。
- 展开计划与文件差异，正文阅读位置、滚轮和当前操作是否稳定；计划是否随阶段更新。
- 已有旧服务占用端口时，新任务应选择空闲端口，不能停掉旧项目；交付链接需对应新项目。
- 正常成功、可继续的受阻、预算暂停均应解释已有成果和下一步；不能用 ask_user 确认未知回执。
- 重启后旧进程句柄不可当活句柄使用；不能仅根据旧会话记录声称当前服务可打开。

## 构建与交付状态

- `cargo fmt --all`：退出 0。
- `pnpm.cmd exec prettier ...`：退出 1，当前命令查找未找到 prettier；没有安装依赖。改用仓库已经存在的 `ui/node_modules/.bin/prettier.cmd --write` 格式化本批前端文件，退出 0。
- `pnpm.cmd run typecheck`：退出 0，仅 TypeScript 编译检查，不是产品验收。
- `git diff --check`：退出 0，有仓库既有 CRLF 提示，无空白差异错误。
- 17:05 开始通过 `ui/desktop` 下 `pnpm.cmd run start-gui` 构建，未运行自动测试或产品 E2E。最终构建及启动结果待追加。
- 首轮 Rust 构建成功（4m49s），随后 SDK 的 prettier 写入 `types.gen.ts` 返回 `UNKNOWN: unknown error, open`，整体启动退出 1。只读核对显示该文件非只读，相关构建进程已退出；没有足够证据指定锁文件的来源。未安装依赖或手工清缓存。
- 首次编译运行期间补齐了受管 stop 的下一步提示和交接独占调用边界。为避免 mtime 启发式误把漏掉最后修改的二进制当新版本，复用 `ensure-dev-backend.cjs` 导出的工具链/环境解析函数，以同一 `cargo build -p goose-cli --bin goose --jobs <脚本原值>` 再让 Cargo 检查依赖指纹；不是更换 profile、features 或构建环境。
- 用户已明确确认无运行中/未保存工作，允许重启 CodeBuddy；仅关闭核对过路径的旧桌面进程及其 Vite，未关闭 Codex 或其他项目服务。
- 新空白项目目录已准备：`C:\test\test_0927\edu_sys3`。建议自然提示词：`开发一个完整的教务管理系统，做好后保持运行，并给我可以直接打开的地址和演示账号。`
- 会话仍使用原 profile `C:\Users\admin\.CodeBuddy`；E2E 后从桌面导出会话 JSON，和截图/看法放在新的测试汇总目录，不覆盖 1504 原始证据。

## 最终候选构建（17:19 更新）

- 同一构建环境下最后一次 `cargo build -p goose-cli --bin goose --jobs <脚本原值>` 退出 0，耗时 3m49s；仅剩未使用函数警告。
- 再次运行 `ui/desktop` 的 `pnpm.cmd run start-gui`，SDK 生成/编译、i18n、Electron main/preload 全部完成，命令退出 0。首轮 SDK 写入错误本次没有复现。
- Forge 输出启动成功后，相关桌面与渲染进程未保留。按照已有 runbook 的 automated-shell fallback，独立启动 Vite 和已编译 Electron，不更换 profile，不重建依赖。
- `target/debug/goose.exe` 与 `ui/desktop/src/bin/goose.exe` SHA256 相同：`4A2F585370986C8B7DB94463BDCED95A309A15C09DE7A36EE6C570CD016E6E39`。
- 候选为上述 revision 加当前未提交改动，不是该提交的干净构建；本轮没有提交或推送。
- 渲染服务 `http://127.0.0.1:5173/` 启动检查返回 200。启动日志：`.local-e2e/logs/20260927-1718-desktop.stdout.log`、同名前缀 `desktop.stderr.log`、`renderer.stdout.log`、`renderer.stderr.log`。
- 17:19:23 日志收到 `React ready`；随后进程检查确认窗口标题 `CodeBuddy`，桌面主进程 PID 20124，新后端 PID 15772（路径为本工作区 `ui/desktop/src/bin/goose.exe`），Vite PID 17996。桌面恢复的目录仍为旧 `edu_sys2`，用户新一轮请新建任务选择 `edu_sys3`。
- 未运行自动测试、Clippy 或用户产品 E2E；编译和启动不能证明真实流式观感、阶段计划更新、后台服务正确交付已通过。这些保留给用户验收。用户“继续”排队的原始原因本批未独立证实，不声称已修复。

## 本轮实际修改位置

- 计划与文件详情：`ui/desktop/src/components/codepro/CodeProCurrentPlan.tsx`、`CodeProConversationFiles.tsx`、`CodeProFileViewer.tsx`，以及 `ui/desktop/src/i18n/messages/en.json`、`zh-CN.json`。
- 增量消息身份与重复等待提示：`ui/desktop/src/acp/adapter/tools.ts`、`ui/desktop/src/components/BaseChat.tsx`。
- 阶段说明和受阻交接：`crates/goose/src/agents/main_agent_contract.rs`、`agent.rs`、`tool_task.rs`。
- 受管后台进程：新增 `crates/goose/src/agents/platform_extensions/developer/managed_process.rs`；调整同目录 `mod.rs`、`shell.rs`，及 `crates/goose/src/agents/workers/process_tree.rs`、`tool_execution.rs`。
- 边界与交付记录：`documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md`、本文。构建生成产物不代表额外手工修改范围；其余共享工作区原有改动保留。

## 计划呈现二次修订（用户反馈后，替代上文固定计划栏方案）

用户指出固定入口仍是宽卡片，展开后已完成项还需再次展开，而且全会话最新计划会覆盖多轮上下文。本次撤销固定 `CodeProCurrentPlan` 组件及隐藏历史计划的 `PinnedPlanContext`，不是继续在浮层内增加开关。

- 计划回到各自工具回执的对话位置，以无边框的“任务列表”文字行作为唯一入口；不再固定在输入框上方。
- 一次展开显示所有勾选/未勾选步骤，完成项弱化并划线，不再二次折叠。浅底区域最大宽 36rem，最大高 18rem，可滚动，无额外描边或阴影；收起时没有内容卡片。
- 每份计划保存其原始时序和快照，不做跨轮覆盖，也不通过文字相似度猜测两个计划属于同一个目标。当前 todo 回执只有 Markdown 勾选状态，不能据此把第一个未勾选项宣称为“正在执行”；本轮没有扩展计划协议来仿制 WorkBuddy 字段。
- 核对 ACP 实时 `MessageContent::Thinking` 与历史加载均已有 `AgentThoughtChunk` 输出，前端原先在 compact 模式统一隐藏。本轮恢复已提供的思考内容，以默认收起的“深度思考”呈现，展开限高可滚动；思考不再作为普通工具组中可跳过的空白消息。没有思考内容时不生成占位或冒充内容。
- 修改 `BaseChat.tsx`、`ProgressiveMessageList.tsx`、`GooseMessage.tsx`、`ToolCallWithResponse.tsx`、`ThinkingContent.tsx`、`codepro/CodeProToolContent.tsx` 和中文文案；删除上一轮新增的未提交 `CodeProCurrentPlan.tsx`。
- `pnpm.cmd run typecheck` 退出 0；局部 Prettier 与 `pnpm.cmd run i18n:compile` 退出 0。本次纯前端修改沿用现有 Vite 开发服务，无需重建/重启后端，没有运行测试或宣称产品视觉验收通过。

## 整体阅读密度修订

本次回看 `2026-09-26-codepro-user-experience-design-notes.zh-CN.md` 中的论坛调研摘要，采用“少噪音不等于少线索、熟悉位置和阅读连续性比新增面板重要”的方向；未将这些非系统抽样评论当作多数用户审美标准，也未重新声称核实各平台当前 UI 数值。

源码显示正文已经使用 14px 的 prose-sm，较突出的不协调来自 24/20/18px 标题、同为 14px 的代码和工具标签，以及各段空隙。本轮只收紧对话阅读层级，不改变窗口缩放和全局 rem，不将设置页、输入控件一并缩放：

- 对话正文 13.5px，行高 1.65；标题 18/16/14px，字重 500，并收紧标题上下间距。
- 普通操作、任务列表和思考入口 13px；Markdown 代码块 13px，已有 12px 原始详情不继续缩。
- 相邻对话间距 16px 调整为 12px；阶段段落与计划条目仅轻微收紧。保留组与组之间的分隔，未把所有留白删掉。
- 输入框仍 14px；主要导航保留 14px、侧栏会话名保留 13px；项目分组名由 14px/700 调为 13px/500，点击区不缩小。
- 对话内次要文字使用现有中性色提高可读性，深浅主题分别处理；缩小字号不能靠更浅的灰色换取安静。
- 实际文件：`BaseChat.tsx` 加局部作用域，`styles/main.css` 集中字号规则；`MarkdownContent.tsx` 代码字号采用作用域变量（其他页面保留 14px）；`ToolCallExpandable.tsx`、`ThinkingContent.tsx`、`CodeProToolContent.tsx` 标记次要入口；`CodeProWorkStep.tsx`、`ProgressiveMessageList.tsx` 收紧段间距；`Layout/NavigationPanel.tsx` 调整项目分组字重。
- TypeScript 检查退出 0，局部 Prettier 退出 0；最后的侧栏修改仅 className 字符串。无测试、无后端重建、无提交/推送；开发服务实时编译前端。没有实际视觉验收，不把源码尺寸宣称为与 Codex/WorkBuddy 在不同系统缩放下逐像素相同。

## 进程实现来源

进程归属复用项目已有 `SystemProcessGroupOwner`（Windows Job / Unix process group），没有依赖端口数字或模型描述推断归属。Windows 查询使用 `IsProcessInJob` 和只查询权限，接口及权限依据：[Microsoft 官方接口说明](https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob)。端口所有者无法查询时保持未知，不降级成已验证。
