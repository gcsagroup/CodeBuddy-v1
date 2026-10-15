# CodeBuddy Windows 研究版开发清单

更新日期：2026-07-28

说明：`[x]` 表示已经完成并取得本机证据；`[ ]` 表示尚未完成，不能对外宣称通过。

## 1. 项目与工具链

- [x] 当前发布修复在独立分支 `fix/codebuddy-release-readiness` 开发，未直接修改 `main`。
- [x] 配置官方 Goose `upstream` 远程，并抓取 `upstream/main` 提交图。
- [x] 识别导入基线 `18740b095f48`，以不改文件树的合并提交恢复上游历史可追溯性。
- [x] 记录 Git、Node.js、pnpm、Rust、Just 和 Visual C++ 工具链状态。
- [x] 尝试激活仓库 Hermit 环境，并记录 Windows MINGW 平台包不可用的阻塞原因。
- [x] 安装 Rust 1.96.1、Visual Studio C++ Build Tools、Windows SDK、LLVM/Clang 和 Just。

## 2. 发行版契约与品牌

- [x] 增加 CodeBuddy 发行契约测试，并保留先失败后实现的测试证据。
- [x] 增加统一发行配置 `ui/desktop/codebuddy.distro.json`。
- [x] 设置产品名、包名、可执行文件名、窗口标题和 Windows 安装元数据。
- [x] 注册新的 `codebuddy://` 协议，并兼容应用内解析旧 `goose://` 链接。
- [x] 生成并检查新的 PNG、ICO、SVG 代码括号图标。
- [x] 保留底层 Goose/ACP 类型、后端二进制名和 `GOOSE_*` 配置键，降低上游合并成本。
- [x] 默认使用 CodeBuddy userData 下的独立后端配置根目录，显式 `GOOSE_PATH_ROOT` 仍可覆盖。
- [x] 新安装默认显示简体中文，设置页“应用 → 语言”可切换并持久化语言。
- [x] 清理简体中文目录中的整句英文残留，并将 TSX 可见英文硬编码接入国际化。
- [x] 为中文词库完整性、默认语言和 TSX 硬编码增加自动回归检查。
- [x] 实测简体中文 → English → 简体中文往返切换，重载后仍保持简体中文。
- [x] 桌面端强制使用 `codebuddy` 系统凭据库服务标识，并显式指定 `goose` 为兼容迁移源。
- [x] 新命名空间为空时一次复制旧凭据，保留旧凭据；新命名空间已有数据时不读取或覆盖。
- [x] 凭据迁移实现通过 Rust workspace tests。
- [ ] 使用真实 Windows Credential Manager 完成旧 `goose` → `codebuddy` 凭据迁移冒烟。
- [ ] 在真实打包产物中人工检查窗口、任务栏、安装器和协议注册。

## 3. Ollama Cloud 与安全默认值

- [x] 复用仓库已有 `ollama_cloud` 提供商，未创建重复实现。
- [x] 首次配置时自动选择并置顶 `Ollama Cloud (Recommended)`。
- [x] 保留本地 Ollama 和其他原有提供商。
- [x] API Key 只通过现有秘密配置流程输入，源码和脚本不包含真实凭据。
- [x] 关闭发行版遥测界面，并在启动后端时强制设置 `GOOSE_TELEMETRY_OFF=1`。
- [x] 未配置独立发布仓库时关闭自动更新入口和查询。
- [x] 使用用户现有 Ollama Cloud 配置完成真实聊天和重启保持配置测试。
- [x] 修复工具审批状态按 `sessionId + toolCallId` 隔离，自动化验证跨会话审批不会串用。
- [x] 使用一次性 Git 仓库完成 CodePro 文件写入、`npm test` 命令执行、独立审查和人工应用测试。
- [x] 完成 Ollama Cloud G0/G1 v2：`gemma4:31b`、`glm-5.2`、`kimi-k2.7-code`
  与 `deepseek-v4-pro` 通过；结果 JSON 已保存且不含凭据。
- [x] 验证推荐候选的失败路径：`deepseek-v4-flash` 因最终答案缺少路径/行号证据失败，
  `minimax-m3` 因 G0 第三次未返回精确 JSON 失败，均未进入推荐组合。
- [x] 验证 `gpt-oss:120b` 的失败路径：G0 通过，G1 因缺少要求的路径/行号证据而失败，没有误报为通过。

## 4. Windows 构建与自动检查

- [x] 增加 `scripts/build-codebuddy-windows.ps1`。
- [x] 增加 CodeBuddy 专用 GitHub Actions Windows 流程，复用本地质量门并上传 unsigned 应用与安装器。
- [x] 构建脚本检查 Git、Node.js、pnpm、Cargo 和已有后端等前置条件。
- [x] 构建脚本包含 Rust fmt/Clippy、SDK、翻译、发行契约、类型、Lint、单测、打包和安装器阶段。
- [x] 配置 Windows Squirrel maker，目标产物为 unsigned `CodeBuddy-Setup.exe`，并保留 ZIP。
- [x] PowerShell 语法检查通过，且发行契约验证了关键质量门和无密钥参数。
- [x] 实跑构建前置检查；补齐 `cargo` 等工具链，并记录本机 ExecutionPolicy 绕过方法。
- [x] 在 NTFS 工作树完整安装 pnpm 工作区依赖。
- [x] 使用已落盘依赖完成 SDK 构建、全部发行测试、typecheck、lint、15 个 locale 校验和全部单元测试（2026-07-28：669 通过、4 跳过）。
- [x] Rust fmt 和 `goose-cli` Windows debug build 通过。
- [x] Rust Clippy 本轮全 workspace、全 target（排除仅供检查的 `v8` 包）串行通过。
- [x] Rust provider 全量测试通过：84 通过、0 失败。
- [x] Rust workspace tests 通过；正式脚本完成测试阶段后进入并完成 release build。
- [x] Rust release build 本轮通过，当前 `goose.exe` SHA-256 与打包资源完全一致。
- [x] 启动 Electron 开发版，验证中文界面、本地 TLS 后端健康检查和 Windows shim。
- [x] 使用当前源码重新生成 unsigned CodeBuddy Windows 应用、Squirrel 安装器和 ZIP 发行包，并完成静态校验。
- [ ] 使用当前源码的打包应用完成启动、后端启动和退出清理冒烟测试。
- [ ] 完成安装器真实安装、创建会话和卸载冒烟测试。

## 5. CodePro 多 Agent 工作区

- [x] 增加独立 `Code | CodePro` 切换，不依赖关键词自动切换。
- [x] CodePro 使用独立会话类型和独立历史列表，Code 原有会话不混入。
- [x] Planner 输出任务图并校验重复 ID、缺失依赖、自依赖和循环依赖。
- [x] Scheduler 按依赖执行，失败或取消会阻断下游任务；第一版限制单 Worker 并发。
- [x] Git 和非 Git 项目都直接在用户当前目录修改；不复制项目、不要求 Git，也不自动执行 `git init`。
- [x] Git 项目使用临时 index 收集差异且不改用户暂存区；非 Git 项目使用有界原生快照生成差异。
- [x] 独立 Reviewer 审查真实累计 Patch 和结构化测试证据。
- [x] 测试证据保存命令、退出码和有界 stdout/stderr；非零退出码不会记为成功。
- [x] 任务面板显示实时状态、修改文件、测试证据、执行报告和取消状态。
- [x] Reviewer 只有在真实累计 Patch、结构化测试证据和敏感文件门禁全部通过后才能批准。
- [x] 直接修改结束后生成带哈希校验的撤销包；用户后续编辑同一文件时拒绝撤销覆盖。
- [x] 历史隔离模式 E2E 已通过；当前直接模式的代码路径由 Rust 自动化覆盖，真实云桌面 E2E 仍需复跑。
- [x] 写入任务串行执行，避免多个 Coder 同时覆盖真实文件。
- [x] 修复 Windows 本机自签名 HTTPS `/status` 探测，范围仅限 `127.0.0.1/status`；ACP 仍固定证书指纹。
- [x] 持久化运行 DAG、任务输出和状态；程序重启后可恢复未完成运行。
- [x] 停止时保存暂停状态；同一会话输入“继续”恢复未完成 DAG。
- [x] 当前直接目录模式明确采用单写入 Worker 串行执行，不再把“双 Worker 独立
  worktree/Integrator”作为交付目标；该旧设计与用户要求的直接修改模式冲突。
- [x] 推荐组合只使用 G0/G1 v2 已资格验证模型，任务面板显示已记录 Token 和已知费用。
- [x] 模型列表由已配置 Provider 在运行时动态返回；推荐组合已按 2026-07-28
  G0/G1 v2 结果复测并更新。
- [x] 敏感文件内容不进入 Patch、撤销包或 Reviewer 提示，敏感修改触发审查拒绝。
- [ ] CodePro 专用网络域名允许列表。

## 6. 文档与交付审查

- [x] 编写 `documentation/codebuddy/USAGE_ZH_CN.md`。
- [x] 编写 `documentation/codebuddy/TESTING_ZH_CN.md`。
- [x] 编写 `documentation/codebuddy/THIRD_PARTY_NOTICE.md`。
- [x] 记录 PASS、FAIL 和 NOT RUN 的判定规则及本次结果。
- [x] 检查 Git diff 格式、JSON、TypeScript 语法、协议逻辑和凭据模式。
- [x] 本轮复跑 Rust lib 1491 项、前端 624 项（另 4 项跳过）、发行契约 27 项、fmt、Clippy、typecheck、Lint 和 i18n。
- [x] 当前源码 Windows release build、桌面 package/make 和安装器静态校验。
- [x] Ollama Cloud 推荐模型在线复测完成；GitHub hosted runner 和真实安装/卸载仍待干净账户。
- [ ] 完成需要真实系统安装状态的 Credential Manager 与安装/卸载测试。

## 7. CodePro 安全执行与验证

- [x] 普通聊天和只读分析不创建隔离工作区。
- [x] 将关键词分类器降级为明确只读/直接执行约束检测；其他自然语言由分析 Agent 结合
  会话历史、项目概况和项目规则判断，不再弹固定的“只分析还是修改”二选一。
- [x] 语义模型无效输出或不可用时安全降级为只读；只有会造成不同产品结果且不存在
  可逆默认方案时才提出具体问题。
- [x] 意图判断与安全授权分离；危险、不可恢复、越界和网络操作仍由执行权限层确认。
- [x] Git、无首次提交 Git 和非 Git 项目都直接修改当前目录，不创建 D 盘影子副本。
- [x] 原项目不被自动初始化 Git，用户现有分支和暂存区保持不变。
- [x] 任务面板显示 Patch 摘要、修改文件和结构化测试证据，不再提供隔离目录操作。
- [x] 同一开发任务的后续修改继续使用同一个真实项目目录。
- [x] 本轮撤销按原始内容和完成后哈希恢复；检测到用户后续编辑时拒绝覆盖。
- [x] 完成相关 Rust、Vitest、fmt、ESLint 和 TypeScript 类型检查。
