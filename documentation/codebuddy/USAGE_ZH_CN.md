# CodeBuddy 使用手册（Windows 研究版）

## 1. 适用范围

CodeBuddy 是基于 goose 桌面端改造的研究版本，主要用于在受信任的 Windows
开发目录中连接 Ollama Cloud，进行代码阅读、修改和测试。当前版本保留底层
`goose` 后端名称、`.goosehints` 文件和 `GOOSE_*` 配置键，以便继续合并上游更新。
未显式设置 `GOOSE_PATH_ROOT` 时，CodeBuddy 会把后端的 config/data/state 放在本
应用的 Electron userData 下的 `backend` 子目录，避免与同一 Windows 账户中的 goose
默认配置目录共用。高级用户仍可通过绝对路径形式的 `GOOSE_PATH_ROOT` 覆盖它。
启用系统凭据库时，桌面端会强制使用独立的 `codebuddy` 服务标识。为兼容已有
配置，仅当新命名空间为空时，后端才会从显式指定的 `goose` 兼容源复制一次 Provider
secrets；复制不会删除旧凭据，新命名空间已有数据时也不会读取或覆盖。真实 Windows
Credential Manager 冒烟验证完成前，需要严格隔离的测试仍建议使用独立 Windows 账户。

当前版本不是 Windows 强隔离沙箱。`gemma4:31b`、`glm-5.2`、`kimi-k2.7-code`
和 `deepseek-v4-pro` 已通过本项目的 G0/G1 v2 基础资格测试，但这不等于通过完整
R1/R2/R3，也不代表模型适合所有仓库。
执行命令、安装扩展或修改文件前仍应检查授权提示。

## 2. 准备工作

使用打包版本需要：

- Windows 10/11 x64；
- 一个可用的 Ollama Cloud 账号和 API Key；
- Ollama Cloud 中可访问的模型名称；
- 一个用于测试的 Git 工作目录，建议不要直接使用重要生产目录。

API Key 不应写入源码、Markdown、Git 配置或截图。请只在 CodeBuddy 的提供商
密钥输入框中填写，应用会沿用上游的秘密配置存储流程。

## 3. 首次连接 Ollama Cloud

1. 启动 `CodeBuddy.exe`。
2. 在欢迎页选择“Connect to a Provider”。
3. 下拉框会自动选中并置顶 `Ollama Cloud (Recommended)`。
4. 在密钥字段填写自己的 Ollama Cloud API Key。
5. 从动态模型列表选择模型；若列表未返回内容，则按 Ollama Cloud 控制台显示的
   模型 ID 手动填写。不要凭文档猜测模型名称。
6. 保存配置并进入主界面。
7. 打开一个测试目录，先发送“只读取并总结这个项目，不要修改文件”，确认基本连接。
8. 再让它修改一个临时文件，并在授权弹窗中检查工具、参数和目标路径后批准。

CodeBuddy 复用的提供商配置为：

- 提供商名：`ollama_cloud`
- 密钥变量名：`OLLAMA_CLOUD_API_KEY`
- OpenAI 兼容接口：`https://ollama.com/v1/chat/completions`
- 模型：运行时动态获取，不在源码中硬编码

## 4. 日常使用建议

- 每个任务从一个干净的 Git 分支开始，修改后先看 `git diff`。
- 先让代理解释计划，再允许写文件或执行命令。
- 对删除、覆盖、安装软件、联网扩展等操作保持人工确认。
- 密钥、令牌、数据库口令不要放进聊天提示或测试仓库。
- 模型若出现空响应、工具调用格式错误或反复失败，请更换模型并记录模型 ID。
- 当前发行版默认关闭遥测界面和自动更新；升级需要重新构建或手动安装新版本。
- CodeBuddy 默认使用自己的后端配置目录；不要把该目录或其中的秘密文件提交到 Git。

新的配方和会话链接使用 `codebuddy://`。为兼容已有资产，应用仍能解析旧的
`goose://` 链接，但不会把它注册为本机的默认协议。

### 切换界面语言

CodeBuddy 新安装默认显示简体中文。需要切换语言时：

1. 点击左侧“设置”；
2. 点击设置页顶部的“应用”；
3. 找到“语言”，选择目标语言；
4. 当前窗口会自动重新加载，并记住所选语言。

选择“系统默认”会跟随 Windows 的显示语言。若系统语言不是中文，但仍希望界面保持
中文，请明确选择“简体中文”。模型 ID、提供商名称、URL、JSON、HTTP、MCP 等技术
标识会保留原文，不属于未翻译界面文案。

## 5. 使用 Code 和 CodePro

窗口顶部有两个互相独立的工作区：

- `Code`：原来的单 Agent 聊天和工具使用方式；
- `CodePro`：自动规划任务、调用 Worker、运行测试，再由独立 Reviewer 审查。

发送“你好”或询问“你是谁”时，当前工作区会使用自己的产品身份：

- `Code` 会介绍自己是 Code，适合直接聊天、快速分析当前项目，以及集中完成单个编码或工具任务；
- `CodePro` 会介绍自己是 CodePro，适合让分析、编码、测试和独立审查角色使用不同模型协同开发，并默认直接操作当前项目。

二者都不会再把自己介绍成 Goose；只有在你主动询问开源上游或技术来源时，才会说明与上游项目的关系。

新手建议这样使用 CodePro：

1. 点击顶部 `CodePro`。项目可以是 Git 项目，也可以是普通文件夹。
2. 直接用自然语言说明目标，不需要先选择“分析”或“修改”。CodePro 会结合当前消息、
   会话历史、项目目录概况和项目规则判断是聊天、只读分析还是开发任务；普通问候和
   只读分析不会写文件，开发、修复、优化和测试请求会进入直接开发流程。
   “只分析，不要改代码”等明确限制会被严格保留。缺少次要细节时会采用合理、可逆的
   MVP 默认方案并说明假设；只有缺少的信息会造成完全不同的产品结果时才询问一个
   具体问题，不再弹出固定的“只分析还是直接修改”二选一。
3. 修改任务尽量写清目标、允许修改的文件和必须运行的测试。
4. Agent 默认直接在当前项目目录修改，不复制项目、不要求项目必须是 Git 仓库，也不会
   对普通文件夹自动执行 `git init`。修改会立即出现在编辑器和文件系统中。
5. 为避免多个编码 Agent 同时覆盖真实文件，直接模式会串行执行写入任务；分析、测试和
   独立审查角色仍按任务流程协作。
6. 展开任务卡片，检查修改文件、测试命令、退出码和输出。任务底部会显示实际项目路径，
   不再出现“应用到项目”或“打开隔离项目”。
7. Git 项目的差异使用临时 index 收集，不修改用户真实暂存区。非 Git 项目可以直接开发，
   并使用原生快照生成差异。输入“撤销上次修改”可恢复本轮可撤销文件；若文件在任务
   完成后又被用户修改，系统会拒绝覆盖并报告冲突。敏感文件不会被写入撤销包。
8. 点击停止会把未完成 DAG 保存为暂停状态。在同一个 CodePro 会话中输入“继续”，可以
   从未完成任务继续执行，不会重新创建一份项目副本。

意图判断只决定任务走聊天、分析还是直接开发流程，不代替安全授权。删除数据、访问
工作区外路径、提权、陌生网络目标等高风险操作仍由执行权限层阻止或要求确认；模型
不能仅凭一句提示绕过这些边界。语义判断模型不可用或返回无效结构时，CodePro 会安全
降级为只读回复，不会因此自动修改项目。明确的执行表达（例如“帮我开发一个教务系统”
或“完成这个教务系统”）会直接进入开发流程，不依赖语义模型是否返回规范 JSON。

开发调试时，前端页面可以热更新，但 Rust 后端不会随页面自动替换。修改
`crates\goose` 后应关闭 CodeBuddy，再重新执行启动命令；启动脚本会编译并同步最新
`goose.exe`。如果不重启，界面可能继续表现为旧逻辑。

点击底部“Agent 模型组合”可以分别设置分析、编码、测试和审查 Agent。建议使用“一键
应用推荐组合”，它会分别使用已通过 G0/G1 v2 资格验证的 `gemma4:31b`、
`kimi-k2.7-code`、`glm-5.2` 和 `deepseek-v4-pro`。只有用户显式把多个角色选成同一模型时，界面才提示相同模型可能
产生相同盲点；系统默认组合不会被误报为冲突。保存后无需重启应用，从下一次 CodePro
任务开始生效，已经运行的任务不会中途换模型。

直接模式不会自动丢弃用户已有的未提交修改，也不会执行 `git reset --hard`。由于 Agent
和用户可能同时编辑同一个真实文件，任务运行期间应避免在编辑器中修改同一内容。当前已
提供持久化 DAG、暂停/继续和带哈希校验的本轮撤销；尚未实现多写入 Worker 并行、独立
Integrator 和可选 worktree 隔离。异常退出后可以恢复保存的未完成 DAG，但正在执行到
一半的单个模型调用会从该任务重新开始，而不是从网络响应中间继续。

CodePro 支持把图片原始内容传给分析 Agent；视频会在本机提取 6 个均匀分布的画面后
作为图片帧分析。开发工具还可在当前工作区边界内读取 PDF、DOCX、XLSX、PPTX 和常见
文本/源码文件。所选模型必须具备相应的视觉能力；默认分析模型为已通过资格测试的
`gemma4:31b`。单个文档限制为 25 MB，提取文本最多 120000 个字符，视频限制为
200 MB。媒体解析不会放宽工作区外路径和敏感信息边界。

Code 与 CodePro 的调度任务相互隔离：在哪个工作区创建的调度，只在对应工作区列表
显示，并在运行时进入对应的单 Agent 或多 Agent 会话。

## 6. 切换到本地 Ollama 或其他提供商

进入 Settings → Providers，选择本地 Ollama 或其他已内置提供商并重新配置默认
模型即可。CodeBuddy 没有删除 goose 原有的多提供商能力；Ollama Cloud 只是
研究版首次配置时的推荐项。

## 7. 从源码构建

完整构建机需要：

- Git for Windows；
- Rust `1.96.1`（以 `rust-toolchain.toml` 为准）；
- Visual Studio C++ Build Tools 和 Windows SDK；
- Node.js 24.x；
- pnpm 10.30 或更高版本。

在 PowerShell 中执行：

```powershell
Set-Location D:\CodeBuddy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-codebuddy-windows.ps1
```

本机若允许执行本地脚本，也可以直接运行 `.\scripts\build-codebuddy-windows.ps1`。
使用 `-ExecutionPolicy Bypass` 只对这一次子进程生效，不会永久修改系统策略。

常用选项：

```powershell
# 已有 ui\desktop\src\bin\goose.exe 时，只构建桌面端
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-codebuddy-windows.ps1 -UseExistingBackend

# release 后端已成功生成，只继续复制、前端门禁和桌面打包
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-codebuddy-windows.ps1 -UseExistingReleaseBackend

# 已安装依赖时跳过 pnpm install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-codebuddy-windows.ps1 -SkipDependencyInstall

# 调试构建时暂不生成安装器
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-codebuddy-windows.ps1 -SkipInstaller

# 构建完成后执行真实安装、启动、退出和卸载冒烟
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-codebuddy-windows.ps1 -SkipDependencyInstall -RunInstallerSmoke
```

默认脚本会执行 Rust 格式/Clippy、后端 release 构建、SDK 与翻译构建、发行契约、
TypeScript 类型检查、桌面单元测试、Electron package 和 installer。成功后的应用位于
`ui\desktop\out\CodeBuddy-win32-*\CodeBuddy.exe`；Squirrel 安装器位于
`ui\desktop\out\make\squirrel.windows\x64\CodeBuddy-Setup.exe`，同时还会保留 ZIP
发行包。默认构建会对 app.asar、打包后端版本和安装器 SHA-256 做非破坏性校验；只有
显式传入 `-RunInstallerSmoke` 才会真实安装和卸载。

如果 Electron 开发版正在运行并占用 `ui\desktop\src\bin\goose.exe`，构建脚本不会要求
关闭应用，也不会把旧后端打进安装包；它会在 `target\codebuddy-package\bin` 创建
受限暂存目录，将最新 release 后端和 Windows 支持文件从该目录交给 Forge。若 release
已经成功但后续打包中断，可用 `-UseExistingReleaseBackend` 继续，不必重新等待 Rust
release 优化。

真实冒烟前必须关闭所有 CodeBuddy 进程。脚本会把现有 `%LOCALAPPDATA%\CodeBuddy`
开发期缓存和 `%APPDATA%\CodeBuddy` userData 移到同盘唯一备份目录，结束后恢复；
测试产生的数据或安装残留会移动到带 `SmokeLeftovers` 的目录供检查，不会递归强删。
若 `%LOCALAPPDATA%\CodeBuddy\Update.exe` 已存在，说明当前账户已有正式 Squirrel
安装，脚本会拒绝覆盖，应改用干净 Windows 测试账户。研究版安装器未签名，Windows
可能显示 SmartScreen 提示。

## 8. 常见问题

### 本机源码调试启动

Windows 中文区域设置下编译 `llama.cpp` 时，应显式使用 UTF-8 C++ 源码解析；否则 MSVC 可能报
`C2001: newline in constant`。先从 “x64 Native Tools Command Prompt for VS 2022” 进入仓库，或在
PowerShell 中调用 `VsDevCmd.bat`，然后执行：

```powershell
$env:LIBCLANG_PATH = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\Llvm\x64\bin'
$env:CXXFLAGS = '/utf-8 /EHsc'
cargo build -p goose-cli --bin goose

Set-Location .\ui\desktop
node .\scripts\prepare-platform-binaries.js
pnpm.cmd run start-gui
```

要让调试版直接打开指定仓库，请使用正斜杠路径：

```powershell
pnpm.cmd run start-gui -- --dir "D:/你的测试仓库"
```

若 Electron 开发模式只显示空白页，确认 Vite 实际监听的是 `http://localhost:5173`，不要只绑定
`127.0.0.1`；Windows 可能把 `localhost` 优先解析到 `::1`。等待构建完成后可按 `Ctrl+R`
刷新一次。2026-07-24 已修复本机自签名 HTTPS `/status` 被普通 `fetch` 错误拒绝的问题；
例外只允许 `https://127.0.0.1:<端口>/status`，ACP 连接仍校验证书指纹。启动日志位于
`%APPDATA%\CodeBuddy\logs\main.log`，后端启动诊断位于其 `startup` 子目录。

### 401 / Unauthorized

重新打开提供商设置并更新 API Key。不要把密钥发到日志或聊天中。确认使用的是
Ollama Cloud 密钥，而不是本地 Ollama 地址或其他服务的令牌。

### 模型列表为空

确认账号有可用云端模型和网络可以访问 `ollama.com`。按控制台的精确模型 ID 手动
填写并执行最小聊天测试；列表为空不代表可以随意猜模型名称。

### 返回空内容或工具调用失败

这通常与所选模型的响应/工具调用能力有关。记录模型 ID、提示和错误，换一个支持
工具调用的模型复测。未通过真实仓库测试的模型不能标记为“已认证”。

### 无法打包

先运行测试手册中的工具链检查。常见原因是 Rust 或 Visual C++ Build Tools 缺失、
Node 版本不匹配、依赖安装未完成，或者 `ui\desktop\src\bin\goose.exe` 不存在。

## 9. 法律与品牌说明

本研究版基于 Apache-2.0 许可的 goose 源码。发布二进制时必须保留仓库中的
`LICENSE` 和上游版权/许可声明。CodeBuddy 的名称与图标用于区分本地研究发行版，
不表示得到 Ollama 或 goose 上游的官方背书。
