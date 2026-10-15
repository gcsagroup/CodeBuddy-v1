# 自然语言长期偏好路由失败分析

日期：2026-09-12
状态：只读审计完成，尚未实施修复
验收证据：`D:\CodeBuddy\.cargo\evidence\memory-candidate-native-20260912-resume\acceptance-status.md`

[繁體中文（默认版本）](2026-09-12-memory-natural-routing-failure-analysis.md) · [English](2026-09-12-memory-natural-routing-failure-analysis.en.md)

## 1. 结论

这不是单纯的模型随机偏离。可以分成两个层次：

1. **确定性的路由缺陷**：用户明确说“请明确记住一项长期用户偏好”，但 `is_project_memory_management_request` 不识别“长期用户偏好”，因此没有进入记忆专用执行路径。
2. **模型相关的具体表现**：后续 `qwen3.5:397b` 把请求分类为 `ComplexChange`，规划并创建了 `goose/preferences.yaml`。其他模型可能产生不同错误表现，但只要前置判定不修复，仍可能绕过记忆专用路径。

受控提示中直接指定 `project_memory_remember` 能成功，只证明后端工具和状态转换可用，不能替代自然语言场景。

## 2. 已验证事实

### 原始请求与模型

- 父会话：`20260912_3`。
- 原始请求：`请明确记住一项长期用户偏好：以后回答第一行使用“已确认偏好-ACT-K3M9”。本次明确允许写入长期用户偏好。`
- Provider：`custom_454541111`。
- 模型：`qwen3.5:397b`，`thinking_effort=high`，`toolshim=false`。
- 工作目录：隔离的 `project-a`。

### 实际调用链

1. `is_project_memory_management_request` 要求同时存在记忆范围词和记忆动作词。
2. 范围词包含“项目记忆、长期记忆、跨对话记忆、跨会话记忆”，但不包含“长期用户偏好”或“用户偏好”。
3. 原始请求虽然包含“记住”和“长期用户偏好”，仍返回 `false`。
4. `reply_codepro_with_intent_core` 因此没有覆盖外层意图，也没有启用 `codepro_project_memory_management()`。
5. 记忆专用路径原本会只保留 `project_memory_*` 工具，并追加“不能用工作区文件代替记忆”的系统说明；本次没有进入该路径。
6. 外层模型把请求作为 `ComplexChange` 拆成 planner、coder、tester 和报告会话。
7. 父会话没有 `project_memory_remember` 请求；子会话只使用了 `tree`、`write`、`read_document` 和 `shell`，最终创建 `project-a\goose\preferences.yaml`。

### Scope 与存储结果

- 失败场景没有写入 Project Memory，所以没有可讨论的实际 memory scope。
- 创建的是项目本地文件，语义上错误地变成 project scope。
- 受控重试明确调用 `project_memory_remember`，使用 `scope=user`、`user_confirmed=true` 后成功写为 `source=user_explicit`、`status=active`。
- 候选、激活、跨项目召回和重启持久化的后端验收均通过；自然路由仍为失败。

## 3. 提示与工具设计中的第二个问题

即使只补充关键词，当前记忆专用系统说明仍写着：显式保存请求使用“current-project scope”。这与工具 schema 支持的长期用户偏好不一致。

工具 schema 已正确说明：

- `scope` 默认是 project；长期低风险交互偏好可以使用 user scope。
- 只有用户明确确认 user scope 时才设置 `user_confirmed=true`。

因此修复不能只增加一个关键词，还必须删除“所有显式保存都使用当前项目 scope”的误导，明确区分：

- 长期用户偏好：`scope=user`，用户本轮明确授权时 `user_confirmed=true`。
- 项目规则、项目上下文：`scope=project`。
- AI 自动推断的低风险习惯：`scope=user`，不设置 `user_confirmed=true`，进入 candidate。

## 4. 与 Codex 公开行为对比

OpenAI 官方文档把固定指令与生成记忆分开：必须稳定执行的团队指导放在 `AGENTS.md` 或受版本控制的文档中；记忆只是辅助召回层。Codex 的本地记忆还把“允许生成记忆”和“允许在未来会话使用记忆”分成独立控制。

CodeBuddy 应采用相同边界：用户明确要求保存长期偏好时进入结构化用户记忆，不应被解释为开发一个项目配置文件，也不应静默写入 `AGENTS.md`。

公开来源：

- [OpenAI Docs：Memories](https://learn.chatgpt.com/docs/customization/memories)
- [OpenAI Docs：Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

## 5. 最小修复范围

### 必须修改

1. 扩展自然语言记忆管理判定，识别“长期用户偏好、用户级偏好、我的长期偏好”等明确 user-memory 范围表达；仍要求同时出现“记住、保存、写入”等动作词。
2. 修改记忆专用系统说明，要求模型保持用户表达的 scope，不再把所有显式保存默认成当前项目。
3. 对明确的长期用户偏好说明 `scope=user`；只有当前消息明确授权时才设置 `user_confirmed=true`。
4. 保持记忆专用工具白名单，确保这类请求看不到 `write`、`edit`、`shell`、任务拆分或子 Agent 路径。

### 暂不修改

- 不修改 Project Memory 存储格式。
- 不修改 candidate/active 状态机。
- 不增加向量数据库或新的偏好配置文件。
- 不删除失败验收产生的 `goose/preferences.yaml`，它继续作为原始证据保留。

## 6. 最小回归测试

1. **意图单元测试**：原始自然请求必须返回 memory-management；“我偏好简短回答”但没有保存动作、`保存 README.md`、一次性会话代号不得误判。
2. **路由测试**：原始请求必须进入统一记忆路径，不得创建 `ComplexChange` DAG 或子会话。
3. **工具白名单测试**：只向模型提供 `project_memory_search/remember/forget/clear/stats`，不得提供文件写入工具。
4. **提示快照测试**：明确包含 user/project scope 区分，且不再出现所有显式保存使用 current-project scope 的文字。
5. **后端集成测试**：mock provider 对原始自然请求调用一次 `project_memory_remember`；断言 `scope=user`、`user_confirmed=true`、`status=active`，并断言工作区没有新增文件。
6. **真实 Electron 回归**：原样输入自然请求，只允许一次权限；必须观察到父会话直接调用 `project_memory_remember`，没有子会话，没有 `goose/preferences.yaml` 或 `AGENTS.md`，重启后能在项目 B 自动召回。

## 7. 完成标准与预估

该缺陷应在进入下一个记忆功能前修复。最小实现预计 0.5 个工作日；包含自动化门禁和真实 Electron 回归预计 1 个工作日。只有自然语言场景通过后，才能把“明确长期用户偏好可用”标记为完成。
