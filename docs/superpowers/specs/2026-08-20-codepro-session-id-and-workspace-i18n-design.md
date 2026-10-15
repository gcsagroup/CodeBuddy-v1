# CodePro 会话 ID 与工作区国际化修复设计

日期：2026-08-20  
状态：用户已批准方案 A，等待书面规格复核  
范围：CodePro 新会话 ID 分配、失败回滚、工作区设置流程国际化

## 1. 问题

当前 CodePro 新会话 ID 只根据 `sessions.db` 中当天仍存在的会话计算。历史会话记录被删除后，持久化运行证据目录仍会保留。数据库可能重新分配一个已存在于 `runs` 目录中的 ID，例如 `20260820_1`。

CodePro 为新逻辑运行创建 `external-http-attempt-budget.json` 时使用禁止覆盖的原子写入。该保护是正确的，但重用 ID 会使创建操作在 Windows 上以 `os error 183` 失败。失败清理删除刚创建的数据库记录，下一次又分配同一 ID，形成稳定失败循环。

此外，root-container 会话不消费 workspace lease，但当前失败清理仍会尝试回滚 lease，产生误导性的 `failed session workspace lease is missing` 次级错误。

工作区设置流程还存在两套文案机制：`CodeProHub` 中有硬编码英文字符串，`workspaceConfirmationCopy(locale)` 只区分中文和英文。结果是界面选择中文或其他语言后，取消、重试和错误提示仍可能显示英文，且错误字符串一旦存入 React state，切换语言不会重新格式化。

## 2. 目标

1. 新会话 ID 不得与数据库记录或持久化运行证据目录冲突。
2. 不删除、不覆盖、不重置历史运行证据或 HTTP 尝试预算。
3. root-container 和 unbound 会话失败时不得回滚不存在的 workspace lease。
4. CodePro 工作区检查、确认、取消、重试、状态和错误文案全部跟随当前 locale。
5. 错误显示期间切换语言，现有提示必须立即使用新语言重新渲染。
6. 保持当前 `YYYYMMDD_N` 会话 ID 格式及现有安全写入策略。

## 3. 非目标

- 不改变历史证据保留策略。
- 不把会话 ID 改为 UUID。
- 不放宽 `persist_noclobber` 或预算授权约束。
- 不清理当前用户的 `runs`、会话数据库或配置。
- 不重构无关的会话存储、Provider、调度或工作树逻辑。

## 4. 后端设计

### 4.1 会话 ID 分配

在现有 `BEGIN IMMEDIATE` 数据库写事务持有期间：

1. 计算数据库中当天 `YYYYMMDD_N` 的最大合法数值后缀。
2. 枚举 `Paths::runs_dir()` 的直接子目录，只接受严格匹配当天前缀且后缀为正整数的目录名。
3. 忽略其他日期、非法名称、文件和不可解析后缀。
4. 取数据库最大值和磁盘最大值中的较大者，加一生成新 ID。
5. 使用该 ID 插入会话记录并提交事务。

数据库写事务继续序列化共享数据库上的正常创建操作；磁盘扫描避免复用已经脱离数据库但仍受证据保留策略保护的 ID。HTTP 预算文件仍以禁止覆盖方式创建，作为最终 fail-closed 防线。

读取 `runs` 目录失败时不得退回数据库单源分配，否则可能再次覆盖历史身份。新会话创建应返回不包含敏感路径的稳定错误。

### 4.2 失败回滚

新会话创建流程显式跟踪 workspace lease 是否已消费并成功绑定：

- `writable_project`：只有实际绑定成功后，失败清理才回滚 lease。
- `root_container`、`unbound`、普通会话：不调用 workspace lease rollback。
- HTTP 预算在成功创建后若后续步骤失败，沿用现有 CodePro state 清理合同；在预算创建前失败时不删除历史 state。

错误聚合只报告真实发生的清理失败，不生成虚假 orphan 警告。

## 5. 前端国际化设计

### 5.1 单一消息源

将 `CodeProHub`、`WorkspaceConfirmationCard` 和 `workspaceConfirmationCopy` 中所有用户可见工作区设置文案迁移到现有 `defineMessages` / `react-intl` 消息体系，包括：

- 工作区检查、候选状态和执行边界；
- 确认、确认容器、取消、正在启动；
- 取消后的说明和重试按钮；
- 目录选择、检查、权限、身份和启动错误；
- 已保存工作区的检查、失配和不可用提示。

`workspaceConfirmationCopy(locale)` 的手工中英文分支在迁移完成后删除，避免形成第二套 locale 规则。

### 5.2 响应当前语言

React state 不保存已格式化字符串。设置错误保存为受限的语义 key；结构化后端诊断码也映射到语义 key。渲染阶段调用 `intl.formatMessage`，因此 locale 改变时现有提示会自然重新渲染。

未知后端错误继续使用路径安全的通用文案，不把内部路径、预算状态或原始异常暴露到 UI。

### 5.3 Locale 完整性

所有当前发布的 locale 目录必须包含新增 key，并通过现有占位符一致性检查。英文作为 source catalog；其他语言不得缺 key。简体中文验收必须确认截图中的取消提示和重试按钮为中文。

## 6. 测试设计

### 6.1 Rust

1. 数据库当天无会话、临时 `runs` 目录已有 `_1` 到 `_5` 时，新会话 ID 为 `_6`。
2. 数据库最大值高于磁盘最大值时，使用数据库最大值加一。
3. 磁盘最大值高于数据库最大值时，使用磁盘最大值加一。
4. 非法目录名、其他日期和普通文件不参与分配。
5. `runs` 目录不可读取时失败关闭，不创建数据库会话。
6. root-container 的预算创建失败不得调用不存在的 workspace lease rollback，也不得报告虚假 orphan。
7. writable-project 已绑定 lease 的后续失败仍执行既有回滚。

### 6.2 Desktop

1. 中文 locale 下，工作区取消提示和重试按钮显示中文。
2. 中文 locale 下，检查、确认、状态和安全错误不混入硬编码英文。
3. 错误已显示时切换 locale，提示立即切换。
4. 英文 locale 保持既有英文语义。
5. 未知后端异常仍被路径安全的本地化通用消息替代。
6. 现有 launch intent 在取消和重试后完整保留。

### 6.3 验证顺序

1. 运行新增 Rust 聚焦测试。
2. 运行 `CodeProHub` 和工作区确认组件聚焦测试。
3. 运行全部 locale catalog 完整性检查、i18n 提取一致性检查和 TypeScript typecheck。
4. 按项目要求运行相关 Rust/desktop 门禁；未运行项明确标记 `NOT_RUN`。
5. 重建开发后端并启动 Electron。
6. 在真实窗口中复现：选择磁盘根容器、取消、重试、创建会话、切换语言。
7. 核对新 ID 避开已有 `runs` 目录，历史证据文件 SHA 不变。

## 7. 预计源码 write set

- `crates/goose/src/session/session_manager.rs`
- `crates/goose/src/acp/server/new_session.rs`
- `ui/desktop/src/components/codepro/CodeProHub.tsx`
- `ui/desktop/src/components/codepro/CodeProHub.test.tsx`
- `ui/desktop/src/components/codepro/WorkspaceConfirmationCard.tsx`
- `ui/desktop/src/components/codepro/workspaceConfirmationCopy.ts`（完成迁移后删除）
- `ui/desktop/src/i18n/messages/*.json`
- 仅当测试职责无法放入现有测试模块时，新增同目录聚焦测试文件

这些路径当前包含既有未提交改动。实施必须在当前字节上做最小增量，不重置、不覆盖、不格式化无关区域、不使用 `git add .`。

## 8. 完成标准

- 已保留的运行目录不会阻止新 CodePro 会话创建。
- 新会话 ID 在数据库和磁盘证据命名空间内均唯一。
- 历史预算和运行证据未被删除、覆盖或修改。
- root-container 失败不再产生缺失 lease 的次级错误。
- 工作区设置流程全部跟随当前语言，运行时切换语言也立即生效。
- 聚焦回归测试、i18n 校验、typecheck 和真实桌面复现均有明确结果。
- 任何未执行的正式 build、package、VM 或发布门禁保持 `NOT_RUN`，不因聚焦测试通过而升级结论。
