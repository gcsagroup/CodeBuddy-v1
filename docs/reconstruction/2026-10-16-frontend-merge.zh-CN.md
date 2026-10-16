# 2026-10-16 同事前端分支合并

## 源码与交付边界

在现有 `main` 中合并 `origin/codex/dsh-frontend-ux` 的 21 个提交，分支顶点 `cead742`，本地主分支基线 `692f235`（包含品牌更新）及 `743bb5f`（GitHub 账户修复）。共同祖先 `01610d0`。不纳入 Dependabot 分支，不创建新分支，不改写历史。

合并候选版本为 `1.43.5`。`1.43.4` 是合并前产物，已单独保留；它不证明本批改动。首次克隆按根 README 准备三个依赖目录，使用现有锁文件。新增的桌面直接依赖 `diff@8.0.4` 已存在本机，不执行安装。构建按 README：`node scripts/build-harness-windows.cjs target/codebuddy-package-1.43.5/harness-distribution`。

## 改动及冲突处理

- 保留同事的聊天滚动加载、消息排队与停止后发送、过期审批收起、工具记录折叠、对话文件变更面板，以及只读子 Agent 目录和对话。
- 原生子 Agent 继承当前主模型与思考强度；Host 上限为 3 个并行、深度 1。旧角色路由配置仍保存，但不覆盖运行模型或原生并发设置。
- `runtime/compat.mjs` 保留本地主分支的分阶段耗时记录，合入会话模型选择与取消释放协议；`runtime/harness/index.mjs` 保留 MCP 复用、异步任务和按需发现，权限筛选位于远端组合绑定之后，避免重复筛选及遗漏远端作用域。
- 两份中文语言资源同时保留 Office 工具箱名称和新增子 Agent／变更面板词条；保留已完成的 GitHub 账户修复和产品品牌。
- 根规则与 README 保留当前实际架构、入口和许可记录，修正同事分支中过时的旧核心路径说明。历史数据、凭据、兼容标识不迁移。
- 合并测试按真实语义调整：可选工具先发现再执行；子 Agent 请求按原始用户提示辨认而非旧角色模型名；滚动加载测试通过 IntersectionObserver；流式展示用确定性动画时钟；审批按钮只在真实待处理请求存在时验证。

## 验证记录

本地证据位于 `.preview-evidence/h20-*`，不提交含本机路径或配置的测试产物。

- 后端全量：428 项，首次 426 通过、2 项旧预期失败；修正后相关能力测试 25/25 通过。其他 403 项使用同批全量结果，不重复执行。
- 原生三子 Agent 集成复测通过；聊天历史和流式展示组件复测 59/59 通过；类型检查通过。
- 前端全量曾遭遇 Windows 内存耗尽／Vitest worker 退出，未标为全量通过；相关改动改用分批串行测试。
- 安装包、真实模型及界面结果见下方最终验收。真实安装升级、macOS 及全部旧功能不在本次合并中冒充已验。

## 最终验收与产物

- `node --test --test-concurrency=2 runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs`：首次退出 1，426/428 通过；修正上述测试预期后，`node --test runtime/harness/test/capabilities.test.mjs` 退出 0，25/25 通过；`roles-harness-integration.test.mjs` 复测退出 0。全部 428 项均有本批有效通过结果，但不是同一次全绿执行。
- 本次受影响前端 Vitest：27 文件 479 项 + 展示组件 2 文件 59 项，退出 0。先前资源紧张时失败的 Git 快照／扩展弹窗单独复跑 7/7，退出 0。完整前端套件被中止，保留未完成状态。
- `tsc --noEmit` 最终退出 0。受影响文件 ESLint 首次仅缺少 IntersectionObserver 浏览器声明；补齐现有 lint 配置后相关文件复测退出 0。没有关闭规则或改变运行实现。
- 真实浏览器滚动夹具首次遇到 `VirtualAlloc ... errno=1455` 和内存耗尽，已停止，未报通过。打包应用另有以下真实 UI 证据。
- `1.43.5` 打包应用／现有 Kimi K3：真实“你好”会话 710 ms 可见，首条可见回复 5646 ms，原生 `end_turn`。这是单次样本，不是稳定延迟承诺。
- 真实两子 Agent 多模块项目：Alpha/Beta 分别创建 `alpha.mjs`、`beta.mjs`，主 Agent 创建 `verify.mjs`，实际 `node verify.mjs` 退出 0，输出 `MERGE_SMOKE_OK`；UI 全流程约 35.9 秒。目录里可见两个子 Agent，打开 Alpha 后显示只读对话；变更面板显示主会话保存的 verify.mjs 差异，并保留覆盖范围提示。
- 设置中现有 GitHub CLI 账户状态正常，测试 profile 的 GitHub MCP 保持停用；没有登出用户、新增授权或更改真实 profile。
- 构建命令退出 0，载荷校验确认内置 Node 24.21.0、原生会话、子进程、Office 及兼容服务。NuGet 内容与实际应用一致。未验：安装／升级、macOS、全功能长任务及所有旧测试，不以本批冒充全量验收。

安装包：`ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Setup.exe`，363,771,392 字节。SHA256：`ea7771130bd05a49b0b4b2adc42cc8f958ef2a38a40b45748fbe850ffe9adbf8`。

应用 asar SHA256：`32935c61cf9e5daab268277eee4563cc08fb4884f44c85d48506ce6040a1198a`。运行载荷 sourceDigest：`404fb903c175dd8fbccffb8133e5d96e41f65fd91649695aae3c3d983da443b2`。产物来自本次已解决冲突的合并工作区；源码提交用本记录所在合并提交及两个 parent 定位。安装包和本地证据不进入源码 Git。
