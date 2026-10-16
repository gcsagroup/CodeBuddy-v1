<div align="center">

<img src="ui/desktop/src/images/icon-512.png" alt="CodeBuddy" width="96" />

# CodeBuddy

**面向 Windows 的桌面 AI 开发助手：分析项目、修改代码、运行测试、检查 Git 变更。**

[简体中文](README.md) · [繁體中文](documentation/codebuddy/GITHUB_OVERVIEW_ZH_TW.md) · [English](documentation/codebuddy/GITHUB_OVERVIEW_EN.md)

</div>

## 当前版本

CodeBuddy 将项目分析、代码修改、命令执行、Git 审查、项目记忆和工具扩展放在同一个桌面工作区。当前候选版本为 `1.43.4`；安装包与验收状态以[本批交付记录](docs/reconstruction/2026-10-16-codebuddy-branding.zh-CN.md)为准，源码构建成功不代表所有功能均已完成真实验收。

Windows 使用仓库根目录的 `start-preview.ps1` 启动开发版。模型、历史及设置保存在 `.preview-data`，日志位于 `.preview-data/logs/preview`。安装版的数据目录为 `~/.CodeBuddy-Harness`，该兼容路径保持不变，以便继续读取已有数据。新任务可使用默认工作区，也可选择现有项目。

Git 仅保存源码、依赖锁文件和许可证，不包含本机凭据、聊天数据、运行载荷和构建产物。首次克隆需要准备开发依赖及独立工具，详见下文。

## Windows 构建

使用已有 Node.js 24+ 和项目依赖，在仓库根目录执行：

```powershell
node scripts/build-harness-windows.cjs
```

产物为 `ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Setup.exe`；桌面应用显示为 **CodeBuddy**。安装标识 `CodeBuddyHarness` 和现有数据路径为兼容已有版本保留，不通过改名迁移用户数据。

构建将运行时、适配层、配方类型、Office 载荷和独立 MCP 工具暂存、校验并交给 Electron Forge/Squirrel 封装。包内包含 Node 24 与许可证，应用运行不依赖系统 Node。项目开发所需的语言工具链仍按项目自身要求准备。

首次准备 Office 环境请阅读 [Office 构建器说明](scripts/office-builder/README.md)，生成 `runtime/py` 和 `runtime/office`。该准备步骤涉及下载；正常打包只复制和验证已有载荷，不修改系统 Python。短目录和构建前路径检查用于避免 Windows 安装路径超长。

独立 MCP 工具按 `runtime/tools/provenance.json` 准备到 `runtime/tools/bin`。本机离线构建命令：

```powershell
cargo build --offline -p goose-mcp --features rustls-tls --bin codebuddy-tools --jobs 1
```

更新工具产物时须同步核对 `runtime/tools/provenance.json`、`runtime/builtin-extensions.mjs` 中的大小和 SHA256。运行依赖以 `runtime/harness/package-lock.json` 为准。

同批源码、同一暂存目录且应用已完整构建时，才可使用 `node scripts/build-harness-windows.cjs <stage-directory> --make-only` 接续安装包生成。NuGet 已完成、仅 Squirrel 封装中断时可使用 `--finalize-only`；脚本先验证 NuGet 内应用与当前产物一致。源码变更后必须重新构建，不复用旧暂存目录。

第三方组件的许可证、版权及来源记录保留在对应许可文件与 `runtime/harness/PROVENANCE.json`。开发交接与逐批验收记录见 [重构记录](docs/reconstruction)，历史记录中的版本名与测试结论仅适用于当时产物。

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

使用仓库根目录的 `start-preview.ps1` 或 Node 24 执行 `scripts/start-harness-preview.cjs`。独立 MCP 工具依照上方说明准备。
## 第一次使用

1. **连接模型**：在设置中配置提供商、服务地址、API Key 和实际可用模型。本地服务需要先启动。
2. **选择项目**：点击新任务，使用默认工作区或选择项目文件夹。初次试用使用可恢复的测试项目。
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
[Windows Actions](https://github.com/erjinyi-bool/CodeBuddy-v1/actions/workflows/codebuddy-windows.yml)
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
| runtime/harness            | 执行服务与必要适配 |
| scripts                    | 启动、构建和验证脚本    |
| documentation/codebuddy | 产品文档与第三方声明    |
| docs                       | 设计和开发计划          |

## 项目体积与本地文件

- `target/` 是可重新生成的 Rust 编译产物，不属于提交到 GitHub 的源码。
- `node_modules/`、安装包输出、本地验收记录和临时夹具也不应提交。
- 先停止构建再整理缓存；源码、配置、会话及未完成工作的证据需要保留。
- 当前仓库已移除未被引用的旧演示视频和动图。历史提交仍保留原文件，因此这次删除不会立即缩小已有 `.git` 历史。

## 反馈与许可

使用本仓库 [Issues](https://github.com/erjinyi-bool/CodeBuddy-v1/issues) 反馈问题，
提供版本、复现步骤、预期与实际结果，去除密钥和个人信息。

[贡献指南](CONTRIBUTING.md) · [维护者](MAINTAINERS.md) ·
[Apache-2.0 许可证](LICENSE) · [第三方软件与修改声明](documentation/codebuddy/THIRD_PARTY_NOTICE.md)
