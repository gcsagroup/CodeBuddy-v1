# GitHub 账户设置修复

日期：2026-10-16。目录 `D:\CodeBuddy-v1`，分支 `main`，基线 `04362df`。本批只修复账户设置，不生成安装包。

## 根因与改动

- `GitHubAuthCard` 仍请求 `_goose/unstable/github/auth/status` 等旧 Rust OAuth 方法；当前 Harness runtime 未实现这些旧方法。卡片错误与另一套 CLI 连接状态同时展示，产生截图中的红字和等待界面。
- 删除旧卡片内的 OAuth 状态机、无调用者的 `acp/githubAuth.ts` 及其专用文案；复用已有 `GitHubConnections`、Electron IPC 和官方 `gh auth login`。不恢复旧 Rust 核心，不新增 OAuth 服务；SDK 兼容 schema 保留。
- 每个账户/MCP 检查阶段有 25 秒界面等待上限，迟到结果不覆盖超时或新刷新结果。MCP 探测不阻止账户登录。该期限仅用于设置页检查，不改 Harness 工具执行超时。
- 账户状态只消费 `gh auth status --json hosts` 的验证结果，明确检查 active/state/login。JSON 模式退出 0 不代表认证成功。移除多余的第二次 `gh api user`，合并同时发生的只读查询；不缓存已完成结果，登录/退出后的验证不复用旧查询。

依据：[GitHub CLI 官方状态命令](https://cli.github.com/manual/gh_auth_status)及本机 `gh auth status --help`，该命令会实际验证账户。账户授权和凭据由 GitHub CLI 管理；GitHub MCP 仍独立配置，CLI 登录不会自动启用它或复制凭据。

## 验收与合并

- `vitest run --maxWorkers=1 src/components/settings/auth src/github`：退出 0，35 项通过；最终并发查询失效处理后重跑 `src/github`，12 项通过。覆盖卡片真实子组件、刷新、设备码发起/取消、缺少桥接、检查超时、迟到结果、登出保护和错误状态。
- `tsc --noEmit`、修改文件 ESLint、i18n 提取/全部语言校验/编译均退出 0。
- 使用 README 的 `scripts/start-harness-preview.cjs` 重新启动当前源码，在真实桌面进入“设置→账号与凭据”并刷新；实际结果与耗时见下方追加记录。
- 保留现有账户与 MCP/模型设置；没有为测试退出用户账户。新账户的浏览器授权完成流程未实测，设备流程有自动化回归；不把它宣称为一次新的真实登录。

同事完整应用本提交，重点核对账户卡片、CLI 状态检查、删除的 ACP 调用与语言文件。已有运行中的 Electron 需重启以载入主进程改动。原始证据位于本机 `.preview-evidence/h17-*`，不提交账户配置、日志或截图。

真实桌面结果：首次检查 3,974 ms，手动刷新 3,965 ms；账户已连接、MCP 已停用、旧 OAuth 错误消失。此前移除旧卡片但尚未精简重复查询的一次检查为 16,249 ms；这些是当次网络环境的观测值，并非固定延迟保证。证据 h17-ui-receipt.json / h17-ui-final.png。最终启动回执 launcher PID 50132，入口仍是当前源码预览。
