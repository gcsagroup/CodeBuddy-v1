<div align="center">

<img src="ui/desktop/src/images/icon-512.png" alt="CodeBuddy" width="96" />

# CodeBuddy

**面向 Windows 的桌面 AI 开发助手：分析项目、修改代码、运行测试、检查 Git 变更。**

[简体中文](README.md) · [繁體中文](documentation/codebuddy/GITHUB_OVERVIEW_ZH_TW.md) · [English](documentation/codebuddy/GITHUB_OVERVIEW_EN.md)

</div>

## 当前 Harness 首版候选（D:\CodeBuddy-v1）

**2026-10-16 源码交付：** 当前版本 `1.43.3-harness15`，按用户要求停止生成安装包，改为本地应用验收后提交推送。新增官方 Office 技能/载荷及公网抓取，完成旧 Rust Agent 清理和上下文、按需工具、冷启动改进。后端及脚本 422 项、前端 2320 项、Rust 85 项通过（1 项联网测试忽略），类型检查、格式、Clippy 通过；真实 Word/Excel 多轮编辑及工具箱验收通过。完整变更、同事合并步骤、依赖准备和待验边界见[合并交接文档](docs/reconstruction/2026-10-16-merge-handoff.zh-CN.md)。下文 H14 安装结论为历史记录；H15 曾安装失败，本机应使用源码入口或已验收本地产物，不能据旧快捷方式判断当前安装完整。

Git 仓库保存源码、依赖锁文件和许可证；不包含本机模型凭据、聊天数据、验收原始记录、`node_modules`、构建目录和安装包。`vendor/deepseek-harness` 仅为本地上游源码参考缓存，实际运行依赖以 `runtime/harness/package-lock.json` 为准。首次克隆后，除下文开发依赖外，还须按 `runtime/tools/provenance.json` 准备对应平台的 MCP 工具到 `runtime/tools/bin`；启动/打包会校验这些文件，仓库本身不包含预编译工具。当前 Windows 安装包已内置这些运行组件。

历史记录：Windows 候选 `1.43.3-harness14` 曾实际安装并启动。旧 Rust Agent 的 11 个 crate 及专用入口已移除，Cargo 仅保留独立 MCP 工具；Harness 主导执行、调度、完成与压缩。真实桌面八模块项目及安装重启后的需求修正合计完成 21 次自动压缩，分别通过 70 / 73 项项目测试和每轮 64 项独立检查；运行中用量更新、界面停止与继续通过。安装版运行时对本仓库完成只读跨目录分析，仓库未变。自动验证：后端 382 项、相关前端 78 项、Rust 工具 85 项通过（1 项联网测试忽略），类型检查与 Clippy 通过。原有 661 个会话和配置保留。安装包：`target/accepted-harness-installer-1.43.3-harness14/CodeBuddy-Harness-Setup.exe`，约 234 MiB。启动「CodeBuddy Harness」，数据 `~/.CodeBuddy-Harness`。详见[本批验收](docs/reconstruction/2026-10-16-harness14.zh-CN.md)；本批未重跑全部技能、电脑控制、macOS 或小时级生产项目，大仓库只读分析不等同于大项目完整开发验收。

安装包包含构建机已有的 Node 24 可执行文件及许可证；Harness 服务与原生任务子进程使用包内 Node，运行服务不依赖系统 Node。打包前会实际执行 PowerShell 和文件搜索，检查原生子进程链路。项目开发所需的语言工具链仍按项目自身要求准备。

Harness Windows 安装包开发入口（使用已有 Node 24+ 和本地依赖）：
`node scripts/build-harness-windows.cjs`。脚本将官方 Harness 依赖、适配层、SDK 配方类型和已验收 MCP 工具暂存到独立目录并校验指纹，调用现有 Electron Forge/Squirrel。安装标识为 CodeBuddyHarness，默认数据目录为用户主目录下 `.CodeBuddy-Harness`，与旧版隔离。首次启动可在设置配置模型；不自动导入旧版。打包和真实安装验收的结果以专题记录为准。

Harness15 的 Office 技能使用官方锁定的独立 Python 载荷。首次打包前，按 [Office 构建器说明](scripts/office-builder/README.md) 准备 `runtime/py` 和 `runtime/office`；准备步骤涉及依赖下载，正常打包只复制和验证已有载荷，不修改系统 Python。短目录用于避免 Squirrel 安装路径超长，打包前检查当前主机的路径限制。载荷和构建缓存不纳入 Git。

已有同一批次应用产物时，可用 `node scripts/build-harness-windows.cjs <stage-directory> --make-only` 继续生成安装程序；仅适用于无需重新构建应用的中断，不用于跳过源码变更后的构建。

独立 Windows 工具的现有离线构建入口：`cargo build --offline -p goose-mcp --features rustls-tls --bin codebuddy-tools --jobs 1`。将本批 `target/debug/codebuddy-tools.exe` 放入 `runtime/tools/bin` 后，按实际产物更新 `runtime/tools/provenance.json` 和 `runtime/builtin-extensions.mjs` 的大小、SHA256，再运行打包校验。此程序仅提供 MCP 工具，不包含旧 Agent；旧源码的 `goose.exe` 不用于 Harness 发行包。

若 NuGet 已完成、Squirrel 最终封装中断，可用 `node scripts/build-harness-windows.cjs <stage-directory> --finalize-only` 续做；先校验 NuGet 中的应用归档和 Harness 清单与当前产物一致。构建工具仅从现有依赖复制到 `target/harness-winstaller-*`，补齐当前主机架构的 7-Zip 文件名，不修改依赖目录。

此目录的新执行链路由 Harness 主导；Windows 使用已存在的启动器：

```powershell
Set-Location D:\CodeBuddy-v1
.\start-preview.ps1
```

启动器选择本机已有的 Node.js 24+，准备 SDK/语言资源并启动 Harness 桥接与 Electron，不自动安装依赖。已有模型、历史和配置保存在 `.preview-data`；日志及本次启动回执位于 `.preview-data/logs/preview`。新任务默认在 `D:\CodeBuddy-Workspace` 内建立独立工作目录，也可选择现有项目。模型在设置中配置。

上述 start-preview 是源码开发入口，使用独立于安装版的数据目录。实际通过项和剩余缺口以[安装验收记录](docs/reconstruction/2026-10-15-harness-package.zh-CN.md)、[夜间验收记录](docs/reconstruction/overnight-acceptance.zh-CN.md)及[功能矩阵](docs/reconstruction/v1-functionality.zh-CN.md)为准。当前 `start-gui` 也转入 Harness 启动器；旧 Rust Agent 打包入口已退役。

CodeBuddy 将模型对话、项目文件、命令执行、Git 审查和扩展工具放在同一个桌面工作区。
选择项目、连接模型、描述目标，再查看实际执行过程与结果。

> 当前 main 是源码开发预览，并不代表每项功能均已完成实操验收。
> 本次已同步当前开发源码，包括工具箱详情与教程移除、记忆容量优化、电脑控制截图状态保护、Git 审查桥接及任务恢复相关修复。
> 最新源码仍有尚未完成的完整构建、桌面时序与软件操作验收，不能作为已验收的正式发行版。

## 功能

| 能力               | 使用方式                                       |
| ------------------ | ---------------------------------------------- |
| 项目分析与开发     | 选择目录，用自然语言要求读取、解释或修改代码   |
| 命令与测试         | 运行项目已有测试，查看命令、退出码与输出       |
| Git 版本控制       | 查看状态、差异，并使用任务面板的审查入口       |
| 项目记忆与历史     | 管理记忆，通过历史记录返回已有对话             |
| 工具与扩展         | 按任务配置内置能力、MCP 服务和技能             |
| Windows 电脑控制   | 支持桌面操作；复杂软件任务仍需逐项核对实际结果 |
| 常用任务与自动任务 | 保存重复任务，确认项目、模型和计划后执行       |

## 环境准备

- Windows 10/11 x64、Git for Windows。
- Node.js 24.10 或兼容的 24.x 版本。
- pnpm：以 [ui/package.json](ui/package.json) 的 packageManager 为准，当前 11.9.0。
- Rust：以 [rust-toolchain.toml](rust-toolchain.toml) 为准，当前 1.96.1。
- Visual Studio 2022 C++ Build Tools、Windows SDK、LLVM/Clang。
- 可访问的模型服务及凭据，例如本地 Ollama、Ollama Cloud 或应用支持的其他提供商。

首次编译会下载依赖并生成较大的构建缓存。确认目标磁盘空间充足，避免同时运行多份完整编译。

## 源码启动

使用仓库根目录的 `start-preview.ps1` 或 Node 24 执行 `scripts/start-harness-preview.cjs`。旧 Rust Agent 与其构建入口已经移除；独立 MCP 工具依照上方说明准备。不要用历史文档中的 goose CLI 命令启动新版。
## 第一次使用

1. **连接模型**：在设置中配置提供商、服务地址、API Key 和实际可用模型。本地服务需要先启动。
2. **选择项目**：点击新任务，选择要操作的项目文件夹。初次试用使用可恢复的测试项目。
3. **先只读分析**：发送下面的第一条提示词，确认模型与项目连接正常。
4. **再执行修改**：说明具体目标、允许修改的范围和验收条件。
5. **核对结果**：检查文件差异、工具回执、测试命令和退出码，不仅看模型的“完成”文案。
6. **继续任务**：在原对话补充要求或输入“继续”。恢复失败时保留会话和错误用于排查。

### 提示词示例

```text
只读取当前项目，说明主要功能、入口文件和启动步骤，不修改文件。
```

```text
检查当前 Git 差异，指出具体文件、行号和问题原因，不提交、不推送。
```

```text
修复这个函数的边界错误，运行对应测试，报告修改文件、测试结果和未验证部分。
```

## Git、工具和授权

- Git 操作以当前选择的项目为准。写入或远端操作前确认仓库、分支和变更。
- 使用版本控制/任务面板的审查入口，检查实际返回的问题列表。
- 启用工具不等于连接成功，更不等于所有功能已验收。外部 MCP 需要单独配置与测试。
- 电脑控制明确指定软件、目标和完成条件；发信、删除等操作需要准确对象与内容。
- API Key 只填写在应用配置中，不写入源码或提交到 Git。

## 常见问题

**启动报编译器或 Clang 错误**：确认 C++ Build Tools、Windows SDK 和 LLVM 安装完整，
必要时检查 LIBCLANG_PATH，重新打开终端后重试。

**模型能回答但工具失败**：检查模型工具调用支持、工具启用状态、服务连接与权限。
记录具体工具错误，不能用另一项工具成功替代本次验收。

**磁盘空间下降**：Rust target、前端依赖和打包产物占用空间较大。
停止构建后再检查可再生成目录；保留源码、会话和未验收证据。

**没有安装包**：可直接从源码启动，也可查看
[Windows Actions](https://github.com/erjinyi-bool/CodeBuddy/actions/workflows/codebuddy-windows.yml)
中成功任务实际提供的工件。仓库不承诺每次提交都有已签名的正式安装包。

## 开发与测试

在 ui/desktop 下执行：

```powershell
corepack pnpm run typecheck
corepack pnpm run test:run
corepack pnpm run lint:check
```

在仓库根目录执行：

```powershell
cargo fmt --check
cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1
cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings
```

部分内部 crate、包和协议保留兼容名称，不能直接全局替换。

| 路径                       | 内容                    |
| -------------------------- | ----------------------- |
| ui/desktop                 | Electron 界面           |
| ui/sdk                     | 通信 SDK                |
| crates/goose-mcp            | 独立文档、图表、查询工具 |
| runtime/harness            | 官方 Harness 插件及必要适配 |
| scripts                    | 启动、构建和验证脚本    |
| documentation/codebuddy | 产品文档与第三方声明    |
| docs                       | 设计和开发计划          |

## 当前开发快照验证（2026-09-11）

- 当前本地开发源码已同步；会话、密钥、缓存和验收产物不上传。
- 桌面全量测试 221 个文件通过：1801 项通过、4 项跳过。Rust 全工作区首轮 4952 项通过、1 项失败、39 项忽略；过期断言修正后，所属记忆工具测试 14 项全部通过。
- 打包前已修复三处 Clippy 提示；`cargo clippy --workspace --all-targets --exclude v8 --jobs 1 -- -D warnings` 已通过。
- Windows x64 1.43.1 安装包已从 Release 源码构建，包内容、后端哈希和发行配置检查通过。安装包未签名；实际安装升级、思考增量显示时序、电脑控制完整软件操作等验收尚未完成，不代表所有功能已经实操验收。

## 项目体积与本地文件

- `target/` 是可重新生成的 Rust 编译产物，不属于提交到 GitHub 的源码。
- `node_modules/`、安装包输出、本地验收记录和临时夹具也不应提交。
- 先停止构建再整理缓存；源码、配置、会话及未完成工作的证据需要保留。
- 当前仓库已移除未被引用的旧演示视频和动图。历史提交仍保留原文件，因此这次删除不会立即缩小已有 `.git` 历史。

## 反馈与许可

使用本仓库 [Issues](https://github.com/erjinyi-bool/CodeBuddy/issues) 反馈问题，
提供版本、复现步骤、预期与实际结果，去除密钥和个人信息。

[贡献指南](CONTRIBUTING.md) · [维护者](MAINTAINERS.md) ·
[Apache-2.0 许可证](LICENSE) · [第三方软件与修改声明](documentation/codebuddy/THIRD_PARTY_NOTICE.md)

上游 goose 博客及活动素材不再随仓库复制，相关文档链接指向上游网站；使用指南仍需要的配图保留在 `documentation/static/img/upstream-blog/`。本地 `target/` 等构建缓存不属于源码，重新编译时会生成。
