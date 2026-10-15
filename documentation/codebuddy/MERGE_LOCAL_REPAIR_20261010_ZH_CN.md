# 本地功能融合与失败修复验收记录

## 范围与源码

在主目录 `D:\Users\jiangrui\Desktop\CodeBuddy` 的 main 上完成同事分支融合，基线合并提交为 `b05b297d10e8e7c02160d37c65875108d47b3d42`。用户确认合并前未提交的本地功能也属于本轮范围。原 stash `442a5495fdafcd7b016608782c81d5a785508ee4` 和逐文件备份保留。本文记录当前融合源码的验证，不引用旧二进制作为验收证据。

## 功能融合与修复

- 逐文件三方融合 Git MCP、GitHub 登录/退出、macOS 构建与运行边界、设置和工作区功能；保留 main 的新版完成检查、暂停回答、流式消息顺序和当前活动投影。
- 按用户批准的设计修复失败后的复测：原失败节点及精确证据保存在历史计划中，新修复/复测任务承担验收。历史 RecoveryEvidence 不成为可执行依赖，不授予权限；同一 DAG/run 身份、原合同、结构化失败证据和重试上限继续校验。
- 归档保留原行动预算并清理当前任务映射；共享进程 owner 使用既有 runtime 登记表，支持跨跟踪器终止。
- 负数 token 用量显示为未知，避免误报为零；暂停回归验证主 Agent 使用宿主已提交事实回答，且不提供执行工具。
- 修复旧编译中文消息目录造成的 GitHub 提示不一致。15 个语言目录校验通过；新增繁体文案补齐，其他语言的新键使用英文回退，尚未进行翻译品质验收。

## 当前源码自动化验收

所有下列最终命令退出码为 0。命令在主目录执行，前端命令在 `ui/desktop` 执行；具体工具链和完整输出保存在本地证据目录。

| 项目 | 命令/目标 | 最终结果 | 日志 |
| --- | --- | --- | --- |
| 后端相关回归 | `cargo test -p goose --lib --jobs 1 --offline -- agents:: acp:: context:: permission:: --test-threads=2` | 2212 通过，3 忽略 | fusion-rust-final-3.log |
| 上下文压缩 | `cargo test -p goose --lib --jobs 1 --offline -- context_mgmt:: --test-threads=2` | 18/18 | fusion-context-final.log |
| 运行时集成 | `cargo test -p goose --test codepro_runtime --jobs 1 --offline -- --test-threads=2` | 18/18 | fusion-runtime-integration-final.log |
| Rust 检查 | `cargo clippy -p goose -p goose-providers -p goose-provider-types -p goose-sdk-types --lib --jobs 1 --offline -- -D warnings` | 通过 | fusion-clippy-final.log |
| 前端全量 | `vitest run --maxWorkers=1` | 2307 通过，4 跳过 | fusion-vitest-final.json |
| 真实 Edge 浏览器 | 现有 streaming 与 scroll-area 浏览器用例 | 17/17 | fusion-browser.log |
| Git MCP | 隔离真实本地仓库 | 4/4 | fusion-git-mcp.log |
| 发行/macOS 脚本 | 现有打包与发行测试 | 54/54 | fusion-distribution.log |
| 根启动脚本 | 现有启动测试 | 2/2 | fusion-root-launcher.log |

TypeScript、83 个改动文件的 ESLint、消息目录检查通过；新增启动诊断日志后再次运行 TypeScript 和 main.ts ESLint，均通过。恢复链路专项 273/273 通过，覆盖历史证据、重复失败、重试上限和恢复相关边界。首轮失败记录保留，最终结果以上表为准。

## 真实桌面盲测

通过项目 `pnpm run start-gui-debug` 启动当前源码 Electron 和后端。在真实界面提交安全整数账单修复任务，未向 Agent 提供参考实现；只允许操作隔离工作区 `D:\test-codebuddy-merge-20261010`。

- 会话 `20261010_4`，run `run_eaf9d891-e415-47e0-af48-9184ee8d5f24`。
- Agent 自行检查、复现、修复 `invoiceTotal`，补充边界测试，实际运行 `node --test`：16/16 通过。
- 外部独立检查修复前 18/22、修复后 22/22，退出码从 1 变为 0。原有 9 项测试内容保留，用户草稿 SHA-256 不变。
- 宿主返回结构化 `completion_accepted`；持久化终态为 `completed`，不是依据模型自述判定。
- 实际文件树与源码预览正常；重新加载界面后仍显示同一会话的完成结果，未残留旧暂停状态。
- 临时 shell 权限已按原文件逐字节恢复，SHA-256 为 `c2271237f1414d0583e44a092c3e5e6a10c4b61368f1c9f747014ef798f6b6a3`。

完整输出：`desktop-fusion-current-session.json`、`desktop-fusion-summary.txt`、`desktop-fusion-fixture-after.log`、`invoice-independent-after.log`。本地证据目录：`D:\CodeBuddy\.cargo\merge-codebuddy-20261010`，不提交会话、日志、profile 或凭据。

## 边界与交付

暂态命令会话启动曾无窗口退出；改为持久隐藏 PowerShell 启动同一项目入口后完成桌面验收。现有证据支持启动会话生命周期干扰的判断，未把未确认原因写成产品崩溃。

macOS 真机、安装包安装和所有电脑控制场景未在本轮逐项实测，脚本通过不代表这些场景已通过。桌面盲测证明当前 Windows 编码任务及完成持久化链路；历史失败归档边界由自动化测试验证。提交与推送结果以本轮最终 Git 回执为准。
