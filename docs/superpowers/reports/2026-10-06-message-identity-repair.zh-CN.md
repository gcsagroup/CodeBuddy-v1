# 10/06 消息身份修复与对抗验证记录

## 范围与依据

- 工作区 `C:\Users\admin\CodeBuddy`，分支 `work/codebuddy-next`，实施基线 `6e0e4c4b9c31b65e700278cb2b377138b29e9a7e`；开始时工作树干净。本轮允许相关测试，不沿用上一批免测约定。
- 输入会话 `C:\Users\admin\Desktop\会话记录\2026-1006-0100.txt`，session `20261005_5`。导出的两条独立回答复用了 `chatcmpl-838`。Provider 解析器直接采用上游 ID，ACP 客户端按角色和 ID 追加内容，历史加载也复用该 ID。不能凭此断言录屏里每一种思考消失都源于这个缺陷。
- 本批修消息身份与展示事件的上下文保留，不修改意图、权限、要求修订、完成门槛、Unknown 或恢复生命周期。Exa 服务额度耗尽不按权限拒绝修复；咨询运行如何收尾尚不能仅凭本轮证据指定实现。

## 实际修改与权责

1. OpenAI Chat Completions-compatible 流解析每个实际响应生成独立宿主消息 ID，正文、思考、工具请求和尾部 filter flush 共用它；同一响应的 created 稳定。上游 response ID 仅记录诊断，工具 call ID 不改。没有增加公共字段或第二套事实系统。本批未修改 Responses/Anthropic 等其他格式，不宣称全部 Provider 都已迁移。
2. ACP 历史重放仅在客户端投影中隔离普通 assistant 的非连续 ID 复用。连续同 ID 保持已有 Conversation::push 分片语义；已有所有 ID 预留，alias 不碰撞。用户和 TurnTerminal 记录身份受保护，source/retry/evidence 字段不改；数据库不迁移。
3. 只有展示作用、没有 provider payload 的 assistant 事件不消耗待合并 reasoning。原有完整测试暴露了 reasoning 与工具参数预览同批时丢失前缀的边界；Agent 正常路径不将纯通知写入模型历史，故不将此容错缺陷直接写成本次用户会话的已确认根因。

## 对抗场景

- 两个响应复用上游 ID；同一响应中途更换 ID；缺 ID；尾部半截标签在 EOS flush；检查正文和工具 call ID 不变。
- 历史 alias 与已有 ID 碰撞；同秒记录；两轮同文；连续分片不拆开；用户 ID 和终态恢复字段原封不动；输入快照不变、重复投影稳定。
- 仅展示事件插入思考和正文之间；新用户轮必须清除旧 reasoning。
- ACP adapter 两个宿主 ID 使用同时间、同正文，再迟到输出原响应分片，不允许追加到最新卡片。
- Electron 测试使用既有本地服务的固定上游 ID，通过真实输入提交两轮，再重载。此场景只验证新响应 live/reload，不替代旧历史 alias 或终态恢复的产品 E2E。

## 已执行证据与当前限制

- 修复前 `cargo test -p goose-provider-types --lib streaming_response_identity --jobs 1`：exit 101，两条新增对抗测试均失败。
- 第一轮完整 Provider 回归：exit 101，432 通过、1 失败；原有 reasoning/工具预览测试失败。修正 formatter 后 exit 0，433 通过。最终增加跨用户轮测试、中途 ID 变化与稳定时间断言后，同入口 exit 0，434 通过。
- `cargo fmt -p goose-provider-types -p goose`：受限环境拒绝访问；同入口放行后 exit 0。未改变构建配置或清缓存。
- `cargo test -p goose --lib replay_ --jobs 1`：首轮依赖构建子进程被拒绝访问，exit 1；同入口放行后第一版 exit 0，25 通过。最终补充回归曾因新增测试漏写 Conversation 完整类型路径 exit 1，已修正；最终同入口 exit 0，27 通过，包括连续分片与终态保护。没有删减断言。
- 补跑已有 `cargo test -p goose --lib agents::tool_task::tests --jobs 1`：exit 0，48 通过；`cargo test -p goose --lib denied_calls_ --jobs 1`：exit 0，2 通过。覆盖 Unknown 不被后续无关成功结清、shell 成功不等于交付、来源绑定以及拒绝不派发。这些是组件回归，不是现实桌面发送 E2E。
- 前端 adapter + ProgressiveMessageList 首次回归：exit 1，40 通过、1 失败。加入本批 adapter 对抗用例后最终回归：exit 1，41 通过、1 失败，新增用例通过。原有 usage 测试预期未包含实际返回的 contextLimit；生产 adapter 与该断言均为基线代码，未为凑通过修改断言。
- `corepack pnpm run typecheck` 首次 exit 1，Corepack 获取固定 pnpm 时 DNS 失败，同入口环境审核拒绝隐含下载。用户明确允许仅补齐固定 pnpm 后，原入口 exit 0；未升级项目依赖、未修改系统 PATH。修改的前端测试文件 ESLint exit 0。
- `corepack pnpm run test-e2e:dev message-identity.spec.ts --list`：exit 0，发现 1 个隔离桌面测试。隔离桌面启动辅助进程增加 windowsHide，仅避免测试控制台弹窗，不修改产品行为。
- `cargo clippy -p goose-provider-types -p goose --all-targets --jobs 1 -- -D warnings`：exit 1，goose lib 有 24 项诊断（3 项 dead_code，另有 too_many_arguments、nonminimal_bool、unnecessary_unwrap/map_or、string_slice、collapsible_if、large_enum_variant、if_same_then_else、needless_borrow/return）。所有指向本批未修改的文件/代码段；当前 diff 与基线核对后记录为既有欠账，没有扩大清理或降低门槛。不能声称全套 Clippy 通过。
- 单独 `cargo clippy -p goose-provider-types --all-targets --jobs 1 -- -D warnings`：exit 0。
- 隔离 Electron E2E 前两次 exit 1，测试主体均未运行：第一次启动超时且缺少即时诊断；补上有界启动日志与启动器已退出时的明确失败后，第二次在 11.5 秒内暴露 CMake 路径发现失败。现有原入口已支持 Visual Studio 自带 CMake，但夹具漏传 `ProgramFiles(x86)`，使该发现链失效。只补夹具环境传递，不安装 CMake、不改系统 PATH 或构建配置。
- 环境隔离对抗用例修复前 exit 1，工具发现根目录缺失；修复后 exit 0，验证根目录保留、用户目录重定向、凭据 getter 不被读取且不继承、子环境网络开关仍为 0。最终放在既有 Playwright E2E 目录执行（1 通过），不让前端 typecheck 引入原本排除的整套 E2E 夹具。迁移前曾暴露测试使用 ES2022 API 和夹具已有类型限制；不调整项目 tsconfig，最终 `corepack pnpm run typecheck` exit 0。
- 补齐夹具环境后，第三次隔离桌面启动已越过 CMake 失败，继续编译当前源码，但在 480 秒的 appPage 准备预算内未完成首次开发构建，exit 1；聊天断言仍为 NOT_RUN。只读进程检查确认编译子进程已清理后，改为先执行现有 `corepack pnpm run ensure-dev-backend` 构建入口，再单独执行桌面测试；不延长断言预算、不改 profile/features 或系统 PATH。
- 本批 E2E 文件 Prettier 最终 exit 0；`git diff --check` exit 0。夹具曾有混合行尾，当时格式化后仍只保留 15 行本批新增内容，无无关重排；后续另有此测试场景的选择分支，最终 diff 共新增 18 行、替换 1 行。
- `corepack pnpm run ensure-dev-backend`：exit 0，后续独立构建耗时 5 分 48 秒，沿用原 dev profile 与串行构建入口。新产物 `target/debug/goose.exe` 写入时间 2026-10-06 03:03:52，SHA256 `ED7D8A0B7C49C0D9927062284DF0BFE6E881D48582C2C8A45F507A1A9B182EA2`。构建来源为当前工作区、基线 revision 加本批未提交 diff，不是旧二进制。
- 原入口检测到旧桌面占用 `ui/desktop/src/bin/goose.exe`，未覆盖旧文件，明确切换本次开发启动到新构建 `target/debug/goose.exe`；隔离启动日志亦记录相同选择。
- 构建完成后的首次 Electron E2E：exit 1，桌面已成功显示第一条回答，但准备流程误用其他测试的“必须出现项目确认弹窗”假设，与当前实际界面不符。截图及 UI stream_timing 确认回答已经接收、提交到界面。删去这项与消息身份无关的准备断言，不改产品，不放宽第一轮 1 条、第二轮 2 条、重载 2 条的核心断言。
- 下一次 E2E：exit 1，第一轮 1 条通过，第二轮被“恢复判断返回了无效数据”拒绝。源码核对确认现有辅助调用要求 `{"kind":"question|resume|amend|cancel|new_task"}`，本地默认服务却回普通正文。新增仅供此测试使用的 `message-identity` 场景，依真实辅助合同回 `{"kind":"question"}`；仍由真实宿主校验，不修改产品判断或绕过门禁。所有响应仍复用原固定上游 ID，没有把模拟服务改成唯一 ID 来满足断言。
- 最终 `corepack pnpm run test-e2e:dev message-identity.spec.ts`：exit 0，1 通过，测试主体 50.1 秒、总计 51.7 秒。真实输入连续提交两轮，第一轮精确 1 条、第二轮精确 2 条，重载后仍精确 2 条。已查看 live/replay 两张截图，正文未串接。UI 日志中的宿主消息 ID 分别为 `msg_72d30cea-8624-44d7-80ff-ebaac61dab2e` 与 `msg_6685bb82-2847-42ca-839a-5084c3d2f307`。仅此局部消息展示链的 Electron E2E 通过，不等于真实模型任务、旧历史迁移、CU、外发或全部产品验收通过。
- 最终证据在 `ui/desktop/test-results/message-identity-Message-i-76737-esponse-ID-including-reload/`：`two-live-answers.png`、`two-replayed-answers.png`、`electron-stdout.txt`、`electron-stderr.txt`、`electron-exit.json`、`deterministic-route-trace.json`。exit 记录测试启动器退出码 0，测试浏览器/启动器进程树与本地服务清理 completed；backend 未单独观测，不补造其独立退出事实。
- 上述测试完成时未提交、未推送，也未重启用户桌面。测试与后端构建来源为 `6e0e4c4b9c31b65e700278cb2b377138b29e9a7e` 加本批未提交 diff，构建产物不是安装包。随后用户明确要求重新启动并在构建完成后补本地提交，交付记录见下。

## 修改文件与未完成事项

- 产品：`crates/goose-provider-types/src/formats/openai.rs`、`crates/goose/src/acp/server/load_session.rs`。
- 自动回归与隔离测试：`ui/desktop/src/acp/__tests__/sessionNotificationAdapter.test.ts`、`ui/desktop/tests/e2e/deterministic-openai-server.ts`、`ui/desktop/tests/e2e/fixtures.ts`、`ui/desktop/tests/e2e/message-identity.spec.ts`、`ui/desktop/tests/e2e/qualification-environment.spec.ts`；另有本记录。
- 严格 goose Clippy 和既有前端 usage 用例未通过，不能宣称全部门禁通过。完成提案拒绝、咨询运行收尾、Exa 额度及 CU 整体能力未被本批修改或证明修好。
- 截图复核还发现首轮用户提问在 live 截图中没有显示，重载后恢复显示。该现象单独保留为待查 UX 问题，本批没有证明其根因或与消息身份改动的关系；不因局部 E2E 通过而掩盖这项观察。

## 独立审查与兼容边界

已请此前获授权的子 Agent 做只读对抗审查。审查发现 terminal alias 会破坏继续/重试回传身份，已修正为保护控制记录，仅 alias 普通展示内容，并补回归。审查未运行额外编译，不替代测试。

最终测试侧只读复审未发现阻塞性问题：辅助 JSON 模拟不绕过真实宿主校验，上游响应 ID 仍固定，核心数量断言未削弱，环境修复未继承真实用户配置或凭据。复审同样明确局部 Electron PASS 不覆盖旧历史恢复、真实模型、CU 或完整 UX，首轮提问 live 缺失与现有门禁失败须继续保留。复审没有修改文件或另起编译/桌面。

旧数据若在存储阶段已合并成一个记录，无法通过重放恢复两个原响应；连续同 ID 的记录也不能凭空判断是分片还是两个命名错误的响应。重复控制记录不猜测修复。这些边界保留为已知限制，不通过正文内容、时间阈值或模型推测迁移历史。

## 11:24 启动与本地提交交付

- 当前目录仍为 `C:\Users\admin\CodeBuddy`，分支仍为 `work/codebuddy-next`。启动前未发现旧 CodeBuddy/Electron/goose 进程；没有关闭其他应用。
- 通过 README 原入口 `corepack pnpm run start-gui` 启动，启动器隐藏，日志保存在 `C:\Users\admin\AppData\Local\Temp\codebuddy-launch-20261006-112310\`。原入口成功构建 SDK、语言资源和 Vite bundles，11:24:18 收到 React ready；只读窗口检查确认 `CodeBuddy` 窗口存在。启动没有提交代码，也没有执行用户任务。
- 原入口现已把新后端同步到 `ui/desktop/src/bin/goose.exe`，其 SHA256 与 `target/debug/goose.exe` 相同，仍为 `ED7D8A0B7C49C0D9927062284DF0BFE6E881D48582C2C8A45F507A1A9B182EA2`。后端实际从该内置路径启动。提交只是保存同一份已构建源码，不重写二进制 provenance：该产物仍来自上述基线 revision 加当时 dirty diff。
- 本地按独立行为拆分：`931c89668` 保存隔离测试环境修复；`299ee3444` 保存展示通知中的思考上下文修复；消息身份修复、其回归/E2E 及本记录作为本次最后一笔交付提交。最终完整提交号以本分支 Git log 为准。
- 未 push、未 merge main。既有严格 Clippy/usage 测试失败及首轮用户消息的待查观察不因本地提交变为通过，仍保留前述验收边界。
