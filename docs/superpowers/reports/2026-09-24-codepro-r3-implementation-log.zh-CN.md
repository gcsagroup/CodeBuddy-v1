# CodeBuddy R3 实施记录

日期：2026-09-24。范围：已获用户批准的 [R3 计划](../plans/2026-09-24-codepro-reliability-and-experience-repair-plan.zh-CN.md)。本记录只记本批实际进展，不修改冻结的事实权威图或 Final Plan。

## S0：开工基线与证据保护

- 工作目录：`C:\Users\admin\CodeBuddy`；分支：`fix/codepro-context-compaction`；开工 HEAD：`25d4d48c1c2f90ef161f726bc1a76f013cd1ee5f`，仅本地，未推送。
- `git diff --name-status -- crates/goose ui/desktop/src ui/desktop/scripts` 为空；这三个产品源码区域无开工前未提交改动。`git ls-files --others --exclude-standard` 对同三区域也为空，因此无须复制其未跟踪源码实际内容。后续本批源改动可与该基线对比。
- 开工前已存在且不属于本批的工作树项目：修改的 `AGENTS.md`、`documentation/AGENTS.md`、`evals/harbor/.agents/skills/compare_tasks/SKILL.md`、`ui/text/AGENTS.md`，以及未跟踪的 `docs/AGENTS.md`、四份 2026-09-22 candidate/E2E 报告、`scripts/prepare_codepro_second_repair_e2e.ps1`、`ui/desktop/BUILD_AND_E2E_RUNBOOK.md`。这些项目保留原处，不纳入本批源改动。R3 计划文档在开工前也未提交，SHA-256 `806385BC7D743EA19513E649F1374713E8E5065B0462AE11D24A27FFEE272A73`；R1 在 HEAD 中可恢复。
- 旧 `target/debug/goose.exe` 与 `ui/desktop/src/bin/goose.exe` 均为 328312320 字节、SHA-256 `B55E6CA0FA7D5B58E5ADA61ECB4B6D68182DAD1DB7D0413FB6930B95DADEE605`。它们的精确源码来源未知，不作为 R3 candidate 的验证证据。
- EDU 原始会话 `C:\Users\admin\Desktop\会话记录\EDU-0924-1125.txt`：SHA-256 `31A65B775A39C2663AD62A857A6CE8030DD5E7D62176B89DC6C016894451C639`。另一完整教务系统会话附件 `C:\Users\admin\.codex\attachments\1b715021-a303-4b5c-a0e5-057cc2fefbd8\已粘贴的文本.txt`：SHA-256 `D56EFDC3442405B22DF8A86E8233B2C790121A88CB62CFE54154BAC75296A36A`。仅引用，不更改原始证据、运行账本、数据库或 Evidence artifact。
- README 的 Windows 源码入口为 `ui/desktop` 下 `node .\scripts\prepare-platform-binaries.js`、`corepack pnpm run start-gui`；`ui/desktop/node_modules` 和 `ui/node_modules` 均已存在。后续在构建前检查脚本会否下载依赖，遵守现有 toolchain/profile/target。
- 开工前未跑产品测试或构建。对已有历史二进制、窗口和 session 的状态不作推断。

## S1：运行状态与合法受阻退出

源码实施中，未编译或验收：`runtime.admit_action` 将工具发起与当前 Running run/task 的检查按 run 锁排序，工具开始审计在释放准入锁前落盘；暂停后新动作无法准入，在途调用仍保留实际结果或未知状态。主循环对空完成缺口与重复同缺口反馈采用明确暂停，不把反复读取/复核当成业务进展。委派注册前检查权威 run 状态，Paused 等状态直接返回 run/task 诊断且不创建子会话。

## S2：当前目标、恢复与完成证据

源码实施中，未编译或验收：`UserRequirement` 保留原始来源、当前语义、目标资源、期望效果和 revision 关系；Main Agent 通过一个 task-contract 工具提出修订和具体 audit ID 覆盖，Reducer/Convergence 保留版本及终态所有权。工作区文件效果以工具边界的 delta 与当时资源版本为证，项目记忆不会因权限类别为 WorkspaceWrite 而充当开发交付。要求命令经真实 `ValidationInvocation` 注册 `ExitCodeObserved` / `SuccessfulExitCode`，执行观察以实际调用 cwd 和退出码匹配。

续跑输入现在尝试从 ACP 的 session/workspace Durable binding 找既有 run，再由语义关系判断续做、修订或新任务；修订只在同一 run 新增来源绑定，旧 `run_started.goal` 不改。已有 Main Agent run 不再依赖旧 `CodeProStateStore` 作为索引。尚需集中验证多 run、旧 binding、模型分类失败和已终结 run 的跨 run 关系；这些场景未标通过。

## S3：执行、授权、委派与结果对账

源码实施中，未编译或验收：已有任务授权的审批结果写入控制面 grant 后复用；根 Main Agent 自主模式按用户拍板走完整访问，子任务仍按父当前模式与明确委托写入范围取交集。子会话无法向父界面转发的新审批在工具派发前拒绝并审计，避免长时间等待不存在的审批卡；父 Agent 可改由自身执行。委派先登记控制面任务，再创建子会话；超时/取消与结果未知按带 ID 的暂停对账，不把 timeout 当作无副作用。仍需聚焦验证及桌面审批回执。

### 2026-09-24 权限模式补充拍板

用户在实施中明确修订原 R3 的权限上限：CodePro 的“自主／智能／手动”分别对齐“完全访问／风险操作请求批准／请求批准”，并明确“完全访问”包含工作区外文件与网络，不再逐文件审批。此项是用户新授权的产品权限合同，不从 `ask_user` 文本或既有 `auto` 标签反推历史任务授权。原 R3 第 9.2 节的任务范围 grant 仍用于非完全访问路径；全访问必须由当前会话有效模式产生，切换离开立即失效，子任务仍取父模式权限与委派范围的交集，显式禁止规则及未暴露工具不因模式而解除。

曾提出单独“完全访问”档以避免既有 `auto` 会话升级后静默扩权，用户随后明确拍板沿用现有“自主”并赋予完全访问语义；最终产品仍须在模式说明和当前会话摘要中清楚展示风险。OpenAI 官方权限文档将完整访问定义为无本地沙箱限制及无需审批，而“帮我批准”仅更换越界审批的审查者、不扩大沙箱；CodePro 当前 `smart_approve` 并无同等独立 reviewer，因此本批只保证其既有风险审批行为，不对外宣称二者内部机制等同。

源码对照：当前 `permission_inspector.rs` 对 CodePro 分类工具先于 `GooseMode::Auto` 判定，使普通工作区写入仍默认 `AskBefore`；工作区外目标又单独要求审批。`tool_execution.rs` 的 CodePro guard 独立限制 `write_scope` 与验证命令。因此只改 UI 文案或仅改审批分类都不能实现该合同。Provider 自身的 `Auto` 映射与宿主边界还需同源核对，不能把 Provider 的宽权限当作宿主已批准。此处为实施决策记录，不宣称已完成或通过测试。

## S4：过程展示

源码实施中，未编译或视觉验收：真实工具请求/回执进入轻量、可展开、限高滚动的记录，运行、失败与审批单独显露；公开阶段文字留在正文，隐藏思考不作为阶段结论，真实编辑证据才计入修改摘要。用户提供的 WorkBuddy 自述指南可作为“折叠信息仍可回看、最终回复自包含”的设计参考，但其源码/协议描述未经本批独立复核，不用来替换 CodePro 现有 ACP/事件拓扑，也不照搬与当前全访问模式冲突的权限流程。真实 Change 轨迹、实时与历史回放及桌面观感仍需验收。

用户后续提供了本机 WorkBuddy `app.asar` 及只读检索脚本。本批直接核对了打包后的 ACP 累加器和聊天 UI 代码：工具调用更新按调用 ID 并入既有记录；可折叠片段围绕相邻工具/思考与正文组织，完成态另取请求终态。借鉴的是事件身份、正文/操作分层与终态边界，不复制其打包实现。先前声称“renderer 只按 index 替换 Core 的权威 block”的注释未找到，列为未证实，不作为 CodePro 修改依据。对照 CodePro 的实际缺口，ACP 后续 `tool_call_update` 的标题和参数此前没有更新到已显示的工具请求；本批已补合并逻辑及聚焦回归，仍待编译测试和真实桌面轨迹确认。

## 集成验证、构建与 E2E 交接

### 2026-09-25 聚焦验证与源码身份

本批源码仍在 `C:\Users\admin\CodeBuddy`、`fix/codepro-context-compaction`、基准 HEAD `25d4d48c1c2f90ef161f726bc1a76f013cd1ee5f` 上，未提交、未推送。65 个产品源/测试文件的逐文件 SHA-256 和后端哈希见 [候选版源码清单](2026-09-25-codepro-r3-candidate-source-manifest.json)；清单复核为 65/65 匹配。开工前列出的其他 dirty 文件仍保留，未吸收到本批。

在根目录实际执行：

| 命令 | 退出码与结果 |
| --- | --- |
| `cargo fmt --all` | 0 |
| `cargo check -p goose --jobs 1` | 0；有 `explicit_user_validation_invocation` 未使用警告 |
| `cargo test -p goose --lib r3_ --jobs 1` | 0；16 通过 |
| `cargo test -p goose --test codepro_runtime --jobs 1` | 0；17 通过 |
| `cargo test -p goose --test codepro_control_reducer --test codepro_convergence --test codepro_worker_outcome_reducer --jobs 1` | 0；35 通过（12 + 6 + 17） |
| `cargo clippy -p goose --lib --jobs 1` | 0；14 条非阻断警告 |
| `cargo clippy -p goose --all-targets --jobs 1` | 0；先修正相关旧测试夹具签名，再次执行通过，仍有非阻断警告 |

在 `ui/desktop` 实际执行：`corepack pnpm run typecheck` 退出 0；`corepack pnpm run lint:check` 退出 0（15 个 locale 合计 2634 条消息）；`corepack pnpm run test:run` 定向五个受影响测试文件退出 0，69/69 通过。新增文案在简体中文和英文为对应译文，其他 locale 使用英文回退文案，避免缺键；这不等于完成各语言人工本地化验收。首次 Vitest 在受限沙箱内因 esbuild `spawn EPERM` 未能启动，随后以同一入口的获批执行完成上述 69/69，不把环境错误算测试断言失败。

### 开发构建、启动和夹具

- `ui/desktop` 下 `node .\scripts\prepare-platform-binaries.js` 退出 0，使用已有本地二进制；`corepack pnpm run ensure-dev-backend` 退出 0。`target/debug/goose.exe` 与 `ui/desktop/src/bin/goose.exe` 的 SHA-256 均为 `D72582DB50B211A0BE3DFD4BD126E79B087B990073A332CBD2F94920CD3F04FE`。没有制作安装包。
- `corepack pnpm run start-gui` 首次遇到 SDK 格式化过程的临时文件打开错误；生成文件可读可写，第二次同入口退出 0，Vite main/preload 构建并报告 Electron 启动。随后按该入口从同一源码以独立 `CODEBUDDY_HOME=C:\test\test_0924\codepro-r3-profile` 和其 `electron-data` 启动；日志确认后端来自上述 `src/bin/goose.exe`，React ready 事件到达。开发启动日志在 `C:\Users\admin\AppData\Local\Temp\codepro-r3-start.out.log` 和 `.err.log`。这是启动证明，不是用户视觉或模型 E2E。
- 使用已有隔离夹具脚本创建 `C:\test\test_0924\codepro-r3-e2e`，`fixture-manifest.json` SHA-256 为 `4B373A7B9F477FE2C50709B01C20B3D1D310DBC1DEFF56D407E949A8E66A4910`，生成后文件哈希全匹配。N01 基线退出 0、4/4；N03 退出 1、缺 `missing.test.js`；M02 退出 1、4/5；D01 退出 1、0/1。旧 `test_0922` 夹具已有变动，没有冒充干净源。
- 另准备 `codepro-r3-edu-source` 的 22 个历史示例文件和空 `codepro-r3-edu-empty` 作对照；前者未执行、未确认业务正确性，树哈希见 [人工 E2E 交接](2026-09-25-codepro-r3-e2e-kit.zh-CN.md)。

### 尚未闭合的资格与外部阻塞

- 隔离 profile 的默认 LAN 模型地址是 `192.168.9.120:8001`；本机 `Test-NetConnection` 返回 `False`，当前桌面展示“默认模型尚未配置完成”。此时不能运行真实模型驱动的产品 E2E。未迁移旧 profile 的凭据、会话或 run；服务可达后须在窗口重试并核对模型可用。
- 静态复核发现 `prior_prompt_run_for_input` 当前跳过 `Cancelled`/`Failed`，新 run 初始要求也未记跨 run 来源；用户在取消后说“继续”仍可能被当成新的字面目标，A→B 的结构化来源关系亦不完整。这是 R3 S2 已批准范围内的未闭合点，不以 UI 或模型服务故障掩盖，正式 E2E-ready 之前必须修正和复验。
- 本批尚未执行产品手工 E2E，也未做真实窗口的活动折叠/重载、授权卡、委派或长会话视觉验收。自动测试、构建与 Electron 启动不能替代这些验收。当前状态：**候选版已构建并启动，但 R3 正式 E2E-ready 尚未达成**。
