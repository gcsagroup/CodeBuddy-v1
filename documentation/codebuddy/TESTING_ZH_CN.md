# CodeBuddy 测试手册（Windows）

## 1. 测试原则

测试结果分为三类：

- `PASS`：本机实际执行并满足预期；
- `FAIL`：实际执行但结果不满足预期；
- `NOT RUN`：缺少工具、凭据或完整构建环境，不能声称通过。

Ollama Cloud 真实测试必须由测试人员通过本机应用配置自己的密钥。资格脚本只复用
Windows 系统凭据库中的现有配置，不接受 API Key 参数。测试记录只写模型 ID、时间、
二进制哈希和结果，不写 API Key。

## 2. 快速发行契约（无需安装前端依赖）

```powershell
Set-Location D:\CodeBuddy
node --test ui\desktop\scripts\codebuddy-actions.test.cjs ui\desktop\scripts\codebuddy-branding.test.cjs ui\desktop\scripts\codebuddy-distribution.test.cjs ui\desktop\scripts\codebuddy-qualification.test.cjs ui\desktop\scripts\codebuddy-windows-shims.test.cjs
```

预期：当前共 25 项全部通过。覆盖：

1. 包名、产品名、可执行文件名和协议；
2. 更新与遥测默认关闭；
3. 首次配置不能绕过发行版遥测开关；
4. Ollama Cloud 接口、密钥变量和动态模型契约；
5. Ollama Cloud 在首次配置中置顶且推荐；
6. 所有语言目录保持统一的 FormatJS 描述符结构；
7. CodeBuddy 默认使用简体中文，并保留设置页语言切换；
8. 简体中文目录没有整句英文残留；
9. TSX 可见文字没有绕过国际化的英文硬编码；
10. Windows 构建脚本包含质量门且不嵌入密钥；
11. Ollama Cloud G0/G1 阈值、LF 归一化夹具哈希和安全范围固定；
12. Windows shim 使用 CodeBuddy 自有路径和提示；
13. GitHub Actions 只构建 CodeBuddy unsigned Windows 发行物，不引用签名密钥；
14. 安装器冒烟必须显式启用、有超时、可恢复，并拒绝覆盖已有 Squirrel 安装。

## 3. 前端检查

```powershell
Set-Location D:\CodeBuddy\ui
pnpm.cmd install --frozen-lockfile

Set-Location D:\CodeBuddy\ui\desktop
pnpm.cmd run build-goose-sdk
pnpm.cmd run i18n:compile
pnpm.cmd run test:distribution
pnpm.cmd run typecheck
pnpm.cmd run lint:check
pnpm.cmd run test:run
```

以上质量门应返回退出码 0。依赖安装被中断时，TypeScript 会产生大量“Cannot find
module”错误；这属于环境未完成，不应当成产品代码通过或失败。先完成锁文件安装和
SDK 构建再复测。

仓库还提供 `pnpm run format:check`，但本次上游基线在完全未修改的文件上已有 429 个
Prettier 告警，因此它暂不作为 CodeBuddy 安装器构建硬门槛。本次改动引入的格式
问题应单独修正，不能借机格式化数百个无关上游文件。

## 4. Rust 后端检查

```powershell
Set-Location D:\CodeBuddy
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --exclude v8 -- -D warnings
cargo test --workspace --jobs 1
cargo build --release -p goose-cli --bin goose
```

Windows 必须具备 Rust、Visual Studio C++ Build Tools 和 Windows SDK。仅有 Node.js
不能证明桌面应用可打包。

## 5. 界面中文和语言切换测试

在执行云端模型测试前，先完成界面语言测试：

| ID | 操作 | 预期结果 |
|---|---|---|
| LANG-001 | 使用无历史设置的新配置启动 | 默认显示简体中文 |
| LANG-002 | 打开“设置 → 应用 → 语言” | 显示系统默认、简体中文、English 等选项 |
| LANG-003 | 选择 English | 当前窗口重载，设置页显示英文 |
| LANG-004 | 选择 Chinese (Simplified) | 当前窗口重载，界面恢复简体中文 |
| LANG-005 | 再次重载应用窗口 | 仍显示简体中文，证明设置已持久化 |
| LANG-006 | 运行 `pnpm run test:distribution` | 中文词库和 TSX 英文硬编码检查通过 |

模型 ID、提供商名称、URL、JSON、HTTP、MCP 等技术标识允许保留原文。

## 6. Ollama Cloud 真实冒烟测试

| ID | 操作 | 预期结果 |
|---|---|---|
| OC-001 | 首次启动并点击 Connect to a Provider | Ollama Cloud 自动选中并显示 Recommended |
| OC-002 | 输入无效密钥并保存 | 明确报认证失败，不崩溃、不泄露密钥 |
| OC-003 | 输入有效密钥并选择真实模型 | 配置成功，模型 ID 可记录 |
| OC-004 | 发送“回复 OK” | 收到非空文本响应 |
| OC-005 | 让代理只读取测试仓库 README | 能读取并总结，不修改文件 |
| OC-006 | 让代理修改临时文本文件 | 出现授权流程，批准后只修改目标文件 |
| OC-007 | 让代理运行一个无副作用测试命令 | 命令、目录和结果在界面可见 |
| OC-008 | 重启应用 | 提供商配置仍可用，不要求把密钥写进仓库 |

记录模板：

```text
测试时间：
CodeBuddy 提交：
Ollama Cloud 模型 ID：
OC-001..008 结果：
失败日志（已脱敏）：
```

## 7. 品牌、协议和隐私检查

| ID | 检查 | 预期结果 |
|---|---|---|
| DIST-001 | 查看安装器、任务栏、窗口标题和 About | 显示 CodeBuddy |
| DIST-002 | 查看应用图标与欢迎页 | 显示代码括号图标，不显示 goose 鹅形图标 |
| DIST-003 | 打开 `codebuddy://recipe?...` | CodeBuddy 接收链接 |
| DIST-004 | 在应用内导入旧 `goose://recipe?...` | 兼容解析，但系统不注册旧协议 |
| DIST-005 | 查看 Settings | 自动更新和遥测入口不显示 |
| DIST-006 | 检查首次配置完成页 | 不显示遥测勾选框，并保存为关闭 |
| DIST-007 | 搜索源码和 Git diff | 不包含真实 API Key、令牌或凭据 |
| DIST-008 | 同机安装 goose 后启动 CodeBuddy | 默认后端配置写入 CodeBuddy userData 的 `backend`，不写入 goose 默认目录 |

凭据搜索示例只检查变量名和常见前缀，不要把真实密钥写进命令历史：

```powershell
git diff --check
git status --short
rg -n "OLLAMA_CLOUD_API_KEY\s*=|Bearer\s+[A-Za-z0-9_-]{20,}" . --glob "!ui/node_modules/**"
```

## 8. CodePro 单 Worker 安全闭环

建议同时准备一个一次性 Git 项目和一个普通非 Git 文件夹，测试前备份重要数据。

1. 从源码启动并指定测试仓库，路径使用正斜杠：

   ```powershell
   Set-Location D:\CodeBuddy\ui\desktop
   pnpm.cmd run start-gui -- --dir "D:/CodePro-E2E"
   ```

2. 点击顶部 `CodePro`，先发送“你好”和“分析一下这个项目”。预期正常回复，不创建
   文件写入，也不出现空 Patch 审查失败。“你好”应以 CodePro 身份回复，并简要介绍
   多 Agent、多模型、直接项目修改和独立审查等特点，不应再自称 Goose。切换到 `Code`
   新建会话后发送“你好”，应以 Code 身份回复，并介绍直接聊天、快速项目分析和集中
   编码等特点。
3. 依次测试自然语言路由：

   - “登录页面不好看”应先检查和判断，不弹固定二选一；
   - “帮我开发一个教务系统”应进入开发流程，并从可逆 MVP 开始，不因范围较大而先
     罗列一串技术栈问题；
   - “分析登录失败并修复”应分析后直接进入开发流程；
   - “只分析，不要改代码”必须保持只读；
   - “删除整个项目数据”可以被识别为执行目标，但真正删除前必须由权限层确认，不能
     因意图判断结果而自动执行。

4. 再提交一个包含“修改目标 + 必须运行的测试 + 禁止修改的范围”的任务。
5. Agent 执行期间在另一个 PowerShell 中运行：

   ```powershell
   git -C D:\CodePro-E2E status --short
   git -C D:\CodePro-E2E worktree list
   ```

   预期：修改直接出现在源项目中，`git worktree list` 不增加 CodePro 工作树，
   `D:\CodeBuddy-Workspaces` 不新增会话副本。
6. 在任务面板检查每个任务的文件、测试命令、退出码和输出。完成区域应显示当前项目
   路径，不再显示“应用到项目”“丢弃”或“打开隔离项目”。
7. 同一会话追加“再改一下……”，确认继续修改同一真实项目。
8. 执行项目测试和 `git diff`，只应出现预期修改；执行前后用 `git diff --cached`
   和 `git ls-files --stage` 确认 CodePro 没有改变暂存区。
9. 对普通非 Git 文件夹重复修改。预期修改立即出现在原目录，且原目录不出现 `.git`。
   完成后输入“撤销上次修改”，预期恢复本轮可撤销文件；若先手工修改同一文件，再执行
   撤销，预期系统报告冲突并保留用户的新修改。敏感文件不进入撤销包。

本机 2026-07-28 本轮自动化证据：Rust `goose` lib 1491/1491 通过，桌面 Vitest
629 项通过、4 项跳过，CodePro 进度/任务面板定向测试 12/12 通过，桌面 TypeScript、ESLint、发行
契约和 Rust fmt/Clippy 均通过。真实项目直接修改的在线模型桌面 E2E 仍应按上述步骤
逐项目执行。

## 9. Windows 打包测试

```powershell
Set-Location D:\CodeBuddy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-codebuddy-windows.ps1
```

默认构建完成后已自动执行非破坏性的安装器、app.asar 和打包后端校验。需要真实安装/
卸载时，可以在关闭全部 CodeBuddy 进程后执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-codebuddy-windows-installer.ps1 -InstallUninstall
```

也可以在完整构建时增加 `-RunInstallerSmoke`。脚本会备份并恢复 LocalAppData 与
Roaming userData；测试数据和安装残留只移动到 `SmokeLeftovers` 目录，不会强制递归
删除。检测到已有 `%LOCALAPPDATA%\CodeBuddy\Update.exe` 时会拒绝覆盖，需使用干净
Windows 测试账户。

检查：

1. `ui\desktop\out\CodeBuddy-win32-*\CodeBuddy.exe` 可启动；
2. `ui\desktop\out\make\squirrel.windows\x64\CodeBuddy-Setup.exe` 存在，且名称正确；
3. 安装、启动、退出、卸载均不影响上游 goose 安装；
4. `%LOCALAPPDATA%\CodeBuddy\bin` 用于 CodeBuddy 的 Windows shim；
5. 未配置独立发布仓库时不会访问或安装上游 goose 更新。

## 10. 本次开发验证记录

本机工具链快照（2026-07-24）：Git `2.55.0.windows.2`、Node.js `24.18.0`、pnpm `11.9.0`、
Rust/Cargo `1.96.1`、Just `1.57.0`、Visual Studio Build Tools `17.14.36`、Windows SDK
`10.0.26100.0`。Visual Studio 还安装了完整 LLVM/Clang 组件，供 `bindgen` 查找 `libclang.dll`。

本次验证在 `D:\CodeBuddy` 执行。D 盘当前由 Windows 报告为 NTFS、`Healthy`、`OK`，
依赖安装和前端质量门均直接在该工作树完成。

| 检查 | 当前结果 | 说明 |
|---|---|---|
| CodeBuddy 发行契约 | PASS | 本机 Node 24 执行 27/27；包含 Actions、品牌、中文、资格夹具、安装器安全范围和 shim 检查 |
| CodeBuddy GitHub Actions | PASS（静态） | YAML 解析和专用流程契约通过；尚未推送，GitHub hosted runner 为 NOT RUN |
| Ollama Cloud 静态定义 | PASS | URL、密钥变量、动态模型和流式标志通过契约测试 |
| 新 PNG/ICO 图标 | PASS | 已生成并人工检查 512 px 图标 |
| 15 个 locale 目录 | PASS | i18n compile、官方检查与 locale validator 通过，1589 个消息键一致 |
| TypeScript 类型检查 | PASS | 桌面 `tsc --noEmit` 返回退出码 0 |
| JSON/脚本/diff/凭据模式 | PASS | 变更 JSON、PowerShell 解析、Python 编译、diff 与凭据扫描通过 |
| Windows 构建前置检查 | PASS | Rust、MSVC、Windows SDK、LLVM/Clang、Node.js、pnpm 和 Just 均已安装并实测可调用 |
| pnpm 工作区完整安装 | PASS | 在 NTFS 工作树执行 `pnpm install --frozen-lockfile` 成功，Electron postinstall 和 SDK 生成完成 |
| SDK 与前端 TypeScript | PASS | SDK schema 生成与编译通过；桌面 `tsc --noEmit` 通过 |
| ESLint | PASS | 全部桌面 TypeScript/TSX 以 0 warning 通过 |
| 桌面单元测试 | PASS | Vitest 92 个文件通过；669 项通过、4 项跳过、0 失败 |
| 隔离 Electron 用户旅程 | PASS | Playwright 使用一次性 APPDATA、LOCALAPPDATA 和 CodeBuddy 数据根目录启动真实 Electron；点击 Code/CodePro、配方、技能、应用、调度、扩展、历史、设置全部标签和四 Agent 模型弹窗，控制台 0 error |
| 工具审批会话隔离 | PASS（自动化） | 允许、拒绝、取消、重复请求和跨会话同名工具调用共 6 项通过；跨会话审批缓存回归已修复 |
| 全仓 Prettier | FAIL | 上游当前基线已有 429 个文件告警；未把该既有问题设为安装器硬门槛 |
| Rust fmt 与调试构建 | PASS | `cargo fmt --all -- --check` 通过；`cargo build -p goose-cli --bin goose` 通过；`goose --version` 返回 `1.43.0` |
| Rust Agent tests | PASS | `cargo test -p goose --lib`：1523 通过、0 失败；同时修复日志与插件发现测试的全局路径竞态 |
| Rust Clippy | PASS | `cargo clippy --workspace --all-targets --exclude v8 --jobs 1 -- -D warnings` 返回 0 |
| Rust provider tests | PASS | `cargo test -p goose-providers`：84 通过、0 失败 |
| Rust workspace tests | PASS | 正式 Windows 构建脚本完成 workspace tests 后进入并完成 release 阶段 |
| Rust release build | PASS | 增加 `--jobs 1` 避免 Windows 内存峰值后完成；后端 SHA-256 为 `21da14768b7adc8d288391ed8e132816323622635b89b6aa0ad115056c773501` |
| Windows shim | PASS | 固定版本 `uv 0.11.11` 通过仓库内置 SHA-256 校验；`uv.exe`、`uvx.exe`、`npx.cmd` 启动时复制成功 |
| Electron 开发版启动 | PASS | Vite、Electron、中文界面和本地 TLS `goose serve` 启动；修复自签名 HTTPS 探测后 `/status` 返回 `ok` |
| 界面语言往返切换 | PASS | 实测简体中文切换 English 后显示英文，再切回简体中文并重载保持；历史会话“Thinking”显示为“思考过程”，控制台无错误 |
| Ollama Cloud 在线资格复测 | PASS/FAIL 有证据 | `gemma4:31b`、`glm-5.2`、`kimi-k2.7-code`、`deepseek-v4-pro` PASS；`deepseek-v4-flash` 与 `minimax-m3` FAIL 并已移出推荐组合 |
| Windows 安装器安全流程 | PASS（静态） | 可恢复安装/卸载脚本已接入构建；保护 LocalAppData、Roaming userData 和已有 Squirrel 安装，发行契约通过 |
| CodePro 历史隔离版 E2E | PASS（历史） | 旧隔离工作区版本曾在一次性 Git 仓库中完成 3/3 任务；当前直接目录模式不能用该旧结果替代本轮在线验证 |
| CodePro 测试证据 | PASS | 保存命令、退出码 0 和有界 stdout/stderr；非零退出码单测确认不会记为成功 |
| CodePro 审查拒绝 | PASS | 第一轮因缺少结构化测试输出被 Reviewer 拒绝，源仓库保持不变且应用未授权 |
| CodePro 安全执行增量 | PASS（自动化） | 强约束检测、模型语义路由、无效输出只读降级、Git/非 Git 原生证据、敏感文件门禁、暂停/恢复和哈希保护撤销均通过 |
| CodePro 自然语言路由 | PASS | `glm-5.2` 在线验证：“登录页面不好看”→只读检查，“帮我开发一个教务系统”→开发，“删除整个项目数据”→执行目标；Rust 意图路由 8/8 通过，并确认“完成这个教务系统”直接进入开发流程；危险操作仍留给权限层审批 |
| CodePro Planner 协议 | PASS | Rust 定向测试 6/6；Planner 不再加载执行扩展；主模型返回畸形 JSON 或结构校验失败时自动调用备用 Planner 纠错一次；两次都失败时仅显示有界输出预览，不再把整页 JSON 倾倒到聊天窗口 |
| Code / CodePro 产品身份 | PASS | Rust 定向测试 5/5；可见会话会先移除冲突的 Goose 身份，再分别加入 Code/CodePro 身份，内部 Agent 保留完整上游协议提示；Ollama Cloud `glm-5.2` 实测“你好”已用中文自称 Code 并介绍三项特点 |
| CodePro 源状态边界 | PASS（自动化） | 直接修改当前项目且不改 Git 暂存区；撤销前校验完成后哈希，用户后续编辑时拒绝覆盖 |
| Electron package/make | PASS | 当前源码生成应用、Squirrel 安装器和 ZIP；安装器/app.asar/后端版本静态校验通过 |
| 打包后端一致性 | PASS | release、受限暂存目录和打包资源中的 `goose.exe` SHA-256 完全一致 |
| 打包应用启动/退出 | BLOCKED（当前账户） | 当前调试实例正在使用同一产品单实例锁和旧后端；未强制关闭用户进程。app.asar、后端版本和目录结构静态校验通过 |
| 安装器真实安装/卸载 | BLOCKED（安全保护） | `%LOCALAPPDATA%\CodeBuddy` 已存在 Squirrel 安装，脚本按设计拒绝覆盖；需在干净 Windows 测试账户执行 |
| Ollama Cloud G0/G1 v2 | PASS/FAIL 有证据 | 四个不同的推荐模型 PASS；`deepseek-v4-flash`、`minimax-m3`、`gpt-oss:120b` 失败且未误报 |
| 授权写入、命令和越界拒绝 | PASS（自动化） | 安全边界 49、授权路由 5、命令执行 5、任务调度 18 项通过；尚不等同于 Windows 强沙箱 |

以下是 2026-07-28 当前源码产物。研究版未配置 Windows 代码签名，因此 EXE 均为
`NotSigned`；这不影响本地静态校验，但不应直接作为公开发布版：

| 产物 | 大小 | SHA-256 | 签名 |
|---|---:|---|---|
| `ui\desktop\out\make\squirrel.windows\x64\CodeBuddy-Setup.exe` | 248,645,120 字节 | `71cfa5bf5e94a2458b3f0e18df5985f9a946790b0bffbd171215b6f72bb11549` | `NotSigned` |
| `ui\desktop\out\CodeBuddy-win32-x64\CodeBuddy.exe` | 222,755,328 字节 | `7cf1ec2d72de8964770036f94ca33e642c540051b71ba8f6cb5e31eb1fa17bb2` | `NotSigned` |
| `target\release\goose.exe` | 259,092,480 字节 | `21da14768b7adc8d288391ed8e132816323622635b89b6aa0ad115056c773501` | `NotSigned` |
| `ui\desktop\out\make\zip\win32\x64\CodeBuddy-win32-x64-1.43.0.zip` | 256,655,647 字节 | `d4cb1c376facdbff117ea3bec472788fce65ae8e6575c8b75bfafaf7467dc6ed` | 不适用 |

构建期间还修复并回归验证了三个 Windows 专属问题：

1. Stop Hook 批处理夹具的数字重定向与系统代码页问题；
2. `C:\`、`C:/` 与 UNC 图片路径识别问题；
3. `goose-cli` 文档示例在 Windows 上同时链接 V8 与 llama.cpp 时的重复 C++ 符号冲突。

交付前应更新本表。`NOT RUN` 项不等于失败，但不能对外宣称已经通过。
