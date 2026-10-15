# CodeBuddy：逐步说明与按需详情

## 用户以前在哪里困惑，这次如何改变

用户补充的要求是：不只是最后能顺利用完，过程中每个工作步骤也要知道做了什么，用自然语言表达；具体代码改动在展开时查看。

本轮针对过程呈现实施，不把自然语言说明变成授权、证据或完成裁决，也没有修改冻结基线。

| 以前的断点 | 本次实现 |
| --- | --- |
| 主 Agent 主要在“大阶段”说明，阶段内部容易长时间只剩工具动作 | 主说明明确覆盖每个连贯的工作步骤：事前说明意图，收到回执后说明发现或改变，再接下一步；同一步的连续操作可以共用说明 |
| 只有失败且长期无公开说明时，才提醒 Agent 解释 | 成功推进时也检查公开说明间隔；在已有工具返回后提醒同一个 Main Agent 解释，不增加独立总结调用或阻断执行的门槛 |
| 连续成功操作默认被“工具记录 N 项”挡住，不知道读改了什么 | 在正文说明下面直接保留紧凑操作行，长列表限高滚动，每行仍可独立展开 |
| 正在生成代码或收到命令流式输出时，详情会自动展开 | 默认保持折叠，用户主动展开后仍可查看当前生成内容及输出；尊重此前主动选择的展开状态 |
| 命令正文出现在折叠行、每条操作重复显示 token | 命令正文进入详情；操作行不再附带用量页脚，总用量仍由原输入区显示 |

“自然语言是主体”仍由理解任务的 Main Agent 负责，前端不从文件名猜测业务成果。未收到有效公开说明的旧历史只展示已有动作，不补造事后解释；也不保证提示词能让所有模型在每一步都恰当地表达。这一项必须由用户在实际任务中体会。

## 调用链与边界

- `main_agent_contract.rs` 提供同一份逐步说明指令及已有 `codepro__publish_progress` 工具说明，`agent.rs` 注入并在长期未说明时提醒。提醒有独立节流时间，不把发出提醒当作已经向用户说明。
- 沿用现有公开进度请求/成功回执和实时参数预览；没有新事件类型、字段、状态库、Agent 或业务判定者。
- `ProgressiveMessageList.tsx` 消费实时与历史共用的请求/回执，普通成功操作组保持可读；审批、失败和未确认状态仍由原结构化状态呈现，不标为“已恢复”。
- `ToolCallWithResponse.tsx` 保持技术内容默认折叠；`toolActionPresentation.ts` 不再把完整命令拼进简短标题。`GooseMessage.tsx` 去掉紧凑操作行的重复用量页脚。
- `main.css` 对组内展开区使用同一个滚动容器；递归呈现时传递既有工作区路径，保留文件入口上下文。
- 同步调整既有列表用例中与本次默认展示变化直接相关的断言，未运行测试。

本轮没有修订完成门槛、暂停恢复或权限，也没有新增“打开系统／启动并打开”协议。此前受阻收尾模板仍需作为独立交接切片处理，不能把本轮称为整个用户旅程已经改完。

## 源码与构建记录

工作区：`C:\Users\admin\CodeBuddy`。分支：`fix/codepro-context-compaction`。HEAD：`25d4d48c1c2f90ef161f726bc1a76f013cd1ee5f`，加原有及本轮未提交改动。没有新建工作区、提交或推送。

已完成：

- `cargo fmt --all`：退出码 0。
- 已安装的 `..\node_modules\.bin\prettier.cmd --write`，仅本轮涉及的 TS/TSX：退出码 0。最初 `pnpm exec prettier` 未找到入口，未安装依赖，改用本地已存在的格式化器。
- `pnpm.cmd run typecheck`：退出码 0。
- `git -c core.safecrlf=false diff --check -- <本轮文件>`：退出码 0。
- `pnpm.cmd run build-goose-sdk`：退出码 0；使用既有构建脚本生成 SDK 并清理其指定的 Vite 缓存。
- `pnpm.cmd run i18n:compile`：退出码 0。

后端构建与桌面重启结果在完成后追加。用户明确确认当前没有未保存或运行中的工作，可以重启；旧主进程 PID 24108 已通过 `CloseMainWindow()` 正常关闭，返回 true。没有删除用户会话或修改模型配置。

第一次 `pnpm.cmd run ensure-dev-backend` 在受限进程中失败，脚本退出码 1，Cargo 退出码 101：`llama-cpp-sys-2` 找不到 `cmake`。只读核对发现，正常宿主权限下 `vswhere` 能找到既有 `Visual Studio 2022 BuildTools`，同一 `resolveWindowsBuildEnvironment()` 能取得 `INCLUDE` 和 CMake 路径；受限进程的记录中 `INCLUDE = None`。因此使用相同入口在正常宿主权限下重试，没有安装依赖、改变 toolchain/profile/features 或手工拼接构建变量。没有把首次失败记为通过。

重试结果：`pnpm.cmd run ensure-dev-backend` 退出码 0，Cargo dev 构建用时 14 分 37 秒，已同步 `ui/desktop/src/bin/goose.exe`。存在一条 `validation_invocation.rs` 中未使用函数的警告，本轮没有顺手处理。

`target/debug/goose.exe` 与 `ui/desktop/src/bin/goose.exe` 的 SHA256 均为 `404FB1396F0864A104936D9E90C7769C00A0FA1368AB14A4A22F21B4D6DA0049`。桌面从当前工作区按 `pnpm.cmd run start-gui` 启动，后台启动器 PID 24544，启动时间 2026-09-27 01:06:03（Asia/Shanghai）。启动器日志：`.local-e2e/logs/20260927-step-explanations.stdout.log`、同名 `.stderr.log`；长期运行入口不记为“退出码 0”。

首次桌面入口完成 SDK、语言资源、Vite main/preload 构建，并报告 `Launched Electron app`，但随后启动器、Electron 与 5173 监听一同退出。因此这次只记录构建完成，不记录持续启动成功。

随后按 `ui/desktop/BUILD_AND_E2E_RUNBOOK.md` 的 **Automated-shell fallback** 操作，没有另造构建入口：

- 独立运行 `..\node_modules\.bin\vite.cmd --config vite.renderer.config.mts --host 127.0.0.1 --port 5173`。页面服务 PID 7408，监听 `127.0.0.1:5173`。
- 独立运行 `..\node_modules\.bin\electron.cmd .`，使用上一步刚构建的 main/preload。桌面主进程 PID 16552，窗口标题 `CodeBuddy`；后端 PID 21836，路径 `ui/desktop/src/bin/goose.exe`，端口 62124。
- 01:08:36 日志收到 `React ready event received`。这是窗口与渲染启动证据，不是视觉或业务 E2E 通过；没有发送模型任务，也未独立验证模型此刻能完成请求。
- 备用启动日志：`.local-e2e/logs/20260927-step-renderer.stdout.log`、`.stderr.log`，以及 `20260927-step-desktop.stdout.log`、`.stderr.log`。

交接状态：本轮过程展示改动已构建并启动，空白试用目录和提示词已准备；产品体验由用户验收。原有交付状态解释和成果启动入口的后续工作不因此被宣称完成。

按用户约定：不运行单元测试、集成测试或产品 E2E。类型编译、后端构建和启动只证明对应准备工作，不代替过程文案与观感验收。

## 用户试用入口

已创建空白目录 `C:\Users\admin\CodeBuddy\.local-e2e-fixtures\step-explanations-20260927`，由现有 `.gitignore` 排除；也可以选用户自己的空白目录。本轮未在其中运行开发任务。

自然提示词示例（不需要额外教 Agent 如何汇报）：

> 帮我做一个可在本机使用的教务系统，支持学生、教师、课程、选课和成绩管理。做好后告诉我怎么打开。

体会的重点：每次转入具体工作时，是否能读懂它在做什么；结果是否接得上前一句说明；不展开是否看不到代码和原始命令；主动展开后是否可以继续查看正在生成的内容，并滚动回看。重新打开会话后，已有步骤说明和动作应仍然在。

会话证据通过桌面已有会话导出入口保存；运行日志仍使用现有用户 profile 的 `C:\Users\admin\.CodeBuddy\logs\cli\`，不创建无模型配置的新 profile。目录或配置存在不等于模型已实际响应，本轮不会代替用户发送开发请求。

## 12:26 E2E 后：步骤标题与进行中呈现修正

用户要求进度说明位于对应操作上方作为小标题，并能看到生成、执行、完成的连续变化，而不是等结束后整段出现。

本次仅修改前端，源码来源仍为 `fix/codepro-context-compaction` / `25d4d48c1` 加现有未提交改动。没有变更权限、完成门槛或后端协议。

- 新增 `CodeProWorkStep.tsx`：以实际公开说明作为小节标题，下方相邻操作可折叠，限制高度并滚动；不编造业务阶段标题。失败、审批和新的说明中断当前归组，仍单独可见。
- `ProgressiveMessageList.tsx`：相邻操作包含本次仍在运行的请求，不再仅成功后归组；沿用 call ID，让说明预览和确认后的说明使用同一个小节。公开说明不能吞掉同条消息里的其他正文。
- `chatSessionStore.ts`：收到 completed/failed 后移除对应 live tool ID，避免当前动作持续指向最早已经结束的请求。
- `ToolCallWithResponse.tsx`：公开说明从参数预览过渡到完整请求等待回执时仍显示已有文字，不短暂退回普通工具行。
- `toolActionPresentation.ts`、`zh-CN.json`：恢复简短命令目标，中文运行态使用“正在…”；成功时仍由真实回执切换为“已运行／已写入／已修改”。展开代码保留“生成内容尚未执行或保存”的区分。

### 实时文字问题的证据边界

静态追踪已覆盖 OpenAI-compatible 参数预览（约 100 ms 节流）、Agent 系统通知转发、ACP rawInput 预览、前端同 call ID 合并与渲染。当前本机 provider 配置 `supports_streaming=true`，该会话 `toolshim=false`。这些只证明配置和通路存在，不能证明此次模型服务真正逐片返回，也不能证明每片实时到达桌面。

现有会话导出没有逐片到达时间，故尚未确定“整段弹出”的运行根因，不能宣称流式问题已解决。没有追加完成后的打字动画，没有把普通最终答复绕过现有交付门槛，也没有将生成预览作为写入证据。

### 实际执行

- 本地 Prettier 格式化所改 TS/TSX：退出码 0。
- `pnpm.cmd run typecheck`：退出码 0。
- `pnpm.cmd run i18n:compile`：退出码 0。
- 所改路径 `git diff --check`：退出码 0（有 CRLF 提示）。
- 现有 Vite 开发服务记录了 HMR 与语言资源 reload，Electron / goose 进程仍在；未主动重启、未重建后端或安装包。
- 按用户约定未运行测试、未发送模型任务、未执行产品 E2E；没有提交或推送。该局部修改不等于整体 E2E-ready，实时输出根因及真实观感仍未验收。

### 用户随后修正：正在进行留在最下方（覆盖上一节的摆放约定）

用户对照截图明确：无论操作大小，正在执行的操作放在所有文字最下方；阶段结束后收为可展开记录，由自然语言分隔阶段。

已据此调整展示，而不是沿用“标题下始终嵌入活动操作”：

- 运行中的普通操作从历史展示分离，统一放在当前对话尾部；仅调整视图，不移动持久化消息或改变执行顺序。
- 公开说明仍是正文。新的说明等可见边界出现后，前一段已成功的操作收为可折叠记录；单条命令成功并不独自触发整段折叠。摘要保留操作类型和次数。
- 未解决失败和审批不当成成功记录收起；生成中的说明仍随原 call ID 更新，代码详情仍按需展开。
- `BaseChat.tsx` 在底部已有当前操作时不重复显示同一动作的独立 loading 行；等待用户、压缩等状态仍保留。
- 修改后再次执行本地 Prettier 和 `pnpm.cmd run typecheck`，退出码均为 0；Vite 日志记录对应页面重载。没有测试、主动重启、后端构建、提交或推送。

这里的“阶段”仅指按公开说明分隔的阅读小节，不新增业务阶段状态或推断业务完成。前述真实流式输出的运行证据缺口仍保留，不能把本次布局调整称为它已经修复。

最后补充摘要次数后，单文件 Prettier 首次写入返回 `UNKNOWN: unknown error, open`（退出码 1）；原路径原命令重试成功（退出码 0），未更换环境或清理目录。最终 TypeScript 编译再次通过（退出码 0）。

### 13:28 摘要文案与整条展示链静态自查

用户要求外层使用“已写入 3 个文件 已执行 5 个命令”，不显示乘号计数，也不以居中点分隔。

本轮在同一分支/revision 的 dirty worktree 上修改：

- `toolActionPresentation.ts` 新增本地化摘要格式；文件按记录路径去重（统一路径分隔符，不声称识别符号链接或所有路径别名），命令按调用次数统计。缺少路径不虚构文件数；同一文件的写入与修改分别归入对应操作类别。
- `ProgressiveMessageList.tsx` 共用该摘要；仅成功回执能进入折叠的成功记录。底部活动区跳过已有结构化活动视图承载的同一操作，避免重复呈现。
- 本轮历史标题、最终文件列表标题及文件名预览移除中点分隔。更新 `en.json`、`zh-CN.json` 并编译语言资源。
- `MarkdownContent.tsx` 去掉运行记录标题的“可选”；同步既有测试中的两条文案预期，但没有运行测试。

静态自查覆盖：ACP 运行集合移除已结束请求、底部活动分区、说明与阶段记录的分隔、失败/审批不并入成功组、展开后的代码与滚动容器、历史重载、摘要计数、最终文件列表和运行记录标题。自查发现并修正了文件调用次数冒充文件数、结构化活动与底部操作可能重复两处问题。静态核对不能替代窗口观感验收。

对照用户 E2E 清单，未闭合项继续保留：真实增量文字的到达/显示时序；固定位置动态计划（当前仍保留多个计划记录，只减少旧计划预览）；真实 diff 行数；最终交付说明及阻止收尾的 unknown 动作。未改动这些事实 owner，不把本轮局部改动记成完整修复。

验证：Prettier、TypeScript 类型编译、`i18n:compile`、限定路径 `git diff --check` 均退出码 0（Git 有 CRLF 提示）。Vite 记录了对应热重载及语言资源重载。未运行测试、模型任务或 E2E，未重建后端/安装包、未主动重启、未提交或推送。

### 后续实施：固定计划、增量展示与真实修改回执

来源仍为当前主工作区 `C:\Users\admin\CodeBuddy`、`fix/codepro-context-compaction`、`25d4d48c1c2f90ef161f726bc1a76f013cd1ee5f` 加已有未提交改动。保留其他改动，不更换分支，不运行测试或模型任务。

- `CodeProCurrentPlan.tsx` / `BaseChat.tsx`：输入区上方固定一份可展开计划，从原有 todo 请求和成功回执读取；生成中的计划标注“正在更新计划”。仅当前活跃调用允许成为预览，旧中断请求不会重新显示运行态。新版本原地替换，失败更新不覆盖最近的成功版本。计划勾选不等于任务终态。
- `ProgressiveMessageList.tsx` / `ToolCallWithResponse.tsx`：采用固定计划的会话不再重复渲染普通计划行；失败和审批继续保留。原始消息不删除，历史会话仍可从同一回执重建计划。
- `openai_responses.rs`：此前忽略 `function_call_arguments.delta`；现按 item ID 累积、按 call ID 发送既有 display-only 参数预览，约 100 ms 节流，done 发送最终快照。完整请求才进入执行。沿用已有 OpenAI Chat / Anthropic 通路，不新增业务状态或审批能力。
- `adapter/tools.ts`：接收增量时替换嵌套请求值，避免修改 React 旧快照共享的对象。相同 call ID 从预览过渡到请求和真实回执，不使用完成后打字动画。
- `developer/edit.rs`：write/edit 成功后，使用本次操作读取的旧文本与新文本生成行差异；回读匹配才附带可选 `file_change` 结构化展示回执。已有 `similar` 依赖，无新增依赖。大于 2 MiB、旧内容不可读或回读不匹配时不声称已知差异；差异预览限 32,768 字符，截断明示。操作返回本身仍沿用原有成功/错误合同。
- `CodeProFileChange.tsx` / `CodeProToolContent.tsx` / `CodeProConversationFiles.tsx`：消费成功的本地工具审计及上述回执，在修改行显示绿色新增、红色删除，展开显示差异。最终文件区保留逐次修改记录，明确不是工作区净差异；旧会话、Shell 改动、未提供该回执的工具不补造数字。
- `codepro_terminal_report.rs`：暂停说明外层交代当前不能确认可用、已有改动和继续后的检查工作；退出码、命令、内部 gap 放进运行记录。没有把被拒绝的完成草稿提升为成果，没有改变 Unknown 判定或恢复权限。

参考采用及边界：使用 OpenAI Docs 技能核对 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 的开始/增量/完成、计划更新和文件变更事件分工；参考 [公开 diff tracker](https://github.com/openai/codex/blob/main/codex-rs/core/src/turn_diff_tracker.rs) 的真实文本差异与有界计算。采用稳定身份连接增量和回执，不复制另一套运行状态；本次只提供逐操作差异，不把它包装成 Codex 整轮净 diff。

流式证据仍需区分：本机 E2E 对应的 `llm_request.2.jsonl` 中，计划调用 `call_yfqgngwp` 只有一次参数预览，且首次已经包含完整计划。该日志位于 provider 转换之后，不是原始网络帧，因此不能仅据此断言服务端缓冲。已核对当前配置允许 streaming、toolshim 关闭、前端直接消费更新；现阶段不能承诺 Kimi 服务一定逐片发送工具参数，也不能把 Responses 接口修复说成该 Kimi 会话的已证实根因。已询问用户是否授权进一步检查模型服务配置。

构建与启动结果待下节补充。类型编译首次发现新计划组件读取 unknown 未收窄，修正后 `pnpm.cmd run typecheck` 退出码 0；`cargo fmt --all`、Prettier、语言资源编译均退出码 0。未执行任何测试或真实产品验收。

### 14:29 构建完成，待确认重启

- `pnpm.cmd run ensure-dev-backend`：沿用项目脚本和宿主现有 VS 环境，退出码 0，Cargo 报告 5m 30s；仅出现已有 `explicit_user_validation_invocation` 未使用警告。未安装依赖或更换构建配置。
- 前端最终 `pnpm.cmd run typecheck`、`pnpm.cmd run i18n:compile` 及所改路径 `git diff --check` 退出码均为 0。Vite 日志记录了新组件及语言资源的 reload。
- 新后端：`C:\Users\admin\CodeBuddy\target\debug\goose.exe`，2026-09-27 14:28:49，SHA-256 `F6EE1F21899F075FADB3B12353F0DC34E62D1C51DF41B86483C034FAF26F65A8`。
- 现有桌面使用的 `ui\desktop\src\bin\goose.exe` 仍为旧 SHA-256 `404FB1396F0864A104936D9E90C7769C00A0FA1368AB14A4A22F21B4D6DA0049`。脚本明确报告文件被使用，保留旧文件，后续开发启动可选择新构建。没有把旧进程当作新版验证。
- 已向用户确认是否可重启，尚未收到本轮回答；未强制关闭现有工作。因此状态是“候选代码及编译完成，启动对齐待完成”，不是产品验收通过，也不是当前窗口已经 E2E-ready。

手工验收准备（未运行）：空白工作目录 `C:\Users\admin\CodeBuddy\.local-e2e\stream-plan-diff-workspace`，不会修改既有教务系统。可发送：“做一个可运行的课程管理网页，能新增和删除课程并保存在本地。过程中用中文说明当前在做什么，完成后告诉我如何打开。”随后自然提出一次修改，以观察同一文件的增删回执。

重点看实际体验：计划是否始终停在同一位置；公开说明和展开的代码是否随收到的片段更新；底部操作是否从生成/执行过渡为确认回执；修改行及最终记录是否出现真实 +/-，旧记录是否没有被补造数字。此处不声称模型一定会生成计划或提供流式工具参数。

桌面/前端现有启动日志：`.local-e2e/logs/20260927-step-desktop.stdout.log`、`.local-e2e/logs/20260927-step-desktop.stderr.log`、`.local-e2e/logs/20260927-step-renderer.stdout.log`。模型转换后记录位于 `C:\Users\admin\.CodeBuddy\logs\llm_request.*.jsonl`，会轮转，不能把它当作原始网络 SSE；请在验收后及时导出会话 JSON 和截图到新的 `Desktop\测试汇总` 子目录。当前原始 E2E 材料未修改。

仍未关闭：当前模型端到端真实增量时序须实际验收；旧 E2E 的后台子进程/Unknown 收尾不能由本轮展示改动裁决，没有删除门槛或声称已解决。无提交、无推送、无测试、无安装包构建。

### 15:02 用户批准后完成重启

- 旧主进程 16552 的 `CloseMainWindow` 返回 true，旧桌面和后端正常退出；仅停止已核对命令行属于本项目的旧 Vite 7408。
- 从 `ui/desktop` 执行 `pnpm.cmd run start-gui`，退出码 0；新后端同步、SDK 编译、语言资源编译和 Electron main/preload 构建完成。该脚本按既有流程清理 Vite 缓存，未删除依赖目录、未安装依赖。
- 自动化启动器退出后 Electron/Vite 未保持存活，5173 拒绝连接；按 runbook 的备用入口独立后台启动 Vite，再启动已经编译的 Electron。未更改模型配置或 profile。
- 最终核对：Electron 主进程 4384，窗口标题 `CodeBuddy`；goose 进程 1352，启动路径 `ui/desktop/src/bin/goose.exe`，后端端口 52161。桌面日志记录 `React ready event received`；5173 返回 HTTP 200。
- 构建目录和桌面后端 SHA-256 均为 `F6EE1F21899F075FADB3B12353F0DC34E62D1C51DF41B86483C034FAF26F65A8`，完成新前端与新后端的启动对齐。保留用户原 profile；此次启动恢复的目录为 `C:\test\test_0927\edu_sys`。
- 本次日志：`.local-e2e/logs/20260927-1501-desktop.stdout.log` / `.stderr.log`、`.local-e2e/logs/20260927-1501-renderer.stdout.log` / `.stderr.log`。
- 这是启动核对，不是模型可用性或产品 E2E 验收；未发送开发任务、未运行测试。上一节未解决项继续保留。
