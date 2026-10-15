# Git 面板本地写操作

日期：2026-10-14。工作目录 `D:\CodeBuddy-v1`，基于 `source-baseline.json` 中 revision `964bbeb1587f1c5551ee17907e0b26632c4163ce` 及原项目未提交文件。目标目录没有 Git 元数据；本批没有在开发目录创建分支、提交或推送。测试中的仓库、分支和提交全部属于 OS 临时目录中的独立夹具。

## 实现及合同

保留原 `ui/desktop/src/acp/git.ts` 和 `GitRepositoryPanel.tsx`。`runtime/git-extension.mjs` 复用已安装 Git CLI，以 Harness host tools 接入。`gitTools()` 公开 7 个读取工具及以下 5 个写工具；`createGitReader()` 继续只提供 7 个读取工具给 Review。许可由原宿主/Harness 链路决定。

| 原 UI 工具          | 输入        | 原 UI 回执                                |
| ------------------- | ----------- | ----------------------------------------- |
| `git_stage`         | `{paths}`   | `{staged_paths}`                          |
| `git_unstage`       | `{paths}`   | `{unstaged_paths}`                        |
| `git_commit`        | `{message}` | `{commit,branch,subject,committed_paths}` |
| `git_branch_create` | `{name}`    | `{branch,created:true}`                   |
| `git_branch_switch` | `{name}`    | `{branch,created:false}`                  |

暂存只接受状态中实际存在的显式文件路径，保留未选择文件。取消暂存使用 `git restore --staged`，要求已有 HEAD，保留工作区内容。提交只使用暂存区，回执读取 Git 产生的实际 commit。创建分支立即切换，切换只接受已有本地分支；两者均不强制覆盖未提交修改。读取和写入共享 canonical repository 队列，不跨进程声称排他；外部 Git/编辑器仍可能修改仓库，Git 自己的锁和拒绝结果继续有效。

所有命令使用固定 argv 和无 shell 的 `execFile`。路径使用 literal pathspec、`--`、仓库相对路径和实际状态校验，拒绝空列表、遍历、元数据路径、目录泛选及路径祖先链接。子进程仅继承 Git 运行需要的目录和系统环境；模型/MCP 密钥及继承的 Git 路由覆盖不会传入。错误不回显原始命令输出中的潜在密钥。

旧 `crates/goose/src/agents/platform_extensions/git.rs::run_git_with_env` 已禁用 hooks 和 fsmonitor，本实现延续该行为。只读操作禁用 external diff、textconv 和外部 clean/smudge/process。写操作遇到实际生效的外部 filter（包含目标分支属性）会明确要求使用该仓库的专用 Git 流程，不静默提交未经转换的内容；仅全局安装 LFS 而项目没有对应属性不妨碍普通操作。配置 `commit.gpgsign=true` 时明确报告签名流程待接，不自行创建无签名提交。分支属性检查使用 `git check-attr --source`，当前 Windows Git `2.55.0.windows.2` 已验证；较旧 Git 和 macOS 尚待平台验收。

## 验证和剩余范围

`git-write.test.mjs` 使用真实临时 Git 仓库、原 renderer parser 和原 SDK `zGooseToolCallResponse_unstable`，覆盖五个回执、暂存/未暂存隔离、unborn、脏分支切换拒绝、路径边界、hooks/filter/signing、同仓库并发、取消及实际子进程环境。`git-write-acp.test.mjs` 使用真实 server/WebSocket 和官方 Harness，验证裸工具名、SDK 回执、7 个面板只读调用免重复审批、5 个写操作按 `ask_before` 审批，以及 `never_allow` 和关闭 Git 扩展的否决。GitHub CLI 使用隔离空 profile；没有访问用户登录配置或发起远程 Git 写入。模型服务仅使用 loopback 夹具做接入配置校验，工具调用阶段没有模型请求。

运行入口：Node 24 `--test runtime/tests/git-write.test.mjs runtime/tests/git-extension.test.mjs runtime/tests/codepro-review.test.mjs runtime/tests/review-harness-integration.test.mjs`，19 项通过，退出码 0；另执行 `--test runtime/tests/git-write-acp.test.mjs`，1 项通过，退出码 0，含关闭/重新启用扩展后工具列表及权限保留。测试证明自动化与协议链路，不等于真实 Electron 用户流程或 macOS 验收。

`git_restore_preview/restore`、`git_conflict_abort_preview/abort/continue`、`git_pull`、`git_push_preview/push` 尚未在本批接入。原预览的快照绑定、失效及用户确认合同必须保留；没有伪造 preflight，也没有通过通用 shell 替代这些按钮。GitHub 专用 issues/PR/CI/OAuth 另列。

## 参考

使用系统已有 Git，不添加依赖或移植 Git 实现。参考 [git-add](https://git-scm.com/docs/git-add)、[git-switch](https://git-scm.com/docs/git-switch)、[git-commit](https://git-scm.com/docs/git-commit)、[githooks](https://git-scm.com/docs/githooks) 的官方 CLI 行为及本仓库原 Rust/TypeScript 合同。
