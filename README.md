<div align="center">

<img src="ui/desktop/src/images/icon-512.png" alt="CodeBuddy" width="96" />

# CodeBuddy

**面向 Windows 的桌面 AI 开发助手：分析项目、修改代码、运行测试、检查 Git 变更。**

[简体中文](README.md) · [繁體中文](documentation/codebuddy/GITHUB_OVERVIEW_ZH_TW.md) · [English](documentation/codebuddy/GITHUB_OVERVIEW_EN.md)

</div>

## 当前 Harness 版本

当前执行核心为 DeepSeek Harness（DSH），通过 `runtime/` 的 Node.js 兼容服务连接 Electron/React 桌面。`vendor/deepseek-harness` 仅为本地上游源码参考缓存，实际运行依赖以 `runtime/harness/package-lock.json` 为准。

仓库保存源码、锁文件和许可证，不包含模型凭据、聊天数据、`node_modules`、构建产物和预编译 MCP 工具。独立工具的来源、平台、路径和哈希见 `runtime/tools/provenance.json`；按其要求准备到 `runtime/tools/bin`，不能以任意旧二进制替代或跳过校验。

源码启动、安装包构建和真实产品验收是不同步骤。历史实现与安装记录见 [Harness 接入记录](docs/reconstruction/2026-10-14-harness-authority.zh-CN.md)、[安装记录](docs/reconstruction/2026-10-15-harness-package.zh-CN.md)和[功能矩阵](docs/reconstruction/v1-functionality.zh-CN.md)；其中原开发机的路径、旧产物和通过项不代表当前 checkout 已完成验收。

准备下文依赖后，在仓库根目录启动：

```powershell
.\start-preview.ps1
```

启动器选择本机已有的 Node.js，编译 SDK/语言资源并启动 Harness 服务与 Electron，不自动安装依赖。预览的模型、历史和配置保存在当前仓库的 `.preview-data`；日志和启动回执位于 `.preview-data/logs/preview`。首次启动未配置模型时进入配置页面；可在界面选择测试项目。

`start-gui` 等旧后端脚本仍保留在源码中，不用于启动本版 Harness。预览数据与安装版隔离，不自动导入旧版配置或凭据。

CodeBuddy 将模型对话、项目文件、命令执行、Git 审查和扩展工具放在同一个桌面工作区。
选择项目、连接模型、描述目标，再查看实际执行过程与结果。

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
- 可访问的模型服务及凭据，例如本地 Ollama、Ollama Cloud 或应用支持的其他提供商。

仅在需要本地编译原生 npm 模块或重建 Rust 工具时准备相应 C++/Rust 工具链；Rust 版本以 `rust-toolchain.toml` 为准，不把旧 Agent 全量编译作为 Harness 桌面启动步骤。

## 首次准备依赖

以下命令在仓库根目录的 PowerShell 中执行，保持现有锁文件版本：

```powershell
node --version
corepack pnpm --dir .\ui install --frozen-lockfile
Push-Location .\runtime
npm ci --ignore-scripts --no-audit --no-fund
Pop-Location
Push-Location .\runtime\harness
npm ci --ignore-scripts --no-audit --no-fund
Pop-Location
.\start-preview.ps1
```

已有匹配版本 pnpm 时，可将 `corepack pnpm` 替换为 `pnpm.cmd`。UI、兼容服务和 Harness 是不同依赖目录；任一步失败先查看该步错误，不直接进入启动。不为绕过安装错误修改依赖版本或锁文件。

以后依赖未变化时直接运行 `.\start-preview.ps1`。窗口未出现时，先检查 `.preview-data/logs/preview/launch.json`、`prepare.log`、`runtime.log` 和 `electron.log`；进程启动成功不等于真实模型对话或工具已经验收。

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

**启动报找不到模块**：确认三个依赖目录均已按锁文件准备，查看 `runtime.log` 中具体缺失的模块。不要改用旧 Rust 启动脚本掩盖 Harness 错误。

**模型能回答但工具失败**：检查模型工具调用支持、工具启用状态、服务连接与权限。
记录具体工具错误，不能用另一项工具成功替代本次验收。

**磁盘空间下降**：Rust target、前端依赖和打包产物占用空间较大。
停止构建后再检查可再生成目录；保留源码、会话和未验收证据。

**需要 Windows 安装包**：依赖和原生 MCP 工具齐备后，使用 `node scripts/build-harness-windows.cjs`。脚本暂存运行时并调用 Electron Forge/Squirrel，安装版服务使用包内 Node。构建、安装和模型/工具实测分别确认；仓库不包含本机 `target/` 中的历史安装包。

## 开发与测试

从仓库根目录按受影响组件选择现有检查或相关用例：

```powershell
corepack pnpm --dir .\ui\desktop run typecheck
corepack pnpm --dir .\ui\desktop run test:run
corepack pnpm --dir .\ui\desktop run lint:check
npm --prefix .\runtime test
npm --prefix .\runtime\harness test
```

不必每次运行上面全部检查；桌面可指定相关 Vitest 文件，运行时可用 `node --test <相关测试文件>`。只有改动实际使用的 Rust 组件才选择对应 Cargo 检查。部分包和协议保留兼容名称，不能按旧名字全局替换或删除。

| 路径                       | 内容                    |
| -------------------------- | ----------------------- |
| ui/desktop                 | Electron 界面           |
| ui/sdk                     | 通信 SDK                |
| runtime                    | Harness 驱动、产品兼容服务与独立工具边界 |
| crates                     | 保留的旧 Rust 实现及工具源码 |
| scripts                    | 启动、构建和验证脚本    |
| documentation/codebuddy | 产品文档与第三方声明    |
| docs                       | 设计和开发计划          |

## 项目体积与本地文件

- `target/` 是可重新生成的 Rust 编译产物，不属于提交到 GitHub 的源码。
- `node_modules/`、安装包输出、本地验收记录和临时夹具也不应提交。
- 先停止构建再整理缓存；源码、配置、会话及未完成工作的证据需要保留。

## 反馈与许可

在[当前仓库](https://github.com/erjinyi-bool/CodeBuddy-v1)反馈问题，
提供版本、复现步骤、预期与实际结果，去除密钥和个人信息。

[贡献指南](CONTRIBUTING.md) · [维护者](MAINTAINERS.md) ·
[Apache-2.0 许可证](LICENSE) · [第三方软件与修改声明](documentation/codebuddy/THIRD_PARTY_NOTICE.md)
