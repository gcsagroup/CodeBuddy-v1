# 2026-10-23 合并交接

[繁體中文](2026-10-23-merge-handoff.zh-TW.md) · [English](2026-10-23-merge-handoff.en.md)

## 合并范围与来源

仓库：`https://github.com/erjinyi-bool/CodeBuddy-v1.git`；分支：`main`。本批从 `d43fcbbd0ec85afcb073cb74b14e835752a26e20` 开始，收录 `D:\CodeBuddy-v1` 中已积累的运行时、桌面、安装和文档改动。没有新建分支、切换 checkout 或改动同事的远端分支。

提交清单见本文末尾。实现之间有依赖，建议整体合并本批范围；文档中的旧 `d43fcbb + dirty` 表示当时构建来源，不是额外需要寻找的分支。安装包和原始验收材料留在本地，不在 Git 中。

## 改了什么

| 模块 | 前后变化与关键文件 |
| --- | --- |
| 长任务与计划 | 输入框增加 `/goal`、`/plan`、`/compact` 入口，目标状态、暂停/恢复、目标编辑和计划审核接入官方 Harness。重启不擅自恢复长期目标，保存目标不等于开始执行。`runtime/goal-request.mjs`、`runtime/compat.mjs`、`ui/desktop/src/acp/goals.ts`、`ComposerGoalBar`、`ComposerPlanMode`、`PlanReviewForm`、`WorkspaceGoalEditor`。 |
| 浏览器与电脑控制 | 增加会话绑定的内置 `browser_control`，支持工作区 HTML 预览、观察、输入、点击和截图。节点引用过期、遮挡与未知动作结果按结构化回执处理。新增 Playwright 独立浏览器及用户浏览器扩展入口；电脑技能由模型选择，宿主保留权限控制。`runtime/browser-tool.mjs`、`runtime/harness/{computer-skill,playwright-entry,tool-discovery}.mjs`、`runtime/harness/skills/`、`ui/desktop/src/workspace-panel/`。 |
| 图片与工具调用 | 内置截图经过既有视觉路由和官方附件服务，保存持久图片引用，修复后续请求缺少 `attachmentId`。图片观察失败保留已执行动作回执，取消继续传播。首轮暴露已获允许的 `write`、`edit`、`browser_control`；其他工具按需发现。`runtime/harness/index.mjs` 及对应测试。 |
| 模型预设 | 新安装同时显示 CodeBuddy LAN 与 Ollama Cloud；LAN 初始选中，云目录首项为实测的 `kimi-k2.6`。统一默认配置到 `runtime/default-model.json`，移除桌面发行配置中的重复默认模型。首次初始化导入可选分发凭据，已有用户设置和主动删除的预设保持原样。`runtime/{store,providers,model-settings}.mjs`、桌面模型设置及回归。 |
| 流式聊天与文件 | 流式代码和超过 8000 字符的历史代码按完整纯文本显示，减少高亮开销；滚动布局写入合并到动画帧。显示工具参数生成阶段，区别于工具已经执行。实际变更与有效工作区引用合并成文件卡，去重并保留每轮真实变更；精简设置导航、工具箱分组与模型能力展示。涉及 `MarkdownContent`、`ProgressiveMessageList`、`scroll-area`、`WorkspaceFileReferences`、`CodeProConversationFiles`、`runtime/work-status.mjs`。 |
| 桌面宠物 | 增加新对话输入、文件/图片附件、右键隐藏/设置、等待提问摘要和任务跳转；完成提醒与会话已读事实一致，保留用户主动启用选择；调整多屏边界和鼠标穿透。`ui/desktop/src/pets/` 及对应测试。 |
| 存储与卸载 | 移除设置页的数据迁移/空间统计/手动清理入口，继续兼容既有数据位置和迁移日志，不把已迁移用户切回默认目录。新增 macOS 卸载计划与数据保留边界。`runtime/storage-management.cjs`、`runtime/macos-uninstall.cjs`、`ui/desktop/src/storage/macosUninstall.ts`。 |
| Windows 安装 | Inno 安装/卸载进度、详情与排版调整；默认目录保持 `%LOCALAPPDATA%\Programs\CodeBuddy`，`UsePreviousAppDir=no`，避免再次默认显示旧 D 盘安装路径，仍可手工选择目录。`scripts/installer/*.iss` 及原生夹具测试。 |
| macOS 打包与原生助手 | DMG 背景与 Finder 布局、签名/架构/载荷校验、已运行工具的文件替换、Keychain 凭据验证及电脑控制 AX/按键处理。`ui/desktop/scripts/`、`scripts/*macos*`、`tools/macos-credentials/`、`tools/qwen-computer-use/`。 |
| 文档与语言资源 | 补齐功能说明、所有权说明和中英繁三语交付文档；16 种界面语言资源有条目及格式变化，合并冲突时按键合并，勿整文件覆盖同事新增译文。 |

执行、计划、目标、压缩和完成仍由官方 DeepSeek Harness 判定；Rust 仅保留独立 MCP 工具。本批没有恢复旧 Agent、Provider 或调度核心。

## 同事合并时重点

1. 在同事自己的目标分支先保存本地修改，再 `git fetch origin`，核对本文基线和下列提交清单；按团队流程合并本批最终提交。示例：`git merge <本批最终提交>`。不要直接覆盖文件或重置目标分支。
2. 优先检查冲突：`runtime/harness/index.mjs`、`runtime/compat.mjs`、`runtime/store.mjs`、`ChatInput.tsx`、`main.ts`、`workspace-panel/`、`pets/`、i18n JSON、Forge 和安装脚本。保留目标分支独立改动，确保 ACP、UI 与运行时的关联修改同时存在。
3. `runtime/harness/package.json` 与锁文件一起合并。新增固定版本 `@playwright/mcp@0.0.83`；DeepSeek 包仍固定 `0.2.1-alpha.2`。使用 README 的既有工具链与依赖准备流程，不顺便升级依赖。
4. `runtime/tools/provenance.json` 描述本地工具产物，不会从 Git 自动带回二进制。按目标平台的 README 准备原生工具并重新生成/核对来源记录；Windows Qwen 记录明确为既有锁定产物，不能把它当成这次 Go 源码重新构建的证明。
5. 构建入口：Windows `node scripts/build-harness-windows.cjs <暂存目录> --installer=inno`；macOS 按 `docs/macos-installation.zh-CN.md` 使用 `build-harness-macos.cjs`，原生工具需对应平台、架构和签名环境。开发启动使用 `start-preview.ps1`，不以开发启动代替安装包。

### Ollama Cloud 凭据交接

Git **不包含** `runtime/distribution-credentials.json`、真实 Key、用户 profile、安装包或原始会话证据。已交付的本地安装包按用户授权携带共享 Key；只拉取 Git 后构建不会自动取得该 Key。需要相同行为时，由拥有者通过独立渠道提供本地分发凭据文件，再按现有打包流程构建。

文件结构如下，`<由拥有者单独提供>` 只是占位值，不是可用凭据：

```json
{"version":1,"providers":[{"providerId":"custom_codebuddy_ollama","baseUrl":"https://ollama.com","apiKey":"<由拥有者单独提供>"}]}
```

首次启动导入 DPAPI/Keychain；客户端包中的共享 Key 仍可被接收者提取。本机保护不等于分发保密。LAN 预设为 `http://192.168.9.101:8001`，只适用于能访问该网络的用户。全部 22 个云目录项不是全部已通过验收的模型。

## 验证与限制

本次提交前复核结果在本文末尾。原始日志在本机 `.preview-evidence/commit-handoff-20261023/`，不随 Git 提交。

已完成的同批产品验收：Windows 与 Apple Silicon Mac 的安装版使用隔离 profile，显示两个连接；LAN 对话、Cloud 写 HTML/打开内置浏览器/截图后继续请求、重启后恢复含图片历史均有实际回执。Mac 按钮完成 0 → 1；Windows 飞机游戏流程中发生长推理，验收者停止并补充实测事实后才完成，不能当成全自动单轮成功。`kimi-k3` 原始流正文为空已独立复现；保留可选，未算通过。

Windows 同批旧安装器完成真实安装/卸载且保留测试数据；最后修改默认目录后，8 项原生安装夹具测试与完整构建退出 0，截图确认 C 盘默认目录，应用/运行时摘要未变。**最终新 EXE 的完整安装流程留给用户复测**。Mac DMG 已校验、挂载、复制安装并验证签名和启动；正常 LaunchServices 启动的 LAN 请求通过。直接 SSH 启动曾出现 `EHOSTUNREACH`，保留为环境差异，不再列为待用户放行权限。

最新产物仅在本地：

| 平台 | 路径（仓库相对） | SHA256 |
| --- | --- | --- |
| Windows x64 | `.preview-evidence/installer-default-path-20261023/CodeBuddy-1.43.6-windows-x64-default-path.exe` | `7255b4467173808d58968084582dde9e3d3b45fdcea0f78e4cf392b9c2b01eba` |
| macOS arm64 | `.preview-evidence/desktop-fixes-20261023/deliverables/final/CodeBuddy-1.43.6-macos-arm64.dmg` | `c34a54fe15c4af7ee79e181384e6707894aa0ca02a65dec1a446222a26915030` |

这些包来源是上述基线加本批源码快照，早于本次 Git 提交；本次提交动作不会重新生成安装包。Windows 未签名，Mac 为开发签名且未公证；公开下载后的 SmartScreen/Gatekeeper、Mac 卸载/Finder 拖放/Intel、长期内存压力和所有模型组合均未验收。当前本机仍有先前清理未完成的用户数据，不能把普通重启当成全新安装验收。

## 提交及提交前复核

1. `6491d44` — Windows/macOS 打包、原生助手与安装目录修正（45 个文件）。
2. `11e8c28` — Harness 目标/浏览器、模型预设、聊天与宠物交互、功能文档及测试（250 个文件）。
3. 包含本文的 `docs: add trilingual merge handoff and acceptance boundaries` 提交 — 三语交接及旧阶段记录状态说明（6 个文件）。

以上提交应整体合并。本文提交的哈希可在拉取后通过 `git log -1 --format=%H origin/main -- docs/reconstruction/2026-10-23-merge-handoff.zh-CN.md` 查询；交付消息也提供最终提交号。完整差异可用 `git diff d43fcbbd0ec85afcb073cb74b14e835752a26e20 <最终提交>` 查看。

本次使用现有 Node 24.18.0；下表命令以仓库根目录为默认工作目录。

| 命令 / 检查 | 结果与边界 |
| --- | --- |
| `node --test runtime/tests/*.test.mjs runtime/tests/*.test.cjs runtime/harness/test/*.test.mjs` | 首跑 622 项：617 通过、4 失败、1 跳过，退出 1。旧夹具缺少 `tools` 能力和首轮 `write` 断言过期；其中测试服务因断言提前失败未清理而挂起，终止该测试子进程后完成汇总，不算全套通过。 |
| 相关重跑：`node --test runtime/harness/test/driver.test.mjs`；`node --test runtime/tests/model-thinking-preferences.test.mjs runtime/tests/roles-harness-integration.test.mjs runtime/harness/test/driver.test.mjs`；最后 `node --test runtime/tests/model-thinking-preferences.test.mjs` | 已修正三个测试文件，与现有工具能力合同一致；将 HTTP 服务清理注册提前。driver 9 项通过；组合重跑中 driver/roles 10 项通过；补齐最后一个 `/api/show` 夹具后 thinking 6 项全部通过、退出 0。未再重跑整个 622 项套件。产品实现未因这些夹具修正改变。 |
| `node --test scripts/harness-macos.test.cjs scripts/start-harness-preview.test.cjs ui/desktop/scripts/macos-package.test.cjs ui/desktop/scripts/codebuddy-branding.test.cjs` | 32 通过、退出 0；跨平台脚本夹具不是 Mac 原生 E2E。 |
| 桌面目录：`node ../node_modules/typescript/bin/tsc --noEmit` | 退出 0。 |
| 桌面目录：`node scripts/i18n-check.js`、`node scripts/i18n-validate-locale.js` | 均退出 0；2982 条消息，英文源检查及 15 个翻译语言校验。 |
| 桌面目录：`node ../node_modules/vitest/vitest.mjs run --maxWorkers=1` | 306 个文件、2709 项测试全部通过，退出 0，耗时 857.94 秒。使用现有 `ui/node_modules`，未安装或重建依赖；组件测试不等于全部桌面产品 E2E。 |
| `go test ./...` / `go vet ./...` | 当前 PATH 没有 Go，命令未启动；本次未完成 Go 重跑。未在 Windows 上运行 Swift 原生测试，也未修改 Rust 源码或运行 Rust 全套。 |
| Git 差异检查、提交候选扫描 | `git diff --cached --check` 退出 0；未发现本地共享 Key、安装包、大型二进制或原始 profile 混入候选。旧索引锁确认无 Git 进程占用后备份到本地证据目录。 |
