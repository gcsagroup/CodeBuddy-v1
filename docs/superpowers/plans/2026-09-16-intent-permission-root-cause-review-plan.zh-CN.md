# 意图、验证边界与报告修复计划

2026-09-16 · 简体中文

[繁體中文（預設）](2026-09-16-intent-permission-root-cause-review-plan.md) · [English](2026-09-16-intent-permission-root-cause-review-plan.en.md)

状态：阶段 A 已实施并完成其核心桌面验证，路由证据增强也已完成核心桌面验收。阶段 B 已依据 L03/L04/L05 最小差异证据获准实施当前请求的单文件范围修复，分支为 `fix/simple-change-scope-roles`。C–E 不在本次实施范围。

本文与另外两个语言版本是同一份权威计划。早期修复计划和复核归档中的有效证据、校准结论与后续阶段已合并到本文，不再维护独立旧计划。`reports/` 中的证据报告只保留一份，不复制成三种语言。

## 1. 范围和结论强度

### 当前先行项：路由证据增强

分支：`fix/intent-routing-evidence`。主轴是持续维护用户当前任务的目标、边界与变更；本项只为定位理解在哪个环节发生偏差提供证据，不实现新的任务合同或分类器。

- 复用已有 `intent_completed` 活动及其 session/run/event ID，增加可选、版本化的 `routing_evidence`；不新建日志目录。
- 来源由实际调用分支传入，区分聊天快路径、工作区约束、语义分类后的结果、检查点及文本恢复；不能事后重跑关键词推断来源。
- 记录分类结果、语义降级原因、实际执行意图及覆盖原因、目标来自已绑定的执行消息还是澄清上下文、单文件检查是否评估/匹配、最终入口路线。执行消息可能已绑定历史请求，不等同于用户刚提交的原文。
- 首批覆盖已有意图完成事件；提前工作区门禁、澄清返回及不重发前奏的恢复路径仍可能没有此事件。不得据缺失字段推断这些层已运行或已通过。Planner、权限审计与执行回执继续查各自原有证据，本项不宣称已经打通全部层。
- 新字段不进入模型上下文，不包含提示词、用户全文、代码或密钥；旧记录缺字段保持未知。桌面技术详情可读、导出与日志读写不丢字段。
- 先验证缺字段的回归失败，再验证新旧记录读写、分支真实性、事件关联和桌面行为；未完成项记为 NOT_RUN。

设计对照：[OpenAI 沙盒说明](https://learn.chatgpt.com/zh-Hans/docs/sandboxing) 将技术边界与审批策略分开。采用“分类、权限、执行事实不能混为一个结果”的原则；不照搬其权限配置、不推断 Codex 私有意图实现。当前产品可观察到的审批与命令退出码同样是独立事实。日志字段不是执行授权。

本计划只覆盖 CodePro 的意图识别、任务调度、工具调用边界与结果报告。它不修改 Computer Use、Git、Mac 或搜索模块，也不扩大 Shell、解释器或路径权限。

已确认的事实：

- P04 的编码任务成功修改 `app.js`，Tester 请求的 `node -e` 被宿主有界验证合同跳过；它不是用户主动跳过，也没有真实待审批请求。
- G03 和会话 `20260916_24` 表明，前一轮只读分析后，后续明确修改请求仍可能保留 `read_only` 意图并路由给 Planner；这属于阶段 B，不是阶段 A。
- P01 表明简单修改完成后可能没有运行必需验证；这属于阶段 C1。
- 旧 revision 中的失败证据仍在磁盘；跨 revision 汇总和重试属于阶段 E，不能用阶段 A 的单次报告修复替代。

不把相似现象强行合并为一个根因。宿主策略拒绝、用户拒绝、待审批、错误路由和验证遗漏分别处理。

## 2. 入口和调用链

桌面请求的相关链路为：

```text
用户消息
→ agent.rs 识别当前请求与约束
→ execution strategy 选择简单修改或 L2 DAG
→ task_scheduler.rs 分派 Coder / Tester 并处理工具结果
→ TaskOutput 持久化任务事实
→ result_aggregator.rs 聚合运行结果
→ codepro_terminal_report.rs 生成用户报告
→ codepro_run_result.rs / 桌面端展示终态
```

权限判断和意图路由是不同层次。正确识别“要修改”不会自动放宽命令权限；命令被策略拒绝也不能反推用户要求跳过。

## 3. 外部设计对照

依据仓库规则，本设计对照公开资料，而不推断私有实现：

- [OpenAI Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)：采用“技术边界、审批策略和执行回执分层”的原则。
- [OpenAI 模型指导](https://developers.openai.com/api/docs/guides/latest-model)：采用“从指令和先前上下文推断用户意图与任务范围”以及明确约束问题表面的原则。本阶段只把当前消息中的修改目标、保护边界和验证命令分开，不据此推断 Codex 私有解析器，也不把模型提示词当作路径授权。
- [OpenCode 权限生命周期](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/permission/index.ts)：采用 allow / ask / deny 状态明确、真实审批必须有待处理请求的思想。
- [Cline 命令拦截器](https://github.com/cline/cline/blob/82b8e1fa0471f728e3d9540fd19aa063e2049497/sdk/packages/core/src/extensions/tools/command-guard-extension.ts)：采用“跳过单个动作不等于终止整个任务”的思想。

不采用：换模型代替确定性规则、全放开解释器、复制简单黑名单、把生命周期 `completed` 机械改成 `failed`，或删除旧失败证据。

## 4. 全阶段约束

1. 修改范围来自当前请求和可核验合同；命令、示例或引用中出现路径不产生编辑授权。
2. 路由选择不授予新的 Shell 权限；现有 `node -e`、拼接命令和任意解释器边界保持不变。
3. 未执行、失败和成功是三种事实；未执行必须保留 `exit_code = null`。
4. 用户主动跳过、宿主边界、真实待审批和用户拒绝分别记录。
5. 子任务、本轮和整个运行的修改作用域分别展示。
6. 编辑完成不等于测试通过；历史成功也不能自动证明当前文件状态。
7. 旧状态缺字段时显示未知，不从模型文本推导用户授权。
8. 日志复用 session、run、task 和 tool call ID，只为错误与安全事件增加必要结构化事实。

## 5. 实施顺序

### 阶段 A：可信的 NOT_RUN 原因与报告作用域——已实施

- `TaskOutput` 增加可选、版本化的 `ValidationNotRunEvidenceV1`。
- 原因限定为 `user_requested`、`host_boundary`、`unknown`。
- 证据只能由调度器依据真实分支创建；模型文本不能填写或覆盖。
- 新报告优先读取结构化证据，旧记录缺字段时兼容读取并显示未知。
- Coder 的全局修改记录与 Tester 的局部“无修改”同时保留；静态报告标题标明任务、角色和“仅本子任务”。
- 本阶段不改变路由、白名单、审批策略或跨 revision 汇总。

### 阶段 B：当前请求的意图与约束作用域——单文件范围修复实施中

L03/L04/L05 已形成最小差异证据：单一修改目标能命中 `simple_change`；增加一个明确受保护的文件名会错误降级；两个真实修改目标应继续走普通 `change`。源码复核确认 `classify_simple_change()` 原先收集消息中所有路径，不区分其语义角色。

本次只修复单文件快速路线的确定性资格检查：按当前消息的子句和作用域标记区分编辑、保护与命令片段，仅编辑片段中的路径参与目标计数。重叠标记优先采用更长、更具体的保护表达；不确定输入仍保守回退普通路线。它不是新的通用意图分类器，也不修改语义路由、Planner、权限、白名单或审批。

回归必须覆盖 L03 的受保护文件、保护表达在前、中文“不要修改测试文件”、英文 `modify/leave unchanged`、验证命令中的路径，以及 L05 的真实多文件拒绝。实现前聚焦测试为 39 通过、2 失败；最小实现后为 41 通过、0 失败。桌面后端重建和 L03/L04/L05 重跑仍是完成门槛。

### 阶段 C1：简单修改的验证要求——待授权

让简单修改合同显式记录本轮是否要求动态验证，以及用户是否明确排除命令。编辑成功但按用户要求不验证，与遗漏必需验证必须使用不同事实。

### 阶段 C2：已执行验证的证据新鲜度——待授权

先记录实际验证事实，再根据后续写入判断结果是否过期。后续写入不能抹掉“曾执行”，旧成功也不能证明新版本。

### 阶段 D：用户可见终态——待授权

保持 wire protocol 的生命周期语义，只修正 UI 对 PASS、NOT_RUN、等待审批和恢复操作的表达。

### 阶段 E：跨 revision 历史与重试——待进一步设计

使用稳定验收标识关联旧失败、新修改和新验证；不通过任务名称或命令字符串猜测继承关系，不继承已经撤销的权限。

## 6. 阶段 A 改动范围

```text
crates/goose/src/agents/agent.rs
crates/goose/src/agents/codepro_run_result.rs
crates/goose/src/agents/codepro_terminal_report.rs
crates/goose/src/agents/result_aggregator.rs
crates/goose/src/agents/task_dag.rs
crates/goose/src/agents/task_scheduler.rs
crates/goose/tests/codepro_result_convergence.rs
crates/goose/tests/finding_candidate_contract.rs
```

没有修改锁文件、Computer Use、Git、Mac 或搜索模块。

## 7. 阶段 A 验证记录

聚焦测试：

- `task_dag::tests`：82/82 通过。
- `result_aggregator::tests`：40/40 通过。
- `codepro_terminal_report::tests`：49/49 通过。
- `codepro_run_result::tests`：17/17 通过。
- 新增的调度器来源、脱敏、混合原因和作用域测试均通过。
- `task_scheduler::tests`：185/187 通过；两个既有失败分别涉及 Python 依赖和旧 host Node 测试回执，不在阶段 A 路径。

门禁记录：

- `cargo fmt --check` 和 `git diff --check` 通过。
- `cargo clippy --all-targets -- -D warnings` 仅剩 `load_hints.rs` 三处既有 `needless_borrows`。
- 全量 `cargo test -p goose --lib --jobs 1` 在 Windows 上遇到既有 PermissionDenied 与一个栈溢出，未完成全绿。
- 桌面 `typecheck`、`lint:check` 通过；Vitest 运行未完成，`format:check` 命中大量既有格式差异。
- 按 README 重建并启动桌面后端成功；构建二进制哈希已核对一致。

真实桌面样本 `20260916_25` / `run_332218f4-8794-4fb7-8ce5-a3e5886fc6c2`：

- Coder 实际把 `app.js` 从 `hello` 改为 `hi`。
- Tester 的验证命令被宿主边界跳过，没有退出码。
- 持久化状态记录 `reason=host_boundary`、tool call ID 和原始命令。
- 最终报告保留 `app.js` 修改、显示 NOT_RUN，没有伪造 PASS 或待审批。
- 重启桌面并重新打开会话后，上述报告和文件状态仍然存在。

## 8. 已知低优先级事项

- `validation_not_run.cwd` 在该桌面样本中为 `null`，但事件和最终报告仍保存了正确项目路径。
- 可见报告写“环境问题：无”，结构化统计却把宿主边界计入 `environment_problem: 1`。
- 模型生成的静态建议出现无证据的 Node 版本猜测和编号从 2 开始的问题。

这些事项当前不影响用户判断真实执行结果，不为它们扩大阶段 A。只有出现实际 UI、统计或排障影响时再单独处理。

## 9. 后续阶段验收门槛

- 每个阶段先补可复现回归，再做最小修改。
- 运行相关 Rust/桌面测试、格式、lint 和构建门禁；既有失败单独记录。
- 重新构建后端并启动 Electron，在真实窗口验证可见结果和重启持久化。
- 未执行的验证必须明确标记，不以跳过、零匹配或静态观察冒充通过。
- 每个阶段独立评审和授权；阶段 B 不因阶段 A 完成而自动开始。
