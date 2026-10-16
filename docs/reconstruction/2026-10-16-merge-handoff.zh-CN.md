# Harness 11–15 源码合并交接

日期：2026-10-16。默认语言为简体中文；[繁體中文](2026-10-16-merge-handoff.zh-TW.md) · [English](2026-10-16-merge-handoff.en.md)。

## 交付范围与合并基线

仓库 `https://github.com/erjinyi-bool/CodeBuddy-v1.git`，现有 `main` 分支；本批以 `01610d03764570282eee439cd2bfb49fcd373e98` 为父基线，包含此前尚未提交的 Harness 11–14 和本次 15 改动。准确交付提交由本文件所在提交及紧随的交接修订确定，可用 `git log --oneline -- docs/reconstruction/2026-10-16-merge-handoff.zh-CN.md` 查询。

用户最终要求改为本地验证、提交和推送，停止生成新安装包。交付源码、锁文件、回归测试和文档；不上传模型密钥、用户会话、验收原始数据、Python 载荷、node_modules、二进制及构建缓存。历史专题中“未提交/未推送”表示当时状态，不是本次最终交付状态。

## 改了什么

| 模块 | 前后差异及合并注意点 |
| --- | --- |
| 执行核心 | 删除 11 个旧 Rust crate 及旧 CLI/Provider/原生 SDK 专用入口。Cargo 仅保留 `goose-mcp`。Harness 拥有 Agent 执行、任务调度、完成、计量与压缩；不要恢复旧 Agent fallback。 |
| 独立工具 | `crates/goose-mcp/src/bin/codebuddy-tools.rs` 提供独立 MCP 入口，保留电脑控制、PDF、图表、缓存、天气等工具。Office 和公网抓取优先走官方 Harness；尚无等价替代的旧工具保留。不是整个产品零 Rust。 |
| 按需工具 | `runtime/harness/tool-discovery.mjs` 延迟注入原生/MCP 完整 schema；保留发现入口、权限及动态工具刷新。精简 `task-tools.mjs`、`memory.mjs` 重复提示，不让普通问候承担完整工具说明。 |
| 模型容量 | `model-catalog.mjs`、`model-settings.mjs`、`providers.mjs` 使用模型元数据/提供商查询与显式设置。移除前端临时 128K 猜测；`useModelCapacity` 防止切换模型后的旧响应覆盖新模型。未知容量与确认容量区别显示，不把 33K 当所有模型的固定上限。 |
| 自动压缩与实时显示 | Harness 决定压缩；适配层传递运行中的 token/容量/压缩事件。ACP store、上下文指示器消费结构化事实。沿用已记录的 upstream compaction 单检查点兼容补丁，没有第二套摘要器。 |
| 启动与连接 | 并行处理容量查询和连接预热、复用 MCP scope；预热不创建会话、不生成回答、不执行工具。减少历史序列化及重复解密。桌面启动和 Forge 拒绝旧 Rust Agent 回退。 |
| MCP 长工具调用 | `mcp-tasks.mjs` 使用官方 SDK 协商 tasks 能力并处理轮询/取消；默认请求超时 300 秒。已被服务端接受的调用不因断线盲目重放，task handle 不作为完成结果。跨进程恢复外部异步任务仍有限制。 |
| Office | 直接注册 `dsh-skill-office`、`dsh-tool-workspace-dependencies`；官方锁定 Python 3.12.14 与 13 个库。官方准备器源码原样保存于 `scripts/office-builder/upstream`，许可证和锁文件一起提交。模型经技能、依赖查询、Harness shell 操作文件；没有重写 Office 引擎。 |
| 工具箱 | `library.mjs` 将官方获胜技能定义投影到来源列表及实际技能管理列表，支持详情，内置技能只读。修复“底层已加载但工具箱列表看不到”的接口遗漏，未重做 UI 布局。 |
| 网页 | 直接使用官方 `web_fetch`，保持权限、公网地址和 URL 校验。没有配置搜索服务时不暴露 `web_search`。公网抓取不等于私网访问或二进制下载。 |
| SDK/构建 | 旧 Rust 导出的 ACP schema 原样移到 `ui/sdk/schema`，生成器改读固定 schema，协议字段不变。CI、Justfile、README、AGENTS、桌面入口同步退役旧核心。 |
| Windows 路径 | 实际安装曾复现 Squirrel 268 字符路径失败；Python/技能载荷缩短至 `runtime/py` 和 `runtime/office`，增加安装路径预检与回归。用户停止安装包后，没有重复真实安装验收。 |

细节与各阶段证据：[H11](2026-10-15-harness11.zh-CN.md)、[H12](2026-10-15-harness12.zh-CN.md)、[H13](2026-10-15-harness13.zh-CN.md)、[H14](2026-10-16-harness14.zh-CN.md)、[H15](2026-10-16-harness15.zh-CN.md)、[工具替代审计](2026-10-16-rust-tool-reuse-audit.zh-CN.md)。事实所有权见 `documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md`。

## 同事如何合并

1. 先保存同事分支上未提交的工作，检查与上述父基线的分叉；本批没有替同事执行合并。
2. `git fetch origin main`，用 `git diff --stat 01610d03764570282eee439cd2bfb49fcd373e98..origin/main` 和实际文件差异评审。
3. 在同事已选定的集成分支合并该交付提交。跨层迁移应整体合入，不只拣 Office 的 UI 或删除 Rust 的一部分。
4. 重点处理 `Cargo.toml/Cargo.lock`、`runtime/harness/index.mjs/profile.mjs`、`runtime/library.mjs/server.mjs`、桌面 `main.ts/forge.config.ts`、ACP 上下文事件、SDK schema 的冲突。保留对方独立功能，但执行与上下文 owner 仍为 Harness。
5. 新增协议字段应先修改权威 schema，再运行 SDK 生成；不要恢复从已删除 Rust 核心生成 schema 的命令。历史导入映射和 `_goose/unstable` 协议名是兼容层，有意保留。
6. 本机依赖并不随 Git 传递；按 README、`runtime/harness/package-lock.json`、`runtime/tools/provenance.json` 准备对应运行依赖。Office 下载须按下方独立步骤执行。合并后重新验证自己的源码，不能把本机旧二进制当新分支证明。

## 本地准备与验证入口

使用 Node 24、仓库现有 pnpm 和 Rust toolchain。依赖已准备时不重新安装，不清缓存。

```powershell
# 官方 Office 载荷首次准备；这是单独的联网依赖准备步骤
npm ci --prefix scripts/office-builder --ignore-scripts --no-audit --no-fund
node scripts/prepare-harness-office.mjs

# 仓库根目录
node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/*.test.cjs
cargo fmt --check
cargo test --offline -p goose-mcp --features rustls-tls --jobs 1
cargo clippy --offline -p goose-mcp --all-targets --features rustls-tls --jobs 1 -- -D warnings

# ui/desktop 目录，使用已准备的依赖
node ../node_modules/typescript/bin/tsc --noEmit
node ../node_modules/vitest/vitest.mjs run --maxWorkers=1

# 回到仓库根目录，源码开发启动；不是生成安装包
.\start-preview.ps1
```

Office 准备器保留已有载荷而不覆盖。生成的 `runtime/py`、`runtime/office` 和工具二进制被忽略是有意的；缺失载荷会使相关 Office 回归标记跳过，必须同时检查通过数和跳过数。准备细节与上游固定 revision 见 [构建器说明](../../scripts/office-builder/README.md)。

## 验证分层与实际结果

- 当前源码：后端/Harness/构建脚本 422 项通过、0 跳过，退出 0；Rust 85 项通过、1 项联网测试忽略，退出 0；格式、Clippy、TypeScript 检查退出 0。完整前端 262 个文件、2320 项全部通过，退出 0。
- 当前本地应用：`1.43.3-harness15`，`ui/desktop/out/CodeBuddy Harness-win32-x64/CodeBuddy.exe`，运行时 sourceDigest `826f35f499126abbe1f8fa4e84f94f8249e48dfab2c64b224955b31eeb31012f`。这来自本目录当前改动，非旧安装版。
- 当前真实 Kimi K3：新会话约 691 ms 可见，首段回答约 5514 ms；这是单次样本，不是服务时延承诺。普通需求创建 DOCX/XLSX 并抓取网页，然后第二轮定点修改，两轮均 completed；原生日志无工具错误，使用官方 `skill/load_workspace_dependencies/write/pwsh/web_fetch`，未调用旧 MCP 文档工具。创建 64.5 秒、修改 50.9 秒。
- 独立回读：原文件、图片字节、粗体、公式文本及其他工作表保留；当前真实工具箱列出三个 Office 技能并成功打开详情。用户原有 661 个会话和模型/偏好哈希保持不变。所有模型验收使用隔离 profile。
- 复用 H14 证据：八模块订单项目及重启后修正需求，合计 21 次自动压缩，70/73 项项目测试和每轮 64 项独立检查通过；运行中计量、停止/继续及真实仓库只读分析通过。这些是 H14 实测，未在 H15 再完整执行。
- 本机原始证据在 `.preview-evidence/h15-final-*`、`h15-local-final-*`、`h15-user-preservation-after.json`，不提交其中的模型配置和原始会话。

## 剩余边界与恢复

这次不宣称全部平台、技能和任意大型项目已完整验收：macOS、所有电脑控制操作、小时级任务、本轮 PPTX 模型操作和 Office 视觉版式尚待专项验收。Excel 只检查公式文本/格式，未验证计算缓存刷新；LibreOffice 视觉渲染未验。Rust 联网测试被忽略，不能记作通过。

旧安装尝试因路径过长失败，可能留下不完整的 `%LOCALAPPDATA%/CodeBuddyHarness` 应用目录。用户数据仍保留；本次应使用源码入口或上述本地产物，不把旧开始菜单快捷方式当 H15 验收入口。短路径修复有自动回归及当前本地应用验证，但用户取消封装后未重跑安装。不要将 rejected H15 安装包分发给同事。

回滚代码应使用 Git 的审阅/还原流程，不删除 `~/.CodeBuddy-Harness`、`.preview-data` 或用户工作区。恢复旧安装仅使用此前已验收的 H14 包，并先确认本机现状；旧安装验证记录不代表当前系统仍安装完好。合并后若升级 Harness，须复核本项目的模型元数据、MCP Apps/tasks、compaction 兼容补丁与官方新接口。
