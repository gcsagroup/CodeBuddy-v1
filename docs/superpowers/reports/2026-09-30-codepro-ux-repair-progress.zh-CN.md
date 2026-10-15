# CodePro 连续用户体验修复实施记录

日期：2026-09-30。工作区 `C:\Users\admin\CodeBuddy`，分支 `work/codebuddy-next`，基线 `68423420` 加既有未提交改动。计划见 [修复计划](../plans/2026-09-30-codepro-ux-repair-plan.zh-CN.md)。未提交、未推送。

## 实施前审查

本 Agent 在阅读现有调用链后做反向审查，未委派其他 Agent。

- 通过：计划格式兼容属于展示修正；已有事实表明确支持裸复选约定，与当前正则不一致。
- 修订收敛：旧计划只改准确说明，不自动继承；此前内部字段补齐确实提升合同 revision，但不能由 UI 判断它与用户目标语义等价。
- 修订收敛：思考保留完整模型上下文，展示去重不能跨独立用户轮次或依赖模糊文本匹配。
- 通过但待定位：预览已有 Provider、ACP 和 UI 通路；日志不足不能证明某一层丢弃，因此先追踪/夹具，不重建。
- 修订收敛：文件查看与应用预览不是同一能力，本批不偷偷执行生成 HTML；最终正文缓冲也不通过假打字或提前完成绕过。
- 风险保留：既有 Electron 后端时序日志未完整落盘，连续 E2E 必须区分代码能力与真实模型分片到达行为。

审查结论：可开始边界内修复。未决的预览根因、应用执行预览、最终答复提前流式不作已经解决的承诺。

## 进度

| 项目 | 实现 | 自动验证 | 产品 E2E | 剩余边界 |
| --- | --- | --- | --- | --- |
| 计划格式与同任务旧版本说明 | 已修改 | 相关组件测试通过 | 未运行 | 不自动迁移旧计划 |
| 思考展示与阅读位置 | 已修改 | 组件、store、时效及「思考 → 文件生成」跨组件测试通过 | 未运行 | 不删模型上下文 |
| 生成预览与等待反馈 | UI 已修改 | preview → 调用 → 结果夹具通过 | 未运行 | 真实上游时序待证据 |
| 文件交付入口 | 复用现有入口，修正跨工作区异步读取 | 读取测试通过 | 未运行 | 不新增 HTML 执行能力 |
| 收尾状态 | 活动详情自动收起已修改 | Activity 测试 27 项通过 | 未运行 | 最终正文仍缓冲；完成门槛不变 |

## 当前检查和未完成项

- 本轮未修改 Rust。已有 Rust dirty 改动保留，不能据本轮前端测试宣称整个 dirty 工作区已验收。
- 2026-09-30 12:14 集中运行 10 个相关测试文件，176 项通过，退出码 0，包括「思考 → 文件生成」跨组件用例。随后统一 snapshot 的压缩状态与思考活动展示状态，单独重跑 store 的 50 项测试通过（退出码 0），不重复累计为新增通过数。
- `corepack pnpm run typecheck` 已通过。针对本批修改文件运行 ESLint `--max-warnings 0` 退出码 0；此前新增测试中的 `sessionStorage` 已改用 `window.sessionStorage`。
- `lint:check` 退出码 1：未修改的 `components/ui/scroll-area.tsx` 存在 `WheelEvent`、`Element` 两个 no-undef 错误；未扩大清理范围。
- `i18n:extract` / `i18n:compile` 退出码 0。`node scripts/i18n-check.js` 退出码 0，英文源词条与代码一致；本批新增的 `thinkingContent.latest`、`toolAction.generatingFile` 已补齐全部 16 个语言目录，键与 ICU 参数检查通过。全语言 `i18n:check` 仍因既有缺键/冗余键未通过；单独 `i18n:validate-locale zh-CN` 退出码 1，剩余 8 个旧冗余键，未删除无关翻译。
- 首次 pnpm 测试调用带 `--` 导致过滤未生效，已中止该轮（退出码 1），改为直接传文件名运行对应目标；未把中止轮当作验证通过。
- Computer Use 技能已初始化；`sky.list_apps()` 报 `Computer Use native pipe is unavailable ... (os error 2)`。未使用脚本绕过，不具备真实桌面连续 E2E 证据。
- 未重新构建/重启桌面、未提交、未推送。构建身份与连续用户验收仍待完成。

## 用户补充：最终回答中的横线

依据 `C:\Users\admin\Desktop\新建 文本文档.txt` 和 Q1 原始会话，四处分隔来自模型最终正文的 Markdown `---`，并非宿主额外插入。曾尝试只显示第一条横线，用户指出会误伤合理分隔后，已完整撤回该显示规则及专用 class。

边界：保留正常 Markdown 表达，不以单次排版偏好全局隐藏分隔符，不新增提示词约束。这条反馈不应扩展成宿主替模型决定回答结构的规则。

## 确定修复的交付范围

本批具体落点：

- `CodeProToolContent.tsx` 与 `CodeProPlanDock.tsx`：兼容裸复选框；同一任务旧版计划按历史展示，不自动恢复绑定或冒充当前进度。
- `chatSessionStore.ts`、`useChatSession.ts` / Types、`BaseChat.tsx`、`ProgressiveMessageList.tsx`、`GooseMessage.tsx`、`useRecentActivity.ts`：由实际 ACP 到达事件提供暂态展示依据；停止、重放、工具活动、压缩期间不把旧思考当作正在接收。3 秒只是“最近有内容到达”的显示期限，不是模型业务状态。
- `GooseMessage.tsx`、`ThinkingContent.tsx`：同创建时间、连续工具序列内完全一致的思考仅在显示时去重；原消息不变。活动思考默认展开、结束收起，手动折叠优先；上翻后不抢滚动，可返回最新。
- `toolActionPresentation.ts`：文件预览按已收到内容计算行数，明确尚未写入；真实工具调用接管后不保留生成标签，不伪造百分比。
- `CodeProFileViewer.tsx`、`CodeProConversationFiles.tsx`：复用文件查看入口，跨工作区读取结果失效；文件查看不当作应用运行或验收成功。
- `CodeProActivity.tsx`：运行期间自动展开的记录可在结束后自动收起，手动选择保留。
- 对应测试与语言目录同步更新；没有新增运行时分类请求、模型固定流程、权限规则或完成状态机。

收尾审查：正常 Markdown 分隔未改变；未将预览写回工具执行事实；未删会话思考原文；未重写计划所有权；未放宽完成门槛。确定的前端修复已完成相关自动检查，真实长等待/上游分片和最终正文缓冲仍未解决，不计入本批完成范围。

## 12:52 补充与 E2E 准备

用户要求移除截图中的设置 → 行为与回答 → 默认模式卡片。已从 `ChatSettingsSection.tsx` 移除该卡片及局部词条，更新页面测试；保留全局指令与工具过程展示设置。没有修改 `SessionPermissionSummary`、模式配置存储或权限判定。需要区分：移除的是新会话默认值的设置入口，输入区保留的是当前会话切换入口；没有偷偷把两个作用域合并，也没有重置已保存默认值。

- 页面测试 1 项通过；顺带运行未修改的 `SessionPermissionSummary.test.tsx`，6 项在查找旧版 `Current session mode: ...` 文案时失败。该文件与组件在本轮修改前均无 diff，属于现有测试与已改版 UI 不一致；联合命令退出码 1，不记成全部通过，本轮未改权限逻辑来适配旧测试。
- `corepack pnpm run typecheck`、针对设置页面和测试文件的 ESLint 退出码均为 0；`i18n:extract`（含 compile）退出码 0，提取器对 `vite-env.d.ts` 有警告。
- `corepack pnpm run ensure-dev-backend` 退出码 0，按原入口判定后端无需重编；实际复用当前 worktree 的 `target/debug/goose.exe`，与 `ui/desktop/src/bin/goose.exe` SHA256 相同：`BD0914B54FC5F356353DE8A8035AA2128D2566CB6B32C7C09DBAD2BD07FE8DF8`。本次没有新的 Rust 编译、测试或 Clippy 结果。
- 用户确认无任务可重启，已关闭核对身份后的旧 Electron 主进程及其后端；12:57 从当前工作区按 README 的 `corepack pnpm run start-gui` 启动。启动日志位于忽略目录 `target/review-0930/ux-e2e-start-1259.{stdout,stderr}.log`（文件名中的 1259 仅为标识，实际启动时间为 12:57）。
- 新建空测试目录 `C:\test\0930\04_booking_ux_retest`，复用题目 1；复测步骤追加到 `C:\test\0930\开始测试.md`，未覆盖旧题数据。产品 E2E 由用户执行，尚无 PASS 结论。

报告范围核账：计划/思考/等待提示/文件读取竞态/活动详情属于本批已实现候选；真实分片到达与收尾耗时需要本轮日志。最终正文缓冲、生成 HTML 的应用内执行预览没有完成；样本业务缺陷不是本批 Host 修复。外界体验建议不自动升级为 Artifact 新架构或新的任务状态 owner。

### 本次启动阻塞（13:01）

SDK、语言资源、Vite 主进程和 preload 构建均完成。首次后台启动及随后原入口前台启动都在显示 `Launched Electron app` 后退出，没有留存 Electron/goose 进程，应用 `main.log` 最后记录仍为 12:56:38。为获取退出证据，在原入口增加 Forge 已支持的 `--enable-logging` 再运行一次，退出码仍为 0，仍未得到新增应用启动日志。Windows Application 日志在该时段未发现 Application Error / Windows Error Reporting 记录；没有据此断言是代码崩溃、权限、单实例或系统原因。

当前结论：前端开发构建完成，桌面拉起受阻，尚不能交付为完整 E2E-ready。旧桌面已按用户许可关闭；没有安装依赖、修改系统环境、清理用户 profile 或绕开项目启动入口。停止无证据重复启动，保留现有产物和测试准备。若从用户终端启动同一入口成功，仍须核对实际进程来源与会话时间，不能把其他版本当作本候选。

### 启动阻塞已解除（13:03）

用户要求继续拉起。先用同一 Electron 二进制的 `--version` 确认原生进程能够启动（v41.1.0，退出码 0），随后仍用 `corepack pnpm run start-gui --enable-logging`，仅将命令宿主改为持续 PTY 会话，未改产品源码、环境配置或启动入口。本次成功保持运行：Electron PID 4612，后端 PID 7664，均来自 `C:\Users\admin\CodeBuddy`；后端路径 `ui/desktop/src/bin/goose.exe`，端口 53026。13:02:54 打开当前 Vite 页面，13:02:59 应用日志收到 React ready。

事实边界：可确认 PTY 启动成功、此前非 PTY 启动退出，尚未证明更底层的退出原因，不归因于 UX 代码。启动入口保持运行，没有退出码可报；构建阶段完成，当前可交给用户 E2E，真实业务和连续体验尚未验收。当前桌面恢复到旧工作目录 `C:\test\0930\01_booking`，复测时请新建聊天选择已准备的 `C:\test\0930\04_booking_ux_retest`，避免覆盖旧样本。

## 用户复测审查：Q01-0930-1313

材料：`C:\Users\admin\Desktop\会话记录\Q01-0930-1313.txt`（会话 `20260930_4`）、用户提供的题目 1 pt1 / pt2 两段 MP4、当前 `main.log` 和源码。pt1 时长 268.44 秒、pt2 时长 69.27 秒；本轮按约 20 秒间隔抽帧并补看 pt2 开头与末尾，未声称逐帧审阅。视频文件名不是精确会话起始时间；以下绝对时间来自会话和日志。

### 已观察到的改善

- pt1 00:20 可见模型思考展开，00:40 已收起，等待期没有把旧思考一直显示成正在接收；抽样画面未出现以前连续多份相同思考的刷屏。会话中 5986 字思考仍保留在四个工具消息，显示去重不删除原始记录。没有本轮重新载入历史的录像证据，因此不宣称历史回放已验收。
- 文件回执字号不高于正文；等待提示与“最近进度说明”分层，未把早已完成的文件持续标作正在写入。
- 底部计划入口位置保持一致。合同从 revision 1 升到 2 后显示“本任务的先前计划”，与 `todo.v1` 实际仍只有 revision 1 相符；不是 UI 擅自丢计划或把旧计划当新计划。不代表计划关联全场景通过。

### 非 CU 问题仍未收敛

1. **长生成缺少可见增量仍存在，现已能拆分原因。** 13:06:24 后到 13:07:48 约 84 秒，录屏主要是等待，然后直接出现 1013 行 HTML 的已写入结果。请求 `2e24bb53-981a-413b-bb85-ba7ea47812db`：13:06:26.226—26.940 已解析并交给 Agent 的 33 个正文片段被标记 `agent_text_buffered`；内容即稍后才显示的“现在开始制作”说明。随后到 13:07:48.574 的约 81.6 秒没有 body_chunk 到达事件；之后约 110 毫秒集中收到大块工具内容，13:07:48.685 才有完整工具请求。说明早期说明被 Host 缓冲，而长工具生成期间客户端没有持续收到可展示数据；前端无法凭空显示文件生成进度。服务生成还是中间网关缓冲仍无法细分，不能称为纯前端故障。
2. **观测在本轮确实给出了新证据。** 初次读取后端日志时文件元数据暂为 0；交付前复核时已为 5,888,801 字节，成功读取同一请求的 body_chunk、parsed、agent_received/buffered、acp_enqueue，与 UI received 对齐。撤回初步“本轮没有后端日志”的判断。文件大小短暂不可见的原因未确认，不能凭此新增日志故障修复；本轮后端文件为 `logs/cli/2026-09-30/20260930_130254.log`。
3. **同一进度说两遍。** 录屏与会话显示 publish_progress 与普通 assistant 文本分别讲了“收到需求”和“开始制作”。这是两个原始内容来源，不属于已修的完全相同思考展示去重；不能用语义相似度在 UI 随意删正文。
4. **收尾 42.6 秒已定位到 Host 全历史审计扫描。** 最终回答请求 `2371fe64-fa60-4e02-a8c3-303f54a909ee` 在 13:11:59.144—13:12:03.524 收到并缓冲 380 个正文片段；parsed_end 为 13:12:03.535，final_released 为 13:12:46.148。同期 `CodePro tool audit completion scan finished` 明确记录 session_count=159、pair_count=2747、unfinished_count=0、elapsed_ms=42567；外层 effect/audit reconciliation 为 42568 毫秒。`tool_audit.rs` 的现有实现遍历 audit_root 下各 session，加锁读 pairs 后才按 task scope 筛未完成记录，与耗时记录一致。这次不能再归为上游没回答或 UI 收得慢；不能靠取消完成门槛提速。最终正文仍整段释放是既有合同，耗时扫描与输出协议应分开处理。

### CU 与报告事实另列，不恢复 CU 修复范围

- 不是“完全没有 CU 工具”：本会话实际调用旧版 computer_observe / screenshot / observe_ui / focus / read_screen_text / click / stop。两次成功截图均明确说明有效模型未声明图片输入能力，图片附件已降级；模型后来得到 OCR 文本。它说“截图已确认界面正常渲染”超出了自身收到的视觉证据，尽管用户录屏确实能看见网页。
- 13:11:03 点击因观察过期被拦；13:11:16 聚焦回执明确写了已派发、动作后截图失败、结果不确定。13:11:45 的合同索引却将该次 `call_vp71y3qa` 记为 `tool_error`，`unresolvedActions` 为空。当前 `tool_task.rs` 消费结构化 receipt/audit outcome，纯错误文字里的 unknown 没有自动成为结构化 unknown；这是应与新 CU 接入对照的事实传播缺口，不通过下游扫报错文字补洞。
- 用户于 13:11:21 输入“算了 不需要验证”，这是取消验证要求的插话，不是完整点击停止按钮场景。其后没有继续桌面验证；系统仍执行一个文件修正、computer_stop 和收尾，最终给出使用说明。不能据此宣称停止按钮/恢复已通过。
- 最终答复未保留“功能未实测”的醒目标注，计划把跳过验证写入勾选项；不应据“搞定了”判预约业务通过。用户已取消验证，本轮没有替用户继续操作预约系统。

### 提交判断

用户授权条件是“这版没问题的话就 commit”。本次仍有明确的非 CU 体验缺口，特别是日志已定位的全历史扫描耗时和过程说明被缓冲，不能满足“这版没问题”的条件。故本轮未 commit、未 push、未拉取/合并组长功能；只更新实施记录。没有把旧 CU 缺陷归因于本批 UX 改动，也没有为通过本次验收修改模型生成的预约系统。

后续可选边界：优先收敛完成检查的无关历史扫描，再明确普通过程说明与最终完成答复的释放边界，避免把最终正文提前放行；重复公开进度单独归因，不在 UI 语义删文。若用户决定先保存阶段检查点，可提交为“部分 UX 修复、带已知问题”的候选基线，但不能标记全面验收通过。新 CU 的整合属于下一批，仍需独立比对。

### 用户随后批准先提交

用户明确要求“先 commit 吧”，因此将当前已审查的后端观测/反馈改动与前端 UX 修复分别保存为阶段提交。本次不把已知的全历史扫描、过程说明缓冲、重复公开进度或旧 CU 缺口标成已修复；不新增测试、构建或产品验收结论。测试夹具、录屏、用户会话与日志不纳入 Git；不 push、不拉取或合并其他分支。

## CodeBuddy 上游分阶段整合（9/30 后续授权）

### Git 边界与来源

- 当前工作区始终为 `C:\Users\admin\CodeBuddy`，分支 `work/codebuddy-next`。未另建或切换 worktree。
- 用户随后批准备份与分阶段整合；`3002afee0`、`011f2582d` 已推送到 `codebuddy/work/codebuddy-next`，没有修改远端 main。
- `codebuddy` 指向 `erjinyi-bool/CodeBuddy`；`origin` 指向旧 `erjinyi-bool/CodeBuddy`。按用户要求执行过 `git fetch origin`，只更新引用，未合入其 main。发现旧库有 15 笔不同提交、约 200 文件差异后，用户明确继续使用 CodeBuddy。
- 第一阶段 `384dc53ae` 是保留双亲的 merge commit，合入 `45c448bbb`（上下文压缩/用量）和 `ae4d4821f`（加载布局）。保留本地基于实际到达时间的思考活动判断；前端 4 文件 102 项通过，typecheck、相关 ESLint 退出码 0。其 Rust Clippy 首轮退出码 1，25 项诊断，不能把该检查点称为完整验收。
- 第二阶段从干净的 `384dc53ae` 开始 `git merge --no-ff --no-commit codebuddy/main`，目标固定为 `912eb6f7b3950c2c0ccf0ed1095e0ab4863f940e`。第三笔实际包含独立 Computer MCP、视觉路由、搜索、扩展协议与配置迁移，不仅是鼠标键盘实现。

### 整合落点与用户确认的差异

- `agent.rs`：保留本地集中收集覆盖缺口、整批不部分提交的行为，同时调用上游 `validate_coverage_entry` 检验桌面 action/after-image 绑定。没有削弱外部送达证据要求。
- `tool_task.rs`：本地紧凑动作索引自动合并时遗漏上游新增的 `desktopObservation`；补充同一权威回执的展示字段，不新建事实 owner。复用现有桌面证据用例检查 call ID 和窗口身份可被 inspect 消费。
- 用户明确拒绝未配置时自动使用 `http://192.168.9.109:8001/v1`。默认辅助视觉改为 disabled；显式选择厂商与模型后才启用。删除特殊内网 provider 构造与自动选第一模型路径，统一使用现有 provider 配置。主模型自身识图路径保留。
- v1 模型路由迁移及旧 v2 空视觉配置均不自动授权辅助服务；保存过的主/子 Agent 路由不丢失，明确保存的视觉厂商/模型保留。配置界面同步显示未配置/未启用及图片发送对象说明。
- 首轮前端 6 文件出现 2 个只读工具字段丢失失败：SDK 源码已含字段，但 dist 仍旧。执行既有 `build-goose-sdk` 后 typecheck 通过，扩展/工具箱 4 文件 47 项通过。未修改断言掩盖字段丢失。
- 路由协议 8 项测试通过，包含未配置视觉迁移及已配置路由保留；Go 的 `go test ./...` 和 `go vet ./...` 退出码 0；构建入口脚本测试 11 项通过。上述均不是桌面用户验收。

### 必须保留的已知风险

- 上游 `tools/qwen-computer-use/runtime.ps1::Build-AfterActionResponse` 在动作已派发、后置观察失败时保留 `actionDispatched=true`；但 `main.go::acceptSnapshotResponse` 将它转为 `textResult(..., false)`，MCP 结果不再携带该结构化状态。`extension_manager.rs` 因 `is_error != true` 记为 ToolAuditOutcome::Success。这证明派发与后置结果不确定性没有完整传播，不证明任务已成功或一定发生误发。
- 桌面覆盖校验会拒绝没有真实 after-image 的完成证据，但这不等于已经把原操作登记为可追踪、可对账的 Unknown。本批没有另造状态机修补，也没有把提示词的“不要重发”算成不可绕过保证。
- 完全访问下 Shell 等同等副作用路径仍须按实际能力边界评估，不能宣称所有发送均受 Computer 工具约束。真实账号、联系人外发不作为本批验证。
- 之前日志确认的全历史审计扫描耗时、普通说明缓冲和重复公开进度仍未修复，不归入三笔整合的验收范围。
- 本轮调用 computer-use 技能的 `sky.list_apps()` 返回 native pipe unavailable（os error 2）。没有脚本绕过；真实桌面交互验收未执行。构建/启动结果须在后续记录中单列，不能引用旧 Electron 进程证明合并版可用。

### 候选合并门禁与明确例外

- 严格命令 `cargo clippy --offline -p goose --lib --jobs 1 --message-format=json -- -D warnings` 退出码 1，剩余 24 项诊断。本次新增的 `context_maintenance::lifecycle` 参数数量问题已通过合并同一操作的两个参数修正，没有添加 lint 豁免。
- 剩余诊断涉及 agent、task_evidence、tool_execution、tool_task、validation_invocation、retry、task_dag、reporting/projection、summon、todo 和 utils 等既有位置。逐项将诊断主行与 `011f2582d` 对照，24 处均已存在；未重新构建完整旧基线，不将源码比对表述为旧版 Clippy 复跑通过。
- 用户明确批准：相关测试与构建通过后，可带此欠账保存候选合并提交，旧问题另列，不标记验收通过、不修改 main。这是本批例外，不修改仓库规则或降低 Clippy 命令的严格度。
- 当前合并态前端 9 个测试文件合计 161 项通过（路由/模型配置、扩展/工具箱、消息时间线与会话存储）；typecheck、相关 ESLint 均退出码 0。语言资源重新提取仅调整 en.json 的键顺序，`i18n:extract`（含 compile）和 `node scripts/i18n-check.js` 均退出码 0；提取器仍对 vite-env.d.ts 发出既有警告。
- 重启前将实际 local profile 的 config.yaml 复制为同目录 `config.pre-codebuddy-912-20260930.yaml`；两份 SHA256 均为 `B5987E45DE280A59FC31C0F8B23413F44303CEE9AE339E858C1D614960C08E43`。备份不纳入 Git，没有手动改写凭据或模型选择。
- 通过构建入口导出的 Windows/toolchain 环境顺序执行 `cargo test --offline -p goose --lib agents::tool_task::tests::desktop_ --jobs 1`（6 项）和 `agents::vision_service::tests::main_first_routing_honors_unknown_supported_and_explicit_modes`（1 项），均退出码 0。测试使用模拟回执/提供商，没有真实桌面输入；不等于实际 CU 成功。
- `ui/desktop` 中执行原入口 `corepack pnpm run ensure-dev-backend`，退出码 0；Rust dev 构建耗时 11 分 33 秒，独立 Computer MCP 同步完成。旧后端占用 bundled goose.exe，入口明确保留旧文件并选择当前 worktree 的 `target/debug/goose.exe`；重启时再由原入口同步。此处是开发构建，不是 release 安装包。
- 构建时 HEAD 为 `384dc53ae`、存在本次待提交合并内容（source_dirty=true）；候选提交保存的是该次构建对应源码，不把编译元数据冒充为提交后的 clean revision。真实桌面交互尚未验收。

### 候选提交与开发版重启

- 第二阶段合并提交为 `262cd747a`，双亲 `384dc53ae` 与 `912eb6f7b`；保留上游历史，没有合并旧 origin/main，没有修改 main。
- 用户确认没有运行任务后，重新核对旧 Electron PID 4612 与后端 PID 7664 的路径及父子关系，关闭这两个旧进程；未按进程名批量关闭其他应用。
- 在同一 worktree 的 `ui/desktop` 按 README 执行 `corepack pnpm run start-gui --enable-logging`（持续 PTY）。入口同步新后端，完成 SDK、语言资源、Vite main/preload 构建并启动 Electron；命令保持运行，没有最终退出码。
- 14:21:15 启动新后端，14:21:28 收到 React ready。Electron PID 1212，后端 PID 22812，后端端口 63241，实际路径为 `C:\Users\admin\CodeBuddy\ui\desktop\src\bin\goose.exe`。恢复的工作目录是 `C:\test\0930\04_booking_ux_retest`；未自动发送任务、操作真实联系人或改写旧测试成品。
- `target/debug/goose.exe` 与 bundled goose.exe 的 SHA256 均为 `89FE80434AD51EA6447F9BDF16A64C45A7DA98E1DD3FC19622C0C950E0BA036A`；独立 Computer MCP 两处 SHA256 均为 `AFE7DEEF8F15F75C407886F9D529FC019C3B451F46A92D2C0A3FB3093F1B3BD4`。提交后未修改产品源码或重新伪装构建身份。
- 启动输出仍有开发模式 icon.ico 读取、Electron deprecated API 和依赖 source map 警告，未阻止 React ready；本批未扩大清理。启动日志为 `.CodeBuddy/state/electron-app/logs/main.log`，后端日志在 `.CodeBuddy/logs/cli/2026-09-30/`。
- 状态：开发构建与启动检查完成，候选 E2E-ready；computer-use 技能的原生接口不可用，因此没有真实桌面点击验收。优先在新会话、隔离测试文件/窗口复测，真实联系人发送不在本次验收范围。

## 14:38 追问与网页分析体验：第一修复切片

### 范围和证据

- 工作区仍为 `C:\Users\admin\CodeBuddy`，分支 `work/codebuddy-next`，起点 `4e6b3ae1f`，开始时 clean；不合并、不切换分支、不操作用户桌面任务。
- 用户批准优先修复截图 `屏幕截图 2026-09-30 143828.png` 的追问报错、自然语言流式和搜索过程空白。证据为 `CU-WEB-0930-1442.txt`、后端 `20260930_142123.log`、111.6 秒搜索录屏（按 10 秒取帧）及补充的 `CU-0930-1443.txt`。后者的 WorkBuddy 控制任务是正向交互样本，不因后续网页问题判它失败。
- 14:38:13 的日志确认 `custom_codebuddy_lan` 在 `model discovery` 失败；旧日志没有底层原因，不能断言是限流、断网或服务端异常。追问关系判断重新构造路由并请求模型目录，是代码确认的前置依赖。
- 请求 `2e52c54b-1a06-432f-a5a2-23849338f1c6` 在 14:35:13 至 14:35:22 已收到正文分片，Agent 记录 `agent_text_buffered`，结尾才释放正文；本例不是缺少上游流式证据。
- 搜索早期还等待了此前工具记录的摘要；末尾工具分组即使所有子项已完成，也因整个对话仍在响应而显示“正在执行”。这些是不同原因，不能统一归咎于模型不汇报进度。

### 落点与不变边界

1. 输入关系：`ModelRouter` 保留角色路由权威；仅当配置的角色厂商和模型与已加载的会话连接完全匹配时复用连接，不重新查询模型目录。不同路由仍执行原激活校验，不能静默回退或换模型。语义判断、HTTP 预算、取消、要求版本与原任务绑定不变。
2. 只读正文：现有分析工具回执已有证据时，真实 Text 分片沿 `AgentEvent::Message -> ACP -> UI` 发送；仍保存到原会话，结束时不再补发/包装同一正文。证据缺失的原检查保留；工具请求确认仍在工作时，先前缓冲的过程说明也不再丢弃。流式展示不是完成事实。
3. 等待与展示：复用 `ProgressMessage` 告知正在整理此前工具记录，并在等待结束清除；添加等待起止及耗时日志，不保存摘要内容。工具分组标题和动画同时要求有未完成子项，不用整轮模型响应推断工具还在执行。
4. 日志：模型激活保留阶段及现有 `ProviderError::telemetry_type`，不记录响应原文、凭据或请求正文；正文分片增加同 request ID 的 `agent_text_released`，沿用已有网络、解析与 ACP 观测。

### 验收与余项

- 本切片重点检查：精确路由复用、不匹配不回退；只读第一段在第二段尚未产出前到达消费者；实时正文与重载历史一致且不重复；无证据仍拒绝假完成；工具已完成时父标题不继续运行。
- 不承诺主 Agent 写入/外发最终答复已经流式。该分支仍受完成提案门槛约束，需要独立处理草稿展示和正式交付，不能通过删除门槛解决。
- 本切片只揭示摘要等待，不宣称串行摘要耗时已经消除。辅助视觉关闭时新截图丢失、只读文本过度截断、失效 run 轮询、合同修订失败与导出体积仍另列，未偷偷扩大进本批。
- 尚未提交、推送或重启；当前已运行桌面仍是此前合并版，不是本切片产品验收证据。

### 已执行检查与诊断补充

- `cargo test -p goose --lib --jobs 1 codepro_read_only_analysis` 退出码 0，5 项通过；编译期间随后又补充了诊断与少量边界代码，因此这个结果不能覆盖当前全部 dirty 源码。新路由复用测试尚未运行，最新 Rust 改动尚未完成编译/Clippy。
- 前端 Activity 与 ProgressiveMessageList 两个目标共 47 项通过；Activity 最后一次单独复跑 27 项通过。新增流式日志检查及消息分片用例过滤运行，7 项通过、14 项跳过。TypeScript 检查与相关文件 ESLint 退出码 0。
- sessionNotificationAdapter 全文件检查有 1 项失败：usage 用例期望缺少实际返回的 `contextLimit: 200`。HEAD 中该处理逻辑已存在，本批未修改 applyGoose；这是源码比对，不是旧版测试复跑证明。未为通过检查顺手改写无关断言。
- 已补输入关系调用的 session/source message/run 关联、模型路由与目录加载阶段耗时、正文首片的展示策略、历史工具摘要批次和单项耗时，以及 UI adapter 应用分片后的时间。只记录 ID、阶段、数量、耗时和错误类别，不保存正文、思考、图片或凭据。
- `ui_adapter_applied` 仅表示适配器已应用事件，不代表 React 已绘制到屏幕；真实可见时间仍须结合录屏。上述日志不参与权限、路由、完成或恢复判定。

### 流式与完成检查解耦：公开实现对照（2026-09-30，仅调查）

用户要求先检查成熟做法，再评估和实施；本阶段没有继续放开主 Agent 正文，也没有修改冻结的事实权威职责表。

| 一手来源 | 已核对的做法 | 本项目采用与不采用的边界 |
| --- | --- | --- |
| [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server#events) | agentMessage delta、item 完结与 turn 终态是独立事件；item ID 关联分片与最终内容，phase 为可选字段 | 借鉴消息与轮次分层；不能把 turn completed 或 final_answer 当成本项目业务验收通过，也不要求所有厂商提供 phase |
| [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) | message chunk 与最终 StopReason 分开；messageId 可关联分片；取消需要返回 cancelled，并处理剩余更新的顺序 | 继续使用已有 ACP，不新增另一套传输协议；end_turn 不是业务完成证据 |
| [AI SDK UI 消费源码，e25994e](https://github.com/vercel/ai/blob/e25994e067e773ce7cbc8f6dcd03e10b6ad5e256/packages/ai/src/ui/process-ui-message-stream.ts) | text-start 建立 ID，text-delta 追加并通知 UI，text-end 关闭该文本块；finish 与 reset-step 分别处理消息结束和重试时的内容失效 | 采用稳定关联、明确追加/最终化语义；不能把业务检查拒绝伪装成网络重试并删除用户已见历史 |
| [AI SDK 持久化文档](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence) | 持久化前稳定消息 ID，区分客户端断线与后端消费，并在重连后恢复历史 | 借鉴实时与历史一致性；不照搬断线后继续运行作为用户明确停止后的行为 |
| [Cline SDK 架构，3435f72](https://github.com/cline/cline/blob/3435f72fcf4cb843bee946b8f9e981683564c9e3/sdk/ARCHITECTURE.md) | 文档区分文本/思考分片、工具事件和 agent done；完成遥测可由成功 submit_and_exit 触发 | 只借鉴事件分层，不照搬其完成遥测定义。该条是维护者设计文档证据，不是本地执行 Cline 的验证 |

本地对应证据：

- `agent.rs` 的主 Agent 分支在无工具分片时移除公开 Text，完成检查通过后才发送聚合文本；检查拒绝时草稿为 agent-only。前一切片只增加了部分只读流式出口，仍非通用解耦。
- `tool_task.rs::checked_final_text` 可根据未核验动作/缺少证据，替换模型草稿为未完成说明；不能假设最终内容总等于已流式正文。
- `acp/adapter/messages.ts::applyContentChunk` 对同一 assistant message 追加文本；再次发送完整文本并不等于替换。后端 `HistoryReplaced` 在 ACP 入口只触发 context usage 更新，不能用它撤回桌面正文。
- `TurnTerminalRecord` 已包含 run、来源用户消息、终态及结构化 report，应继续消费原完成事实；不是再造完成状态机的理由。

评估结论与下一步边界：

1. “公开正文实时传递，完成事实独立提交”的方向可行，但单删缓冲不足以交付；消息身份、保存、拒绝后的说明、停止与历史重载必须作为同一切片处理。
2. 首选在既有 Message / ACP / SessionManager / TurnTerminal 上修复。仅传递原本 user-visible 的公开正文，不泄露 agent-only、内部 JSON 或隐藏思考；不按自然语言关键词猜正文是否最终答复，不新增模型分类请求。
3. 模型原文已展示后，不通过内容匹配删除或重写历史；检查拒绝应保留原结果并明确呈现尚未通过的事实，随后继续原有恢复路径。检查通过不得重放整段正文。文本变更应区分“消息内容最终化”与“独立的宿主核验结论”，不能混用追加事件。
4. 不移植完整 SDK、消息账本、DAG 或另一套完成生命周期。结构化报告、exact-reply、simple-change 等特殊出口逐项核实，不承诺原始 JSON 可直接流式给用户。
5. 不用定时打字动画伪装流式；验收要求在第二段尚未生成时第一段已到消费者，并用日志和录屏确认 UI。上游本身整段返回时，应记录边界而不是制造假分片。
6. 最小验收覆盖：工具前说明与工具后回答；主 Agent 正常完成且不重复；完成拒绝后继续；生成中停止与重开历史。网络异常后的保存单独检查，不把终态或一条 success 日志当用户验收。

需要显式修订的旧约定：事实权威职责表的“2026-09-28 消息与清单展示修复”明确保留主 Agent 普通文本缓冲。上述首选方案会改变这项可见性/历史语义：从“通过前看不到草稿”改为“公开正文实时可见，但是否完成独立核验”。这不改变完成 owner 或权限，但存在用户先看到模型错误交付声明的可能。按冻结基线规则，取得该边界修订确认后再实施；本轮不擅自把它当普通前端放行条件。

### WorkBuddy 分享材料与体验取舍

用户随后明确“以用户体验之上”，并提供桌面的 `workbuddy流式.txt`、`WorkBuddy_流式输出链路.html`、`事件推送调度器的三分流路由.html`、`推理块的三层嵌套结构.html`。本轮全部读取；三个 HTML 实际是 SVG 示意图。文本自述来自 app.asar 的静态阅读，未附完整包、版本或运行验证；推理块是否共用吐字缓冲在材料中也明确标成推断。因此不能将具体参数和私有实现认定为已验证的 WorkBuddy 事实。

- 将用户的体验优先取舍落实为：普通公开正文及时显示，核验结果由原 owner 独立提供；不因可能遇到完成拒绝就扣住所有说明。保留模型决定怎么执行的空间，不通过文案决定控制事实。实施时同步修订上节指出的旧展示约定，不修改完成门槛。
- 吸收短时合批、稳定消息/内容身份、尊重手动展开和阅读位置、减少重复渲染的思路。不直接照抄 24fps、40ms、300ms 或字符速度；首先修复 Host 整段缓冲，再按真实渲染证据决定是否需要性能优化。
- 修正此前“平滑就是伪装流式”的过强表述：对已收到的真实分片做有界的展示平滑是合理体验优化；把整段缓冲后返回的内容慢放，不能证明网络/Host 流式已修复。结束、取消、历史重放与减少动态效果偏好不应被打字效果拖延。
- 材料里的 `terminal_update`（终端输出增量）与 completed/failed 等终态不是同一种事件，不能照着“terminal 直通”一词实现。正文/思考/终端输出增量按序保留；生命周期更新前需要处理此前已接纳的增量，不能终态先封口而让尾部丢失或停后继续冒字。
- 不按文本相等去重正文/思考增量；相同内容可能是真实重复字符。只有协议明确的幂等快照才可考虑合并。工具事件同样先区分快照、增量和终态，不能所有 tool_call_update 一律 last-wins。
- 不直接采用“同帧含工具就不显示思考”或“后台会话丢高频帧”：前者可能重现本项目思考消失，后者若误用到数据消费层会损坏历史。可以减少后台重绘，不能丢真实内容或事实事件。
- 不自行以空行切分 Markdown 作为稳定解析边界，也不只为三层嵌套图新增组件层次。本地 ThinkingContent 已有手动开合持久化、追踪最新和停止强制跟随的机制；GooseMessage 使用 message ID 作为其 storageKey。需验证端到端身份稳定，而非再造一套折叠状态。
- 本地 MarkdownContent 仍随 content 变化重新处理分段并交给 ReactMarkdown；chatSessionStore 每次应用通知后 notify。这里只能说明潜在的渲染优化点，没有性能采样，不能据此断言已发生 IPC 洪水、OOM 或渲染瓶颈。

实施顺序保持：真实正文流与原完成事实分离（包含保存/拒绝/停止一致性）→ 连续用户过程验收 → 如有卡顿证据再做有界合批与渲染优化。不扩展远端 WebSocket 重连，不增加思考分类器、用户画像分类或通用调度器。本轮仅补充调查记录，未实施上述主 Agent 展示边界变更。

### 公开正文解耦实施（用户随后批准执行及本地 commit）

本节更新上节的“未实施”状态。仍在 `C:\Users\admin\CodeBuddy` / `work/codebuddy-next`，起点 `4e6b3ae1f`；没有切换工作树、推送或更新 main。

- Main Agent 的普通公开正文按原 Message / ACP 通道实时发送，provider 缺少消息 ID 时仅补本轮稳定关联；隐藏消息使用独立身份，保留既有 audience 过滤。重复的真实增量不按文本去重。
- 可见性回归发现 `categorize_tool_requests` 重建过滤消息时只复制 ID，丢失整条消息的 visibility 元数据；原缓冲曾掩盖部分影响。修正该投影复制原 metadata，不改变内容 audience，不在下游根据文字重新判断谁能看。
- SessionManager 继续负责历史。在响应结束、取消及进入 provider 错误处理前保存已接纳正文，核验前不再扣住或丢弃它。不是逐 token 落盘，也不承诺进程崩溃时最后分片必然已持久化。
- 完成仍由原控制面判定。拒绝后保留已展示原文，并另发“尚未通过完成核验”的说明，走原反馈/恢复路径；通过后不把同一正文完整追加一遍。原核验器替换出的未完成说明另发消息，不伪装成修改旧增量。
- 等待 provider 下一片时可以响应取消；发生 provider 错误的响应不能进入主 Agent 完成提案或聚合最终答复出口。此处判断的是已有错误事实，不解析自然语言判断成功与否。
- 追踪 ACP 停止入口发现它会在取消后的首个事件直接丢弃 Agent stream，因此只改 Agent 保存位置仍不足以覆盖中间 usage/tool 事件。ACP 对已取消的 CodePro 执行最多消费 5 秒收尾事件、但不再转发正文，让原 Agent 完成待保存历史及取消处理；超时/错误明确记日志，保留原控制面的取消处理，不宣称此时历史完整。没有后台继续业务执行或新的取消状态机。
- 同步修订事实权威职责表的旧展示约定。没有新建状态机、正文分类器或模型调用，没有改变执行权限、要求版本、证据门槛或 completion owner。
- finalize、结构化 final-output、simple-change、exact-reply 等特殊出口保留原行为；只读缺少证据时也仍保留原检查。本批不声称所有输出出口都已变成流式。

检查与提交记录：

- 前端当前源码：chatSessionStore、ThinkingContent、CodeProActivity 共 82 项；ACP 正文分片及诊断过滤目标 7 项；ProgressiveMessageList 20 项，命令均退出码 0。typecheck 与本批文件 ESLint 退出码 0。未用过滤运行掩盖前文已记录的 adapter usage 既有失败。
- 前端独立提交 `49f677b6e`：工具全部结束后不继续展示运行状态，补 UI 接收/应用分片的无正文时间记录；未 push。
- 路由独立提交 `16ee1fc59`：准确匹配配置时复用现有连接，并补调用阶段、失败类型和关联日志；精确复用/不匹配不回退回归已通过，未 push。
- Rust 首次新增测试编译遇到 mock stream 借用生命周期错误，已改为持有 Arc；后续隔离测试因缺少项目绑定被现有权限边界拒绝，已补原 `bind_test_workspace` 夹具。夹具预算低于现有预留的 5 轮收尾预算，又触发 finalize 分支，导致取消样本等不到公开首片；已按实际预算约定修正并强制断言真实首片到达。这些夹具问题不作为产品故障或通过证据，不放宽产品权限。最终检查结果在下节记录。
- 当前桌面仍非本批后端源码构建，不作为本批 E2E 证据。未进行真实产品验收。

### 本轮追加的定位日志（不扩成日志系统改造）

用户提供 `WorkBuddy-日志系统说明.md` 后明确“先别管脱敏那些，先加对目前修复有用的”。因此只补当前缺口，不改日志框架、轮转、归档、远端上报或原请求日志策略；该说明是参考材料，没有独立验证其 WorkBuddy 运行时结论。

- UI 原有 `ui_received` / `ui_adapter_applied` 记录增加原 message ID，连接 request ID 与消息展示身份。
- 开发版 GooseMessage 增加 `ui_text_committed`：记录 session/message ID、UTC 毫秒时间、显示文字 UTF-16 长度、更新次数、streaming、文档可见性及文字节点是否挂载。首条与结束立即记录，中间最多每秒一条；只节流诊断，不节流/删除正文事件。不记录文字内容，不写入会话或模型上下文。
- React effect 证明该次组件提交已经发生，不证明浏览器完成绘制、用户正在看这条消息或屏幕实际已显示。它与适配器记录的差值用于缩小排查范围；真实可见体验仍以录屏为准。该探针仅开发版启用，不宣称发布版默认具备。
- 主 Agent 普通响应保存完成、provider 错误前保存、完成核验起止/耗时/结果类别/缺口数量，以及 ACP 取消收尾消费起止均补关联日志。不输出正文或整段 gap，不把日志记录成功当任务成功。
- 下次对照顺序：`body_chunk → parsed → agent_text_released → ACP 发送 → ui_received → ui_adapter_applied → ui_text_committed`。前半使用 request ID，后半用适配器记录的 message ID 衔接；完成核验按 session/run/task ID 单独看，不能用核验结束时间冒充首片到达时间。

### 本批最终检查与交付边界

- 最后一次前端补日志后：`corepack pnpm run typecheck`、相关 3 文件 ESLint、GooseMessage/adapter 的 Prettier 检查均退出码 0。`GooseMessage.test.ts` 与 `ProgressiveMessageList.test.tsx` 共 63 项通过；adapter 的正文分片/诊断过滤目标 7 项通过、14 项未运行，均退出码 0。前文的全文件 usage 既有失败仍未清理。
- `cargo fmt --all`、`git diff --check` 退出码 0。严格 `cargo clippy --offline -p goose --lib --jobs 1 -- -D warnings` 最终退出码 1，24 项诊断；本批新增的 3 项 `unnecessary_map_or` 已修正。剩余诊断对应源码主行均在 `4e6b3ae1f` 存在，位置未纳入本批修改；这是当前执行与源码比对，不是旧基线 Clippy 复跑结果。不压低检查等级，不为本地候选提交扩大历史清理，也不宣称静态门禁通过。
- 最终 Rust 相关回归以 `cargo test --offline -p goose --lib --jobs 1 <filter>` 在同一份最终源码顺序运行，整体退出码 0，共 11 项通过；过滤目标为 `main_agent_stream`、`buffered_commentary_preserves_visibility_and_error_diagnostics`、`tool_task_streams_prose_without_accepting_unverified_completion`、`codepro_read_only_analysis`（5 项）、`input_relation_reuses_exact_active_route_without_discovery_or_fallback`、`stop_hook_payload_includes_streamed_assistant_reply_text`、`running_tool_cancellation_is_bounded_when_cleanup_is_slow`。覆盖分片先到、停止/异常历史保存、可见性、完成门槛、只读路径、精确路由复用及取消边界；无并行 Rust 编译，不等同于真实桌面 E2E。
- 没有安装/下载依赖、清理缓存、改变构建入口、推送或合并。只生成相关测试产物，未执行本批桌面应用构建或重启；正在运行的旧应用不能验收这些修改。真实产品 E2E 尚未执行，特殊 finalize/结构化输出等余项仍按上文保留。
