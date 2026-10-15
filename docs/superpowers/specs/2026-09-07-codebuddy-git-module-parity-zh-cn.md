# CodeBuddy Git 模块对齐设计（简体中文）

**状态：** 分阶段实现中
**日期：** 2026-09-07

[繁體中文（預設）](2026-09-07-codebuddy-git-module-parity-zh-tw.md) · [简体中文](2026-09-07-codebuddy-git-module-parity-zh-cn.md) · [English](2026-09-07-codebuddy-git-module-parity-en.md)

## 目标

使用系统 Git、现有凭据管理器和 CodeBuddy 的 ACP 权限层快速补齐日常版本控制，不自行重写 Git 传输、认证或对象数据库。

## 与 Codex 公开行为的比较

根据 OpenAI 公开文档，Codex 的 Code review 可以查看工作区、暂存区、提交和分支差异，并提供暂存、还原、提交和推送；本地任务也可使用 Git worktree 隔离。这些是可观察的产品契约，不代表其私有实现。

- 采用：明确的差异范围、分支操作、逐路径暂存/取消暂存、推送前预览，以及 worktree 隔离方向。
- 保留 CodeBuddy 设计：Rust 主机执行无 shell 的 Git 参数向量；ACP 注册表决定只读、工作区写入、外部写入和高风险权限。
- 拒绝：猜测远程分支、静默 stash/reset、跳过预览的破坏性还原，以及在游离 HEAD 上提交或拉取。

参考：

- <https://learn.chatgpt.com/docs/code-review>
- <https://learn.chatgpt.com/docs/environments/git-worktrees>
- <https://git-scm.com/docs/git-restore>
- <https://git-scm.com/docs/git-merge>
- <https://git-scm.com/docs/git-rebase>
- <https://git-scm.com/docs/git-cherry-pick>
- <https://git-scm.com/docs/git-revert>

## 第一批垂直切片

- `git_branch_create`：从当前 `HEAD` 创建并切换到经 Git 验证的本地分支，可修复游离 HEAD。
- `git_branch_switch`：只切换到已存在且精确匹配的本地分支，不自动猜测远程。
- `git_unstage`：只取消暂存用户明确指定的相对路径，不改变工作区内容。
- 桌面 Git 面板提供分支选择、新分支输入和逐文件取消暂存；所有操作完成后重新读取仓库状态。

## 第二批垂直切片

- `git_restore_preview`：只接受明确的仓库相对路径，拒绝未跟踪或冲突路径，并在界面截断显示前，用 SHA-256 将规范化工作区和完整二进制差异绑定成预检凭据。
- `git_restore`：执行 `git restore --worktree -- <paths>` 前立即重新计算该凭据；过期预览无法丢弃后续编辑，暂存区内容也保持不变。
- 桌面 Git 面板显示精确路径和差异，明确提示破坏性后果，并同时要求面板内确认与 ACP 高风险权限批准。

## 第三批垂直切片

- `git_repository_snapshot`：通过单个只读 ACP 调用并行读取状态、冲突、分支、工作区差异和暂存区差异，避免同一会话被五次工具初始化与生命周期锁串行化。
- `git_conflicts`：显示 merge、rebase、cherry-pick 或 revert 的进行中状态与未解决路径；本阶段只开放 merge 写操作。
- `git_conflict_continue`：仅在 merge 已无未解决冲突时执行非交互式 `git merge --continue`；冲突解决文件仍需用户明确暂存。
- `git_conflict_abort_preview` 与 `git_conflict_abort`：先展示受影响路径及完整工作区/暂存区差异，再将工作区、HEAD、merge 标记、状态和完整差异绑定为 SHA-256 凭据；状态一旦变化，旧预览立即失效。
- 桌面 Git 面板在冲突期间禁用分支、同步、普通提交和普通还原，但保留暂存/取消暂存以完成冲突解决；中止 merge 需要面板二次确认与 ACP 高风险权限批准。

## 第四批垂直切片

- `git_conflict_continue` 现在接受与当前状态完全一致的 merge、rebase、cherry-pick 或 revert；仅在所有未合并条目均已解决并暂存后，调用 Git 原生的非交互式 `--continue`。
- `git_conflict_abort_preview` 将完整工作区/暂存区证据与操作专属 Git 状态（`MERGE_HEAD`、rebase 状态目录、`CHERRY_PICK_HEAD`、`REVERT_HEAD` 及 sequencer 数据）共同纳入哈希。即使工作区未变化，只要 rebase 计划等操作状态变化，旧凭据也会失效。
- `git_conflict_abort` 重新计算凭据后才调用匹配的原生 `--abort`，并保留无关的未跟踪文件。桌面面板开放相同四种操作，并显示对应确认文案；未知冲突状态仍保持只读。
- continue 与 abort 仍是受保护的 ACP 写操作；abort 继续同时要求面板确认和宿主高风险权限批准。

## 第五批垂直切片

- `CodeProRunState.workspace` 现在持久化带 schema 版本的工作区权限描述，明确记录模式、生命周期、源路径、执行路径、修订号、可选 Git 身份，以及强类型 apply/discard 恢复日志。
- 历史 JSON 缺少描述字段时，只保守迁移为不含 Git metadata 的 `direct_legacy`。模式与 metadata 不匹配、空路径、零修订号、无效哈希及状态路径不一致都会校验失败。
- 保存运行状态和 checkpoint 前会先规范化描述；投影只暴露有界的生命周期与身份字段，不暴露恢复日志内容。
- 本切片尚不创建 worktree，也不改变执行路由。现有直接执行继续明确标记为 legacy，直到完成并验证发现、创建、所有权校验与重开。

## 第六批垂直切片

- `git_runtime_status` 现在会在桌面端加载仓库状态前执行有时限、可取消的 `git --version` 检测，并返回可用状态、经过校验的版本信息和对应平台的 `git-scm.com` 官方安装页面。
- 未检测到 Git 时，仓库面板会在执行任何仓库命令前停止，询问用户是否下载 Git，并要求再次明确操作后才打开经过校验的官方下载页面。安装完成后需重启 CodePro，使新进程获得更新后的系统 PATH，并在启动时重新检测。
- 本切片不会静默下载安装包、执行安装器或调用包管理器；系统安装仍由用户控制。
- OpenAI 已发布的 Codex 文档没有说明自动安装 Git 的行为，只明确要求在用户范围内自主推进，并为破坏性或不可逆操作保留批准边界。CodeBuddy 采用该确认边界，不推测 Codex 私有安装逻辑：https://developers.openai.com/api/docs/guides/latest-model

## 第七批垂直切片

- `github_runtime_status` 将 GitHub CLI 与 Git 分开检测，然后执行官方的非交互式 `gh auth status --active --hostname github.com` 检查；执行时间有上限，结果不输出令牌。
- 仓库面板区分 GitHub CLI 未安装、已安装但未登录和已连接三种状态。缺少 `gh` 不会阻断普通 Git 的 fetch、pull、push 或 clone，只会把后续 PR、Issue 功能标记为未就绪。
- 前端桥接只接受固定的 `github.com` 主机、`https://cli.github.com/` 安装地址和 `gh auth login --hostname github.com --web` 登录命令，拒绝后端替换命令或链接。
- 这与 Codex 的公开行为一致：其代码审查文档明确说明 PR 上下文需要 GitHub CLI 和 `gh auth login`；GitHub CLI 手册将 `gh auth status` 定义为认证状态检查。

参考：

- <https://learn.chatgpt.com/docs/code-review>
- <https://cli.github.com/manual/gh_auth_status>
- <https://cli.github.com/manual/gh_auth_login>

## 第八批垂直切片

- 现有 GitHub 交付链路已经提供 Pull Request 状态、必要检查、有边界的本地预检，以及经过明确确认的 Pull Request 创建。本批直接复用该链路，不再新增第二套 GitHub 后端。
- 仓库与 Pull Request 面板现在共用恢复操作。缺少 `gh` 时，只有经过界面内确认才会打开固定的官方下载页；`gh` 未登录时，只复制固定登录命令，并要求用户在终端完成授权后刷新。
- CodeBuddy 不会静默安装 GitHub CLI、在后台启动交互式认证，也不会捕获凭据。剪贴板或浏览器失败会明确显示，并可安全重试。
- Codex 的公开代码审查契约要求使用 GitHub CLI 和 `gh auth login` 获取 Pull Request 上下文。CodeBuddy 采用该公开前提，同时在安装和凭据边界保留用户的明确控制。

## 第九批垂直切片

- 交付面板只为打开状态的 Pull Request 提供关闭操作，只为已关闭的 Pull Request 提供重新打开操作；已合并的 Pull Request 保持只读。
- 最新预检会把规范 GitHub 仓库、当前分支、Pull Request 编号、标题、URL、基础分支、当前状态和目标状态绑定成 SHA-256 凭据。执行阶段会在共享交付写锁内重新检查，并拒绝过期或被替换的凭据。
- 后端只调用固定参数向量 `gh pr close <number>` 或 `gh pr reopen <number>`。关闭操作绝不传入 `--delete-branch`；超时、取消、输出超限或非零退出都会报告为远程结果不确定，要求检查 GitHub 后再重试。
- 桌面端要求用户主动打开对话框、运行状态预检并进行第二次确认，才会写入远程。自动化测试和桌面验收不会改动真实 Pull Request。
- 本实现采用 Codex 公开可观察到的模式，把 Pull Request 上下文保留在审查工作流中，并以 GitHub CLI 公开契约执行变更；不推测 Codex 私有实现。

参考：

- <https://learn.chatgpt.com/docs/code-review>
- <https://cli.github.com/manual/gh_pr_close>
- <https://cli.github.com/manual/gh_pr_reopen>

## 第十批垂直切片

- 打开或已关闭的 Pull Request 可以编辑标题与正文；已合并的 Pull Request 继续保持只读。
- 更新流程要求用户打开编辑对话框、修改内容、运行最新预检并第二次确认。预检把工作目录、规范 GitHub 仓库、当前分支、Pull Request 编号、旧/新标题与正文、状态、URL 和基础分支绑定为 SHA-256 凭据。
- 执行阶段在共享交付写锁内重新读取 Pull Request，并拒绝无效、无变化、被替换或已过期的凭据。后端只调用固定参数向量 `gh pr edit <number> --title <title> --body-file -`，正文仅通过 stdin 传递，不经过 shell 或命令行参数。
- 超时、取消、输出超限或非零退出都会报告为远程结果不确定，要求检查 GitHub 后再重试。自动化测试不修改真实 Pull Request。
- 本实现沿用 Codex 公开可观察到的 Pull Request 上下文与确认式工作流，不推测 Codex 私有实现。

参考：

- <https://learn.chatgpt.com/zh-Hans/docs/code-review>
- <https://cli.github.com/manual/gh_pr_edit>

## 第十一批垂直切片

- Issue 面板通过固定且有边界的 GitHub CLI 参数列出最多 20 条打开或已关闭的 Issue，并把每个返回 URL 绑定到当前的规范 GitHub 仓库。
- 创建、编辑、关闭和重新打开都要求最新 SHA-256 预检与第二次确认。执行阶段会在与 Pull Request 共享的远程写锁内重新读取仓库和 Issue，拒绝无效、无变化、被替换或过期的预检。
- 标题只以固定参数传给 `gh`，正文仅通过 `--body-file -` 的 stdin 传递。超时、取消、输出超限或非零退出一律视为远程结果不确定，界面会停止后续写入，直到用户在 GitHub 检查结果。
- 这完成本版合并候选的 GitHub Issue 范围。Codex 公开文档承诺审查、暂存、还原、提交、推送和 PR 上下文，没有把 PR 评论、审查者管理或草稿切换列为核心 Git 工作流；因此这三项保留为合并后增强，不作为本版门槛。

参考：

- <https://learn.chatgpt.com/zh-Hans/docs/code-review>
- <https://cli.github.com/manual/gh_issue_list>
- <https://cli.github.com/manual/gh_issue_create>
- <https://cli.github.com/manual/gh_issue_edit>
- <https://cli.github.com/manual/gh_issue_close>
- <https://cli.github.com/manual/gh_issue_reopen>

## 合并候选范围

1. 普通 Git 传输继续使用系统 Git；GitHub CLI 只负责认证、Pull Request 和 Issue。
2. 所有 GitHub 写操作都需要最新预检、明确确认和不确定结果的失败关闭处理。
3. Pull Request 评论、审查请求和草稿状态切换列入合并后增强，不阻挡本版候选。
