# 主 Agent 独立模型配置

用户要求：在“分析 Agent”上方新增同样样式的“主 Agent”，可选择已配置厂商及其可用模型。

## 实现边界

- 沿用 `GOOSE_CODEPRO_MODEL_ROUTING` 和已有 ACP read/save 接口；宿主仍负责校验厂商、模型及重复角色，UI 不另存配置。
- `main` 是模型配置角色，不新增 Worker 的 `AgentRole`，不改变任务、权限、委派或完成门槛。
- 统一执行入口和旧单文件执行入口将配置传给已有 `prevalidated_provider` / `model_config_override`。分析路由继续使用 `planner`，主执行及其工具审计使用本轮实际模型；不修改会话默认模型。
- 会话命名仍使用会话的厂商和模型，避免把主 Agent 的厂商与会话的模型错误配对。
- 工具兼容模式（toolshim）及执行中刷新工具使用本轮实际模型配置，不再用会话模型准备工具后才覆盖模型名称。
- 每轮读取配置，执行中的请求不热切换。按后续用户批准的新语义，关闭高级路由并保存也保留独立组合，仅停用；重新启用仍需通过可用性校验。

## 兼容

版本 1 的四个原有角色仍为必需，新增 `main` 可选。旧配置、旧 checkpoint 缺少主 Agent 时沿用会话模型，不从分析 Agent 猜测。界面加载旧配置时以当前模型填充新增卡片，只有用户保存才持久化。

包含 `main` 的新配置以及停用但保留非空组合的新语义，需要本次前后端一起使用。旧后端不认识 `main`，也拒绝停用时保留组合；降级前需备份后恢复旧四角色启用配置，或显式保存停用且 `routes: []` 的旧格式，不能只取消勾选。应用不自动丢弃用户选择。

## 验收边界

新增/调整回归覆盖旧配置兼容、重复主角色拒绝、主角色独立解析、复用厂商激活、卡片顺序与保存恢复。按本批约定未执行测试；类型检查与构建结果另行记录，不能代替实际模型调用 E2E。

手工验收：启用高级路由，给主 Agent 与分析 Agent 选择不同模型，保存后重新打开核对；发起新任务，核对分析与主执行的实际模型回执；关闭高级路由后确认回到当前模型。执行中的任务不得中途换模型。

## 文件与源码来源

工作区 `C:\Users\admin\CodeBuddy`，分支 `fix/codepro-context-compaction`，基线 `18753e430` 加本批未提交改动。原有规则文件、本地夹具与其他报告未纳入本次修改。

- 配置界面：`ui/desktop/src/components/codepro/CodeProModelModal.tsx` 及其测试。
- 前端合同与文案：`ui/desktop/src/acp/codeproModelRouting.ts`，`ui/desktop/src/i18n/messages/en.json`、`zh-CN.json`。
- 宿主合同：`crates/goose-sdk-types/src/custom_requests.rs` 及 `tests/codepro_model_routing_contract.rs`。
- 路由与执行：`crates/goose/src/agents/model_router.rs`、`agent.rs`、`reply_parts.rs`；`task_scheduler.rs` 仅补齐原有测试夹具的缺省字段。
- SDK：`crates/goose/acp-schema.json`，由既有生成器同步 `ui/sdk/src/generated/types.gen.ts`、`zod.gen.ts`。

## 本轮执行结果

- `cargo fmt --all`、`pnpm.cmd run typecheck`、`pnpm.cmd run i18n:compile`、`pnpm.cmd run build-goose-sdk`、相关文件 `git diff --check`：最终退出码均为 0。
- `pnpm.cmd run ensure-dev-backend`：最终退出码 0，dev 构建通过，仍有 3 条既有 dead-code 警告。中间一次检查使用了不兼容当前 Rust edition 的 let-chain 语法，已改回嵌套写法后重跑通过；未改变工具链。
- 直接调用 formatter CLI 不可用（退出码 1），未安装依赖；前端新增代码的格式已手工整理。
- `pnpm.cmd run start-gui`：退出码 0，SDK、文案、main/preload 构建完成，但非交互 launcher 未保持窗口；按已有 runbook 启动 Vite 与已编译 Electron。核对窗口 PID 24572、后端 PID 7340，后端端口 52062，均来自当前工作区。
- `target/debug/goose.exe` 与桌面 `src/bin/goose.exe` SHA256 一致：`CD354B5BFBDFFD3D1DFD3457C167121CF5FED6FEA4C064D5FF2A128FD1F8EAA7`。
- 自动测试、Clippy、实际主/分析模型分流 E2E 未运行；新窗口启动与编译通过不是功能 E2E PASS。本批改动尚未提交或推送。

## 后续：模型组合保存后回退

用户报告保存后重新打开全部恢复 kimi-k3。只读取当前配置确认 `advancedRoutingEnabled: false`、`routes: []`。本次后端日志未记录保存请求序列，因此不能认定具体一次保存由哪个分支清空。

源码确认两类会丢失选择的路径：模型列表失败、缺少已选模型或厂商时，`clearStaleRouting` 自动持久化空配置；父组件重绘生成新的 `currentDefault` 或 intl 对象时，加载 effect 再次运行，覆盖编辑草稿。上轮未完成保存回读行为验收，遗漏了这些路径。

修复仅涉及弹窗及两个测试文件：

- 移除读取/模型发现 effect 中的自动保存和默认值覆盖；配置写入只发生在用户保存时。
- 持久配置、当前默认和厂商目录共同完成初始加载后才开放编辑/保存，旧四角色配置仅初始化缺省的主角色。
- 依赖实际默认值及文案值，不因对象引用变化重新初始化；模型暂时不可用保留选择，显示错误和重试入口。
- 增加重绘、保存后重开、不可用厂商/模型、读取未完成及读取失败等回归。`pnpm.cmd run test:run src/components/codepro/CodeProModelModal.test.tsx src/components/codepro/CodeProModelModal.modelDiscovery.test.tsx` 最终退出码 0，两文件 30 项通过；`pnpm.cmd run typecheck` 与相关 `git diff --check` 退出码 0。首次运行的重绘回归暴露 intl 对象变化触发重载，修复后重跑通过。测试使用模拟配置和模拟厂商，不写用户配置、不请求真实模型。

本轮为前端修复，开发 Vite 已热更新，无需 Rust 重编译。真实桌面里重新选择、保存、重开仍需用户验收；已清空的组合未擅自恢复或猜测。

## 后续：关闭再开启高级路由重置组合

用户确认保存已经有效，但在同一弹窗取消勾选后重新勾选，全部角色恢复默认模型。源码直接原因是开关 `onChange` 在启用时无条件调用 `setSelections(selectionsFromDefault(defaultSelection))`，不是持久化失败。上次修复遗漏了这个编辑入口。

本次仅修改弹窗、两个回归测试文件与本报告：

- 开关只改变启用模式，保留已加载或用户编辑的五角色厂商/模型组合；初次没有配置时仍由初始加载填入默认组合。
- 切换模式清除旧的操作错误和重复组合确认；高级路由关闭时不展示它的模型发现错误和重试入口，重新开启后仍正常检查可用性。
- 取消不保存；保存失败保留草稿且不自动关闭；显式关闭并保存仍提交 `advancedRoutingEnabled: false, routes: []`。没有新增持久化草稿或修改宿主合同，因此关闭并保存后再重开不保留原独立组合。

复查范围：设置页和聊天底栏两处弹窗入口、初始加载与父级重绘、五角色编辑、模型发现失败/重试/过期回包、开关、重复组合确认、保存/取消/重开及普通默认模型切换事务。配置读取与模型发现不写设置；真实保存仍由既有 ACP 接口交给宿主校验。本次不修改后端、实际执行路由或正在运行的任务。

验证（当前工作区、`18753e430` 加现有未提交改动）：

- 先增加回归运行单文件，退出码 1：已保存/新编辑组合两种场景均复现厂商被重置，另发现切换后旧保存错误残留，共 3 项失败。
- 修复后执行 `pnpm.cmd run test:run src/components/codepro/CodeProModelModal.test.tsx src/components/codepro/CodeProModelModal.modelDiscovery.test.tsx src/acp/codeproModelRouting.test.ts`，退出码 0，3 文件 38 项通过。全部使用模拟配置/厂商，不写用户配置、不请求真实模型。
- `pnpm.cmd run typecheck`、已有 Prettier 对三个界面/测试文件的格式化、`node ../node_modules/eslint/bin/eslint.js src/components/codepro/CodeProModelModal.tsx src/components/codepro/CodeProModelModal.test.tsx src/components/codepro/CodeProModelModal.modelDiscovery.test.tsx --max-warnings 0 --no-warn-ignored`、相关文件 `git diff --check` 均退出码 0。
- Vite 日志记录 15:29:28 加载修改后的弹窗。仅前端变更，没有重编译 Rust 或制作安装包；真实桌面开关、保存后回读及实际模型调用仍不是本次自动测试所证明的结果。本批尚未提交、未推送。

审查保留项：跳转厂商配置会卸载弹窗、放弃未保存草稿；保存请求发出后关闭弹窗不会取消已发出的请求。这些是现有行为，本次未扩大为跨页面草稿恢复或可撤销保存机制。未发现本次开关修复改变配置/执行权威边界的证据，不据此宣称整个产品无回归。

## 后续：停用但保留组合（取代此前关闭保存清空的规则）

用户明确批准调整后端规则：关闭仅暂时停用，保存并重新打开后仍可恢复原组合。继续使用原版本 1 文档、开关和角色数组，不新增第二套存储或状态机。

- 宿主反序列化：停用时保留角色选择，仍校验非空标识、重复角色、版本、字段和并发范围；角色齐全仅作为启用条件。
- ACP 保存：停用不联系厂商，离线/已移除的厂商选择可以作为偏好保留；启用仍走实时凭据/模型校验，失败不覆盖旧配置。
- 执行端：保留原有 `advanced_routing_enabled` 检查，停用时整个组合和并发数均不参与执行。新增回归检查主角色及四个工作角色均不能使用停用组合。
- UI：停用配置仍恢复到草稿，关闭时展示实际默认模型和保留说明；开关不重置选择。停用保存保留已选完整厂商/模型对；只选厂商、模型尚空的未完成行不构成可保存的组合，重开该行以默认值初始化。取消不写配置。
- 相邻入口：普通默认模型切换和厂商失效导致的自动停用保留原角色选择，避免从另一路径清空组合。没有恢复已删除厂商或凭据。

迁移：旧空配置、旧四角色配置可读；新的停用非空配置要求新后端。旧版本降级前需备份组合、显式清空停用配置的 `routes`，否则旧版会拒绝读取；不自动转换或猜测恢复。此次需要后端重编译和重启，不能只依赖前端热更新。事实所有权地图同步记录本次用户批准的语义扩展。

验证进度：前端弹窗、模型发现、ACP 配置事务及聊天模型栏 4 文件 48 项测试通过（退出码 0）；`pnpm.cmd run typecheck`、`pnpm.cmd run i18n:compile` 退出码 0。Rust 回归、构建及最终审查结果待下文记录。测试使用模拟厂商和隔离配置，不改用户组合、不调用真实模型。

补充验证记录：

- `cargo test --offline -p goose-sdk-types --test codepro_model_routing_contract --jobs 1`：退出码 0，5 项通过。Rust 命令复用 `ensure-dev-backend.cjs` 导出的 Windows 开发环境与开发 profile 配置，不手工另设工具链或优化参数。
- `cargo fmt --all`、相关文件 ESLint、`git diff --check`：退出码 0。
- `node scripts/i18n-validate-locale.js zh-CN`：退出码 0，2685 条消息校验通过。完整 `pnpm.cmd run i18n:check` 未通过：英文目录有本次前已存在的提取差异，其他语言还缺既有键以及新增提示的翻译。曾按脚本提取以定位差异，已撤回其无关排序/旧键改动，仅保留本批主角色和停用提示，并重新编译语言资源；不声称全语言门禁通过。
- `cargo test --offline -p goose --lib disabled_preferences_never_become_effective_routes_or_parallelism --jobs 1`：退出码 0，1 项通过；包含依赖编译耗时 16 分 35 秒。
- `cargo test --offline -p goose --lib provider_lifecycle_change_disables_stale_codepro_routes --jobs 1`：退出码 0，1 项通过。
- `cargo test --offline -p goose --test acp_custom_requests_test typed_routing_save_validates_live_models_before_one_snapshot_write --jobs 1`：退出码 0，1 项通过；包含编译耗时 4 分 24 秒。真实 ACP 测试接口配合注入厂商及临时目录，证明停用保存不调用厂商、可以回读原组合、重新启用仍校验失效模型，拒绝后原配置字节保持不变；不是用户桌面 E2E。
- 用户随后要求停止测试、直接重建。已停止追加测试/Clippy，不再扩展验证范围，执行 `pnpm.cmd run ensure-dev-backend`。此局部修复的 Rust 测试目标编译开销过大，后续应更早说明成本并选择与交付阶段相称的验证。
- 第一次开发后端构建退出码 1（Cargo 101）：`llama-cpp-sys-2` 构建进程未找到 `cmake`，输出显示未导入 INCLUDE。随后使用原脚本做只读环境检查，确认本机 Visual Studio BuildTools 自带 CMake 且正常环境包含 INCLUDE；没有安装工具、删除缓存或更改构建参数。改为在获准的正常进程环境重跑同一个 `pnpm.cmd run ensure-dev-backend`。用户已明确允许重启，旧窗口通过正常关闭请求退出。
- 最终 `pnpm.cmd run ensure-dev-backend` 退出码 0，dev 后端构建完成并同步至桌面目录，耗时 14 分 26 秒；仍有上述 3 条既有未使用函数警告。按用户要求未追加测试或 Clippy。
- 16:24 重新启动当前工作区开发桌面：Electron PID 23896，窗口标题 CodeBuddy、句柄 5113960；其子后端 PID 25000，从 `ui/desktop/src/bin/goose.exe` 启动、端口 65478；16:24:28 收到 React ready。沿用未改动的 main/preload 包与当前 Vite renderer；没有制作安装包。
- `target/debug/goose.exe` 与桌面后端 SHA256 相同：`27C6B1A45850E0B07F5AD241B2EEB5A1B52E662AFBAF51DF824D6217C8A633FA`。构建来源为本工作区 `fix/codepro-context-compaction`、`18753e430` 加本批未提交改动；未提交、未推送。这里只确认启动及产物身份，不声明真实桌面功能 E2E 已通过。

## 提交范围与后续移植基准

用户要求先提交模型路由，再以提交后的版本作为 Computer Use 移植基准。本批包含主 Agent 独立路由、配置加载/保存与开关保留组合、相邻停用入口、对应测试、生成合同、文案及职责记录；不纳入其他规则修改、本地夹具、历史测试报告或 Computer Use 移植文档。此前各段“未提交”为对应阶段的历史状态，实际提交身份以 Git 记录为准。

此次仅核对提交范围和差异格式，不重复编译、测试或重启；前述自动验证、构建与未执行的 Clippy、产品 E2E 边界保持不变。该提交用于固定源码，不代表新增产品验收结论，也没有推送到远端。
