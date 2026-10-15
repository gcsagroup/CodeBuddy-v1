# 路由证据增强：实现与验证记录

## Python unittest 验证权限收敛（2026-09-17）

- 桌面 E2E L08 会话 `20260917_25`、run `run_e7d26bf8-3079-4526-9c04-5b30eed85f9e` 正确得到 `classification_source=semantic_model`、`classified_intent=change`、`simple_change_check=matched`、`execution_route=simple_change`。Agent 只修改 `app.py`，未修改 `test_app.py`；随后请求执行用户指定的 `python -m unittest -v`，但确定性权限层返回 `policy_denied`，终态为 BLOCKED。该结果不是路由或修改范围失败。
- 根因是同一类验证命令在三处被不同实现识别：调度器已把 `python -m unittest` 认作真实测试，simple-change 权限校验只列出 `python -m pytest`，主机固定 argv 校验也只允许 `pytest`。分散的安全命令知识发生漂移。
- 修复将 Python 验证判断收敛到一个 argv 级解析器。模型继续从目标与上下文选择具体命令；确定性规则只接受受限 Python 可执行文件名或绝对路径、`-m` 以及明确允许的验证模块，并继续拒绝 `-c`、任意模块、脚本路径和 shell 组合。`pytest` 与 `unittest` 复用同一结构校验，不再在 simple-change 前缀表中分别维护命令短语。
- 与官方 OpenAI 文档的公开行为对照：采用“模型从指令和上下文推断意图并持续完成任务”，同时由应用执行工具、管理待处理工作和校验边界；测试只在新改动、失败或未解决风险要求时扩展。拒绝让模型输出直接成为权限，也拒绝以自然语言关键词表决定业务路由。来源：<https://developers.openai.com/api/docs/guides/latest-model>。
- 聚焦回归均退出 0：`codepro_validation_uses_python_argv_shape_instead_of_command_phrases` 验证 Python argv 正反例；`codepro_simple_change_run_allows_python_unittest_after_write` 验证写入后 simple-change 权限；`host_verification_specs_are_fixed_argv_and_unknown_commands_fail_closed` 验证主机执行固定 argv 并对未知模块 fail closed。第一次增量构建因当前 target 缓存缺少部分依赖耗时 10m12s；稳定产物上的后两次复跑分别约 1m58s（重新链接）与 1.4s，未清缓存或并发启动第二个 Cargo。

日期：2026-09-16。状态：新版后端构建及桌面启动已确认，尚未完成桌面 E2E，不可宣称整体修复完成。用户先安排手动 E2E，后因下班时限重新授权助手接手；本轮 Computer Use 连接失败，桌面验收仍未执行。

## 范围

- 分支：`fix/intent-routing-evidence`，基线 `51bbc1c80`。
- 工作目录：`C:\Users\admin\AppData\Local\Temp\CodeBuddy-routing-evidence`。
- 主目录和 `CodeBuddy-phase-b` 中的已有改动不合入本分支。不提交、不推送、不改锁文件；本地 `AGENTS.md` 提醒不提交。
- 复用 `intent_completed` 事件，记录来源、分类值、覆盖前后意图、覆盖原因、目标来源、单文件检查结果和入口路线。该数据只用于诊断，不参与授权和执行决策。
- `codepro_intent.rs` 仅为已有枚举补序列化派生；未改分类条件、规则次序、白名单或审批策略。
- 其他 ActivityEvent 构造点补 `None` 为类型兼容性调整，不为其编造路由证据。
- 不覆盖全部提前返回路径，不细分每条关键词规则，也不记录语义模型原始回答。缺字段代表没有该证据，不代表某层已执行。

设计依据与三语计划见 [权威计划](../plans/2026-09-16-intent-permission-root-cause-review-plan.zh-CN.md)。

## 自动化记录

除另行说明，工作目录均为上述日志分支目录。Rust 缓存使用已存在的 `C:\Users\admin\AppData\Local\Temp\CodeBuddy-phase-b\target`，不复制该分支源码。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cargo test --locked -p goose --test activity_event_contract routing_evidence --target-dir C:\Users\admin\AppData\Local\Temp\CodeBuddy-phase-b\target`（实现前） | 1 | 1 通过、1 失败、0 忽略。新增字段经过旧 ActivityEvent 反序列化后丢失，断言实际为 Null，符合复现预期；4m09s。 |
| `cargo test --locked -p goose --test activity_event_contract --test codepro_event_log --test codepro_event_migration --test codepro_legacy_archive_import --target-dir C:\Users\admin\AppData\Local\Temp\CodeBuddy-phase-b\target`（重跑） | 0 | 7+8+5+3=23 通过、0 失败、0 忽略；包含新增证据写盘重读、旧记录不补造证据、敏感字段脱敏、迁移兼容；4m04s。 |
| `pnpm.cmd --dir .\ui install --frozen-lockfile --offline` | 1 | 缓存缺 `@changesets/cli`，不是代码测试失败。 |
| `pnpm.cmd --dir .\ui install --frozen-lockfile`（中断前） | 未取得 | 中断后句柄失效，不当作安装成功证据。 |
| `pnpm.cmd --dir ui/desktop exec vitest run src/types/activityEvent.test.ts --maxWorkers=1` | 0 | pnpm 先自动补齐安装；部分可选平台二进制下载失败/缺失警告，安装最终退出成功。测试 1 文件、8 通过、0 失败。 |
| `cargo fmt --all` | 0 | 已执行；最终差异再次检查。 |
| `git diff --check` | 0 | 无空白错误，只有 Windows 换行提示。 |
| `pnpm.cmd --dir ui/desktop exec prettier --check src/types/activityEvent.test.ts` | 1 | 新测试文件格式问题，已安排格式化重跑，不弱化断言。 |

中断前另一次 Rust 重跑未取得最终结果，以上后续明确退出码的重跑替代其验收；不补猜中断进程的状态。

### 后续验证与环境诊断

- `cargo test --locked -p goose --lib routing_evidence --target-dir C:\Users\admin\AppData\Local\Temp\CodeBuddy-phase-b\target`：退出 0，2 通过、0 失败、0 忽略，3327 项被筛选；测试了真实聊天入口仅一次推理、实际执行意图覆盖、未改变文件及会话重读。编译 6m58s。之后为避免把已绑定的历史请求误称为当前用户原文，将诊断枚举 `current_message` 更名为 `execution_message`，最终版本仍需再次验证。
- `pnpm.cmd --dir ui/desktop run typecheck` 首次因缺少生成的 `i18n/compiled/zh-CN.json` 退出非零；执行 `pnpm.cmd --dir ui/desktop run i18n:compile` 后重跑退出 0。
- `pnpm.cmd --dir ui/desktop exec eslint src/types/activityEvent.test.ts --max-warnings 0` 与格式化后的 `prettier --check` 退出 0。
- `node ui/desktop/scripts/prepare-platform-binaries.js` 退出 0，按 README 准备固定版本 uv/uvx。未修改平台模块源码。
- `cargo build --locked --target-dir C:\Users\admin\AppData\Local\Temp\CodeBuddy-phase-b\target` 退出 1：全工作区的 `llama-cpp-sys-2` C++ 依赖报 C4819/C2001/C2146，以及缺少 `/EHsc` 的提示。命令未采用桌面启动脚本的 Windows 环境；正在使用 README 启动入口重试。不据此认定本次 Rust 修改有错，也不宣称全构建通过。
- `cargo test --locked -p goose --target-dir C:\Users\admin\AppData\Local\Temp\CodeBuddy-phase-b\target -- --test-threads=2` 退出 101：LNK1104 无法打开 `libblock_padding-01592c282eb08c81.rlib` / `libnum_integer-3e3f8e318c33e81a.rlib`。后续只读检查发现前者实际存在；尚未证明具体根因。测试尚未运行，不能报告全量测试统计。原始日志保存在桌面证据目录的 `cargo-test-goose.log`。
- 最初 UI 全量测试在语言资源准备完成之前启动，出现中文消息断言失败。资源生成后，`pnpm.cmd --dir ui/desktop exec vitest run src/types/activityEvent.test.ts src/i18n/i18n.test.ts --maxWorkers=1 --reporter=verbose` 退出 0，31 项全部通过，已保存 `ui-focused.log`。因此不将首次中文断言失败登记为已确认产品缺陷。旧全量进程已按准确 PID 停止，重新运行完整 UI 门禁并保存 `ui-full.log`。
- README 桌面命令：在 `ui/desktop` 执行 `pnpm.cmd run start-gui`。本轮设置 `CARGO_PROFILE_DEV_DEBUG=2`、`CARGO_INCREMENTAL=1` 与前述缓存路径以复用调试构建；独立工作区 `target` 是指向缓存目录的 junction。启动脚本负责导入 Visual Studio 环境及 C++ 参数，日志保存在 `desktop-start.log`。这是构建产物路径复用，不合入其他分支源文件。

桌面证据目录：`C:\Users\admin\Desktop\测试汇总\修复证据\2026-09-16-routing-evidence`。日志可能包含本机路径，不应直接上传公共仓库。

## 桌面 E2E 现场

每个用例新建独立 CodePro 会话，不改变模型或权限。目录均在 `C:\test\test_0916\routing-evidence`，仅三个小型 Node 标准库测试项目。

| 用例 | 子目录 | 提示词 | 当前结果 |
| --- | --- | --- | --- |
| L01 | `L01-readonly` | 请读取 app.js 和 app.test.js，解释这个小项目的功能与测试覆盖。不修改任何文件，也不要运行命令。 | PASS |
| L02 | `L02-test-only` | 请在当前项目运行 npm test，报告真实结果，不修改任何文件。 | PASS；最终可见统计较简略 |
| L03 | `L03-change` | 请修复当前失败的测试，只修改 app.js，保留 app.test.js 的断言。修改后运行 npm test 验证。 | 业务 PASS；路由证据 PASS；发现单文件范围识别缺陷 |
| L04 | `L04-single-target-control` | 请修复当前失败的测试，只修改 app.js。修改后运行 npm test 验证。 | PASS；命中 `simple_change` 对照路线 |
| L05 | `L05-real-multifile-control` | 请修改 app.js 和 app.test.js：让 greeting(name) 返回 `hello, <name>`，未传参数时返回 `hello, world`，并补充对应测试。修改后运行 npm test 验证。 | PASS；真实多文件任务保持普通 `change` 路线 |

验收以实际路由及工具回执为准。即使原意图缺陷再次出现，也应如实保留；本次日志增强不承担修好旧分类缺陷的承诺。

Computer Use 已发现现有 CodeBuddy 窗口；该窗口当时来自主目录，尚不是本分支后端，不作为新代码验收。

### 用户手动 E2E 交接

1. 使用本报告分支目录启动的开发版，不启动另一份安装版。只有确认新后端构建成功且启动后，才开始测试；旧窗口不能替代新版本验收。
2. 分别选择表中的 L01、L02、L03 文件夹，每项新建独立会话，发送对应提示词。不要改变模型、权限或追加绕过拦截的提示。
3. 展开入口“思考”的技术详情，查找 `Routing evidence (host observations)`；保存最终报告和完整会话导出。缺少此段时记录缺失，不自行补填分类。
4. L01 应只读文件且不运行命令；L02 应实际运行测试但不改文件；L03 的业务目标是只改 app.js、保留原测试断言并验证。最终结果与实际工具回执分别记录，不能只看 PASS 文案。
5. 离开会话再从历史打开，检查技术详情仍在；完成后重启应用再核对一次。保存 session ID、run ID、时间、模型及权限设置、提示词、关键截图、导出 JSON。不要在未保存证据前重复同一用例或覆盖现场。
6. 日志验收核对：`classification_source`、`classified_intent`、`effective_intent`、`effective_intent_reason`、`simple_change_check`、`execution_route` 与同一 run 的执行事实一致。入口事件不说明 Planner、审批和工具的全部状态；这些仍查原有对应事件。

L01、L02、L03 均已由用户在真实桌面窗口中手动执行；日志增强验收与路由精度缺陷分开记录。

### L02 手动 E2E 结果（2026-09-17 10:11）

- 会话 `20260917_2`，run `run_1ae407d4-417c-438e-8770-7c559f238d22`，工作目录 `C:\test\test_0916\routing-evidence\L02-test-only`，模型 `custom_codebuddy_lan/kimi-k3`。
- 路由证据为 `classification_source=semantic_router_postprocessed`、`classified_intent=test`、`effective_intent=test`、`effective_intent_reason=classified_intent`、`goal_source=execution_message`、`simple_change_check=not_applicable`、`execution_route=test`。分类和入口路线与用户目标一致。
- 测试进度文件记录 `npm test` 被解析为 `C:\Program Files\nodejs\node.exe --test --test-isolation=none`，PID 11916，实际输出为 1 通过、0 失败、0 取消、0 跳过、0 todo，Node 报告耗时约 23.62 ms；终态 `verification_summary` 记录 `passed`、退出码 0、`evidence_ref=verify-1`。
- `changed_files=[]`；`app.js`、`app.test.js`、`package.json` 的写入时间均保持 2026-09-16 17:46:00，内容未变。没有出现虚假审批、Shell 拦截或重复重试。
- 最终用户可见正文只说“检查通过”，没有列出测试数量、执行命令和退出码。底层证据真实完整，因此本用例执行判定为 PASS；但“报告真实结果”的呈现质量仍有改进空间，不能只靠用户展开技术详情或导出 JSON 才看到统计。
- 纯测试任务的执行策略仍给出 `multi_file_or_unknown_write_scope`。该理由未影响本次执行，也不表示发生多文件写入；它对只读测试任务语义不贴切，登记为风险说明精度问题，不与意图或权限缺陷混为一谈。

判定：测试意图、动态执行、零写入和日志一致性均为 PASS；最终报告详细度及风险理由精度存在非阻塞问题。

### L04 单文件对照结果（2026-09-17 10:17）

- 会话 `20260917_6`，run `run_c58e8461-8621-46c1-acc8-65de938d6619`，工作目录 `C:\test\test_0916\routing-evidence\L04-single-target-control`，模型 `custom_codebuddy_lan/kimi-k3`。
- 路由证据为 `classification_source=workspace_constraint`、`classified_intent=change`、`effective_intent=change`、`effective_intent_reason=classified_intent`、`goal_source=execution_message`、`simple_change_check=matched`、`execution_route=simple_change`。
- 实际工具序列为查看目录、读取 `app.js`、读取 `app.test.js`、只编辑 `app.js`、运行 `npm test`。工具审计均为 `policy_allowed` 和 `success`；没有 Planner/Coder/Tester 多 Agent 拆分。
- `app.js` 从返回 `hello` 改为 `hi`，`app.test.js` 未写入。`npm test` 真实输出 1 通过、0 失败、0 取消、0 跳过、0 todo，退出码 0；最终 simple-change 报告列出了目标文件、验证命令和退出码。
- L03 与 L04 的同模型、同类项目、同一主要目标对照确认：仅当提示词额外提到受保护的 `app.test.js` 时，单文件检查才从 `matched` 变成 `unmatched`。结合 `classify_simple_change()` 当前收集全部路径候选、两个候选即返回 `None` 的实现，已足以确认“受保护文件被误当作第二修改目标”是 L03 路由降级的直接原因，而不是修改意图、Shell 权限或模型随机性。

判定：L04 业务与单文件快速路线均 PASS；L03/L04 最小差异对照使范围角色缺失的根因证据成立。后续修复必须区分允许修改目标、受保护对象与命令/引用中的路径，同时保留真实多文件修改继续走复杂路线。

### L05 真实多文件负对照（2026-09-17 10:20）

- 会话 `20260917_7`，run `run_e9fd7976-aa2c-457b-9070-6a3dd7d7d162`，工作目录 `C:\test\test_0916\routing-evidence\L05-real-multifile-control`，模型 `custom_codebuddy_lan/kimi-k3`。
- 路由证据为 `classification_source=semantic_router_postprocessed`、`classified_intent=change`、`effective_intent=change`、`effective_intent_reason=classified_intent`、`goal_source=execution_message`、`simple_change_check=unmatched`、`execution_route=change`；策略进入 L2 Planner/Coder/Tester，理由 `multi_file_or_unknown_write_scope`。
- Coder 任务明确保留两个修改目标及验证动作。实际 `file_changed` 事件分别对应 `app.js` 和 `app.test.js`；`package.json` 未写入。最终 `changed_files` 也只列出这两个文件。
- Tester 实际运行 `C:\Program Files\nodejs\node.exe --test --test-isolation=none`，PID 12024；输出为 2 通过、0 失败、0 取消、0 跳过、0 todo，退出码 0。实现和测试内容符合提示词。
- 最终可见正文仍只写“检查通过”，详细统计需要查看结构化终态或测试进度记录；与 L02 相同，登记为报告详细度问题，不影响本用例路由和业务判定。

判定：L05 PASS。三项最小差异证据闭环：L04 的单一真实修改目标命中 `simple_change`；L03 的单一修改目标加受保护对象被错误降级；L05 的两个真实修改目标正确保持普通 `change`。当前无需继续堆叠同类桌面用例，可进入回归测试与最小修复设计。

### L01 手动 E2E 结果（2026-09-17 10:05）

- 会话 `20260917_1`，入口 run `run_0943ca91-b003-4a61-a185-250f7bdcee6b`，只读执行 run `analysis-4d6a9c28-c626-4352-8798-2453fd630982`，工作目录 `C:\test\test_0916\routing-evidence\L01-readonly`，模型 `custom_codebuddy_lan/kimi-k3`。
- 路由证据为 `classification_source=semantic_router_postprocessed`、`classified_intent=read_only`、`effective_intent=read_only`、`effective_intent_reason=classified_intent`、`goal_source=execution_message`、`simple_change_check=not_applicable`、`execution_route=unified_executor`。字段与实际行为一致。
- 实际只调用两次 `developer::read_document`，分别读取 `app.js` 和 `app.test.js`；两次工具审计均为 `policy_allowed`、`success`。没有 Shell、测试、Computer、写文件或 Git 工具调用。
- 文件时间戳均保持 2026-09-16 17:46:00，内容未变。最终回答正确说明 `greeting()` 固定返回 `hello`，唯一测试使用 Node 内置测试框架断言该返回值，并合理指出当前无参数、分支或异常路径。
- `codepro_unified_turn.v1` 最终状态为 `finished`、`pause_reason=null`。工作区绑定虽然是 `writable_project`，但执行仍遵守本轮只读边界，说明可写工作区并未被错误等同于写入授权。

判定：业务行为、边界遵守与新增路由日志均为 PASS。本用例未触发权限审批或 Shell，不能用来判断测试路线的命令权限；该问题由 L02 单独验证。

### L03 手动 E2E 结果（19:14）

- 会话 `20260916_35`，run `run_1d2b2328-dbf8-487b-8607-0e87daeeb1fc`，工作目录 `C:\test\test_0916\routing-evidence\L03-change`，模型 `custom_codebuddy_lan/kimi-k3`。证据来自用户导出的完整会话 JSON、同一 run 的 `events.jsonl` 与 `test-execution-progress.jsonl`，不是自动化助手代操作。
- 入口路由证据完整写入并能随会话导出：`classification_source=workspace_constraint`、`classified_intent=change`、`effective_intent=change`、`effective_intent_reason=classified_intent`、`goal_source=execution_message`、`simple_change_check=unmatched`、`execution_route=change`。因此本轮日志增强的核心目标在真实桌面路径上通过。
- 执行策略进入 L2 `分析 → 编码 → 独立测试`，理由为 `multi_file_or_unknown_write_scope`。Coder 下发任务仍保留了用户边界：只修改 `app.js`，不得修改 `app.test.js`、`package.json` 或其他文件。
- 实际文件行为符合用户要求：`app.js` 从返回 `hello` 改为返回 `hi`，写入时间为 19:14:43；`app.test.js` 与 `package.json` 写入时间仍为 17:46:00。事件流只包含一次 `app.js` 的 `file_changed`，没有其他文件写入事件。
- 独立测试确实运行，不只存在最终 PASS 文案。`test-execution-progress.jsonl` 记录 `npm test` 解析为 `C:\Program Files\nodejs\node.exe --test --test-isolation=none`，PID 23624，退出码对应成功；统计为 1 通过、0 失败、0 取消、0 跳过、0 todo，耗时约 19.77 ms。终态报告的 `verification_summary` 同样记录 `task-2=passed`、`exit_code=0`、`evidence_ref=verify-1`。
- 未发现修改前实际运行 `npm test` 的事件。Coder 任务文本要求先复现失败，但执行器读取实现和断言后直接修改；用户原始要求只明确要求修改后验证，因此这不是本用例的业务失败，但属于任务文本与执行事实没有完全一致的可观测差异。
- 已确认的路由精度缺陷：`codepro_simple_change::classify_simple_change()` 会收集消息中所有看起来像文件路径的文本，不区分“允许修改目标”和“必须保留/禁止修改对象”。L03 同时出现 `app.js` 与受保护的 `app.test.js`，被视为两个候选文件，导致 `simple_change_check=unmatched`，继而误报“多文件或写入范围未知”并进入 L2。该缺陷增加了规划与多 Agent 开销，但本次未扩大实际写入范围，也未造成业务失败。
- 本轮只记录证据，没有修改路由、权限、白名单或审批策略。离开会话后从历史重开、应用重启后再次读取及截图尚未验证；会话导出本身已证明数据在导出时可读取，但不能替代重启持久化验收。

约 18:54 按用户重新授权尝试 Computer Use：加载技能规定的 `@oai/sky` 并调用 `list_apps()`，报 `Computer Use native pipe is unavailable: failed to connect native pipe: 系统找不到指定的文件。 (os error 2)`。重置 JS 会话并重新初始化后同样失败。按技能要求停止桌面输入，不自建操作通道、不以接口测试冒充桌面验收。该失败属于本次助手的桌面自动化环境，不是 CodePro 宿主权限或意图缺陷。

### 续跑说明

- 上一轮构建及 UI 全量测试的会话句柄失效；只读检查未发现存活的 cargo/rustc/Electron 进程，原日志也没有最终汇总。终止原因与退出码未知，不把已打印的通过项当成整套通过。
- 复用相同缓存、profile 与环境，通过原 README 启动入口续跑，不清缓存，不启动全工作区构建。新日志：`desktop-start-resume.log`。
- UI 全量重跑首次在沙箱内启动 esbuild 报 `spawn EPERM`，退出 1，测试未开始；申请沙箱外执行后再次运行，记录到 `ui-final.log`。这是本轮验证环境的限制，不是 CodePro 自己的工具白名单证据。
- 沙箱外完整 UI 重跑已结束：`pnpm.cmd --dir ui/desktop run test:run --reporter=dot`，退出 0；235 个文件通过，2070 项通过、4 项跳过、0 项失败，共 2074 项，耗时 573.04 秒。未新增跳过或修改断言以通过门禁。原始输出见 `ui-final.log`。
- `cargo fmt --all -- --check` 和 `git diff --check` 本轮退出 0。SDK 生成文件有工作区状态标记，但 `git diff --numstat` 未发现内容差异；不混入产品改动。
- `pnpm.cmd --dir ui/desktop run lint:check` 本轮退出 0，含完整 typecheck、ESLint 和 i18n 检查（15 个语言、2620 条消息）。原始输出暂存系统临时目录 `routing-evidence-ui-lint.log`。
- `pnpm.cmd --dir ui/desktop run format:check` 本轮退出 1，提示 776 个文件有格式差异；本次未修改这些无关文件，不执行全库格式化。此前本次修改的 `src/types/activityEvent.test.ts` 单文件 Prettier 检查通过。原始输出暂存系统临时目录 `routing-evidence-ui-format.log`。
- 用户提出约 20 分钟后下班，优先完成当前后端启动供手动验收；不追加其他耗时门禁，不将尚未运行的 clippy、自测 recipe 或最终 Rust 重跑标为通过。

### 最终构建与启动证据（19:03）

- 在 `ui/desktop` 执行 `pnpm.cmd run start-gui`，保留 `CARGO_PROFILE_DEV_DEBUG=2`、`CARGO_INCREMENTAL=1`、原 target 缓存路径。其后端命令 `cargo build -p goose-cli --bin goose --jobs 1` 完成，退出 0，显示 `Finished dev profile [unoptimized + debuginfo] ... in 16m 34s`；已同步开发后端。耗时为本次续跑，不包含上一轮中断前的时间。
- 缓存中的 `target/debug/goose.exe` 与日志分支的 `ui/desktop/src/bin/goose.exe` SHA256 均为 `63C97B3E0E2F9F1549C3699856F60B944A92F34610CE7D1AF939B6B0F6288DCA`。
- 两次通过 pnpm 管道启动均显示 Electron 已启动并以 0 退出，但没有留下 Electron/goose 进程，也无新应用启动日志，因此不能算桌面启动成功。第二次显式清除当前进程的 `ELECTRON_RUN_AS_NODE` 也未改善；没有证据认定该变量为根因。
- 复用已完成的构建，通过同一已安装 Forge 启动器，以 Node 和 PTY 运行：`node ..\node_modules\@electron-forge\cli\dist\electron-forge-start.js --enable-logging -- --dir C:\test\test_0916\routing-evidence\L03-change`，工作目录仍为 `ui/desktop`。未重编 Rust；运行中，无终态退出码。Node/PTY 启动成功不能单独证明此前秒退的具体根因。
- 应用日志 `C:\Users\admin\.CodeBuddy\state\electron-app\logs\main.log` 于 19:03:17.793 确认加载本日志分支的 `src/bin/goose.exe`，端口 59416，项目为 L03-change；19:03:24.545 打开开发页面，19:03:29.961 与 19:03:30.007 收到 `React ready`。
- 进程核对：Electron 主进程 PID 13480，后端 goose PID 20384，路径均属于本日志工作区。前端地址 `http://localhost:5173/` 只是开发服务器，不能以浏览器打开页面替代桌面 E2E。
- 未操作用户测试会话，未发送测试提示词；L01–L03 的业务结果和路由证据仍需真实桌面验收。

待补：最终版本私有入口和相关 Rust 回归重跑、完整 Rust 门禁、clippy、自测 recipe；真实窗口操作、技术详情/会话导出、重启读取、截图及会话/run ID 等待用户手动验收或桌面操作服务恢复。完整 UI 测试、UI lint/typecheck/i18n、Rust 格式检查和新后端构建已通过；全 UI 格式门禁的 776 个无关文件问题保留，不扩大修改范围。

## 阶段 B 最小修复（2026-09-17）

- 修复分支：`fix/simple-change-scope-roles`。保留阶段 A 的既有修改；未提交、未推送、未修改锁文件。
- 修复范围仅限 `codepro_simple_change::classify_simple_change()` 的单文件快速路线资格判断：先按语句片段区分允许编辑、受保护对象和验证命令，再只从允许编辑片段提取目标路径。没有修改意图分类、Planner、白名单、Shell 权限、审批策略或跨 revision 汇总。
- 采用：以用户明确允许写入的对象决定快速路线；受保护文件和验证命令中的路径只作为边界或后续动作证据。拒绝：把消息中出现的所有路径都当成修改目标，也不让模型输出扩大用户授权。
- 与 OpenAI 官方公开指南对照：采用“从指令与既有上下文推断任务范围，并明确保持范围纪律”的公开原则；只把它作为设计约束，不推断 Codex 私有路由或意图解析实现。来源：<https://developers.openai.com/api/docs/guides/latest-model>。
- 回归测试先于实现加入。修复前聚焦用例结果为 41 项中的 39 通过、2 组失败；失败恰好覆盖受保护路径和验证命令路径被误计为第二修改目标。实现后同一聚焦集合为 41 通过、0 失败、3290 项被过滤，命令为 `cargo test --locked -p goose --lib codepro_simple_change --jobs 1 --target-dir C:\Users\admin\AppData\Local\Temp\CodeBuddy-phase-b\target`，退出码 0。
- `cargo fmt --all -- --check` 退出码 0；`cargo clippy --locked -p goose --lib --no-deps --jobs 1 --target-dir C:\Users\admin\AppData\Local\Temp\CodeBuddy-phase-b\target -- -D warnings` 首次发现 5 处 UTF-8 字符串切片风险，改用安全边界读取后重跑退出码 0；`git diff --check` 退出码 0，仅有 Windows 换行提示。
- 负对照仍由现有用例覆盖：真实双文件修改继续返回普通 `change` 路线；目录、缺失文件、工作区外路径、敏感文件、链接、复杂任务及多个真实修改目标仍不能进入单文件快速路线。
- 桌面后端已按 README 的 `ensure-dev-backend`/`start-gui` 流程增量重建并重启。首次构建因当前 PATH 缺少 CMake 退出 101；固定使用本机 Visual Studio Build Tools 自带 CMake 后，同一构建复用已有产物并以退出码 0 完成，耗时 14m44s。新后端已同步到 `ui/desktop/src/bin/goose.exe`，Electron 于 11:35:31 从该路径启动后端，并于 11:35:46 收到 React ready。
- 当前尚未完成：在新构建上执行桌面 L03/L04/L05 E2E。已准备不覆盖旧证据的本地 L03 复测现场 `.local-e2e/L03-protected-target`；在该现场取得真实路由和执行证据前，不能宣称用户可见修复已经完成。

## 桌面后端增量构建配置复核（2026-09-17）

- 修改范围仅限 `ui/desktop/scripts/ensure-dev-backend.cjs` 及其单元测试；未修改 Cargo features、业务代码、锁文件或 target 目录，也未清理缓存。
- 构建模式固定为两档：日常默认 `fast-dev` 使用 `debug=0`、`incremental=1`、`jobs=2`；内存受限时显式设置 `CODEBUDDY_BUILD_MODE=low-memory`，使用 `debug=0`、`incremental=0`、`jobs=1`。脚本会移除同名环境变量造成的 profile 漂移，并在 Cargo 启动前打印最终配置；未知模式直接报错。
- Windows 预检会优先使用 `vswhere`，失败时验证 Visual Studio 2022 的标准安装目录，并自动加入其 CMake 路径。首次沙箱内诊断在不到 1 秒内报告 CMake 缺失，补充标准目录兜底后，沙箱外构建自动找到本机 Build Tools，无需人工拼接 PATH。
- 聚焦脚本测试命令为 `node --test scripts/ensure-dev-backend.test.cjs`，退出码 0；12 项通过、0 项失败，耗时约 134 ms。覆盖固定模式、环境漂移、VS 标准目录兜底、CMake 提前失败、Cargo 定位和锁定二进制回退。
- 第一次无额外环境覆盖执行 `pnpm.cmd run ensure-dev-backend`，打印 `mode=fast-dev, debug=0, incremental=1, jobs=2`，退出码 0；Cargo 用时 10m21s。该轮把此前 `debug=2/jobs=1` 的缓存归一到固定配置，因缓存指纹变化重新编译 V8、llama-cpp、AWS/加密等重依赖，不能代表日常增量耗时。
- 在不改变源码内容的前提下，仅更新 `codepro_simple_change.rs` 的时间戳，再以完全相同命令和配置复测：只重新编译 `goose` 与 `goose-cli`，退出码 0，Cargo 用时 34.94s。没有第二个 Cargo 进程、没有锁等待，也没有重新编译上述重依赖。
- 结论：固定配置后，同一 target、同一 profile 和同一 features 下的 Rust 日常增量循环已从此前的 14–60 分钟级收敛到本机约 35 秒。首次冷构建或真实配置变化仍会较慢；轻量 desktop features 与跨 worktree 的 `sccache` 属于后续独立设计，不在本次最小修复内。
- 构建时桌面应用仍占用 `ui/desktop/src/bin/goose.exe`，脚本按既有设计保留新产物于 `target/debug/goose.exe` 并报告 `built-fallback`，未强制关闭用户界面。新后端尚未通过桌面重启装载；本节只证明构建配置和增量缓存行为，不把它写成新的桌面 E2E 通过证据。

## 语义决策架构替换及 L07 验收（2026-09-17）

- 本节取代上文“阶段 B 最小修复”的关键词分类方案。`classify_simple_change()`、编辑关键词表、复杂任务关键词表和文本路径猜测已经删除；普通新请求不再由 `detect_codepro_constraint_in_workspace()`、简单对话关键词或文本续跑关键词决定业务路线。
- 语义模型现在一次返回结构化决策：`intent`、可选 `direct_change_target`、`project_memory_management`、`focused_test`、澄清问题及用户可见摘要。宿主只把这些字段映射到执行路线，并继续确定性校验目标必须是当前工作区内已存在的普通非敏感文件；模型输出不能跳过路径、权限、状态机或 Shell 校验。
- 语义服务不可用或输出无效时，不再按关键词降级为对话、只读或修改路线。本轮保留原任务与授权边界并返回可重试失败，避免失败路径悄悄改变用户目标。
- 采用 OpenAI 官方文档的 outcome-first 原则：提示中明确目标、成功标准和约束，让模型选择有效路径；`ALWAYS`/`NEVER` 只保留给安全与协议不变量；验证优先相关测试、类型检查和最小 smoke。拒绝在本次顺手迁移整个提供商层到 Structured Outputs，因为它会扩大改动面；当前仍严格解析 JSON 并由宿主校验。来源：<https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5>。
- 聚焦 Rust 回归：`agents::codepro_intent::tests::` 为 72 通过、0 失败；目标安全校验为 2 通过、0 失败；`routing_evidence_` 为 3 通过、0 失败。`cargo fmt --all -- --check` 与 `git diff --check` 通过。`cargo clippy --locked -p goose --lib --no-deps --jobs 2 -- -D warnings` 通过；`--all-targets` 还报告 `src/hints/load_hints.rs` 三处既有 `needless_borrows_for_generic_args`，未扩大本次修改范围。最后一次重复 72 项测试在依赖重编时由用户中止；此前同版本业务逻辑的 72 项结果及随后 lib clippy、桌面构建和真实 E2E 共同作为验收证据，不把中止命令记为通过。
- 桌面后端使用固定 `fast-dev` 配置完成构建，退出码 0，用时 7m13s；旧窗口关闭后同步到 `ui/desktop/src/bin/goose.exe`。Electron 于 15:08:34 从该路径启动后端，工作目录为 `C:\test\test_0917\routing-evidence\L07-typescript-command-path`，15:08:45 收到 React ready。
- 真实桌面 L07 会话 `20260917_15`、run `run_1e1031be-4d67-4e85-896d-fd7f6f8b41dc`：用户要求只修改 `app.ts`、保护 `app.test.ts` 并运行 TypeScript 测试。路由证据为 `classification_source=semantic_model`、`classified_intent=change`、`effective_intent=change`、`simple_change_check=matched`、`execution_route=simple_change`。
- 实际工具序列为目录读取、读取 `app.ts`、读取 `app.test.ts`、只编辑 `app.ts`、运行 `node --test --test-isolation=none app.test.ts`。磁盘复核确认 `app.ts` 返回 `hi`，`app.test.ts` 断言未修改；测试为 1 通过、0 失败、退出码 0。用户原文还把命令写成了 `node--test`，执行仍根据目标和上下文选择了正确命令，说明本次通过不是增加该提示词的字符串特判。
- L07 用户可见修复与路由验收均为 PASS。尚未执行完整 `goose` crate 测试、完整自测 recipe，以及因 Computer Use 当前不返回原生应用而无法自动完成的截图/重启历史读取；这些限制不影响本次 L07 已取得的真实执行证据，但提交说明必须继续如实保留。

## 旧会话复测与语义协议隔离（2026-09-17）

- 用户没有新建会话，而是在原 L01、L02 会话中重复原提示词。L02 会话 `20260917_2` 正确得到 `classification_source=semantic_model`、`intent=test`、`execution_route=test`；实际测试退出码 0，`changed_files=[]`。这证明旧会话本身不是必然失败条件。
- L01 会话 `20260917_1` 的第二次请求在语义决策阶段失败，界面显示“CodePro semantic decision failed; the original task was preserved for retry”。对应模型请求把历史用户消息、历史助手答案和当前重复请求作为真实对话角色重放；模型受到“延续回答”语境影响，直接返回了项目解释正文，而不是路由 JSON。严格解析器正确拒绝该输出并保留原任务，因此没有误执行或扩大授权，但可用性未通过。
- 根因不是缺少某个中文关键词，也不通过增加字符串匹配修复。语义路由上下文现改为单个用户消息，其中包含结构化 JSON：当前请求、最近历史及未完成澄清目标；历史角色和文本仅作为不可信数据传给模型，不再以真实 assistant/user 轮次驱动续答。这样既保留“继续”等请求所需上下文，又隔离旧答案对路由协议的角色污染。
- 路由提示进一步明确模型是语义路由器而非任务执行 Agent，不得回答用户任务。第一次输出违反 JSON 协议时，同一个语义模型会用协议修复提示重试一次；两次均无效才保持安全失败。没有增加关键词表、基于正文猜测意图或绕过宿主校验的降级路径。
- 新增回归覆盖：旧助手答案只作为数据、后续请求仍保留前序目标、首次非 JSON 后第二次结构化决策成功、取消能终止提供商重试。测试夹具使用显式 mock 路由配置，不读取用户全局配置。
- 聚焦命令 `cargo test --locked -p goose --lib semantic_intent_ --jobs 2` 最终退出 0：6 通过、0 失败、3317 项被筛选，执行阶段 0.30 秒，总耗时 1.97 秒。修改测试夹具后，单独取消测试也为 1 通过、0 失败。Windows 在每次修改 `agent.rs` 后重新链接大型 lib 测试二进制，分别耗时约 2m54s 和 3m20s；稳定产物下复跑为秒级，未清缓存、未并行启动 Cargo。
- 桌面后端随后用固定 `fast-dev` 配置增量构建成功：`pnpm.cmd --dir ui/desktop run ensure-dev-backend` 退出 0，Cargo 用时 4m42s。受限环境内的第一次尝试在 1 秒内因无法导入 Visual Studio 环境而提前失败，没有启动 Cargo；沙箱外重试自动导入工具链。该轮重新编译了部分加密、压缩、网络和数据库依赖，不能作为稳定 35 秒增量样本，也未并发启动第二个 Cargo。
- 构建时旧 Electron/后端仍占用 `ui/desktop/src/bin/goose.exe`，脚本未覆盖运行中的旧二进制，新产物保存在 `target/debug/goose.exe`，并明确报告下一次开发启动将直接使用它。关闭旧应用后，新产物成功同步；直接 Forge 开发入口于 16:06:39 从 `ui/desktop/src/bin/goose.exe` 启动后端，工作目录为 L01，16:06:51 收到 React ready。普通 `start-gui` 管道曾表面报告启动成功后立即退出；沙箱内直接 Forge 又因 `spawn EPERM` 失败，沙箱外同一入口最终稳定启动。这些启动问题未触发 Rust 重编，也不计作 L01 业务失败。
- L01 最终在原会话 `20260917_1` 中复测通过，没有新建会话。入口 run `run_bb0d3fbb-e550-4a12-b85e-5ef5accb1e8d` 的证据为 `classification_source=semantic_model`、`classified_intent=read_only`、`effective_intent=read_only`、`semantic_warning=null`、`simple_change_check=not_applicable`、`execution_route=unified_executor`；执行 run 为 `analysis-121dd143-aba8-497a-94a2-2113d5f76c9e`。
- 本地 LLM 请求日志确认语义路由只收到一个 user 角色消息；当前请求、旧 user 请求和旧 assistant 答案均位于 `prior_conversation` JSON 数据中，没有作为真实对话角色重放。执行仅包含两次 `developer::read_document`，分别读取 `app.js` 和 `app.test.js`；审计均为 `policy_allowed/success`。没有 Shell、测试、Computer、文件写入或 Git 调用，最终回答与文件内容一致，`codepro_unified_turn.v1.status=finished`、`pause_reason=null`。
- 判定：L01 旧会话恢复 PASS，原“semantic decision failed”已在用户可见路径上消失；L02 也已在原会话通过，不需重复。语义路由修复的源码回归、构建、启动和两类旧会话对照证据闭环成立。
