# 常用任务、技能和自动任务的 Harness 接入

本批源码位于 `D:\CodeBuddy-v1`，基线见 `source-baseline.json`。该目录没有 Git 仓库，未创建分支、提交或推送。本批保持 renderer 文件冻结，只增加宿主兼容模块和隔离回归测试。

## 实现和事实归属

- `runtime/library.mjs` 保存真实 YAML 常用任务、技能文件和 Agent 模板。常用任务支持解析、保存、更新、删除、链接编码/解码、斜杠命令；自动任务时间直接读取 `state.schedules`，没有第二套调度状态。Agent 模板支持全局/项目范围的读写、导入和导出。
- 技能的全局目录为 `store.directory/harness/agents/skills`，项目目录为 `<project>/.agents/skills`。发现复用官方 `FileSystemSkillProvider`；成功写入后调用 `driver.refreshSkills()` 使 Harness 重新发现技能。创建、编辑、启停、本地导入、复制、删除恢复使用现有管理接口。删除需要原前端反向 ACP 确认和匹配 nonce；恢复使用持久化副本。预览绑定连接、五分钟过期、单次消费，并检查文件身份及包含附属文件的内容版本。
- `runtime/recipe-execution.mjs` 的 `prepareRecipe(library, meta, sessionId, connection)` 只准备会话，不调用模型。原 `session/recipe/request-params` 表单提供参数；取消返回 `recipe_params_cancelled`。支持 ID、分享链接和调度保存的配方快照，渲染提示词、指令、模型设置及扩展参数。文件参数需要用户显式提供路径，不接受默认路径，最多读取 1 MiB UTF-8 内容。
- `settings.max_turns` 以正整数限制传入 Harness，优先于全局轮数设置；达到上限是可继续执行的暂停边界。HTTP 扩展的 `envs`、`env_keys` 合并后替换 URI 与请求头中的 `$NAME` / `${ NAME }`；显式 `envs` 优先，一次替换，不写入进程环境。会话扩展定义随原有密钥保护机制保存，缺失变量、无效 URL 返回不含实际密钥的错误。
- 参数模板复用 Nunjucks 3.2.4。官方说明其自身不提供模板沙箱，因此只有正向 AST 白名单通过后才交给编译器：标量参数、条件、单层有界循环和纯文本过滤器。禁用属性访问、函数调用、宏、导入及文件加载器，拒绝未知参数；编译前估算输出上限，渲染后再次限制 1 MiB。该限制不是操作系统沙箱。
- `runtime/schedules.mjs` 的 `ScheduleService` 是自动任务运行记录和状态的唯一写入者。复用官方 `@deepseek-ai/dsh-schedule` 的五字段 cron 与时区/DST 计算；仅把原 UI 的字面量零秒六字段格式转成五字段。支持 CRUD、运行、暂停/启用、检查、取消和会话历史。`run(job,{signal,onSession})` 由兼容层接到统一 Harness 会话入口，必须先保存 `onSession(id)`，再执行提示词并返回结构化完成或取消结果。
- 新建默认暂停；显式 `paused:false` 沿用请求语义。成功运行才设置 `tested:true`，启用需要成功记录。失败或取消后暂停。重启发现运行中任务时标记 interrupted，未验证任务保持暂停；从当前时间计算下一次，不自动重放错过的任务。同一任务同时只允许一个运行。
- 项目范围的 `sources` 同时接受原 UI 的 `projectId` 和显式 `projectDir`，通过 `WorkspaceService` 的项目记录解析目录；未知或多目录项目缺少明确选择时返回错误，不回退写入全局目录。自动任务的扩展定义使用宿主凭据保护，状态 JSON 及日程 YAML 投影不重复保存明文扩展。用户主动保存的原始常用任务 YAML 仍是普通文件，其中直接填写的密钥不属于加密存储。

## 验证范围

以下命令均使用既有 Node.js 24，退出码 0：

- `node --test runtime/tests/library.test.mjs runtime/tests/recipe-execution.test.mjs runtime/tests/schedules.test.mjs runtime/tests/session-extensions.test.mjs`：29/29 通过。临时真实目录与原 SDK DTO 验证覆盖参数取消、模板属性/调用绕过、文件读取、技能确认及恢复、版本冲突、日程排重/取消/失败/重启、扩展凭据保护、保存前高级字段校验、轮数及 HTTP 环境变量合并规则。
- `node --test runtime/tests/library-compat-integration.test.mjs`：5/5 通过。真实 WebSocket ACP 覆盖参数表单、模型/工具选择、项目引用及取消；配方轮数实际传入驱动。日程“立即运行”经过官方 Harness 与受控 HTTP 模型，确认一个会话及完成记录。HTTP 环境变量测试通过官方 Harness 连接真实本地 MCP，检查 URI、鉴权请求头及文件中没有明文令牌；没有调用外部模型。
- `node --test --test-name-pattern="step limit is a resumable bound" runtime/harness/test/capabilities.test.mjs`：1/1 通过。官方 Harness 达到轮数上限后返回 `max_turns`，提高上限后继续至 `end_turn`。

默认工作区另有 14 项通过记录，见默认工作区三语说明。这些独立批次的数字不代表完整应用覆盖率。

这些属于后端合同自动验证。真实桌面交互、真实模型长任务、macOS 验收及完整首版验收由集成批次独立记录；本批没有控制或关闭用户当前桌面进程。

## 明确保留的边界

技能远程下载与本地导入均已连接，新增验收见 2026-10-14-skill-download.zh-CN.md。复杂配方的 `retry`、`sub_recipes`、结构化 `response.json_schema` 尚未连接。常用任务保存与自动任务创建会先拒绝这些字段，返回精确字段名，原文件保持不变；已有配方仍可解析、查看及导出，执行前同样明确拒绝，不会静默忽略。

原 UI 的 JSON 输出格式与子配方是可见的高级选项：`RecipeFormFields.tsx` 的高级面板包含 JSON Schema 编辑器与 `subRecipes` 编辑器，`CreateEditRecipeModal.tsx` 将它们写入 DTO。新配方默认折叠该面板、这两个字段为空；普通标题/说明/指令路径不受影响。`retry`、`settings.max_turns` 没有独立表单项，导入配方及编辑时保留的设置仍可携带它们。`RecipeExtensionSelector.tsx` 会传递 HTTP `envs`，现已实际消费。自动任务表单通过文件或分享链接选取配方，因此创建时使用同一执行校验。

非零秒/七字段 cron、HTTP socket 扩展配置尚未支持。技能与工作区的文件身份检查不提供持续的 OS 目录句柄锁。上述高级选项仍属于全部功能目标中的待完成范围。

参考：[Nunjucks API 与模板安全说明](https://mozilla.github.io/nunjucks/api.html)、[Nunjucks 模板语法](https://mozilla.github.io/nunjucks/templating.html)、[YAML 文档](https://eemeli.org/yaml/)、[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。复用现有 YAML 与官方 Harness 包；Nunjucks 依赖由主集成任务统一安装和维护。没有恢复旧 Agent 执行核心。
