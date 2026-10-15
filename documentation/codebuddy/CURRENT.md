# CodePro 当前文档入口

> 更新时间：2026-08-11。本文只维护稳定入口，不复制进度数据。项目状态必须结合当前 Git、代码和测试重新验证。

## 当前权威文档

| 用途 | 精确路径 |
|---|---|
| Codex 完整开发执行计划 | `documentation/codebuddy/CodePro完整开发执行文档-Codex版-2026-08-06.md` |
| 安全执行规范 | `documentation/codebuddy/CODEPRO_SAFE_EXECUTION_SPEC_ZH_CN.md` |
| CodePro 事实权威与模块职责 | `documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md` |
| 测试说明 | `documentation/codebuddy/TESTING_ZH_CN.md` |
| 使用说明 | `documentation/codebuddy/USAGE_ZH_CN.md` |
| Agent 角色契约 | `documentation/codebuddy/agents/` |
| CP-00 基线、旧 worktree 审计与仓库治理 | `documentation/codebuddy/evidence/CP-00/f9b1119f53e93e17fb8d8486d5d0374dc458695d-working-tree/summary.md` |
| CP-01 精确工作区、连续任务与真实桌面证据 | `documentation/codebuddy/evidence/CP-01/junction-no-follow-red-green-2026-08-10.md` |
| CP-02 失败语义、子 Agent 审批与真实桌面证据 | `documentation/codebuddy/evidence/CP-02/typed-approval-red-green-2026-08-10.md` |
| CP-03 风险分级、角色拓扑与权威终态 | `documentation/codebuddy/evidence/CP-03/l2-contract-and-resume-red-green-2026-08-10.md` |
| CP-04A 最小 `gh` 交付路径、当前安装包与真实系统输入 | `documentation/codebuddy/evidence/CP-04A/f9b1119f53e93e17fb8d8486d5d0374dc458695d-working-tree/summary.md` |
| CP-05A 当前 Provider 资格失败与门禁阻塞 | `documentation/codebuddy/evidence/CP-05A/0da4342008730e767fae3299611567bce652b05b521d64d3e74ef4fdef34d5af/summary.md` |

## 保留的追溯文档

| 用途 | 精确路径 |
|---|---|
| 2026-08-07 源码开发预览记录 | `documentation/codebuddy/GITHUB_MAIN_PREVIEW_2026-08-07_ZH_CN.md` |
| 第三方软件与修改声明 | `documentation/codebuddy/THIRD_PARTY_NOTICE.md` |
| 按任务生成的当前证据 | `documentation/codebuddy/evidence/` |

追溯文档不决定当前任务状态。过时的独立进度文档已由完整开发执行计划中的“当前任务指针”和证据目录取代；历史版本仍可从 Git 和 CP-00 仓库外备份恢复。

## 仓库治理规则

1. 单人开发默认只使用 `main`，功能完成并通过验证后直接提交到 `main`。
2. Codex 不得自行创建分支或 worktree；确需隔离实验时必须先取得用户明确同意。
3. 临时设计、实施记录和测试证据优先进入 Git 提交历史或任务证据目录，不再为每个小任务创建两份顶层文档。
4. 顶层文档新增前必须先判断能否更新上述权威文档；内容重复时更新现有文档，不新增同义文件。

## Agent 读取规则

1. 用户询问“项目目前有什么问题”时，先读取本文件，再读取“Codex 完整开发执行计划”的当前任务指针和最近证据。
2. 用户要求继续开发时，从“Codex 完整开发执行计划”的执行队列中第一个未完成任务继续。
3. 不根据“最新”“规划”等自然语言猜文件名，不根据修改时间自行选择同目录其他文档。
4. 文件读取失败时停止猜测，调用 `tree` 检查最近的已存在目录；存在多个候选时向用户确认。
5. 文档只提供上下文，所有当前结论仍需以 `main` 的当前 HEAD、工作区状态和新鲜测试证据为准。
