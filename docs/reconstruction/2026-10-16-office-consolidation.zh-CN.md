# Office 工具合并与同事合并说明

日期：2026-10-16。基线：`main` / `e9540aa8b35f5ed63a136455a52e72137fd73918`，当前工作区 `D:\CodeBuddy-v1`。本批交付源码与本地验收，不生成安装包。前批工具箱审计见 [审计报告](2026-10-16-toolbox-audit.zh-CN.md)；那份报告描述删除前的历史快照。

## 改了什么

1. 删除 Rust `docx_tool.rs`、`xlsx_tool.rs`、对应 MCP 注册及参数类型、两份专用测试文档。删除 `docx-rs`、`umya-spreadsheet` 依赖，离线 Cargo 更新锁文件，清除仅由它们引入的依赖。
2. Word、Excel、PowerPoint 统一复用现有 Harness `dsh-skill-office` 技能、`load_workspace_dependencies` 和原生 shell。未新增 Office 编辑服务、协议适配编辑器或 Agent 调度器。
3. 工具箱按内置技能身份归入“Office 文档”组，保留三个技能各自的详情与搜索。原“文档与网页工具”更名“PDF 与网页文件”，更新中英文说明，避免仍声称提供已移除的 Office 工具。
4. 保留配置键 `computercontroller` 及其 PDF、网页文件保存、缓存功能；旧启用状态继续有效，不改用户数据库或凭据。历史工具图标及回执保留，以供旧会话查看。
5. 更新独立 MCP 工具产物指纹与来源记录。新 Windows 工具 21,777,920 字节，原为 41,534,464 字节；这只是工具可执行文件大小，不代表项目总大小或安装包大小。

## 为什么这样选

旧 DOCX 的文字替换会重建文档并丢失图片，前批已独立复现。本批先用上游载荷验证 Word 图片、表格、粗体和原件保留，以及旧 XLSX 七种操作的对应能力，再删除旧实现。

采用 [官方 Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件/技能机制。继续锁定 `0.2.1-alpha.2`，Office 插件为 MIT；保留现有许可证及载荷来源，不在本批升级快速迭代的上游版本。实际兼容依据是本地锁定插件和真实运行，不把官网最新能力当成本项目已具备。

没有删掉整个网页工具：锁定版 `dsh-web-fetch-http` 支持公网文本/结构化文本，拒绝非公网地址与二进制内容；旧 `web_scrape` 还负责本地/内网及文件保存。公网正文优先用 Harness，剩余独有用途继续保留。Exa、Tavily、GitHub 的用户配置保留，缺密钥不视作废代码。外部安全 MCP 按用户要求不测试、不改配置。

## 迁移和合并边界

- 直接合并本批源码提交；如有冲突，重点核对 `computercontroller/mod.rs`、`runtime/builtin-extensions.mjs`、`runtime/tools/provenance.json`、工具箱组件和 i18n。别把旧 DOCX/XLSX 注册从另一分支带回。
- `computercontroller` 服务器身份不变，但当前清单只含 `cache/pdf_tool/web_scrape`。自动化已验证同一会话在驱动重启后重新配置仍可发现剩余工具及三个 Office 技能。
- 旧历史不改写、不重放；新的执行由 Harness 发现当前技能。**直接硬编码 `docx_tool/xlsx_tool` 名称的外部配方需要迁移**：描述文档目标，使用对应上游技能和包内依赖；没有保留会偷偷执行旧编辑器的同名代理。
- 未扩大工具权限或修改执行/完成判定。Office 编辑继续经过现有 shell 审批；拒绝 shell 不会被旧文档 MCP 绕过。
- `runtime/py`、`runtime/office` 沿用 H15 官方锁定载荷。已有环境不需要安装新依赖；新克隆按 `scripts/office-builder/README.md` 准备载荷。
- 工具二进制不入 Git。同事按 README 离线构建 `codebuddy-tools`，复制到 `runtime/tools/bin`，按实际构建更新大小和 SHA256；不同工具链/构建环境产生的字节身份可能不同，不要只复制本机指纹而配旧二进制。
- 回滚应恢复源码、Cargo 锁文件、工具产物及指纹这一整组；用户文档和状态无迁移，勿覆盖用户数据。回滚会重新带回旧 DOCX 缺陷，正常处理应向前修复。

## 验证记录

当前源码开发入口：`node scripts/start-harness-preview.cjs`，本机使用已有 Node 24.21.0。没有用旧打包应用证明当前改动。真实模型为已有配置的 Kimi K3，测试采用专用 profile/工作区。

| 验证 | 结果 |
|---|---|
| `node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs` | 退出 0，407 项通过 |
| 工具箱、扩展设置及 ACP 工具箱相关 Vitest | 退出 0，14 文件 / 128 项通过 |
| `cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1` | 退出 0，69 通过、1 项既有联网测试忽略；旧 Office 专属测试随旧实现删除 |
| `cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings` | 退出 0 |
| `cargo build --offline -p goose-mcp --features rustls-tls --bin codebuddy-tools --jobs 1` | 退出 0，复制产物后更新并校验指纹 |
| TypeScript / i18n 提取一致性 | 退出 0 |
| 新产物保留能力实调 | 22 次调用通过：PDF 两种提取、网页三种模式、缓存列表、八种图表及资源读取 |
| 真实桌面 Office 两轮与独立检查 | 两轮原生 completed；Word 图片字节、表格、粗体、原件及 Excel 公式/其他表/原件均独立通过；仅使用上游技能 |

本机原始证据位于 `.preview-evidence/h16-*`，不提交会话、配置和工具 URL。首次测试 profile 写入了错误的扩展对象结构，已修正夹具；首次连续对话的一个 turn 标记用户中断，与开发热更新时段重合，不作为完整通过证据。模型也出现过缺少 shell 必需参数/断言笔误，记录实际重试及回执，不把模型自述当产品结论。

macOS、安装包、小时级任务、全部文档版式未在本批重新验收。Gemma 参数兼容问题是前批已知限制，本批没有宣称修复。当前没有改变外部安全 MCP 或用户原有配置。

最终 Office 会话 `914972d9-a0ac-46f1-9430-0750fab50550`：创建约 81 秒，编辑约 44 秒；中间一次缺 `description` 的工具参数被拒绝，模型随后补齐并成功，不掩盖重试。证据 `h16-final-native.json`、`h16-final-independent.json`。ESLint 退出 0；原 661 个会话保留，providers/preferences 哈希未变。

本批追加电脑控制实测：Harness + Kimi K3 在专用窗口完成输入、快捷键、点击切换、取消、拖动及滚动，退出 0。可见回执包含 KEY-739、12 次拖动移动及 scrollY=40；证据 h16-computer.log。全部语言键校验及 i18n 编译退出 0，其他语言原有英文工具说明同步更新。

## 同事接入步骤

1. 先保存同事工作区的未提交修改，确认其项目已经包含上述 Harness 基线。若仍是旧 Rust Agent 项目，先合入 Harness 迁移基线，再应用本批，不能只拷贝工具箱文件。
2. 同仓库、没有分叉提交的副本使用 `git fetch origin` 和 `git merge --ff-only origin/main`。已有独立开发提交时，在同事现有目标分支审阅后 cherry-pick 本批完整提交；不要强推或覆盖未提交内容。
3. 将 Rust 删除、Cargo 锁文件、运行时清单、Office 分组和测试作为整体合入。重建独立工具、同步产物指纹，按上面的命令验证；用一份带图片/表格的 Word 和含公式/第二工作表的 Excel 做两轮修改回读。
4. 本机证据不进 Git；合并者需在自己的环境重做关键验收。没有在本轮执行其他同事分支的合并。
