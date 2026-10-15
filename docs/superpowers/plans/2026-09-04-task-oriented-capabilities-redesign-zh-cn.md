# CodeBuddy 任务导向能力重构实施计划

日期：2026-09-04
依据：`docs/superpowers/specs/2026-09-04-task-oriented-capabilities-redesign-zh-cn.md`
状态：可以开始实施
语言：简体中文

## 执行原则

- 当前 `main` 有大量未提交修改并领先远端 2 个提交。每阶段先检查文件重叠，只改本计划列出的文件，不 reset、checkout、clean、建分支、提交或推送。
- 先写失败的回归测试，再做最小实现；新回归未解释前不进入下一阶段。
- Rust/Cargo 和完整 UI 测试串行运行；记录命令、工作目录、退出码及通过/失败/忽略数。
- 原始配置编辑器文件目前已在工作树删除；验证并保留该结果，不重新创建。
- Skills、Apps、MCP、Recipes、Scheduler 保持各自数据所有权，工具箱仅增加聚合读模型和动作分发。

## 阶段 0：基线与修改边界

**文件**：修改 `NavigationPanel.test.tsx`、`App.test.tsx`、`SettingsView.test.tsx`、`settingsNavigation.test.ts`、`SkillsView.test.ts`、`ExtensionItem.test.tsx` 和 `CronPicker.test.tsx`。

**步骤**

1. 保存分支/脏工作树、相关 diff、C/D 盘空间及 cargo/rustc/node/electron 进程证据；其他工作正在修改同一文件时先协调。
2. 补特征测试，锁定旧路由、五类来源加载、设置页无原始配置编辑器，以及行为设置当前真实读写。
3. 运行已有 Provider 回归，保护之前的供应商新增、更新和默认端点修改。

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/App.test.tsx src/components/Layout/NavigationPanel.test.tsx src/components/settings/SettingsView.test.tsx src/components/settings/settingsNavigation.test.ts src/components/settings/providers/ProviderGrid.customLifecycle.test.tsx src/components/settings/providers/ProviderSettingsPage.test.tsx src/components/settings/providers/modal/subcomponents/forms/CustomProviderForm.localConnection.test.tsx --maxWorkers=1
```

## 阶段 1：主导航与兼容路由

**文件**：修改 `useNavigationItems.ts`、`navigationUtils.ts`、`NavigationPanel.tsx`、`App.tsx` 及测试；新增 `toolboxRouting.ts` 和测试。

1. 测试先期待六个入口：新任务、常用任务、自动任务、工具箱、历史记录、设置。
2. 新增 `/toolbox` 和 `/codepro/toolbox`。旧 `/skills`、`/apps`、`/extensions` 转到工具箱对应分区，并保留 query、workspace mode 和来源状态。
3. `View` 增加 `toolbox`；旧调用保留兼容。Recipes、Schedules、Sessions 只改显示名称，不改底层路由。
4. 旧中英文名称作为搜索别名存在，不作为主标题。

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/utils/toolboxRouting.test.ts src/components/Layout/NavigationPanel.test.tsx src/App.test.tsx --maxWorkers=1
```

## 阶段 2：工具箱聚合读模型

**文件**：新增 `src/types/toolbox.ts`、`src/acp/toolbox.ts`、`src/components/toolbox/toolboxModel.ts`、`ToolboxView.tsx` 及测试；修改 `App.tsx`。

1. 定义 `builtin | skill | app | external` UI 判别联合，包含稳定 ID、来源、状态、可用动作、使用信息和结构化引用。
2. 并行调用 `listSkillSources`、`listMcpApps`、`getConfiguredExtensions`；用 `Promise.allSettled` 保留部分成功结果。
3. Skills 只采用 ACP 返回的 `skill`/`builtinSkill`，禁止扫描 `C:\Users\jiangrui\.codex\skills`。
4. 显示现有能力、做事方法、我的小工具、外部工具，以及 loading/empty/setup/permission/failed/partial failure 状态。
5. 卡片操作分发回现有 API，不复制来源配置。

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/acp/toolbox.test.ts src/components/toolbox/toolboxModel.test.ts src/components/toolbox/ToolboxView.test.tsx --maxWorkers=1
```

## 阶段 3：外部工具连接、测试和原子更新

**文件**：修改 `goose-sdk-types/src/custom_requests.rs`、ACP `server/extensions.rs`、`custom_dispatch.rs`、`server.rs`、`acp_custom_requests_test.rs`；生成 ACP schema/SDK；修改桌面 `acp/extensions.ts`、`ExtensionsSection.tsx`、`ExtensionModal.tsx`、`ExtensionConfigFields.tsx` 及测试。

1. 先测更新按钮在有效修改后可用、更新失败保留旧配置、测试连接不落正式配置且不计使用。
2. 新增 `configExtensionsTest`：临时初始化 STDIO/HTTP、列出 tools/resources、清理资源，返回延迟、能力摘要和安全化错误。
3. 新增以 `configKey` 定位的原子更新 API，替代“先删后加”。
4. 普通表单只显示名称和 URL/命令；env、headers、timeout、工具白名单放高级设置。SSE 只显示迁移提示。
5. 删除或关闭前展示结构化依赖。
6. 只运行生成器更新 schema/SDK，不手改生成文件。

```powershell
cd D:\CodeBuddy
cargo test -p goose --test acp_custom_requests_test config_extensions --jobs 1
just generate-acp-types
just check-acp-schema
cd ui\desktop
pnpm exec vitest run src/components/settings/extensions/modal/ExtensionModal.test.tsx src/components/settings/extensions/extension-manager.test.ts src/components/settings/extensions/subcomponents/ExtensionItem.test.tsx src/acp/toolbox.test.ts --maxWorkers=1
```

## 阶段 4：本地实际使用记录

**文件**：新增 `crates/goose/src/capability_usage.rs`、`acp/server/capability_usage.rs`、`tests/capability_usage.rs`、桌面 `acp/capabilityUsage.ts` 及测试；修改 `lib.rs`、custom requests/dispatch、`extension_manager.rs`、`skills/client.rs`、`scheduler.rs`、`AppsView.tsx`、`RecipesView.tsx`。

1. 建立版本化、原子写入的本地记录，只保存类型/ID、最后成功时间、成功次数、最近结果和引用；不保存提示、参数、文件内容和凭据。
2. 仅在 skill 真正加载、MCP tool 成功、App 初始化成功、Common Task session 创建成功、调度器真实触发时记录。
3. 后端事件直接记录；前端成功事件通过 ACP 写入统一存储；event ID 必须幂等。
4. ACP list 只返回汇总，不暴露审计参数摘要或私人路径。
5. 损坏使用记录显示可恢复错误，不能清空能力列表。

```powershell
cd D:\CodeBuddy
cargo test -p goose --test capability_usage --jobs 1
cargo test -p goose skills:: --jobs 1
cd ui\desktop
pnpm exec vitest run src/acp/capabilityUsage.test.ts src/components/toolbox/toolboxModel.test.ts src/components/apps/AppsView.test.tsx src/components/recipes/RecipesView.workspace.test.ts --maxWorkers=1
```

## 阶段 5：常用任务

**文件**：新增 `components/recipes/commonTaskModel.ts` 和测试；修改 `RecipesView.tsx`、`CreateEditRecipeModal.tsx`、`RecipeFormFields.tsx`、`RecipesView.workspace.test.ts`、`recipe_management.ts`。

1. 保留 Recipe YAML、深层链接和 ACP，仅将用户概念改为 Common Task。
2. 卡片从结构化 manifest 显示用途、模型、extensions、已知文件、权限、最后执行和结果；不解析 prompt 猜依赖。
3. 主操作为“运行、编辑、设为自动”，导入/导出/YAML/深链放高级菜单。
4. 创建支持“描述我要做的事”和“手动设置”；描述模式带明确意图进入新任务，手动模式复用表单。
5. 运行前展示依赖和风险摘要，但不替代现有权限确认。

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/components/recipes/commonTaskModel.test.ts src/components/recipes/RecipesView.workspace.test.ts src/components/recipes/shared/__tests__/RecipeFormFields.test.tsx src/recipe/validation.test.ts --maxWorkers=1
```

## 阶段 6：自动任务

**文件**：新增 `FriendlySchedulePicker.tsx` 及测试、`cronSchedule.test.ts`；修改 `ScheduleModal.tsx`、`SchedulesView.tsx`、`ScheduleDetailView.tsx`、`cronSchedule.ts`、`acp/schedules.ts`、调度 ACP/SDK/Rust 文件和 `scheduler_test_support.rs`。

1. 普通界面以频率、星期、日期和本地时间生成易读计划；原始 cron 放高级区。
2. 显示 Common Task、依赖、下次运行、通知和“应用必须运行、错过默认不补跑”。
3. 新增“先测试再启用”；测试失败不能启用，取消不能留下活动排程。后端持久化 `paused/tested`，旧数据保持原行为。
4. 定时触发与 Run now 分开计数，只有调度器触发算 Automatic Task 使用。
5. 保留 pause/unpause/kill/inspect/history/workspace mode。

```powershell
cd D:\CodeBuddy
cargo test -p goose scheduler --jobs 1
cargo test -p goose --test schedule_tool_security --jobs 1
cd ui\desktop
pnpm exec vitest run src/components/schedule/__tests__/FriendlySchedulePicker.test.tsx src/components/schedule/__tests__/CronPicker.test.tsx src/utils/cronSchedule.test.ts src/utils/scheduleWorkspace.test.ts --maxWorkers=1
```

## 阶段 7：按真实效果重组设置

**文件**：修改 settings navigation/view/chat/mode/goosehints/response styles 及测试；新增 `input/InputSettingsSection.tsx`、`security/SecurityAndPermissionsSection.tsx`、`advanced/AdvancedBehaviorSection.tsx`；更新 `settings-behavior.spec.ts`。

1. 先证明组件移动后仍使用相同配置键，已有 session 不受默认模式修改影响。
2. “行为与回答”只保留默认模式和回答相关项；“回复风格”改为“工具过程显示”。
3. 语音/拼写移到输入，提示注入/权限移到安全，最大轮次移到高级，项目提示显示为项目规则。
4. 系统提示模板留在高级，不恢复原始键值编辑器。
5. 搜索支持新名称和旧别名并跳到新位置。

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/components/settings/settingsNavigation.test.ts src/components/settings/SettingsView.test.tsx src/components/settings/mode/ModeSection.test.tsx src/components/settings/models/ModelsAndRuntimeSettings.test.tsx --maxWorkers=1
pnpm exec playwright test tests/e2e/settings-behavior.spec.ts --workers=1
```

## 阶段 8：国际化与兼容清理

通过 `pnpm run i18n:extract` 更新英文消息，完整更新 `zh-CN.json`、`zh-TW.json`，按项目规则处理其他语言 fallback；保留旧 API/YAML 名称和路由别名。

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm run i18n:extract
pnpm run i18n:check
pnpm exec vitest run src/i18n/i18n.test.ts --maxWorkers=1
```

## 阶段 9：真实 MCP 单文件知识源验收

**文件**：修改 `ui/desktop/package.json`、`pnpm-lock.yaml`、`tests/e2e/fixtures.ts`、`goose-self-test.yaml`；新增 `tests/e2e/toolbox-mcp-filesystem.spec.ts`、`mcp-filesystem-evidence.ts`；证据存入 `.cargo/evidence/toolbox-mcp-acceptance/`，不保存私人正文。

1. 执行 `pnpm add -D -E @modelcontextprotocol/server-filesystem@2026.8.31`，禁止 `latest`。
2. 使用隔离 profile，测试前记录 `D:\xwechat_files\wxid_5mloegbbcbl222_d3a5\msg\file\2026-09\obsidian README.md` 的 SHA-256、大小和修改时间。
3. 在真实界面连接：command=`cmd`；args=`/c`, `npx`, `-y`, `@modelcontextprotocol/server-filesystem@2026.8.31`, `D:\xwechat_files\wxid_5mloegbbcbl222_d3a5\msg\file\2026-09`。
4. `list_allowed_directories` 规范化后只能包含该父目录；测试连接后使用数仍为 0。
5. 以文件第一条非空文本为 oracle，要求模型只原样返回且不执行内容；回答必须匹配，并有成功 MCP read 审计，使用数变为 1。
6. 读取范围外 `D:\CodeBuddy\Cargo.toml` 必须被拒绝。
7. 关闭后重问不得调用 MCP；重新开启并重启 Electron 后配置恢复。
8. 测试后文件哈希、大小、修改时间不变，审计无 write/move/delete。

```powershell
cd D:\CodeBuddy\ui\desktop
pnpm exec playwright test tests/e2e/toolbox-mcp-filesystem.spec.ts --workers=1 --retries=0
```

随后从修改源码执行 `pnpm run start-gui`，在可见 Electron 窗口用真实鼠标键盘重复连接、提问、停用、重启和恢复，保存截图和安全化证据。

## 阶段 10：完整门禁

```powershell
cd D:\CodeBuddy
cargo fmt --all -- --check
cargo test -p goose-sdk-types --jobs 1
cargo test -p goose --jobs 1
cargo build --workspace --jobs 1
cargo clippy --all-targets --jobs 1 -- -D warnings
just check-acp-schema
cd ui\desktop
pnpm run test:run
pnpm run typecheck
pnpm run lint:check
pnpm run format:check
pnpm run test-e2e -- --workers=1
cd ..\..
.\target\debug\goose.exe run --recipe goose-self-test.yaml
```

最终从修改源码重建并启动 Electron，验收六个主入口、旧路由、工具箱四分区、常用/自动任务、设置持久化和真实 MCP。报告逐项标记 PASS/FAIL/NOT RUN；环境、下载、账号或模型阻塞单独说明，不冒充完成。
